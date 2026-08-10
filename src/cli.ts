#!/usr/bin/env node
import { cliCmd } from "./lib/cliName.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Help } from "commander";
import { commandSummaries, formatCommandList, formatRootHelp } from "./lib/cliHelp.ts";
import { backupEditableFiles } from "./lib/backup.ts";
import { EDITABLE_FILES } from "./lib/files.ts";
import { guardRerun } from "./lib/rerunGuard.ts";
import {
  clearCutplanApproval,
  writeCutplanApproval,
} from "./lib/approval.ts";
import {
  aiProfileStatuses,
  formatPerceptionStatusLines,
  formatStyleProfileStatusLines,
  loadConfig,
  resolvePerceptionStatus,
  resolveStyleProfileStatus,
  resolveConfigPath,
  resolveLogCfg,
  resolvePlanLoopSecondaryObservationCfg,
  resolveAiRuntimeConfig,
  AI_UNCONFIGURED_MESSAGE,
} from "./lib/config.ts";
import { editorLogFilePath, liveEditor, startDetachedEditor, stopEditor } from "./lib/editorServe.ts";
import { setLogLevel } from "./lib/obs.ts";
import type { LogLevel } from "./lib/obs.ts";
import { timed } from "./lib/timing.ts";
import { BASE_LAYOUTS, CANVAS_SIZES, isBaseLayoutPreset, isCanvasPreset } from "./lib/profile.ts";
import { findSource } from "./lib/findSource.ts";
import { ingest } from "./stages/ingest.ts";
import { deriveProject, parseDeriveRange } from "./stages/derive.ts";
import { transcribe } from "./stages/transcribe.ts";
import { detect } from "./stages/detect.ts";
import { plan, remeta } from "./stages/plan.ts";
import { runDraft } from "./stages/runDraft.ts";
import { planMaterials } from "./stages/planMaterials.ts";
import { planEffects } from "./stages/planEffects.ts";
import { autoZoom, autoZoomIfFresh } from "./stages/autoZoom.ts";
import { planBgm } from "./stages/planBgm.ts";
import { probe as runProbe } from "./stages/probe.ts";
import { draft as runDomainDraft } from "./stages/draft.ts";
import { check as runCheck } from "./stages/check.ts";
import { authorHyperframe, renderHyperframe } from "./stages/hyperframe.ts";
import { embedLottieHyperframe } from "./stages/hyperframeLottie.ts";
import { formatHyperframeBackends, hyperframeBackends } from "./lib/hyperframeBackends.ts";
import { loadHyperframeAssetInputs } from "./lib/hyperframeAssets.ts";
import { formatPlaceReport, hyperframePlace } from "./stages/hyperframePlace.ts";
import { auditHyperframe, formatHyperframeAuditReport } from "./stages/hyperframeAudit.ts";
import { formatFreezeReport, freezeHyperframe } from "./stages/hyperframeFreeze.ts";
import { learn } from "./stages/learn.ts";
import { preview } from "./stages/preview.ts";
import { render } from "./stages/render.ts";
import { validate } from "./stages/validate.ts";
import { assert as assertProject } from "./stages/assert.ts";
import { idStamp } from "./stages/idStamp.ts";
import { applyEdits, planApply } from "./lib/applyEdits.ts";
import { describe, describeJson } from "./stages/describe.ts";
import { frames } from "./stages/frames.ts";
import type { FrameRequest } from "./stages/frames.ts";
import { DEFAULT_SERVE_PORT, startFramesServe } from "./stages/framesServe.ts";
import { startRecordWatch } from "./stages/record.ts";
import { tryServeFrames } from "./lib/framesClient.ts";
import { formatOcrPreview } from "./lib/ocr.ts";
import type { OcrResult } from "./lib/ocr.ts";
import { thumbnail } from "./stages/thumbnail.ts";
import { formatMaterialsSummary, materials } from "./stages/materials.ts";
import { formatMaterialFitReport, materialFit } from "./stages/materialFit.ts";
import { effectCheck, formatEffectCheckReport } from "./stages/effectCheck.ts";
import { av, formatAvSummary } from "./stages/av.ts";
import { formatScreenSummary, screen } from "./stages/screen.ts";
import { bgmFit, formatBgmFitReport } from "./stages/bgmFit.ts";
import { styleProfile, formatStyleProfileReport } from "./stages/styleProfile.ts";
import { styleCheck, formatStyleCheckReport } from "./stages/styleCheck.ts";
import { reviewEdit } from "./stages/review.ts";
import { aiDoctor } from "./stages/aiDoctor.ts";
import { readEditSnapshot } from "./lib/renderSnapshot.ts";
import { fmtT, parseT } from "./lib/fmt.ts";
import type { ApplyPatch, CutPlan, Overlays, Region } from "./types.ts";
import type { EditSnapshot, ReviewSpec } from "./lib/review.ts";
import { buildRetrievalIndex } from "./stages/retrievalIndex.ts";
import { retrievalSearch } from "./stages/retrievalSearch.ts";
import type { AiRoute, Config } from "./lib/config.ts";
import { envDoctor, formatDoctorReport } from "./stages/doctor.ts";
import { planCleanWithRemuxDup, executeClean, formatCleanReport } from "./stages/clean.ts";
import { boundaryCheck, formatBoundaryCheckReport } from "./stages/boundaryCheck.ts";
import { formatSilenceSweepReport, silenceSweep } from "./stages/silenceSweep.ts";
import { floorCalibration, formatFloorCalibrationReport } from "./stages/floorCalibration.ts";
import { boundaryDirection, formatBoundaryDirectionReport } from "./stages/boundaryDirection.ts";
import { compactionSweep, formatCompactionSweepReport } from "./stages/compactionSweep.ts";
import { calibrationEvaluate, formatCalibrationEvaluateReport } from "./stages/calibrationEvaluate.ts";

const program = new Command();
program
  .name("framewright")
  .description(
    "撮影後の編集を自動化するパイプライン(文字起こし→カット案→人間承認→レンダー)",
  )
  .option("--config <path>", "config.yaml のパス")
  .option("-v, --verbose", "外部ツール(ffmpeg/whisper/remotion)まで stderr に出す")
  .option("-q, --quiet", "workflow ログを抑止する(エラーは除く)")
  .helpOption("-h, --help", "ヘルプを表示する");

// ヘルプは2段構え(理由と分類は src/lib/cliHelp.ts)。ルートだけ短い案内へ
// 差し替え、各コマンドの `--help` は commander 既定のまま(詳細な
// .description() と全オプションが要るのはそちら)。
program.configureHelp({
  formatHelp(cmd, helper) {
    if (cmd !== program) return Help.prototype.formatHelp.call(helper, cmd, helper);
    const terms = helper.visibleOptions(cmd).map((o) => helper.optionTerm(o));
    const width = Math.max(...terms.map((t) => t.length)) + 3;
    const lines = helper
      .visibleOptions(cmd)
      .map((o) => helper.optionTerm(o).padEnd(width) + helper.optionDescription(o));
    return formatRootHelp(cliCmd(), lines);
  },
});

/** グローバル --verbose/--quiet・環境変数 FRAMEWRIGHT_LOG・config.yaml の log.level から
 *  ログレベルを解決する(優先順位: flag > env > config > 既定 normal)。
 *  config 読み込み失敗はここでは無視する(コマンド本体の loadConfig が本エラーを出す) */
function resolveCliLogLevel(): LogLevel {
  const opts = program.opts();
  if (opts.quiet === true) return "quiet";
  if (opts.verbose === true) return "verbose";
  const env = process.env.FRAMEWRIGHT_LOG;
  if (env === "quiet" || env === "normal" || env === "verbose") return env;
  try {
    return resolveLogCfg(loadConfig(opts.config)).level;
  } catch {
    return "normal";
  }
}

// 全コマンド共通の所要時間表示(フェーズ0: docs/perf.md のベースライン計測用)。
// render 等の内訳(loudnorm実測/ffmpeg cut/Remotion)は各ステージ側で
// src/lib/timing.ts の timed() を使って個別に出す
let commandStartedAt = 0;
program.hook("preAction", () => {
  commandStartedAt = Date.now();
  setLogLevel(resolveCliLogLevel());
});
program.hook("postAction", (_thisCommand, actionCommand) => {
  // `commands` はヘルプの続き(何も実行していない)なので所要時間を出さない
  if (actionCommand.name() === "commands") return;
  const sec = ((Date.now() - commandStartedAt) / 1000).toFixed(1);
  const line = `(所要時間: ${sec}秒)`;
  // JSON 射影はパイプ可能な純 JSON を stdout に出すので、診断行だけ stderr へ逃がす。
  // mcp は stdout が JSON-RPC 専用チャネルなので同様に stderr へ逃がす(サーバは
  // 通常 SIGINT まで返らないため多くの場合発火しないが、安全のため明示的に対応)。
  // 他コマンド・散文 describe/assert の stdout は従来どおり console.log(=不変)
  const jsonCommands = new Set([
    "describe", "assert", "doctor", "clean", "boundary-check", "silence-sweep", "floor-calibration",
    "boundary-direction",
    "compaction-sweep", "check",
    "calibration-evaluate", "hyperframe-backends",
  ]);
  const isMcp = actionCommand.name() === "mcp";
  if (isMcp || (jsonCommands.has(actionCommand.name()) && actionCommand.opts().json === true)) {
    console.error(line);
  } else {
    console.log(line);
  }
});

function resolveDir(dir: string): string {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new Error(`フォルダがありません: ${abs}`);
  return abs;
}

function readJsonFile<T>(file: string): T {
  const abs = resolve(file);
  if (!existsSync(abs)) {
    throw new Error(
      `JSONファイルが見つかりません: ${abs}\n` +
      "review specの例: docs/examples/review-spec.json",
    );
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T;
  } catch (error) {
    throw new Error(`JSONファイルを読めません: ${abs}: ${(error as Error).message}`);
  }
}

/** --layout フラグの値を検査する。未指定は undefined(resolveLayout 既定へ委ねる) */
function parseLayoutOpt(v: string | undefined): "obs-canvas" | "plain" | "auto" | "stills" | undefined {
  if (v === undefined) return undefined;
  if (v === "obs-canvas" || v === "plain" || v === "auto" || v === "stills") return v;
  throw new Error(`--layout の値が不正です: ${v}(plain|obs-canvas|auto|stills のいずれか)`);
}

function parseCanvasOpt(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (isCanvasPreset(v)) return v;
  throw new Error(`--canvas の値が不正です: ${v}(${Object.keys(CANVAS_SIZES).join("|")} のいずれか)`);
}

function parseBaseLayoutOpt(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (isBaseLayoutPreset(v)) return v;
  throw new Error(`--base-layout の値が不正です: ${v}(${Object.keys(BASE_LAYOUTS).join("|")} のいずれか)`);
}

/** --mic-track / --system-track を検査して数値へ。未指定は undefined。
 *  1 始まりの正整数のみ許可(0/負/非数はエラーで即停止) */
