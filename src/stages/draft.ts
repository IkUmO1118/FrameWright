import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../lib/config.ts";
import { resolveDraftPlan } from "../lib/commandPlan.ts";
import type { DraftStep } from "../lib/commandPlan.ts";
import type { DraftPlanOptions } from "../lib/commandPlan.ts";
import { backupEditableFiles } from "../lib/backup.ts";
import { APPROVAL_FILE, EDITABLE_FILES } from "../lib/files.ts";
import { guardRerun } from "../lib/rerunGuard.ts";
import type { Overlays } from "../types.ts";
import { planMaterials } from "./planMaterials.ts";
import { planEffects } from "./planEffects.ts";
import { planBgm } from "./planBgm.ts";
import { autoZoom } from "./autoZoom.ts";

export interface DraftRunOptions extends DraftPlanOptions {
  force?: boolean;
}

function shaOrMissing(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function protectedHashes(dir: string): Map<string, string | null> {
  return new Map(["cutplan.json", APPROVAL_FILE].map((file) => [file, shaOrMissing(join(dir, file))]));
}

function assertUnchanged(dir: string, before: Map<string, string | null>): void {
  for (const [file, hash] of before) {
    const after = shaOrMissing(join(dir, file));
    if (after !== hash) throw new Error(`内部エラー: draft が ${file} を変更しました`);
  }
}

function readOverlaysOrNull(dir: string): Overlays | null {
  const path = join(dir, "overlays.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Overlays;
}

function backupForDraft(dir: string, outputs: string[]): void {
  const dest = backupEditableFiles(dir, [...new Set([...EDITABLE_FILES, ...outputs])]);
  if (dest) {
    console.log(
      `上書き前に手編集ファイルを退避しました: ${dest}\n` +
        "(戻すには退避先のファイルを収録フォルダ直下へコピーし直す)",
    );
  }
}

function guardEffectLikeRerun(dir: string, overlays: Overlays | null, force: boolean, kind: "effects" | "zoom"): void {
  const has =
    kind === "effects"
      ? (overlays?.zooms?.length ?? 0) > 0 ||
        (overlays?.blurs?.length ?? 0) > 0 ||
        (overlays?.annotations?.length ?? 0) > 0
      : (overlays?.zooms?.length ?? 0) > 0;
  if (!has) return;
  if (!force) {
    throw new Error(
      `overlays.json に既存の ${kind === "effects" ? "zooms/blurs/annotations" : "zooms"} があります。` +
        `draft --${kind} の再実行はこれらを上書きし、手編集が消えます。\n` +
        "やり直す場合は --force を付けてください(実行前に手編集ファイルを backups/ へ退避します)",
    );
  }
  backupForDraft(dir, ["overlays.json"]);
}

function guardDraftRerun(dir: string, steps: DraftStep[], force: boolean): void {
  const initialOverlays = readOverlaysOrNull(dir);
  if (steps.includes("materials")) guardRerun(dir, ["overlays.json"], force, "draft --materials");
  if (steps.includes("effects")) guardEffectLikeRerun(dir, initialOverlays, force, "effects");
  if (steps.includes("zoom")) guardEffectLikeRerun(dir, initialOverlays, force, "zoom");
  if (steps.includes("bgm")) guardRerun(dir, ["bgm.json"], force, "draft --bgm");
}

export async function draft(dir: string, cfg: Config, opts: DraftRunOptions = {}): Promise<string[]> {
  const before = protectedHashes(dir);
  const steps = resolveDraftPlan(opts);
  guardDraftRerun(dir, steps, opts.force === true);
  const ran: string[] = [];
  let thrown: unknown;
  try {
    for (const step of steps) {
      if (step === "materials") await planMaterials(dir, cfg);
      else if (step === "effects") await planEffects(dir, cfg);
      else if (step === "bgm") await planBgm(dir, cfg);
      else autoZoom(dir, cfg);
      ran.push(step);
    }
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
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
  return ran;
}
