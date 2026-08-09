import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Config } from "../lib/config.ts";
import { isBaseLayoutPreset, isCanvasPreset } from "../lib/profile.ts";
import { mergeIntervals } from "../lib/timeline.ts";
import type { CutPlan, Interval, Manifest } from "../types.ts";
import { ingest } from "./ingest.ts";

export type SourceTransfer = "symlink" | "hardlink" | "copy";

export interface DeriveRequest {
  sourceDir: string;
  name: string;
  canvas: string;
  baseLayout?: string;
  ranges: Interval[];
  cfg: Config;
}

export interface DeriveResult {
  dir: string;
  transfer: SourceTransfer;
  cutplan: CutPlan;
}

export interface DeriveDeps {
  ingest?: typeof ingest;
  symlink?: typeof symlinkSync;
  hardlink?: typeof linkSync;
  copy?: typeof copyFileSync;
  log?: (line: string) => void;
}

/** CLI の `start-end` を source 秒の区間へ変換する。 */
export function parseDeriveRange(value: string): Interval {
  const match = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) throw new Error(`--range は start-end 形式で指定してください: ${value}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!(end > start)) throw new Error(`--range は end > start が必要です: ${value}`);
  return { start, end };
}

/** 人間指定の範囲を正規化し、元尺を隙間なく覆う cutplan にする。 */
export function buildDerivedCutplan(durationSec: number, ranges: Interval[]): CutPlan {
  if (ranges.length === 0) throw new Error("--range を1つ以上指定してください");
  const sorted = ranges
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const range of sorted) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) {
      throw new Error(`不正な派生範囲です: ${range.start}-${range.end}`);
    }
    if (range.end > durationSec) {
      throw new Error(`派生範囲 ${range.start}-${range.end} が元収録の尺 ${durationSec}秒を超えています`);
    }
  }
  const keeps = mergeIntervals(sorted);
  const segments: CutPlan["segments"] = [];
  let cursor = 0;
  for (const keep of keeps) {
    if (keep.start > cursor) {
      segments.push({ action: "cut", start: cursor, end: keep.start, reason: "派生プロジェクト: 範囲外" });
    }
    segments.push({ action: "keep", start: keep.start, end: keep.end, reason: "derive --range" });
    cursor = keep.end;
  }
  if (cursor < durationSec) {
    segments.push({ action: "cut", start: cursor, end: durationSec, reason: "派生プロジェクト: 範囲外" });
  }
  return { approved: false, segments };
}

/** symlink 非対応環境では hardlink、最後に copy へフォールバックする。 */
export function transferDerivedSource(
  source: string,
  destination: string,
  deps: Pick<DeriveDeps, "symlink" | "hardlink" | "copy"> = {},
): SourceTransfer {
  try {
    (deps.symlink ?? symlinkSync)(relative(dirname(destination), source), destination);
    return "symlink";
  } catch {
    try {
      (deps.hardlink ?? linkSync)(source, destination);
      return "hardlink";
    } catch {
      (deps.copy ?? copyFileSync)(source, destination);
      return "copy";
    }
  }
}

/** 元プロジェクトと同じ source 時間軸を持つ、独立した派生プロジェクトを作る。 */
export async function deriveProject(request: DeriveRequest, deps: DeriveDeps = {}): Promise<DeriveResult> {
  const sourceDir = resolve(request.sourceDir);
  const manifestPath = join(sourceDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`元プロジェクトに manifest.json がありません: ${sourceDir}`);
  if (!isCanvasPreset(request.canvas)) throw new Error(`未知の canvas 名です: ${request.canvas}`);
  if (request.baseLayout !== undefined && !isBaseLayoutPreset(request.baseLayout)) {
    throw new Error(`未知の baseLayout 名です: ${request.baseLayout}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const cutplan = buildDerivedCutplan(manifest.durationSec, request.ranges);
  const safeName = basename(request.name).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "");
  if (!safeName || safeName !== request.name) throw new Error(`派生プロジェクト名が不正です: ${request.name}`);
  const destination = resolve(dirname(sourceDir), safeName);
  if (existsSync(destination)) throw new Error(`派生先は既に存在します: ${destination}`);
  const source = join(sourceDir, manifest.source);
  if (!existsSync(source)) throw new Error(`元メディアがありません: ${source}`);
  const transcriptPath = join(sourceDir, "transcript.json");
  if (!existsSync(transcriptPath)) {
    throw new Error(`元プロジェクトに transcript.json がありません: ${sourceDir}`);
  }

  mkdirSync(destination, { recursive: false });
  try {
    const destinationSource = join(destination, basename(manifest.source));
    const transfer = transferDerivedSource(source, destinationSource, deps);
    deps.log?.(`ベースメディアを ${transfer} で共有しました: ${destinationSource}`);
    await (deps.ingest ?? ingest)(
      destination,
      basename(manifest.source),
      request.cfg,
      manifest.layout ?? "obs-canvas",
      undefined,
      request.canvas,
      request.baseLayout,
    );
    const derivedManifestPath = join(destination, "manifest.json");
    const derivedManifest = JSON.parse(readFileSync(derivedManifestPath, "utf8")) as Manifest;
    writeFileSync(
      derivedManifestPath,
      JSON.stringify({
        ...derivedManifest,
        derivedFrom: { name: basename(sourceDir), ranges: request.ranges },
      }, null, 2),
    );
    copyFileSync(transcriptPath, join(destination, "transcript.json"));
    writeFileSync(join(destination, "cutplan.json"), JSON.stringify(cutplan, null, 2));
    return { dir: destination, transfer, cutplan };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
