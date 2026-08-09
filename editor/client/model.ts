// タイムライン UI のデータモデル。
// タイムラインの横軸は「カット後の秒」(プレビュー再生と同じ軸)、
// 編集対象の JSON は「元収録の秒」なので、App が両者を変換する。
//
// トラックは Premiere / Final Cut と同じく「動画の基本構成要素」で構成し、
// 上にあるトラックほど前面(z-index が高い)に描画されるものを置く。
// 並びは overlays.json の layerOrder(下→上)で自由に入れ替えられる
// (ベースの映像と BGM は固定)。wipeFull(ワイプ全画面)は独立トラックに
// せず、ワイプレイヤー上の属性スパンとして表現する。字幕を
// 隠したい場合はテロップそのものを削る・縮める(hideCaption は手書き互換)。

import { capNum, ovNum, textNum } from "../../src/types.ts";
import type { AnnotationType, CaptionPos, Interval, LayerId, PlanSegment, Region, SpotlightShape } from "../../src/types.ts";
import type { ScriptSegment } from "./apiTypes.ts";
import type { Hunk } from "../../src/lib/docDiff.ts";
import type { ReviewEvent, ReviewEventKind } from "../../src/lib/reviewEvents.ts";
import type { Manifest } from "../../src/types.ts";

export function videoFileForPreview(manifest: Manifest): string {
  return manifest.layout === "stills" ? "" : "media/proxy.mp4";
}

/** overlays.json のどの配列か(hide 系はエディタ非表示の手書き互換)。
 * "zoom" はズーム演出(overlays.json の zooms)の区間。
 * "blur" は領域ぼかし(overlays.json の blurs)の区間。
 * "annotation" は注釈グラフィック(overlays.json の annotations)の区間。
 * "text" は動画内テキスト(overlays.json の texts)の区間 */
export type SpanKind =
  | "overlays"
  | "wipeFull"
  | "hideCaption"
  | "zoom"
  | "blur"
  | "annotation"
  | "text";

/** トラックの空き領域ドラッグで作れる区間の種類 */
export type AddKind =
  | "overlays"
  | "wipeFull"
  | "caption"
  | "bgm"
  | "zoom"
  | "blur"
  | "annotation"
  | "text";

/** 選択・ドラッグの対象。index は各ドキュメントの配列の添字
 * (caption は transcript.segments、insert は overlays.inserts の添字、
 * zoom は overlays.zooms の添字、blur は overlays.blurs の添字、
 * annotation は overlays.annotations の添字)。
 * captionTrack だけは例外で、index は**配列の添字ではなくテロップトラック番号**
 * (1始まり。overlays.json の captionTracks[].track と同じ値)。クリップではなく
 * トラックそのものを選んだ状態=インスペクタがそのトラックの標準デザインを編集する。
 * wipe はトラック設定として選択・編集可能。bgm は表示専用 */
export type SelKind =
  | "cut"
  | "insert"
  | "caption"
  | "captionTrack"
  | "overlays"
  | "wipeFull"
  | "wipe"
  | "bgm"
  | "zoom"
  | "blur"
  | "annotation"
  | "text";
export type Selection = { kind: SelKind; index: number } | null;

export type DragMode = "move" | "trim-start" | "trim-end";

/** 音声を持つ固定トラック(映像・BGM)。ラベルにミュートボタンを出す */
export type AudioTrackId = "cut" | "bgm";

export type TrackId =
  | "caption"
  | "wipe"
  | "zoom"
  | "blur"
  | "annotation"
  | "text"
  | "cut"
  | "bgm"
  | `ov${number}`
  | `cap${number}`
  | `text${number}`;

export interface TrackDef {
  id: TrackId;
  label: string;
  /** 空き領域のドラッグで区間を作れるトラックはその作成先 */
  createKind?: AddKind;
  hint?: string;
  /** ラベルの上下ドラッグで重なり順(overlays.json の layerOrder)を変えられる */
  reorderable?: boolean;
  /** 音声トラック(映像・BGM)。ラベルにプレビューミュートのボタンを出す */
  audio?: AudioTrackId;
  /** 重ね合わせレイヤー(ワイプ・素材・テロップ)。ラベルに
   * プレビュー専用の目トグル(一時非表示)を出す */
  layer?: LayerId;
  /** テロップトラック番号(ダブルクリックでトラック名を変更できる) */
  renamableCaption?: number;
}

const REORDER_HINT = "ラベルを上下にドラッグで重なり順を変更";
const TRACK_DEFS = {
  wipe: {
    id: "wipe", label: "ワイプ", createKind: "wipeFull", reorderable: true, layer: "wipe",
    hint: `ドラッグで全画面区間を作成。${REORDER_HINT}`,
  },
  zoom: {
    id: "zoom", label: "ズーム", createKind: "zoom",
    hint:
      "画面の一部を拡大して見せる区間(overlays.json の zooms)。" +
      "ドラッグで区間を作成。かかるのはベース映像の背景だけで、" +
      "ワイプ・テロップ・素材は動かない",
  },
  blur: {
    id: "blur", label: "ぼかし", createKind: "blur",
    hint:
      "領域ぼかし区間(overlays.json の blurs)。秘匿情報の目隠し。" +
      "ドラッグで区間を作成。かかるのはベース映像だけで、ズームには追従せず" +
      "出力px固定",
  },
  annotation: {
    id: "annotation", label: "注釈", createKind: "annotation",
    hint:
      "注釈グラフィック区間(overlays.json の annotations)。矢印・囲み・" +
      "スポットライトで「ここを見ろ」を示す。ドラッグで区間を作成(既定は囲み)。" +
      "最前面(テロップより上)・ズームには追従せず出力px固定",
  },
  text: {
    id: "text", label: "テキスト", createKind: "text", reorderable: true, layer: "text",
    hint:
      "動画内テキスト(overlays.json の texts)。タイトル・ラベルなど発話に由来しない文字。" +
      `ダブルクリックで文言を編集。${REORDER_HINT}`,
  },
  cut: {
    id: "cut", label: "映像", audio: "cut",
    hint:
      "画面+マイク。keep 区間の移動・トリム(最下層固定)。" +
      "ファイルをドロップするとその位置にインサート(後続が後ろへズレる)",
  },
  bgm: {
    id: "bgm", label: "BGM", audio: "bgm", createKind: "bgm",
    hint:
      "BGM 区間(bgm.json)。区間の端をドラッグで削り(イントロ無音など)、" +
      "本体をドラッグで移動。空きをドラッグで区間作成、音声/動画ファイルを" +
      "ドロップで追加。区間を並べれば曲の切り替え・重ねれば重奏。覆っていない" +
      "時間は無音(bgm.json が無ければ収録フォルダ直下の bgm.* を全編で流す)",
  },
} satisfies Partial<Record<TrackId, TrackDef>>;

