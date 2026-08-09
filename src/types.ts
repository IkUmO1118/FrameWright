// パイプラインの中間ファイル(JSON)のスキーマ定義。
// 各ステージはここで定義した型のファイルを読み書きする。

/** ingest が生成。収録ファイルの構成情報(manifest.json) */
export interface Manifest {
  /** 収録フォルダの絶対パス */
  dir: string;
  /** 元ファイル名(収録フォルダ内) */
  source: string;
  durationSec: number;
  /** レイアウト。省略時は "obs-canvas"(旧 manifest 互換)。
   *  obs-canvas: 拡張キャンバス(画面+カメラ横並び)。cameraRegion を持つ
   *  plain:      通常動画。カメラ無し。screenRegion は全フレーム
   *  stills:     音声のみの元ファイル。映像は inserts[] の静止画で構成 */
  layout?: "obs-canvas" | "plain" | "stills";
  /** 作成時に固定する出力キャンバス(サイズ)。省略時は screenRegion の寸法(従来どおり)。 */
  canvas?: string;
  /** 作成時に固定するベース映像(画面/カメラ)の置き方。省略時 "auto"。
   *  camera / stack はカメラのある obs-canvas 収録でのみ有効。 */
  baseLayout?: string;
  /** 同じ recordings root 直下の親プロジェクトから派生した場合の軽い由来情報。
   * 絶対パスは持たず、フォルダ移動時は一覧側が同じ root 内の name で解決する。 */
  derivedFrom?: {
    name: string;
    ranges: Interval[];
  };
  video: {
    width: number;
    height: number;
    fps: number;
    /** 出力に使う画面領域(=出力解像度)。obs-canvas は 3840x1080 内の
     *  画面部分、plain は全フレーム(= {x:0,y:0,w:width,h:height}) */
    screenRegion: Region;
    /** カメラ(ワイプ)領域。plain では無し(ワイプ非対応) */
    cameraRegion?: Region;
  };
  audio: {
    /** マイク音声のストリーム番号(ffmpeg の a:N) */
    micStream: number;
    /** システム音声のストリーム番号。存在しない場合は null */
    systemStream: number | null;
    /** 抽出済みマイク音声(16kHz mono wav、収録フォルダからの相対パス) */
    micWav: string;
    /** 抽出済みシステム音声(16kHz mono wav、収録フォルダからの相対パス)。
     *  whisper.systemAudio 有効 かつ systemStream が存在するときだけ設定される。
     *  省略時=未抽出(既定・バイト等価)。知覚専用(transcript.system.json を
     *  作るためだけの入力。描画・mix には無関係) */
    systemWav?: string;
  };
  createdAt: string;
}

/** Remotion composition / Player が使う整数 fps。素材の実測平均 fps ではなく、
 * manifest を唯一の clock として preview bake / cache でも共有する。 */
export const manifestCompositionFps = (manifest: Pick<Manifest, "video">): number =>
  Math.round(manifest.video.fps) || 30;

/** manifest のレイアウト(未指定は旧 manifest 互換で obs-canvas) */
export const manifestLayout = (m: { layout?: string }): "obs-canvas" | "plain" | "stills" =>
  m.layout === "plain" || m.layout === "stills" ? m.layout : "obs-canvas";

/** ワイプ(カメラ)を持つレイアウトか。plain・cameraRegion 欠落は false */
export const hasCamera = (m: Manifest): boolean =>
  manifestLayout(m) === "obs-canvas" && m.video.cameraRegion != null;

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** transcribe が生成(transcript.json)。JSON Schema: schemas/transcript.schema.json
 * (スキーマを変えたらこのコメント・validate.ts・usage.md と揃える。§5点セット) */
export interface Transcript {
  /** 機械が書いたまま人間がまだ手を入れていない印。
   * "bootstrap" = editor が開くときに補った空文書。
   * "transcribe" = 自動解析の文字起こし結果。テロップとしては描画しない。
   * 人間か AI が transcript に触れた時点で消える(=採用)。 */
  generatedBy?: "bootstrap" | "transcribe";
  language: string;
  model: string;
  segments: TranscriptSegment[];
}

/** transcribe が生成する知覚専用のシステム音声文字起こし(transcript.system.json)。
 * **描画されない**(テロップにならない)・**編集されない**・`@id`/承認 hash/apply の
 * 対象外。plan / describe が「アプリ・デモ・TTS が何を鳴らしたか」を読むためだけの
 * 生成物(GENERATED カテゴリ)。`track`/`pos`/`style`/`words`/`id` を構造的に持たない
 * ことで「描画・アドレッシングの契約は transcript.json だけが担う」を型で表す。
 * 時刻は他と同じく元収録(raw)の秒。`speaker` はトラック起源の話者帰属(mic=host に
 * 対する system の対比。音響的な話者分離ではない=§audio-perception-design D4) */
export interface SystemTranscript {
  language: string;
  model: string;
  speaker: "system";
  segments: { start: number; end: number; text: string }[];
}

export interface TranscriptSegment {
  /** 編集をまたいで安定な永続 id(例 "cap_a1b2c3")。`@id` で人間/AI がこの要素を
   * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
   * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
   * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
   * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
   * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
  id?: string;
  /** 秒 */
  start: number;
  end: number;
  text: string;
  /** テロップトラック番号(1始まり)。省略時 1。重なりは layerOrder が決める */
  track?: number;
  /** このテロップだけの表示位置(テキスト中心、出力px)。
   * 省略時はトラックの標準位置(overlays.json の captionTracks)、
   * それも無ければ従来の下部中央 */
  pos?: CaptionPos;
  /** このテロップだけの見た目。項目単位でトラック標準・既定値に重なる */
  style?: CaptionStyle;
  /** 語/トークン単位のタイミング(whisper -ojf の per-token offsets 由来)。
   * 省略可(後方互換)。**カラオケアニメ等の描画専用の補助データで、テロップの
   * 文言・表示区間そのものは常に text / start / end が正**。人間が text を
   * 手編集すると words[] は古くなりうる(§5 参照)。特殊トークン([_BEG_] /
   * [_TT_NNN] 等)と空 text は除外済み。時刻は他と同じく「元収録(raw)の秒」。
   * words[] は時系列順で、各 word の [start,end) は親 segment の [start,end] に収まる */
  words?: WordTiming[];
}

/** transcript の1語/1トークンのタイミング。whisper のサブワード単位
 * (日本語は分かち書きが無いためトークン=サブワード)。時刻は元収録の秒 */
export interface WordTiming {
  /** トークン文字列(前後空白を trim 済み。特殊トークンは含めない) */
  text: string;
  /** 開始・終了(元収録の秒)。start < end。親 segment の範囲内 */
  start: number;
  end: number;
  /** whisper の確信度(0..1、-ojf の token.p)。省略可 */
  confidence?: number;
}

/** テロップの表示位置。出力解像度上のテキスト中心座標(px) */
export interface CaptionPos {
  x: number;
  y: number;
}

