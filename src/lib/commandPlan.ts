export type ProbeStep = "materials" | "av" | "screen" | "style";
export type DraftStep = "materials" | "effects" | "bgm" | "zoom";
export type CheckStep = "materials" | "effects" | "bgm" | "style" | "boundary";

export interface ProbePlanOptions {
  materials?: boolean;
  av?: boolean;
  screen?: boolean;
  style?: boolean;
  all?: boolean;
}

export interface DraftPlanOptions {
  materials?: boolean;
  effects?: boolean;
  bgm?: boolean;
  zoom?: boolean;
  all?: boolean;
}

export interface CheckPlanOptions {
  materials?: boolean;
  effects?: boolean;
  bgm?: boolean;
  style?: boolean;
  boundary?: boolean;
  all?: boolean;
  fix?: boolean;
}

export interface CheckPlan {
  steps: CheckStep[];
  autoProbe: ProbeStep[];
  autoIdStamp: boolean;
  isAll: boolean;
}

function anySelected(values: readonly (boolean | undefined)[]): boolean {
  return values.some((v) => v === true);
}

export function resolveProbePlan(opts: ProbePlanOptions): ProbeStep[] {
  const selected = anySelected([opts.materials, opts.av, opts.screen, opts.style, opts.all]);
  const all = opts.all === true || !selected;
  const steps: ProbeStep[] = [];
  if (all || opts.materials === true) steps.push("materials");
  if (all || opts.av === true) steps.push("av");
  if (all || opts.screen === true) steps.push("screen");
  if (opts.style === true) steps.push("style");
  return steps;
}

export function resolveDraftPlan(opts: DraftPlanOptions): DraftStep[] {
  if (opts.effects === true && opts.zoom === true) {
    throw new Error("draft --effects と --zoom は同時指定できません");
  }
  const selected = anySelected([opts.materials, opts.effects, opts.bgm, opts.zoom, opts.all]);
  const all = opts.all === true || !selected;
  const steps: DraftStep[] = [];
  if (all || opts.materials === true) steps.push("materials");
  if (all || opts.effects === true) steps.push("effects");
  if (all || opts.bgm === true) steps.push("bgm");
  if (opts.zoom === true) steps.push("zoom");
  return steps;
}

export function resolveCheckPlan(opts: CheckPlanOptions): CheckPlan {
  const selected = anySelected([opts.materials, opts.effects, opts.bgm, opts.style, opts.boundary, opts.all]);
  const all = opts.all === true || !selected;
  const steps: CheckStep[] = [];
  if (all || opts.materials === true) steps.push("materials");
  if (all || opts.effects === true) steps.push("effects");
  if (all || opts.bgm === true) steps.push("bgm");
  if (all || opts.style === true) steps.push("style");
  if (all || opts.boundary === true) steps.push("boundary");

  const autoProbe: ProbeStep[] = [];
  if (steps.includes("materials")) autoProbe.push("materials");
  if (steps.includes("bgm")) autoProbe.push("av");
  return { steps, autoProbe, autoIdStamp: opts.fix === true, isAll: all };
}
