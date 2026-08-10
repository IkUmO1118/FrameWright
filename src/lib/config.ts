import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULT_OCR_LANGUAGES } from "./ocr.ts";
import { CUT_PATTERN_IDS } from "./cutPatterns.ts";
import type { CutPatternId } from "./cutPatterns.ts";
import type { DesignConfig } from "./design.ts";
import type { LogLevel } from "./obs.ts";
import type { CaptionBackground, Region } from "../types.ts";
import { normalizeBaseUrl, originOfProfile, resolveCredential } from "./ai/http.ts";
import { adapterFor } from "./ai/registry.ts";
import {
  DEFAULT_HYPERFRAME_ASSET_MAX_BYTES,
  DEFAULT_HYPERFRAME_ASSET_MAX_TOTAL_BYTES,
} from "./hyperframeAssets.ts";
import type { PerceptionCursorOptions } from "./perception.ts";

export type AiProvider = "claude-code" | "codex" | "anthropic" | "openai";
export type LegacyLlmBackend = "claude-cli" | "api";
export type AiProfileName = string;
export type AiAdapterKind = AiProvider | "openai-compatible";
export type AiRoute = "text" | "structured" | "vision";

export interface LegacyAiConfig {
  /** 生成 AI の入口。agent と one-shot の違いは provider 側の既定で吸収する */
  provider: AiProvider;
  /** "auto" または省略で provider の既定。API provider は明示 model を推奨 */
  model?: string;
}

export interface AiProfileConfig {
  adapter: AiAdapterKind;
  model?: string;
  protocol?: "chat-completions" | "responses";
  baseUrl?: string;
  auth?: AiAuthConfig;
  capabilities?: AiCapabilitiesConfig;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
}

export type AiAuthConfig =
  | { type: "none" }
  | { type: "bearer"; apiKeyEnv: string }
  | { type: "x-api-key"; apiKeyEnv: string };

export interface AiCapabilitiesConfig {
  structuredOutput?: "native-json-schema" | "json-object" | "prompt" | "none";
  imageInput?: boolean;
  maxImages?: number;
}

export interface AiRoutesConfig {
  text: string;
  structured: string;
  vision?: string;
}

export interface RoutedAiConfig {
  profiles: Record<string, AiProfileConfig>;
  routes: AiRoutesConfig;
  defaults?: {
    timeoutMs?: number;
    maxRetries?: number;
    maxResponseBytes?: number;
  };
}

export type AiConfig = LegacyAiConfig | RoutedAiConfig;

export interface AiCapabilities {
  textInput: true;
  textOutput: true;
  structuredOutput: "native-json-schema" | "json-object" | "prompt" | "none";
  imageInput: boolean;
  maxImages: number;
}

export interface ResolvedAiProfile {
  name: string;
  adapter: AiAdapterKind;
  model: string;
  protocol: "cli" | "responses" | "messages" | "chat-completions";
  baseUrl?: string;
  auth: AiAuthConfig;
  capabilities: AiCapabilities;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  maxResponseBytes: number;
}

export interface ResolvedAiConfig {
  profiles: ReadonlyMap<string, ResolvedAiProfile>;
  routes: {
    text: string;
    structured: string;
    vision?: string;
  };
  /** "unconfigured" = ai も llm も未設定で、API キーも1つも見つからない状態。
   *  profiles/routes は形だけ既定候補の先頭で埋まるが、実際の AI 呼び出しは
   *  lib/ai/client.ts が AI_UNCONFIGURED_MESSAGE で止める(知覚系の
   *  supportsImageReview 等は例外ではなく「AI 無し」として優雅に劣化する) */
  source: "routed" | "legacy-ai" | "legacy-llm" | "default" | "unconfigured";
}

export interface AiProfileStatus {
  name: string;
  adapter: AiAdapterKind;
  model: string;
  origin: string | null;
  credential: "not-required" | "present" | "missing";
  capabilities: AiCapabilities;
}

let repoEnvLoaded = false;

function loadRepoEnv(): void {
  if (repoEnvLoaded) return;
  repoEnvLoaded = true;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    process.loadEnvFile?.(join(repoRoot, ".env"));
  } catch {
    // .env is optional. Status falls back to inherited process env.
  }
}