/** テロップの見た目。項目単位で「セグメント個別 → トラック標準 → 既定値」の
 * 順に重なる(サイズの既定は config.yaml の render.captionFontSizePx) */
export interface CaptionStyle {
  fontSizePx?: number;
  /** 文字色(CSS カラー)。既定は白 */
  color?: string;
  /** 縁取り色(CSS カラー)。既定は青。"none" で縁取りを消す
   * (座布団=background と組み合わせるときの定番) */
  outlineColor?: string;
  /** 縁取りの太さ(出力px)。0 以上。省略時はフォントサイズの 0.25 倍
   * (従来の既定)。縁を消したいときは太さ 0 ではなく outlineColor:"none" を使う */
  outlineWidthPx?: number;
  /** フォント種(CSS の font-family)。既定は日本語ゴシック(CAPTION_DEFAULT_FONT_FAMILY) */
  fontFamily?: string;
  /** 文字の太さ(CSS の font-weight 相当の 100〜900)。既定は 700 */
  fontWeight?: number;
  /** 座布団(テキスト背後の背景帯)。YouTube テロップの定番表現。
   * 縁取りを消したい場合は outlineColor: "none" を併用する。
   *
   * 省略(undefined)は「指定なし」で、下の層(トラック標準 → config.yaml の
   * render.captionBackground)から継承する。継承された帯を**この層で明示的に
   * 消す**には "none" を書く(outlineColor: "none" と同じ流儀)。
   * 解決の優先順は config 既定 → captionTracks[].style → segment.style で、
   * どの層でも "none" でその下を打ち消せる */
  background?: CaptionBackground | "none";
  /** 登場/退場アニメ(フェード・スライド・ポップ)。省略時アニメ無し=現状
   * (器の opacity/transform は動かず、追加 div も出ない)。素材(overlays)の
   * fadeInSec/fadeOutSec に対応するテロップ版 */
  anim?: CaptionAnim;
  /** カラオケ表示(発話に同期した語の色替え)。segment.words[](語単位
   * タイムスタンプ)を消費する。省略時カラオケ無し=現状。words[] が無い
   * テロップに指定しても無視され通常表示になる(validate が警告) */
  karaoke?: CaptionKaraoke;
}

/** テロップの座布団(背景帯)の設定 */
export interface CaptionBackground {
  /** 帯の色(CSS カラー。半透明の rgba() も可) */
  color: string;
  /** テキスト周りの余白(px、横方向)。省略時はフォントサイズの 0.35 倍。
   * 縦の余白はこの 0.5 倍にする */
  paddingPx?: number;
  /** 角丸の半径(px)。省略時 8 */
  radiusPx?: number;
}

/** テロップの登場/退場アニメ。CaptionStyle.anim。省略時はアニメ無し(現状)。
 * in/out はキー単位で独立(片方だけ指定可)。durationSec は in/out 共通。
 * かかるのはテロップの器(位置・レイアウトは不変)で、opacity と transform
 * だけを時間で動かす。素材の fadeInSec/fadeOutSec に対応するテロップ版。 */
export interface CaptionAnim {
  /** 登場(表示開始 start から durationSec 秒)。省略時 in なし(瞬時に出る) */
  in?: CaptionAnimKind;
  /** 退場(表示終了 end の手前 durationSec 秒)。省略時 out なし(瞬時に消える) */
  out?: CaptionAnimKind;
  /** in/out それぞれの遷移秒。省略時 DEFAULT_CAPTION_ANIM_SEC(0.3)。
   * 表示区間が in+out より短いときは短い方へ自動で縮める(fadeFactor と同じ) */
  durationSec?: number;
}

/** アニメ種別の最小セット。"none" は明示的にアニメ無し(トラック標準を打ち消す用) */
export type CaptionAnimKind =
  | "fade"        // 不透明度 0→1
  | "slide-up"    // 下からせり上がりながらフェード
  | "slide-down"  // 上から降りながらフェード
  | "slide-left"  // 右から寄りながらフェード
  | "slide-right" // 左から寄りながらフェード
  | "pop"         // 小さめから拡大しながらフェード
  | "none";

/** テロップのカラオケ表示。CaptionStyle.karaoke。省略時はカラオケ無し(現状)。
 * segment.words[](語単位タイムスタンプ)を消費し、発話済みの語を activeColor に、
 * 未発話の語を inactiveColor(既定=テロップの本文色)にして左から順に色を進める。
 * words[] が無いテロップに指定した場合は無視され通常表示になる(validate が警告)。 */
export interface CaptionKaraoke {
  /** 発話済み(t >= 語の start)の語の色。省略時 KARAOKE_DEFAULT_ACTIVE(#ffe14d) */
  activeColor?: string;
  /** 未発話の語の色。省略時はテロップの本文色(style.color→既定の白)。
   * 「未発話は薄く」したいときは inactiveOpacity と併用 */
  inactiveColor?: string;
  /** 未発話の語の不透明度(0〜1)。省略時 1。0.4 等で「これから読む所を薄く」 */
  inactiveOpacity?: number;
  /** 語をまたぐ塗りの進み方。"word"(既定): 語単位で瞬間に色が切り替わる /
   * "fill": いま発話中の語だけ左から右へ塗り進む(karaoke 字幕の定番)。 */
  mode?: "word" | "fill";
}

/** style 未指定時の文字色・縁取り色・フォント種・太さ */
export const CAPTION_DEFAULT_COLOR = "#ffffff";
export const CAPTION_DEFAULT_OUTLINE = "#2563eb";
// Noto Sans JP を先頭に置く。これはバンドル同梱の可変フォント(remotion/
// fonts/NotoSansJP.woff2、wght 100〜900)で、fontWeight の 300/500/600/800 等
// 中間ウェイトを実グリフとして描き分けられる。システムフォント(Hiragino)は
// 数値ウェイトの中間を丸めてしまい太さ指定がほぼ効かないため、太さ制御を
// 効かせる目的で既定を Noto に切り替えている。Hiragino は同梱フォントの
// 読み込み失敗時のフォールバックとして残す(見た目は近いゴシック)。
export const CAPTION_DEFAULT_FONT_FAMILY =
  '"Noto Sans JP", "Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif';
export const CAPTION_DEFAULT_FONT_WEIGHT = 700;

// 明朝の既定も同じ理由で同梱の可変フォント(assets/fonts/NotoSerifJP.woff2、
// wght 200〜900)を先頭に置く。ヒラギノ明朝 ProN は W3(400)と W6(600)の
// 2ウェイトしか無いため、600 以上を指定しても実フェイスが W6 に丸められ、
// かつ 600 の実フェイスが在るぶん合成ボールドも掛からず 600〜900 が
// すべて同じ絵になる(=太さ指定が効かない)。ヒラギノ明朝は同梱フォントの
// 読み込み失敗時のフォールバックとして残す。
export const CAPTION_MINCHO_FONT_FAMILY =
  '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif';