function parseTrackOpts(
  mic?: string,
  system?: string,
): { micTrack?: number; systemTrack?: number } | undefined {
  const one = (v: string | undefined, label: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`${label} は 1 以上の整数で指定してください: ${v}`);
    }
    return n;
  };
  const micTrack = one(mic, "--mic-track");
  const systemTrack = one(system, "--system-track");
  if (micTrack === undefined && systemTrack === undefined) return undefined;
  return {
    ...(micTrack !== undefined ? { micTrack } : {}),
    ...(systemTrack !== undefined ? { systemTrack } : {}),
  };
}

function parseRangeOpt(v: string | undefined): { startSec: number; endSec: number } | undefined {
  if (v === undefined) return undefined;
  const [startRaw, endRaw] = v.split("-");
  if (startRaw === undefined || endRaw === undefined) {
    throw new Error(`--range の値が不正です: ${v}(例 10-25.5)`);
  }
  const startSec = parseT(startRaw.trim());
  const endSec = parseT(endRaw.trim());
  if (startSec === null || endSec === null || endSec <= startSec) {
    throw new Error(`--range の値が不正です: ${v}(例 10-25.5)`);
  }
  return { startSec, endSec };
}

/**
 * plan-effects の再実行ガード。guardRerun と違い overlays.json 自体の存在では
 * なく、既存の zooms/blurs/annotations が非空かどうかで判定する(overlays.json
 * には plan-materials 等が書いた overlays[] や inserts 等の他フィールドが
 * 単独で存在しうるため、それだけで --force を要求するのは過剰)。
 */
function guardEffectsRerun(dir: string, force: boolean): void {
  const overlaysPath = join(dir, "overlays.json");
  if (!existsSync(overlaysPath)) return;
  const existing = JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays;
  const hasEffects =
    (existing.zooms?.length ?? 0) > 0 ||
    (existing.blurs?.length ?? 0) > 0 ||
    (existing.annotations?.length ?? 0) > 0;
  if (!hasEffects) return;
  if (!force) {
    throw new Error(
      "overlays.json に既存の zooms/blurs/annotations があります。plan-effects の " +
        "再実行はこれらを LLM の生成物で上書きし、手編集が消えます。\n" +
        "やり直す場合は --force を付けてください(実行前に手編集ファイルを " +
        "backups/ へ退避します)",
    );
  }
  const backupList = [...new Set([...EDITABLE_FILES, "overlays.json"])];
  const dest = backupEditableFiles(dir, backupList);
  if (dest) {
    console.log(
      `上書き前に手編集ファイルを退避しました: ${dest}\n` +
        "(戻すには退避先のファイルを収録フォルダ直下へコピーし直す)",
    );
  }
}

/**
 * autozoom の再実行ガード。guardEffectsRerun の zoom だけ版
 * (autozoom は zooms[] しか置換しないため blurs/annotations の非空は無視する)。
 */
function guardAutoZoomRerun(dir: string, force: boolean): void {
  const overlaysPath = join(dir, "overlays.json");
  if (!existsSync(overlaysPath)) return;
  const existing = JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays;
  if ((existing.zooms?.length ?? 0) === 0) return;
  if (!force) {
    throw new Error(
      "overlays.json に既存の zooms があります。autozoom の再実行はこれらを " +
        "上書きし、手編集が消えます。\n" +
        "やり直す場合は --force を付けてください(実行前に手編集ファイルを " +
        "backups/ へ退避します)",
    );
  }
  const backupList = [...new Set([...EDITABLE_FILES, "overlays.json"])];
  const dest = backupEditableFiles(dir, backupList);
  if (dest) {
    console.log(
      `上書き前に手編集ファイルを退避しました: ${dest}\n` +
        "(戻すには退避先のファイルを収録フォルダ直下へコピーし直す)",
    );
  }
}

function printPerceptionStatus(cfg: Parameters<typeof resolvePerceptionStatus>[0]): void {
  for (const line of formatPerceptionStatusLines(resolvePerceptionStatus(cfg))) {
    console.log(line);
  }
}

function printStyleProfileStatus(cfg: Parameters<typeof resolveStyleProfileStatus>[0]): void {
  for (const line of formatStyleProfileStatusLines(resolveStyleProfileStatus(cfg))) {
    console.log(line);
  }
}

function ensurePlanVlmReady(cfg: Parameters<typeof loadConfig>[0] extends never ? never : ReturnType<typeof loadConfig>): { profile: string; origin: string | null; maxCalls: number; maxImages: number } {
  const secondaryCfg = resolvePlanLoopSecondaryObservationCfg(cfg);
  if (!secondaryCfg.enabled) {
    throw new Error("plan.loop.secondaryObservation.enabled=true が必要です");
  }
  const runtime = resolveAiRuntimeConfig(cfg);
  if (runtime.source === "unconfigured") throw new Error(AI_UNCONFIGURED_MESSAGE);
  if (!runtime.routes.vision) {
    throw new Error("vision route が未設定です");
  }
  const status = aiProfileStatuses(cfg).find((item) => item.name === runtime.routes.vision);
  if (!status) {
    throw new Error(`vision profile "${runtime.routes.vision}" が見つかりません`);
  }
  if (!status.capabilities.imageInput) {
    throw new Error(`AI profile "${status.name}" は imageInput=false です`);
  }
  if (status.credential === "missing") {
    throw new Error(`vision profile "${status.name}" の認証情報が見つかりません`);
  }
  return {
    profile: status.name,
    origin: status.origin,
    maxCalls: secondaryCfg.maxCalls,
    maxImages: secondaryCfg.maxImages,
  };
}

program
  .command("commands")
  .description("全コマンドを分類つきで一覧表示する(収録フォルダ不要・read-only)")
  .action(() => {
    console.log(formatCommandList(cliCmd()));
  });

program
  .command("doctor")
  .description(
    "環境プリフライト(read-only): node/ffmpeg/ffprobe/エンコーダ整合/whisper/model/AI 到達性を1コマンドで検査。" +
      "必須(node/ffmpeg/ffprobe)欠落は exit 1、収録/AI 系の欠落は warn(exit 0)。収録フォルダには書かない",
  )
  .option("--json", "DoctorReport を JSON で標準出力に出す(パイプ可)")
  .option("--no-ai", "AI provider 到達性プローブ(ネットワーク)をスキップする")
  .action(async (opts: { json?: boolean; ai?: boolean }) => {
    let cfg: Config | undefined;
    let cfgError: string | undefined;
    try {
      cfg = loadConfig(program.opts().config);
    } catch (e) {
      cfgError = (e as Error).message;
    }
    const report = await envDoctor({ cfg, cfgError, ai: opts.ai !== false });
    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatDoctorReport(report)) console.log(line);
    }
    if (report.exitCode === 1) process.exit(1);
  });

program
  .command("ai")
  .description("AI provider diagnostics")
  .command("doctor")
  .description("AI profile / route の接続確認")
  .option("--profile <name>", "特定profileのみ検査")
  .option("--route <route>", "特定route(text|structured|vision)のみ検査")
  .option("--json", "JSONで出力")
  .action(async (opts: { profile?: string; route?: AiRoute; json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const results = await aiDoctor(cfg, { profile: opts.profile, route: opts.route });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    console.log("PROFILE\tADAPTER\tTEXT\tSTRUCTURED\tIMAGE\tAUTH");
    for (const item of results) {
      console.log([
        item.profile,
        item.adapter,
        item.checks.text.status,
        item.checks.structured.status,
        item.checks.image.status,
        item.checks.credential.status,
      ].join("\t"));
    }
  });

program
  .command("ingest <dir>")
  .description("収録ファイルを解析し manifest.json とマイク音声を生成")
  .option(
    "--layout <layout>",
    "収録レイアウト(plain|obs-canvas|auto)。省略時は plain",
  )
  .option("--canvas <preset>", "出力キャンバス(作成時固定)")
  .option("--base-layout <kind>", "ベース映像配置(auto|screen|camera|stack、作成時固定)")
  .option("--mic-track <n>", "マイク音声のトラック番号(1始まり)。config を一時上書き")
  .option("--system-track <n>", "システム音声のトラック番号(1始まり)。config を一時上書き")
  .action(async (dir: string, opts: { layout?: string; canvas?: string; baseLayout?: string; micTrack?: string; systemTrack?: string }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const layout = parseLayoutOpt(opts.layout);
    const tracks = parseTrackOpts(opts.micTrack, opts.systemTrack);
    const canvas = parseCanvasOpt(opts.canvas);
    const baseLayout = parseBaseLayoutOpt(opts.baseLayout);
    const m = await ingest(abs, findSource(abs), cfg, layout, tracks, canvas, baseLayout);
    console.log(
      `ingest 完了: ${m.durationSec.toFixed(1)}秒 / ` +
        `${m.video.width}x${m.video.height} ${m.video.fps.toFixed(0)}fps / ` +
        `音声${m.audio.systemStream !== null ? "2" : "1"}トラック`,
    );
  });

program
  .command("derive <dir>")
  .description("元メディアと transcript を共有する派生プロジェクトを作成")
  .requiredOption("--name <name>", "新しいプロジェクトのフォルダ名")
  .requiredOption("--canvas <preset>", "派生先の出力キャンバス")
  .option("--base-layout <kind>", "派生先のベース映像配置(auto|screen|camera|stack)")
  .requiredOption(
    "--range <start-end>",
    "元収録秒の採用範囲(複数指定可)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(async (dir: string, opts: { name: string; canvas: string; baseLayout?: string; range: string[] }) => {
    if (opts.range.length === 0) throw new Error("--range を1つ以上指定してください");
    const cfg = loadConfig(program.opts().config);
    const result = await deriveProject({
      sourceDir: resolveDir(dir),
      name: opts.name,
      canvas: parseCanvasOpt(opts.canvas)!,
      baseLayout: parseBaseLayoutOpt(opts.baseLayout),
      ranges: opts.range.map(parseDeriveRange),
      cfg,
    }, { log: console.log });
    console.log(`派生プロジェクトを作成しました: ${result.dir}`);
  });

program
  .command("transcribe <dir>")
  .description("whisper.cpp でマイク音声を文字起こし(transcript.json / .srt)")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    // 再実行はテロップの手編集(文言修正・位置・章トラック)ごと上書きする
    // ので、既存の transcript.json は退避してから書き直す
    const dest = backupEditableFiles(abs, ["transcript.json"]);
    if (dest) console.log(`既存の transcript.json を退避しました: ${dest}`);
    const t = await transcribe(abs, cfg);
    console.log(`transcribe 完了: ${t.segments.length}セグメント`);
  });

program
  .command("detect <dir>")
  .description("無音区間を検出しカット候補を生成(cuts.auto.json)")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const c = await detect(resolveDir(dir), cfg);
    const saved = c.originalDurationSec - c.keptDurationSec;
    console.log(
      `detect 完了: 無音${c.silences.length}箇所 / ` +
        `${c.originalDurationSec}秒 → ${c.keptDurationSec}秒(${saved.toFixed(1)}秒削減)`,
    );
  });