export interface Config {
  recordingsDir: string;
  /** 複数ルート運用(opt-in)。recordingsDir と併記不可。 */
  recordingsDirs?: Record<string, string>;
  ingest: {
    screenRegion: Region;
    cameraRegion: Region;
    micTrack: number;
    systemTrack: number;
    /** 収録レイアウトの既定。省略時 "plain"。
     *  auto = 寸法/縦横比から OBS 拡張キャンバスらしければ obs-canvas、それ以外は plain */
    layout?: "obs-canvas" | "plain" | "auto";
    /** 音声のみを ingest する stills project の canvas。 */
    stills?: { width?: number; height?: number; fps?: number };
  };
  whisper: {
    bin: string;
    model: string;
    language: string;
    /** 語/トークン単位のタイミング(WordTiming)を transcript.json に付加するか。
     * 省略時 false(既存挙動と完全一致・words を一切書かない)。true で
     * whisper 実行を -ojf に切り替え、各 segment に words[] を付加する */
    wordTimestamps?: boolean;
    /** DTW トークンアライメント(whisper.cpp の -dtw)。使用モデルに合う
     *  preset 名(例 "large.v3.turbo" / "small" / "medium.en")を書くと
     *  whisper 実行に -dtw を付け、各トークンに音響へ固定された t_dtw が入る。
     *  buildWords は t_dtw を offsets より優先して words[] の時刻を組み立てる
     *  (注意ベースの offsets は文中で±数百ms〜秒単位でずれ、ポーズに語を
     *  等幅で塗り広げる。エディタのスクリプトタブの取り消し線判定は語の
     *  実時刻に依存するため、この精度が体感品質に直結する)。
     *  省略時は付けない(既存挙動と完全一致。wordTimestamps と独立だが、
     *  words[] に効かせるには wordTimestamps: true が必要) */
    dtw?: string;
    /** テロップ(transcript.json の 1 segment)を読みやすい粒度へ割り直す設定。
     *  省略時は分割しない(whisper のチャンク幅そのまま=導入前とバイト等価)。
     *  LLM も再文字起こしも使わない決定論処理。区切りの強さ(句点 > 述語の終止形 >
     *  接続助詞 > 格助詞 > 連体の「の」)と無音の「間」を合成してスコア化し、
     *  Knuth-Plass 型の動的計画法で全体のコストが最小になる分割を選ぶ。
     *  words[] があれば分割後の時刻は語境界そのもの。§src/lib/captionSplit.ts */
    captionSplit?: {
      /** これ(code point 数)を超える segment だけを分割する。分割後の断片も
       *  この長さを超えない(単一の語がこれより長い病的ケースだけ例外)。0 以下で無効。
       *  テロップは 1 行で描かれ自動折り返しをしないので、実質は「1 行に収まる字数」 */
      maxChars: number;
      /** 分割後の断片がこれ未満だと強い減点を受ける(ハード禁止ではない)。
       *  省略時 floor(maxChars * 0.4) */
      minChars?: number;
      /** 語間ギャップ(秒)がこれ未満なら「間」として数えない。省略時 0.3 */
      gapSec?: number;
      /** この秒数の語間ギャップで「間」の強さが最大になる。省略時 0.8 */
      pauseFullSec?: number;
      /** 断片の表示秒がこれ未満だと減点する(一瞬で消えるテロップの抑制)。省略時 0.9 */
      minDurationSec?: number;
    };
    /** システム音声(ingest.systemTrack)も第2トラックとして文字起こしし、
     *  知覚専用の transcript.system.json を書くか。省略時 false(既存挙動と
     *  完全一致=system.wav も transcript.system.json も作らず manifest も不変)。
     *  render.systemAudio.mix(=出力に音を混ぜる)とは別軸で、こちらは
     *  「AI がその音を読めるようにする」= 描画はしない知覚専用。
     *  収録に systemStream が無ければ true でも自動で無視される */
    systemAudio?: boolean;
  };
  detect: {
    silenceDb: number;
    minSilenceSec: number;
    padSec: number;
    minKeepSec: number;
    /** 発話候補の隙間(無音)を cutplan に action:"cut" として埋めるときの
     *  reason 文言。省略時 DEFAULT_SILENCE_CUT_REASON("無音")。この cut は
     *  エディタで「この区間を動画に戻す」で復元できる(全ての映像を戻せる状態) */
    silenceCutReason?: string;
    /** 収録ごとのsilencedetect床から実効thresholdを決めるopt-in較正。
     *  省略/enabled:falseは従来のsilenceDbをそのまま使い、出力もバイト等価。 */
    calibration?: {
      enabled: boolean;
      method: "silencedetect-occupancy-v1";
      floorOffsetDb: number;
    };
    /** threshold較正とは独立に、無音圧縮の時間3ノブだけをpresetで置換するopt-in。 */
    silenceCompaction?: {
      enabled: boolean;
      preset:
        | "gentle" | "balanced" | "tight"
        | "compact-gentle" | "compact-balanced" | "compact-tight";
    };
    /** keep 端を実音声 RMS の発話エッジ+padSec へ詰める opt-in(C7)。
     *  省略/enabled:false は従来の keep 端のまま=出力バイト等価。 */
    edgeTrim?: {
      enabled: boolean;
      floorOffsetDb?: number;
      padSec?: number;
      maxTrimSec?: number;
    };
  };
  /** AI 設定の新しい入口。省略時は llm(旧設定)から解決し、両方無ければ claude-code */
  ai?: AiConfig;
  /** 旧 LLM 設定。互換のため読み続けるが、新規設定は ai.provider を使う */
  llm?: { backend: LegacyLlmBackend; model: string };
  /** カット判断 LLM(plan / plan --cuts-only / remeta)へ発話テキスト以外の
   * 知覚を添える設定。省略可(古い config.yaml との互換。省略時は全項目オフ=
   * plan の LLM 入力・plan.raw.txt が現状とバイト等価)。
   * §docs/plans/2026-07-07-plan-eyes-ears-design.md */
  plan?: {
    /** カット判断の積極度。safe=現状とバイト等価 / balanced=既定(明確な冗長は切る) /
     *  aggressive=テンポ最優先。省略時 balanced(D4)。rules/brief のマーカー行が優先。
     *  §docs/plans/2026-07-11-x4-editing-aggressiveness-design.md */
    editMode?: "safe" | "balanced" | "aggressive";
    /** 章(chapters.json + 「章」テロップ)を自動生成するか。省略時 false=
     *  plan/remeta は章を作らない(meta.json のタイトル案・概要欄は作る)。
     *  §docs/plans/2026-07-24-chapters-toggle-design.md */
    chapters?: boolean;
    /** カット判断と演出判断に分類 id を使わせる共通 opt-in 設定。
     *  cut は docs/edit-skills/cut/recipes / src/lib/reasonIds.ts、演出は
     *  docs/edit-skills/effects/recipes / src/lib/effectReasonIds.ts が単一の出所。
     *  省略/enabled=false のとき plan と plan-effects の LLM 入力・応答schema・
     *  編集JSONは本機能導入前とバイト等価(plan.perception / plan.styleProfile と
     *  同型の不変条件)。pattern はEP3までcut側だけが使う。
     *  §docs/plans/2026-07-20-cut-knowledge-p1-p2-design.md §4.2 */
    reasonIds?: {
      /** 注入の有効化。省略時 false(バイト等価) */
      enabled?: boolean;
      /** 収録タイプ(docs/edit-skills/patterns.md・cutPatterns.ts の
       *  CUT_PATTERN_IDS)。注入する分類の部分集合+blueprint を選ぶ。省略時
       *  "general"(13分類全部。P2 とバイト等価)。未知の値は警告のうえ
       *  "general" へ劣化する(前提エラーで plan を止めない)。
       *  §docs/plans/2026-07-20-cut-knowledge-p3-p5-design.md §2 */
      pattern?: string;
    };
    perception?: {
      /** 無音・間の注記(区間長 / 直前に落ちた素材秒 / 区間内無音秒)を
       *  プロンプトに添える。省略時 false。決定論・追加依存なし(推奨の opt-in) */
      audio?: boolean;
      /** 各区間の代表フレームの画面 OCR テキストをプロンプトに添える。
       *  省略時 false。macOS + Apple Vision が必要(無い環境は自動で劣化=
       *  OCR 部分を省いて続行)。区間数ぶんの ffmpeg クロップ+Vision が走る */
      ocr?: boolean;
      /** OCR をかける区間数の上限(コスト制御)。省略時
       *  DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS(40)。区間数がこれを超える場合は
       *  尺の長い区間を優先して上限まで */
      ocrMaxSegments?: number;
      /** 1区間あたりプロンプトに載せる OCR 行数の上限。省略時
       *  DEFAULT_PERCEPTION_OCR_MAX_LINES(6) */
      ocrMaxLines?: number;
      /** システム音声の発話(transcript.system.json)のうち各区間に重なるものを
       *  plan の知覚ブロックに添える。省略時 false。transcript.system.json が
       *  無ければ(= whisper.systemAudio 未使用)自動で劣化=ブロック省略 */
      systemSpeech?: boolean;
      /** カーソル操作(クリック回数・停留・待機カーソル比率)を各区間へ添える。
       *  省略時 false(バイト等価)。`<recording base>.cursor.json` サイドカー
       *  (record --watch。D1)が無ければ警告なしで注入をスキップする(opt-in の
       *  収録方式なので不在は異常ではない)。
       *  §docs/plans/2026-08-10-video-perception-p3-cursor-perception-design.md */
      cursor?: boolean;
      /** 知覚用の dwell 閾値。`plan.cursor`(演出用のズーム閾値)とは別軸
       *  (演出は長い停留・密集した停留を間引くが、知覚は全 dwell を数えたい)。
       *  省略時 DEFAULT_PERCEPTION_CURSOR_MIN_DWELL_MS(600) /
       *  DEFAULT_PERCEPTION_CURSOR_MOVE_THRESHOLD(0.02) */
      cursorDwell?: {
        minDwellMs?: number;
        moveThreshold?: number;
      };
      /** 待機系とみなす cursorType の完全一致リスト。省略時
       *  DEFAULT_PERCEPTION_CURSOR_WAIT_TYPES(["wait", "busybutclickable"]) */
      cursorWaitTypes?: string[];
    };
    /** plan --cuts-only のカット判断を「生成→観測→再調整」の有限反復にする
     * opt-in 設定。省略時は maxIterations=0 と同義で、従来の1ショットと
     * バイト等価。maxIterations >= 2 のときだけループする */
    loop?: {
      /** 最大反復回数。0 または 1 は従来どおり1ショット */
      maxIterations?: number;
      /** 目標出力尺(秒)。指定時は outDuration <= 値を内部アサーションに足す */
      targetOutDurationSec?: number | null;
      /** assertions.json + 目標尺が fail/error なしになったら停止する */
      stopWhenAssertionsPass?: boolean;
      secondaryObservation?: {
        enabled?: boolean;
        maxCalls?: number;
        maxImages?: number;
      };
    };
    /** cut 判断を tool + 検証ループのエージェントにする(H1=pull型知覚 /
     * H2=検証の主経路化)。opt-in・省略/agentic=false のとき plan --cuts-only の
     * 経路・生成プロンプト・cutplan.json は従来の単発/pushループとバイト等価
     * (§docs/plans/2026-07-11-h1-h2-agentic-perception-loop-design.md)。
     * 対象プロファイルのアダプタが tool-use(completeAgentic)非対応のときは
     * 警告のうえ既存経路へ自動フォールバックする */
    harness?: {
      /** 既定 false。true でも要 ai の structured route が anthropic 等
       * completeAgentic 対応アダプタであること(非対応なら実質 off) */
      agentic?: boolean;
      /** 1生成ターンあたりの tool 呼び出し上限。既定 16(コスト/レイテンシの天井) */
      maxToolCalls?: number;
      /** 既定 false。候補内部を語境界で分割する書込み tool(list_words/
       * split_candidate)を追加する(H6・R0 突破)。要 agentic:true。
       * LLM は語 index しか書かず、分割は validate/assert 通過時のみ書かれ
       * ロールバックされる(§docs/plans/2026-07-11-h6-apply-hybrid-r0-breakthrough-design.md)。
       * agentic の内側の入れ子 opt-in(既定 off で SD4 とバイト等価) */
      applySplit?: boolean;
      /** 1ターンの分割上限(確信区間のみ=全面 apply 移行はしない)。既定 4 */
      maxSplits?: number;
      /** 個別 tool の on/off。省略時は全 on。describe_timeline/set_cuts/
       * run_assert は常時有効(this では止められない) */
      tools?: {
        frames?: boolean;
        av?: boolean;
        materials?: boolean;
        ocr?: boolean;
      };
    };
    /** SD-T0 が抽出した style profile を compact な soft prior として plan /
     *  plan --cuts-only のプロンプトへ注入する opt-in 設定。省略/enabled=false の
     *  とき plan の LLM 入力・plan.raw.txt は導入前とバイト等価(plan.perception と
     *  同型の不変条件)。番号選択方式は維持=LLM に精密な値は書かせない(§8 不変条件5)。
     *  brief.md に劣後するソフトな prior として注入される(§6.2)。
     *  §docs/plans/2026-07-12-sd-t4-style-injection-design.md */
    styleProfile?: {
      /** 注入の有効化。省略時 false(バイト等価)。true で channel 直下
       *  style.probe/<profile>.json を読み compact policy を prompt に添える */
      enabled?: boolean;
      /** 読み込む profile 名(style.probe/<profile>.json)。省略時 "default"。
       *  style-profile --name と対応 */
      profile?: string;
    };
    /** OpenScreen 移植 D2: カーソル dwell(停留)からズーム候補を作る
     *  plan-effects の演出アンカー生成(cursorAnchors.ts)の閾値。省略時は
     *  全て既定値(DEFAULT_PLAN_CURSOR_*。OpenScreen 自身のチューニング値)。
     *  `<recording base>.cursor.json` サイドカー(record --watch。D1)が
     *  無ければ一切参照されない(この機能導入前とバイト等価)。
     *  §docs/plans/2026-07-24-openscreen-d2-dwell-suggestion-design.md */
    cursor?: {
      /** 停留とみなす最小継続時間(ms)。省略時 DEFAULT_PLAN_CURSOR_MIN_DWELL_MS(450) */
      minDwellMs?: number;
      /** 停留とみなす最大継続時間(ms。これを超えると意図的な作業とみなし除外)。
       *  省略時 DEFAULT_PLAN_CURSOR_MAX_DWELL_MS(2600) */
      maxDwellMs?: number;
      /** 隣接サンプル間でこれを超える移動(正規化座標)があれば停留を打ち切る。
       *  省略時 DEFAULT_PLAN_CURSOR_MOVE_THRESHOLD(0.02) */
      moveThreshold?: number;
      /** 採用済み候補の中心からこの間隔(ms)未満の候補は間引く。省略時
       *  DEFAULT_PLAN_CURSOR_SPACING_MS(1800) */
      spacingMs?: number;
      /** focus点からズーム rect を作るときの倍率(w=screenRegion.w/scale)。
       *  省略時 DEFAULT_PLAN_CURSOR_DEFAULT_SCALE(2.5) */
      defaultScale?: number;
      /** クリック起点(leftButtonPressed 直後)の dwell に与える strength 倍率。
       *  省略時 DEFAULT_PLAN_CURSOR_CLICK_BOOST(1.5)。1 で無効化 */
      clickBoost?: number;
      /** dwell 窓長の上限(ms)。clamp(総尺の5%, 1000, これ)。省略時
       *  DEFAULT_PLAN_CURSOR_MAX_WINDOW_MS(3500)。追従(枝A)前の長尺ドリフト対策 */
      maxWindowMs?: number;
      /** スクロール誤爆抑制(枝D)の scene score 閾値。`av.probe/motion.json`
       *  があるときだけ効く(無ければ無視。この機能導入前とバイト等価)。
       *  カーソル静止×画面モーション大(スクロール/再生中動画)の区間の
       *  dwell サンプルを検出前段で除去する。省略時
       *  DEFAULT_PLAN_CURSOR_SCROLL_MOTION_THRESHOLD(0.4)。av の scene score
       *  スケールに合わせて収録で較正する。
       *  §docs/plans/2026-07-24-openscreen-zoom-D-scroll-suppression-design.md */
      scrollMotionThreshold?: number;
      /** run(収録直後の初回一括)の末尾で、カーソル dwell 由来の zoom を
       *  決定論で自動挿入するか。省略時 true。false でも `autozoom` /
       *  `plan-effects` コマンド自体は閾値(このオブジェクトの他フィールド)を
       *  使い続ける(run の自動挿入だけを止める別軸)。
       *  §docs/plans/2026-07-24-openscreen-autozoom-placement-design.md D6 */
      autoZoom?: boolean;
    };
  };
  /** plan の候補格子を語タイムスタンプ(transcript.words)由来の語境界でも
   *  分割する(C1)+ 候補テキストを実際に残る語だけにする(C8)。省略可
   *  (古い config.yaml との互換。省略時 enabled=false=バイト等価)。
   *  §docs/plans/2026-07-11-c1-word-candidate-grid-design.md */
  candidates?: {
    /** 細分化+語ベーステキストの有効化。省略時 false */
    enabled?: boolean;
    /** これ以上長い keep だけを分割対象にする(秒)。省略時
     *  DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC(6) */
    splitOnlyLongerThanSec?: number;
    /** 語間ギャップがこの秒以上なら分割点候補にする。省略時
     *  DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC(0.3) */
    minSplitGapSec?: number;
    /** 分割後の各 sub-candidate の最小尺(秒)。省略時
     *  DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC(0.5) */
    minCandidateSec?: number;
    /** フィラー語(単独の候補として切り出せるようにする)。省略時
     *  DEFAULT_CANDIDATES_FILLERS */
    fillers?: string[];
  };
  /** 素材(B-roll)配置候補の自動生成(plan-materials)。番号選択方式で
   *  overlays[] の下書きを生成する(§docs/plans/2026-07-11-m1-material-placement-candidates-design.md)。
   *  省略時は全て既定値(DEFAULT_PLAN_MATERIALS_*) */
  planMaterials?: {
    /** 素材を置けるアンカーにする keep span の最小尺(秒)。省略時
     *  DEFAULT_PLAN_MATERIALS_MIN_SPAN_SEC(3.0) */
    minSpanSec?: number;
    /** 1回の生成で作る overlay の上限(出しすぎ防止)。省略時
     *  DEFAULT_PLAN_MATERIALS_MAX_PLACEMENTS(8) */
    maxPlacements?: number;
    /** 生成する overlay の既定音量(0〜2)。省略時
     *  DEFAULT_PLAN_MATERIALS_DEFAULT_VOLUME(0=無音) */
    defaultVolume?: number;
    /** 生成する overlay の既定 fit。省略時 "contain" */
    defaultFit?: "contain" | "cover";
    /** 生成する overlay の既定 rect(出力px)。省略=全画面。指定で PIP(ワイプ) */
    defaultRect?: { x: number; y: number; w: number; h: number };
  };
  /** 素材の尺整合・dangling 検出(material-fit)。要 materials <dir> の事前実行。
   *  出力は apply パッチ下書き(material-fit.suggested.json)で、適用は人間が
   *  apply で行う。省略時は全て既定値(DEFAULT_MATERIAL_FIT_*)
   *  (§docs/plans/2026-07-11-m2-m3-material-fit-dangling-design.md) */
  materialFit?: {
    /** 尺超過判定の許容誤差(秒)。省略時 DEFAULT_MATERIAL_FIT_OVERRUN_EPS_SEC(0.1) */
    overrunEpsSec?: number;
    /** 実尺が宣言尺の何倍で「大半未使用」とみなすか。省略時
     *  DEFAULT_MATERIAL_FIT_UNDERRUN_RATIO(2.0) */
    underrunRatio?: number;
    /** 尺不足で延長 set を出すか。省略時 false(reason のみ) */
    suggestUnderrunExtend?: boolean;
    /** dangling 貼り替え候補の上限。省略時 DEFAULT_MATERIAL_FIT_MAX_REPLACEMENTS(3) */
    maxReplacements?: number;
  };
  /** 静止画クリップの生成既定と長尺警告。省略時は DEFAULT_STILLS_* */
  stills?: {
    defaultDurationSec?: number;
    /** 1件が出力尺に占める割合。この値以下、または 0 で警告しない */
    maxShareWarnRatio?: number;
  };
  /** 演出(zoom/blur/annotation)候補の自動生成(plan-effects)。番号+種別選択
   *  方式で overlays.json の zooms/blurs/annotations を下書き生成する
   *  (§docs/plans/2026-07-11-e1-e2-effect-anchor-candidates-design.md)。
   *  要 frames --ocr / av の事前実行。省略時は全て既定値(DEFAULT_PLAN_EFFECTS_*) */
  planEffects?: {
    /** 1回で作る演出の上限(出しすぎ防止)。省略時
     *  DEFAULT_PLAN_EFFECTS_MAX_DECISIONS(6) */
    maxDecisions?: number;
    /** アンカー時刻の前後に張る表示窓(秒)。省略時
     *  DEFAULT_PLAN_EFFECTS_ANCHOR_WINDOW_SEC(3.0) */
    anchorWindowSec?: number;
    /** motion アンカーにする sceneScore 下限。省略時
     *  DEFAULT_PLAN_EFFECTS_MIN_SCENE_SCORE(0.4) */
    minSceneScore?: number;
    /** OCR box をアンカーにする最小面積(px^2。小さい文字を除外)。省略時
     *  DEFAULT_PLAN_EFFECTS_MIN_OCR_BOX_AREA_PX(8000) */
    minOcrBoxAreaPx?: number;
    /** zoom rect の最小サイズ(拡大しすぎ防止)。省略時
     *  DEFAULT_PLAN_EFFECTS_MIN_ZOOM_RECT */
    minZoomRect?: { w: number; h: number };
    /** blur の既定強度(0..1)。省略時
     *  DEFAULT_PLAN_EFFECTS_DEFAULT_BLUR_STRENGTH(0.5) */
    defaultBlurStrength?: number;
  };
  /** BGM 配置候補の自動生成(plan-bgm)。B1(章×テンションでの区間割り)+
   *  B3(切替点の意味化)。切替アンカー(章境界/大カット境界)は決定論、
   *  曲は人間が materials/ or bgm.* に置いたものから番号選択する
   *  (§docs/plans/2026-07-11-b1-b3-bgm-placement-candidates-design.md)。
   *  省略時は全て既定値(DEFAULT_PLAN_BGM_*) */
  planBgm?: {
    /** 「大カット境界」とみなす cut 尺の下限(秒)。省略時
     *  DEFAULT_PLAN_BGM_BIG_CUT_SEC(3.0) */
    bigCutSec?: number;
    /** BGM スロットの最小尺(秒)。これ未満は前後へ吸収する。省略時
     *  DEFAULT_PLAN_BGM_MIN_SLOT_SEC(8.0) */
    minSlotSec?: number;
    /** スロット上限(区切りすぎ防止)。省略時 DEFAULT_PLAN_BGM_MAX_SLOTS(12) */
    maxSlots?: number;
  };
  /** 演出の検品(effect-check)。E3(座標視覚検証)+ E4(zoom 相互作用)+
   *  E5(密度ガード)。決定論チェックは常時、VLM は vision route があり
   *  useVlm=true のときだけ(§docs/plans/2026-07-11-e3-e4-e5-effect-visual-verification-design.md)。
   *  省略時は全て既定値(DEFAULT_EFFECT_CHECK_*) */
  effectCheck?: {
    /** 密度判定の窓(秒)。省略時 DEFAULT_EFFECT_CHECK_DENSITY_WINDOW_SEC(5.0) */
    densityWindowSec?: number;
    /** 窓内の演出本数の上限。省略時 DEFAULT_EFFECT_CHECK_MAX_PER_WINDOW(3) */
    maxPerWindow?: number;
    /** annotation 表示尺の上限(秒)。省略時 DEFAULT_EFFECT_CHECK_MAX_ANNOTATION_SEC(8.0) */
    maxAnnotationSec?: number;
    /** 「重なり」とみなす rect 交差率。省略時 DEFAULT_EFFECT_CHECK_MIN_RECT_OVERLAP_RATIO(0.3) */
    minRectOverlapRatio?: number;
    /** VLM 二次確認を使うか。省略時 DEFAULT_EFFECT_CHECK_USE_VLM(true)。
     *  vision route 不在なら実行時に自動で無効になる */
    useVlm?: boolean;
  };
  /** HyperFrames カードの render 不要な動的監査(hyperframe-check)。
   *  headless Chrome で srcdoc を時間グリッド seek し、論理アニメーション状態
   *  (ピクセルではない)から dead-zone / 終端未完了 / 画面外終端 / seek 無反応 /
   *  一斉登場を検出する。決定論のみ・常に exit 0・warn/info のみ。
   *  省略時は全て既定値(DEFAULT_HYPERFRAME_CHECK_*) */
  hyperframeCheck?: {
    /** サンプル間隔(秒)。省略時 DEFAULT_HYPERFRAME_CHECK_STEP_SEC(0.1) */
    stepSec?: number;
    /** 終端未完了とみなす、最終フレームでの完了進捗(0..1)の下限。
     *  省略時 DEFAULT_AUDIT_THRESHOLDS.terminalProgressThreshold(0.4) */
    terminalProgressThreshold?: number;
    /** 「可視」とみなす opacity の下限。省略時 DEFAULT_AUDIT_THRESHOLDS.offscreenOpacityGate(0.05) */
    offscreenOpacityGate?: number;
    /** dead zone とみなす無変化区間の尺の比率。省略時 DEFAULT_AUDIT_THRESHOLDS.deadZoneMaxFrac(0.5) */
    deadZoneMaxFrac?: number;
    /** simultaneous-entry の対象とする最小要素数。省略時 DEFAULT_AUDIT_THRESHOLDS.entryMinElements(3) */
    entryMinElements?: number;
    /** simultaneous-entry の「同時」とみなす許容フレーム数。省略時 DEFAULT_AUDIT_THRESHOLDS.entryEpsilonFrames(2) */
    entryEpsilonFrames?: number;
    /** VLM 二次確認を使うか(commit 2 で実装)。省略時 DEFAULT_HYPERFRAME_CHECK_USE_VLM(true) */
    useVlm?: boolean;
  };
  /** E7: 演出検品(effect-check)の警告を plan-effects の再生成へ観測として
   *  戻す opt-in フラグ(§docs/plans/2026-07-11-e6-e7-effect-review-loop-design.md)。
   *  省略時 observe=false(バイト等価。plan-effects の出力は導入前と不変)。
   *  observe=true でも `plan-effects --observe`(明示フラグ)か、こちらの
   *  config どちらかが true であれば有効(フラグと config は OR) */
  effectReview?: {
    /** 前回 effect-check.json の警告を次の plan-effects の観測として渡すか。
     *  省略時 false。命令ではなく参考情報(過補正回避のため強制はしない) */
    observe?: boolean;
  };
  /** BGM の音量/被り/単調の検出と調整提案(bgm-fit)。B2(無音/被り回避の
   *  音量・duck・切替調整)+ B4(単調 fallback 検出)。要 av <dir> の
   *  事前実行。出力は apply パッチ下書き(bgm-fit.suggested.json)で、
   *  適用は人間が apply で行う。省略時は全て既定値(DEFAULT_BGM_FIT_*)
   *  (§docs/plans/2026-07-11-b2-b4-bgm-audio-aware-design.md) */
  bgmFit?: {
    /** 発話 RMS を BGM がこの dB 下回るまで下げる(被り回避)。省略時
     *  DEFAULT_BGM_FIT_SPEECH_HEADROOM_DB(8) */
    speechHeadroomDb?: number;
    /** 無音区間で BGM を下げる量。省略時 DEFAULT_BGM_FIT_SILENCE_DUCK_DB(3) */
    silenceDuckDb?: number;
    /** 全体ラウドネス目標(超過で loud 判定)。省略時
     *  DEFAULT_BGM_FIT_TARGET_LUFS(-14) */
    targetLufs?: number;
    /** no-fade 判定で付ける fade 秒。省略時 DEFAULT_BGM_FIT_MIN_FADE_SEC(1.0) */
    minFadeSec?: number;
    /** 単一 file が総尺のこの割合超で monotone。省略時
     *  DEFAULT_BGM_FIT_MONOTONE_COVER_RATIO(0.9) */
    monotoneCoverRatio?: number;
    /** 章がこの数以上あると BGM 単調を警告。省略時
     *  DEFAULT_BGM_FIT_MIN_CHAPTERS_FOR_VARIETY(3) */
    minChaptersForVariety?: number;
  };
  /** describe(操作エージェント向け)の任意露出。省略可・全オフが既定。
   *  無いときは散文・--json ともに導入前とバイト等価 */
  describe?: {
    /** keep 内に残った無音(間)の「位置と長さ」を describe に出す。省略時 false。
     *  cuts.auto.json の silences から算出(新規計測なし) */
    pauses?: boolean;
    /** 1区間あたり出す間の件数上限。省略時 DEFAULT_DESCRIBE_PAUSE_MAX(3) */
    pauseMax?: number;
    /** これ以上の長さの間だけ出す(秒)。省略時 DEFAULT_DESCRIBE_PAUSE_MIN_SEC(0.6) */
    pauseMinSec?: number;
    /** 画面状態の区間(`screen.probe/index.json`)を describe の**散文**へ
     *  `[画面]` 行として出す。省略時 false(散文はバイト等価。fs にも触らない)。
     *  `describe --json` の `screen` キーはこの設定と無関係で、
     *  `screen.probe/index.json` が在れば常に出る(不在なら省略)。
     *  §docs/plans/2026-08-10-video-perception-p1-screen-probe-design.md §2.7 */
    screen?: boolean;
  };
  preview: {
    width: number;
    /** proxy.mp4 / preview.mp4 のビデオエンコーダ。省略時 "videotoolbox"
     * (macOS のハードウェアエンコーダ h264_videotoolbox。生成時間はほぼ同等で
     * ファイルサイズが小さい)。"libx264" で従来の ultrafast+CRF に戻せる。
     * 実測は docs/perf.md 参照 */
    videoEncoder?: "libx264" | "videotoolbox";
    /** proxy.mp4 をオールイントラ(GOP=1。全フレーム I)でエンコードするか。
     * 省略時 true。エディタはカット境界ごとに proxy.mp4 をシークして繋ぐため、
     * オールイントラだと直前キーフレームからのデコード待ちが無くなる
     * (代償はファイルサイズ増。proxy は再生成可能なキャッシュなので許容)。
     * false で従来の GOP=PROXY_GOP_FRAMES(0.2秒)エンコードに戻せる。
     * preview.mp4 / preview-cut.mp4 には影響しない(proxy.mp4 専用) */
    proxyIntra?: boolean;
    /** エディタのプレビュー描画エンジン。省略時 "canvas"(WebCodecs+自前WGSL
     * コンポジタ。M3b)。"legacy" で従来の Remotion Player + bake 経路に戻せる。
     * "canvas" 指定でも navigator.gpu 不在/初期化失敗時は実行時に "legacy" へ
     * 自動フォールバックする(WebGL2 フォールバックは無い。M3a §2 の決定)。
     * 書き出し(preview.mp4/final.mp4)には影響しない(エディタのプレビューのみ) */
    engine?: "canvas" | "legacy";
  };
  /** エディタ(GUI)設定。省略可(古い config.yaml との互換) */
  editor?: {
    /** 素材アップロード(/api/upload)の1ファイルの上限(MB)。省略時は既定値 */
    maxUploadMb?: number;
    /** ベースメディアアップロード(/api/upload?as=base)の上限(MB)。 */
    maxBaseUploadMb?: number;
    /** タイムラインに置く画像素材・尺不明素材の既定の尺(秒)。
     * 省略時は DEFAULT_IMAGE_DURATION_SEC */
    defaultImageDurationSec?: number;
    /** タイムラインのフィルムストリップ(editor-perf P1)。省略時は既定値 */
    thumbstrip?: {
      intervalSec?: number;
      tileWidthPx?: number;
      columns?: number;
      rows?: number;
    };
    aiReview?: {
      /** before/after still を外部APIへ送る明示的opt-in。既定false */
      vlm?: boolean;
      /** APIへ送る画像枚数。1-4、既定4 */
      maxImages?: number;
      /** GUI refine の上限。既定2、最大3 */
      maxRefinements?: number;
    };
  };
  /** HyperFrame authoring のローカル入力制限。省略時は安全な既定値を使う。 */
  hyperframe?: {
    assets?: {
      /** 添付画像1ファイルの最大byte数。省略時 2MiB。 */
      maxBytes?: number;
      /** 1回の author に添付できる画像の合計最大byte数。省略時 6MiB。 */
      maxTotalBytes?: number;
    };
  };
  render: {
    /** ingest 時の既定キャンバス。--canvas が優先。省略時 landscape。 */
    canvas?: string;
    /** ingest 時の既定ベース配置。--base-layout が優先。省略時 auto。 */
    baseLayout?: string;
    wipeWidthPx: number;
    wipeMarginPx: number;
    /** ワイプ全画面(wipeFull)の出入りの遷移時間(秒)。
     * 省略時 DEFAULT_WIPE_TRANSITION_SEC。0 で従来どおり瞬時に切り替わる */
    wipeTransitionSec?: number;
    /** カット境界のトランジション。省略時 type: "none"(既存挙動と完全一致・
     * 瞬時に切り替わる)。"dip-to-black" で keep 境界の前後に黒フェードを
     * 被せる(尺不変: cut.mp4 には触れず Remotion 合成層でのオーバーレイ)。
     * sec は黒への往復の合計秒(前半でフェードアウト、後半でフェードイン)。
     * 省略時 DEFAULT_CUT_TRANSITION_SEC(0.3) */
    cutTransition?: {
      type?: "none" | "dip-to-black";
      sec?: number;
    };
    captionFontSizePx: number;
    /** テロップ既定の文字色。省略時 CAPTION_DEFAULT_COLOR(#ffffff) */
    captionColor?: string;
    /** テロップ既定の縁取り色。省略時 CAPTION_DEFAULT_OUTLINE(#2563eb)。
     * "none" で縁取りなし */
    captionOutlineColor?: string;
    /** テロップ既定のフォント種(CSS font-family)。
     * 省略時 CAPTION_DEFAULT_FONT_FAMILY(日本語ゴシック) */
    captionFontFamily?: string;
    /** テロップ既定の太さ(100〜900)。省略時 CAPTION_DEFAULT_FONT_WEIGHT(700) */
    captionFontWeight?: number;
    /** テロップ既定の座布団(背景帯)。省略時は背景帯なし */
    captionBackground?: CaptionBackground;
    chapterCardSec: number;
    targetLufs: number;
    /** システム音声(ingest.systemTrack)のミックス設定。
     * 省略時はミックスしない(古い config.yaml との互換) */
    systemAudio?: { mix: boolean; volumeDb: number };
    /** マイク音声のノイズ除去(ffmpeg afftdn)。システム音声はデジタル由来で
     * ノイズが無く劣化するだけなので対象外。省略時 mic: false / noiseFloorDb: -25
     * (古い config.yaml との互換) */
    denoise?: { mic: boolean; noiseFloorDb: number };
    bgm: {
      volumeDb: number;
      fadeOutSec: number;
      /** 発話中に BGM を下げるダッキング。省略か duckDb: 0 で無効 */
      ducking?: { duckDb: number; fadeSec: number };
    };
    /** Remotion 合成段のハードウェアエンコーダ利用。if-possible: 使えれば
     * 使う(macOS は VideoToolbox。使えない環境はソフトウェアへ自動
     * フォールバック)。disable: 常にソフトウェアエンコード(従来動作)。
     * 省略時 "if-possible" */
    hardwareAcceleration?: "if-possible" | "disable";
    /** チャンク単位の差分レンダー(render.chunks/)の目標チャンク長(秒)。
     * 直前フルレンダー以降、映像に効く要素(テロップ・位置・ワイプ等)だけを
     * 変えた再実行で、変わったチャンクだけ再レンダーして連結する。
     * 音声・keeps・全域設定を変えたときは自動でフルレンダーに戻る。
     * 省略・0 で機能オフ(常にフルレンダー。従来どおり render.chunks/ には
     * 一切触れない)。詳細は docs/render-chunk-cache.md */
    chunkSec?: number;
    /** Remotion 合成段(OffthreadVideo)のフレームキャッシュ上限(MB)。
     * Remotion の既定は「利用可能メモリの半分」で、16GB 機では compositor が
     * render 中に数GBまで成長し、マシン全体のメモリプレッシャー(スワップ・
     * 他アプリの鈍化)を招く(実測は docs/perf.md フェーズ9)。省略時
     * DEFAULT_OFFTHREAD_VIDEO_CACHE_MB(512)。0 で Remotion 既定(無制限=
     * 利用可能メモリの半分)に戻す。出力の画・音には影響しない(renderKey
     * にも含めない=変更しても final.mp4 の再生成は誘発しない) */
    offthreadVideoCacheMb?: number;
    /** Remotion 合成段の並列レンダータブ数。省略時は Remotion 既定
     * (CPU コア数の半分)。メモリの節約(1タブ ≈ 350〜400MB)を優先したい
     * ときに下げる。出力には影響しない(renderKey にも含めない) */
    concurrency?: number;
    /** ズーム演出(overlays.json の zooms)の既定設定。省略可 */
    zoom?: {
      /** ズームイン/アウトの遷移秒数(両方未指定時の後方互換値)。
       * easeInSec/easeOutSec のどちらも未指定のときだけ使われ、両方に同じ
       * 値を適用する(対称のまま値だけ引き継ぐ)。zooms[].easeSec/easeOutSec
       * で個別指定があればそちらが最優先 */
      easeSec?: number;
      /** ズームインの遷移秒数。省略時は easeSec、それも無ければ
       * DEFAULT_ZOOM_EASE_IN_SEC(1.5。OpenScreen 移植 D3)。
       * zooms[].easeSec で個別指定があればそちらが優先 */
      easeInSec?: number;
      /** ズームアウトの遷移秒数。省略時は easeSec、それも無ければ
       * DEFAULT_ZOOM_EASE_OUT_SEC(1.0。OpenScreen 移植 D3。入りより短い
       * 非対称が既定)。zooms[].easeOutSec で個別指定があればそちらが優先 */
      easeOutSec?: number;
      /** ズーム中にカメラワイプを右下アンカーで縮める倍率。省略時
       * DEFAULT_ZOOM_WIPE_SCALE(0.8)。1 で縮小なし(従来どおり)。
       * 縮小・復帰のトランジションは zoom 本体と同じ(easeSec/easeOutSec を
       * 共有。専用の時間設定は無い)。zoom 1件ごとの上書きは非目標
       * (overlays.json のスキーマは変えない) */
      wipeScale?: number;
      /** 隣接ズームを連鎖(パン遷移)とみなす gap の上限(秒)。省略時
       * DEFAULT_ZOOM_CHAIN_GAP_SEC(1.5)。0 <= gap <= この値で連鎖、
       * 負の gap(重なり。validate がそもそもエラーにする)は連鎖にしない。
       * OpenScreen 移植 D3(#2・D2a) */
      chainGapSec?: number;
      /** 先読み(pre-roll)。区間開始のこの秒だけ前からイーズインを開始し、
       * 開始時点で既に `leadSec/easeIn` まで寄っている状態にする(「見せたい
       * 瞬間には既に寄り終わっている」)。省略時 DEFAULT_ZOOM_LEAD_SEC(0.5)。
       * 0 で無効(従来どおり区間開始から寄り始める)。連鎖側(前と隙間なく
       * 接する区間)には効かない(既に前 rect からパンで入るため)。
       * OpenScreen 移植 D3(#1・D1c) */
      leadSec?: number;
      /** gap のある連鎖(chainGapSec 以内だが完全隣接ではない)のパン遷移秒数。
       * gap 区間(前の end 〜 次の start)は前 rect のフルズームを保持し、
       * 次区間の頭からこの秒数でパンする。省略時 DEFAULT_ZOOM_CHAIN_PAN_SEC(1.0)。
       * 完全隣接(gap=0。従来どおりの連鎖)には効かず easeInSec を使う。
       * OpenScreen 移植 D3(#2・D2b) */
      chainPanSec?: number;
      /** baked(focusMode)ズーム中のワイプ縮小の下限(0..1)。省略時 0.35
       * (OpenScreen WEBCAM_REACTIVE_ZOOM_MIN_SCALE 逐語。src/lib/zoom.ts の
       * DEFAULT_WEBCAM_REACTIVE_MIN_SCALE)。1.0=縮小なし、値を上げるほど
       * 縮小が穏やかになる。legacy(baked 無し)経路には効かない */
      webcamReactiveMinScale?: number;
    };
    /** ベースレイアウトのデザイン。plain は背景画像 + 画面パネル、
     * obs-canvas はさらにカメラ円を描く。縦プロファイルには継承しない。
     * 省略 / enabled: false で各収録レイアウトの従来描画とバイト等価。
     * 有効時は静的design assetが揃えばdesign FAST基底で合成し、欠ければ
     * 通常のRemotionレンダーへ保守的にフォールバックする
     * (§src/lib/design.ts。docs/programs/render-fastpath-program.md) */
    design?: DesignConfig;
  };
  /** 画面 OCR(frames --ocr)。Apple Vision の認識設定のうち、収録の言語構成で
   * 変わりうるものだけを置く(認識レベル・言語補正はコード内の閉じた定数。
   * src/lib/ocr.ts)。省略可(古い config.yaml との互換。frames --ocr を
   * 使わない限り読まれず既存挙動は不変) */
  ocr?: {
    /** 認識言語の優先順(Vision の recognitionLanguages)。
     * 省略時 DEFAULT_OCR_LANGUAGES(["en", "ja"]) */
    languages?: string[];
  };
  /** 常駐フレームサーバ(frames-serve)。省略可(古い config.yaml との互換)。
   * 有効化フラグはここには置かない(opt-in は `frames-serve` の明示起動で
   * 担保する。config はポート番号を変えたいときだけ使う任意の項目) */
  frames?: {
    serve?: {
      /** frames-serve の待受ポート。省略時 DEFAULT_SERVE_PORT(4311)。
       * CLI の --port が指定されていればそちらが優先 */
      port?: number;
    };
    /** frames --scenes(画面の変化点+静止区間の代表を自動選択して撮る)の
     * 閾値。省略可(古い config.yaml との互換。--scenes を使わない限り
     * 読まれず既存挙動は不変)。全キー省略可・既定値は
     * src/lib/sceneSampling.ts の DEFAULT_SCENE_SAMPLING_CFG。
     * video-perception-P0 §2.4 */
    scenes?: {
      /** scdet の sceneScore がこれ以上なら変化点とみなす */
      sceneThreshold?: number;
      /** 変化点をこれ未満の間隔で連続採用しない(av.everySec より大きくすること) */
      minGapSec?: number;
      /** 1回の --scenes で撮る上限枚数。CLI の --max-shots が指定されて
       * いればそちらが優先 */
      maxShots?: number;
      /** 静止区間にこの秒ごとに1枚 */
      frozenShotEverySec?: number;
      /** 1つの静止区間から取る最大枚数 */
      frozenMaxShotsPerSpan?: number;
    };
  };
  av?: {
    everySec?: number;
    cols?: number;
    windowSec?: number;
    scdetThreshold?: number;
    freeze?: {
      noiseDb?: number;
      durationSec?: number;
    };
    stripWidthPx?: number;
  };
  /** `screen <dir>`(画面状態の区間トラック。要 av <dir> の事前実行)の閾値。
   * 省略可(古い config.yaml との互換。全キー省略可・既定値は
   * src/stages/screen.ts の DEFAULT_SCREEN_*)。`frames.scenes` とは別キー
   * (同じ selectSceneTimes を呼ぶが較正の目標が違うため独立に動かせる)。
   * video-perception-P1 §2.6 */
  screen?: {
    /** OCR にかけるサンプル数の上限(= selectSceneTimes の maxShots) */
    maxSamples?: number;
    /** selectSceneTimes へ渡す間引き間隔(秒) */
    minGapSec?: number;
    /** selectSceneTimes へ渡す(静止区間の代表を取る間隔) */
    frozenShotEverySec?: number;
    /** selectSceneTimes へ渡す(1つの静止区間から取る最大枚数) */
    frozenMaxShotsPerSpan?: number;
    /** 隣接サンプルの OCR 行 Jaccard 係数がこれ以上なら同一画面とみなす */
    mergeThreshold?: number;
    /** 境界の追認に使う scene score */
    sceneThreshold?: number;
    /** これ未満の区間は前へ吸収する。av.everySec 以下にすると吸収が機能しない
     * (実行時に警告する。エラーにはしない) */
    minSegmentSec?: number;
    /** index.json に載せる OCR 行数(全行は Layer 1 の ocr/*.json) */
    indexLines?: number;
    /** `screen --summarize`(video-perception-P4。区間へ VLM 1 行要約を付ける。
     * 既定オフ=このキーは `--summarize` を使わない限り一切読まれない)の
     * コスト制御。省略可(全キー省略時は DEFAULT_SCREEN_SUMMARIZE_*) */
    summarize?: {
      /** 1回の --summarize で VLM に送る上限区間数。超過分は長い区間を優先し、
       * 切った件数を stdout に出す(P4 §2.7) */
      maxSegments?: number;
      /** 1回の VLM 呼び出しの出力トークン上限。1行40字なので既定は小さい */
      maxOutputTokens?: number;
    };
  };
  /** `record --watch`(D1。カーソル座標の取得)。省略可(古い config.yaml との
   * 互換。使わない限り読まれず既存挙動は不変)。撮影は OBS を維持したまま、
   * obs-websocket 経由で録画ボタンに自動連動する常駐 watcher の接続設定。
   * §docs/plans/2026-07-24-openscreen-d1-cursor-telemetry-design.md */
  record?: {
    obsWebsocket?: {
      /** 省略時 "localhost" */
      host?: string;
      /** 省略時 4455(obs-websocket の既定ポート) */
      port?: number;
      /** OBS の「WebSocket サーバー設定」→「認証を有効にする」時のみ必須。
       * config.yaml は git 管理下のため平文パスワードは書かない
       * (ai.profiles.*.auth.apiKeyEnv と同じ流儀)。環境変数名を書き、
       * 実際の値は .env / シェル環境から読む。認証無効の OBS では省略可 */
      passwordEnv?: string;
    };
    /** カーソルヘルパのサンプリング間隔(ms)。省略時 DEFAULT_RECORD_SAMPLE_INTERVAL_MS(33) */
    sampleIntervalMs?: number;
  };
  /** ログ/可観測性。workflow(AI 呼び出し・ステージ・外部ツール)を stderr に
   *  どれだけ出すか。省略時 normal(既定挙動=AI 行+ステージが出る)。
   *  quiet で AI 行も抑止、verbose で ffmpeg/whisper/remotion まで1行ずつ。
   *  FRAMEWRIGHT_LOG 環境変数・グローバル --verbose/--quiet が config より優先。
   *  stdout(JSON 射影)は level に関わらず不変 */
  log?: { level?: LogLevel };
}

