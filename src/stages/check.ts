import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../lib/config.ts";
import { resolveCheckPlan } from "../lib/commandPlan.ts";
import type { CheckPlanOptions, CheckStep } from "../lib/commandPlan.ts";
import { applyEdits, planApply } from "../lib/applyEdits.ts";
import { APPROVAL_FILE, EDITABLE_FILES } from "../lib/files.ts";
import type { ApplyPatch } from "../types.ts";
import { idStamp } from "./idStamp.ts";
import { materials } from "./materials.ts";
import { av } from "./av.ts";
import { formatMaterialFitReport, materialFit, MATERIAL_FIT_PATCH_FILE } from "./materialFit.ts";
import { effectCheck, EFFECT_FIX_PATCH_FILE, formatEffectCheckReport } from "./effectCheck.ts";
import { bgmFit, BGM_FIT_PATCH_FILE, formatBgmFitReport } from "./bgmFit.ts";
import { formatStyleCheckReport, styleCheck } from "./styleCheck.ts";
import { boundaryCheck, formatBoundaryCheckReport } from "./boundaryCheck.ts";

export interface CheckRunOptions extends CheckPlanOptions {
  noVlm?: boolean;
  dryRun?: boolean;
  json?: boolean;
  profile?: string;
  onLine?: (line: string) => void;
  onWarn?: (line: string) => void;
}

export interface CheckRunResult {
  ran: CheckStep[];
  skipped: { step: CheckStep; reason: string }[];
  fixed: { file: string; status: "missing" | "dry-run" | "applied" | "no-op"; changedFiles: string[] }[];
}

const CHECK_PROTECTED_FILES = [
  ...EDITABLE_FILES,
  "bgm.json",
  "thumbnail.json",
  APPROVAL_FILE,
] as const;

function shaOrMissing(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function protectedHashes(dir: string): Map<string, string | null> {
  return new Map(CHECK_PROTECTED_FILES.map((file) => [file, shaOrMissing(join(dir, file))]));
}

function assertUnchanged(dir: string, before: Map<string, string | null>): void {
  for (const [file, hash] of before) {
    const after = shaOrMissing(join(dir, file));
    if (after !== hash) throw new Error(`内部エラー: check が ${file} を変更しました`);
  }
}

function readPatch(path: string): ApplyPatch | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ApplyPatch;
}

function patchTargetsCutplan(patch: ApplyPatch): boolean {
  return (patch.ops ?? []).some((op) => typeof op.target === "string" && op.target.startsWith("cutplan"));
}

const FIX_PATCHES: readonly { step: CheckStep; file: string }[] = [
  { step: "materials", file: MATERIAL_FIT_PATCH_FILE },
  { step: "effects", file: EFFECT_FIX_PATCH_FILE },
  { step: "bgm", file: BGM_FIT_PATCH_FILE },
];

function applyFixPatch(dir: string, file: string, dryRun: boolean): CheckRunResult["fixed"][number] {
  const path = join(dir, file);
  const patch = readPatch(path);
  if (!patch) return { file, status: "missing", changedFiles: [] };
  if (patchTargetsCutplan(patch)) throw new Error(`${file} は cutplan.* を変更しようとしています。check --fix では拒否します`);
  const plan = planApply(dir, patch);
  if (plan.diff.some((d) => d.file === "cutplan.json")) {
    throw new Error(`${file} は cutplan.json を変更しようとしています。check --fix では拒否します`);
  }
  if (plan.errors.length > 0) {
    throw new Error(`${file} の適用前検査に失敗しました: ${plan.errors.map((e) => `${e.file} ${e.where}: ${e.message}`).join(" / ")}`);
  }
  if (plan.changedFiles.length === 0) return { file, status: "no-op", changedFiles: [] };
  if (dryRun) return { file, status: "dry-run", changedFiles: plan.changedFiles };
  const applied = applyEdits(dir, patch);
  if (applied.plan.errors.length > 0) {
    throw new Error(`${file} の適用に失敗しました: ${applied.plan.errors.map((e) => `${e.file} ${e.where}: ${e.message}`).join(" / ")}`);
  }
  return { file, status: "applied", changedFiles: applied.written };
}

export async function check(dir: string, cfg: Config, opts: CheckRunOptions = {}): Promise<CheckRunResult> {
  if (opts.dryRun === true && opts.fix !== true) throw new Error("check --dry-run は --fix と一緒に指定してください");
  const plan = resolveCheckPlan(opts);
  const before = opts.fix === true ? null : protectedHashes(dir);
  const onLine = opts.onLine ?? (() => {});
  const onWarn = opts.onWarn ?? ((line) => onLine(`警告: ${line}`));
  const result: CheckRunResult = { ran: [], skipped: [], fixed: [] };
  let thrown: unknown;

  try {
    if (plan.autoIdStamp) idStamp(dir);
    if (plan.autoProbe.includes("materials")) await materials(dir, {}, cfg);
    if (plan.autoProbe.includes("av")) await av(dir, {}, cfg);

    for (const step of plan.steps) {
      try {
        onLine(`--- ${step} ---`);
        if (step === "materials") {
          const stepResult = materialFit(dir, cfg);
          for (const line of formatMaterialFitReport(dir, stepResult)) onLine(line);
        } else if (step === "effects") {
          const stepResult = await effectCheck(dir, cfg, { useVlm: opts.noVlm !== true });
          for (const line of formatEffectCheckReport(dir, stepResult)) onLine(line);
        } else if (step === "bgm") {
          const stepResult = bgmFit(dir, cfg);
          for (const line of formatBgmFitReport(dir, stepResult)) onLine(line);
        } else if (step === "style") {
          const stepResult = styleCheck(dir, { profile: opts.profile }, cfg);
          for (const line of formatStyleCheckReport(dir, stepResult)) onLine(line);
        } else {
          const stepResult = await boundaryCheck(dir);
          for (const line of formatBoundaryCheckReport(stepResult)) onLine(line);
        }
        result.ran.push(step);
      } catch (error) {
        if (plan.isAll) {
          const reason = (error as Error).message;
          result.skipped.push({ step, reason });
          onWarn(`${step} をスキップしました: ${reason}`);
          continue;
        }
        throw error;
      }
    }

    if (opts.fix === true) {
      const ran = new Set(result.ran);
      for (const { step, file } of FIX_PATCHES) {
        if (!ran.has(step)) continue;
        const fixed = applyFixPatch(dir, file, opts.dryRun === true);
        result.fixed.push(fixed);
      }
    }
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    if (before) {
      try {
        assertUnchanged(dir, before);
      } catch (assertError) {
        if (thrown instanceof Error) {
          thrown.message += `\nさらに不変条件の検査にも失敗しました: ${(assertError as Error).message}`;
        } else if (thrown === undefined) {
          throw assertError;
        }
      }
    }
  }
  return result;
}