/** 素材トラック(V1, V2, ... 可変個数)の定義 */
const materialTrackDef = (n: number): TrackDef => ({
  id: `ov${n}`,
  label: `素材 V${n}`,
  createKind: "overlays",
  reorderable: true,
  layer: `ov${n}`,
  hint:
    `素材トラック。空きをドラッグで区間作成、ファイルをドロップで追加。` +
    `クリップは上下ドラッグで別の素材トラックへ。${REORDER_HINT}`,
});

/** テロップトラック(T1, T2, ... 可変個数)の定義。1本目の id は従来互換の
 * "caption"。表示位置・スタイルは全トラック共通(重なり順だけが違う)。
 * name は overlays.json の captionTracks に付けた任意のトラック名 */
const captionTrackDef = (n: number, count: number, name?: string): TrackDef => ({
  id: n === 1 ? "caption" : `cap${n}`,
  label: name ?? (count > 1 ? `テロップ T${n}` : "テロップ"),
  createKind: "caption",
  reorderable: true,
  layer: n === 1 ? "caption" : `cap${n}`,
  renamableCaption: n,
  hint:
    `ドラッグで追加、選択して文言を編集。ラベルのダブルクリックで名前を変更。` +
    (count > 1 ? `クリップは上下ドラッグで別のテロップトラックへ。` : "") +
    REORDER_HINT,
});

/** テキストトラック(1本目 "text", 2本目以降 text<N>)の定義。
 * ラベルは番号だけ(テロップの "T2" と紛らわしくしない)。
 * 名前の変更は持たない(v1 のスコープ外) */
const textTrackDef = (n: number, count: number): TrackDef => ({
  id: n === 1 ? "text" : `text${n}`,
  label: count > 1 ? `テキスト ${n}` : "テキスト",
  createKind: "text",
  reorderable: true,
  layer: n === 1 ? "text" : `text${n}`,
  hint:
    `動画内テキスト(overlays.json の texts)。タイトル・ラベルなど発話に` +
    `由来しない文字。ダブルクリックで文言を編集。` +
    (count > 1 ? `クリップは上下ドラッグで別のテキストトラックへ。` : "") +
    REORDER_HINT,
});

/** 表示順(上=前面)。layerOrder(下→上)を逆順に並べ、
 * ベースの映像と BGM は最下段に固定する。
 * capName はテロップトラック名の解決(overlays.json の captionTracks) */
export const buildTracks = (
  layerOrder: LayerId[],
  capName?: (n: number) => string | undefined,
): TrackDef[] => {
  const capCount = layerOrder.filter((id) => capNum(id) !== null).length;
  const textCount = layerOrder.filter((id) => textNum(id) !== null).length;
  const hasTextLayer = textCount > 0;
  return [
    ...[...layerOrder].reverse().map((id) => {
      const n = ovNum(id);
      if (n !== null) return materialTrackDef(n);
      const cn = capNum(id);
      if (cn !== null) return captionTrackDef(cn, capCount, capName?.(cn));
      const tn = textNum(id);
      if (tn !== null) return textTrackDef(tn, textCount);
      return TRACK_DEFS[id as keyof typeof TRACK_DEFS];
    }),
    TRACK_DEFS.zoom,
    TRACK_DEFS.blur,
    TRACK_DEFS.annotation,
    ...(hasTextLayer ? [] : [TRACK_DEFS.text]),
    TRACK_DEFS.cut,
    TRACK_DEFS.bgm,
  ];
};

/** annotation の部分更新パッチ(App の updateAnnotation / Inspector の
 * type 切替・見た目編集で使う緩い union)。delete-undefined 機構
 * (undefined を渡すとキー削除)に type 切替も乗せるため、各 union
 * メンバーのフィールドを全部緩く持たせる */
export type AnnotationPatch = {
  type?: AnnotationType;
  start?: number;
  end?: number;
  from?: CaptionPos;
  to?: CaptionPos;
  rect?: Region;
  color?: string;
  fill?: string;
  widthPx?: number;
  headPx?: number;
  radiusPx?: number;
  featherPx?: number;
  dim?: number;
  shape?: SpotlightShape;
};

/** タイムラインの1行の高さ(px)。旧保存値・互換用の既定値 */
export const ROW_H = 26;

/** OpenCut classic の型別トラック行高(px)。apps/web/src/timeline/components/layout.ts */
export const TRACK_H = { video: 65, audio: 50, text: 25, effect: 25 } as const;

/** トラック id → 既定の行高(px)。素材/映像=video, bgm=audio, テロップ=text, 演出=effect */
export const trackHeightFor = (id: TrackId): number => {
  if (id === "cut" || ovNum(id) !== null) return TRACK_H.video;
  if (id === "bgm") return TRACK_H.audio;
  if (id === "caption" || capNum(id) !== null) return TRACK_H.text;
  return TRACK_H.effect;
};

/** 素材パネル → タイムラインへのドラッグで使う dataTransfer の型
 * (値はプロジェクト相対パス "materials/..."。OS のファイルドロップと区別する) */
export const MATERIAL_MIME = "application/x-framewright-material";

/** ステッカー/エフェクト タブのプリセット → タイムラインへのドラッグで使う
 * dataTransfer の型(値は presets.ts の EditorPreset.id)。MATERIAL_MIME と
 * 同じ語彙だが別 MIME にして、onDropTimeline が素材ドロップの分岐(音声=BGM
 * ヒューリスティック等)と混ざらないようにする */
export const PRESET_MIME = "application/x-framewright-preset";

/** 映像トラックの継ぎ目に出す「カットされた区間」の印。index は
 * cutplan.segments の添字(選択はクリップと同じ kind "cut" を使い回す)。
 * out = 継ぎ目のカット後秒。stack = 同じ継ぎ目に複数の記録があるときの
 * 横ずらし段数(両方掴めるように) */
export interface CutMark {
  index: number;
  out: number;
  durSec: number;
  reason: string;
  stack: number;
}

/** タイムラインに置かれる1ブロック。カットをまたぐ区間は複数に割れるので
 * 同じ kind/index のクリップが複数できることがある */