/** editor.defaultImageDurationSec 未指定時の既定(秒) */
export const DEFAULT_IMAGE_DURATION_SEC = 4;

export const DEFAULT_AI_TIMEOUT_MS = 120_000;
export const DEFAULT_AI_MAX_RETRIES = 1;
export const DEFAULT_AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 8192;
export const MAX_AI_IMAGES = 4;
/** legacy(ai.provider)/既定経路が使う内部 profile 名。ユーザーは使えない(予約語) */
export const LEGACY_AI_PROFILE = "legacy-default";

export function resolveHyperframeAssetLimits(cfg: Config): {
  maxBytes: number;
  maxTotalBytes: number;
} {
  return {
    maxBytes: cfg.hyperframe?.assets?.maxBytes ?? DEFAULT_HYPERFRAME_ASSET_MAX_BYTES,
    maxTotalBytes: cfg.hyperframe?.assets?.maxTotalBytes ?? DEFAULT_HYPERFRAME_ASSET_MAX_TOTAL_BYTES,
  };
}

export function resolveAiReviewCfg(cfg: Config): { vlm: boolean; maxImages: number } {
  const requested = cfg.editor?.aiReview?.maxImages ?? 4;
  return {
    vlm: cfg.editor?.aiReview?.vlm ?? false,
    maxImages: Math.max(1, Math.min(MAX_AI_IMAGES, Math.trunc(requested))),
  };
}

