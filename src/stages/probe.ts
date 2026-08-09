import type { Config } from "../lib/config.ts";
import { resolveProbePlan } from "../lib/commandPlan.ts";
import type { ProbePlanOptions } from "../lib/commandPlan.ts";
import { formatMaterialsSummary, materials } from "./materials.ts";
import { av, formatAvSummary } from "./av.ts";
import { styleProfile } from "./styleProfile.ts";

export interface ProbeRunOptions extends ProbePlanOptions {
  deep?: boolean;
  onLine?: (line: string) => void;
}

export async function probe(dir: string, cfg: Config, opts: ProbeRunOptions = {}): Promise<string[]> {
  const ran: string[] = [];
  const onLine = opts.onLine ?? (() => {});
  for (const step of resolveProbePlan(opts)) {
    if (step === "materials") {
      const result = await materials(dir, {
        frames: opts.deep === true,
        ocr: opts.deep === true,
        transcribe: opts.deep === true,
      }, cfg);
      for (const line of formatMaterialsSummary(result.index)) onLine(line);
    } else if (step === "av") {
      const result = await av(dir, {}, cfg);
      for (const line of formatAvSummary(result)) onLine(line);
    } else {
      await styleProfile({ from: [dir] }, cfg);
    }
    ran.push(step);
  }
  return ran;
}