export interface Clip {
  kind: SelKind;
  index: number;
  track: TrackId;
  /** カット後の秒 */
  outStart: number;
  outEnd: number;
  label?: string;
  /** insert 素材の種別。cut トラック上で動画/静止画を見分ける表示にだけ使う */
  mediaKind?: "video" | "image";
  /** false は選択・ドラッグ不可 */
  editable: boolean;
  /** 背景レイヤー表示(ワイプ本体・BGM)。ポインタも素通しする */
  static?: boolean;
  /** 左端トリム不可(挿入クリップのアンカー / カットで割れた継ぎ目の辺) */
  noTrimStart?: boolean;
  /** 右端トリム不可(カットで割れた継ぎ目の辺。本当の端だけを掴ませる) */
  noTrimEnd?: boolean;
  /** クリップに描く音声波形。src = ピークの取得元("" はマイク音声、
   * それ以外は素材・BGM の相対パス)。startSec = クリップ先頭に対応する
   * 音声内の秒(クリップ内は連続な前提)。loop = ファイル末尾で先頭へ
   * 戻って描く(BGM はループ合成されるため)。
   * 合成で音が出ないもの(ワイプ)には付けない。素材トラックは無音
   * (volume 省略時 0)なら付けないが、volume > 0 の動画素材は最終ミックスに
   * 音が乗るため波形を付ける */
  wave?: { src: string; startSec: number; loop?: boolean };
  /** 映像トラックに描くフィルムストリップ。cut(keep)クリップにだけ付く。
   * srcStart = クリップ先頭に対応する元収録の秒、speed = この keep の再生倍率。
   * クリップ内の出力オフセット d 秒に対応する元収録の秒は srcStart + d * speed。
   * insert クリップには付けない(素材自身の映像であって元収録ではないため) */
  film?: { srcStart: number; speed: number };
}

/** 元収録の秒で表す区間(ズーム・ぼかし等の共通部分) */
export interface TimeSpan {
  start: number;
  end: number;
}

/**
 * 元収録秒を keep 区間へ寄せる。cut 内なら直後の keep の先頭、最後の
 * keep より後ろならその末尾へ寄せる。エディタ上で insert のアンカーを
 * ドラッグしたときに、見た目上動かない cut 内の死に領域を作らないための
 * UI 都合の写像であり、render の timeline 写像とは分けておく。
 */
export function snapToKeep(srcSec: number, keeps: readonly Interval[]): number {
  if (keeps.length === 0) return srcSec;
  for (const keep of keeps) {
    if (srcSec < keep.start) return keep.start;
    if (srcSec <= keep.end) return srcSec;
  }
  return keeps[keeps.length - 1].end;
}

/** 配列順が再生順になる同一 at の insert について、交換相手の添字を返す。 */
export function sameAtInsertNeighbor(
  inserts: readonly { at: number }[],
  index: number,
  direction: "before" | "after",
): number | null {
  const selected = inserts[index];
  if (!selected) return null;
  const step = direction === "before" ? -1 : 1;
  for (let i = index + step; i >= 0 && i < inserts.length; i += step) {
    if (inserts[i].at === selected.at) return i;
  }
  return null;
}

/* ---------------- スクリプトタブの範囲カット/復元 ----------------
 * 文字ベース編集: スクリプト(元収録の全文文字起こし)で選択した語の範囲
 * [start,end](元収録の秒)を cutplan の keep 集合から抜く/戻す。
 * どちらも cutplan.segments の純関数(App が pushHistory と setCutplan を巻く)。
 * 分割の id 規約は splitAtPlayhead と同じ「左が元 id を保持・右は新規要素」。 */

export const SCRIPT_CUT_REASON = "スクリプトで削除";
export const SCRIPT_RESTORE_REASON = "スクリプトで復元";

/** スクリプト表示のまとまり(段落ブロック)の分割パラメータ。
 * whisper の segment はテロップ1枚程度で細かすぎるので、keep 後の尺と
 * 表示文字数で「話している一まとまり」へ束ねて表示する */
export const SCRIPT_BLOCK = {
  /** ブロックの上限尺(これを超える連結はしない) */
  maxSec: 30,
  /** raw 側に大量のリテイクがある場合も段落を長大にしない表示文字数上限。
   * 超える直前の whisper 発話境界で折る */
  maxChars: 150,
  /** これ以上の尺が溜まっていたら、小さな間(softGapSec)でも区切る */
  minSec: 15,
  softGapSec: 0.8,
  /** これ以上の無音は尺に関係なく段落境界(リテイク・場面転換) */
  hardGapSec: 2.5,
  /** これ以上の発話の切れ目は「間チップ」として表示する(無音・
   * 文字起こしに残らなかったフィラーの可視化) */
  gapItemSec: 0.5,
} as const;

/** 語が「残っている」と判定する keep との最小重なり秒。whisper の語タイム
 * スタンプは端で数百 ms ずれるため、中点判定だと無音詰めで端を削られた
 * 語尾・助詞が大量に偽の取り消し線になる(実測: keep 内の文に混ざる誤判定の
 * ほぼ全て)。実時間の重なりで判定すれば「一部でも音が残る語」は生き、
 * スクリプトからのカット(語境界ちょうどの cut)は重なり 0 で正しく消える */
export const SCRIPT_KEPT_MIN_OVERLAP = 0.02;

/** keep 間の穴(カット・トリム痕)がこの幅未満なら「実質連続」とみなして
 * 橋渡しする。息継ぎの無音詰め・境界トリム・LLM の微小トリム(実測 0.2〜0.26s の
 * 「末尾の重複」等)は聴感上「言葉が消えた」にならないのに、語の途中を貫通して
 * 音節単位の取り消し線を出すため(実例: ハ~~ッ~~シュ)。スクリプトからの
 * カットは幅に関係なく橋渡ししない(消した語が即取り消し線になる
 * フィードバックを守る) */
export const SCRIPT_BRIDGE_MAX_SEC = 0.35;

/** 語の区間がこの割合以上「実測無音」(cuts.auto.json の silences)に沈んで
 * いたら、その語タイムスタンプは虚構とみなす。whisper は発話前後のポーズに
 * トークンを等幅で塗り広げることがあり(実測: 幅 0.51s が機械的に並ぶ)、
 * 語は実際には隣の keep の中で発話されている。虚構の語は幾何判定せず、
 * 時間的に最寄りの「実在語」(音のある語)の取り消し状態を継承する */