/** plan.perception.ocrMaxSegments 未指定時の既定(区間数) */
export const DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS = 40;

/** plan.perception.ocrMaxLines 未指定時の既定(行数) */
export const DEFAULT_PERCEPTION_OCR_MAX_LINES = 6;

/** plan.perception.cursorDwell.minDwellMs 未指定時の既定(ms)。
 *  `plan.cursor.minDwellMs`(演出用。既定450)とは別軸なので値も独立(§2.4) */
export const DEFAULT_PERCEPTION_CURSOR_MIN_DWELL_MS = 600;

/** plan.perception.cursorDwell.moveThreshold 未指定時の既定(正規化座標) */
export const DEFAULT_PERCEPTION_CURSOR_MOVE_THRESHOLD = 0.02;

/** plan.perception.cursorWaitTypes 未指定時の既定(cursorType の完全一致リスト) */
export const DEFAULT_PERCEPTION_CURSOR_WAIT_TYPES = ["wait", "busybutclickable"];

/** candidates.* 未指定時の既定値。§docs/plans/2026-07-11-c1-word-candidate-grid-design.md */
export const DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC = 6;
export const DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC = 0.3;
export const DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC = 0.5;
export const DEFAULT_CANDIDATES_FILLERS = [
  "えー",
  "えっと",
  "あの",
  "あのー",
  "まあ",
  "その",
  "なんか",
];

/** candidates を既定値で解決する純関数(省略時 enabled=false=バイト等価)。
 *  loadConfig は cfg.candidates を書き換えない */
export function resolveCandidatesCfg(cfg: Config): {
  enabled: boolean;
  splitOnlyLongerThanSec: number;
  minSplitGapSec: number;
  minCandidateSec: number;
  fillers: string[];
} {
  const c = cfg.candidates ?? {};
  return {
    enabled: c.enabled ?? false,
    splitOnlyLongerThanSec: c.splitOnlyLongerThanSec ?? DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC,
    minSplitGapSec: c.minSplitGapSec ?? DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC,
    minCandidateSec: c.minCandidateSec ?? DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC,
    fillers: c.fillers ?? [...DEFAULT_CANDIDATES_FILLERS],
  };
}

/** planMaterials.* 未指定時の既定値。§docs/plans/2026-07-11-m1-material-placement-candidates-design.md */
export const DEFAULT_PLAN_MATERIALS_MIN_SPAN_SEC = 3.0;
export const DEFAULT_PLAN_MATERIALS_MAX_PLACEMENTS = 8;
export const DEFAULT_PLAN_MATERIALS_DEFAULT_VOLUME = 0;
export const DEFAULT_PLAN_MATERIALS_DEFAULT_FIT = "contain" as const;

/** planMaterials を既定値で解決する純関数。loadConfig は cfg.planMaterials を
 *  書き換えない */
export function resolveMaterialPlacementCfg(cfg: Config): {
  minSpanSec: number;
  maxPlacements: number;
  defaultVolume: number;
  defaultFit: "contain" | "cover";
  defaultRect?: { x: number; y: number; w: number; h: number };
} {
  const p = cfg.planMaterials ?? {};
  return {
    minSpanSec: p.minSpanSec ?? DEFAULT_PLAN_MATERIALS_MIN_SPAN_SEC,
    maxPlacements: p.maxPlacements ?? DEFAULT_PLAN_MATERIALS_MAX_PLACEMENTS,
    defaultVolume: p.defaultVolume ?? DEFAULT_PLAN_MATERIALS_DEFAULT_VOLUME,
    defaultFit: p.defaultFit ?? DEFAULT_PLAN_MATERIALS_DEFAULT_FIT,
    ...(p.defaultRect ? { defaultRect: p.defaultRect } : {}),
  };
}

/** materialFit.* 未指定時の既定値。§docs/plans/2026-07-11-m2-m3-material-fit-dangling-design.md */
export const DEFAULT_MATERIAL_FIT_OVERRUN_EPS_SEC = 0.1;
export const DEFAULT_MATERIAL_FIT_UNDERRUN_RATIO = 2.0;
export const DEFAULT_MATERIAL_FIT_SUGGEST_UNDERRUN_EXTEND = false;
export const DEFAULT_MATERIAL_FIT_MAX_REPLACEMENTS = 3;

/** materialFit を既定値で解決する純関数。loadConfig は cfg.materialFit を
 *  書き換えない */
export function resolveMaterialFitCfg(cfg: Config): {
  overrunEpsSec: number;
  underrunRatio: number;
  suggestUnderrunExtend: boolean;
  maxReplacements: number;
} {
  const m = cfg.materialFit ?? {};
  return {
    overrunEpsSec: m.overrunEpsSec ?? DEFAULT_MATERIAL_FIT_OVERRUN_EPS_SEC,
    underrunRatio: m.underrunRatio ?? DEFAULT_MATERIAL_FIT_UNDERRUN_RATIO,
    suggestUnderrunExtend: m.suggestUnderrunExtend ?? DEFAULT_MATERIAL_FIT_SUGGEST_UNDERRUN_EXTEND,
    maxReplacements: m.maxReplacements ?? DEFAULT_MATERIAL_FIT_MAX_REPLACEMENTS,
  };
}

export const DEFAULT_STILLS_DURATION_SEC = 5.0;
export const DEFAULT_STILLS_MAX_SHARE_WARN_RATIO = 0.5;

/** stills.* を既定値で解決する純関数。 */
export function resolveStillsCfg(cfg: Config): {
  defaultDurationSec: number;
  maxShareWarnRatio: number;
} {
  return {
    defaultDurationSec: cfg.stills?.defaultDurationSec ?? DEFAULT_STILLS_DURATION_SEC,
    maxShareWarnRatio: cfg.stills?.maxShareWarnRatio ?? DEFAULT_STILLS_MAX_SHARE_WARN_RATIO,
  };
}

/** planEffects.* 未指定時の既定値。§docs/plans/2026-07-11-e1-e2-effect-anchor-candidates-design.md */
export const DEFAULT_PLAN_EFFECTS_MAX_DECISIONS = 6;
export const DEFAULT_PLAN_EFFECTS_ANCHOR_WINDOW_SEC = 3.0;
export const DEFAULT_PLAN_EFFECTS_MIN_SCENE_SCORE = 0.4;
export const DEFAULT_PLAN_EFFECTS_MIN_OCR_BOX_AREA_PX = 8000;
export const DEFAULT_PLAN_EFFECTS_MIN_ZOOM_RECT = { w: 480, h: 270 };
export const DEFAULT_PLAN_EFFECTS_DEFAULT_BLUR_STRENGTH = 0.5;

/** planEffects を既定値で解決する純関数。loadConfig は cfg.planEffects を
 *  書き換えない */
export function resolveEffectPlacementCfg(cfg: Config): {
  maxDecisions: number;
  anchorWindowSec: number;
  minSceneScore: number;
  minOcrBoxAreaPx: number;
  minZoomRect: { w: number; h: number };
  defaultBlurStrength: number;
} {
  const p = cfg.planEffects ?? {};
  return {
    maxDecisions: p.maxDecisions ?? DEFAULT_PLAN_EFFECTS_MAX_DECISIONS,
    anchorWindowSec: p.anchorWindowSec ?? DEFAULT_PLAN_EFFECTS_ANCHOR_WINDOW_SEC,
    minSceneScore: p.minSceneScore ?? DEFAULT_PLAN_EFFECTS_MIN_SCENE_SCORE,
    minOcrBoxAreaPx: p.minOcrBoxAreaPx ?? DEFAULT_PLAN_EFFECTS_MIN_OCR_BOX_AREA_PX,
    minZoomRect: p.minZoomRect ?? { ...DEFAULT_PLAN_EFFECTS_MIN_ZOOM_RECT },
    defaultBlurStrength: p.defaultBlurStrength ?? DEFAULT_PLAN_EFFECTS_DEFAULT_BLUR_STRENGTH,
  };
}

/** plan.cursor.* 未指定時の既定値(OpenScreen 自身のチューニング値)。
 *  §docs/plans/2026-07-24-openscreen-d2-dwell-suggestion-design.md */
export const DEFAULT_PLAN_CURSOR_MIN_DWELL_MS = 450;
export const DEFAULT_PLAN_CURSOR_MAX_DWELL_MS = 2600;
export const DEFAULT_PLAN_CURSOR_MOVE_THRESHOLD = 0.02;
export const DEFAULT_PLAN_CURSOR_SPACING_MS = 1800;
export const DEFAULT_PLAN_CURSOR_DEFAULT_SCALE = 2.5;
export const DEFAULT_PLAN_CURSOR_CLICK_BOOST = 1.5;
export const DEFAULT_PLAN_CURSOR_MAX_WINDOW_MS = 3500;
/** スクロール誤爆抑制(枝D)の scene score 閾値の既定値。av の scene score
 *  スケールに合わせたゆるめの既定(明白なスクロールだけ落とす)。
 *  §docs/plans/2026-07-24-openscreen-zoom-D-scroll-suppression-design.md */
export const DEFAULT_PLAN_CURSOR_SCROLL_MOTION_THRESHOLD = 0.4;
/** run の末尾で autozoom を自動挿入するかの既定値。
 *  §docs/plans/2026-07-24-openscreen-autozoom-placement-design.md D6 */
export const DEFAULT_PLAN_CURSOR_AUTO_ZOOM = true;

/** plan.cursor を既定値で解決する純関数。loadConfig は cfg.plan.cursor を
 *  書き換えない */
