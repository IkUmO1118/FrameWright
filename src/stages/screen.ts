// video-perception-P1: `screen <dir>` — 画面状態の区間トラックを作る知覚コマンド。
// §docs/plans/2026-08-10-video-perception-p1-screen-probe-design.md
//
// 手順(§2.3.2 の I/O 側): av.probe/motion.json を読む → P0 の
// selectSceneTimes でサンプル時刻を決める → Layer 2(index.json)のキャッシュを
// 引く(一致すれば OCR も ffmpeg も一切呼ばない)→ 各サンプルで Layer 1
// (ocr/<sourceSec>.json)のキャッシュを引き、ミスしたものだけ
// buildScreenStill → runOcr を実行 → normalizeOcrLines → foldScreenSegments
// (純関数。src/lib/screenSegments.ts)で区間へ畳む → index.json を書く →
// 書き込み成功後に mark-and-sweep で未参照の Layer 1 ファイルを削除する。
//
// キャッシュは2層(索引 §2.1・本設計書 §2.5。1層実装は C2/C3 で必ず落ちる):
//   Layer 1 = screen.probe/ocr/<sourceSec.toFixed(2)>.json(cutplan 非依存。
//     source ファイルの mtime+size・screenRegion・languages だけをキーにする)
//   Layer 2 = screen.probe/index.json の key(av.probe/motion.json の key
//     全体 = keepsHash 込み。cutplan 依存はここに閉じる)
//
// テスト可能性(§3.2): OCR 実行関数(runOcr)と still 抽出関数
// (buildScreenStill)を deps 引数で注入できるようにし、C1〜C7 が
// runOcr の呼び出し回数を数えられるようにする。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../lib/config.ts";
import { DEFAULT_AV_EVERY_SEC, resolveAiRuntimeConfig, resolveScreenCfg } from "../lib/config.ts";
import { selectSceneTimes } from "../lib/sceneSampling.ts";
import type { SceneSamplingCfg } from "../lib/sceneSampling.ts";
import { foldScreenSegments, normalizeOcrLines } from "../lib/screenSegments.ts";
import type { ScreenSample, ScreenSegmentCfg } from "../lib/screenSegments.ts";
import { DEFAULT_OCR_LANGUAGES, runOcr as runOcrDefault } from "../lib/ocr.ts";
import type { OcrResult, RunOcrOptions } from "../lib/ocr.ts";
import { buildScreenStill as buildScreenStillDefault } from "../lib/screenStill.ts";
import { AV_DIR, MOTION_FILE } from "./av.ts";
import type { MotionReport } from "./av.ts";
import type { Manifest, Region } from "../types.ts";
// video-perception-P4: `screen --summarize`(§docs/plans/2026-08-10-
// video-perception-p4-vlm-segment-summary-design.md)。純関数(後段検証
// R1〜R3・選定・プロンプト・応答検査・引き継ぎ判定)は screenSummary.ts。
// ここは I/O(completeAi 呼び出し)だけを持つ(索引 §2.9)。
import {
  buildInheritedSummaryMap,
  buildScreenSummaryPrompt,
  checkSummaryText,
  parseScreenSummaryResponse,
  screenSummaryResponseSchema,
  selectSummarizeTargets,
  SCREEN_SUMMARY_SCHEMA_NAME,
} from "../lib/screenSummary.ts";
import type { ScreenSummary } from "../lib/screenSummary.ts";
import { completeAi as completeAiDefault } from "../lib/ai/client.ts";
import { AiProviderError } from "../lib/ai/http.ts";
import type { AiRequest, AiResponse } from "../lib/ai/types.ts";

export const SCREEN_DIR = "screen.probe";
export const SCREEN_INDEX_FILE = "index.json";
const SCREEN_OCR_SUBDIR = "ocr";
const SCREEN_STILLS_SUBDIR = "stills";
const SCHEMA_VERSION = 1;