export const SCRIPT_FICTION_SILENCE_RATIO = 0.5;

/** keep 間の穴(カットされている時間)がこの幅以上のときだけ「意図的な
 * 内容カット」として語の取り消し線の対象にする。それ未満の穴は言い淀み
 * トリム・境界の微修整とみなし、中に落ちた語を打ち消さない(=文は生きて
 * いる扱いで吸収)。whisper の語タイムスタンプは文中でも数百 ms ずれるため、
 * 小さな穴の中の語は「その語が消えた」証拠にならない(実測: 偽の取り消し
 * 線の穴は 0.36〜1.04s、本物のリテイクカットは 1.9〜5.25s で分離できる)。
 * スクリプトタブからのカットはこの吸収の対象外(幅に関係なく即取り消し線) */
export const SCRIPT_REAL_CUT_MIN_SEC = 1.5;

/**
 * keep 集合の実効版: SCRIPT_BRIDGE_MAX_SEC 未満の穴を連続へ均す。
 * noBridgeSpans(スクリプトからのカット記録)が覆う穴は橋渡ししない。
 * keeps は時系列・重なりなし前提(返り値も同じ)
 */
export function bridgeKeeps(
  keeps: readonly Interval[],
  noBridgeSpans: readonly Interval[],
  maxHoleSec: number,
): Interval[] {
  const out: Interval[] = [];
  for (const k of keeps) {
    const last = out[out.length - 1];
    if (last) {
      const holeStart = last.end;
      const holeEnd = k.start;
      const blocked = noBridgeSpans.some((s) => s.start < holeEnd && s.end > holeStart);
      if (holeEnd - holeStart < maxHoleSec && !blocked) {
        last.end = Math.max(last.end, k.end);
        continue;
      }
    }
    out.push({ start: k.start, end: k.end });
  }
  return out;
}

/**
 * ブロック内全要素の「keep に残っているか」(取り消し線の反転)を判定する。
 * 3層の決定論ルール(いずれも whisper の語タイムスタンプの既知の嘘への対処。
 * 判定材料はすべて手元の実測データで、LLM は使わない):
 * 1. 実効 keep(微小穴を橋渡し)との実時間の重なりが閾値超 → 残っている
 * 2. 重ならない語でも、区間の過半が実測無音に沈む「虚構語」は、時間的に
 *    最寄りの実在語(音のある word)の状態を継承する(ポーズに塗り
 *    広げられた語は隣の発話に属する)
 * 3. それ以外(音があるのに keep と重ならない)= 本当にカットされた発話
 * silences が無い(detect 未実行)場合は 2 を飛ばして 1/3 だけで判定する。
 *
 * aligned = true(words の時刻が DTW で音響に固定済み)のときは補正
 * ヒューリスティクス(2 の虚構語継承と、小穴への吸収)を使わない:
 * 時刻が正確なら幾何判定だけが最も正確で、吸収は逆に本物の小さなカットを
 * 隠す誤りになる(橋渡しとスクリプトカットの優先だけは残す=カット境界が
 * 語の音節を貫くときに半端な取り消し線を出さないため)
 */
