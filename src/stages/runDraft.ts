import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../lib/config.ts";
import { findSource } from "../lib/findSource.ts";
import { guardRerun } from "../lib/rerunGuard.ts";
import { ingest } from "./ingest.ts";
import { transcribe } from "./transcribe.ts";
import { detect } from "./detect.ts";
import { plan } from "./plan.ts";
import { idStamp } from "./idStamp.ts";
import { autoZoomIfFresh } from "./autoZoom.ts";
import { probe } from "./probe.ts";
import { draft } from "./draft.ts";

const RUN_OUTPUTS = ["transcript.json", "cutplan.json", "chapters.json", "meta.json"];
const RUN_FULL_OUTPUTS = [...RUN_OUTPUTS, "overlays.json", "bgm.json"];

export interface RunDraftOptions {
  force?: boolean;
  layout?: Parameters<typeof ingest>[3];
  tracks?: Parameters<typeof ingest>[4];
  canvas?: Parameters<typeof ingest>[5];
  baseLayout?: Parameters<typeof ingest>[6];
  full?: boolean;
  /** detect 完了後、plan 開始前の通知（CLI の知覚 status 表示用）。 */
  beforePlan?: () => void;
}

export interface RunDraftDeps {
  ingest: typeof ingest;
  transcribe: typeof transcribe;
  detect: typeof detect;
  plan: typeof plan;
  idStamp: typeof idStamp;
  autoZoomIfFresh: typeof autoZoomIfFresh;
  probe: typeof probe;
  draft: typeof draft;
  findSource: typeof findSource;
  stage: <T>(name: string, task: () => Promise<T>) => Promise<T>;
}

const defaultDeps: RunDraftDeps = {
  ingest,
  transcribe,
  detect,
  plan,
  idStamp,
  autoZoomIfFresh,
  probe,
  draft,
  findSource,
  stage: async (_name, task) => await task(),
};

/** AI 初版の共通本体。manifest 無しだけ ingest する後方互換をここで固定する。 */
export async function runDraft(
  dir: string,
  cfg: Config,
  options: RunDraftOptions = {},
  overrides: Partial<RunDraftDeps> = {},
) {
  const deps = { ...defaultDeps, ...overrides };
  guardRerun(dir, options.full === true ? RUN_FULL_OUTPUTS : RUN_OUTPUTS, options.force === true, "run");
  if (!existsSync(join(dir, "manifest.json"))) {
    await deps.stage("ingest", () =>
      deps.ingest(dir, deps.findSource(dir), cfg, options.layout, options.tracks, options.canvas, options.baseLayout));
  }
  await deps.stage("transcribe", () => deps.transcribe(dir, cfg));
  const detected = await deps.stage("detect", () => deps.detect(dir, cfg));
  options.beforePlan?.();
  const planned = await deps.stage("plan", () => deps.plan(dir, cfg));
  const stamped = deps.idStamp(dir);
  const fullFailures: string[] = [];
  let fullProbe: string[] = [];
  let fullDraft: string[] = [];
  if (options.full === true) {
    try {
      fullProbe = await deps.stage("probe", () => deps.probe(dir, cfg, { all: true }));
    } catch (error) {
      fullFailures.push(`probe: ${(error as Error).message}`);
    }
    for (const step of ["materials", "effects", "bgm"] as const) {
      try {
        const ran = await deps.stage(`draft:${step}`, () => deps.draft(dir, cfg, { [step]: true, force: options.force }));
        fullDraft.push(...ran);
      } catch (error) {
        fullFailures.push(`draft:${step}: ${(error as Error).message}`);
      }
    }
  }
  const autoZoom = deps.autoZoomIfFresh(dir, cfg);
  return { detected, planned, stamped, autoZoom, fullProbe, fullDraft, fullFailures };
}
