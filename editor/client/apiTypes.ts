// エディタのサーバー(editor/server.ts)とクライアントで共有する API の型。
// 編集対象のドキュメント自体はパイプラインの型(src/types.ts)をそのまま使う。

import type { AiAdapterKind, AiCapabilities, AiProfileStatus, Config } from "../../src/lib/config.ts";
import type { PerceptionStatus } from "../../src/lib/config.ts";
import type {
  Bgm,
  CutPlan,
  Interval,
  Manifest,
  Overlays,
  Transcript,
  WordTiming,
} from "../../src/types.ts";
import type { Profile } from "../../src/lib/profile.ts";
import type { FrameShot } from "../../src/stages/frames.ts";
import type { ReviewBundle, ReviewKey } from "../../src/stages/review.ts";
import type { PreparedDesignAssets } from "../../src/lib/design.ts";
import type { SourceCandidate } from "../../src/lib/findSource.ts";
import type { ThumbstripIndex } from "../../src/lib/thumbstrip.ts";
export type {
  AiProposeRequest,
  AiScope,
  AiSelectionContext,
} from "../../src/stages/editorAi.ts";
import type { AiProposeResponse as EditorAiProposeResponse } from "../../src/stages/editorAi.ts";

export interface AiProposeResponse {
  proposalId: string;
  proposal: EditorAiProposeResponse;
}

export interface AiReviewRequest {
  proposalId: string;
  acceptedHunkLabels: string[];
  secondaryObservation?: "none" | "vlm";
}

export interface AiReviewResponse {
  bundle: ReviewBundle;
}

export type AiRefineMode = "normal" | "warning-fix";

export interface AiRefineRequest {
  proposalId: string;
  acceptedHunkLabels: string[];
  instruction?: string;
  vlm?: boolean;
  mode?: AiRefineMode;
}

export interface AiRefineResponse {
  proposalId: string;
  proposal: EditorAiProposeResponse;
}

export interface AiDoctorCheck {
  status: "ok" | "warn" | "error" | "skip";
  message: string;
}

export interface AiDoctorResult {
  profile: string;
  adapter: AiAdapterKind;
  model: string;
  origin: string | null;
  checks: {
    config: AiDoctorCheck;
    credential: AiDoctorCheck;
    text: AiDoctorCheck;
    structured: AiDoctorCheck;
    image: AiDoctorCheck;
  };
}

/** GET /api/project のレスポンス。収録フォルダの編集に必要な全データ
 * (chapters.json は YouTube チャプター用メタデータでエディタでは扱わない) */
export interface EmptyProjectData {
  state: "empty";
  dir: string;
  candidates: SourceCandidate[];
  dirFiles: string[];
  /** editor --canvas で初回値を明示した場合の選択初期値。 */
  canvas?: string;
  /** editor --base-layout で初回値を明示した場合の選択初期値。 */
  baseLayout?: string;
}