program
  .command("plan <dir>")
  .description("LLM で意味カット・章立て・タイトル案を生成(cutplan.json ほか)")
  .option(
    "--force",
    "既存の cutplan / chapters / meta を上書きして再実行(実行前に backups/ へ退避)",
  )
  .option(
    "--cuts-only",
    "カット判断だけを行い cutplan.json / plan.raw.txt だけを書く" +
      "(chapters / meta / transcript の章テロップ / overlays の章トラックには触らない)",
  )
  .option("--with-vlm", "VLM二次観測を明示的に有効化(cuts-only loop 専用)")
  .action(async (dir: string, opts: { force?: boolean; cutsOnly?: boolean; withVlm?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const cutsOnly = opts.cutsOnly === true;
    if (opts.withVlm === true && !cutsOnly) {
      throw new Error("--with-vlm は --cuts-only と一緒に指定してください");
    }
    guardRerun(
      abs,
      cutsOnly ? ["cutplan.json"] : ["cutplan.json", "chapters.json", "meta.json"],
      opts.force === true,
      "plan",
    );
    printPerceptionStatus(cfg);
    printStyleProfileStatus(cfg);
    if (opts.withVlm === true) {
      const vlm = ensurePlanVlmReady(cfg);
      console.error(
        `VLM二次観測: profile=${vlm.profile} origin=${vlm.origin ?? "local"} 最大${vlm.maxCalls}回 / 各${vlm.maxImages}枚`,
      );
    }
    const p = await plan(abs, cfg, { cutsOnly, withVlm: opts.withVlm === true });
    printPlanSummary(p.segments);
  });

program
  .command("remeta <dir>")
  .description(
    "章立て・タイトル案・概要欄だけを LLM で作り直す(cutplan は触らない。カット手編集後の再生成用)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    // 章タイトル(「章」トラックのテロップ)と chapters / meta を作り直すので、
    // 上書き前に手編集ファイルを退避する(cutplan は読むだけで触らない)
    const dest = backupEditableFiles(abs, [
      "transcript.json",
      "chapters.json",
      "meta.json",
    ]);
    if (dest) console.log(`上書き前に手編集ファイルを退避しました: ${dest}`);
    printPerceptionStatus(cfg);
    console.log("remeta 実行中(LLM で章立て・タイトル案を生成)...");
    const m = await remeta(abs, cfg);
    console.log(`remeta 完了: タイトル案 ${m.titles.length}件`);
    for (const t of m.titles) console.log(`  ${t}`);
  });

program
  .command("plan-materials <dir>")
  .description(
    "LLM で素材(B-roll)の配置候補を選ばせ overlays.json の下書きを生成" +
      "(要 materials <dir> --all の事前実行。cut/承認には触れない)",
  )
  .option(
    "--force",
    "既存の overlays.json を上書きして再実行(実行前に backups/ へ退避)",
  )
  .action(async (dir: string, opts: { force?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    guardRerun(abs, ["overlays.json"], opts.force === true, "plan-materials");
    console.log("plan-materials 実行中(LLM で素材配置候補を選定)...");
    const result = await planMaterials(abs, cfg);
    console.log(
      `plan-materials 完了: アンカー${result.anchorCount}件 / 素材${result.choiceCount}件から` +
        `${result.placed.length}件を overlays[] へ下書き`,
    );
    for (const o of result.placed) {
      console.log(`  [${o.start.toFixed(2)}-${o.end.toFixed(2)}] ${o.file}`);
    }
    console.log(
      "\n次のステップ: preview か GUI エディタで確認し、要らなければ overlays.json から削除してください。",
    );
  });

program
  .command("probe <dir>")
  .description("知覚層をまとめて実行する(materials.probe/ と av.probe/ と screen.probe/。--style は明示時のみ)")
  .option("--materials", "素材(B-roll)を知覚する")
  .option("--av", "keep 後タイムラインの motion/sound を知覚する")
  .option("--screen", "本編画面の状態トラックを作る(要 av の事前実行。--all 内では自動的に av の後)")
  .option("--style", "style-profile --from <dir> を実行する(--all には含まれない)")
  .option("--all", "materials + av + screen を実行する(--style は含めない)")
  .option("--deep", "materials で frames/OCR/transcribe まで実行する")
  .action(async (
    dir: string,
    opts: { materials?: boolean; av?: boolean; screen?: boolean; style?: boolean; all?: boolean; deep?: boolean },
  ) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const ran = await runProbe(abs, cfg, { ...opts, onLine: (line) => console.log(line) });
    console.log(`probe 完了: ${ran.join(", ") || "なし"}`);
  });

program
  .command("draft <dir>")
  .description("下書き層をまとめて実行する(overlays.json / bgm.json。cutplan と approvals には触れない)")
  .option("--materials", "素材配置を下書きする")
  .option("--effects", "演出を下書きする")
  .option("--bgm", "BGM 配置を下書きする")
  .option("--zoom", "cursor dwell から zoom を下書きする(--all には含めない)")
  .option("--all", "materials + effects + bgm を実行する(--zoom は含めない)")
  .option("--force", "各段の既存出力を上書きする")
  .action(async (
    dir: string,
    opts: { materials?: boolean; effects?: boolean; bgm?: boolean; zoom?: boolean; all?: boolean; force?: boolean },
  ) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const ran = await runDomainDraft(abs, cfg, opts);
    console.log(`draft 完了: ${ran.join(", ") || "なし"}`);
  });

program
  .command("check <dir>")
  .description("検品層をまとめて実行する。--fix なしでは編集ファイルを変更しない")
  .option("--materials", "素材の尺不整合・未使用/参照切れを検品する")
  .option("--effects", "演出を検品する")
  .option("--bgm", "BGM を検品する")
  .option("--style", "学習済み style profile からの逸脱を検品する")
  .option("--boundary", "keep 終端の語尾食いを検品する")
  .option("--all", "全検品を実行する(前提エラーの domain は warn してスキップ)")
  .option("--no-vlm", "effect check の VLM 二次確認をスキップする")
  .option("--json", "実行結果の要約 JSON を標準出力に出す")
  .option("--fix", "生成された apply パッチ下書きの安全な補正だけ適用する")
  .option("--dry-run", "--fix の適用内容を検査し、書き込まない")
  .option("--profile <name>", "style-check の参照 profile 名")
  .action(async (
    dir: string,
    opts: {
      materials?: boolean;
      effects?: boolean;
      bgm?: boolean;
      style?: boolean;
      boundary?: boolean;
      all?: boolean;
      vlm?: boolean;
      json?: boolean;
      fix?: boolean;
      dryRun?: boolean;
      profile?: string;
    },
  ) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const result = await runCheck(abs, cfg, {
      ...opts,
      noVlm: opts.vlm === false,
      onLine: (line) => opts.json === true ? console.error(line) : console.log(line),
      onWarn: (line) => opts.json === true ? console.error(`警告: ${line}`) : console.warn(`警告: ${line}`),
    });
    if (opts.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`check 完了: ${result.ran.join(", ") || "なし"}`);
    for (const item of result.fixed) {
      console.log(`fix ${item.file}: ${item.status}${item.changedFiles.length > 0 ? ` (${item.changedFiles.join(", ")})` : ""}`);
    }
  });

program
  .command("hyperframe-backends")
  .description("HyperFrames backend の利用状態を表示する(収録フォルダ不要・read-only)")
  .option("--json", "固定 schemaVersion の機械可読 JSON を標準出力に出す")
  .action((opts: { json?: boolean }) => {
    const report = hyperframeBackends();
    if (opts.json === true) console.log(JSON.stringify(report, null, 2));
    else console.log(formatHyperframeBackends(report));
  });