/** CaptionAnim.durationSec 未指定時の既定(秒)。in/out 共通。描画側の最終フォールバック */
export const DEFAULT_CAPTION_ANIM_SEC = 0.3;
/** CaptionKaraoke.activeColor 未指定時の既定(発話済みの語の色) */
export const KARAOKE_DEFAULT_ACTIVE = "#ffe14d";

/** render.wipeTransitionSec 未指定時の既定(秒)。renderProps と設定画面で共有。
 * config.ts は node 専用(node:fs 等)なので、ブラウザにも入るこのファイルに置く */
export const DEFAULT_WIPE_TRANSITION_SEC = 0.3;

export type WipeAnchor =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

export interface WipeStyle {
  anchor: WipeAnchor;
  marginPx: number;
  sizePx: number;
  radiusPx: number;
  shadow: boolean;
}

/** render.cutTransition.sec 未指定時の既定(秒)。dip-to-black 使用時の
 * 黒への往復の合計秒(前半でフェードアウト、後半でフェードイン) */
export const DEFAULT_CUT_TRANSITION_SEC = 0.3;

/** detect が生成(cuts.auto.json)。機械的に検出したカット候補 */
export interface AutoCuts {
  /** 検出パラメータ(再現性のため記録) */
  params: {
    silenceDb: number;
    minSilenceSec: number;
    padSec: number;
    calibration?: {
      method: "silencedetect-occupancy-v1";
      floorDb: number;
      floorOffsetDb: number;
      effectiveSilenceDb: number;
    };
    silenceCompaction?: {
      preset:
        | "gentle" | "balanced" | "tight"
        | "compact-gentle" | "compact-balanced" | "compact-tight";
      minKeepSec: number;
    };
    /** keep 端の実音声 RMS トリム(C7)の記録。detect.edgeTrim 有効時のみ */
    edgeTrim?: {
      floorOffsetDb: number;
      padSec: number;
      maxTrimSec: number;
      floorDb: number;
      thresholdDb: number;
      trimmedSec: number;
      trimmedEdges: number;
    };
  };
  /** 無音区間(この区間がカット候補。補集合=発話区間は render の
   * BGM ダッキングにも使われる) */
  silences: Interval[];
  /** 残す区間(無音の補集合+前後パディング) */
  keepSegments: Interval[];
  /** 残す区間の合計秒数 */
  keptDurationSec: number;
  originalDurationSec: number;
}

export interface Interval {
  start: number;
  end: number;
}

/** plan が生成、人間が編集して承認する(cutplan.json)。JSON Schema:
 * schemas/cutplan.schema.json(§5点セット) */
export interface CutPlan {
  /** 開くために決定論的に作った未編集の初期値。人間/AI が書けば消える。 */
  generatedBy?: "bootstrap";
  /** 人間の承認意図の表示(GUI チェックボックスのモデル)。**render のゲートでは
   * ない**(src/lib/approval.ts を参照)。render は approvals.json の承認
   * レコード(keep 集合のハッシュに束縛)だけを見る。ここが true でもレコードが
   * 無い/内容が変わっていれば render は拒否される(validate が警告する) */
  approved: boolean;
  /** 残す区間のリスト(時系列順)。reason は人間が確認するための説明 */
  segments: PlanSegment[];
}

export interface PlanSegment {
  /** 編集をまたいで安定な永続 id(例 "seg_a1b2c3")。`@id` で人間/AI がこの要素を
   * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
   * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
   * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
   * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
   * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
  id?: string;
  start: number;
  end: number;
  /** keep: 残す / cut: 切る(確認用に候補も残しておく) */
  action: "keep" | "cut";
  reason: string;
  /** この判断の分類 id(docs/edit-skills/cut/recipes/<id>.md)。値の単一の出所は
   * src/lib/reasonIds.ts の CUT_REASON_IDS。省略可=未分類。1つも持たない
   * プロジェクトは全コマンドが本機能導入前とバイト等価(opt-in・sticky。
   * src/lib/ids.ts の id と同じ流儀)。**render / 承認 hash には一切影響しない**
   * (src/lib/approval.ts の cutplanApprovalHash は keep の [start, end] のみ参照) */
  reasonId?: string;
  /** keep 区間の再生倍率。省略時1。cut segment には指定不可 */
  speed?: number;
}

export const MIN_PLAYBACK_SPEED = 0.25;
export const MAX_PLAYBACK_SPEED = 4;
export const DEFAULT_PLAYBACK_SPEED = 1;

/** 承認レコード(approvals.json)。承認は cutplan の keep 集合の
 * ハッシュに束縛され、内容が変われば hash 不一致で自動失効する。
 * render の唯一のゲート。boolean approved は人間の意図表示に降格
 * (CutPlan.approved のコメント参照)。
 * 収録フォルダ直下の別ファイルに置く(cutplan.json 等の編集ワークフローとは
 * 別行為にするため。src/lib/approval.ts が算出・読み書きする) */
export interface Approvals {
  version: 1;
  cutplan?: ApprovalRecord;
}

export interface ApprovalRecord {
  /** "sha256:…"。src/lib/approval.ts が現内容から算出した値と一致で承認有効 */
  hash: string;
  /** 承認した時刻(情報用。ゲート判定には使わない) */
  approvedAt: string;
  /** 承認した経路(情報用。監査の助け。信頼できる値ではないため判定には使わない) */
  by?: "cli" | "gui";
}

/** plan が生成(chapters.json)。YouTube チャプター用の章立てメタデータ
 * (概要欄の「0:00 導入」リストの元)。動画への描画には使われない:
 * 章タイトルの表示は plan が通常テロップとして transcript.json に書く。
 * JSON Schema: schemas/chapters.schema.json(§5点セット) */