export interface ReadyProjectData {
  state: "ready";
  dir: string;
  manifest: Manifest;
  transcript: Transcript;
  cutplan: CutPlan;
  overlays: Overlays;
  /** 収録フォルダ内の全ファイル(相対パス)。素材選択と存在チェック用 */
  dirFiles: string[];
  /** bgm.json(BGM の区間配置)。無ければ null で、その場合は bgmFile を
   * 全編1曲として流す(後方互換)。エディタでは編集せず表示・再生のみ */
  bgm: Bgm | null;
  bgmFile: string | null;
  /** cuts.auto.json の無音区間(BGM ダッキングをプレビューでも再現する
   * ために渡す。スクリプトタブの虚構タイムスタンプ判定の無音証拠にも使う)。
   * detect 未実行なら null */
  silences: Interval[] | null;
  /** cutplan の無音カット記録の reason 文言(config.detect.silenceCutReason の
   * 解決値)。スクリプトタブが cut 記録を無音証拠として数える一致判定用 */
  silenceCutReason: string;
  /** proxy.mp4 / proxy.m4a(元収録の軽量プロキシ。エディタの再生ソース)のファイル名 */
  proxyFile: "proxy.mp4" | "proxy.m4a";
  /** proxy.*(元収録の軽量プロキシ。エディタの再生ソース)があるか。
   * 無ければ POST /api/proxy で生成する(収録ごとに1回) */
  proxyExists: boolean;
  /** proxy.* が焼き込み済みの設定(ラウドネス・システム音声・プレビュー幅・
   * エンコーダ)か元収録ファイルと食い違っている(古い)か。proxyExists が
   * false のときは常に false(未生成であって陳腐化ではない) */
  proxyStale: boolean;
  /** 開いた瞬間の自動解析(transcribe → detect)が必要か。 */
  analysisNeeded: boolean;
  /** 自動解析が走れない理由(whisper モデル不在など)。null なら障害なし。 */
  analysisBlocked: string | null;
  renderCfg: Config["render"];
  /** server が現在の design key と全 PNG の存在を検証した静的資産 */
  designAssets?: PreparedDesignAssets;
  /** カット確認用プレビュー動画・プロキシの横幅(config の preview.width) */
  previewCfg: { width: number; videoEncoder?: "libx264" | "videotoolbox"; engine?: "canvas" | "legacy" };
  /** エディタ設定(サーバー側で省略時の既定値まで解決した実値) */
  editorCfg: EditorCfg;
  /** 最終レンダーの出力解像度(resolveCanvas) */
  output: { w: number; h: number };
  /** プレビュー/レンダー共通の解決済みキャンバス配置。 */
  canvasProfile: Profile;
  /** カメラ(ワイプ)を持つレイアウトか(obs-canvas かつ cameraRegion あり)。
   * plain(カメラ無し)ではワイプトラック・全画面区間 UI を出さない */
  hasCamera: boolean;
  /** 前回のセッションが保存せずに終わった(クラッシュ等)ときに残る
   * 未保存編集の退避(.editor-draft.json)。無ければ null */
  draft: DraftData | null;
  /** plan/remeta に渡る知覚設定の解決結果。header の短い状態表示用 */
  planPerception: PlanPerceptionStatus;
  aiProfiles: AiProfileStatus[];
  aiRoutes: { text: string; structured: string; vision?: string };
  aiReviewCfg: { vlm: boolean; maxImages: number; maxRefinements: number };
  /** 並行制御用の内容バージョン(§8.3)。存在する編集ファイル(cutplan/overlays/
   *  transcript/bgm)ごとの "sha256:…"。存在しないファイルはキーごと省略。
   *  client は不透明 token として保持し save 時に baseHashes として echo する
   *  (再計算はしない)。 */
  contentHashes: Record<string, string>;
}

export type ProjectData = EmptyProjectData | ReadyProjectData;

export interface ProjectSummary {
  root: string;
  name: string;
  hasManifest: boolean;
  durationSec: number | null;
  canvas: string;
  baseLayout?: string;
  derivedFrom?: string;
  rendered: boolean;
  modifiedAt: string;
}

export interface RootStatus {
  key: string;
  available: boolean;
  reason?: string;
}

export interface ProjectsResponse {
  roots: RootStatus[];
  projects: ProjectSummary[];
}

export type PlanPerceptionStatus = PerceptionStatus;

/** GET /api/script のレスポンス。元収録の全文スクリプト(AI が編集する前の
 * ベース)。whisper の生出力(whisper-out.json。編集で変わらない)が正で、
 * 無い収録では現在の transcript.json から代替する(source で区別)。
 * 時刻はすべて元収録の秒。スクリプトタブの表示専用で編集・保存はしない
 * (編集は cutplan.json 側に落ちる) */
