import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { applyEdits, planApply } from "./applyEdits.ts";
import { hasAnyId, usedIdsOf } from "./ids.ts";
import { readEditableDocs } from "../stages/idStamp.ts";
import {
  DEFAULT_BLUR_STRENGTH,
  type Annotation,
  type ApplyPatch,
  type AutoCuts,
  type Overlays,
  type CutPlan,
  type Transcript,
  type PlanSegment,
  type Region,
} from "../types.ts";
import type { ApplyPlan, ApplyResult } from "./applyEdits.ts";
import type { LoadedDocs, Problem } from "../stages/validate.ts";

export type EditIntent =
  | {
      type: "set-range-action";
      range: { startSec: number; endSec: number };
      action: "keep" | "cut";
      reason: string;
    }
  | {
      type: "trim-pauses";
      range?: { startSec: number; endSec: number };
      minPauseSec: number;
      keepHeadSec: number;
      keepTailSec: number;
      reason: string;
    }
  | { type: "set-caption-text"; target: `@cap_${string}`; text: string }
  /** テロップの表示区間(元収録の秒)。省略側は現在値を保つ。words[] は新区間へクリップする */
  | { type: "set-caption-timing"; target: `@cap_${string}`; startSec?: number; endSec?: number }
  | {
      type: "add-blur";
      range: { startSec: number; endSec: number };
      rect: Region;
      strength?: number;
    }
  | {
      type: "add-annotation";
      range: { startSec: number; endSec: number };
      annotation:
        | { type: "arrow"; from: { x: number; y: number }; to: { x: number; y: number }; color?: string }
        | { type: "box"; rect: Region; color?: string; fill?: string }
        | { type: "spotlight"; rect: Region; shape?: "rect" | "ellipse" };
    }
  | {
      type: "place-material";
      file: string;
      range: { startSec: number; endSec: number };
      placement:
        | { mode: "overlay"; rect?: Region; fit?: "contain" | "cover"; track?: number }
        | { mode: "insert"; durationSec: number; startFrom?: number; fit?: "contain" | "cover" };
      audio?: { volume: number };
    };

export interface EditIntentContext {
  recordingDir: string;
  autoCuts?: AutoCuts | null;
}