export function resolvePlanCursorCfg(cfg: Config): {
  minDwellMs: number;
  maxDwellMs: number;
  moveThreshold: number;
  spacingMs: number;
  defaultScale: number;
  clickBoost: number;
  maxWindowMs: number;
  scrollMotionThreshold: number;
  autoZoom: boolean;
} {
  const c = cfg.plan?.cursor ?? {};
  return {
    minDwellMs: c.minDwellMs ?? DEFAULT_PLAN_CURSOR_MIN_DWELL_MS,
    maxDwellMs: c.maxDwellMs ?? DEFAULT_PLAN_CURSOR_MAX_DWELL_MS,
    moveThreshold: c.moveThreshold ?? DEFAULT_PLAN_CURSOR_MOVE_THRESHOLD,
    spacingMs: c.spacingMs ?? DEFAULT_PLAN_CURSOR_SPACING_MS,
    defaultScale: c.defaultScale ?? DEFAULT_PLAN_CURSOR_DEFAULT_SCALE,
    clickBoost: c.clickBoost ?? DEFAULT_PLAN_CURSOR_CLICK_BOOST,
    maxWindowMs: c.maxWindowMs ?? DEFAULT_PLAN_CURSOR_MAX_WINDOW_MS,
    scrollMotionThreshold: c.scrollMotionThreshold ?? DEFAULT_PLAN_CURSOR_SCROLL_MOTION_THRESHOLD,
    autoZoom: c.autoZoom ?? DEFAULT_PLAN_CURSOR_AUTO_ZOOM,
  };
}

/** planBgm.* 未指定時の既定値。§docs/plans/2026-07-11-b1-b3-bgm-placement-candidates-design.md */
export const DEFAULT_PLAN_BGM_BIG_CUT_SEC = 3.0;
export const DEFAULT_PLAN_BGM_MIN_SLOT_SEC = 8.0;
export const DEFAULT_PLAN_BGM_MAX_SLOTS = 12;

/** planBgm を既定値で解決する純関数。loadConfig は cfg.planBgm を
 *  書き換えない */
export function resolveBgmSlotCfg(cfg: Config): {
  bigCutSec: number;
  minSlotSec: number;
  maxSlots: number;
} {
  const p = cfg.planBgm ?? {};
  return {
    bigCutSec: p.bigCutSec ?? DEFAULT_PLAN_BGM_BIG_CUT_SEC,
    minSlotSec: p.minSlotSec ?? DEFAULT_PLAN_BGM_MIN_SLOT_SEC,
    maxSlots: p.maxSlots ?? DEFAULT_PLAN_BGM_MAX_SLOTS,
  };
}

/** effectCheck.* 未指定時の既定値。§docs/plans/2026-07-11-e3-e4-e5-effect-visual-verification-design.md */
export const DEFAULT_EFFECT_CHECK_DENSITY_WINDOW_SEC = 5.0;
export const DEFAULT_EFFECT_CHECK_MAX_PER_WINDOW = 3;
export const DEFAULT_EFFECT_CHECK_MAX_ANNOTATION_SEC = 8.0;
export const DEFAULT_EFFECT_CHECK_MIN_RECT_OVERLAP_RATIO = 0.3;
export const DEFAULT_EFFECT_CHECK_USE_VLM = true;

/** record.sampleIntervalMs(config.yaml)未指定時の既定(ms)。
 * §docs/plans/2026-07-24-openscreen-d1-cursor-telemetry-design.md D1 */
export const DEFAULT_RECORD_SAMPLE_INTERVAL_MS = 33;
export const DEFAULT_OBS_WEBSOCKET_HOST = "localhost";
export const DEFAULT_OBS_WEBSOCKET_PORT = 4455;

/** effectCheck を既定値で解決する純関数。loadConfig は cfg.effectCheck を
 *  書き換えない */
export function resolveEffectCheckCfg(cfg: Config): {
  densityWindowSec: number;
  maxPerWindow: number;
  maxAnnotationSec: number;
  minRectOverlapRatio: number;
  useVlm: boolean;
} {
  const e = cfg.effectCheck ?? {};
  return {
    densityWindowSec: e.densityWindowSec ?? DEFAULT_EFFECT_CHECK_DENSITY_WINDOW_SEC,
    maxPerWindow: e.maxPerWindow ?? DEFAULT_EFFECT_CHECK_MAX_PER_WINDOW,
    maxAnnotationSec: e.maxAnnotationSec ?? DEFAULT_EFFECT_CHECK_MAX_ANNOTATION_SEC,
    minRectOverlapRatio: e.minRectOverlapRatio ?? DEFAULT_EFFECT_CHECK_MIN_RECT_OVERLAP_RATIO,
    useVlm: e.useVlm ?? DEFAULT_EFFECT_CHECK_USE_VLM,
  };
}

/** effectReview.observe 未指定時の既定(E7)。false=バイト等価
 *  (§docs/plans/2026-07-11-e6-e7-effect-review-loop-design.md) */
export const DEFAULT_EFFECT_REVIEW_OBSERVE = false;

/** effectReview を既定値で解決する純関数。loadConfig は cfg.effectReview を
 *  書き換えない */
export function resolveEffectReviewCfg(cfg: Config): { observe: boolean } {
  return { observe: cfg.effectReview?.observe ?? DEFAULT_EFFECT_REVIEW_OBSERVE };
}

/** hyperframeCheck.* 未指定時の既定値(src/lib/hyperframeAudit.ts の
 *  DEFAULT_AUDIT_THRESHOLDS と同じ数値を config 未指定時の既定として重ねる) */
export const DEFAULT_HYPERFRAME_CHECK_STEP_SEC = 0.1;
export const DEFAULT_HYPERFRAME_CHECK_TERMINAL_PROGRESS_THRESHOLD = 0.4;
export const DEFAULT_HYPERFRAME_CHECK_OFFSCREEN_OPACITY_GATE = 0.05;
export const DEFAULT_HYPERFRAME_CHECK_DEAD_ZONE_MAX_FRAC = 0.5;
export const DEFAULT_HYPERFRAME_CHECK_ENTRY_MIN_ELEMENTS = 3;
export const DEFAULT_HYPERFRAME_CHECK_ENTRY_EPSILON_FRAMES = 2;
export const DEFAULT_HYPERFRAME_CHECK_USE_VLM = true;
export const DEFAULT_CANVAS = "landscape";

/** hyperframeCheck を既定値で解決する純関数。loadConfig は cfg.hyperframeCheck を
 *  書き換えない */
export function resolveHyperframeAuditCfg(cfg: Config): {
  stepSec: number;
  terminalProgressThreshold: number;
  offscreenOpacityGate: number;
  deadZoneMaxFrac: number;
  entryMinElements: number;
  entryEpsilonFrames: number;
  useVlm: boolean;
} {
  const h = cfg.hyperframeCheck ?? {};
  return {
    stepSec: h.stepSec ?? DEFAULT_HYPERFRAME_CHECK_STEP_SEC,
    terminalProgressThreshold: h.terminalProgressThreshold ?? DEFAULT_HYPERFRAME_CHECK_TERMINAL_PROGRESS_THRESHOLD,
    offscreenOpacityGate: h.offscreenOpacityGate ?? DEFAULT_HYPERFRAME_CHECK_OFFSCREEN_OPACITY_GATE,
    deadZoneMaxFrac: h.deadZoneMaxFrac ?? DEFAULT_HYPERFRAME_CHECK_DEAD_ZONE_MAX_FRAC,
    entryMinElements: h.entryMinElements ?? DEFAULT_HYPERFRAME_CHECK_ENTRY_MIN_ELEMENTS,
    entryEpsilonFrames: h.entryEpsilonFrames ?? DEFAULT_HYPERFRAME_CHECK_ENTRY_EPSILON_FRAMES,
    useVlm: h.useVlm ?? DEFAULT_HYPERFRAME_CHECK_USE_VLM,
  };
}

/** bgmFit.* 未指定時の既定値。§docs/plans/2026-07-11-b2-b4-bgm-audio-aware-design.md */
export const DEFAULT_BGM_FIT_SPEECH_HEADROOM_DB = 8;
export const DEFAULT_BGM_FIT_SILENCE_DUCK_DB = 3;
export const DEFAULT_BGM_FIT_TARGET_LUFS = -14;
export const DEFAULT_BGM_FIT_MIN_FADE_SEC = 1.0;
export const DEFAULT_BGM_FIT_MONOTONE_COVER_RATIO = 0.9;
export const DEFAULT_BGM_FIT_MIN_CHAPTERS_FOR_VARIETY = 3;

/** bgmFit を既定値で解決する純関数。loadConfig は cfg.bgmFit を書き換えない。
 *  defaultVolumeDb は bgmFit.* のユーザー設定ではなく、track.volumeDb 省略時の
 *  実効値を解決するために render.bgm.volumeDb から渡す(BgmFitFinding の
 *  currentVolumeDb 算出用。sound.bgm.spans にトラックが現れない場合の
 *  フォールバックにのみ使う) */
export function resolveBgmFitCfg(cfg: Config): {
  speechHeadroomDb: number;
  silenceDuckDb: number;
  targetLufs: number;
  minFadeSec: number;
  monotoneCoverRatio: number;
  minChaptersForVariety: number;
  defaultVolumeDb: number;
} {
  const b = cfg.bgmFit ?? {};
  return {
    speechHeadroomDb: b.speechHeadroomDb ?? DEFAULT_BGM_FIT_SPEECH_HEADROOM_DB,
    silenceDuckDb: b.silenceDuckDb ?? DEFAULT_BGM_FIT_SILENCE_DUCK_DB,
    targetLufs: b.targetLufs ?? DEFAULT_BGM_FIT_TARGET_LUFS,
    minFadeSec: b.minFadeSec ?? DEFAULT_BGM_FIT_MIN_FADE_SEC,
    monotoneCoverRatio: b.monotoneCoverRatio ?? DEFAULT_BGM_FIT_MONOTONE_COVER_RATIO,
    minChaptersForVariety: b.minChaptersForVariety ?? DEFAULT_BGM_FIT_MIN_CHAPTERS_FOR_VARIETY,
    defaultVolumeDb: cfg.render.bgm.volumeDb,
  };
}

/** plan.loop.maxIterations 未指定時の既定。0 は従来1ショットと同義 */
export const DEFAULT_PLAN_LOOP_MAX_ITERATIONS = 0;
export const DEFAULT_PLAN_LOOP_SECONDARY_MAX_CALLS = 1;
export const DEFAULT_PLAN_LOOP_SECONDARY_MAX_IMAGES = 2;

/** plan.perception を既定値で解決する純関数(省略時は全オフ)。
 *  loadConfig は cfg.plan を書き換えない(省略=オフ=バイト等価を守る) */
export function resolvePerceptionCfg(cfg: Config): {
  audio: boolean;
  ocr: boolean;
  ocrMaxSegments: number;
  ocrMaxLines: number;
  systemSpeech: boolean;
  cursor: boolean;
  cursorOptions: PerceptionCursorOptions;
} {
  const p = cfg.plan?.perception ?? {};
  return {
    audio: p.audio ?? false,
    ocr: p.ocr ?? false,
    ocrMaxSegments: p.ocrMaxSegments ?? DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
    ocrMaxLines: p.ocrMaxLines ?? DEFAULT_PERCEPTION_OCR_MAX_LINES,
    systemSpeech: p.systemSpeech ?? false,
    cursor: p.cursor ?? false,
    cursorOptions: {
      minDwellMs: p.cursorDwell?.minDwellMs ?? DEFAULT_PERCEPTION_CURSOR_MIN_DWELL_MS,
      moveThreshold: p.cursorDwell?.moveThreshold ?? DEFAULT_PERCEPTION_CURSOR_MOVE_THRESHOLD,
      waitTypes: p.cursorWaitTypes ?? DEFAULT_PERCEPTION_CURSOR_WAIT_TYPES,
    },
  };
}

export interface PerceptionStatus {
  explicit: boolean;
  audio: boolean;
  ocr: boolean;
  systemSpeech: boolean;
  cursor: boolean;
  ocrMaxSegments: number;
  ocrMaxLines: number;
  warnings: string[];
}

export function resolvePerceptionStatus(cfg: Config): PerceptionStatus {
  const pc = resolvePerceptionCfg(cfg);
  const explicit = cfg.plan?.perception !== undefined;
  const warnings: string[] = [];
  if (!explicit) {
    warnings.push(
      "plan.perception が config.yaml にありません。plan の知覚(audio/ocr/systemSpeech/cursor)は全てオフです。",
    );
  }
  return {
    explicit,
    audio: pc.audio,
    ocr: pc.ocr,
    systemSpeech: pc.systemSpeech,
    cursor: pc.cursor,
    ocrMaxSegments: pc.ocrMaxSegments,
    ocrMaxLines: pc.ocrMaxLines,
    warnings,
  };
}

export function formatPerceptionStatusLines(status: PerceptionStatus): string[] {
  return [
    ...status.warnings.map((w) => `警告: ${w}`),
    `plan 知覚: audio=${status.audio ? "on" : "off"} / ` +
      `ocr=${
        status.ocr
          ? `on(max ${status.ocrMaxSegments} segments, ${status.ocrMaxLines} lines)`
          : "off"
      } / ` +
      `systemSpeech=${status.systemSpeech ? "on" : "off"} / ` +
      `cursor=${status.cursor ? "on" : "off"}`,
  ];
}

/** plan.loop を既定値で解決する純関数。loadConfig は cfg.plan.loop を生成しない
 * (省略=従来挙動を守るため)ので、利用側は必ずこの関数を通す */
export function resolvePlanLoopCfg(cfg: Config): {
  maxIterations: number;
  targetOutDurationSec: number | null;
  stopWhenAssertionsPass: boolean;
} {
  const l = cfg.plan?.loop ?? {};
  return {
    maxIterations: l.maxIterations ?? DEFAULT_PLAN_LOOP_MAX_ITERATIONS,
    targetOutDurationSec: l.targetOutDurationSec ?? null,
    stopWhenAssertionsPass: l.stopWhenAssertionsPass ?? true,
  };
}

export function resolvePlanLoopSecondaryObservationCfg(cfg: Config): {
  enabled: boolean;
  maxCalls: number;
  maxImages: number;
} {
  const s = cfg.plan?.loop?.secondaryObservation ?? {};
  return {
    enabled: s.enabled ?? false,
    maxCalls: s.maxCalls ?? DEFAULT_PLAN_LOOP_SECONDARY_MAX_CALLS,
    maxImages: s.maxImages ?? DEFAULT_PLAN_LOOP_SECONDARY_MAX_IMAGES,
  };
}

export function planLoopEnabled(cfg: Config): boolean {
  return resolvePlanLoopCfg(cfg).maxIterations >= 2;
}

/** plan.harness.maxToolCalls 未指定時の既定(1生成ターンあたりの tool 呼び出し上限) */
export const DEFAULT_PLAN_HARNESS_MAX_TOOL_CALLS = 16;

/** plan.harness.maxSplits 未指定時の既定(1ターンの候補内部分割上限・H6) */
export const DEFAULT_PLAN_HARNESS_MAX_SPLITS = 4;

/** plan.harness を既定値で解決する純関数(省略時は全オフ+既定値)。
 *  loadConfig は cfg.plan.harness を書き換えない(省略=オフ=バイト等価を守る) */
export function resolvePlanHarnessCfg(cfg: Config): {
  agentic: boolean;
  maxToolCalls: number;
  applySplit: boolean;
  maxSplits: number;
  tools: { frames: boolean; av: boolean; materials: boolean; ocr: boolean };
} {
  const h = cfg.plan?.harness ?? {};
  const t = h.tools ?? {};
  return {
    agentic: h.agentic ?? false,
    maxToolCalls: h.maxToolCalls ?? DEFAULT_PLAN_HARNESS_MAX_TOOL_CALLS,
    applySplit: h.applySplit ?? false,
    maxSplits: h.maxSplits ?? DEFAULT_PLAN_HARNESS_MAX_SPLITS,
    tools: {
      frames: t.frames ?? true,
      av: t.av ?? true,
      materials: t.materials ?? true,
      ocr: t.ocr ?? true,
    },
  };
}