export interface ScriptData {
  source: "whisper" | "transcript";
  segments: ScriptSegment[];
  /** words の時刻が DTW(whisper -dtw の t_dtw)で音響に固定されているか。
   * true なら取り消し線判定は幾何(keep との重なり)だけで正確になり、
   * 注意ベースのズレを補うヒューリスティクス(虚構語の継承・小穴の吸収)を
   * 使わない。省略/false = 従来の注意ベース時刻(ヒューリスティクス併用) */
  aligned?: boolean;
}

/** スクリプトの1文(whisper の segment 粒度)。words は語(トークン)単位の
 * タイミング(whisper.wordTimestamps 有効時のみ。無い文は文単位でしか
 * 選択できない) */
export interface ScriptSegment {
  start: number;
  end: number;
  text: string;
  words?: WordTiming[];
}

/** エディタ設定の解決済み実値(config.yaml editor セクション+既定値) */
export interface EditorCfg {
  maxUploadMb: number;
  maxBaseUploadMb: number;
  /** タイムラインに置く画像素材・尺不明素材の既定の尺(秒) */
  defaultImageDurationSec: number;
}

/** POST /api/config のレスポンス。保存後の解決済み設定(クライアントは
 * これで proj の該当フィールドを差し替える)。リクエストボディは
 * ConfigPatch(src/lib/configEdit.ts。クライアントからは import type のみ=
 * yaml パッケージをバンドルに入れない) */
export interface ConfigSaveResult {
  ok: true;
  renderCfg: Config["render"];
  designAssets?: PreparedDesignAssets;
  previewCfg: { width: number; videoEncoder?: "libx264" | "videotoolbox"; engine?: "canvas" | "legacy" };
  editorCfg: EditorCfg;
  aiProfiles: AiProfileStatus[];
  aiRoutes: { text: string; structured: string; vision?: string };
  aiReviewCfg: { vlm: boolean; maxImages: number; maxRefinements: number };
}

export type { AiCapabilities, AiProfileStatus };

export interface AiFrameRequest {
  times: number[];
  axis?: "source" | "output";
  ocr?: boolean;
  fullRes?: boolean;
}

export interface AiFrameResponse {
  shots: FrameShot[];
}

export interface ProxyResponse {
  ok: true;
  path: string;
  proxyFile: ReadyProjectData["proxyFile"];
}

export interface AnalyzeResponse {
  ok: true;
  /** 実行中に人間が transcript.json を編集したため文字起こし結果を破棄した。 */
  transcriptSkipped: boolean;
  /** detect が書いた無音区間。ProjectReady.silences をこれで置き換える。 */
  silences: Interval[] | null;
}

/** POST /api/draft のボディ = .editor-draft.json の中身。未保存の編集を
 * クラッシュ・強制終了から守るための自動退避で、正のデータ(各 JSON)には
 * 保存(⌘S)まで触らない。保存が成功したら削除される */
export interface DraftData {
  /** 退避した時刻(ISO 8601)。復元バナーの表示用 */
  savedAt: string;
  cutplan: CutPlan;
  overlays: Overlays;
  transcript: Transcript;
  /** BGM の区間配置(bgm.json)。未設定なら null */
  bgm: Bgm | null;
}

/** GET /api/peaks のレスポンス。マイク音声の波形ピーク(タイムライン描画用)。
 * 時刻軸は元収録の秒(micWav は元収録と同じ長さ) */
export interface PeaksData {
  /** 1秒あたりのピーク数 */
  rate: number;
  durationSec: number;
  /** ピーク列(各 0..255、全体の最大値で正規化)のバイト列を base64 で */
  peaks: string;
}

/** GET /api/thumbstrip のレスポンス。生成不能でも 200 + unavailable を返す
 * (エディタは thumbstrip 無しで普通に動くので 4xx にしない) */
export type ThumbstripData =
  | { state: "ready"; index: ThumbstripIndex }
  | { state: "unavailable"; reason: string };