export interface EditIntentPlan {
  patch: ApplyPatch;
  warnings: Problem[];
  errors: Problem[];
  summary: string[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const round = (n: number): number => Math.round(n * 1000) / 1000;

function problem(index: number, message: string): Problem {
  return { file: "(intent)", where: `tasks[${index}]`, message };
}

function validRange(range: unknown): range is { startSec: number; endSec: number } {
  if (!range || typeof range !== "object") return false;
  const candidate = range as { startSec?: unknown; endSec?: unknown };
  return typeof candidate.startSec === "number" && Number.isFinite(candidate.startSec)
    && typeof candidate.endSec === "number" && Number.isFinite(candidate.endSec)
    && candidate.startSec >= 0 && candidate.endSec > candidate.startSec;
}

function validRect(rect: unknown): rect is Region {
  if (!rect || typeof rect !== "object") return false;
  const candidate = rect as Partial<Region>;
  return [candidate.x, candidate.y, candidate.w, candidate.h].every((v) => typeof v === "number" && Number.isFinite(v))
    && (candidate.w ?? 0) > 0 && (candidate.h ?? 0) > 0;
}

function validReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validAction(value: unknown): value is "keep" | "cut" {
  return value === "keep" || value === "cut";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPoint(point: unknown): point is { x: number; y: number } {
  if (!point || typeof point !== "object") return false;
  const candidate = point as { x?: unknown; y?: unknown };
  return typeof candidate.x === "number" && Number.isFinite(candidate.x)
    && typeof candidate.y === "number" && Number.isFinite(candidate.y);
}

function validAnnotationPayload(annotation: unknown): annotation is Annotation {
  if (!annotation || typeof annotation !== "object") return false;
  const candidate = annotation as Partial<Annotation> & { type?: unknown; from?: unknown; to?: unknown; rect?: unknown };
  if (candidate.type === "arrow") return validPoint(candidate.from) && validPoint(candidate.to);
  if (candidate.type === "box") return !!candidate.rect && validRect(candidate.rect);
  if (candidate.type === "spotlight") return !!candidate.rect && validRect(candidate.rect);
  return false;
}

function rebuildSegments(
  segments: PlanSegment[],
  edits: Array<{ startSec: number; endSec: number; action: "keep" | "cut"; reason: string }>,
  idMode: boolean,
  allocateId: (prefix: string) => string,
): PlanSegment[] {
  const boundaries = new Set<number>();
  for (const segment of segments) {
    boundaries.add(segment.start);
    boundaries.add(segment.end);
  }
  for (const edit of edits) {
    boundaries.add(edit.startSec);
    boundaries.add(edit.endSec);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const out: PlanSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const source = segments.find((segment) => segment.start <= start && segment.end >= end);
    if (!source) continue;
    const edit = [...edits].reverse().find((item) => item.startSec < end && item.endSec > start);
    const next: PlanSegment = {
      ...(source.start === start && source.id ? { id: source.id } : {}),
      start: round(start),
      end: round(end),
      action: edit?.action ?? source.action,
      reason: edit?.reason ?? source.reason,
    };
    if (idMode && !next.id) next.id = allocateId("seg");
    const previous = out.at(-1);
    if (previous && previous.end === next.start && previous.action === next.action && previous.reason === next.reason) {
      previous.end = next.end;
    } else {
      out.push(next);
    }
  }
  return out;
}

export function compileEditIntents(
  docs: LoadedDocs,
  intents: EditIntent[],
  context: EditIntentContext,
): EditIntentPlan {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  const summary: string[] = [];
  if (!docs.cutplan || !docs.transcript || typeof docs.cutplan !== "object" || typeof docs.transcript !== "object") {
    return { patch: {}, warnings, errors: [problem(0, "cutplan/transcript がありません")], summary };
  }
  const cutplan = clone(docs.cutplan as CutPlan);
  const transcript = clone(docs.transcript as Transcript);
  const overlays: Overlays = clone(docs.overlays ?? {});
  const editable = readEditableShape(docs);
  const idMode = hasAnyId(editable);
  const used = usedIdsOf(editable);
  const seed = JSON.stringify({ docs: editable, intents });
  let idCounter = 0;
  const allocateId = (prefix: string): string => {
    while (true) {
      const token = createHash("sha256").update(`${seed}\0${prefix}\0${idCounter++}`)
        .digest("hex").slice(0, 8);
      const value = Number.parseInt(token, 16).toString(36).padStart(6, "0").slice(-6);
      const id = `${prefix}_${value}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const rangeEdits: Array<{ startSec: number; endSec: number; action: "keep" | "cut"; reason: string }> = [];
  let cutplanChanged = false;
  let transcriptChanged = false;
  let overlaysChanged = false;

  intents.forEach((intent, index) => {
    if (!intent || typeof intent !== "object" || typeof intent.type !== "string") {
      errors.push(problem(index, "intent が不正です"));
      return;
    }
    if (intent.type === "set-range-action") {
      if (!validRange(intent.range) || !validAction(intent.action) || !validReason(intent.reason)) {
        errors.push(problem(index, "range/action/reason が不正です"));
        return;
      }
      rangeEdits.push({ ...intent.range, action: intent.action, reason: intent.reason });
      cutplanChanged = true;
      summary.push(`${intent.range.startSec}-${intent.range.endSec}秒を${intent.action}`);
      return;
    }
    if (intent.type === "trim-pauses") {
      if (!Number.isFinite(intent.minPauseSec) || intent.minPauseSec < 0
        || !Number.isFinite(intent.keepHeadSec) || intent.keepHeadSec < 0
        || !Number.isFinite(intent.keepTailSec) || intent.keepTailSec < 0
        || (intent.range !== undefined && !validRange(intent.range)) || !validReason(intent.reason)) {
        errors.push(problem(index, "trim-pauses のパラメータが不正です"));
        return;
      }
      if (!context.autoCuts) {
        errors.push(problem(index, "cuts.auto.json がないため trim-pauses を実行できません"));
        return;
      }
      let count = 0;
      for (const silence of context.autoCuts.silences) {
        const start = Math.max(silence.start + intent.keepHeadSec, intent.range?.startSec ?? 0);
        const end = Math.min(silence.end - intent.keepTailSec, intent.range?.endSec ?? Infinity);
        if (silence.end - silence.start < intent.minPauseSec || end - start < 0.1) continue;
        rangeEdits.push({ startSec: round(start), endSec: round(end), action: "cut", reason: intent.reason });
        count++;
      }
      cutplanChanged ||= count > 0;
      summary.push(`無音${count}件を短縮`);
      return;
    }
    if (intent.type === "set-caption-text") {
      if (typeof intent.target !== "string" || !intent.target.startsWith("@cap_")
        || typeof intent.text !== "string" || !intent.text.trim()) {
        errors.push(problem(index, "target または text が不正です"));
        return;
      }
      const caption = transcript.segments.find((segment) => `@${segment.id}` === intent.target);
      if (!caption) {
        errors.push(problem(index, `${intent.target} が見つかりません`));
        return;
      }
      caption.text = intent.text;
      transcriptChanged = true;
      summary.push(`${intent.target} の字幕を変更`);
      return;
    }
    if (intent.type === "set-caption-timing") {
      const validSec = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
      if (typeof intent.target !== "string" || !intent.target.startsWith("@cap_")
        || !validSec(intent.startSec) || !validSec(intent.endSec)
        || (intent.startSec === undefined && intent.endSec === undefined)) {
        errors.push(problem(index, "target または startSec/endSec が不正です"));
        return;
      }
      const caption = transcript.segments.find((segment) => `@${segment.id}` === intent.target);
      if (!caption) {
        errors.push(problem(index, `${intent.target} が見つかりません`));
        return;
      }
      const start = round(intent.startSec ?? caption.start);
      const end = round(intent.endSec ?? caption.end);
      if (!(end > start)) {
        errors.push(problem(index, `${intent.target} の区間が不正です(${start}-${end})`));
        return;
      }
      caption.start = start;
      caption.end = end;
      // words[] は描画時に区間へクリップされるが、範囲外のまま残すと validate が
      // 警告するので新区間へ揃える(区間外に完全に出た語は落とす)
      if (caption.words) {
        const words = caption.words
          .filter((w) => w.end > start && w.start < end)
          .map((w) => ({ ...w, start: Math.max(w.start, start), end: Math.min(w.end, end) }));
        if (words.length > 0) caption.words = words;
        else delete caption.words;
      }
      transcriptChanged = true;
      summary.push(`${intent.target} の表示区間を${start}-${end}秒に変更`);
      return;
    }
    if (intent.type === "add-blur") {
      if (!validRange(intent.range) || !validRect(intent.rect)
        || (intent.strength !== undefined && (!Number.isFinite(intent.strength) || intent.strength < 0 || intent.strength > 1))) {
        errors.push(problem(index, "blur のrange/rect/strengthが不正です"));
        return;
      }
      overlays.blurs ??= [];
      overlays.blurs.push({
        ...(idMode ? { id: allocateId("bl") } : {}),
        start: intent.range.startSec,
        end: intent.range.endSec,
        rect: intent.rect,
        strength: intent.strength ?? DEFAULT_BLUR_STRENGTH,
      });
      overlaysChanged = true;
      summary.push("ぼかしを追加");
      return;
    }
    if (intent.type === "add-annotation") {
      if (!validRange(intent.range) || !validAnnotationPayload(intent.annotation)) {
        errors.push(problem(index, "annotation のrange/bodyが不正です"));
        return;
      }
      const annotation = {
        ...intent.annotation,
        ...(idMode ? { id: allocateId("ann") } : {}),
        start: intent.range.startSec,
        end: intent.range.endSec,
      } as Annotation;
      overlays.annotations ??= [];
      overlays.annotations.push(annotation);
      overlaysChanged = true;
      summary.push(`${intent.annotation.type}注釈を追加`);
      return;
    }
    if (intent.type === "place-material") {
      if (!validRange(intent.range) || typeof intent.file !== "string" || !safeExistingPath(context.recordingDir, intent.file)) {
        errors.push(problem(index, "material のrangeまたはfileが不正です"));
        return;
      }
      const volume = intent.audio?.volume;
      if (volume !== undefined && (!Number.isFinite(volume) || volume < 0 || volume > 2)) {
        errors.push(problem(index, "material volume は0-2です"));
        return;
      }
      if (!isObject(intent.placement)) {
        errors.push(problem(index, "material placement が不正です"));
        return;
      }
      if (intent.placement.mode === "overlay") {
        overlays.overlays ??= [];
        overlays.overlays.push({
          ...(idMode ? { id: allocateId("mat") } : {}),
          start: intent.range.startSec,
          end: intent.range.endSec,
          file: intent.file,
          ...(intent.placement.rect ? { rect: intent.placement.rect } : {}),
          ...(intent.placement.fit ? { fit: intent.placement.fit } : {}),
          ...(intent.placement.track ? { track: intent.placement.track } : {}),
          ...(volume !== undefined ? { volume } : {}),
        });
      } else if (intent.placement.mode === "insert") {
        if (!Number.isFinite(intent.placement.durationSec) || intent.placement.durationSec <= 0) {
          errors.push(problem(index, "insert durationSec は正数です"));
          return;
        }
        overlays.inserts ??= [];
        overlays.inserts.push({
          ...(idMode ? { id: allocateId("ins") } : {}),
          at: intent.range.startSec,
          file: intent.file,
          durationSec: intent.placement.durationSec,
          ...(intent.placement.startFrom !== undefined ? { startFrom: intent.placement.startFrom } : {}),
          ...(intent.placement.fit ? { fit: intent.placement.fit } : {}),
          ...(volume !== undefined ? { volume } : {}),
        });
      } else {
        errors.push(problem(index, "material placement が不正です"));
        return;
      }
      overlaysChanged = true;
      summary.push(`${intent.file} を配置`);
      return;
    }
    errors.push(problem(index, `未知のintent: ${(intent as { type: string }).type}`));
  });

  if (cutplanChanged) cutplan.segments = rebuildSegments(cutplan.segments, rangeEdits, idMode, allocateId);
  const replace: NonNullable<ApplyPatch["replace"]> = {};
  if (cutplanChanged) replace.cutplan = cutplan;
  if (transcriptChanged) replace.transcript = transcript;
  if (overlaysChanged) replace.overlays = overlays;
  return { patch: Object.keys(replace).length > 0 ? { replace } : {}, warnings, errors, summary };
}

function readEditableShape(docs: LoadedDocs) {
  return {
    cutplan: docs.cutplan as import("../types.ts").CutPlan | null,
    transcript: docs.transcript as import("../types.ts").Transcript | null,
    overlays: docs.overlays as import("../types.ts").Overlays | null,
    chapters: docs.chapters as import("../types.ts").Chapters | null,
    bgm: docs.bgm as import("../types.ts").Bgm | null,
    thumbnail: docs.thumbnail as import("../types.ts").Thumbnail | null,
  };
}

function safeExistingPath(dir: string, file: string): boolean {
  const root = resolve(dir);
  const abs = resolve(dir, file);
  return abs.startsWith(root + sep) && existsSync(abs);
}

function loadDocs(dir: string): LoadedDocs {
  const editable = readEditableDocs(dir);
  const read = (file: string): unknown => {
    const path = join(dir, file);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  return { manifest: read("manifest.json"), meta: read("meta.json"), ...editable };
}

function loadAutoCuts(dir: string): AutoCuts | null {
  const file = join(dir, "cuts.auto.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as AutoCuts : null;
}

export function planIntentEdits(dir: string, intents: EditIntent[]): ApplyPlan & { intentPlan: EditIntentPlan } {
  const intentPlan = compileEditIntents(loadDocs(dir), intents, { recordingDir: dir, autoCuts: loadAutoCuts(dir) });
  if (intentPlan.errors.length > 0) {
    return { body: {}, changedFiles: [], diff: [], errors: intentPlan.errors, warnings: intentPlan.warnings, intentPlan };
  }
  return { ...planApply(dir, intentPlan.patch), intentPlan };
}

export function applyIntentEdits(dir: string, intents: EditIntent[]): ApplyResult & { intentPlan: EditIntentPlan } {
  const planned = planIntentEdits(dir, intents);
  if (planned.errors.length > 0) {
    return { written: [], backupDir: null, plan: planned, intentPlan: planned.intentPlan };
  }
  return { ...applyEdits(dir, planned.intentPlan.patch), intentPlan: planned.intentPlan };
}