export interface Chapters {
  chapters: {
    /** 編集をまたいで安定な永続 id(例 "ch_a1b2c3")。`@id` で人間/AI がこの要素を
     * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
     * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
     * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
     * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
     * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
    id?: string;
    start: number;
    title: string;
  }[];
}

/** 画面の重なりレイヤーの識別子。overlays.json の layerOrder と
 * RenderProps で共用する。ov<N> は素材トラック(V1, V2, ... 可変個数)、
 * テロップトラックは1本目が "caption"(従来互換)、2本目以降が cap<N>、
 * テキストトラックは1本目が "text"(従来互換)、2本目以降が text<N> */
export type LayerId =
  | "wipe" | "caption" | "text"
  | `ov${number}` | `cap${number}` | `text${number}`;

export const ovId = (n: number): LayerId => `ov${n}`;
/** "ov3" → 3。素材トラックでなければ null */
export const ovNum = (id: string): number | null => {
  const m = /^ov([1-9]\d*)$/.exec(id);
  return m ? Number(m[1]) : null;
};

/** テロップトラック n の LayerId。1本目は従来互換の "caption" */
export const capId = (n: number): LayerId => (n === 1 ? "caption" : `cap${n}`);
/** "caption" → 1、"cap3" → 3。テロップトラックでなければ null */
export const capNum = (id: string): number | null => {
  if (id === "caption" || id === "cap1") return 1;
  const m = /^cap([1-9]\d*)$/.exec(id);
  return m ? Number(m[1]) : null;
};

/** テキストトラック n の LayerId。1本目は従来互換の "text" */
export const textId = (n: number): LayerId => (n === 1 ? "text" : `text${n}`);
/** "text" → 1、"text3" → 3。テキストトラックでなければ null */
export const textNum = (id: string): number | null => {
  if (id === "text" || id === "text1") return 1;
  const m = /^text([1-9]\d*)$/.exec(id);
  return m ? Number(m[1]) : null;
};
/** texts エントリのテキストトラック番号(1始まり) */
export const textTrack = (t: { track?: number }): number => t.track ?? 1;

/** transcript セグメントのテロップトラック番号(1始まり) */
export const captionTrack = (s: { track?: number }): number => s.track ?? 1;

/** セグメントが属するテロップトラックの標準設定(captionTracks のエントリ) */
const captionTrackDefOf = (s: { track?: number }, overlays: Overlays) =>
  (overlays.captionTracks ?? []).find((t) => t.track === captionTrack(s));

/** テロップの実効表示位置。セグメント指定 → トラック標準 → null(下部中央) */
export const captionPosOf = (
  s: TranscriptSegment,
  overlays: Overlays,
): CaptionPos | null => {
  if (s.pos) return s.pos;
  const def = captionTrackDefOf(s, overlays);
  return def && def.x !== undefined && def.y !== undefined
    ? { x: def.x, y: def.y }
    : null;
};

/** テロップの実効スタイル。項目単位でトラック標準に個別指定を重ねる。
 * どちらも無ければ null(=すべて既定値) */
export const captionStyleOf = (
  s: TranscriptSegment,
  overlays: Overlays,
): CaptionStyle | null => {
  const merged: CaptionStyle = { ...captionTrackDefOf(s, overlays)?.style, ...s.style };
  return Object.keys(merged).length > 0 ? merged : null;
};

/** テロップの座布団(背景帯)の実効値。上の層の指定 → 下の層の既定、の順に
 * 解決する。"none"(明示的に帯なし)は下の層を打ち消して undefined になる。
 *
 * render(Remotion 本編)・render 高速パスの PNG 焼き・エディタの表示は
 * すべてこの1関数を通す。ここを通さずに `style.background ?? defaults` と
 * 書くと "none" が素通りして「帯を消したのに消えない」に戻るので注意 */
export const resolveCaptionBackground = (
  style: CaptionBackground | "none" | undefined,
  fallback?: CaptionBackground | "none",
): CaptionBackground | undefined => {
  const v = style ?? fallback;
  return v === "none" || v === undefined ? undefined : v;
};

/** テロップの座標の解釈(トラック単位)。center: pos はテキスト中心 /
 * topLeft: pos はテキストボックスの左上(章タイトルなど左寄せ配置用) */
export const captionAnchorOf = (
  s: { track?: number },
  overlays: Overlays,
): "center" | "topLeft" => captionTrackDefOf(s, overlays)?.anchor ?? "center";

/** テロップトラックの表示名。captionTracks の name → 自動ラベル */
export const captionTrackName = (
  track: number,
  overlays: Overlays,
  trackCount: number,
): string => {
  const name = (overlays.captionTracks ?? []).find((t) => t.track === track)?.name;
  return name ?? (trackCount > 1 ? `テロップ T${track}` : "テロップ");
};

/** overlays エントリの素材トラック番号(1始まり)。
 * 旧式の layer は under=V1 / over=V2 に対応付ける */
export const overlayTrack = (o: { track?: number; layer?: "under" | "over" }): number =>
  o.track ?? (o.layer === "over" ? 2 : 1);

/** layerOrder 省略時の重なり順(下→上)。素材 n トラック構成。
 * n=2 は従来の固定レイアウト(V1=ワイプ下 / V2=ワイプ上)と同じで、
 * 3本目以降は V2 の上に積む。n=1(素材ゼロ/1本の案件)は意図的に
 * ワイプより上の素材レーン(V2)を出さない(空トラック抑制) */
export function defaultLayerOrder(n: number): LayerId[] {
  const extra = Array.from({ length: Math.max(0, n - 1) }, (_, i) => ovId(i + 2));
  return ["ov1", "wipe", ...extra, "caption"];
}

/** 従来互換の既定順(素材2トラック) */
export const DEFAULT_LAYER_ORDER: LayerId[] = defaultLayerOrder(2);

/** テロップトラックの標準設定1件。overlays.json の captionTracks で使う */
export interface CaptionTrackDef {
  /** 編集をまたいで安定な永続 id(例 "ct_a1b2c3")。`@id` で人間/AI がこの要素を
   * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
   * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
   * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
   * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
   * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
  id?: string;
  track: number;
  name?: string;
  x?: number;
  y?: number;
  anchor?: "center" | "topLeft";
  style?: CaptionStyle;
}

export type KeyframeEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "hold";

export interface Keyframe<TValues> {
  /** 元収録の秒。親要素の [start,end] 内 */
  at: number;
  /** このキーから次の同プロパティのキーへ向かう区間の easing。省略時 linear */
  easing?: KeyframeEasing;
  /** この時刻で値を固定するプロパティ。最低1つ必要 */
  values: TValues;
}

export interface MaterialKeyframeValues {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  opacity?: number;
}

export interface BlurKeyframeValues {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  strength?: number;
}

export interface ArrowKeyframeValues {
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  widthPx?: number;
  headPx?: number;
}

export interface BoxKeyframeValues {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  widthPx?: number;
  radiusPx?: number;
}

export interface SpotlightKeyframeValues {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  dim?: number;
  featherPx?: number;
  radiusPx?: number;
}

/** 人間が書く演出指定(overlays.json)。ファイルが無ければ全部なし。
 * 時刻は他の編集ファイルと同じく元動画(収録ファイル)の秒。
 * JSON Schema: schemas/overlays.schema.json(§5点セット) */
export interface Overlays {
  /** 素材(画像/動画)を表示する区間。省略時は画面いっぱい、rect で
   * 部分配置(ピクチャ・イン・ピクチャ)もできる */
  overlays?: {
    /** 編集をまたいで安定な永続 id(例 "mat_a1b2c3")。`@id` で人間/AI がこの要素を
     * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
     * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
     * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
     * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
     * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
    id?: string;
    start: number;
    end: number;
    /** 素材ファイル(収録フォルダからの相対パス) */
    file: string;
    /** 素材トラック番号(1始まり)。省略時 1。重なりは layerOrder が決める */
    track?: number;
    /** 旧式のトラック指定(under=V1 / over=V2)。track があればそちらが優先 */
    layer?: "under" | "over";
    /** contain: 全体を見せる(全画面時の余白は黒、rect 配置時は透過) /
     *  cover: 領域を埋める(端が切れる)。省略時 contain */
    fit?: "contain" | "cover";
    /** 頭出し(In点)。素材ファイル内の再生開始位置(秒)。省略時 0(頭から)。
     *  動画素材のみ有効(画像では無視) */
    startFrom?: number;
    /** 音量(0〜2、1=素材の音量のまま)。省略時 0 = 無音(従来どおり)。
     *  動画素材のみ有効。マイク音声・BGM はそのまま重なる */
    volume?: number;
    /** 不透明度(0〜1)。省略時 1 */
    opacity?: number;
    /** フェードイン/アウト(秒)。表示区間の頭/末尾で不透明度(と音量)を
     *  なめらかに遷移する。省略時 0(なし) */
    fadeInSec?: number;
    fadeOutSec?: number;
    /** 表示領域(出力px の {x, y, w, h})。省略時は全画面。
     *  fit はこの領域内での素材の収め方になる */
    rect?: Region;
    /** 位置/サイズ/opacity の時間変化。時刻は元収録の秒 */
    keyframes?: Keyframe<MaterialKeyframeValues>[];
  }[];
  /** ベース映像トラックへの挿入クリップ(Premiere のインサート編集相当)。
   * カット後タイムラインの at(元収録の秒)の位置に file を durationSec ぶん
   * 差し込む。at 以降のすべての要素(keep 区間・素材・テロップ)は
   * 元収録の秒のまま動かさず、時刻写像が挿入の尺ぶん後ろへずらす。
   * at が同じ挿入が複数あるときは overlays.json に書いた順に並ぶ */
  inserts?: {
    /** 編集をまたいで安定な永続 id(例 "ins_a1b2c3")。`@id` で人間/AI がこの要素を
     * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
     * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
     * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
     * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
     * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
    id?: string;
    /** 挿入位置のアンカー(元収録の秒)。この時刻の手前に挿入される */
    at: number;
    /** 素材ファイル(収録フォルダからの相対パス) */
    file: string;
    /** 挿入する尺(秒)。動画の実尺より長いと最後のフレームで止まる */
    durationSec: number;
    /** 頭出し(In点)。素材ファイル内の再生開始位置(秒)。省略時 0(頭から)。
     *  動画素材のみ有効(画像では無視)。startFrom + durationSec が素材の
     *  実尺を超えると、超えた分は最後のフレームで止まる */
    startFrom?: number;
    /** contain: 全体を見せる(余白は黒) / cover: 画面を埋める。省略時 contain */
    fit?: "contain" | "cover";
    /** 音量(0〜2、1=素材の音量のまま)。省略時 1(音声込み。従来どおり)。
     *  0 で無音になる */
    volume?: number;
    /** フェードイン/アウト(秒)。黒からの明転/黒への暗転(音量も連動)。
     *  省略時 0(なし) */
    fadeInSec?: number;
    fadeOutSec?: number;
  }[];
  /** ワイプ(カメラ)を全画面にして背景を隠す区間。transitionInSec / transitionOutSec
   * は区間別の入り/戻りの遷移秒(0=瞬時、省略=render.wipeTransitionSec)。
   * transitionSec は旧形式で、個別指定のない両方向へ適用する。id は
   * "wf_a1b2c3" 形式(§Interval & id の共通仕様。src/lib/ids.ts が単一の出所。
   * 省略可=id 未採番) */
  wipeFull?: (Interval & {
    id?: string;
    transitionSec?: number;
    transitionInSec?: number;
    transitionOutSec?: number;
  })[];
  /** 録画単位の常駐ワイプ設定。存在する場合は全項目必須で、
   * config.yaml のワイプ見た目を項目単位では継承しない。 */
  wipeStyle?: WipeStyle;
  /** 画面の重なり順(下→上)。ベース映像と BGM は対象外。
   *  省略時は DEFAULT_LAYER_ORDER(エディタのトラック並べ替えが書く) */
  layerOrder?: LayerId[];
  /** テロップトラックの標準設定。x/y(出力px)はセグメント側の pos が無い
   * テロップに、style は項目単位で個別指定の無い項目に効く。位置が無い
   * トラックは従来の下部中央、style が無ければ既定の見た目。
   * anchor は座標の解釈(省略時 center=テキスト中心 / topLeft=左上。
   * 章タイトルのような左寄せ配置のトラックに使う)。
   * name はタイムラインに出すトラック名(省略時は自動ラベル) */
  captionTracks?: CaptionTrackDef[];
  /** 字幕を出さない区間。id は "hc_a1b2c3" 形式(§Interval & id の共通仕様。
   * src/lib/ids.ts が単一の出所。省略可=id 未採番) */
  hideCaption?: (Interval & { id?: string })[];
  /** ズーム演出(画面の一部を拡大して見せる)。区間は重ならないこと。
   * かかるのは「背景(design の背景画像)+画面パネル」の合成面全体で、
   * ワイプ・テロップ・素材オーバーレイ・挿入クリップ・blur/annotation は
   * 動かない(design 無しでは背景が無くパネル=出力全面なので、実質
   * ベース映像(画面クロップ)だけが動く)。隣の区間と隙間なく接する
   * (end === 次の start)と連鎖になり、境界で等倍へ戻らず次の rect へ
   * 直接パンする(次の区間の easeSec がパンの遷移時間。src/lib/zoom.ts)。
   */
  zooms?: Zoom[];
  /** 簡易カラー調整(全編一律。区間指定なし)。かかるのはベース映像
   * (画面クロップ+カメラ=同一収録動画)だけで、素材オーバーレイ・
   * 挿入クリップには効かない。 */
  colorFilter?: ColorFilter;
  /** 領域ぼかし(秘匿情報の目隠し)。かかるのはベース映像
   * (画面クロップ)だけで、素材・挿入・テロップは対象外。zoom には追従せず
   * 出力px固定。 */
  blurs?: BlurRegion[];
  /** 注釈グラフィック(矢印/囲み/スポットライト)。画面の一点/矩形を指し示す
   * 「ここを見ろ」の描画。独立レイヤーで最前面(テロップより上)。zoom 非追従の
   * 出力px固定。硬い ON/OFF。 */
  annotations?: Annotation[];
  /** 動画に入れ込む任意テキスト(タイトル・ラベル・字幕以外の文字)。
   * 発話に由来しないのがテロップ(transcript.json)との違い。transcribe が
   * transcript.json を書き直しても消えず、describe / plan からは発話ではなく
   * 演出として分離される。位置は出力px 固定で zoom には追従しない。重なり順は
   * layerOrder の "text" / text<N>、省略時はレイヤースタックの上・注釈より下。
   * トラックは texts[].track(省略時 1)で決まる。 */
  texts?: TextOverlay[];
}

/** 動画に入れ込む任意テキスト1件(overlays.json の texts)。時刻は元収録の秒 */
export interface TextOverlay {
  /** 編集をまたいで安定な永続 id(例 "txt_a1b2c3")。`@id` で人間/AI がこの要素を
   * 指す共通アドレス。省略可=id 未採番。render / 承認 hash には影響しない */
  id?: string;
  /** 演出判断の分類 id。省略可・sticky。描画と承認 hash には影響しない。 */
  reasonId?: string;
  /** 元収録の秒。start < end。挿入・カットの時刻写像はツールが行う */
  start: number;
  end: number;
  /** 表示する文字列。"\n" で改行できる(自動折り返しはしない) */
  text: string;
  /** テキストトラック番号(1始まり)。省略 = 1。重なり順は layerOrder の
   * "text"(1本目)/ text<N>(2本目以降)の位置で決まる */
  track?: number;
  /** 表示位置(出力px)。anchor が座標の意味を決める。必須 */
  pos: CaptionPos;
  /** pos の解釈。省略時 center(テキスト中心)/ topLeft(テキストボックス左上) */
  anchor?: "center" | "topLeft";
  /** 見た目。テロップと同じ CaptionStyle を共有する。karaoke は発話同期の機能
   * なので texts では無視される */
  style?: CaptionStyle;
}

/** 簡易カラー調整(overlays.json の colorFilter)。各キー省略可・既定 1.0
 * (無補正)。CSS filter(brightness/contrast/saturate)として解決する */
export interface ColorFilter {
  brightness?: number;
  contrast?: number;
  saturate?: number;
}

/** ズーム演出1件(overlays.json の zooms)。start/end は元収録の秒 */
export interface Zoom {
  /** 編集をまたいで安定な永続 id(例 "zm_a1b2c3")。`@id` で人間/AI がこの要素を
   * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
   * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
   * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
   * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
   * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
  id?: string;
  /** 演出判断の分類 id(docs/edit-skills/effects/recipes)。省略可・sticky。
   * 描画と承認 hash には影響しない。 */
  reasonId?: string;
  start: number;
  end: number;
  /** 全画面に拡大する矩形(出力px。テロップ pos・overlays rect と同じ座標系)。
   * 拡大率は書かせない(rect の幅から scale = 出力幅 / rect.w が一意に決まる。
   * 倍率と rect の二重指定は矛盾の温床になるため) */
  rect: Region;
  /** 区間の頭でズームインする遷移時間(秒)。
   * 省略時 config.yaml の render.zoom.easeSec(既定 DEFAULT_ZOOM_EASE_SEC)。
   * easeOutSec 省略時は末尾のズームアウトにも同じ秒数を使う。
   * 区間が短いときは遷移を区間の半分へ縮める(wipeFull と同じ規則)。
   * 前の区間と隙間なく接する連鎖では、頭の遷移は等倍からのズームインではなく
   * 前の rect からのパンになる(この easeSec がパンの遷移時間) */
  easeSec?: number;
  /** 区間の末尾でズームアウトする遷移時間(秒)。省略時 easeSec と同じ */
  easeOutSec?: number;
  /** 省略=manual(固定 focus)。"auto"=カーソル追従(cursor サイドカーがあれば
   * 毎フレームカーソルへ、無ければ rect 中心へ劣化)。focusMode を1つでも
   * 持つと render は OpenScreen 逐語の precompute 経路(spring 込み)に
   * 切り替わる。持たない既存収録はバイト等価。
   * §docs/plans/2026-07-24-openscreen-zoom-A-cursor-follow-design.md D0 */
  focusMode?: "manual" | "auto";
  /** ズームの強さ(段階)。1..6 → {1.25,1.5,1.8,2.2,3.5,5.0}(OpenScreen ZOOM_DEPTH_SCALES 逐語)。
   * 省略時は rect の幅から scale=出力幅/rect.w(従来どおり)。customScale が優先。 */
  depth?: 1 | 2 | 3 | 4 | 5 | 6;
  /** 強さの直接指定(1.0–5.0)。depth より優先。指定時 rect は focus(中心)専用になり
   * 拡大率は rect.w からではなくこの値から決まる。省略時は depth→rect の順に解決。 */
  customScale?: number;
}

/** render.zoom.easeSec 未指定時の既定(秒)。renderProps と設定画面で共有 */
export const DEFAULT_ZOOM_EASE_SEC = 0.4;

/** render.zoom.easeInSec/easeOutSec が両方未指定(かつ easeSec も未指定)の
 * ときの既定(秒)。OpenScreen 移植 D3: 入りが出より約1.5倍長い非対称が
 * Screen Studio 級の寄りの体感を作る(§docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md)。
 * easeSec だけを指定した既存収録は対称のまま値を引き継ぐ(この既定は使わない) */
export const DEFAULT_ZOOM_EASE_IN_SEC = 1.5;
export const DEFAULT_ZOOM_EASE_OUT_SEC = 1.0;

/** render.zoom.chainGapSec 未指定時の既定(秒)。隣接ズームどうしの gap が
 * これ以内なら連鎖(パン遷移)とみなす。OpenScreen 移植 D3(#2・D2a)
 * §docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md */
export const DEFAULT_ZOOM_CHAIN_GAP_SEC = 1.5;

/** render.zoom.leadSec 未指定時の既定(秒)。孤立ズームのイーズインを区間
 * 開始のこの秒だけ前から始める(先読み/pre-roll)。OpenScreen 移植 D3
 * (#1・D1c)§docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md */
export const DEFAULT_ZOOM_LEAD_SEC = 0.5;

/** render.zoom.chainPanSec 未指定時の既定(秒)。gap のある連鎖(chainGapSec
 * 以内だが完全隣接ではない)のパン遷移秒数。完全隣接(gap=0)には効かず
 * easeInSec を使う。OpenScreen 移植 D3(#2・D2b)
 * §docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md */
export const DEFAULT_ZOOM_CHAIN_PAN_SEC = 1.0;

/** render.zoom.wipeScale 未指定時の既定。ズーム中のカメラワイプをこの倍率
 * まで右下アンカーで縮める(1 = 縮小なし)。renderProps と設定画面で共有 */
export const DEFAULT_ZOOM_WIPE_SCALE = 0.8;

/** 領域ぼかし1件(overlays.json の blurs)。開発画面の API キー・
 * PII・パスワードなど、ベース映像(画面クロップ)の一部を隠す。start/end は
 * 元収録の秒、rect は出力px({x,y,w,h}。テロップ pos・zooms rect と同座標系)。
 * かかるのはベース映像だけ。zoom には追従せず出力px固定(zoom と時間が重なる
 * と validate が警告する)。 */
export interface BlurRegion {
  /** 編集をまたいで安定な永続 id(例 "bl_a1b2c3")。`@id` で人間/AI がこの要素を
   * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
   * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
   * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
   * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
   * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
  id?: string;
  /** 演出判断の分類 id。省略可・sticky。描画と承認 hash には影響しない。 */
  reasonId?: string;
  start: number;
  end: number;
  /** 隠す矩形(出力px)。画面外へはみ出すと validate がエラーにする */
  rect: Region;
  /** 強度(0〜1)。省略時 0.5。ぼかし半径(出力px)へ写像する
   * (src/lib/blur.ts)。0 は効果なし(描画されない) */
  strength?: number;
  /** 矩形/strength の時間変化。時刻は元収録の秒 */
  keyframes?: Keyframe<BlurKeyframeValues>[];
}

/** BlurRegion.strength 未指定時の既定。renderProps と描画・検査で共有 */
export const DEFAULT_BLUR_STRENGTH = 0.5;

/** 注釈グラフィックの種別。判別子は type。将来 "line" 等を足す場合はここに
 * 1枝追加する(今はスコープ外)。src/types.ts の Annotation union と揃える */
export type AnnotationType = "arrow" | "box" | "spotlight";
export type SpotlightShape = "rect" | "ellipse";

/** 注釈グラフィック(overlays.json の annotations)。画面上の一点/矩形を
 * 指し示して「ここを見ろ」を作る描画プリミティブ。start/end は元収録の秒、
 * 座標はすべて出力px(テロップ pos・zooms/blurs rect と同座標系)。
 * 独立レイヤーで最前面(テロップより上)に描く。zoom には追従せず出力px固定。
 * 遷移は無い硬い ON/OFF。 */
export type Annotation = ArrowAnnotation | BoxAnnotation | SpotlightAnnotation;

interface AnnotationBase {
  /** 編集をまたいで安定な永続 id(例 "ann_a1b2c3")。`@id` で人間/AI がこの要素を
   * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
   * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
   * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
   * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
   * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
  id?: string;
  /** 演出判断の分類 id。省略可・sticky。描画と承認 hash には影響しない。 */
  reasonId?: string;
  /** 元収録の秒。start < end。挿入・カットの時刻写像はツールが行う */
  start: number;
  end: number;
}

/** 矢印。from から to へ引く線 + 矢尻。色・太さ・矢尻サイズは任意上書き */
export interface ArrowAnnotation extends AnnotationBase {
  type: "arrow";
  /** 始点(出力px) */
  from: CaptionPos;
  /** 終点=矢尻の向き先(出力px)。from と同一点は validate がエラー */
  to: CaptionPos;
  /** 線と矢尻の色(CSS カラー)。省略時 DEFAULT_ANNOTATION_COLOR */
  color?: string;
  /** 線の太さ(px)。省略時 DEFAULT_ARROW_WIDTH_PX */
  widthPx?: number;
  /** 矢尻の大きさ(px)。省略時 DEFAULT_ARROW_HEAD_PX */
  headPx?: number;
  /** 位置/サイズの時間変化。時刻は元収録の秒 */
  keyframes?: Keyframe<ArrowKeyframeValues>[];
}

/** 囲み。rect の枠線。任意で塗り(fill)も置ける */
export interface BoxAnnotation extends AnnotationBase {
  type: "box";
  /** 囲む矩形(出力px) */
  rect: Region;
  /** 枠線の色(CSS カラー)。省略時 DEFAULT_ANNOTATION_COLOR */
  color?: string;
  /** 枠線の幅(px)。省略時 DEFAULT_BOX_WIDTH_PX */
  widthPx?: number;
  /** 角丸半径(px)。省略時 DEFAULT_BOX_RADIUS_PX */
  radiusPx?: number;
  /** 塗り色(CSS カラー。半透明の rgba() 推奨)。省略時は塗りなし(枠線だけ) */
  fill?: string;
  /** 矩形/線幅の時間変化。時刻は元収録の秒 */
  keyframes?: Keyframe<BoxKeyframeValues>[];
}

/** スポットライト。rect 以外を暗くして注目を集める */
export interface SpotlightAnnotation extends AnnotationBase {
  type: "spotlight";
  /** 明るく残す矩形(出力px) */
  rect: Region;
  /** 明部の形状。省略時 "rect"("ellipse" で楕円) */
  shape?: SpotlightShape;
  /** 外側の暗さ(0〜1、0=無効・1=真っ黒)。省略時 DEFAULT_SPOTLIGHT_DIM */
  dim?: number;
  /** 縁のぼかし幅(px)。省略時 DEFAULT_SPOTLIGHT_FEATHER_PX */
  featherPx?: number;
  /** shape:"rect" の角丸半径(px)。省略時 0(角丸なし)。ellipse では無視 */
  radiusPx?: number;
  /** 矩形/暗さの時間変化。時刻は元収録の秒 */
  keyframes?: Keyframe<SpotlightKeyframeValues>[];
}

/** 注釈グラフィックの色・太さ・大きさの既定(renderProps が解決に使う) */
export const DEFAULT_ANNOTATION_COLOR = "#ff3b30"; // 鮮やかな赤(注釈の定番)
export const DEFAULT_ARROW_WIDTH_PX = 8;
export const DEFAULT_ARROW_HEAD_PX = 28;
export const DEFAULT_BOX_WIDTH_PX = 6;
export const DEFAULT_BOX_RADIUS_PX = 8;
export const DEFAULT_SPOTLIGHT_DIM = 0.6; // 外側の暗さ(0=無効, 1=真っ黒)
export const DEFAULT_SPOTLIGHT_FEATHER_PX = 24;
export const DEFAULT_SPOTLIGHT_SHAPE: SpotlightShape = "rect";

/** 人間が書く BGM 指定(bgm.json)。ファイルが無ければ、収録フォルダ直下の
 * bgm.mp3 / bgm.m4a / bgm.wav(あれば)を全編1曲として流す従来動作になる。
 * 時刻は他の編集ファイルと同じく元動画(収録ファイル)の秒。
 * JSON Schema: schemas/bgm.schema.json(§5点セット) */
export interface Bgm {
  /** BGM を流す区間。時系列順でなくてよく、覆っていない区間は無音になる
   * (「イントロだけ BGM なし」= その区間を覆わない)。別ファイルの区間を
   * 並べれば曲の切り替え、区間を重ねれば重奏になる。各区間はループ再生 */
  tracks: {
    /** 編集をまたいで安定な永続 id(例 "bg_a1b2c3")。`@id` で人間/AI がこの要素を
     * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
     * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
     * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
     * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
     * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
    id?: string;
    /** この区間の時刻(start/end)が属する時間軸。省略時 "source"。
     *  - "source" … 元収録の秒(従来どおり)。cut に追随して縮み、
     *    挿入をまたぐときは繋がった1本の区間になる
     *  - "output" … 出力(カット後・挿入込み)の秒。元収録に対応時刻が
     *    無い区間(冒頭 intro・末尾 ending・挿入の中)へ BGM を当てるために使う。
     *    cut を編集しても位置は動かない
     *  出力秒は `describe <dir>` の「出力」列や `describe <dir> --json` の
     *  `keeps[].outStart/outEnd`・`inserts[].out` で確認できる */
    timebase?: "source" | "output";
    /** 流し始め(timebase が属する時間軸の秒) */
    start: number;
    /** 流し終わり(timebase が属する時間軸の秒) */
    end: number;
    /** BGM ファイル(収録フォルダからの相対パス。例: bgm.mp3 / materials/outro.mp3) */
    file: string;
    /** 音量(dB)。0=原音量。省略時は config の render.bgm.volumeDb */
    volumeDb?: number;
    /** 頭出し(In点)。ファイル内の再生開始位置(秒)。省略時 0(頭から) */
    startFrom?: number;
    /** フェードイン/アウト(秒)。区間の頭/末尾で音量をなめらかに遷移する。
     *  省略時 0(なし)。区間終端を動画の終端に合わせて fadeOutSec を付けると
     *  従来の終端フェードアウトと同じになる */
    fadeInSec?: number;
    fadeOutSec?: number;
  }[];
}

/** plan が生成(meta.json)。タイトル案と概要欄の下書き。
 * JSON Schema: schemas/meta.schema.json(§5点セット) */
export interface Meta {
  titles: string[];
  description: string;
}

/** 人間/AIが書くサムネイル指定(thumbnail.json)。t は元収録の秒で、
 * frames と違いスナップしない(カットされた瞬間も指定できる。サムネは
 * 動画に入っていない絵も使ってよいため)。
 * JSON Schema: schemas/thumbnail.schema.json(§5点セット) */
export interface Thumbnail {
  t: number;
  texts: ThumbnailText[];
}

export interface ThumbnailText {
  /** 編集をまたいで安定な永続 id(例 "tx_a1b2c3")。`@id` で人間/AI がこの要素を
   * 指す共通アドレス。文法は `<prefix>_<base36 6桁>`(src/lib/ids.ts が単一の出所)。
   * **一度振ったら内容・位置が変わっても不変**(採番は id が無い要素にだけ行う)。
   * 省略可=id 未採番。id が1つも無いプロジェクトは全コマンドが本機能導入前と
   * バイト等価(opt-in・sticky。採番は `id-stamp` / 生成 / GUI 保存が行う)。
   * **render / 承認 hash には一切影響しない**(アドレッシング専用) */
  id?: string;
  text: string;
  /** 表示位置(テキスト中心、出力px)。transcript のテロップと違い省略不可
   * (サムネに「既定の下部中央」は無い) */
  pos: CaptionPos;
  /** 見た目。transcript のテロップと同じ CaptionStyle を共有する
   * (動画と見た目の言語を揃えるため) */
  style?: CaptionStyle;
}

/** apply(検査付きアトミック適用)コマンドの入力パッチ。`@id` 宛先の高水準
 * オペレーション列(ops)と、ファイル単位の全置換(replace)の両方を表す
 * (docs/plans/2026-07-07-atomic-apply-design.md 論点1)。両方あるときは
 * ops を先に適用し、その結果へ replace を重ねる(ファイル単位の上書き)。
 * 書き込みは常に replace 相当の全置換1本へ正規化されてから
 * (src/lib/applyEdits.ts の)コアを1回だけ通る。
 * JSON Schema: schemas/apply-patch.schema.json(§5点セット) */
export interface ApplyPatch {
  ops?: EditOp[];
  replace?: ApplyBody;
}

/** apply が書ける編集ファイルの全置換(SaveRequest 相当)。cutplan.approved は、
 * **apply(planApply)は常にディスク現状の値へ強制上書きする**(apply 経由で
 * 承認を true/false に変えることはできない。§論点6・§不変条件2)。
 * chapters / thumbnail は EditableDocs と違って meta.json を含まない
 * (meta.json は id を持つ要素が無く @id op の対象にならないため、apply の
 * スキーマにも含めない) */
export interface ApplyBody {
  cutplan?: CutPlan;
  transcript?: Transcript;
  overlays?: Overlays;
  chapters?: Chapters;
  /** `null` / 空 tracks は bgm.json を削除する(SaveRequest と同じセマンティクス)。
   * `undefined`(キー無し)は bgm.json を触らない */
  bgm?: Bgm | null;
  thumbnail?: Thumbnail;
}

/** apply の高水準オペレーション(`@id` 宛先。docs/plans/2026-07-07-atomic-apply-design.md
 * 論点1)。`target` は set/remove では既存要素を指す `@id`(Feature 2 の
 * resolveMention が解決)、add では許可済みのコレクション選択子
 * (例 "cutplan.segments"。src/lib/applyEdits.ts の allow-list を参照)。
 * `field` / `path` はドット区切りパス(例 "style.fontSizePx")で、パス末端の
 * 置換のみ(中間の欠落・配列添字はエラー)。`field`/`path`(または add の
 * value)に "approved" を指定するのはエラー(apply では承認を変更できない)。*/
export type EditOp =
  | { op: "set"; target: string; field?: string; path?: string; value: unknown }
  | { op: "remove"; target: string }
  | { op: "add"; target: string; value: Record<string, unknown>; at?: number };

/** 編集後の意図を宣言的に検査する期待値ファイル(assertions.json)。人間/AI が
 * 手で書く「宣言ファイル」で、rules.md / brief.md と同じ第3カテゴリ
 * (EDITABLE_FILES にも GENERATED_FILES にも属さない。src/lib/files.ts は
 * 無変更=`fileRole("assertions.json") === "other"`)。plan/run の再実行でも
 * 上書きされず、収録をまたいで生き残る。判定は `assert <dir>` コマンドが
 * `describe --json`(構造 Tier 1)と `frames --ocr`(視覚 Tier 2・`--visual`
 * のときだけ)の射影と照合して行う(src/stages/assert.ts)。
 * JSON Schema: schemas/assertions.schema.json(§5点セット) */
export interface AssertionsDoc {
  schemaVersion: number;
  assertions: Assertion[];
}

/** アサーションの数値比較演算子(outDuration / keepCount が使う) */
export type AssertOp = "<=" | ">=" | "<" | ">" | "==";

/** 1件の期待値宣言。type で判別されるユニオン(9種)。共通で任意の label?
 * (レポート表示用の作者ラベル。要素の @id とは別物)を持てる。
 * Tier 1(構造。describe --json 射影から。依存ゼロ・数ミリ秒・全環境):
 * outDuration / keepCount / captionVisible / captionText / timeKept /
 * materialExists / noCaptionOverlap。
 * Tier 2(視覚。frames --ocr から。macOS 依存・`assert --visual` のときだけ
 * 評価。既定では skip): screenText / regionClear。
 * ref を取るもの(captionVisible/captionText/materialExists/regionClear)は
 * `@id`(または素の id)で対象を指す。プロジェクトに id が1つも無い(id-stamp
 * 未実行)場合は fail ではなく error になる(docs/plans/2026-07-07-
 * visual-assertions-design.md 論点3) */
export type Assertion =
  | { label?: string; type: "outDuration"; op: AssertOp; value: number }
  | { label?: string; type: "keepCount"; op: AssertOp; value: number }
  | { label?: string; type: "captionVisible"; ref: string; visible?: boolean }
  | { label?: string; type: "captionText"; ref: string; contains?: string; equals?: string }
  | { label?: string; type: "timeKept"; at: number; kept?: boolean }
  | { label?: string; type: "materialExists"; ref: string }
  | { label?: string; type: "noCaptionOverlap"; track?: number }
  // Tier 2(視覚・opt-in。--visual のときだけ評価。既定は skip)
  | { label?: string; type: "screenText"; at: number; contains: string; present?: boolean }
  | { label?: string; type: "regionClear"; ref: string };