/** GET /api/media-facts のレスポンス。動画素材(materials/ の mp4/mov/webm)
 * ごとの codec 由来のブラウザ表示可否(§design 8.2)。/api/project に含めない
 * (loadProject は sync・ffprobe は async I/O なので、初回ロードをそれで
 * ブロックしない)理由から /api/script / /api/peaks と同じ「重い部分は要求
 * されてから」の別エンドポイントにした。キーは素材の相対パス(dirFiles と
 * 同じ表記、"materials/xxx.mov")。判定できない/表示可能な素材は載らない=
 * 非表示のものだけを載せる疎な map。全素材が H.264/VP9 等なら空 {} で、
 * UI は現状どおり(挙動不変)。画像・音声は対象外(codec 問題が無い)。
 * 最終レンダーには影響しない(ffmpeg/Remotion は別途デコードできる) */
export interface MediaFactsData {
  mediaCodecFacts: Record<string, { codec: string; reason: string }>;
}

/** GET /api/hyperframes のカード1件。HTML source と render 済み MP4 の
 * 和集合なので、どちらか片方だけのカードも返る。error は壊れた HTML / cache
 * sidecar をカード単位で知らせるもので、一覧全体の取得失敗とは区別する。 */
export interface HyperframeCard {
  name: string;
  mp4Path?: string;
  htmlExists: boolean;
  rendered: boolean;
  stale: boolean;
  durationSec?: number;
  width?: number;
  height?: number;
  error?: string;
}

export interface HyperframesData {
  hyperframes: HyperframeCard[];
  assetLimits: {
    maxBytes: number;
    maxTotalBytes: number;
    fontMaxBytes: number;
  };
}

export interface HyperframeRenderRequest {
  name: string;
}

export interface HyperframeRenderResponse {
  ok: true;
  card: HyperframeCard;
  skipped: boolean;
}

export interface HyperframeAuthorRequest {
  name: string;
  brief: string;
  assets?: Array<{
    name: string;
    /** Base64 本体(data: prefix は付けない)。 */
    data: string;
  }>;
}

export interface HyperframeAuthorResponse {
  ok: true;
  card: HyperframeCard;
}

/** POST /api/upload のレスポンス。素材は materials/ に保存される */
export interface UploadResult {
  /** 収録フォルダからの相対パス(materials/xxx.png) */
  file: string;
  /** 動画素材の長さ(秒)。画像や取得失敗時は null */
  durationSec: number | null;
}

export interface BaseMediaRequest {
  file: string;
  canvas?: string;
  baseLayout?: string;
}

/** POST /api/save のボディ。含まれるドキュメントだけがファイルに書かれる。
 * transcript はテロップの文言・表示時間の編集用(手直し→再レンダーは
 * 元々パイプラインが想定するワークフロー。plan の再実行は cutplan と
 * 章トラックのテロップを作り直すので注意) */
export interface SaveRequest {
  cutplan?: CutPlan;
  overlays?: Overlays;
  transcript?: Transcript;
  /** BGM の区間配置。`null` / 空 tracks は bgm.json を削除する(= 全編1曲の
   * 後方互換へ戻す)。`undefined`(キー無し)は bgm.json を触らない */
  bgm?: Bgm | null;
  /** client が読み込んだ各ファイルの内容バージョン("sha256:…" / 読み込み時に
   *  存在しなければ null)。送られていれば server は一致時のみ書き、不一致なら
   *  全体を 409 stale_base で拒否する。キー自体が無ければ従来どおり無条件保存
   *  (旧 client・プログラム的呼び出しの後方互換)。§8.3 */
  baseHashes?: Record<string, string | null>;
}

/** POST /api/save の 200 レスポンス。書いた/削除したファイルの保存後内容バージョン
 *  (削除は null)。client は reload せずにこれで base を更新する。 */
export interface SaveResponse {
  ok: true;
  contentHashes: Record<string, string | null>;
}