program
  .command("hyperframe <dir>")
  .description(
    "HyperFrames カード(無音の作図素材)を生成・render する。native HyperFrames interpreter で" +
      "check ゲート通過済みの composition だけを render する(cut/承認には触れない)",
  )
  .requiredOption("--name <name>", "カード名(出力ファイル名の元。英数字・.・_・- のみ)")
  .option(
    "--from-brief",
    "brief.md/rules.md から LLM で composition HTML の下書きを書く(hyperframes/<name>.html。render はしない)",
  )
  .option(
    "--embed-lottie <path>",
    "AE/bodymovin JSON と外部画像を SVG/byte Lottie composition HTML に埋め込む(render はしない)",
  )
  .option(
    "--asset <path>",
    "カードへ焼き込む画像(PNG/JPEG/GIF/WebP)またはフォント(WOFF2。--from-brief 専用、複数指定可)",
    collectFrom,
    [],
  )
  .option("--pattern <n>", "作図パターン番号を指定する(--from-brief 専用。省略時は LLM が選ぶ)")
  .option("--var <kv...>", "composition variables の上書き(k=v。複数指定可。render 専用)")
  .option(
    "--width <n>",
    "出力幅px(--from-brief 時は下書きの解像度、render 時は composition の data-width を上書き)",
  )
  .option("--height <n>", "出力高さpx(同上)")
  .option("--fps <n>", "出力fps(render 専用。既定30)")
  .option(
    "--durationSec <s>",
    "尺(秒)(--from-brief 時は下書きの尺、render 時は composition の intrinsic duration を上書き)",
  )
  .option(
    "--force",
    "既存の hyperframes/<name>.html(author/import 時)、または既存キャッシュ(render 時)を無視して上書き・再生成",
  )
  .action(
    async (
      dir: string,
      opts: {
        name: string;
        fromBrief?: boolean;
        embedLottie?: string;
        asset: string[];
        pattern?: string;
        var?: string[];
        width?: string;
        height?: string;
        fps?: string;
        durationSec?: string;
        force?: boolean;
      },
    ) => {
      if (!/^[A-Za-z0-9._-]+$/.test(opts.name)) {
        throw new Error(`--name が不正です(英数字・.・_・- のみ使えます): ${opts.name}`);
      }
      const abs = resolveDir(dir);

      const parseNum = (raw: string | undefined, label: string): number | undefined => {
        if (raw === undefined) return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${label} が数値ではありません: ${raw}`);
        return n;
      };

      if (opts.embedLottie !== undefined) {
        if (opts.fromBrief === true) {
          throw new Error("--embed-lottie と --from-brief は同時に指定できません");
        }
        const rejected = [
          ["--pattern", opts.pattern],
          ["--var", opts.var],
          ["--width", opts.width],
          ["--height", opts.height],
          ["--fps", opts.fps],
          ["--durationSec", opts.durationSec],
          ["--asset", opts.asset.length > 0 ? opts.asset : undefined],
        ].filter((entry) => entry[1] !== undefined).map((entry) => entry[0]);
        if (rejected.length > 0) {
          throw new Error(
            `--embed-lottie では source JSON から寸法・fps・尺を決めるため ${rejected.join(", ")} は指定できません`,
          );
        }
        const result = embedLottieHyperframe(abs, {
          name: opts.name,
          lottiePath: opts.embedLottie,
          force: opts.force === true,
        });
        console.log(
          `Lottie composition を書きました: ${result.sourcePath}` +
            `(${result.width}x${result.height}, ${result.frameRate}fps, ${result.durationSec}秒, ` +
            `画像asset ${result.imageAssetCount}件)`,
        );
        console.log(result.summary);
        console.log("\n次のステップ: --embed-lottie 無しで再実行して render してください。");
        return;
      }

      if (opts.fromBrief) {
        const cfg = loadConfig(program.opts().config);
        const sourcePath = join(abs, "hyperframes", `${opts.name}.html`);
        if (existsSync(sourcePath) && !opts.force) {
          throw new Error(
            `${sourcePath} は既にあります。--from-brief の再実行はこれを LLM の生成物で` +
              "上書きします。やり直す場合は --force を付けてください",
          );
        }
        console.log("hyperframe --from-brief 実行中(LLM で composition HTML を下書き)...");
        const result = await authorHyperframe(abs, cfg, {
          name: opts.name,
          pattern: opts.pattern !== undefined ? Number(opts.pattern) : undefined,
          width: parseNum(opts.width, "--width"),
          height: parseNum(opts.height, "--height"),
          durationSec: parseNum(opts.durationSec, "--durationSec"),
          assets: loadHyperframeAssetInputs(opts.asset),
        });
        console.log(`下書きを書きました: ${result.sourcePath}(variables ${result.varCount}件)`);
        console.log(result.summary);
        console.log(
          "\n次のステップ: 内容を確認し(必要なら手編集し)、--from-brief 無しで再実行して" +
            "render してください。",
        );
        return;
      }

      if (opts.asset.length > 0) {
        throw new Error("--asset は --from-brief と一緒に指定してください");
      }

      const cliVars: Record<string, unknown> = {};
      for (const kv of opts.var ?? []) {
        const eq = kv.indexOf("=");
        if (eq === -1) throw new Error(`--var の形式が不正です(k=v が必要): ${kv}`);
        cliVars[kv.slice(0, eq)] = kv.slice(eq + 1);
      }

      const overrides = {
        width: parseNum(opts.width, "--width"),
        height: parseNum(opts.height, "--height"),
        fps: parseNum(opts.fps, "--fps"),
        durationSec: parseNum(opts.durationSec, "--durationSec"),
      };

      const result = await renderHyperframe(abs, {
        name: opts.name,
        cliVars,
        overrides,
        force: opts.force === true,
      });

      const shortSha = result.sha256.slice(0, 12);
      if (result.skipped) {
        console.log(
          `再利用(変更なし): ${result.outPath}(${result.frames}フレーム, sha256=${shortSha}, tier: ${result.tier})`,
        );
      } else {
        console.log(`render 完了: ${result.outPath}(${result.frames}フレーム, sha256=${shortSha})`);
        if (result.identical !== undefined) {
          if (result.determinismMessage !== undefined) {
            // --force かつ前回と入力が同じだった: tier に応じた決定論判定
            // (byte 一致/不一致・perceptual の YMAX 判定)を報告する
            console.log(`(--force で再生成) ${result.determinismMessage}`);
          } else if (result.identical) {
            console.log(`(--force で再生成。内容は前回と byte 一致。tier: ${result.tier})`);
          } else {
            console.log(
              "(--force で再生成。決定論判定はスキップ(前回と入力が異なる、または計測に失敗)。" +
                "内容が変わりました)",
            );
          }
        }
      }
    },
  );

program
  .command("hyperframe-place <dir>")
  .description(
    "HyperFrames カード(materials/hyperframes/<name>.mp4。要 hyperframe <dir> --name の事前 render)を " +
      "overlays.json の overlay/insert として配置する apply パッチ下書き(hyperframe-place.suggested.json)を書く" +
      "(尺は --duration か hyperframe.<name>.key.json か ffprobe から決定論的に解決。cut/承認には触れない)",
  )
  .requiredOption("--name <name>", "HyperFrames カード名(materials/hyperframes/<name>.mp4 の元)")
  .requiredOption("--at <sec>", "配置位置(元収録の秒)")
  .option("--as <kind>", "overlay(既定)または insert", "overlay")
  .option("--duration <s>", "尺(秒)の明示指定。省略時は hyperframe.<name>.key.json → ffprobe の順に解決")
  .option("--rect <x,y,w,h>", "表示領域(出力px)。overlay 専用")
  .option("--track <n>", "素材トラック番号(1始まり)。overlay 専用")
  .option("--fade <s>", "フェードイン/アウト秒(両方に同じ値)")
  .option("--start-from <s>", "素材の頭出し(In点。秒)")
  .action(
    async (
      dir: string,
      opts: {
        name: string;
        at: string;
        as?: string;
        duration?: string;
        rect?: string;
        track?: string;
        fade?: string;
        startFrom?: string;
      },
    ) => {
      if (!/^[A-Za-z0-9._-]+$/.test(opts.name)) {
        throw new Error(`--name が不正です(英数字・.・_・- のみ使えます): ${opts.name}`);
      }
      const as = opts.as ?? "overlay";
      if (as !== "overlay" && as !== "insert") {
        throw new Error(`--as は overlay か insert です: ${as}`);
      }

      const parseNum = (raw: string | undefined, label: string): number | undefined => {
        if (raw === undefined) return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${label} が数値ではありません: ${raw}`);
        return n;
      };

      const at = parseNum(opts.at, "--at");
      if (at === undefined) throw new Error("--at が必要です");

      let rect: Region | undefined;
      if (opts.rect !== undefined) {
        const parts = opts.rect.split(",").map((s) => Number(s.trim()));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
          throw new Error(`--rect の形式が不正です(x,y,w,h の4つの数値が必要): ${opts.rect}`);
        }
        rect = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
      }

      const abs = resolveDir(dir);
      const result = await hyperframePlace(abs, {
        name: opts.name,
        at,
        as,
        durationSec: parseNum(opts.duration, "--duration"),
        rect,
        fadeSec: parseNum(opts.fade, "--fade"),
        track: parseNum(opts.track, "--track"),
        startFrom: parseNum(opts.startFrom, "--start-from"),
      });
      for (const line of formatPlaceReport(abs, result)) console.log(line);
    },
  );

