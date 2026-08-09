import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../lib/exec.ts";
import { proxyFileName } from "../lib/proxyCache.ts";
import { resolveThumbstripCfg } from "../lib/config.ts";
import {
  buildThumbstripFilter,
  planThumbstrip,
  sheetFileName,
  THUMBSTRIP_GENERATION,
} from "../lib/thumbstrip.ts";
import type { Config } from "../lib/config.ts";
import type { ThumbstripIndex, ThumbstripKey, ThumbstripLevel } from "../lib/thumbstrip.ts";
import type { Manifest } from "../types.ts";

type ThumbstripResult = { index: ThumbstripIndex } | { unavailable: string };

const inflight = new Map<string, Promise<ThumbstripResult>>();

/**
 * timeline.probe/thumbstrip.json を最新にして返す。
 * 既に有効なキャッシュがあれば ffmpeg を起動しない。
 * 生成不能(proxy 不在 / stills / ffprobe 失敗)は例外ではなく unavailable を返す。
 */
export async function ensureThumbstrip(
  dir: string,
  cfg: Config,
): Promise<ThumbstripResult> {
  const key = resolve(dir);
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = ensureThumbstripInner(dir, cfg)
    .catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`thumbstrip を生成できませんでした: ${reason}`);
      return { unavailable: reason } satisfies ThumbstripResult;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, job);
  return job;
}

async function ensureThumbstripInner(dir: string, cfg: Config): Promise<ThumbstripResult> {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return { unavailable: "manifest.json がありません" };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const proxyFile = proxyFileName(manifest);
  if (proxyFile === "proxy.m4a") return { unavailable: "stills プロジェクトは対象外です" };
  const proxyPath = join(dir, proxyFile);
  if (!existsSync(proxyPath)) return { unavailable: "proxy.mp4 がまだありません" };

  const proxyStat = statSync(proxyPath);
  const probe = await probeProxy(proxyPath);
  if (!probe) return { unavailable: "proxy を ffprobe できません" };

  const thumbCfg = resolveThumbstripCfg(cfg);
  const tileHeight = evenHeight((thumbCfg.tileWidthPx * probe.height) / probe.width);
  const basePlan = {
    durationSec: probe.duration,
    intervalSec: thumbCfg.intervalSec,
    columns: thumbCfg.columns,
    rows: thumbCfg.rows,
    tileWidth: thumbCfg.tileWidthPx,
    tileHeight,
  } as const;
  let level = planThumbstrip(basePlan);
  const probeDir = join(dir, "timeline.probe");
  const indexPath = join(probeDir, "thumbstrip.json");

  for (const format of ["webp", "jpeg"] as const) {
    const candidateLevel = planThumbstrip({ ...basePlan, format });
    const candidateKey: ThumbstripKey = {
      generation: THUMBSTRIP_GENERATION,
      proxyFile,
      proxySize: proxyStat.size,
      proxyMtimeMs: proxyStat.mtimeMs,
      intervalSec: candidateLevel.intervalSec,
      tileWidth: candidateLevel.tileWidth,
      tileHeight: candidateLevel.tileHeight,
      columns: candidateLevel.columns,
      rows: candidateLevel.rows,
      format,
    };
    const cached = readCachedThumbstrip(indexPath, candidateKey);
    if (cached && sheetsExist(dir, cached.levels[0])) return { index: cached };
  }

  const tmpDir = join(probeDir, "thumbstrip.tmp");
  const finalDir = join(probeDir, "thumbstrip");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const generated = await generateThumbstripSheets(proxyPath, tmpDir, level);
  if (!generated) {
    rmSync(tmpDir, { recursive: true, force: true });
    return { unavailable: "thumbstrip の生成に失敗しました" };
  }
  level = planThumbstrip({ ...basePlan, format: generated.format });
  const key: ThumbstripKey = {
    generation: THUMBSTRIP_GENERATION,
    proxyFile,
    proxySize: proxyStat.size,
    proxyMtimeMs: proxyStat.mtimeMs,
    intervalSec: level.intervalSec,
    tileWidth: level.tileWidth,
    tileHeight: level.tileHeight,
    columns: level.columns,
    rows: level.rows,
    format: generated.format,
  };
  const index: ThumbstripIndex = {
    key,
    sourceDurationSec: probe.duration,
    levels: [level],
  };

  const actualSheets = generated.files;
  if (actualSheets.length === 0) return { unavailable: "thumbstrip の生成に失敗しました" };
  const publishedIndex: ThumbstripIndex = {
    ...index,
    levels: [levelForGeneratedSheetCount(level, actualSheets.length)],
  };

  rmSync(finalDir, { recursive: true, force: true });
  renameSync(tmpDir, finalDir);
  mkdirSync(probeDir, { recursive: true });
  const tmpIndexPath = `${indexPath}.tmp`;
  writeFileSync(tmpIndexPath, `${JSON.stringify(publishedIndex, null, 2)}\n`);
  renameSync(tmpIndexPath, indexPath);
  return { index: publishedIndex };
}

