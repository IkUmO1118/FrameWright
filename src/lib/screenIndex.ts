// video-perception-P1 §2.7 — screen.probe/index.json の読み出しと古さ判定。
//
// `src/stages/screen.ts`(生成側)から分離しているのは、`validate` と
// `describe`(読む側)が ffmpeg / Apple Vision を引きずり込まずに済むように
// するため。ここは fs 読み出しと純粋な比較だけを持つ。
//
// **`outSec` の読み出し時再計算はしない**(§2.7)。index.json の Layer 2 キーは
// `av.probe/motion.json` の key(= `keepsHash` 込み)を含むので、書かれた
// 時点の cutplan と必ず整合している。再計算すると「区間の境界は古い cutplan
// 由来なのに秒だけ新しい」という不整合な状態になる。代わりに古さを**警告**する。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keepsHash } from "./avParse.ts";
import { mergeIntervals } from "./timeline.ts";
import type { CutPlan, Interval } from "../types.ts";

/** screen.probe/ ディレクトリ名(src/stages/screen.ts の SCREEN_DIR と同値。
 *  読む側が生成側を import しないための再掲) */
export const SCREEN_DIR_NAME = "screen.probe";
export const SCREEN_INDEX_FILE_NAME = "index.json";

/** index.json のうち読む側が使う部分だけ(生成側の ScreenIndex の部分型) */
export interface ScreenIndexRead {
  schemaVersion: number;
  capturedAt: string;
  key: Record<string, unknown>;
  range: { startSec: number; endSec: number };
  ocrAvailable: boolean;
  params: Record<string, number>;
  segments: Record<string, unknown>[];
  warnings: string[];
}

/** screen.probe/index.json を読む(無い/壊れていれば null=優雅な劣化)。
 *  読む側は「未実行は異常ではない」ので例外を投げない */
export function readScreenIndex(dir: string): ScreenIndexRead | null {
  const p = join(dir, SCREEN_DIR_NAME, SCREEN_INDEX_FILE_NAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ScreenIndexRead;
  } catch {
    return null;
  }
}

export type ScreenFreshness =
  | { state: "none" }
  | { state: "fresh" }
  | { state: "stale"; recordedKeepsHash: string; currentKeepsHash: string };

/** index.json の Layer 2 キーに記録された keepsHash を取り出す(取れなければ null) */
function recordedKeepsHash(index: ScreenIndexRead): string | null {
  const motionKey = index.key["av.probe/motion.json"];
  if (typeof motionKey !== "object" || motionKey === null) return null;
  const h = (motionKey as Record<string, unknown>).keepsHash;
  return typeof h === "string" ? h : null;
}

/**
 * screen.probe/index.json が現在の cutplan より古いかを判定する(§2.7)。
 * `frames/index.json` の古さ警告と同じ非強制の姿勢で、`none`(未実行)は
 * 警告しない。判定は Layer 2 キーの `keepsHash` と、現在の cutplan から
 * 計算した `keepsHash`(`src/lib/avParse.ts:122`)の比較だけで行う。
 *
 * 既知の限界: `av --range` で部分測定した motion.json を使った場合、
 * `av` 側の keepsHash は範囲でクリップされた keeps のものになるため
 * 偽陽性(古くないのに stale)になりうる。警告どまりなので害はない。
 */
export function screenFreshness(dir: string, cutplan: CutPlan | null): ScreenFreshness {
  const index = readScreenIndex(dir);
  if (!index) return { state: "none" };
  if (!cutplan) return { state: "fresh" };
  const recorded = recordedKeepsHash(index);
  if (recorded === null) return { state: "fresh" };
  const keeps: Interval[] = mergeIntervals(
    cutplan.segments.filter((s) => s.action === "keep"),
  );
  const current = keepsHash(keeps);
  return recorded === current
    ? { state: "fresh" }
    : { state: "stale", recordedKeepsHash: recorded, currentKeepsHash: current };
}