export function scriptKeptFlags(
  blocks: readonly ScriptBlock[],
  keeps: readonly Interval[],
  silences: readonly Interval[] | null | undefined,
  noBridgeSpans: readonly Interval[],
  aligned = false,
): boolean[][] {
  const eff = bridgeKeeps(keeps, noBridgeSpans, SCRIPT_BRIDGE_MAX_SEC);
  const sil = silences && silences.length > 0 ? silences : null;
  interface Slot {
    start: number;
    end: number;
    kept: boolean;
    fictional: boolean;
    isWord: boolean;
    utterance?: number;
    scriptCut: boolean;
    /** 連続する虚構語のかたまり番号(虚構語のみ) */
    run: number;
  }
  /** t を含む keep 間の穴の幅(keep の内側は 0)。最初の keep の前・最後の
   * keep の後は無限大=常に「意図的カット」側に倒れる */
  const holeWidthAt = (t: number): number => {
    let lo = 0;
    let hi = eff.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (eff[m].end > t) hi = m;
      else lo = m + 1;
    }
    const next = eff[lo];
    if (next && next.start <= t) return 0; // keep の内側
    const prevEnd = lo > 0 ? eff[lo - 1].end : Number.NEGATIVE_INFINITY;
    const nextStart = next ? next.start : Number.POSITIVE_INFINITY;
    return nextStart - prevEnd;
  };
  const slots: Slot[] = [];
  for (const b of blocks) {
    for (const it of b.items) {
      const width = it.end - it.start;
      const isWord = it.kind === "word";
      // スクリプトタブから明示的に消した語は吸収・継承の対象外で常に取り消し
      const scriptCut =
        isWord &&
        width > 0 &&
        overlapWithKeeps(it.start, it.end, noBridgeSpans) > width / 2;
      // 閾値は語幅の半分を上限にする(DTW のゼロ幅丸めで 10ms 程度になった
      // 語は固定 0.02s を物理的に超えられず、keep の真ん中でも偽打消になる)
      const minOv = Math.min(SCRIPT_KEPT_MIN_OVERLAP, Math.max(0.005, width / 2));
      let kept = !scriptCut && overlapWithKeeps(it.start, it.end, eff) > minOv;
      let fictional = false;
      if (!scriptCut && !kept && isWord && !aligned) {
        if (holeWidthAt((it.start + it.end) / 2) < SCRIPT_REAL_CUT_MIN_SEC) {
          // 小さな穴(言い淀みトリム・境界の微修整)に落ちた語は「文が生きて
          // いる」扱いで吸収する(語タイムスタンプのズレはこの語が消えた
          // 証拠にならない。§SCRIPT_REAL_CUT_MIN_SEC)。間チップは対象外
          // (ポーズが縮められた事実は正直に取り消しで見せる)
          kept = true;
        } else {
          fictional =
            sil !== null &&
            width > 0 &&
            overlapWithKeeps(it.start, it.end, sil) >= width * SCRIPT_FICTION_SILENCE_RATIO;
        }
      }
      slots.push({
        start: it.start,
        end: it.end,
        kept,
        fictional,
        isWord,
        ...(it.kind === "word" && it.utterance !== undefined
          ? { utterance: it.utterance }
          : {}),
        scriptCut,
        run: -1,
      });
    }
  }
  // 虚構語は語単位ではなく「連続する虚構語のかたまり」単位で最寄りの実在語へ
  // 寄せる(語単位だと「まだ|まだ」のような連続スミアの前半だけが手前の
  // リテイクへ割れる)。間チップはかたまりを切らない(実在語だけが区切り)
  const words = slots.filter((s) => s.isWord);
  const anchors = words.filter((s) => !s.fictional);
  const runs: { first: Slot; last: Slot; kept: boolean }[] = [];
  let prevWord: Slot | null = null;
  for (const s of words) {
    if (s.fictional) {
      const cur = runs[runs.length - 1];
      // 直前の word も虚構ならかたまりを連結(実在語だけが区切り)
      if (cur && prevWord === cur.last) {
        cur.last = s;
        s.run = runs.length - 1;
      } else {
        runs.push({ first: s, last: s, kept: s.kept });
        s.run = runs.length - 1;
      }
    }
    prevWord = s;
  }
  for (const r of runs) {
    if (anchors.length === 0) break; // アンカー皆無なら幾何判定のまま
    let lo = 0;
    let hi = anchors.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (anchors[m].start > r.first.start) hi = m;
      else lo = m + 1;
    }
    const prev = anchors[lo - 1];
    const next = anchors[lo];
    if (!prev) r.kept = next.kept;
    else if (!next) r.kept = prev.kept;
    else {
      const prevGap = Math.max(0, r.first.start - prev.end);
      const nextGap = Math.max(0, next.start - r.last.end);
      // ほぼ同着(whisper のトークンはポーズ全体を隙間なく敷き詰めるので、
      // かたまりが両側のアンカーに密着して距離で決められないことがある)は
      // 「残っている」側へ倒す。体感で重い誤りは「鳴っているのに取り消し線」
      // の側で、逆(消えた語を生かして見せる)は軽微なため
      r.kept =
        Math.abs(prevGap - nextGap) <= 0.05
          ? prev.kept || next.kept
          : prevGap < nextGap
            ? prev.kept
            : next.kept;
    }
  }

  // 既存 cutplan の境界は発話の途中を横切ることがあり、語ごとの幾何判定を
  // そのまま描くと「何~~でカットされたの~~か」のように、一つのセリフが
  // 細切れの取り消し線になる。元の whisper segment ごとに多数側へそろえ、
  // 同じ発話は一つの読みやすい状態で表示する。スクリプトタブから明示的に
  // 消した語がある発話はこの丸めをせず、選んだ語だけが即座に取り消される。
  const utterances = new Map<number, Slot[]>();
  for (const slot of slots) {
    if (!slot.isWord || slot.utterance === undefined) continue;
    const group = utterances.get(slot.utterance) ?? [];
    group.push(slot);
    utterances.set(slot.utterance, group);
  }
  for (const group of utterances.values()) {
    if (group.some((slot) => slot.scriptCut)) continue;
    const keptCount = group.filter((slot) =>
      slot.fictional && slot.run >= 0 ? runs[slot.run].kept : slot.kept
    ).length;
    // 同数なら「聞こえるのに取り消される」誤表示を避ける側へ倒す。
    const utteranceKept = keptCount * 2 >= group.length;
    for (const slot of group) {
      slot.kept = utteranceKept;
      slot.fictional = false;
    }
  }
  const flags: boolean[][] = [];
  let i = 0;
  for (const b of blocks) {
    flags.push(
      b.items.map(() => {
        const s = slots[i++];
        return s.fictional && s.run >= 0 ? runs[s.run].kept : s.kept;
      }),
    );
  }
  return flags;
}

/** スクリプトブロック内の1要素。word = whisper の語(トークン)、
 * gap = 発話の切れ目(無音・未転写のフィラー等。text は持たない)。
 * どちらも元収録の秒の区間で、選択・カット・カラオケ・シークは同じに扱う */
export type ScriptItem =
  | {
      kind: "word";
      text: string;
      start: number;
      end: number;
      /** 元の whisper segment。既存 cut の表示を発話単位へそろえるために使う */
      utterance?: number;
      /** 同じ表示ブロック内の直前の発話との間に半角スペースを置く */
      leadingSpace?: boolean;
    }
  | { kind: "gap"; start: number; end: number };

/** スクリプト表示の1ブロック(15〜30秒の話のまとまり) */
export interface ScriptBlock {
  start: number;
  end: number;
  items: ScriptItem[];
}

/** 区間 [start,end] と keep 集合(時系列・重なりなし)の重なり秒 */
export function overlapWithKeeps(
  start: number,
  end: number,
  keeps: readonly Interval[],
): number {
  // 最初に end > start になりうる keep を二分探索してから前方走査
  let lo = 0;
  let hi = keeps.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (keeps[m].end > start) hi = m;
    else lo = m + 1;
  }
  let sum = 0;
  for (let i = lo; i < keeps.length && keeps[i].start < end; i++) {
    sum += Math.max(0, Math.min(end, keeps[i].end) - Math.max(start, keeps[i].start));
  }
  return sum;
}

/**
 * /api/script の segments を表示用ブロックへ束ねる。
 * - words の無い文は文全体を1語として扱う(選択粒度が文単位になるだけ)
 * - 発話の切れ目(gapItemSec 以上)は gap 要素として差し込む。ブロックの
 *   先頭にも直前ブロックからの切れ目を付ける(カットされた間・フィラーが
 *   スクリプト上で見え、選択して復元/カットもできる)
 * - 区切りは「maxSec 超過」「hardGapSec 以上の無音」「minSec 以上溜まった
 *   状態での softGapSec 以上の無音」のいずれか
 */
