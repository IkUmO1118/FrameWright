/** フォーマットを変えたら +1。key に載るのでキャッシュが自動で無効化される */
export const THUMBSTRIP_GENERATION = 2;

/** シート数の上限。長尺で無制限に増やさないための決定論的な上限 */
export const THUMBSTRIP_MAX_SHEETS = 20;

export interface ThumbstripKey {
  generation: number;
  /** "proxy.mp4"(収録フォルダからの相対) */
  proxyFile: string;
  proxySize: number;
  proxyMtimeMs: number;
  /** 実効サンプル間隔(planThumbstrip が上限で引き伸ばした後の値) */
  intervalSec: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  format: ThumbstripFormat;
}

export type ThumbstripFormat = "webp" | "jpeg";

export interface ThumbstripSheet {
  /** 収録フォルダからの相対パス。例 "timeline.probe/thumbstrip/coarse-000.webp" */
  file: string;
  /** このシートの先頭タイルの通し番号 */
  startIndex: number;
  /** このシートに実際に入っているタイル数(最終シートは columns*rows 未満) */
  count: number;
}

export interface ThumbstripLevel {
  id: "coarse";
  format: ThumbstripFormat;
  intervalSec: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  /** 全タイル数 */
  count: number;
  sheets: ThumbstripSheet[];
}

export interface ThumbstripIndex {
  key: ThumbstripKey;
  /** proxy の尺(秒)。タイル番号 → source 秒の逆算に使う */
  sourceDurationSec: number;
  levels: ThumbstripLevel[];
}

/** 近似画像 1 枚の参照。Filmstrip のタイルと同じ sprite sheet 座標 */
export interface ThumbTileRef {
  /** 収録フォルダからの相対パス(sheet の webp) */
  file: string;
  /** sheet 内のセル位置とセル寸法(出力 px ではなく sheet のピクセル) */
  col: number;
  row: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
}

/**
 * 尺と設定から level を決定論的に組む。
 * 実効間隔: durationSec / intervalSec が MAX_SHEETS*columns*rows を超えるときだけ
 * intervalSec を引き伸ばす(切り上げ)。
 */
export function planThumbstrip(args: {
  durationSec: number;
  intervalSec: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  format?: ThumbstripFormat;
}): ThumbstripLevel {
  const durationSec = Math.max(0, finiteOr(args.durationSec, 0));
  const columns = Math.max(1, Math.floor(finiteOr(args.columns, 1)));
  const rows = Math.max(1, Math.floor(finiteOr(args.rows, 1)));
  const tileWidth = Math.max(1, Math.floor(finiteOr(args.tileWidth, 1)));
  const tileHeight = Math.max(1, Math.floor(finiteOr(args.tileHeight, 1)));
  const format = args.format ?? "webp";
  const perSheet = columns * rows;
  const maxTiles = THUMBSTRIP_MAX_SHEETS * perSheet;
  let intervalSec = Math.max(1, finiteOr(args.intervalSec, 1));
  if (Math.ceil(durationSec / intervalSec) > maxTiles) {
    intervalSec = Math.max(intervalSec, Math.ceil(durationSec / maxTiles));
  }
  const count = Math.max(1, Math.ceil(durationSec / intervalSec));
  const sheetCount = Math.max(1, Math.ceil(count / perSheet));
  const sheets: ThumbstripSheet[] = [];
  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex++) {
    const startIndex = sheetIndex * perSheet;
    sheets.push({
      file: `timeline.probe/thumbstrip/${sheetFileName("coarse", sheetIndex, format)}`,
      startIndex,
      count: Math.min(perSheet, count - startIndex),
    });
  }
  return {
    id: "coarse",
    format,
    intervalSec,
    tileWidth,
    tileHeight,
    columns,
    rows,
    count,
    sheets,
  };
}

/** ffmpeg の -vf 文字列。tile の出力は %03d パターンで複数枚になる */
export function buildThumbstripFilter(args: {
  intervalSec: number;
  tileWidth: number;
  columns: number;
  rows: number;
}): string {
  return `fps=1/${args.intervalSec},scale=${args.tileWidth}:-2,tile=${args.columns}x${args.rows}`;
}

/** source 秒 → タイル通し番号。範囲外は null */
export function thumbIndexForSourceSec(sourceSec: number, level: ThumbstripLevel): number | null {
  if (!Number.isFinite(sourceSec) || sourceSec < 0) return null;
  const index = Math.floor(sourceSec / level.intervalSec);
  return index >= 0 && index < level.count ? index : null;
}

/** タイル通し番号 → どのシートの何行何列か。範囲外は null */
export function sheetCellFor(
  index: number,
  level: ThumbstripLevel,
): { sheetIndex: number; col: number; row: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= level.count) return null;
  const perSheet = level.columns * level.rows;
  for (let sheetIndex = 0; sheetIndex < level.sheets.length; sheetIndex++) {
    const sheet = level.sheets[sheetIndex];
    if (index < sheet.startIndex || index >= sheet.startIndex + sheet.count) continue;
    const local = index - sheet.startIndex;
    return {
      sheetIndex,
      col: local % level.columns,
      row: Math.floor(local / level.columns),
    };
  }
  const sheetIndex = Math.floor(index / perSheet);
  if (sheetIndex < 0 || sheetIndex >= level.sheets.length) return null;
  const local = index - sheetIndex * perSheet;
  return { sheetIndex, col: local % level.columns, row: Math.floor(local / level.columns) };
}

/** シートのファイル名。level.id と 3 桁ゼロ埋め */
export function sheetFileName(levelId: "coarse", sheetIndex: number, format: ThumbstripFormat = "webp"): string {
  return `${levelId}-${String(sheetIndex).padStart(3, "0")}.${format === "jpeg" ? "jpg" : "webp"}`;
}

/** source 秒 → 近似タイル。範囲外・index 不在は null */
export function tileRefForSourceSec(sourceSec: number, level: ThumbstripLevel): ThumbTileRef | null {
  const index = thumbIndexForSourceSec(sourceSec, level);
  if (index === null) return null;
  const cell = sheetCellFor(index, level);
  if (!cell) return null;
  const sheet = level.sheets[cell.sheetIndex];
  if (!sheet) return null;
  return {
    file: sheet.file,
    col: cell.col,
    row: cell.row,
    tileWidth: level.tileWidth,
    tileHeight: level.tileHeight,
    columns: level.columns,
    rows: level.rows,
  };
}

export function visibleTileRange(args: {
  clipOutStart: number;
  clipW: number;
  pps: number;
  dispW: number;
  winStart: number;
  winEnd: number;
}): { k0: number; k1: number } | null {
  if (args.pps <= 0 || args.dispW <= 0 || args.clipW <= 0) return null;
  const visL = Math.max(0, (args.winStart - args.clipOutStart) * args.pps);
  const visR = Math.min(args.clipW, (args.winEnd - args.clipOutStart) * args.pps);
  if (visR <= visL) return null;
  return {
    k0: Math.floor(visL / args.dispW),
    k1: Math.ceil(visR / args.dispW),
  };
}

export function tileSourceSec(args: {
  k: number;
  dispW: number;
  pps: number;
  srcStart: number;
  speed: number;
}): number {
  const dSec = (args.k * args.dispW + args.dispW / 2) / args.pps;
  return args.srcStart + dSec * args.speed;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