program
  .command("hyperframe-check <dir>")
  .description(
    "HyperFrames カードの render 不要な動的監査(終端未完了(最終フレーム完了進捗)/空終端/画面外要素/seek無反応/dead zone/一斉登場)。" +
      "決定論のみ・常に exit 0・warn/info のみ。render 済み materials/hyperframes/<name>.mp4 があれば " +
      "head/mid/tail + WARN finding 時刻の still を抽出し、vision route があれば任意で VLM 二次確認も行う。" +
      "hyperframe.probe/<name>/index.json に書く(収録フォルダの編集ファイルは一切書かない)",
  )
  .requiredOption("--name <name>", "HyperFrames カード名(hyperframes/<name>.html の元)")
  .option("--no-vlm", "VLM 二次確認をスキップ(決定論チェックのみ)")
  .option("--step <sec>", "サンプル間隔(秒)。省略時 config.yaml の hyperframeCheck.stepSec")
  .option("--var <kv...>", "composition variables の上書き(k=v。複数指定可)")
  .option("--width <n>", "出力幅px(composition の data-width を上書き)")
  .option("--height <n>", "出力高さpx(同上)")
  .option("--fps <n>", "出力fps(既定30)")
  .option("--durationSec <s>", "尺(秒)(composition の intrinsic duration を上書き)")
  .action(
    async (
      dir: string,
      opts: {
        name: string;
        vlm?: boolean;
        step?: string;
        var?: string[];
        width?: string;
        height?: string;
        fps?: string;
        durationSec?: string;
      },
    ) => {
      if (!/^[A-Za-z0-9._-]+$/.test(opts.name)) {
        throw new Error(`--name が不正です(英数字・.・_・- のみ使えます): ${opts.name}`);
      }
      const cfg = loadConfig(program.opts().config);
      const abs = resolveDir(dir);

      const parseNum = (raw: string | undefined, label: string): number | undefined => {
        if (raw === undefined) return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${label} が数値ではありません: ${raw}`);
        return n;
      };

      const cliVars: Record<string, unknown> = {};
      for (const kv of opts.var ?? []) {
        const eq = kv.indexOf("=");
        if (eq === -1) throw new Error(`--var の形式が不正です(k=v が必要): ${kv}`);
        cliVars[kv.slice(0, eq)] = kv.slice(eq + 1);
      }

      const overrides = {
        width: parseNum(opts.width, "--width"),
        height: parseNum(opts.height, "--height"),
        fps: parseNum(opts.fps, "--fps"),
        durationSec: parseNum(opts.durationSec, "--durationSec"),
      };

      const result = await auditHyperframe(abs, cfg, {
        name: opts.name,
        useVlm: opts.vlm !== false,
        stepSec: parseNum(opts.step, "--step"),
        overrides,
        cliVars,
      });
      for (const line of formatHyperframeAuditReport(abs, result)) console.log(line);
    },
  );

program
  .command("hyperframe-freeze <dir>")
  .description(
    "check 済みの HyperFrames カード(hyperframes/<name>.html)から skeletonize した" +
      " DRAFT(hyperframe-freeze.suggested/<name>.{html,md})を書く。channel の" +
      " hyperframe-seeds/ への採用コピーは人間の仕事(cut/承認には触れない)",
  )
  .requiredOption("--name <name>", "HyperFrames カード名(hyperframes/<name>.html の元)")
  .action(async (dir: string, opts: { name: string }) => {
    if (!/^[A-Za-z0-9._-]+$/.test(opts.name)) {
      throw new Error(`--name が不正です(英数字・.・_・- のみ使えます): ${opts.name}`);
    }
    const abs = resolveDir(dir);
    const result = await freezeHyperframe(abs, { name: opts.name });
    for (const line of formatFreezeReport(abs, result)) console.log(line);
  });

program
  .command("plan-effects <dir>")
  .description(
    "LLM で演出(zoom/blur/annotation)の種別を番号選択させ overlays.json の下書きを生成" +
      "(要 frames --ocr / av のいずれかの事前実行。座標は知覚由来。cut/承認には触れない)",
  )
  .option(
    "--force",
    "既存の zooms/blurs/annotations を上書きして再実行(実行前に backups/ へ退避)",
  )
  .option(
    "--observe",
    "前回の effect-check.json の警告を観測(参考情報。命令ではない)として" +
      "プロンプトへ渡す(E7・opt-in。省略時は config.yaml の effectReview.observe に従う)",
  )
  .action(async (dir: string, opts: { force?: boolean; observe?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    guardEffectsRerun(abs, opts.force === true);
    console.log("plan-effects 実行中(LLM で演出候補を選定)...");
    const result = await planEffects(abs, cfg, { observe: opts.observe });
    console.log(
      `plan-effects 完了: アンカー${result.anchorCount}件から ` +
        `zoom${result.zooms.length}件 / blur${result.blurs.length}件 / annotation${result.annotations.length}件を下書き`,
    );
    for (const z of result.zooms) {
      console.log(`  zoom [${z.start.toFixed(2)}-${z.end.toFixed(2)}]`);
    }
    for (const b of result.blurs) {
      console.log(`  blur [${b.start.toFixed(2)}-${b.end.toFixed(2)}]`);
    }
    for (const a of result.annotations) {
      console.log(`  annotation [${a.start.toFixed(2)}-${a.end.toFixed(2)}]`);
    }
    console.log(
      "\n次のステップ: preview か frames <dir> --t <区間の秒> で見え方を確認し、要らなければ overlays.json から削除してください。",
    );
  });

program
  .command("autozoom <dir>")
  .description(
    "カーソル dwell から zoom を決定論で自動配置し overlays.json の zooms を下書き" +
      "(LLM 不使用・要 record --watch 収録・cut/承認には触れない)",
  )
  .option("--force", "既存の zooms を上書きして再実行(実行前に backups/ へ退避)")
  .action(async (dir: string, opts: { force?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    guardAutoZoomRerun(abs, opts.force === true);
    const result = autoZoom(abs, cfg);
    console.log(
      `autozoom 完了: dwell候補${result.candidateCount}件から zoom${result.placedCount}件を下書き` +
        (result.placedCount < result.candidateCount
          ? `(境界クランプで${result.candidateCount - result.placedCount}件を除外)`
          : ""),
    );
    for (const z of result.zooms) {
      console.log(`  zoom [${z.start.toFixed(2)}-${z.end.toFixed(2)}]`);
    }
    console.log(
      "\n次のステップ: preview か frames <dir> --t <区間の秒> で見え方を確認し、要らなければ overlays.json から削除してください。",
    );
  });

program
  .command("plan-bgm <dir>")
  .description(
    "LLM で BGM の配置候補(区間×曲)を選ばせ bgm.json の下書きを生成" +
      "(区間境界は章/大カット境界から決定論、曲は番号選択のみ。cut/承認には触れない)",
  )
  .option(
    "--force",
    "既存の bgm.json を上書きして再実行(実行前に backups/ へ退避)",
  )
  .action(async (dir: string, opts: { force?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    guardRerun(abs, ["bgm.json"], opts.force === true, "plan-bgm");
    console.log("plan-bgm 実行中(LLM で BGM 配置候補を選定)...");
    const result = await planBgm(abs, cfg);
    console.log(
      `plan-bgm 完了: スロット${result.slotCount}件 / 曲${result.choiceCount}件から` +
        `${result.tracks.length}トラックを bgm.json へ下書き` +
        (result.hasChapters ? "" : "(chapters.json 無し。大カット境界のみで区間割り)"),
    );
    for (const t of result.tracks) {
      console.log(`  [${t.start.toFixed(2)}-${t.end.toFixed(2)}] ${t.file}`);
    }
    console.log(
      "\n次のステップ: preview か GUI エディタで確認し、要らなければ bgm.json から削除してください。",
    );
  });

program
  .command("learn <dir>")
  .description(
    "直前の生成案と人間の仕上げを見比べ、次回用のチャンネルルール追記案を生成" +
      "(rules.suggested.md に下書き。channel の rules.md は人間が手で採用)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    console.log("learn 実行中(LLM でルール追記案を生成)...");
    const out = await learn(abs, cfg);
    console.log(`learn 完了: ${out}`);
    console.log(
      "内容を確認し、採用する項目を手で channel の rules.md に追記してください。",
    );
  });

program
  .command("preview <dir>")
  .description("cutplan.json の keep 区間を繋いだ確認用動画を生成(preview.mp4)")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const out = await preview(resolveDir(dir), cfg);
    console.log(`preview 完了: ${out}`);
    console.log(
      "テンポと見せ場を確認し、直したい場合は cutplan.json を編集して再実行してください。",
    );
  });

program
  .command("validate <dir>")
  .description(
    "編集ファイル(cutplan/transcript/overlays 等)の整合性を検査(JSON 編集後に実行)",
  )
  .action((dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const r = validate(resolveDir(dir), cfg);
    for (const w of r.warnings) console.log(`⚠ ${w.file} ${w.where}: ${w.message}`);
    for (const e of r.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
    if (r.errors.length > 0) {
      console.error(
        `\nエラー ${r.errors.length}件` +
          (r.warnings.length > 0 ? ` / 警告 ${r.warnings.length}件` : "") +
          "。上から順に修正して再実行してください。",
      );
      process.exit(1);
    }
    console.log(
      (r.warnings.length > 0 ? `警告 ${r.warnings.length}件(動作はします)\n` : "") +
        `✔ エラーなし: ${r.summary}`,
    );
  });

program
  .command("boundary-check <dir>")
  .description(
    "keep終端直後120msの実音声RMSを収録ごとのノイズ床相対で検品する(read-only・LLM/文字起こし不使用)",
  )
  .option("--json", "決定論的な BoundaryCheckReport JSON を標準出力に出す")
  .action(async (dir: string, opts: { json?: boolean }) => {
    const report = await boundaryCheck(resolveDir(dir));
    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatBoundaryCheckReport(report)) console.log(line);
    }
  });

program
  .command("silence-sweep <dir>")
  .description(
    "silenceDb -35/-40/-45/-50をread-onlyで比較し、語尾食い・削減尺・候補数・人間境界一致を測る",
  )
  .option("--json", "決定論的な SilenceSweepReport JSON を標準出力に出す")
  .action(async (dir: string, opts: { json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const report = await silenceSweep(resolveDir(dir), cfg);
    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatSilenceSweepReport(report)) console.log(line);
    }
  });

program
  .command("floor-calibration <fitDir>")
  .description(
    "silencedetect無音占有率から収録別floorを推定し、人間境界でoffsetをfitしてholdout検証する(read-only)",
  )
  .option("--verify <dir>", "選択offsetを検証する別録画。複数指定可", collectFrom, [])
  .option("--json", "決定論的な FloorCalibrationReport JSON を標準出力に出す")
  .action(async (fitDir: string, opts: { verify: string[]; json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const report = await floorCalibration(
      resolveDir(fitDir),
      opts.verify.map((dir) => resolveDir(dir)),
      cfg,
    );
    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatFloorCalibrationReport(report)) console.log(line);
    }
  });

program
  .command("boundary-direction <dir>")
  .description("承認済みhuman finalと現在設定のdetect keepを比較し、境界修正の方向を分類する(read-only)")
  .option("--json", "決定論的な BoundaryDirectionReport JSON を標準出力に出す")
  .action(async (dir: string, opts: { json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const report = await boundaryDirection(resolveDir(dir), cfg);
    if (opts.json === true) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatBoundaryDirectionReport(report)) console.log(line);
  });

program
  .command("compaction-sweep <dir>")
  .description("較正済み境界thresholdを固定し、無音圧縮の時間3ノブ36条件をread-only比較する")
  .option("--json", "決定論的な CompactionSweepReport JSON を標準出力に出す")
  .action(async (dir: string, opts: { json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const report = await compactionSweep(resolveDir(dir), cfg);
    if (opts.json === true) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatCompactionSweepReport(report)) console.log(line);
  });

program
  .command("calibration-evaluate <dir>")
  .description("V6の固定10 variantをboundary-check同一測定系でread-only比較する(human finalは任意)")
  .option("--json", "決定論的な CalibrationEvaluateReport JSON を標準出力に出す")
  .action(async (dir: string, opts: { json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const report = await calibrationEvaluate(resolveDir(dir), cfg);
    if (opts.json === true) console.log(JSON.stringify(report, null, 2));
    else for (const line of formatCalibrationEvaluateReport(report)) console.log(line);
  });

program
  .command("assert <dir>")
  .description(
    "assertions.json の期待値(意図どおりか)を describe --json 射影と照合(壊れていないかは validate)",
  )
  .option("--json", "AssertReport を JSON で標準出力に出す(パイプ可)")
  .option(
    "--visual",
    "Tier 2(視覚アサーション。frames --ocr と同じ経路で OCR)も評価する。" +
      "既定(付けない場合)は Tier 2 を skip し frames/OCR を一切呼ばない。macOS 専用",
  )
  .action(async (dir: string, opts: { json?: boolean; visual?: boolean }) => {
    const abs = resolveDir(dir);
    const report = await assertProject(abs, { visual: opts.visual === true });
    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.outcomes.length === 0) {
      console.log(
        "アサーションがありません(assertions.json を置くと編集意図を宣言的に検査できます)",
      );
    } else {
      const icon = { pass: "✔", fail: "✖", error: "⚠", skip: "–" } as const;
      for (const o of report.outcomes) {
        const label = o.label ? `${o.label} ` : "";
        console.log(`${icon[o.status]} [${o.type}] ${label}${o.message}`);
      }
      const { pass, fail, skip, error } = report.counts;
      console.log(`\npass ${pass} / fail ${fail} / skip ${skip} / error ${error}`);
    }
    if (report.counts.fail > 0 || report.counts.error > 0) process.exit(1);
  });

program
  .command("id-stamp <dir>")
  .description(
    "編集ファイルの各要素に安定 id を一括採番(@-mention の基盤。冪等・既存 id は不変)",
  )
  .action((dir: string) => {
    const abs = resolveDir(dir);
    const { changed, validate: r } = idStamp(abs);
    if (changed.length === 0) {
      console.log("変更なし(すべて採番済み、または対象ファイルがありません)");
    } else {
      console.log(`id を採番しました: ${changed.join(", ")}`);
    }
    for (const w of r.warnings) console.log(`⚠ ${w.file} ${w.where}: ${w.message}`);
    for (const e of r.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
  });

/** process.stdin を全部読んで文字列にする(apply --patch 省略時の入力経路) */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

program
  .command("apply <dir>")
  .description(
    "検査付きアトミック適用: `@id` op 列/ファイル全置換パッチを検査し、" +
      "全部通れば全書き込み・1つでもエラーなら1バイトも書かない",
  )
  .option("--patch <file>", "パッチ JSON ファイル(省略時は stdin から読む)")
  .option("--dry-run", "検査・変更要約だけ行い、書かない")
  .action(async (dir: string, opts: { patch?: string; dryRun?: boolean }) => {
    const abs = resolveDir(dir);
    let raw: string;
    if (opts.patch) {
      raw = readFileSync(opts.patch, "utf8");
    } else if (process.stdin.isTTY === true) {
      throw new Error(
        "パッチの入力がありません。--patch <file> を指定するか、JSON を stdin にパイプしてください",
      );
    } else {
      raw = await readStdin();
    }
    let patch: ApplyPatch;
    try {
      patch = JSON.parse(raw) as ApplyPatch;
    } catch (e) {
      console.error(`✖ (patch) -: JSON として読めません: ${(e as Error).message}`);
      process.exit(1);
    }
    if (opts.dryRun) {
      const plan = planApply(abs, patch);
      for (const w of plan.warnings) console.log(`⚠ ${w.file} ${w.where}: ${w.message}`);
      for (const e of plan.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
      if (plan.errors.length > 0) {
        console.error(`\nエラー ${plan.errors.length}件。上から順に修正して再実行してください。`);
        process.exit(1);
      }
      if (plan.changedFiles.length === 0) {
        console.log("変更なし(no-op パッチ。--dry-run のため書いていません)");
      } else {
        for (const d of plan.diff) {
          const field = d.field ? ` ${d.field}` : "";
          console.log(
            `  ${d.ref} ${d.file}${field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
          );
        }
        console.log(`✔ 検査通過(--dry-run。書いていません): ${plan.changedFiles.join(", ")}`);
      }
      return;
    }
    const result = applyEdits(abs, patch);
    for (const w of result.plan.warnings) console.log(`⚠ ${w.file} ${w.where}: ${w.message}`);
    for (const e of result.plan.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
    if (result.plan.errors.length > 0) {
      console.error(`\nエラー ${result.plan.errors.length}件。上から順に修正して再実行してください。`);
      process.exit(1);
    }
    if (result.written.length === 0) {
      console.log("変更なし(no-op パッチ)");
    } else {
      console.log(
        `✔ 適用しました: ${result.written.join(", ")}` +
          (result.backupDir ? ` / 退避: ${result.backupDir}` : ""),
      );
    }
  });