async function probeProxy(file: string): Promise<{ width: number; height: number; duration: number } | null> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ]);
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string | number };
    };
    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration);
    if (
      !stream ||
      typeof stream.width !== "number" ||
      typeof stream.height !== "number" ||
      stream.width <= 0 ||
      stream.height <= 0 ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      return null;
    }
    return { width: stream.width, height: stream.height, duration };
  } catch (err) {
    console.warn(`proxy を ffprobe できません: ${(err as Error).message}`);
    return null;
  }
}

function readCachedThumbstrip(file: string, key: ThumbstripKey): ThumbstripIndex | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ThumbstripIndex;
    return JSON.stringify(parsed.key) === JSON.stringify(key) ? parsed : null;
  } catch {
    return null;
  }
}

function sheetsExist(dir: string, level: ThumbstripLevel | undefined): boolean {
  if (!level) return false;
  return level.sheets.length > 0 && level.sheets.every((sheet) => existsSync(join(dir, sheet.file)));
}

async function generateThumbstripSheets(
  proxyPath: string,
  tmpDir: string,
  level: ThumbstripLevel,
): Promise<{ format: "webp" | "jpeg"; files: string[] } | null> {
  const filter = buildThumbstripFilter({
    intervalSec: level.intervalSec,
    tileWidth: level.tileWidth,
    columns: level.columns,
    rows: level.rows,
  });
  const commonArgs = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    proxyPath,
    "-vf",
    filter,
    "-an",
    "-start_number",
    "0",
  ];
  try {
    await run("ffmpeg", [...commonArgs, join(tmpDir, `${level.id}-%03d.webp`)]);
    const webpSheets = generatedSheets(tmpDir, "webp");
    if (webpSheets.length > 0) return { format: "webp", files: webpSheets };
  } catch (err) {
    console.warn(`ffmpeg の WebP 出力に失敗しました。JPEG へフォールバックします: ${(err as Error).message}`);
  }

  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    await run("ffmpeg", [...commonArgs, join(tmpDir, `${level.id}-%03d.jpg`)]);
    const jpegSheets = generatedSheets(tmpDir, "jpg");
    return jpegSheets.length > 0 ? { format: "jpeg", files: jpegSheets } : null;
  } catch (err) {
    console.warn(`ffmpeg の JPEG 出力に失敗しました: ${(err as Error).message}`);
    rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
}

function generatedSheets(dir: string, ext: "webp" | "jpg"): string[] {
  return readdirSync(dir).filter((file) => new RegExp(`^coarse-\\d{3}\\.${ext}$`).test(file)).sort();
}

function levelForGeneratedSheetCount(level: ThumbstripLevel, actualSheetCount: number): ThumbstripLevel {
  const perSheet = level.columns * level.rows;
  const count = Math.min(level.count, actualSheetCount * perSheet);
  const sheetCount = Math.ceil(count / perSheet);
  return {
    ...level,
    count,
    sheets: Array.from({ length: sheetCount }, (_, sheetIndex) => {
      const startIndex = sheetIndex * perSheet;
      return {
        file: `timeline.probe/thumbstrip/${sheetFileName(level.id, sheetIndex, level.format)}`,
        startIndex,
        count: Math.min(perSheet, count - startIndex),
      };
    }),
  };
}

function evenHeight(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}