export interface ScreenOptions {
  /** 区間代表の PNG も screen.probe/stills/<id>.png に残す。省略時 false */
  stills?: boolean;
  /** Layer 1・Layer 2 の両方のキャッシュを無視して全再計算する */
  force?: boolean;
  /** video-perception-P4: 区間へ VLM 1 行要約を付ける。省略時 false(VLM を
   * 一切呼ばない。既定オフ=バイト等価。§2.5) */
  summarize?: boolean;
}

/** OCR 実行・still 抽出・VLM 呼び出しを注入可能にする(テストが実
 * ffmpeg/Apple Vision/AI を呼ばずに呼び出し回数を数えられるようにするための
 * 穴。§3.2・P4 §3.1)。既存の2つ(runOcr/buildScreenStill)は変えない */
export interface ScreenDeps {
  runOcr?: (imagePath: string, screenRegion: Region, opts: RunOcrOptions) => Promise<OcrResult | null>;
  buildScreenStill?: (dir: string, manifest: Manifest, sourceSec: number, outPath: string) => Promise<string>;
  /** video-perception-P4。省略時は実際の completeAi(src/lib/ai/client.ts) */
  completeAi?: (req: AiRequest, cfg: Config) => Promise<AiResponse>;
}

export interface ScreenParams {
  mergeThreshold: number;
  sceneThreshold: number;
  minSegmentSec: number;
  maxSamples: number;
  indexLines: number;
}

export interface ScreenSegmentOut {
  id: string;
  sourceSec: number;
  endSourceSec: number;
  outSec: number | null;
  endOutSec: number | null;
  lenSec: number;
  sampleCount: number;
  absorbed: number;
  sceneScore: number;
  boundary: { in: "start" | "scene"; out: "scene" | "end" };
  /** 代表サンプルの元収録秒(Layer 1 の鍵) */
  representativeSourceSec: number;
  /** --stills 時のみ "stills/<id>.png"。既定 null */
  still: string | null;
  ocr: { lines: string[]; lineCount: number; file: string } | null;
  /** video-perception-P4 が埋める。`--summarize` を使わない限り常に null(§2.4) */
  summary: ScreenSummary | null;
}

export interface ScreenIndex {
  schemaVersion: number;
  capturedAt: string;
  key: Record<string, unknown>;
  range: { startSec: number; endSec: number };
  ocrAvailable: boolean;
  params: ScreenParams;
  segments: ScreenSegmentOut[];
  warnings: string[];
}

function readCachedIndex(path: string, key: unknown): ScreenIndex | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ScreenIndex;
  return JSON.stringify(parsed.key) === JSON.stringify(key) ? parsed : null;
}

function readCachedOcr(path: string, key: unknown): OcrResult | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { key: unknown; result: OcrResult };
  return JSON.stringify(parsed.key) === JSON.stringify(key) ? parsed.result : null;
}

/**
 * screen.probe/index.json(区間トラック)を作る/更新する。
 * av.probe/motion.json が無ければ告知して Error を投げる(exit 1 相当。
 * material-fit / bgm-fit と同じ「前提エラー」の形。共通規約 §2.5)。
 */