export function buildScriptBlocks(
  segments: readonly ScriptSegment[],
  keeps?: readonly Interval[],
): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  let cur: ScriptBlock | null = null;
  let curChars = 0;
  let prevEnd = 0; // 直前の発話の終わり(先頭は収録開始 0 秒から)
  /** keeps が渡されたエディタ表示では、raw のリテイクやカットを30秒へ
   * 数えない。これにより最終的に連続して聞こえる説明文を同じ段落に保つ */
  const visibleDuration = (start: number, end: number): number =>
    keeps === undefined ? Math.max(0, end - start) : overlapWithKeeps(start, end, keeps);
  for (let utterance = 0; utterance < segments.length; utterance++) {
    const seg = segments[utterance];
    const rawGap = seg.start - prevEnd;
    const visibleGap = visibleDuration(prevEnd, seg.start);
    const shouldBreak =
      cur !== null &&
      ((curChars > 0 && curChars + seg.text.length > SCRIPT_BLOCK.maxChars) ||
        visibleDuration(cur.start, seg.end) > SCRIPT_BLOCK.maxSec ||
        visibleGap >= SCRIPT_BLOCK.hardGapSec ||
        (visibleDuration(cur.start, prevEnd) >= SCRIPT_BLOCK.minSec &&
          visibleGap >= SCRIPT_BLOCK.softGapSec));
    if (cur === null || shouldBreak) {
      if (cur !== null) blocks.push(cur);
      cur = { start: seg.start, end: seg.start, items: [] };
      curChars = 0;
    }
    if (rawGap >= SCRIPT_BLOCK.gapItemSec) {
      // 切れ目はブロック先頭なら「直前ブロックとの間」、途中なら「文間の間」
      cur.items.push({ kind: "gap", start: prevEnd, end: seg.start });
      if (cur.items.length === 1) cur.start = prevEnd;
    }
    const leadingSpace = cur.items.some((item) => item.kind === "word");
    const words =
      seg.words && seg.words.length > 0
        ? seg.words
        : [{ text: seg.text, start: seg.start, end: seg.end }];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      cur.items.push({
        kind: "word",
        text: w.text,
        start: w.start,
        end: w.end,
        utterance,
        ...(leadingSpace && i === 0 ? { leadingSpace: true } : {}),
      });
    }
    cur.end = seg.end;
    curChars += seg.text.length;
    prevEnd = seg.end;
  }
  if (cur !== null) blocks.push(cur);
  return blocks;
}

/** ok: false の reason。noop = 変更なし(範囲が既にカット済み/復元済みなど)、
 * empty = 実行すると keep が1つも残らない(validate エラーになるので拒否) */
export type ScriptRangeResult =
  | { ok: true; segments: PlanSegment[] }
  | { ok: false; reason: "noop" | "empty" };

/**
 * 範囲 [span.start, span.end] を keep から抜いて cut 記録にする。範囲に掛かる
 * keep は端をトリムし、丸ごと入る keep は cut へ倒す(このときだけ id を
 * cut 記録が引き継ぐ=既存の cutKeepSeg の flip と同じ扱い)。minSpan 未満の
 * keep の切れ端は残さず cut 側へ吸収する(micro-keep で validate が煩くなる
 * のを避ける)。cut 記録は削除せず残す=いつでも復元できる可逆編集
 */
export function cutSourceRange(
  segments: readonly PlanSegment[],
  span: TimeSpan,
  minSpan: number,
): ScriptRangeResult {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const a = r2(span.start);
  const b = r2(span.end);
  if (b - a < minSpan) return { ok: false, reason: "noop" };
  const next: PlanSegment[] = [];
  let touched = false;
  let keepLeft = 0;
  for (const s of segments) {
    const ovA = Math.max(a, s.start);
    const ovB = Math.min(b, s.end);
    if (s.action !== "keep" || ovB - ovA < minSpan) {
      if (s.action === "keep") keepLeft++;
      next.push(s);
      continue;
    }
    touched = true;
    const headOk = ovA - s.start >= minSpan;
    const tailOk = s.end - ovB >= minSpan;
    if (headOk) {
      next.push({ ...s, end: r2(ovA) });
      keepLeft++;
    }
    const cut: PlanSegment = {
      start: r2(headOk ? ovA : s.start),
      end: r2(tailOk ? ovB : s.end),
      action: "cut",
      reason: SCRIPT_CUT_REASON,
    };
    // speed は keep 専用フィールドなので cut 記録へは持ち越さない
    if (!headOk && !tailOk && s.id !== undefined) cut.id = s.id;
    next.push(cut);
    if (tailOk) {
      // 頭側が残っていれば右は新規要素(id は左が保持)。頭側が吸収されて
      // 尾側だけ残るときは「同じ keep のトリム」なので id を保つ
      next.push({ ...s, start: r2(ovB), ...(headOk ? { id: undefined } : {}) });
      keepLeft++;
    }
  }
  if (!touched) return { ok: false, reason: "noop" };
  if (keepLeft === 0) return { ok: false, reason: "empty" };
  return { ok: true, segments: next };
}

/**
 * 範囲 [span.start, span.end] を keep に戻す。既存 keep と重なる部分を除いた
 * 「隙間」だけを新しい keep として追加し(既存 keep とは重ならない=validate の
 * 不変条件を保つ)、その隙間に掛かる cut 記録は切り詰める(復元済みの記録を
 * 残さない)。返す segments は時系列順へ並べ直す
 */
export function restoreSourceRange(
  segments: readonly PlanSegment[],
  span: TimeSpan,
  minSpan: number,
): ScriptRangeResult {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const a = r2(span.start);
  const b = r2(span.end);
  if (b - a < minSpan) return { ok: false, reason: "noop" };
  const keeps = segments
    .filter((s) => s.action === "keep")
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((x, y) => x.start - y.start);
  const gaps: TimeSpan[] = [];
  let cur = a;
  for (const k of keeps) {
    if (k.end <= cur) continue;
    if (k.start >= b) break;
    if (k.start - cur >= minSpan) gaps.push({ start: r2(cur), end: r2(k.start) });
    cur = Math.max(cur, k.end);
    if (cur >= b) break;
  }
  if (cur < b && b - cur >= minSpan) gaps.push({ start: r2(cur), end: r2(b) });
  if (gaps.length === 0) return { ok: false, reason: "noop" };
  const next: PlanSegment[] = [];
  for (const s of segments) {
    if (s.action !== "cut") {
      next.push(s);
      continue;
    }
    // 復元される隙間を cut 記録から引き、残った部分だけを記録として保つ
    let pieces: TimeSpan[] = [{ start: s.start, end: s.end }];
    for (const g of gaps) {
      const acc: TimeSpan[] = [];
      for (const p of pieces) {
        if (g.end <= p.start || g.start >= p.end) {
          acc.push(p);
          continue;
        }
        if (g.start - p.start >= minSpan) acc.push({ start: p.start, end: r2(g.start) });
        if (p.end - g.end >= minSpan) acc.push({ start: r2(g.end), end: p.end });
      }
      pieces = acc;
    }
    pieces.forEach((p, i) => {
      next.push(
        i === 0
          ? { ...s, start: p.start, end: p.end }
          : { ...s, start: p.start, end: p.end, id: undefined },
      );
    });
  }
  for (const g of gaps) {
    next.push({ start: g.start, end: g.end, action: "keep", reason: SCRIPT_RESTORE_REASON });
  }
  next.sort((x, y) => x.start - y.start || x.end - y.end);
  return { ok: true, segments: next };
}