/** plan.harness.agentic かつ、対象(structured route)プロファイルのアダプタが
 * tool-use(completeAgentic)対応のときだけ true。非対応アダプタでは false=
 * 既存の単発/pushループ経路へ自動フォールバックする(§H1H2design §1-4) */
export function planHarnessEnabled(cfg: Config, env?: NodeJS.ProcessEnv): boolean {
  if (!resolvePlanHarnessCfg(cfg).agentic) return false;
  const runtime = resolveAiRuntimeConfig(cfg, env);
  if (runtime.source === "unconfigured") return false;
  const profile = profileForRoute(runtime, "structured");
  const adapter = adapterFor(profile.adapter);
  return typeof adapter.completeAgentic === "function";
}

/** plan.styleProfile.profile 未指定時の既定 profile 名 */
export const DEFAULT_STYLE_PROFILE_NAME = "default";

/** plan.styleProfile を既定値で解決する純関数(省略時 enabled=false=バイト等価)。
 *  loadConfig は cfg.plan.styleProfile を書き換えない(省略=off を守る) */
export function resolveStyleProfileCfg(cfg: Config): { enabled: boolean; profile: string } {
  const s = cfg.plan?.styleProfile ?? {};
  const profile = (s.profile ?? DEFAULT_STYLE_PROFILE_NAME).trim() || DEFAULT_STYLE_PROFILE_NAME;
  return { enabled: s.enabled ?? false, profile };
}

/** plan.reasonIds を既定値で解決する純関数(省略時 enabled=false・pattern="general"=
 *  plan / plan-effects ともバイト等価)。loadConfig は設定を書き換えない。
 *  未知の pattern は warn(既定は no-op)して "general" へ劣化する
 *  (前提エラーで plan を止めない=style-profile 不在時と同じ流儀)。 */
export function resolveReasonIdsCfg(
  cfg: Config,
  warn: (msg: string) => void = () => {},
): { enabled: boolean; pattern: CutPatternId } {
  const raw = cfg.plan?.reasonIds?.pattern;
  let pattern: CutPatternId = "general";
  if (raw !== undefined) {
    if ((CUT_PATTERN_IDS as readonly string[]).includes(raw)) {
      pattern = raw as CutPatternId;
    } else {
      warn(
        `未知の収録タイプです(docs/edit-skills/patterns.md にある id を使ってください): "${raw}"。"general" として扱います`,
      );
    }
  }
  return { enabled: cfg.plan?.reasonIds?.enabled ?? false, pattern };
}

export interface StyleProfileStatus {
  explicit: boolean; // cfg.plan?.styleProfile !== undefined
  enabled: boolean;
  profile: string;
  warnings: string[];
}

export function resolveStyleProfileStatus(cfg: Config): StyleProfileStatus {
  const sc = resolveStyleProfileCfg(cfg);
  const explicit = cfg.plan?.styleProfile !== undefined;
  const warnings: string[] = [];
  if (!explicit) {
    warnings.push("plan.styleProfile が config.yaml にありません。スタイル注入はオフです。");
  }
  return { explicit, ...sc, warnings };
}

export function formatStyleProfileStatusLines(status: StyleProfileStatus): string[] {
  return [
    ...status.warnings.map((w) => `警告: ${w}`),
    `plan スタイル注入: ${status.enabled ? `on(profile=${status.profile})` : "off"}`,
  ];
}

function validateWorkflowConfig(cfg: Config): string[] {
  const errors: string[] = [];
  const hyperframeValue = cfg.hyperframe as unknown;
  if (hyperframeValue !== undefined && (
    hyperframeValue === null || typeof hyperframeValue !== "object" || Array.isArray(hyperframeValue)
  )) {
    errors.push("hyperframe は object で指定してください");
  } else if (hyperframeValue) {
    const hyperframe = hyperframeValue as Record<string, unknown>;
    errors.push(...unknownKeys(hyperframe, ["assets"])
      .map((key) => `hyperframe.${key} は未対応です`));
    const assetsValue = hyperframe.assets;
    if (assetsValue !== undefined && (
      assetsValue === null || typeof assetsValue !== "object" || Array.isArray(assetsValue)
    )) {
      errors.push("hyperframe.assets は object で指定してください");
    } else if (assetsValue) {
      const assets = assetsValue as Record<string, unknown>;
      errors.push(...unknownKeys(assets, ["maxBytes", "maxTotalBytes"])
        .map((key) => `hyperframe.assets.${key} は未対応です`));
      for (const key of ["maxBytes", "maxTotalBytes"] as const) {
        if (key in assets && (!Number.isInteger(assets[key]) || Number(assets[key]) <= 0)) {
          errors.push(`hyperframe.assets.${key} は正の整数で指定してください`);
        }
      }
      const maxBytes = Number.isInteger(assets.maxBytes)
        ? Number(assets.maxBytes)
        : DEFAULT_HYPERFRAME_ASSET_MAX_BYTES;
      const maxTotalBytes = Number.isInteger(assets.maxTotalBytes)
        ? Number(assets.maxTotalBytes)
        : DEFAULT_HYPERFRAME_ASSET_MAX_TOTAL_BYTES;
      if (maxBytes > 0 && maxTotalBytes > 0 && maxTotalBytes < maxBytes) {
        errors.push("hyperframe.assets.maxTotalBytes は maxBytes 以上にしてください");
      }
    }
  }
  const detectCalibration = cfg.detect?.calibration as Record<string, unknown> | undefined;
  if (detectCalibration) {
    errors.push(...unknownKeys(detectCalibration, ["enabled", "method", "floorOffsetDb"])
      .map((key) => `detect.calibration.${key} は未対応です`));
    if (typeof detectCalibration.enabled !== "boolean") {
      errors.push("detect.calibration.enabled は boolean で指定してください");
    }
    if (detectCalibration.method !== "silencedetect-occupancy-v1") {
      errors.push('detect.calibration.method は "silencedetect-occupancy-v1" で指定してください');
    }
    if (typeof detectCalibration.floorOffsetDb !== "number" || !Number.isFinite(detectCalibration.floorOffsetDb)) {
      errors.push("detect.calibration.floorOffsetDb は有限の数値で指定してください");
    } else if (!Number.isInteger(detectCalibration.floorOffsetDb * 2)) {
      errors.push("detect.calibration.floorOffsetDb は0.5dB gridで指定してください");
    }
  }
  const silenceCompaction = cfg.detect?.silenceCompaction as Record<string, unknown> | undefined;
  if (silenceCompaction) {
    errors.push(...unknownKeys(silenceCompaction, ["enabled", "preset"])
      .map((key) => `detect.silenceCompaction.${key} は未対応です`));
    if (typeof silenceCompaction.enabled !== "boolean") {
      errors.push("detect.silenceCompaction.enabled は boolean で指定してください");
    }
    if (![
      'gentle', 'balanced', 'tight',
      'compact-gentle', 'compact-balanced', 'compact-tight',
    ].includes(silenceCompaction.preset as string)) {
      errors.push(
        'detect.silenceCompaction.preset は "gentle" | "balanced" | "tight" | ' +
        '"compact-gentle" | "compact-balanced" | "compact-tight" で指定してください',
      );
    }
  }
  const edgeTrim = cfg.detect?.edgeTrim as Record<string, unknown> | undefined;
  if (edgeTrim) {
    errors.push(...unknownKeys(edgeTrim, ["enabled", "floorOffsetDb", "padSec", "maxTrimSec"])
      .map((key) => `detect.edgeTrim.${key} は未対応です`));
    if (typeof edgeTrim.enabled !== "boolean") {
      errors.push("detect.edgeTrim.enabled は boolean で指定してください");
    }
    if ("floorOffsetDb" in edgeTrim && !Number.isFinite(edgeTrim.floorOffsetDb)) {
      errors.push("detect.edgeTrim.floorOffsetDb は有限の数値で指定してください");
    }
    if ("padSec" in edgeTrim && (!Number.isFinite(edgeTrim.padSec) || Number(edgeTrim.padSec) < 0)) {
      errors.push("detect.edgeTrim.padSec は 0 以上の数値で指定してください");
    }
    if ("maxTrimSec" in edgeTrim && (!Number.isFinite(edgeTrim.maxTrimSec) || Number(edgeTrim.maxTrimSec) <= 0)) {
      errors.push("detect.edgeTrim.maxTrimSec は正の数値で指定してください");
    }
  }
  const editorAiReview = cfg.editor?.aiReview as Record<string, unknown> | undefined;
  if (editorAiReview) {
    errors.push(...unknownKeys(editorAiReview, ["vlm", "maxImages", "maxRefinements"]).map((key) => `editor.aiReview.${key} は未対応です`));
    if ("vlm" in editorAiReview && typeof editorAiReview.vlm !== "boolean") {
      errors.push("editor.aiReview.vlm は boolean で指定してください");
    }
    if ("maxImages" in editorAiReview) {
      const value = editorAiReview.maxImages;
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 4) {
        errors.push("editor.aiReview.maxImages は 1..4 の整数で指定してください");
      }
    }
    if ("maxRefinements" in editorAiReview) {
      const value = editorAiReview.maxRefinements;
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3) {
        errors.push("editor.aiReview.maxRefinements は 1..3 の整数で指定してください");
      }
    }
  }
  const planLoop = cfg.plan?.loop as Record<string, unknown> | undefined;
  if (planLoop) {
    errors.push(...unknownKeys(planLoop, ["maxIterations", "targetOutDurationSec", "stopWhenAssertionsPass", "secondaryObservation"]).map((key) => `plan.loop.${key} は未対応です`));
    const secondary = planLoop.secondaryObservation as Record<string, unknown> | undefined;
    if (secondary) {
      errors.push(...unknownKeys(secondary, ["enabled", "maxCalls", "maxImages"]).map((key) => `plan.loop.secondaryObservation.${key} は未対応です`));
      if ("enabled" in secondary && typeof secondary.enabled !== "boolean") {
        errors.push("plan.loop.secondaryObservation.enabled は boolean で指定してください");
      }
      if ("maxCalls" in secondary) {
        const value = secondary.maxCalls;
        if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2) {
          errors.push("plan.loop.secondaryObservation.maxCalls は 0..2 の整数で指定してください");
        }
      }
      if ("maxImages" in secondary) {
        const value = secondary.maxImages;
        if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2) {
          errors.push("plan.loop.secondaryObservation.maxImages は 1..2 の整数で指定してください");
        }
      }
    }
  }
  const planHarness = cfg.plan?.harness as Record<string, unknown> | undefined;
  if (planHarness) {
    errors.push(...unknownKeys(planHarness, ["agentic", "maxToolCalls", "applySplit", "maxSplits", "tools"]).map((key) => `plan.harness.${key} は未対応です`));
    if ("agentic" in planHarness && typeof planHarness.agentic !== "boolean") {
      errors.push("plan.harness.agentic は boolean で指定してください");
    }
    if ("maxToolCalls" in planHarness) {
      const value = planHarness.maxToolCalls;
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 64) {
        errors.push("plan.harness.maxToolCalls は 1..64 の整数で指定してください");
      }
    }
    if ("applySplit" in planHarness && typeof planHarness.applySplit !== "boolean") {
      errors.push("plan.harness.applySplit は boolean で指定してください");
    }
    if ("maxSplits" in planHarness) {
      const value = planHarness.maxSplits;
      if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 16) {
        errors.push("plan.harness.maxSplits は 1..16 の整数で指定してください");
      }
    }
    const tools = planHarness.tools as Record<string, unknown> | undefined;
    if (tools) {
      errors.push(...unknownKeys(tools, ["frames", "av", "materials", "ocr"]).map((key) => `plan.harness.tools.${key} は未対応です`));
      for (const key of ["frames", "av", "materials", "ocr"]) {
        if (key in tools && typeof tools[key] !== "boolean") {
          errors.push(`plan.harness.tools.${key} は boolean で指定してください`);
        }
      }
    }
  }
  const planStyleProfile = cfg.plan?.styleProfile as Record<string, unknown> | undefined;
  if (planStyleProfile) {
    errors.push(...unknownKeys(planStyleProfile, ["enabled", "profile"]).map((key) => `plan.styleProfile.${key} は未対応です`));
    if ("enabled" in planStyleProfile && typeof planStyleProfile.enabled !== "boolean") {
      errors.push("plan.styleProfile.enabled は boolean で指定してください");
    }
    if ("profile" in planStyleProfile && typeof planStyleProfile.profile !== "string") {
      errors.push("plan.styleProfile.profile は文字列で指定してください");
    }
  }
  const planReasonIds = cfg.plan?.reasonIds as Record<string, unknown> | undefined;
  if (planReasonIds) {
    errors.push(
      ...unknownKeys(planReasonIds, ["enabled", "pattern"]).map((key) => `plan.reasonIds.${key} は未対応です`),
    );
    if ("enabled" in planReasonIds && typeof planReasonIds.enabled !== "boolean") {
      errors.push("plan.reasonIds.enabled は boolean で指定してください");
    }
    // pattern の値そのもの(未知の収録タイプ)はここではエラーにしない。
    // resolveReasonIdsCfg が warn して "general" へ劣化する(前提エラーで
    // plan を止めない設計。§docs/plans/2026-07-20-cut-knowledge-p3-p5-design.md §2)
    if ("pattern" in planReasonIds && typeof planReasonIds.pattern !== "string") {
      errors.push("plan.reasonIds.pattern は文字列で指定してください");
    }
  }
  const planCursor = cfg.plan?.cursor as Record<string, unknown> | undefined;
  if (planCursor) {
    errors.push(
      ...unknownKeys(planCursor, [
        "minDwellMs", "maxDwellMs", "moveThreshold", "spacingMs", "defaultScale", "clickBoost", "maxWindowMs",
        "scrollMotionThreshold", "autoZoom",
      ]).map((key) => `plan.cursor.${key} は未対応です`),
    );
    if ("minDwellMs" in planCursor && (!Number.isFinite(planCursor.minDwellMs) || Number(planCursor.minDwellMs) <= 0)) {
      errors.push("plan.cursor.minDwellMs は正の数値で指定してください");
    }
    if ("maxDwellMs" in planCursor && (!Number.isFinite(planCursor.maxDwellMs) || Number(planCursor.maxDwellMs) <= 0)) {
      errors.push("plan.cursor.maxDwellMs は正の数値で指定してください");
    }
    if (
      typeof planCursor.minDwellMs === "number" &&
      typeof planCursor.maxDwellMs === "number" &&
      planCursor.minDwellMs >= planCursor.maxDwellMs
    ) {
      errors.push("plan.cursor.minDwellMs は maxDwellMs 未満で指定してください");
    }
    if ("moveThreshold" in planCursor && (!Number.isFinite(planCursor.moveThreshold) || Number(planCursor.moveThreshold) <= 0)) {
      errors.push("plan.cursor.moveThreshold は正の数値で指定してください");
    }
    if ("spacingMs" in planCursor && (!Number.isFinite(planCursor.spacingMs) || Number(planCursor.spacingMs) < 0)) {
      errors.push("plan.cursor.spacingMs は 0 以上の数値で指定してください");
    }
    if ("defaultScale" in planCursor && (!Number.isFinite(planCursor.defaultScale) || Number(planCursor.defaultScale) <= 0)) {
      errors.push("plan.cursor.defaultScale は正の数値で指定してください");
    }
    if ("clickBoost" in planCursor && (!Number.isFinite(planCursor.clickBoost) || Number(planCursor.clickBoost) <= 0)) {
      errors.push("plan.cursor.clickBoost は正の数値で指定してください");
    }
    if ("maxWindowMs" in planCursor && (!Number.isFinite(planCursor.maxWindowMs) || Number(planCursor.maxWindowMs) <= 0)) {
      errors.push("plan.cursor.maxWindowMs は正の数値で指定してください");
    }
    if (
      "scrollMotionThreshold" in planCursor &&
      (!Number.isFinite(planCursor.scrollMotionThreshold) || Number(planCursor.scrollMotionThreshold) <= 0)
    ) {
      errors.push("plan.cursor.scrollMotionThreshold は正の数値で指定してください");
    }
    if ("autoZoom" in planCursor && typeof planCursor.autoZoom !== "boolean") {
      errors.push("plan.cursor.autoZoom は真偽値で指定してください");
    }
  }
  const renderZoom = cfg.render?.zoom as Record<string, unknown> | undefined;
  if (renderZoom && "webcamReactiveMinScale" in renderZoom) {
    const value = renderZoom.webcamReactiveMinScale;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
      errors.push("render.zoom.webcamReactiveMinScale は 0 より大きく 1 以下の数値です");
    }
  }
  const log = cfg.log as Record<string, unknown> | undefined;
  if (log) {
    errors.push(...unknownKeys(log, ["level"]).map((key) => `log.${key} は未対応です`));
    if ("level" in log && !["quiet", "normal", "verbose"].includes(log.level as string)) {
      errors.push('log.level は "quiet" | "normal" | "verbose" で指定してください');
    }
  }
  if (cfg.recordingsDirs !== undefined) {
    if (typeof cfg.recordingsDir === "string") {
      errors.push("recordingsDir と recordingsDirs は併記できません");
    }
    if (cfg.recordingsDirs === null || typeof cfg.recordingsDirs !== "object" || Array.isArray(cfg.recordingsDirs)) {
      errors.push("recordingsDirs は object で指定してください");
    } else {
      const entries = Object.entries(cfg.recordingsDirs as Record<string, unknown>);
      if (entries.length === 0) errors.push("recordingsDirs は最低1件必要です");
      if (entries.length > 16) errors.push("recordingsDirs は最大16件です(用途を分けてください)");
      for (const [key, value] of entries) {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(key)) {
          errors.push(`recordingsDirs のキー "${key}" が不正です(英小文字始まり、英数字と "-" のみ、32文字以内)`);
        }
        if (typeof value !== "string" || value.trim().length === 0) {
          errors.push(`recordingsDirs.${key} は空でない string(パス)で指定してください`);
        }
      }
    }
  } else if (typeof cfg.recordingsDir !== "string" || cfg.recordingsDir.trim().length === 0) {
    errors.push("recordingsDir が必要です(または recordingsDirs)");
  }
  return errors;
}