export async function screen(
  dir: string,
  opts: ScreenOptions,
  cfg: Config,
  deps: ScreenDeps = {},
): Promise<ScreenIndex> {
  const startedAt = Date.now();
  const runOcrFn = deps.runOcr ?? runOcrDefault;
  const buildStillFn = deps.buildScreenStill ?? buildScreenStillDefault;

  const motionPath = join(dir, AV_DIR, MOTION_FILE);
  if (!existsSync(motionPath)) {
    throw new Error(
      "av.probe/motion.json がありません。先に `node src/cli.ts av <dir>` を実行してください。",
    );
  }
  const motion = JSON.parse(readFileSync(motionPath, "utf8")) as MotionReport;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;

  const screenCfg = resolveScreenCfg(cfg);
  const languages = cfg.ocr?.languages ?? DEFAULT_OCR_LANGUAGES;

  // frames.scenes の設定は読まない(§2.6。P0 とは較正の目標が違うため独立)
  const samplingCfg: SceneSamplingCfg = {
    sceneThreshold: screenCfg.sceneThreshold,
    minGapSec: screenCfg.minGapSec,
    maxShots: screenCfg.maxSamples,
    frozenShotEverySec: screenCfg.frozenShotEverySec,
    frozenMaxShotsPerSpan: screenCfg.frozenMaxShotsPerSpan,
  };
  const { times, dropped } = selectSceneTimes(motion, samplingCfg);
  const capped = dropped.scene > 0 || dropped.frozen > 0;
  console.log(
    `screen: ${times.length} 件のサンプルを選択しました` +
      (capped
        ? `(上限 ${samplingCfg.maxShots} 件のため間引き: 画面変化 ${dropped.scene} 件 / 静止区間 ${dropped.frozen} 件)`
        : `(上限 ${samplingCfg.maxShots} 件・間引きなし)`),
  );

  // §2.6 末尾: av.everySec 以下だと吸収が機能しない(エラーにはしない)
  const avEverySec = cfg.av?.everySec ?? DEFAULT_AV_EVERY_SEC;
  if (screenCfg.minSegmentSec <= avEverySec) {
    console.warn(
      `警告: screen.minSegmentSec(${screenCfg.minSegmentSec})が av.everySec(${avEverySec})以下です。` +
        `サンプルグリッド間隔以下のため、短区間の吸収が機能しません。`,
    );
  }

  const outDir = join(dir, SCREEN_DIR);
  const ocrDir = join(outDir, SCREEN_OCR_SUBDIR);
  mkdirSync(ocrDir, { recursive: true });
  const indexPath = join(outDir, SCREEN_INDEX_FILE);

  const params: ScreenParams = {
    mergeThreshold: screenCfg.mergeThreshold,
    sceneThreshold: screenCfg.sceneThreshold,
    minSegmentSec: screenCfg.minSegmentSec,
    maxSamples: screenCfg.maxSamples,
    indexLines: screenCfg.indexLines,
  };
  // Layer 2 のキー(§2.5.2): schemaVersion / motion.json の key 全体
  // (keepsHash 込み。cutplan 依存はここに閉じる) / params / screenRegion /
  // languages の5つだけ。manifest.source の mtime+size は入れない
  // (motion.json の key.base が既に持っている)
  const layer2Key = {
    schemaVersion: SCHEMA_VERSION,
    "av.probe/motion.json": motion.key,
    params,
    screenRegion: manifest.video.screenRegion,
    languages,
  };

  // video-perception-P4: `--summarize` のときは Layer 2 の早期 return を
  // 使わない。理由は2つ: (1) キャッシュ一致時でも旧 index.json には
  // summary が無いことがある(前回は --summarize を付けなかった等)ので、
  // 早期 return すると summary を埋める機会が無くなる。(2) §2.4.1 の
  // representativeSourceSec 引き継ぎは「今回の index.json を書く直前に
  // 旧 index.json を読む」という手順を前提にしており、早期 return では
  // その手順自体が起きない。opts.summarize が false/未指定のときは
  // この条件は従来と完全に同じ(バイト等価。T14)
  if (opts.force !== true && opts.summarize !== true) {
    const cached = readCachedIndex(indexPath, layer2Key);
    if (cached) {
      console.log(`screen: ${((Date.now() - startedAt) / 1000).toFixed(1)}s で完了(キャッシュ一致・OCR/ffmpeg なし)`);
      return cached;
    }
  }

  // Layer 1 のキー(§2.5.1): source ファイルの mtime+size・screenRegion・
  // languages だけ。cutplan も motion.json も params も入らない(同じ元収録の
  // 同じ秒の画面は、どう編集しようと同じ絵だから)
  const sourceFile = join(dir, manifest.source);
  const sourceStat = statSync(sourceFile);
  const layer1Key = {
    source: { file: manifest.source, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
    screenRegion: manifest.video.screenRegion,
    languages,
  };

  const samples: ScreenSample[] = [];
  let ocrAvailable = false;
  for (const t of times) {
    const ocrPath = join(ocrDir, `${t.sourceSec.toFixed(2)}.json`);
    const cachedOcr = opts.force === true ? null : readCachedOcr(ocrPath, layer1Key);
    let result: OcrResult | null;
    if (cachedOcr !== null) {
      result = cachedOcr;
    } else {
      const scratchPath = join(tmpdir(), `framewright-screen-${process.pid}-${t.sourceSec.toFixed(2)}.png`);
      try {
        await buildStillFn(dir, manifest, t.sourceSec, scratchPath);
        result = await runOcrFn(scratchPath, manifest.video.screenRegion, {
          languages,
          warn: (msg) => console.warn(`警告: ${msg}`),
        });
      } finally {
        if (existsSync(scratchPath)) rmSync(scratchPath);
      }
      if (result !== null) {
        writeFileSync(ocrPath, JSON.stringify({ key: layer1Key, result }, null, 2));
      }
    }
    if (result !== null) ocrAvailable = true;
    samples.push({
      outSec: t.outSec,
      sourceSec: t.sourceSec,
      sceneScore: t.sceneScore,
      lines: result !== null ? normalizeOcrLines(result) : null,
      raw: result,
    });
  }

  const foldCfg: ScreenSegmentCfg = {
    mergeThreshold: screenCfg.mergeThreshold,
    sceneThreshold: screenCfg.sceneThreshold,
    minSegmentSec: screenCfg.minSegmentSec,
    indexLines: screenCfg.indexLines,
  };
  const segments = foldScreenSegments(samples, foldCfg);

  // P4 §2.2: `--summarize` は代表 still を要求するので `--stills` を暗黙に
  // 含意する(still が無ければその場で撮る)
  const effectiveStills = opts.stills === true || opts.summarize === true;
  if (effectiveStills) mkdirSync(join(outDir, SCREEN_STILLS_SUBDIR), { recursive: true });

  const segmentsOut: ScreenSegmentOut[] = [];
  for (const seg of segments) {
    const rep = samples[seg.representativeIndex];
    let still: string | null = null;
    if (effectiveStills) {
      const stillRelPath = join(SCREEN_STILLS_SUBDIR, `${seg.id}.png`);
      await buildStillFn(dir, manifest, rep.sourceSec, join(dir, SCREEN_DIR, stillRelPath));
      still = stillRelPath;
    }
    // ocr.lines は正規化前の生テキスト・先頭 indexLines 件(§2.4)
    const ocrOut =
      rep.raw !== null
        ? {
            lines: rep.raw.lines.slice(0, screenCfg.indexLines).map((l) => l.text),
            lineCount: rep.raw.lines.length,
            file: join(SCREEN_OCR_SUBDIR, `${rep.sourceSec.toFixed(2)}.json`),
          }
        : null;
    segmentsOut.push({
      id: seg.id,
      sourceSec: seg.sourceSec,
      endSourceSec: seg.endSourceSec,
      outSec: seg.outSec,
      endOutSec: seg.endOutSec,
      lenSec: seg.lenSec,
      sampleCount: seg.sampleCount,
      absorbed: seg.absorbed,
      sceneScore: seg.sceneScore,
      boundary: seg.boundary,
      representativeSourceSec: rep.sourceSec,
      still,
      ocr: ocrOut,
      summary: null,
    });
  }

  const index: ScreenIndex = {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    key: layer2Key,
    range: motion.range,
    ocrAvailable,
    params,
    segments: segmentsOut,
    warnings: [],
  };

  // video-perception-P4: 旧 index.json(この書き込みで上書きされる前の内容)
  // をここで読む。§2.4.1 の representativeSourceSec 引き継ぎは「新しい
  // index.json を書く直前の状態」が旧区間の定義そのものなので、この
  // タイミングでしか正しく読めない
  if (opts.summarize === true) {
    await summarizeSegments(dir, index, screenCfg.summarize, cfg, opts, deps, indexPath);
  }

  writeFileSync(indexPath, JSON.stringify(index, null, 2));

  // §2.5.4 mark-and-sweep: 今回の実行で使ったサンプル秒(times 由来。代表以外の
  // サンプルも含む=次回 mergeThreshold だけを変えて再実行したときに全サンプルの
  // Layer 1 ヒットを保つため。C2/C3 の前提)だけを ocr/ に残す
  const keepFiles = new Set(times.map((t) => `${t.sourceSec.toFixed(2)}.json`));
  let swept = 0;
  for (const f of readdirSync(ocrDir)) {
    if (!f.endsWith(".json")) continue;
    if (keepFiles.has(f)) continue;
    rmSync(join(ocrDir, f));
    swept++;
  }
  console.log(
    `screen: ${segmentsOut.length} 区間 / OCR ${ocrAvailable ? "利用可能" : "非対応環境(sceneScoreのみ)"}` +
      (swept > 0 ? ` / 未参照の OCR キャッシュ ${swept} 件を削除` : ""),
  );
  console.log(`screen: ${((Date.now() - startedAt) / 1000).toFixed(1)}s で完了`);

  return index;
}

/** 旧 index.json から `representativeSourceSec → summary` の引き継ぎ元を読む
 * (P4 §2.4.1)。ファイルが無い/壊れている/`--force` のときは空(優雅な劣化。
 * 「未実行は異常ではない」と同じ姿勢) */
function readInheritedSummaries(indexPath: string, opts: ScreenOptions): Map<number, ScreenSummary> {
  if (opts.force === true) return new Map(); // §2.4.1: --force は引き継がず全再生成(T13)
  if (!existsSync(indexPath)) return new Map();
  try {
    const old = JSON.parse(readFileSync(indexPath, "utf8")) as {
      segments?: Array<{ representativeSourceSec?: unknown; summary?: unknown }>;
    };
    const rows = (old.segments ?? [])
      .filter((s): s is { representativeSourceSec: number; summary: unknown } => typeof s.representativeSourceSec === "number")
      .map((s) => ({
        representativeSourceSec: s.representativeSourceSec,
        summary: (s.summary ?? null) as ScreenSummary | null,
      }));
    return buildInheritedSummaryMap(rows);
  } catch {
    return new Map();
  }
}

/**
 * video-perception-P4: `index.segments[].summary` を VLM で埋める(I/O 層。
 * 純関数は screenSummary.ts)。優雅な劣化(§2.5)を実装する:
 *   - vision route 未設定 / AI 未設定 → 警告のうえ 0 回呼び出しで return(決定論のまま)
 *   - capability 不足(structuredOutput=none / imageInput=false)の
 *     AiProviderError → 1区間目で捕捉し打ち切る(以降の区間を呼ばない)
 *   - それ以外の呼び出し失敗・JSON パース失敗・R1〜R3 抵触
 *     → その区間だけ summary: null + warnings に積んで続行
 * `index` と `index.warnings` を直接書き換える(呼び出し側が writeFileSync する)。
 */
async function summarizeSegments(
  dir: string,
  index: ScreenIndex,
  summarizeCfg: { maxSegments: number; maxOutputTokens: number },
  cfg: Config,
  opts: ScreenOptions,
  deps: ScreenDeps,
  indexPath: string,
): Promise<void> {
  const inherited = readInheritedSummaries(indexPath, opts);

  // §2.4.1: representativeSourceSec が一致する旧区間から引き継ぐ(VLM を呼ばない)
  const candidates: ScreenSegmentOut[] = [];
  for (const seg of index.segments) {
    const prior = inherited.get(seg.representativeSourceSec);
    if (prior) {
      seg.summary = prior;
      continue;
    }
    candidates.push(seg);
  }
  if (candidates.length === 0) return;

  // §2.7: maxSegments 超過時は長い区間を優先し、切った件数を stdout に出す
  const { selected, droppedCount } = selectSummarizeTargets(candidates, summarizeCfg.maxSegments);
  if (droppedCount > 0) {
    console.log(
      `screen --summarize: 上限 ${summarizeCfg.maxSegments} 区間のため ${droppedCount} 区間を要約対象から除外しました(長い区間を優先)`,
    );
  }
  if (selected.length === 0) return;

  // §2.5: vision route 未設定 / AI 全体が未設定 → 警告のうえ決定論のまま exit 0
  // (0 回呼び出し。resolveAiRuntimeConfig を直接見て、completeAi を1回も
  // 呼ばずに判定する。source==="unconfigured" は AI 鍵が無い場合も含む)
  const runtime = resolveAiRuntimeConfig(cfg);
  if (!runtime.routes.vision || runtime.source === "unconfigured") {
    const msg = "screen --summarize: ai.routes.vision が未設定のため VLM を実行していません(summary は null のまま)";
    console.warn(`警告: ${msg}`);
    index.warnings.push(msg);
    return;
  }

  console.log(`screen --summarize: ${selected.length} 区間へ VLM を呼びます`);
  const completeAiFn = deps.completeAi ?? completeAiDefault;
  const schema = { name: SCREEN_SUMMARY_SCHEMA_NAME, strict: true as const, schema: screenSummaryResponseSchema() };

  let summarized = 0;
  let discarded = 0;
  for (const seg of selected) {
    if (!seg.still) {
      // effectiveStills により通常は必ず埋まっているはずだが、念のための防波堤
      index.warnings.push(`区間 ${seg.id} の要約をスキップしました(still がありません)`);
      continue;
    }
    const imagePath = join(dir, SCREEN_DIR, seg.still);
    const ocrLines = seg.ocr?.lines ?? [];
    const prompt = buildScreenSummaryPrompt(ocrLines);
    try {
      const response = await completeAiFn(
        {
          route: "vision",
          purpose: "vision-review",
          parts: [
            { type: "text", text: prompt },
            { type: "image", file: imagePath, mediaType: "image/png", label: seg.id },
          ],
          output: { kind: "json-schema", format: schema },
          maxOutputTokens: summarizeCfg.maxOutputTokens,
        },
        cfg,
      );
      const parsed = parseScreenSummaryResponse(response.text);
      const check = checkSummaryText(parsed.text);
      if (!check.ok) {
        index.warnings.push(`区間 ${seg.id} の要約を破棄しました(${check.rule})`);
        discarded++;
        continue;
      }
      seg.summary = {
        text: parsed.text,
        confidence: parsed.confidence,
        provenance: {
          profile: response.profile,
          adapter: response.adapter,
          model: response.model,
          observedAt: new Date().toISOString(),
        },
      };
      summarized++;
    } catch (error) {
      // capability 不足(structuredOutput=none / imageInput=false)は1区間目で
      // 捕捉して以降を打ち切る(§2.5・T10)。それ以外は個別失敗として続行する
      if (error instanceof AiProviderError && error.code === "capability") {
        const msg = `screen --summarize: ${error.message}。以降の区間の要約を打ち切ります(決定論のみ)`;
        console.warn(`警告: ${msg}`);
        index.warnings.push(msg);
        break;
      }
      index.warnings.push(`区間 ${seg.id} の要約に失敗しました: ${(error as Error).message}`);
    }
  }
  console.log(`screen --summarize: 完了(${summarized} 区間を要約 / ${discarded} 区間を後段検証で破棄)`);
}

/** stdout 用の1行要約(formatAvSummary と同じ形。probe が使う) */
export function formatScreenSummary(index: ScreenIndex): string[] {
  const lines: string[] = [
    `screen: ${index.segments.length}区間 / OCR ${index.ocrAvailable ? "利用可能" : "非対応環境"}`,
  ];
  return lines;
}