/** ズーム区間の重なり回避。ズームは重なれない(CLI と同じ検査を通す保存が
 * 「ズーム区間が重なっています」で落ち、GUI からは直せない状態になる)ので、
 * 編集後の span を「自分以外のズームが空けている隙間」へ収めてから採る。
 *
 * mode="move" は尺を保ったまま隣のズームの手前で止める(隙間が尺より狭ければ
 * null=そのドラッグを採らない)。trim / create は端を隙間へクランプする。
 * 隙間が最小幅(minSpan)未満、またはアンカーが既存ズームの内側なら null。
 * others は順不同でよい。返す秒は round2 済み(呼び出し側の量子と揃える) */
export function fitZoomSpan(
  others: readonly TimeSpan[],
  span: TimeSpan,
  mode: "create" | "move" | "trim-start" | "trim-end",
  minSpan: number,
): TimeSpan | null {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const dur = span.end - span.start;
  if (dur < minSpan) return null;
  // どの隙間へ収めるかはアンカー(動かさない側の点)で決める。move / create は
  // 移動後の中点、trim は固定端のすぐ内側(編集前の span は重なっていない前提)
  const anchor =
    mode === "move" || mode === "create"
      ? (span.start + span.end) / 2
      : mode === "trim-start"
        ? span.end - minSpan / 2
        : span.start + minSpan / 2;
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  for (const o of others) {
    if (o.start < anchor && anchor < o.end) return null; // 隙間が無い
    if (o.end <= anchor) lo = Math.max(lo, o.end);
    if (o.start >= anchor) hi = Math.min(hi, o.start);
  }
  if (hi - lo < minSpan) return null;
  if (mode === "move") {
    if (hi - lo < dur) return null; // 尺のまま平行移動では収まらない
    const start = Math.min(Math.max(span.start, lo), hi - dur);
    return { start: r2(start), end: r2(start + dur) };
  }
  const start = Math.max(span.start, lo);
  const end = Math.min(span.end, hi);
  if (end - start < minSpan) return null;
  return { start: r2(start), end: r2(end) };
}

// ============================================================
// プレビュー上のテロップ枠(CaptionOverlay)の座標
// ============================================================

/** 位置未指定テロップの実効表示位置(コンポジションpx・**テキスト中心**)。
 *
 * 実描画(src/engine/describeFrame.ts の captionItemForTrack フォールバック +
 * src/engine/refPainter.ts の drawCaption)は、下部中央のテロップを
 * 「anchor=bottomCenter の点 (bandWidth/2, height - wipeMarginPx)」に置く。
 * bottomCenter が指すのは**テキストボックス**(高さ = fontSizePx * 1.4)の
 * 下端なので、中心はそこから行高の半分だけ上=`- fontSizePx * 0.7`。
 *
 * **座布団(background)の padding を引いてはいけない**: 帯は
 * `boxY - pad/2 .. boxY + textH + pad/2` とテキストボックスの外側へ対称に
 * はみ出すだけで、テキスト芯の中心を動かさない(引くと枠とインライン編集
 * ボックスが padding ぶん上へずれる)。Remotion 経路(bottom: marginPx に
 * 座布団ごと置く)の時代はここを引く必要があったが、engine 経路では逆に
 * ずれの原因になる。 */
export function defaultCaptionPos(args: {
  width: number;
  height: number;
  /** テロップ安全余白の算出に使う config 値(render.wipeWidthPx) */
  wipeWidthPx: number;
  wipeMarginPx: number;
  /** カメラ(ワイプ)があるときだけ右側を予約する(plain は全幅中央) */
  hasCamera: boolean;
  /** そのテロップの実効フォントサイズ(トラック標準・個別指定まで解決済み) */
  fontSizePx: number;
}): CaptionPos {
  const reserve = args.hasCamera ? args.wipeWidthPx + args.wipeMarginPx * 2 : 0;
  return {
    x: Math.round((args.width - reserve) / 2),
    y: Math.round(args.height - args.wipeMarginPx - args.fontSizePx * 0.7),
  };
}

/** テロップ枠(青い点線)の左上を pos からどれだけずらすか(コンポジションpx)。
 *
 * 枠は縁取り/座布団の張り出し(padXPx/padYPx)まで含めて可視字幕を囲うので、
 * anchor によって基準が違う:
 * - center: pos はテキスト中心。padding は左右上下対称なので枠の中心も pos
 *   のまま=ずらさない
 * - topLeft: pos は**テキストボックス**の左上(refPainter の drawCaption と
 *   同じ規約)で、帯はその外側へはみ出す。枠は padding ぶん左上へずらして
 *   初めて実際の帯と一致する */
export function captionBoxOffset(
  anchor: "center" | "topLeft",
  padXPx: number,
  padYPx: number,
): { dx: number; dy: number } {
  return anchor === "topLeft" ? { dx: -padXPx, dy: -padYPx } : { dx: 0, dy: 0 };
}

/** 選択スパンを元収録の秒 at で2分割する。at が [start,end] の内側(両端から
 * minSpan 以上)でなければ null(no-op)。返す秒は round2 済み。時刻はすべて
 * 元収録の秒(呼び出し側が playhead→srcAt で変換して渡す)。 */
export function splitSpanAt(
  start: number,
  end: number,
  at: number,
  minSpan: number,
): { left: { start: number; end: number }; right: { start: number; end: number } } | null {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const s = r2(start), e = r2(end), a = r2(at);
  if (a <= s + minSpan || a >= e - minSpan) return null;
  return { left: { start: s, end: a }, right: { start: a, end: e } };
}

// ============================================================
// AI Copilot Diff レビュー: diffレーン用 TrackDef
// ============================================================

/** diffレーンのトラックIDプレフィックス */
export const DIFF_TRACK_PREFIX = "diff:";

/** F2: diff レーンに置く1クリップ。event は元収録秒(source)のままで、
 * outStart/outEnd はカット後秒(output)へ換算した表示座標。
 * inCut = 現在は全部カットされている区間の提案(幅ゼロの印で出す) */
export interface DiffLaneClip {
  event: ReviewEvent;
  outStart: number;
  outEnd: number;
  inCut: boolean;
}