/** describe.pauseMax 未指定時の既定(1keepあたりの件数) */
export const DEFAULT_DESCRIBE_PAUSE_MAX = 3;

/** describe.pauseMinSec 未指定時の既定(秒) */
export const DEFAULT_DESCRIBE_PAUSE_MIN_SEC = 0.6;

export const DEFAULT_AV_EVERY_SEC = 5;
export const DEFAULT_AV_COLS = 5;
export const DEFAULT_AV_WINDOW_SEC = 1;
export const DEFAULT_AV_SCDET_THRESHOLD = 8;
export const DEFAULT_AV_FREEZE_NOISE_DB = -50;
export const DEFAULT_AV_FREEZE_DURATION_SEC = 1;
export const DEFAULT_AV_STRIP_WIDTH_PX = 320;
export const DEFAULT_THUMBSTRIP_INTERVAL_SEC = 10;
export const DEFAULT_THUMBSTRIP_TILE_WIDTH_PX = 160;
export const DEFAULT_THUMBSTRIP_COLUMNS = 10;
export const DEFAULT_THUMBSTRIP_ROWS = 10;

/** describe.pauses を既定値で解決する純関数(省略時は全オフ+既定値)。
 *  loadConfig は cfg.describe を書き換えない(省略=オフ=バイト等価を守る) */
export function resolveDescribePausesCfg(cfg: Config): {
  enabled: boolean;
  max: number;
  minSec: number;
} {
  const d = cfg.describe ?? {};
  return {
    enabled: d.pauses ?? false,
    max: d.pauseMax ?? DEFAULT_DESCRIBE_PAUSE_MAX,
    minSec: d.pauseMinSec ?? DEFAULT_DESCRIBE_PAUSE_MIN_SEC,
  };
}

export function resolveAvCfg(cfg: Config): {
  everySec: number;
  cols: number;
  windowSec: number;
  scdetThreshold: number;
  freeze: { noiseDb: number; durationSec: number };
  stripWidthPx: number;
} {
  const av = cfg.av ?? {};
  return {
    everySec: av.everySec ?? DEFAULT_AV_EVERY_SEC,
    cols: av.cols ?? DEFAULT_AV_COLS,
    windowSec: av.windowSec ?? DEFAULT_AV_WINDOW_SEC,
    scdetThreshold: av.scdetThreshold ?? DEFAULT_AV_SCDET_THRESHOLD,
    freeze: {
      noiseDb: av.freeze?.noiseDb ?? DEFAULT_AV_FREEZE_NOISE_DB,
      durationSec: av.freeze?.durationSec ?? DEFAULT_AV_FREEZE_DURATION_SEC,
    },
    stripWidthPx: av.stripWidthPx ?? DEFAULT_AV_STRIP_WIDTH_PX,
  };
}

/** screen.* 未指定時の既定値。video-perception-P1 §2.6 */
export const DEFAULT_SCREEN_MAX_SAMPLES = 120;
export const DEFAULT_SCREEN_MIN_GAP_SEC = 6.0;
export const DEFAULT_SCREEN_FROZEN_SHOT_EVERY_SEC = 60;
export const DEFAULT_SCREEN_FROZEN_MAX_SHOTS_PER_SPAN = 3;
export const DEFAULT_SCREEN_MERGE_THRESHOLD = 0.6;
export const DEFAULT_SCREEN_SCENE_THRESHOLD = 0.25;
export const DEFAULT_SCREEN_MIN_SEGMENT_SEC = 10.0;
export const DEFAULT_SCREEN_INDEX_LINES = 8;
/** video-perception-P4 §2.7。`--summarize` を使わない限り読まれない */
export const DEFAULT_SCREEN_SUMMARIZE_MAX_SEGMENTS = 40;
export const DEFAULT_SCREEN_SUMMARIZE_MAX_OUTPUT_TOKENS = 64;

/** screen を既定値で解決する純関数。loadConfig は cfg.screen を書き換えない
 * (省略時は上の DEFAULT_SCREEN_* がそのまま使われる) */
export function resolveScreenCfg(cfg: Config): {
  maxSamples: number;
  minGapSec: number;
  frozenShotEverySec: number;
  frozenMaxShotsPerSpan: number;
  mergeThreshold: number;
  sceneThreshold: number;
  minSegmentSec: number;
  indexLines: number;
  summarize: { maxSegments: number; maxOutputTokens: number };
} {
  const s = cfg.screen ?? {};
  const summarize = s.summarize ?? {};
  return {
    maxSamples: s.maxSamples ?? DEFAULT_SCREEN_MAX_SAMPLES,
    minGapSec: s.minGapSec ?? DEFAULT_SCREEN_MIN_GAP_SEC,
    frozenShotEverySec: s.frozenShotEverySec ?? DEFAULT_SCREEN_FROZEN_SHOT_EVERY_SEC,
    frozenMaxShotsPerSpan: s.frozenMaxShotsPerSpan ?? DEFAULT_SCREEN_FROZEN_MAX_SHOTS_PER_SPAN,
    mergeThreshold: s.mergeThreshold ?? DEFAULT_SCREEN_MERGE_THRESHOLD,
    sceneThreshold: s.sceneThreshold ?? DEFAULT_SCREEN_SCENE_THRESHOLD,
    minSegmentSec: s.minSegmentSec ?? DEFAULT_SCREEN_MIN_SEGMENT_SEC,
    indexLines: s.indexLines ?? DEFAULT_SCREEN_INDEX_LINES,
    summarize: {
      maxSegments: summarize.maxSegments ?? DEFAULT_SCREEN_SUMMARIZE_MAX_SEGMENTS,
      maxOutputTokens: summarize.maxOutputTokens ?? DEFAULT_SCREEN_SUMMARIZE_MAX_OUTPUT_TOKENS,
    },
  };
}

export function resolveThumbstripCfg(cfg: Config): {
  intervalSec: number;
  tileWidthPx: number;
  columns: number;
  rows: number;
} {
  const thumbstrip = cfg.editor?.thumbstrip ?? {};
  return {
    intervalSec: positiveNumber(thumbstrip.intervalSec, DEFAULT_THUMBSTRIP_INTERVAL_SEC),
    tileWidthPx: positiveInteger(thumbstrip.tileWidthPx, DEFAULT_THUMBSTRIP_TILE_WIDTH_PX),
    columns: positiveInteger(thumbstrip.columns, DEFAULT_THUMBSTRIP_COLUMNS),
    rows: positiveInteger(thumbstrip.rows, DEFAULT_THUMBSTRIP_ROWS),
  };
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** log.level 未指定時の既定(既存挙動=AI 行+ステージ行が出る) */
export const DEFAULT_LOG_LEVEL: LogLevel = "normal";

/** log.level を既定値で解決する純関数。不正値は既定へフォールバック。
 *  loadConfig は cfg.log を書き換えない */
export function resolveLogCfg(cfg: Config): { level: LogLevel } {
  const l = cfg.log?.level;
  return { level: l === "quiet" || l === "normal" || l === "verbose" ? l : DEFAULT_LOG_LEVEL };
}

function isLegacyAiConfig(value: AiConfig | undefined): value is LegacyAiConfig {
  return !!value && "provider" in value;
}

function defaultAuthForAdapter(adapter: AiAdapterKind): AiAuthConfig {
  if (adapter === "openai") return { type: "bearer", apiKeyEnv: "OPENAI_API_KEY" };
  if (adapter === "anthropic") return { type: "x-api-key", apiKeyEnv: "ANTHROPIC_API_KEY" };
  return { type: "none" };
}

function defaultProtocolForAdapter(adapter: AiAdapterKind, protocol?: string): ResolvedAiProfile["protocol"] {
  if (adapter === "claude-code" || adapter === "codex") return "cli";
  if (adapter === "anthropic") return "messages";
  if (adapter === "openai") return "responses";
  if (protocol === "responses") return "responses";
  return "chat-completions";
}

function defaultCapabilitiesForAdapter(adapter: AiAdapterKind): AiCapabilities {
  if (adapter === "claude-code") {
    return { textInput: true, textOutput: true, structuredOutput: "native-json-schema", imageInput: false, maxImages: 0 };
  }
  if (adapter === "codex") {
    return { textInput: true, textOutput: true, structuredOutput: "prompt", imageInput: false, maxImages: 0 };
  }
  if (adapter === "openai") {
    return {
      textInput: true,
      textOutput: true,
      structuredOutput: "native-json-schema",
      imageInput: true,
      maxImages: MAX_AI_IMAGES,
    };
  }
  if (adapter === "anthropic") {
    return {
      textInput: true,
      textOutput: true,
      structuredOutput: "native-json-schema",
      imageInput: true,
      maxImages: MAX_AI_IMAGES,
    };
  }
  return {
    textInput: true,
    textOutput: true,
    structuredOutput: "none",
    imageInput: false,
    maxImages: 0,
  };
}

function validateAiProfileName(name: string): void {
  if (name === LEGACY_AI_PROFILE) throw new Error(`AI profile名 "${LEGACY_AI_PROFILE}" は予約済みです`);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error(`AI profile名 "${name}" は不正です`);
  }
}

function requireRouteProfile(
  profiles: ReadonlyMap<string, ResolvedAiProfile>,
  route: string,
  profileName: string,
): string {
  if (!profiles.has(profileName)) {
    throw new Error(`AI route "${route}" は未知のprofile "${profileName}" を参照しています`);
  }
  return profileName;
}

function resolveProfile(
  name: string,
  profile: AiProfileConfig,
  defaults?: RoutedAiConfig["defaults"],
): ResolvedAiProfile {
  const baseCaps = defaultCapabilitiesForAdapter(profile.adapter);
  const structuredOutput = profile.capabilities?.structuredOutput ?? baseCaps.structuredOutput;
  const imageInput = profile.capabilities?.imageInput ?? baseCaps.imageInput;
  const maxImages = imageInput ? Math.max(1, Math.min(profile.capabilities?.maxImages ?? baseCaps.maxImages, MAX_AI_IMAGES)) : 0;
  if (profile.adapter === "openai-compatible") {
    if (!profile.baseUrl) throw new Error(`AI profile "${name}" は baseUrl が必要です`);
    if (!profile.protocol) throw new Error(`AI profile "${name}" は protocol が必要です`);
    if (profile.capabilities?.structuredOutput === undefined) {
      throw new Error(`AI profile "${name}" は capabilities.structuredOutput が必要です`);
    }
    if (profile.capabilities?.imageInput === undefined) {
      throw new Error(`AI profile "${name}" は capabilities.imageInput が必要です`);
    }
  }
  return {
    name,
    adapter: profile.adapter,
    model: profile.model ?? "auto",
    protocol: defaultProtocolForAdapter(profile.adapter, profile.protocol),
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl.replace(/\/+$/, "") } : {}),
    auth: profile.auth ?? defaultAuthForAdapter(profile.adapter),
    capabilities: {
      textInput: true,
      textOutput: true,
      structuredOutput,
      imageInput,
      maxImages,
    },
    timeoutMs: Math.max(1_000, Math.min(profile.timeoutMs ?? defaults?.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS, 300_000)),
    maxRetries: Math.max(0, Math.min(profile.maxRetries ?? defaults?.maxRetries ?? DEFAULT_AI_MAX_RETRIES, 2)),
    maxOutputTokens: Math.max(64, Math.min(profile.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS, 131_072)),
    maxResponseBytes: Math.max(1024, Math.min(profile.maxResponseBytes ?? defaults?.maxResponseBytes ?? DEFAULT_AI_MAX_RESPONSE_BYTES, 8 * 1024 * 1024)),
  };
}

function legacyRuntime(provider: AiProvider, model: string, source: ResolvedAiConfig["source"]): ResolvedAiConfig {
  const profile: ResolvedAiProfile = {
    name: LEGACY_AI_PROFILE,
    adapter: provider,
    model,
    protocol: defaultProtocolForAdapter(provider),
    auth: defaultAuthForAdapter(provider),
    capabilities: defaultCapabilitiesForAdapter(provider),
    timeoutMs: DEFAULT_AI_TIMEOUT_MS,
    maxRetries: DEFAULT_AI_MAX_RETRIES,
    maxOutputTokens: DEFAULT_AI_MAX_OUTPUT_TOKENS,
    maxResponseBytes: DEFAULT_AI_MAX_RESPONSE_BYTES,
  };
  return {
    profiles: new Map([[LEGACY_AI_PROFILE, profile]]),
    routes: {
      text: LEGACY_AI_PROFILE,
      structured: LEGACY_AI_PROFILE,
      ...(provider === "openai" || provider === "anthropic" ? { vision: LEGACY_AI_PROFILE } : {}),
    },
    source,
  };
}

/** ai / llm を一切書かないときの既定候補。CLI(claude-code / codex)ではなく
 *  API を既定にし、どの API を使うかは env にある鍵で決める(先頭から順に見る)。
 *  API アダプタは model の明示を要求する(requireExplicitModel)ので、
 *  既定モデルもここで持つ。CLI を使いたい場合は config.yaml で
 *  adapter: claude-code / codex を明示する */