program
  .command("describe <dir>")
  .description(
    "編集状態の要約。既定は散文、--json で機械可読な完全射影(元秒⇔出力秒つき)",
  )
  .option(
    "--json",
    "機械可読な完全射影を JSON で標準出力に出す(発話・タイトルを切り捨てない)",
  )
  .action((dir: string, opts: { json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    // cfg を渡すのは describe.pauses(既定オフ)を解決するため。既定 config では
    // pauses オフ=散文/--json ともに従来と完全にバイト等価
    if (opts.json === true) console.log(JSON.stringify(describeJson(abs, cfg), null, 2));
    else console.log(describe(abs, cfg));
  });

program
  .command("frames <dir>")
  .description(
    "指定時刻のフレームを最終合成と同じ見た目で PNG 出力(frames/。AI の目視確認用)",
  )
  .option(
    "--t <times>",
    "時刻(カンマ区切り。\"90\" や \"2:30.5\" 形式。既定は元収録の秒)",
  )
  .option("--out", "--t をカット後(preview/final)の秒として解釈する")
  .option("--captions", "テロップ全件の一巡監査(各テロップの表示中間で1枚ずつ)")
  .option("--every <sec>", "カット後タイムラインを一定間隔でサンプリング(秒)")
  .option(
    "--scenes",
    "画面の変化点+静止区間の代表を自動選択して撮る(要 av <dir> の事前実行)",
  )
  .option(
    "--max-shots <n>",
    "--scenes の上限枚数(既定は config.yaml の frames.scenes.maxShots、省略時60)",
  )
  .option(
    "--ocr",
    "画面 OCR(Apple Vision)でその時刻の画面内テキストを読む(macOS専用。" +
      "非対応環境では警告のうえ PNG 出力のみ続行)",
  )
  .option(
    "--full-res",
    "ベース映像を proxy でなく元収録のフル解像度にして合成 still を鮮明にする" +
      "(画面内テキストの目視用)",
  )
  .action(async (
    dir: string,
    opts: {
      t?: string;
      out?: boolean;
      captions?: boolean;
      every?: string;
      scenes?: boolean;
      maxShots?: string;
      ocr?: boolean;
      fullRes?: boolean;
    },
  ) => {
    const cfg = loadConfig(program.opts().config);
    const picked = [opts.t, opts.captions, opts.every, opts.scenes].filter(
      (v) => v !== undefined,
    ).length;
    if (picked !== 1) {
      throw new Error("--t / --captions / --every / --scenes のどれか1つを指定してください");
    }
    if (opts.out && !opts.t) {
      throw new Error("--out は --t と一緒に使ってください");
    }
    if (opts.maxShots !== undefined && !opts.scenes) {
      throw new Error("--max-shots は --scenes と一緒に使ってください");
    }
    let req: FrameRequest;
    if (opts.captions) {
      req = { mode: "captions" };
    } else if (opts.every !== undefined) {
      const step = parseT(opts.every);
      if (step === null) throw new Error(`間隔を解釈できません: ${opts.every}(例: 10)`);
      req = { mode: "every", stepSec: step };
    } else if (opts.scenes) {
      let maxShots = cfg.frames?.scenes?.maxShots ?? 60;
      if (opts.maxShots !== undefined) {
        const n = Number(opts.maxShots);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--max-shots は正の整数で指定してください: ${opts.maxShots}`);
        }
        maxShots = Math.floor(n);
      }
      req = { mode: "scenes", maxShots };
    } else {
      const times = opts.t!.split(",").map((s) => {
        const t = parseT(s);
        if (t === null) throw new Error(`時刻を解釈できません: ${s}(例: 90 / 2:30.5)`);
        return t;
      });
      req = { mode: "times", times, axis: opts.out ? "output" : "source" };
    }
    const abs = resolveDir(dir);
    const frameOpts = { ocr: opts.ocr === true, fullRes: opts.fullRes === true };
    // 常駐デーモン(frames-serve)が起動していれば自動検出して委譲し、
    // bundle+browser のコールドコストを省く。portfile が無い/応答しなければ
    // 現行どおりの単発実行(既存挙動は1バイトも変わらない)
    const served = await tryServeFrames(abs, req, frameOpts);
    const shots =
      served ?? (await frames(abs, req, cfg, frameOpts.ocr, frameOpts.fullRes));
    for (const s of shots) {
      const head =
        req.mode === "times"
          ? `${opts.out ? "出力" : "元"} ${fmtT(s.requested)} → 出力 ${fmtT(s.outSec)}`
          : `出力 ${fmtT(s.outSec)}`;
      console.log(`✔ ${head}: ${s.file}` + (s.note ? `(${s.note})` : ""));
      if (s.ocrFile) {
        const result = JSON.parse(readFileSync(s.ocrFile, "utf8")) as OcrResult;
        console.log(`  OCR: ${formatOcrPreview(result)}`);
      }
    }
    console.log(
      `${shots.length}枚を出力しました(frames/ の古い PNG` +
        (opts.ocr ? "・OCR サイドカー" : "") + " は削除済み)",
    );
  });

program
  .command("frames-serve <dir>")
  .description(
    "常駐フレームサーバを起動(bundle+headless Chrome を暖機。opt-in。" +
      "起動中は frames <dir> --t ... が自動検出して使う。終了は Ctrl+C)",
  )
  .option(
    "--port <port>",
    `待受ポート(既定 ${DEFAULT_SERVE_PORT}。config.yaml の frames.serve.port` +
      "があればそちら。editor の既定 4310 とは別)",
  )
  .action(async (dir: string, opts: { port?: string }) => {
    const explicit = program.opts().config as string | undefined;
    const cfg = loadConfig(explicit);
    const abs = resolveDir(dir);
    const port =
      opts.port !== undefined ? Number(opts.port) : (cfg.frames?.serve?.port ?? DEFAULT_SERVE_PORT);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`--port の値が不正です: ${opts.port}`);
    }
    await startFramesServe(abs, explicit, port);
  });

program
  .command("record")
  .description(
    "OBS の録画ボタンに自動連動し、カーソル座標を <recording>.cursor.json へ確定する常駐 watcher" +
      "(D1。撮影は OBS のまま維持。収録フォルダではなく OBS の出力先へサイドカーを書く)。" +
      "対象ディスプレイは自動一致(obs-websocket→単一ディスプレイ→テレメトリ推論の3段)。macOS 専用。終了は Ctrl+C",
  )
  .option("--watch", "常駐して待ち受ける(現状は必須。指定なしはエラー)")
  .option(
    "--display <id>",
    "対象ディスプレイの CGDirectDisplayID(数値)を明示指定する隠しオプション。" +
      "通常は不要(自動一致が失敗する/別ディスプレイを撮りたいときだけ使う)",
  )
  .action(async (opts: { watch?: boolean; display?: string }) => {
    if (!opts.watch) {
      throw new Error("--watch を指定してください(例: framewright record --watch)");
    }
    let displayId: number | undefined;
    if (opts.display !== undefined) {
      displayId = Number(opts.display);
      if (!Number.isFinite(displayId) || displayId <= 0) {
        throw new Error(`--display の値が不正です: ${opts.display}`);
      }
    }
    const cfg = loadConfig(program.opts().config);
    await startRecordWatch(cfg, { displayId });
  });

program
  .command("materials <dir>")
  .description(
    "素材(B-roll)の中身を知る知覚コマンド。既定は ffprobe だけ(尺・解像度・fps・" +
      "音声有無)+ overlays/inserts/bgm との参照クロスリンク(未使用・dangling を検出)。" +
      "materials.probe/index.json に書く",
  )
  .option(
    "--frames",
    "代表フレーム PNG も抽出する(動画は尺の中点1枚。画像は複製せず自身のパスを記録)",
  )
  .option(
    "--ocr",
    "フレーム/画像を Apple Vision で OCR する(動画は --frames を含意。非対応環境は" +
      "警告のうえ probe/frame の出力のみ続行)",
  )
  .option(
    "--transcribe",
    "音声付き素材を whisper で文字起こしする(モデル欠如はその素材だけ警告してスキップ)",
  )
  .option("--all", "= --frames --ocr --transcribe")
  .action(async (dir: string, opts: { frames?: boolean; ocr?: boolean; transcribe?: boolean; all?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const { index, indexPath } = await materials(
      abs,
      {
        frames: opts.all === true || opts.frames === true,
        ocr: opts.all === true || opts.ocr === true,
        transcribe: opts.all === true || opts.transcribe === true,
      },
      cfg,
    );
    for (const line of formatMaterialsSummary(index)) console.log(line);
    for (const m of index.materials) {
      if (m.ocr) {
        const rest = m.ocr.lineCount - m.ocr.preview.length;
        console.log(
          `  OCR(${m.file}): ${m.ocr.preview.map((t) => `"${t}"`).join(" / ")}` +
            (rest > 0 ? ` ほか${rest}行` : ""),
        );
      }
      if (m.transcribe) {
        console.log(`  文字起こし(${m.file}): 「${m.transcribe.preview}」(${m.transcribe.segmentCount}区間)`);
      }
    }
    console.log(`${index.materials.length}件を ${indexPath} に書きました`);
  });

program
  .command("material-fit <dir>")
  .description(
    "素材の尺整合(overrun/underrun)と dangling/unused を検出し、apply パッチ下書き" +
      "(material-fit.suggested.json)を書く。要 materials <dir> の事前実行・overlays の @id",
  )
  .action((dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const result = materialFit(abs, cfg);
    for (const line of formatMaterialFitReport(abs, result)) console.log(line);
  });

program
  .command("effect-check <dir>")
  .description(
    "演出(zoom/blur/annotation)を検品する。決定論(zoom相互作用・密度・座標重なり)は常時、" +
      "任意で VLM 二次確認。still 撮影は既存 frames 経路を再利用。編集ファイルは書かず、" +
      "検品結果(effect-check.json)と補正候補の apply パッチ下書き(effect-fix.suggested.json)だけを書く",
  )
  .option("--no-vlm", "VLM 二次確認をスキップし、決定論チェックだけを行う")
  .action(async (dir: string, opts: { vlm?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const result = await effectCheck(abs, cfg, { useVlm: opts.vlm ?? true });
    for (const line of formatEffectCheckReport(abs, result)) console.log(line);
  });

program
  .command("av <dir>")
  .description(
    "A/V フィードバック用の知覚コマンド。keep を連結した motion/sound を計測し、" +
      "av.probe/{motion,sound}.json と motion.strip.png を書く",
  )
  .option("--range <a-b>", "出力(カット後)秒の範囲。例 10-25.5")
  .option("--every <sec>", "motion のサンプル間隔(秒)")
  .option("--full-res", "motion の基映像に proxy.mp4 ではなく元収録を使う")
  .option("--motion-only", "motion だけを取得する")
  .option("--sound-only", "sound だけを取得する")
  .action(async (
    dir: string,
    opts: {
      range?: string;
      every?: string;
      fullRes?: boolean;
      motionOnly?: boolean;
      soundOnly?: boolean;
    },
  ) => {
    if (opts.motionOnly === true && opts.soundOnly === true) {
      throw new Error("--motion-only と --sound-only は同時指定できません");
    }
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const result = await av(abs, {
      range: parseRangeOpt(opts.range),
      everySec: opts.every !== undefined ? Number(opts.every) : undefined,
      fullRes: opts.fullRes === true,
      motionOnly: opts.motionOnly === true,
      soundOnly: opts.soundOnly === true,
    }, cfg);
    for (const line of formatAvSummary(result)) console.log(line);
  });

program
  .command("screen <dir>")
  .description(
    "画面状態の区間トラックを作る知覚コマンド(要 av <dir> の事前実行)。" +
      "keep 後タイムラインの OCR を区間へ畳み、screen.probe/index.json を書く",
  )
  .option("--stills", "区間代表の PNG も screen.probe/stills/ に残す")
  .option("--json", "index.json を標準出力へ出す")
  .option("--force", "Layer1/Layer2 のキャッシュを無視して全再計算する")
  .action(async (dir: string, opts: { stills?: boolean; json?: boolean; force?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const index = await screen(abs, { stills: opts.stills === true, force: opts.force === true }, cfg);
    if (opts.json === true) {
      console.log(JSON.stringify(index, null, 2));
      return;
    }
    for (const line of formatScreenSummary(index)) console.log(line);
  });

program
  .command("bgm-fit <dir>")
  .description(
    "BGM の無音浮き/発話被り/大音量/フェード無しを検出し、volumeDb/fadeOutSec の" +
      "apply パッチ下書き(bgm-fit.suggested.json)を書く。章が多いのに BGM が単調/" +
      "fallback のままなら plan-bgm へ誘導する。要 av <dir> の事前実行。決定論のみ(LLM 不使用)",
  )
  .action((dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const result = bgmFit(abs, cfg);
    for (const line of formatBgmFitReport(abs, result)) console.log(line);
  });

function collectFrom(value: string, prev: string[]): string[] {
  return [...prev, value];
}

program
  .command("style-profile")
  .description(
    "任意の動画/収録パスからスタイルプロファイルを抽出し、channel(最初の --from の親ディレクトリ)の " +
      "style.probe/<name>.json に書く。収録(manifest+cutplan あり)= 統計+補正デルタ(own-project)、" +
      "素の動画/フォルダ = 観測統計のみ(bare-video)。決定論のみ・編集ファイルは1バイトも書かない",
  )
  .option("--from <path>", "入力パス(収録フォルダ or 素の動画/フォルダ)。複数指定可", collectFrom, [])
  .option("--name <name>", "プロファイル名(出力ファイル名 style.probe/<name>.json)。省略時 default")
  .action(async (opts: { from: string[]; name?: string }) => {
    const cfg = loadConfig(program.opts().config);
    const result = await styleProfile({ from: opts.from, name: opts.name }, cfg);
    for (const line of formatStyleProfileReport(result)) console.log(line);
  });

program
  .command("style-check <dir>")
  .description(
    "収録の現在の編集(候補)の観測統計が style profile の学習分散帯からどれだけ逸脱しているかを" +
      "決定論で測り、warn/info(常に exit 0)で報告する。要 `style-profile --from <dir>` の事前実行。" +
      "profile が持つ軸(cut/caption/audio)に閉じる。編集ファイルは1バイトも書かず style-check.json だけを書く",
  )
  .option("--profile <name>", "参照する profile 名(style.probe/<name>.json)。省略時 default")
  .action((dir: string, opts: { profile?: string }) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const result = styleCheck(abs, { profile: opts.profile }, cfg);
    for (const line of formatStyleCheckReport(abs, result)) console.log(line);
  });

program
  .command("review <dir>")
  .description(
    "before/after の deterministic review bundle を生成し review.probe/index.json に書く",
  )
  .requiredOption("--spec <file>", "ReviewSpec JSON")
  .option("--candidate <file>", "candidate EditSnapshot JSON。省略時は現在の編集状態を使う")
  .option("--json", "bundle JSON を stdout に出す")
  .action(async (
    dir: string,
    opts: { spec: string; candidate?: string; json?: boolean },
  ) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const base = readEditSnapshot(abs);
    const candidate = opts.candidate ? readJsonFile<EditSnapshot>(opts.candidate) : base;
    const spec = readJsonFile<ReviewSpec>(opts.spec);
    const bundle = await reviewEdit(abs, cfg, base, candidate, spec, {
      secondaryObservation: "none",
    });
    if (opts.json === true) {
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }
    console.log(`review 完了: ${join(abs, "review.probe", "index.json")}`);
    console.log(`stills: ${bundle.stills.length}件 / warnings: ${bundle.warnings.length}件`);
    for (const check of bundle.observation.checks) {
      console.log(`[${check.status}] ${check.source} ${check.message}`);
    }
  });

program
  .command("index")
  .description("recordingsDir のローカル検索indexを更新する")
  .option("--json", "index JSONをstdoutへ出す")
  .action((opts: { json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    const index = buildRetrievalIndex(cfg.recordingsDir);
    if (opts.json) console.log(JSON.stringify(index, null, 2));
    else console.log(`index完了: ${index.recordings.length} recordings / ${index.documents.length} documents`);
  });

program
  .command("search <query>")
  .description("recording/material metadata、OCR、transcriptをローカル検索する")
  .option("--kind <kind>", "recording | material | caption | screen")
  .option("--scope <scope>", "current | other | all", "all")
  .option("--limit <n>", "最大件数", "10")
  .option("--json", "JSONをstdoutへ出す")
  .action((query: string, opts: { kind?: string; scope?: string; limit?: string; json?: boolean }) => {
    const cfg = loadConfig(program.opts().config);
    if (opts.kind && !["recording", "material", "caption", "screen"].includes(opts.kind)) {
      throw new Error("--kind は recording | material | caption | screen です");
    }
    if (opts.scope && !["current", "other", "all"].includes(opts.scope)) {
      throw new Error("--scope は current | other | all です");
    }
    const results = retrievalSearch(cfg.recordingsDir, {
      query,
      kind: opts.kind as "recording" | "material" | "caption" | "screen" | undefined,
      scope: opts.scope as "current" | "other" | "all" | undefined,
      limit: Number(opts.limit),
    });
    if (opts.json) console.log(JSON.stringify(results, null, 2));
    else for (const result of results) {
      console.log(`${result.score}\t${result.recording}\t${result.kind}\t${result.relativePath ?? "-"}\t${result.snippet}`);
    }
  });

program
  .command("thumbnail <dir>")
  .description(
    "thumbnail.json からサムネイル静止画を生成(thumbnail.png。元収録のフル解像度)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const out = await thumbnail(resolveDir(dir), cfg);
    console.log(`thumbnail 完了: ${out}`);
  });

/** cutplan.json の approved だけを書き換える(segments はそのまま) */
function updateCutplanApprovedFlag(dir: string, approved: boolean): CutPlan {
  const cutplan = JSON.parse(
    readFileSync(join(dir, "cutplan.json"), "utf8"),
  ) as CutPlan;
  const next: CutPlan = { ...cutplan, approved };
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(next, null, 2));
  return next;
}

/** ターミナルで y/N を尋ねる(approve の対話確認用) */
async function confirmYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

program
  .command("approve <dir>")
  .description(
    "cutplan の内容ハッシュを approvals.json に記録して承認する" +
      "(render の唯一のゲート。承認は人間の対話操作)",
  )
  .option(
    "--yes",
    "非対話環境でも承認する(意図的バイパス。preview 未確認のまま承認できてしまうため通常は使わない)",
  )
  .action(async (dir: string, opts: { yes?: boolean }) => {
    const abs = resolveDir(dir);
    const cfg = loadConfig(program.opts().config);
    // 壊れた内容を承認しない: 先に validate を通す
    const r = validate(abs, cfg);
    if (r.errors.length > 0) {
      for (const e of r.errors) console.error(`✖ ${e.file} ${e.where}: ${e.message}`);
      throw new Error(
        `検査エラー ${r.errors.length}件があるため承認できません。上から順に修正し、` +
          "validate が通ってから再実行してください",
      );
    }
    const interactive = process.stdin.isTTY === true;
    if (!interactive && opts.yes !== true) {
      throw new Error(
        "approve は人間の対話操作です。preview で内容を確認のうえ、端末から実行してください" +
          "(非対話環境(Bash/子エージェント等)から実行する場合は --yes が必要です)",
      );
    }
    if (interactive && opts.yes !== true) {
      const ok = await confirmYesNo("preview.mp4 を確認しましたか? 承認しますか? [y/N] ");
      if (!ok) {
        console.log("承認しませんでした(preview で確認してから再実行してください)");
        return;
      }
    }
    const cutplan = updateCutplanApprovedFlag(abs, true);
    writeCutplanApproval(abs, cutplan, "cli");
    console.log("承認しました: 本編(approvals.json に記録)");
  });

program
  .command("unapprove <dir>")
  .description("承認レコードを取り消す(cutplan)。安全側の操作なので確認は不要")
  .action((dir: string) => {
    const abs = resolveDir(dir);
    clearCutplanApproval(abs);
    updateCutplanApprovedFlag(abs, false);
    console.log("承認を取り消しました: 本編");
  });

program
  .command("render <dir>")
  .description("承認済み cutplan.json から最終動画を生成(ワイプ+テロップ → final.mp4)")
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    console.log("render 実行中(初回は headless Chrome の取得で数分かかります)...");
    const out = await render(abs, cfg);
    console.log(`render 完了: ${out}`);
  });

program
  .command("clean <dir>")
  .description(
    "収録フォルダの中間生成物・キャッシュを安全に削除(分類は files.ts の GENERATED_FILES/fileRole 由来。" +
      "編集ファイル・approvals.json・素材(materials/)・成果物には絶対に触れない)。" +
      "manifest が指す元収録も触れないが、その自動リマックス複製(OBS が .mkv の隣に残す同一内容の .mp4)は" +
      "ffprobe で内容一致を確認したうえで削除する(--logs-only では対象外)",
  )
  .option("--dry-run", "削除せず、削除対象の一覧と解放バイトだけを表示する")
  .option(
    "--cache-only",
    "再生成の重いキャッシュ(proxy/cut/frames/*.probe 等)だけを消し、" +
      "manifest.json / cuts.auto.json / whisper-out.* 等の軽い中間生成物は残す",
  )
  .option(
    "--logs-only",
    "ログ・使い捨て下書き・検品結果(*.raw.txt / cuts.auto.json / *-fit.suggested.json / " +
      "effect-check.json / style-check.json / preview.mp4 / frames/ 等)だけを消し、" +
      "リレンダー最適化(cut/render.*)・proxy・whisper-out.*・manifest.json は残す。--cache-only とは排他",
  )
  .option("--json", "CleanPlan を JSON で標準出力に出す(パイプ可。--dry-run と併用で機械可読な削除計画)")
  .action(async (dir: string, opts: { dryRun?: boolean; cacheOnly?: boolean; logsOnly?: boolean; json?: boolean }) => {
    const abs = resolveDir(dir);
    const plan = await planCleanWithRemuxDup(abs, {
      cacheOnly: opts.cacheOnly === true,
      logsOnly: opts.logsOnly === true,
      // remux 複製を「消さなかった理由」は掃除の判断材料なので黙って捨てない。
      // --json のときは stdout を純 JSON に保つため stderr へ逃がす
      onSkip: (reason) => console.warn(`警告: ${reason}`),
    });
    if (opts.dryRun !== true) executeClean(abs, plan);
    if (opts.json === true) {
      console.log(JSON.stringify({ ...plan, dryRun: opts.dryRun === true }, null, 2));
    } else {
      for (const line of formatCleanReport(plan, opts.dryRun === true)) console.log(line);
    }
  });

program
  .command("editor [dir]")
  .description(
    "GUI エディタを起動(overlays / transcript / cutplan をブラウザで編集)",
  )
  .option(
    "--layout <layout>",
    "初回 bootstrap 時の収録レイアウト(plain|obs-canvas|auto)。省略時は plain",
  )
  .option("--canvas <preset>", "初回 bootstrap 時の出力キャンバス(作成時固定)")
  .option("--base-layout <kind>", "初回 bootstrap 時のベース映像配置(auto|screen|camera|stack、作成時固定)")
  .option("--detach", "バックグラウンドで起動してターミナルを返す(ログは ~/.framewright/editor/)")
  .option("--stop", "デタッチ起動中のエディタを止める")
  .option("--status", "この収録のエディタが起動しているか表示する")
  .action(async (dir: string | undefined, opts: { layout?: string; canvas?: string; baseLayout?: string; detach?: boolean; stop?: boolean; status?: boolean }) => {
    const explicit = program.opts().config as string | undefined;
    const cfg = loadConfig(explicit);
    const launcherMode = dir === undefined;
    if (launcherMode && (opts.detach || opts.stop || opts.status)) {
      throw new Error("dir 省略時のランチャーでは --detach / --stop / --status は使えません");
    }
    const abs = launcherMode ? cfg.recordingsDir : resolve(dir);

    const modes = [opts.detach, opts.stop, opts.status].filter(Boolean).length;
    if (modes > 1) throw new Error("--detach / --stop / --status は同時に指定できません");
    if (!existsSync(abs)) {
      if (opts.stop === true || opts.status === true) throw new Error(`フォルダがありません: ${abs}`);
      mkdirSync(abs, { recursive: true });
    }

    if (opts.status === true) {
      const entry = await liveEditor(abs);
      if (!entry) {
        console.log(`エディタは起動していません(対象: ${abs})`);
        return;
      }
      console.log(`エディタ起動中: http://127.0.0.1:${entry.port}(対象: ${entry.dir})`);
      console.log(`  pid: ${entry.pid}  起動: ${entry.startedAt}`);
      console.log(`  ログ: ${editorLogFilePath(abs)}`);
      return;
    }

    if (opts.stop === true) {
      const stopped = await stopEditor(abs);
      if (!stopped) {
        console.log(`エディタは起動していません(対象: ${abs})`);
        return;
      }
      console.log(`エディタを停止しました(pid=${stopped.pid} 対象: ${stopped.dir})`);
      return;
    }

    if (opts.detach === true) {
      // 子プロセス(= 自分自身の editor コマンド)が listen して portfile を書く
      const entry = await startDetachedEditor(abs, { layout: opts.layout, canvas: opts.canvas, baseLayout: opts.baseLayout, configPath: explicit });
      console.log(`エディタ起動(バックグラウンド): http://127.0.0.1:${entry.port}(対象: ${entry.dir})`);
      console.log(`  ログ: ${editorLogFilePath(abs)}`);
      console.log(`  停止: ${cliCmd()} editor ${dir} --stop`);
      return;
    }

    const layout = parseLayoutOpt(opts.layout);
    const canvas = parseCanvasOpt(opts.canvas);
    const baseLayout = parseBaseLayoutOpt(opts.baseLayout);
    // 設定画面(POST /api/config)が書き戻す先。読んだ config.yaml と同じパス
    const cfgPath = resolveConfigPath(explicit);
    // esbuild 等のエディタ専用依存を CLI 起動時に読ませないため動的 import
    const { startEditor } = await import("../editor/server.ts");
    await startEditor(abs, cfg, cfgPath, layout, canvas, baseLayout, launcherMode);
  });

program
  .command("mcp <dir>")
  .description(
    "Model Context Protocol サーバを起動(stdio。read + 承認スコープ外の安全編集の" +
      "tool だけを露出。approve/render/plan 等は一切露出しない。終了は Ctrl+C)",
  )
  .action(async (dir: string) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    // MCP 専用コードを他コマンド起動時に読ませないため動的 import
    const { startMcpServer } = await import("./mcp/server.ts");
    await startMcpServer(abs, cfg);
  });

program
  .command("run <dir>")
  .description("AI に初版を作らせる(transcribe → detect → plan。manifest が無ければ ingest も実行)")
  .option(
    "--force",
    "既存の transcript / cutplan 等を上書きして再実行(実行前に backups/ へ退避)",
  )
  .option(
    "--layout <layout>",
    "収録レイアウト(plain|obs-canvas|auto)。manifest が無いときだけ有効",
  )
  .option("--canvas <preset>", "出力キャンバス。manifest が無い作成時だけ有効")
  .option("--base-layout <kind>", "ベース映像配置。manifest が無い作成時だけ有効")
  .option("--mic-track <n>", "マイク音声トラック(1始まり)。manifest が無いときだけ有効")
  .option("--system-track <n>", "システム音声トラック(1始まり)。manifest が無いときだけ有効")
  .option("--full", "AI 初版に加えて probe --all と draft --all まで実行する")
  .action(async (
    dir: string,
    opts: {
      force?: boolean;
      layout?: string;
      canvas?: string;
      baseLayout?: string;
      micTrack?: string;
      systemTrack?: string;
      full?: boolean;
    },
  ) => {
    const cfg = loadConfig(program.opts().config);
    const abs = resolveDir(dir);
    const layout = parseLayoutOpt(opts.layout);
    const tracks = parseTrackOpts(opts.micTrack, opts.systemTrack);
    const canvas = parseCanvasOpt(opts.canvas);
    const baseLayout = parseBaseLayoutOpt(opts.baseLayout);
    // P2 以降 ingest はプロジェクト作成時に完了済み。manifest の無い旧来の
    // 収録フォルダだけは後方互換として従来どおり ingest から始める。
    // ▸ stage 行(stderr・レベルゲート・所要時間付き)として出す。進捗は obs
    // チャネルへ、結果要約(尺の縮み・カット案)は stdout に残す(--quiet でも
    // 成果は出るが、工程の進捗は静かになる)。plan の LLM 実行中は AI クライアントが
    // ✦ AI 行を heartbeat として出すので、事前ヒントの console.log は不要
    const result = await runDraft(abs, cfg, {
      force: opts.force,
      layout,
      tracks,
      canvas,
      baseLayout,
      full: opts.full === true,
      beforePlan: () => printPerceptionStatus(cfg),
    }, { stage: timed });
    const c = result.detected;
    console.log(`detect: ${c.originalDurationSec}秒 → ${c.keptDurationSec}秒`);
    const p = result.planned;
    printPlanSummary(p.segments);

    // 新規収録を初回から id 有効(@-mention 可能)にする。id-stamp は冪等・
    // approvals.json 非改変なので、run の末尾に置いても安全
    const { changed } = result.stamped;
    if (changed.length > 0) {
      console.log(`id-stamp 完了: ${changed.join(", ")}`);
    }

    // 新規 watch 収録には dwell 由来 zoom を自動挿入(既存編集は触らない・
    // config の plan.cursor.autoZoom で off 可)。判定は autoZoomIfFresh に閉じる
    const az = result.autoZoom;
    if (az) {
      console.log(`autozoom: zoom${az.placedCount}件を自動配置`);
    }
    if (opts.full === true) {
      if (result.fullProbe.length > 0) console.log(`probe: ${result.fullProbe.join(", ")}`);
      if (result.fullDraft.length > 0) console.log(`draft: ${result.fullDraft.join(", ")}`);
      if (result.fullFailures.length > 0) {
        console.warn("run --full の一部段階が失敗しました:");
        for (const failure of result.fullFailures) console.warn(`  ${failure}`);
      }
      console.log("thumbnail.json を書けば thumbnail コマンドでサムネイルを生成できます。");
    }
  });

function printPlanSummary(
  segments: { action: "keep" | "cut"; reason: string }[],
): void {
  const cuts = segments.filter((s) => s.action === "cut");
  console.log(
    `plan 完了: ${segments.length}区間中 ${cuts.length}区間をカット提案`,
  );
  for (const c of cuts) console.log(`  カット案: ${c.reason}`);
  console.log(
    "\n次のステップ: preview で確認し、cutplan.json を必要に応じて編集、" +
      "approved を true にしてから render を実行してください。",
  );
}

// 一覧表示用の1行要約を流し込む(commander の .summary()。詳細な
// .description() は各コマンドの --help に残る)。全コマンド登録後に一度だけ。
// 未登録名・要約漏れは test/cliHelp.test.ts が落として気づかせる
for (const [name, summary] of commandSummaries()) {
  program.commands.find((c) => c.name() === name)?.summary(summary);
}

program.parseAsync().catch((err: Error) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