/** diffレーンの TrackDef。id は "diff:zoom" のように既存トラックIDに前置する */
export interface DiffTrackDef {
  track: TrackDef;
  /** このdiffレーンに対応する元トラックの TrackDef */
  sourceTrack: TrackDef;
  /** F2: 表示座標(output 秒)まで解決済みのクリップ列。時系列順 */
  clips: DiffLaneClip[];
  /** 提案件数（バッジ表示用） */
  eventCount: number;
}

/**
 * ReviewEvent[] と既存 tracks から、diffレーンの TrackDef 配列を作る。
 * 変更のあるトラックに対してのみ diffレーンを生成する。
 *
 * F2: toOut は「元収録秒の区間 → カット後秒の区間(複数可)」の換算。
 * App が remapInterval / snapToOutput を束ねて渡す。ここで換算まで
 * 済ませるのは、Timeline に source 軸の値を一切渡さないため。
 */
export function buildDiffTracks(
  events: readonly ReviewEvent[],
  existingTracks: readonly TrackDef[],
  toOut: (startSec: number, endSec: number) => { start: number; end: number; inCut: boolean } | null,
): DiffTrackDef[] {
  const trackIdToClips = new Map<TrackId, DiffLaneClip[]>();

  for (const event of events) {
    const trackId = diffTrackIdForEventKind(event.kind);
    if (!trackId) continue;
    const exists = existingTracks.some((t) => t.id === trackId);
    if (!exists) continue;
    if (!event.timeRange) continue;
    const mapped = toOut(event.timeRange.startSec, event.timeRange.endSec);
    if (!mapped) continue;
    const arr = trackIdToClips.get(trackId) ?? [];
    arr.push({ event, outStart: mapped.start, outEnd: mapped.end, inCut: mapped.inCut });
    trackIdToClips.set(trackId, arr);
  }

  const result: DiffTrackDef[] = [];
  for (const [trackId, clips] of trackIdToClips) {
    const sourceTrack = existingTracks.find((t) => t.id === trackId);
    if (!sourceTrack) continue;
    clips.sort((a, b) => a.outStart - b.outStart);
    result.push({
      track: {
        id: `${DIFF_TRACK_PREFIX}${trackId}` as TrackId,
        label: "AI提案",
        hint: "AI編集の提案。クリックでプレビュー・承認・却下",
      },
      sourceTrack,
      clips,
      eventCount: clips.length,
    });
  }

  const orderMap = new Map<TrackId, number>();
  existingTracks.forEach((t, i) => orderMap.set(t.id, i));
  result.sort(
    (a, b) =>
      (orderMap.get(a.sourceTrack.id) ?? 0) -
      (orderMap.get(b.sourceTrack.id) ?? 0),
  );

  return result;
}

/**
 * F7: この提案を diff レーンに出すか。
 * 「時間軸上の位置で判断する変更」だけを通す。テロップの文言だけの変更は
 * パネルのインライン diff に任せ、レーンには出さない(量が多く、クリップ幅
 * では読めないため)。テロップでも削除・追加・時刻変更は通す。
 */
export function isLaneWorthy(
  event: { kind: string; hunkIndexes: readonly number[] },
  hunks: readonly Hunk[],
): boolean {
  if (event.kind === "caption-track" || event.kind === "json") return false;
  if (event.kind !== "caption") return true;
  const own = event.hunkIndexes.map((i) => hunks[i]).filter(Boolean);
  if (own.length === 0) return false;
  if (own.some((h) => h.kind === "element-add" || h.kind === "element-remove")) return true;
  return own.some((h) => h.address.field !== "text");
}

/** ReviewEventKind → 対応する TrackId */
function diffTrackIdForEventKind(kind: string): TrackId | null {
  switch (kind) {
    case "cut": return "cut";
    case "caption": return "caption";
    case "overlay": return "ov1";
    case "insert": return "cut";
    case "annotation": return "annotation";
    case "text": return "text";
    case "blur": return "blur";
    case "zoom": return "zoom";
    case "wipe": return "wipe";
    case "caption-track": return "caption";
    case "bgm": return "bgm";
    default: return null;
  }
}

/**
 * F6: AI編集モード(Copilot)を開いてよいか。
 * - 提案が無い / 差分ゼロ件 → 開かない
 * - 外部変更を検知している → 開かない(古い base への提案になるため)
 */
export function shouldEnterCopilotMode(args: {
  hunkCount: number;
  externalChanged: boolean;
}): boolean {
  if (args.externalChanged) return false;
  return args.hunkCount > 0;
}

/**
 * 比較(before/after still)の生成を、暗黙のトリガ(diff popover を
 * 開く / 差分プレビュー)で走らせてよいか。
 */
export function shouldRequestAiReview(args: {
  phase: string;
  hasBundle: boolean;
  stale: boolean;
  alreadyRequested: boolean;
}): boolean {
  if (args.phase !== "reviewing") return false;
  if (args.hasBundle || args.stale) return false;
  return !args.alreadyRequested;
}

/**
 * F8: 単一(または複数)hunk だけを当てるための resolution を作る。
 * applyProposalResolution は resolution に無い hunk を既定で "theirs" として
 * 当ててしまうので、当てたいもの以外を明示的に "mine" で塞ぐ必要がある
 */
export function resolutionForOnly(
  allHunks: readonly Hunk[],
  targets: readonly Hunk[],
): Map<Hunk, "theirs" | "mine"> {
  const m = new Map<Hunk, "theirs" | "mine">();
  for (const h of allHunks) m.set(h, "mine");
  for (const h of targets) m.set(h, "theirs");
  return m;
}

/** diffレーンの行高(px)。開閉は無く常にこの高さ(F3) */
export const DIFF_ROW_H = 28;

/**
 * プレビュー上のインライン編集(ダブルクリック)中の下書きを、Player へ渡す
 * props のどのエントリへ当てるか。編集枠(textarea)は color:transparent で、
 * 打鍵の見た目は Player 側の字幕が担うので、ここが外れると「確定するまで
 * 何も変わらない」ように見える。
 *
 * 判定はトラック一致+「下書きを取った時刻がそのエントリの表示区間内」。
 * **時刻はカット後(出力)の秒**で比べること(transcript / overlays.json が
 * 持つ元収録の秒と混ぜると、カットのあるプロジェクトで当たらなくなる)。
 */
export function isInlineDraftTarget(
  item: { start: number; end: number; track?: number },
  editingTrack: number | null,
  outT: number,
): boolean {
  if (editingTrack === null) return false;
  return (item.track ?? 1) === editingTrack && outT >= item.start && outT < item.end;
}