export const DEFAULT_AI_CANDIDATES: readonly { adapter: AiProvider; apiKeyEnv: string; model: string }[] = [
  { adapter: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-sonnet-5" },
  { adapter: "openai", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5.4-mini" },
];

export const AI_UNCONFIGURED_MESSAGE =
  "AI の接続先が未設定です。config.yaml の ai を設定するか、"
  + `${DEFAULT_AI_CANDIDATES.map((c) => c.apiKeyEnv).join(" / ")} のいずれかを .env に入れてください`
  + "(Claude Code / Codex CLI を使う場合は ai.profiles で adapter: claude-code / codex を明示してください)";

function defaultRuntime(env: NodeJS.ProcessEnv): ResolvedAiConfig {
  const found = DEFAULT_AI_CANDIDATES.find((candidate) => (env[candidate.apiKeyEnv] ?? "").trim() !== "");
  if (found) return legacyRuntime(found.adapter, found.model, "default");
  // 鍵が1つも無くても throw しない: 収録フォルダを開くだけ・決定論チェックだけ
  // の経路(editor の project load / effect-check の非 VLM 部分)を壊さないため。
  // 形だけ先頭候補で埋め、実際の AI 呼び出しは client.ts が止める
  return { ...legacyRuntime(DEFAULT_AI_CANDIDATES[0]!.adapter, DEFAULT_AI_CANDIDATES[0]!.model, "default"), source: "unconfigured" };
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export function validateAiConfig(value: unknown): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["ai は object である必要があります"];
  const ai = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("provider" in ai && "profiles" in ai) errors.push("ai.provider と ai.profiles は併記できません");
  const topUnknown = unknownKeys(ai, ["provider", "model", "profiles", "routes", "defaults"]);
  errors.push(...topUnknown.map((key) => `ai.${key} は未対応です`));
  for (const key of ["apiKey", "token", "authorization", "headers"]) {
    if (key in ai) errors.push(`ai.${key} は使えません`);
  }
  if ("provider" in ai) {
    if (!["claude-code", "codex", "anthropic", "openai"].includes(String(ai.provider))) {
      errors.push(`ai.provider が不正です: ${String(ai.provider)}`);
    }
    return errors;
  }
  if ("profiles" in ai) {
    const profiles = ai.profiles;
    const routes = ai.routes;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) errors.push("ai.profiles は object である必要があります");
    if (!routes || typeof routes !== "object" || Array.isArray(routes)) errors.push("ai.routes は object である必要があります");
    if (errors.length > 0) return errors;
    const profileEntries = Object.entries(profiles as Record<string, unknown>);
    if (profileEntries.length > 16) errors.push("AI profile は最大16件です");
    for (const [name, rawProfile] of profileEntries) {
      if (name === LEGACY_AI_PROFILE || !/^[a-z][a-z0-9-]{0,31}$/.test(name)) errors.push(`AI profile名 "${name}" は不正です`);
      if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
        errors.push(`AI profile "${name}" は object である必要があります`);
        continue;
      }
      const profile = rawProfile as Record<string, unknown>;
      errors.push(...unknownKeys(profile, [
        "adapter", "model", "protocol", "baseUrl", "auth", "capabilities",
        "timeoutMs", "maxRetries", "maxOutputTokens", "maxResponseBytes",
      ]).map((key) => `ai.profiles.${name}.${key} は未対応です`));
      for (const key of ["apiKey", "token", "authorization", "headers"]) {
        if (key in profile) errors.push(`ai.profiles.${name}.${key} は使えません`);
      }
      const adapter = String(profile.adapter ?? "");
      if (!["claude-code", "codex", "anthropic", "openai", "openai-compatible"].includes(adapter)) {
        errors.push(`AI profile "${name}" の adapter が不正です`);
      }
      if (adapter === "openai-compatible") {
        if (typeof profile.baseUrl !== "string" || profile.baseUrl.length === 0) errors.push(`AI profile "${name}" は baseUrl が必要です`);
        else {
          try {
            normalizeBaseUrl(profile.baseUrl);
          } catch (error) {
            errors.push(`AI profile "${name}" の baseUrl が不正です: ${(error as Error).message}`);
          }
        }
        if (profile.protocol !== "chat-completions" && profile.protocol !== "responses") {
          errors.push(`AI profile "${name}" は protocol が必要です`);
        }
        if (!profile.model) errors.push(`AI profile "${name}" は model が必要です`);
        if (!(profile.capabilities && typeof profile.capabilities === "object")) {
          errors.push(`AI profile "${name}" は capabilities が必要です`);
        } else {
          const caps = profile.capabilities as Record<string, unknown>;
          if (!["native-json-schema", "json-object", "prompt", "none"].includes(String(caps.structuredOutput ?? ""))) {
            errors.push(`AI profile "${name}" は capabilities.structuredOutput が必要です`);
          }
          if (typeof caps.imageInput !== "boolean") errors.push(`AI profile "${name}" は capabilities.imageInput が必要です`);
        }
      }
      if ((adapter === "openai" || adapter === "anthropic") && "baseUrl" in profile) {
        errors.push(`AI profile "${name}" では baseUrl を指定できません`);
      }
      if ((adapter === "claude-code" || adapter === "codex") && ("baseUrl" in profile || "auth" in profile)) {
        errors.push(`AI profile "${name}" の CLI adapter では baseUrl/auth を指定できません`);
      }
      if (profile.auth !== undefined) {
        if (!profile.auth || typeof profile.auth !== "object" || Array.isArray(profile.auth)) {
          errors.push(`AI profile "${name}" の auth は object である必要があります`);
        } else {
          const auth = profile.auth as Record<string, unknown>;
          errors.push(...unknownKeys(auth, ["type", "apiKeyEnv"]).map((key) => `ai.profiles.${name}.auth.${key} は未対応です`));
          if (!["none", "bearer", "x-api-key"].includes(String(auth.type ?? ""))) errors.push(`AI profile "${name}" の auth.type が不正です`);
          if (auth.type === "none" && "apiKeyEnv" in auth) errors.push(`AI profile "${name}" の auth.type=none に apiKeyEnv は指定できません`);
          if ((auth.type === "bearer" || auth.type === "x-api-key") && typeof auth.apiKeyEnv !== "string") {
            errors.push(`AI profile "${name}" の auth.apiKeyEnv が必要です`);
          }
        }
      }
      if (profile.capabilities !== undefined) {
        if (!profile.capabilities || typeof profile.capabilities !== "object" || Array.isArray(profile.capabilities)) {
          errors.push(`AI profile "${name}" の capabilities は object である必要があります`);
        } else {
          const caps = profile.capabilities as Record<string, unknown>;
          errors.push(...unknownKeys(caps, ["structuredOutput", "imageInput", "maxImages"]).map((key) => `ai.profiles.${name}.capabilities.${key} は未対応です`));
          if (caps.maxImages !== undefined && ![1, 2, 3, 4].includes(Number(caps.maxImages))) {
            errors.push(`AI profile "${name}" の capabilities.maxImages が不正です`);
          }
        }
      }
    }
    const routeObj = routes as Record<string, unknown>;
    const routeUnknown = unknownKeys(routeObj, ["text", "structured", "vision"]);
    errors.push(...routeUnknown.map((key) => `ai.routes.${key} は未対応です`));
    if (typeof routeObj.text !== "string") errors.push("ai.routes.text が必要です");
    if (typeof routeObj.structured !== "string") errors.push("ai.routes.structured が必要です");
    for (const route of ["text", "structured", "vision"] as const) {
      const value = routeObj[route];
      if (value !== undefined && typeof value === "string" && !(profiles as Record<string, unknown>)[value]) {
        errors.push(`AI route "${route}" は未知のprofile "${value}" を参照しています`);
      }
    }
  }
  return errors;
}

export function aiProfileStatuses(cfg: Config): AiProfileStatus[] {
  loadRepoEnv();
  const runtime = resolveAiRuntimeConfig(cfg);
  return [...runtime.profiles.values()].map((profile) => ({
    name: profile.name,
    adapter: profile.adapter,
    model: profile.model,
    origin: originOfProfile(profile),
    credential:
      profile.auth.type === "none"
        ? "not-required"
        : resolveCredential(profile.auth, process.env)
          ? "present"
          : "missing",
    capabilities: profile.capabilities,
  }));
}

/** `env` を渡すと既定解決(ai/llm 未設定時)の鍵探索をその環境で行う。
 *  省略時はリポジトリ直下の .env を読み込んだうえで process.env を見る */
export function resolveAiRuntimeConfig(cfg: Config, env?: NodeJS.ProcessEnv): ResolvedAiConfig {
  if (cfg.ai && "provider" in cfg.ai && "profiles" in cfg.ai) {
    throw new Error("ai.provider と ai.profiles は併記できません");
  }
  if (isLegacyAiConfig(cfg.ai)) {
    return legacyRuntime(cfg.ai.provider, cfg.ai.model ?? "auto", "legacy-ai");
  }
  if (cfg.ai?.profiles) {
    const names = Object.keys(cfg.ai.profiles);
    if (names.length > 16) throw new Error("AI profile は最大16件です");
    const profiles = new Map<string, ResolvedAiProfile>();
    for (const name of names) {
      validateAiProfileName(name);
      profiles.set(name, resolveProfile(name, cfg.ai.profiles[name], cfg.ai.defaults));
    }
    return {
      profiles,
      routes: {
        text: requireRouteProfile(profiles, "text", cfg.ai.routes.text),
        structured: requireRouteProfile(profiles, "structured", cfg.ai.routes.structured),
        ...(cfg.ai.routes.vision ? { vision: requireRouteProfile(profiles, "vision", cfg.ai.routes.vision) } : {}),
      },
      source: "routed",
    };
  }
  if (cfg.llm?.backend === "claude-cli") {
    return legacyRuntime("claude-code", cfg.llm.model || "auto", "legacy-llm");
  }
  if (cfg.llm?.backend === "api") {
    return legacyRuntime("anthropic", cfg.llm.model || "auto", "legacy-llm");
  }
  if (env) return defaultRuntime(env);
  loadRepoEnv();
  return defaultRuntime(process.env);
}

export function profileForRoute(runtime: ResolvedAiConfig, route: AiRoute): ResolvedAiProfile {
  const profileName = runtime.routes[route];
  if (!profileName) throw new Error(`AI route "${route}" は未設定です`);
  const profile = runtime.profiles.get(profileName);
  if (!profile) throw new Error(`AI route "${route}" のprofile "${profileName}" が見つかりません`);
  return profile;
}

export function aiCapabilities(cfg: Config, route: AiRoute, env?: NodeJS.ProcessEnv): AiCapabilities | null {
  const runtime = resolveAiRuntimeConfig(cfg, env);
  // 未設定は「その route は使えない」= route 未設定と同じ扱い。VLM 経路は
  // これを見て決定論のみへ優雅に劣化する(例外を投げない)
  if (runtime.source === "unconfigured") return null;
  const profileName = runtime.routes[route];
  if (!profileName) return null;
  return runtime.profiles.get(profileName)?.capabilities ?? null;
}

export function resolveAiCfg(cfg: Config): Required<LegacyAiConfig> {
  const runtime = resolveAiRuntimeConfig(cfg);
  const profile = profileForRoute(runtime, "text");
  return { provider: profile.adapter === "openai-compatible" ? "openai" : profile.adapter, model: profile.model };
}

/** "~/foo" をホームディレクトリに展開する */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export interface RecordingRoot {
  /** "main"(単一ルート運用時の暗黙キー)またはユーザー定義キー。 */
  key: string;
  /** 展開済み絶対パス */
  path: string;
}

export function resolveRecordingRoots(
  cfg: Pick<Config, "recordingsDir" | "recordingsDirs">,
): RecordingRoot[] {
  if (cfg.recordingsDirs) {
    return Object.entries(cfg.recordingsDirs).map(([key, path]) => ({ key, path }));
  }
  return [{ key: "main", path: cfg.recordingsDir }];
}

/** 収録ルートが「今そこにあるか」。
 * - `present`: 実在する(そのまま使える)
 * - `creatable`: まだ無いが、実在する親が書き込み可能=作れば使える
 * - `disconnected`: 作れる場所ですらない(未接続の外付け/未マウントの
 *   ネットワークボリューム)。設定ミスではなく**繋げば直る**状態 */
export type RecordingRootState = "present" | "creatable" | "disconnected";

/**
 * 収録ルートの状態を調べる(read-only。作成はしない)。
 *
 * 外付け USB は未接続だとマウント点(macOS なら `/Volumes/<ラベル>`)ごと
 * 存在せず、`mkdir -p` は `/Volumes` 自体を作ろうとして EACCES で落ちる。
 * これを「エラー」として毎回出すと、繋いでいないときの起動が常に警告まみれに
 * なるので、実在する直近の祖先が書き込み可能かどうかで
 * 「作れば使える(creatable)」と「未接続(disconnected)」を分ける。
 */
export function recordingRootState(path: string): RecordingRootState {
  const abs = resolve(expandHome(path));
  if (existsSync(abs)) return "present";
  let dir = abs;
  for (;;) {
    const parent = dirname(dir);
    // ファイルシステムのルートまで遡っても実在しない(通常は起こらない)
    if (parent === dir) return "disconnected";
    if (existsSync(parent)) {
      try {
        accessSync(parent, constants.W_OK);
        return "creatable";
      } catch {
        // 親はあるが書けない(= /Volumes 直下等)。未接続として扱う
        return "disconnected";
      }
    }
    dir = parent;
  }
}

/**
 * config.yaml のパスを解決する。探す順序:
 * 1. --config で明示されたパス
 * 2. カレントディレクトリの config.yaml
 * 3. リポジトリ直下の config.yaml(デフォルト設定)
 * 設定の書き戻し(エディタの設定画面)も同じパスへ書くため、読みと書きで
 * この関数を共有する
 */
export function resolveConfigPath(explicitPath?: string): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = explicitPath
    ? [explicitPath]
    : [resolve("config.yaml"), join(repoRoot, "config.yaml")];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    `config.yaml が見つかりません(探した場所: ${candidates.join(", ")})`,
  );
}

/** config.yaml を読み込む(パスの解決は resolveConfigPath) */
export function loadConfig(explicitPath?: string): Config {
  const cfg = parse(readFileSync(resolveConfigPath(explicitPath), "utf8")) as Config;
  const aiErrors = validateAiConfig(cfg.ai);
  if (aiErrors.length > 0) {
    throw new Error(`AI config error:\n- ${aiErrors.join("\n- ")}`);
  }
  const workflowErrors = validateWorkflowConfig(cfg);
  if (workflowErrors.length > 0) {
    throw new Error(`Workflow config error:\n- ${workflowErrors.join("\n- ")}`);
  }
  if (cfg.recordingsDirs) {
    cfg.recordingsDirs = Object.fromEntries(
      Object.entries(cfg.recordingsDirs).map(([key, path]) => [key, expandHome(path)]),
    );
    cfg.recordingsDir = Object.values(cfg.recordingsDirs)[0];
  } else {
    cfg.recordingsDir = expandHome(cfg.recordingsDir);
  }
  cfg.whisper.model = expandHome(cfg.whisper.model);
  cfg.whisper.wordTimestamps ??= true;
  cfg.whisper.systemAudio ??= false;
  // preview はテスト用の最小 config では省略されることがある(このセクション
  // 自体は require しない=既存挙動を壊さない)。あるときだけ既定値を補う
  if (cfg.preview) {
    cfg.preview.proxyIntra ??= true;
    cfg.preview.engine ??= "canvas";
  }
  cfg.ocr ??= {};
  cfg.ocr.languages ??= [...DEFAULT_OCR_LANGUAGES];
  return cfg;
}
