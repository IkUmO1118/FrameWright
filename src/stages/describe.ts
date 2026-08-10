// 編集状態のテキスト要約。AI(Claude Code)や人間が JSON 群を全部読まずに
// 「どこが残っていて・どこが切られ・そこで何を喋っているか」を把握するための
// 知覚コマンド。時刻は「元 = 元収録の秒 / 出力 = カット後(preview/final)の秒」を
// 併記する(人間は preview を見て出力秒で話し、編集ファイルは元秒で書くため)。

import { cliCmd } from "../lib/cliName.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmtT } from "../lib/fmt.ts";
import { isImageFile } from "../lib/overlayFade.ts";
import { resolveDescribePausesCfg } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";
import { DEFAULT_SILENCE_CUT_REASON } from "../lib/buildCutplan.ts";
import { CUT_REASON_IDS, REASON_ID_FAMILY } from "../lib/reasonIds.ts";
import type { FirstPlan, FirstPlanEntry } from "../lib/firstPlan.ts";
import { EFFECT_REASON_IDS, EFFECT_REASON_ID_FAMILY } from "../lib/effectReasonIds.ts";
import type { FirstEffectsPlan } from "../lib/firstEffectsPlan.ts";
import { pausesWithinKeeps } from "../lib/perception.ts";
import type { KeepPause } from "../lib/perception.ts";
import { framesFreshness } from "../lib/framesIndex.ts";
import { readScreenIndex } from "../lib/screenIndex.ts";
import type { ScreenIndexRead } from "../lib/screenIndex.ts";
import { outputSize } from "../lib/profile.ts";
import type { FramesShot } from "../lib/framesIndex.ts";
import {
  buildTimeline,
  insertSpans,
  mergeIntervals,
  remapInterval,
  snapToOutput,
  toOutputTime,
} from "../lib/timeline.ts";
import type { TimelineEntry } from "../lib/timeline.ts";
import { captionTrack, hasCamera, manifestLayout, overlayTrack, textTrack } from "../types.ts";
import type {
  AutoCuts,
  Annotation,
  Bgm,
  CaptionPos,
  CaptionStyle,
  CaptionTrackDef,
  ColorFilter,
  Chapters,
  CutPlan,
  Interval,
  LayerId,
  Manifest,
  Meta,
  Overlays,
  PlanSegment,
  Region,
  SystemTranscript,
  Transcript,
  WordTiming,
} from "../types.ts";

/** overlays.json の inserts の1件(存在するファイルだけに絞り込んだもの)。
 * timeline.ts の InsertSpan(at/durationSec)の上位互換 */
type LoadedInsert = NonNullable<Overlays["inserts"]>[number];

/** describe() が読み込む全ファイル+派生値。散文レンダラ(describe)と
 * JSON ビルダ(describeJson/buildProjection)が共有する唯一の入力構造
 * (設計 §論点3)。読み込み規約(必須/任意ファイルの扱い)をここに集約し、
 * bgm=null を必須と誤解する旧バグ型の drift を防ぐ */
interface DescribeInputs {
  dir: string;
  manifest: Manifest;
  cutplan: CutPlan;
  transcript: Transcript;
  overlays: Overlays;
  bgm: Bgm | null;
  chapters: Chapters;
  meta: Meta;
  /** システム音声の知覚専用文字起こし(transcript.system.json)。無ければ null
   *  =散文/--json ともにバイト等価(ファイル存在でのみ露出) */
  systemTranscript: SystemTranscript | null;
  keeps: Interval[];
  cutRecords: PlanSegment[];
  inserts: LoadedInsert[];
  timeline: TimelineEntry[];
  keptSec: number;
  outDur: number;
}

function loadDescribeInputs(dir: string): DescribeInputs {
  // 必須ファイル(パイプラインの生成物)。無ければ実行を促して止める
  const readRequired = <T>(file: string): T => {
    const p = join(dir, file);
    if (!existsSync(p)) {
      throw new Error(`${file} がありません。${cliCmd()} editor <dir> でベースメディアを選んでください`);
    }
    return JSON.parse(readFileSync(p, "utf8")) as T;
  };
  // 任意ファイル。無ければ fallback を返す。fallback には「存在しない」を
  // 表す null も渡せる(bgm.json など)。必須扱いと区別できる別関数にすることで、
  // bgm.json の無いフォルダ(新規プロジェクト全般)で describe が誤って
  // 落ちる旧バグ(fallback=null を必須と解釈していた)を断つ
  const readOptional = <T>(file: string, fallback: T): T => {
    const p = join(dir, file);
    if (!existsSync(p)) return fallback;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  };
  const manifest = readRequired<Manifest>("manifest.json");
  const cutplan = readRequired<CutPlan>("cutplan.json");
  const transcript = readRequired<Transcript>("transcript.json");
  const overlays = readOptional<Overlays>("overlays.json", {});
  const bgm = readOptional<Bgm | null>("bgm.json", null);
  const chapters = readOptional<Chapters>("chapters.json", { chapters: [] });
  const meta = readOptional<Meta>("meta.json", { titles: [], description: "" });
  const systemTranscript = readOptional<SystemTranscript | null>("transcript.system.json", null);

  const keeps = mergeIntervals(
    cutplan.segments.filter((s) => s.action === "keep"),
  );
  const cutRecords = cutplan.segments.filter((s) => s.action === "cut");
  const inserts = (overlays.inserts ?? []).filter((i) =>
    existsSync(join(dir, i.file)),
  );
  const timeline = buildTimeline(keeps, inserts);
  const keptSec = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const outDur = keptSec + inserts.reduce((a, i) => a + i.durationSec, 0);

  return {
    dir,
    manifest,
    cutplan,
    transcript,
    overlays,
    bgm,
    chapters,
    meta,
    systemTranscript,
    keeps,
    cutRecords,
    inserts,
    timeline,
    keptSec,
    outDur,
  };
}

/** 区間 [start, end) と 0.05 秒以上重なるか */
function overlaps(s: { start: number; end: number }, start: number, end: number): boolean {
  return Math.min(s.end, end) - Math.max(s.start, start) > 0.05;
}

/** 各テロップの所属 keep(0始まり)。見えるものは「最初に重なる keep」、
 * 完全にカット内で消えるものは所属なし(null) */
function keepIndexOf(
  s: { start: number; end: number },
  keeps: Interval[],
  timeline: TimelineEntry[],
): number | null {
  if (remapInterval(s.start, s.end, timeline).length === 0) return null;
  const i = keeps.findIndex((k) => overlaps(s, k.start, k.end));
  return i >= 0 ? i : null;
}

/** describe 散文用: 画面区間のうち keep [start,end) と重なるものを、表示用の
 *  1行ラベル付きで返す(video-perception-P1 §2.7)。ラベルは P4 の `summary` が
 *  あればそれ、無ければ代表 OCR の先頭1行。どちらも無い区間は出さない。
 *  screenIndex が null(既定オフ or 未実行)なら常に空配列 = 散文はバイト等価 */
function screenSegmentsIn(
  screenIndex: ScreenIndexRead | null,
  start: number,
  end: number,
): { sourceSec: number; lenSec: number; label: string }[] {
  if (!screenIndex) return [];
  const out: { sourceSec: number; lenSec: number; label: string }[] = [];
  for (const raw of screenIndex.segments) {
    const seg = raw as {
      sourceSec?: unknown; endSourceSec?: unknown; lenSec?: unknown;
      summary?: unknown; ocr?: { lines?: unknown } | null;
    };
    if (typeof seg.sourceSec !== "number" || typeof seg.endSourceSec !== "number") continue;
    if (!(seg.sourceSec < end && start < seg.endSourceSec)) continue;
    const summary = typeof seg.summary === "string" && seg.summary.trim() ? seg.summary.trim() : null;
    const firstLine =
      seg.ocr && Array.isArray(seg.ocr.lines) && typeof seg.ocr.lines[0] === "string"
        ? (seg.ocr.lines[0] as string).trim()
        : null;
    const label = summary ?? (firstLine && firstLine.length > 0 ? firstLine : null);
    if (label === null) continue;
    out.push({
      sourceSec: seg.sourceSec,
      lenSec: typeof seg.lenSec === "number" ? seg.lenSec : seg.endSourceSec - seg.sourceSec,
      label,
    });
  }
  return out;
}

export function describe(dir: string, cfg?: Config): string {
  const inp = loadDescribeInputs(dir);
  const {
    manifest,
    cutplan,
    transcript,
    overlays,
    bgm,
    chapters,
    meta,
    systemTranscript,
    keeps,
    cutRecords,
    inserts,
    timeline,
    keptSec,
    outDur,
  } = inp;

  // keep 内の間(cfg.describe.pauses が真のときだけ。cfg 省略時は無効=バイト等価)。
  // cuts.auto.json の silences から算出(新規計測なし)。keepIndex ごとに引ける形に
  const pausesCfg = cfg ? resolveDescribePausesCfg(cfg) : { enabled: false, max: 3, minSec: 0.6 };
  const pausesByKeep = new Map<number, KeepPause[]>();
  if (pausesCfg.enabled) {
    const autoPath = join(dir, "cuts.auto.json");
    const silences = existsSync(autoPath)
      ? (JSON.parse(readFileSync(autoPath, "utf8")) as AutoCuts).silences
      : [];
    for (const p of pausesWithinKeeps(keeps, silences, pausesCfg.minSec)) {
      const arr = pausesByKeep.get(p.keepIndex) ?? [];
      if (arr.length < pausesCfg.max) arr.push(p);
      pausesByKeep.set(p.keepIndex, arr);
    }
  }

  const quote = (text: string): string => {
    const t = text.trim().replace(/\s+/g, " ");
    return t.length > 36 ? `${t.slice(0, 36)}…` : t;
  };

  const lines: string[] = [];
  lines.push(
    `収録: ${manifest.source} ${fmtT(manifest.durationSec)} → 出力 ${fmtT(outDur)}` +
      `(keep ${keeps.length}区間、${fmtT(manifest.durationSec - keptSec)} をカット)`,
  );
  const bgmDesc =
    bgm && bgm.tracks?.length
      ? `bgm.json(${bgm.tracks.length}区間${bgm.tracks.some((t) => t.timebase === "output") ? `・うち${bgm.tracks.filter((t) => t.timebase === "output").length}件は出力秒指定` : ""}: ${[...new Set(bgm.tracks.map((t) => t.file))].join(", ")})`
      : (["bgm.mp3", "bgm.m4a", "bgm.wav"].find((f) => existsSync(join(dir, f))) ?? "なし");
  lines.push(
    `approved: ${cutplan.approved} / テロップ ${transcript.segments.length}件 / BGM ${bgmDesc}`,
  );
  // 分類(reasonId)行は sticky(buildProjection の summary.reasonIds と同じ
  // 判定): reasonId を1つも持たない かつ plan.first.json も無ければ1行も足さない
  {
    const hasAnyReasonId = cutplan.segments.some((s) => s.reasonId !== undefined);
    const firstPlanPath = join(dir, "plan.first.json");
    const hasFirstPlan = existsSync(firstPlanPath);
    if (hasAnyReasonId || hasFirstPlan) {
      const silenceReason = cfg?.detect?.silenceCutReason ?? DEFAULT_SILENCE_CUT_REASON;
      const cov = computeReasonIdCoverage(cutplan.segments, silenceReason);
      const pct = Math.round(cov.ratio * 100);
      let line = `分類: 意味カット ${cov.semanticCuts} 件中 ${cov.labeled} 件に分類 id(${pct}%)`;
      if (hasFirstPlan) {
        try {
          const firstPlan = JSON.parse(readFileSync(firstPlanPath, "utf8")) as FirstPlan;
          const fvf = computeFirstVsFinal(firstPlan, cutplan.segments);
          const flipped =
            fvf.flippedToKeep.reduce((a, f) => a + f.flipped, 0) +
            fvf.flippedToCut.reduce((a, f) => a + f.flipped, 0);
          line += ` / 初版から反転 ${flipped} 件`;
        } catch {
          // 壊れた plan.first.json は反転件数を省略するだけ(coverage 行は出す)
        }
      }
      lines.push(line);
    }
  }
  lines.push("");
  lines.push(
    "時刻は「元 = 元収録の秒(編集ファイルに書く値)/ 出力 = カット後の秒(preview/final の再生位置)」",
  );
  lines.push("");

  /* ---- タイムライン(カットと keep の交互。テロップ・カット理由を添える) ---- */

  // 画面区間は describe.screen が真のときだけ読む(既定オフ=fs にも触らない)
  const screenIndex = cfg?.describe?.screen === true ? readScreenIndex(dir) : null;

  for (let i = 0; i <= keeps.length; i++) {
    // keep[i] の手前のカット区間(収録先頭・末尾のカットも含む)
    const gapStart = i === 0 ? 0 : keeps[i - 1].end;
    const gapEnd = i < keeps.length ? keeps[i].start : manifest.durationSec;
    if (gapEnd - gapStart > 0.05) {
      lines.push(
        `✂ カット 元 ${fmtT(gapStart)}–${fmtT(gapEnd)}(${(gapEnd - gapStart).toFixed(1)}秒)`,
      );
      for (const r of cutRecords) {
        if (overlaps(r, gapStart, gapEnd) && r.reason) lines.push(`    理由: ${r.reason}`);
      }
      for (const s of transcript.segments) {
        if (overlaps(s, gapStart, gapEnd) && keepIndexOf(s, keeps, timeline) === null) {
          lines.push(`    消える発言 ${fmtT(s.start)}「${quote(s.text)}」`);
        }
      }
    }
    if (i >= keeps.length) break;

    const k = keeps[i];
    const outStart = toOutputTime(k.start, timeline) ?? 0;
    lines.push(
      `■ keep${i + 1} 元 ${fmtT(k.start)}–${fmtT(k.end)} → 出力 ${fmtT(outStart)}–` +
        `${fmtT(outStart + (k.end - k.start))}(${(k.end - k.start).toFixed(1)}秒)`,
    );
    for (const s of transcript.segments) {
      if (keepIndexOf(s, keeps, timeline) !== i) continue;
      const track = captionTrack(s);
      lines.push(`    ${fmtT(s.start)}${track > 1 ? ` [T${track}]` : ""}「${quote(s.text)}」`);
    }
    // システム音声(アプリ/デモ/TTS)の発話。transcript.system.json があるときだけ
    // (ファイル不在=null なら1行も足さない=散文 golden はバイト等価)
    if (systemTranscript) {
      for (const s of systemTranscript.segments) {
        if (overlaps(s, k.start, k.end)) {
          lines.push(`    ${fmtT(s.start)} [システム音声]「${quote(s.text)}」`);
        }
      }
    }
    // 画面状態の区間(video-perception-P1 §2.7)。cfg.describe.screen が真で
    // screen.probe/index.json があるときだけ。無効/不在なら1行も足さない
    // (= 既定では散文 golden とバイト等価)
    for (const seg of screenSegmentsIn(screenIndex, k.start, k.end)) {
      lines.push(`    ${fmtT(seg.sourceSec)} [画面]「${quote(seg.label)}」(${seg.lenSec.toFixed(1)}秒)`);
    }
    // keep 内の間(cfg.describe.pauses が真のときだけ。無効なら1行も足さない)
    for (const p of pausesByKeep.get(i) ?? []) {
      lines.push(`    間 元 ${fmtT(p.start)}(${p.len.toFixed(1)}秒・keep先頭+${p.offset.toFixed(1)}秒)`);
    }
  }

  /* ---- 演出・章・メタ ---- */

  const ovList = overlays.overlays ?? [];
  const wipeList = overlays.wipeFull ?? [];
  const textList = overlays.texts ?? [];
  if (ovList.length + inserts.length + wipeList.length + textList.length > 0) {
    lines.push("");
    lines.push("演出:");
    for (const o of ovList) {
      lines.push(
        `  素材 V${o.track ?? (o.layer === "over" ? 2 : 1)} 元 ${fmtT(o.start)}–${fmtT(o.end)} ${o.file}` +
          (existsSync(join(dir, o.file)) ? "" : "(⚠ ファイルなし)"),
      );
    }
    insertSpans(keeps, inserts).forEach((sp) => {
      const ins = inserts[sp.index];
      lines.push(
        `  挿入${isImageFile(ins.file) ? " [静止画]" : ""} 元 ${fmtT(ins.at)} の手前に ${ins.file}(${ins.durationSec}秒)→ 出力 ${fmtT(sp.start)}–${fmtT(sp.end)}`,
      );
    });
    for (const w of wipeList) {
      lines.push(`  ワイプ全画面 元 ${fmtT(w.start)}–${fmtT(w.end)}`);
    }
    for (const t of textList) {
      lines.push(`  テキスト 元 ${fmtT(t.start)}–${fmtT(t.end)}「${quote(t.text)}」`);
    }
  }

  if (chapters.chapters.length > 0) {
    lines.push("");
    lines.push("章(YouTube 概要欄用):");
    for (const c of chapters.chapters) {
      const out = snapToOutput(c.start, timeline);
      lines.push(
        `  元 ${fmtT(c.start)} → 出力 ${out !== null ? fmtT(out) : "(カット内・スナップ先なし)"} ${c.title}`,
      );
    }
  }

  if (meta.titles.length > 0) {
    lines.push("");
    lines.push(`タイトル案: ${meta.titles.slice(0, 3).join(" / ")}`);
  }

  /* ---- frames の鮮度(stale-PNG 罠対策。none は無出力=golden 不変) ---- */
  const freshness = framesFreshness(dir);
  if (freshness.state === "stale") {
    lines.push("");
    lines.push(
      `⚠ frames は撮影後に ${freshness.changed.join("、")} が変更されており古い可能性があります。` +
        `古い PNG を読まないよう \`${cliCmd()} frames <dir> ...\` で撮り直してください` +
        "(config.yaml の変更はこの検出の対象外です)",
    );
  } else if (freshness.state === "fresh") {
    lines.push("");
    lines.push(`frames/: ${describeShot(freshness.shot)}(現在の JSON と一致)`);
  }
  // freshness.state === "none"(index.json 無し=未撮影/機能導入前)は
  // 意図的に無出力(golden test を1バイトも動かさない)

  return lines.join("\n");
}

/** frames/index.json の shot を「何の絵が今 frames/ に入っているか」の
 * 一行に整形する。 */
function describeShot(shot: FramesShot): string {
  const modeFlag = shot.mode === "times" ? "--t" : `--${shot.mode}`;
  const suffix = [shot.ocr ? "--ocr" : null, shot.fullRes ? "--full-res" : null]
    .filter((s): s is string => s !== null)
    .join(" ");
  return `${modeFlag} 撮影${suffix ? `(${suffix})` : ""}・${shot.count}枚`;
}

/* ==================================================================== */
/* 機械可読な完全射影(describe --json)。設計 §論点2 の型・規則(A〜E)どおり。
 * 発話・タイトルは verbatim(quote() も slice() も使わない=規則A)。
 * 元秒はファイルの値そのまま、出力秒は timeline.ts の写像結果(規則B)。
 * トップレベルの構造キーは常在、要素内の任意フィールドは元ファイルに
 * 在るときだけ載せる(規則C)。テロップの pos/style はセグメント個別指定の
 * みで、トラック標準とのマージ解決はしない(規則D)。キー順は構築順で
 * 固定・派生値は round2(規則E)。 ==================================== */

export interface DescribeProjection {
  schemaVersion: number;
  source: SourceInfo;
  summary: Summary;
  keeps: KeepEntry[];
  cuts: CutEntry[];
  captions: CaptionEntry[];
  overlays: OverlaysProjection;
  chapters: ChapterEntry[];
  meta: { titles: string[]; description: string };
  bgm: BgmProjection;
  /** システム音声の知覚専用文字起こし(transcript.system.json)。**ファイルが
   *  在るときだけ**このキーが出る(不在時は省略=既存 --json とバイト等価)。
   *  規則C(トップレベル常在)の明示的な例外=新規任意成果物は存在時のみ */
  systemAudio?: SystemAudioProjection;
  /** 画面状態の区間トラック(`screen.probe/index.json`。video-perception-P1)。
   *  **ファイルが在るときだけ**このキーが出る(不在時は省略=既存 --json と
   *  バイト等価)。systemAudio と同じ「新規任意成果物は存在時のみ」の例外。
   *  中身は index.json の segments を**そのまま**載せる(再計算しない。§2.7)。
   *  これは編集状態ではなく**観測**なので、規則A(完全復元)の対象外 */
  screen?: ScreenProjection;
}

export interface ScreenProjection {
  schemaVersion: number;
  capturedAt: string;
  range: { startSec: number; endSec: number };
  ocrAvailable: boolean;
  params: Record<string, number>;
  segments: Record<string, unknown>[];
}

export interface SystemAudioProjection {
  speaker: "system";
  segments: { start: number; end: number; text: string; out: Interval[] }[];
}

export interface SourceInfo {
  file: string;
  durationSec: number;
  layout: "obs-canvas" | "plain" | "stills";
  /** manifest.canvas がある新規プロジェクトだけに載る(旧収録は byte 不変)。 */
  canvas?: { name: string; width: number; height: number };
  /** manifest.baseLayout がある新規プロジェクトだけに載る(旧収録は byte 不変)。 */
  baseLayout?: string;
  video: {
    width: number;
    height: number;
    fps: number;
    screenRegion: Region;
    cameraRegion?: Region;
  };
  audio: { micWav: string; systemStream: number | null };
}

export interface Summary {
  approved: boolean;
  outDurationSec: number;
  keptSec: number;
  cutSec: number;
  keepCount: number;
  captionCount: number;
  /** カット判断の分類 id(reasonId)の集計(§docs/plans/2026-07-20-cut-knowledge-p3-p5-design.md
   *  §7)。**sticky**: `reasonId` を1つも持たない cutplan かつ `plan.first.json` も
   *  無ければキー自体が無い(既存収録は導入前と deepEqual。I5) */
  reasonIds?: {
    coverage: ReasonIdCoverage;
    /** plan.first.json がある収録だけ(§P5-5)。無ければキーごと無い */
    firstVsFinal?: FirstVsFinal;
  };
  /** 演出判断の分類集計。reasonId付き演出またはplan-effects.first.jsonが
   *  あるときだけ出す(sticky。旧収録のdescribe --jsonを変えない)。 */
  effectReasonIds?: {
    coverage: EffectReasonIdCoverage;
    firstVsFinal?: EffectFirstVsFinal;
  };
}

/** cut 判断の reasonId 語彙カバレッジ(§7)。分母は fillSilenceGaps が作った
 *  穴埋め cut を除く「意味カット」(P1P2 §8注意3: 穴埋め cut に reasonId は
 *  付かない前提の帰結。含めると永久に100%に届かない)。`byId` は cut 系
 *  (REASON_ID_FAMILY==="cut")の分類 id 全部を固定の鍵順で持つ(未使用は0)。 */
export interface ReasonIdCoverage {
  semanticCuts: number;
  labeled: number;
  ratio: number;
  byId: Record<string, number>;
}

/** plan.first.json(初版)と現在の cutplan.json(最終)を、切る/残す方向の
 *  反転として比較した集計(§P5-5)。 */
export interface FirstVsFinal {
  source: "plan" | "plan --cuts-only";
  reasonIdsEnabled: boolean;
  flippedToKeep: { reasonId: string; first: number; flipped: number; rate: number }[];
  flippedToCut: { reasonId: string; first: number; flipped: number; rate: number }[];
}

export interface EffectReasonIdCoverage {
  effects: number;
  labeled: number;
  ratio: number;
  byId: Record<string, number>;
}

export type EffectDecisionType = "zoom" | "blur" | "annotation" | "none";

export interface EffectFirstVsFinal {
  source: "plan-effects";
  effectReasonIdsEnabled: boolean;
  pattern: string;
  compared: number;
  flipped: number;
  rate: number;
  transitions: {
    effectReasonId?: string;
    from: EffectDecisionType;
    to: EffectDecisionType;
    count: number;
  }[];
  added: { effect: Exclude<EffectDecisionType, "none">; count: number }[];
}

export interface KeepEntry {
  index: number;
  start: number;
  end: number;
  durationSec: number;
  outStart: number;
  outEnd: number;
  /** keep 内に残った無音(間)。`describe.pauses` が真のときだけ付く
   *  (既定オフ=省略=既存 --json とバイト等価)。縦プロファイルの mergedRanges には付かない */
  pauses?: KeepPause[];
}

export interface CutEntry {
  start: number;
  end: number;
  durationSec: number;
  reasons: string[];
  lostCaptions: LostCaption[];
}

export interface LostCaption {
  start: number;
  end: number;
  text: string;
  track: number;
}

export interface CaptionEntry {
  index: number;
  /** 安定 id(`@id` mention の発見手段。散文 describe には出ない)。
   * id 未採番(id-stamp 未実行)なら省略される */
  id?: string;
  start: number;
  end: number;
  text: string;
  track: number;
  pos?: CaptionPos;
  style?: CaptionStyle;
  words?: WordTiming[];
  out: Interval[];
  keepIndex: number | null;
  visible: boolean;
}

export interface OverlaysProjection {
  materials: MaterialEntry[];
  inserts: InsertEntry[];
  wipeFull: MappedInterval[];
  zooms: ZoomEntry[];
  blurs: BlurEntry[];
  annotations: AnnotationEntry[];
  texts: TextEntry[];
  hideCaption: MappedInterval[];
  colorFilter: ColorFilter | null;
  layerOrder: LayerId[] | null;
  captionTracks: CaptionTrackDef[];
}

export interface KeyframeEntry {
  sourceAt: number;
  outputTimes: number[];
  easing?: string;
  values: Record<string, number>;
}

/** 元秒区間 + その出力秒射影。演出の元秒 interval に一律で付ける。
 * id は安定 id(未採番なら省略) */
export interface MappedInterval {
  id?: string;
  /** 省略時は source。output を明記した要素だけ start/end 自体が出力秒。 */
  timebase?: "source" | "output";
  start: number;
  end: number;
  out: Interval[];
}

export interface MaterialEntry {
  id?: string;
  start: number;
  end: number;
  file: string;
  track: number;
  fit?: "contain" | "cover";
  startFrom?: number;
  volume?: number;
  opacity?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  rect?: Region;
  keyframeCount?: number;
  keyframes?: KeyframeEntry[];
  exists: boolean;
  out: Interval[];
}

export interface InsertEntry {
  id?: string;
  at: number;
  file: string;
  durationSec: number;
  /** image は宣言尺いっぱい表示される無音の静止画クリップ。 */
  kind: "image" | "video";
  startFrom?: number;
  fit?: "contain" | "cover";
  volume?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  exists: boolean;
  out: Interval | null;
}

export interface ZoomEntry extends MappedInterval {
  rect: Region;
  reasonId?: string;
  easeSec?: number;
}

export interface BlurEntry extends MappedInterval {
  rect: Region;
  reasonId?: string;
  strength?: number;
  keyframeCount?: number;
  keyframes?: KeyframeEntry[];
}

export type AnnotationEntry =
  | ({
      type: "arrow";
      from: CaptionPos;
      to: CaptionPos;
      color?: string;
      widthPx?: number;
      headPx?: number;
      reasonId?: string;
      keyframeCount?: number;
      keyframes?: KeyframeEntry[];
    } & MappedInterval)
  | ({
      type: "box";
      rect: Region;
      color?: string;
      widthPx?: number;
      radiusPx?: number;
      fill?: string;
      reasonId?: string;
      keyframeCount?: number;
      keyframes?: KeyframeEntry[];
    } & MappedInterval)
  | ({
      type: "spotlight";
      rect: Region;
      shape?: "rect" | "ellipse";
      dim?: number;
      featherPx?: number;
      radiusPx?: number;
      reasonId?: string;
      keyframeCount?: number;
      keyframes?: KeyframeEntry[];
    } & MappedInterval);

export interface TextEntry extends MappedInterval {
  reasonId?: string;
  text: string;
  track?: number;
  pos: CaptionPos;
  anchor?: "center" | "topLeft";
  style?: CaptionStyle;
}

export interface ChapterEntry {
  id?: string;
  start: number;
  out: number | null;
  title: string;
}

export interface BgmProjection {
  source: "bgm.json" | "fallback" | "none";
  tracks?: (Bgm["tracks"][number] & { out: Interval[] })[];
  file?: string;
}

/** timeline.ts の round2 は未 export のため、同義の2行関数をここに持つ
 * (規則E: 派生値の浮動小数ノイズを避ける。timeline と同精度) */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** cut 系(REASON_ID_FAMILY==="cut")の分類 id を CUT_REASON_IDS の掲載順で
 *  固定した空ヒストグラム(byId の鍵順を安定させる。未使用 id は 0) */
const CUT_FAMILY_IDS = CUT_REASON_IDS.filter((id) => REASON_ID_FAMILY[id] === "cut");

/** reasonId の語彙カバレッジを計算する純関数(§7)。分母(semanticCuts)は
 *  action:"cut" のうち reason===silenceReason(fillSilenceGaps の穴埋め)を
 *  除いたもの。silenceReason は cfg.detect?.silenceCutReason(未設定なら
 *  DEFAULT_SILENCE_CUT_REASON)。 */
function computeReasonIdCoverage(segments: PlanSegment[], silenceReason: string): ReasonIdCoverage {
  const semantic = segments.filter((s) => s.action === "cut" && s.reason !== silenceReason);
  const byId: Record<string, number> = Object.fromEntries(CUT_FAMILY_IDS.map((id) => [id, 0]));
  let labeled = 0;
  for (const s of semantic) {
    if (s.reasonId === undefined) continue;
    labeled += 1;
    byId[s.reasonId] = (byId[s.reasonId] ?? 0) + 1;
  }
  return {
    semanticCuts: semantic.length,
    labeled,
    ratio: semantic.length > 0 ? round2(labeled / semantic.length) : 0,
    byId,
  };
}

/** plan.first.json のエントリを、元秒(start/end)で最終 cutplan.json の
 *  segment と突き合わせる(候補 id は detect/candidates の再実行で番号が
 *  変わりうるため、id では join しない)。0.01秒未満の差は round2 の端数と
 *  みなして一致とする。一致する segment が無ければ(区間が分割/統合された等)
 *  数えない(過大/過小に倒さず、単純に集計対象から外れる)。 */
function findFinalSegment(entry: FirstPlanEntry, finalSegments: PlanSegment[]): PlanSegment | undefined {
  return finalSegments.find(
    (s) => Math.abs(s.start - entry.start) < 0.01 && Math.abs(s.end - entry.end) < 0.01,
  );
}

/** reasonId ごとに { first, flipped, rate } を集計し、CUT_REASON_IDS の
 *  掲載順で返す(決定論・byId と同じ並びの流儀)。 */
function groupFlips(
  entries: FirstPlanEntry[],
  finalSegments: PlanSegment[],
  isFlipped: (finalAction: string) => boolean,
): { reasonId: string; first: number; flipped: number; rate: number }[] {
  const byId = new Map<string, { first: number; flipped: number }>();
  for (const e of entries) {
    if (e.reasonId === undefined) continue;
    const g = byId.get(e.reasonId) ?? { first: 0, flipped: 0 };
    g.first += 1;
    const seg = findFinalSegment(e, finalSegments);
    if (seg && isFlipped(seg.action)) g.flipped += 1;
    byId.set(e.reasonId, g);
  }
  return CUT_REASON_IDS.filter((id) => byId.has(id)).map((id) => {
    const g = byId.get(id)!;
    return { reasonId: id, first: g.first, flipped: g.flipped, rate: g.first > 0 ? round2(g.flipped / g.first) : 0 };
  });
}

/** plan.first.json(初版)と現在の cutplan.json(最終)を比較する(§P5-5)。
 *  flippedToKeep: 初版で cut と判断された reasonId が、最終的に keep へ
 *  反転した割合。flippedToCut: 初版で「切る誘惑があったが残した」(keeps)
 *  reasonId が、最終的に cut へ反転した割合。閾値ゲートは無い(測るだけ)。 */
function computeFirstVsFinal(firstPlan: FirstPlan, finalSegments: PlanSegment[]): FirstVsFinal {
  return {
    source: firstPlan.source,
    reasonIdsEnabled: firstPlan.reasonIdsEnabled,
    flippedToKeep: groupFlips(firstPlan.cuts, finalSegments, (a) => a === "keep"),
    flippedToCut: groupFlips(firstPlan.keeps, finalSegments, (a) => a === "cut"),
  };
}

const NON_NONE_EFFECT_REASON_IDS = EFFECT_REASON_IDS.filter(
  (id) => EFFECT_REASON_ID_FAMILY[id] !== "none",
);

function effectItems(overlays: Overlays): {
  effect: Exclude<EffectDecisionType, "none">;
  start: number;
  end: number;
  reasonId?: string;
}[] {
  return [
    ...(overlays.zooms ?? []).map((item) => ({
      effect: "zoom" as const,
      start: item.start,
      end: item.end,
      ...(item.reasonId !== undefined ? { reasonId: item.reasonId } : {}),
    })),
    ...(overlays.blurs ?? []).map((item) => ({
      effect: "blur" as const,
      start: item.start,
      end: item.end,
      ...(item.reasonId !== undefined ? { reasonId: item.reasonId } : {}),
    })),
    ...(overlays.annotations ?? []).map((item) => ({
      effect: "annotation" as const,
      start: item.start,
      end: item.end,
      ...(item.reasonId !== undefined ? { reasonId: item.reasonId } : {}),
    })),
  ];
}

function computeEffectReasonIdCoverage(overlays: Overlays): EffectReasonIdCoverage {
  const effects = [overlays.zooms ?? [], overlays.blurs ?? [], overlays.annotations ?? []].flat();
  const byId: Record<string, number> = Object.fromEntries(NON_NONE_EFFECT_REASON_IDS.map((id) => [id, 0]));
  let labeled = 0;
  for (const effect of effects) {
    if (effect.reasonId === undefined) continue;
    labeled += 1;
    if (Object.hasOwn(byId, effect.reasonId)) byId[effect.reasonId] += 1;
  }
  return {
    effects: effects.length,
    labeled,
    ratio: effects.length > 0 ? round2(labeled / effects.length) : 0,
    byId,
  };
}

function isFirstEffectsPlan(value: unknown): value is FirstEffectsPlan {
  if (value === null || typeof value !== "object") return false;
  const plan = value as Partial<FirstEffectsPlan>;
  if (
    plan.schemaVersion !== 1 ||
    plan.source !== "plan-effects" ||
    typeof plan.writtenAt !== "string" ||
    typeof plan.effectReasonIdsEnabled !== "boolean" ||
    typeof plan.pattern !== "string" ||
    typeof plan.anchorCount !== "number" ||
    plan.generated === null ||
    typeof plan.generated !== "object" ||
    !Array.isArray(plan.generated.zooms) ||
    !Array.isArray(plan.generated.blurs) ||
    !Array.isArray(plan.generated.annotations) ||
    !Array.isArray(plan.none)
  ) return false;
  const isRegion = (region: unknown): boolean => {
    if (region === null || typeof region !== "object") return false;
    const r = region as Record<string, unknown>;
    return [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n));
  };
  const isTimed = (item: unknown): item is { start: number; end: number; reasonId?: string } => {
    if (item === null || typeof item !== "object") return false;
    const timed = item as Record<string, unknown>;
    return typeof timed.start === "number" && Number.isFinite(timed.start) &&
      typeof timed.end === "number" && Number.isFinite(timed.end) &&
      (timed.reasonId === undefined || typeof timed.reasonId === "string");
  };
  if (!plan.generated.zooms.every((item) => isTimed(item) && isRegion(item.rect))) return false;
  if (!plan.generated.blurs.every((item) => isTimed(item) && isRegion(item.rect))) return false;
  if (!plan.generated.annotations.every((item) =>
    isTimed(item) && item.type === "box" && isRegion(item.rect)
  )) return false;
  return plan.none.every((item) =>
    isTimed(item) &&
    typeof item.anchorId === "number" && Number.isFinite(item.anchorId) &&
    typeof item.reason === "string" &&
    (item.effectReasonId === undefined || typeof item.effectReasonId === "string") &&
    (item as unknown as Record<string, unknown>).reasonId === undefined &&
    (item.rect === undefined || isRegion(item.rect))
  );
}

function computeEffectFirstVsFinal(first: FirstEffectsPlan, finalOverlays: Overlays): EffectFirstVsFinal {
  const initial: { effect: EffectDecisionType; start: number; end: number; reasonId?: string }[] = [
    ...effectItems(first.generated),
    ...first.none.map((item) => ({
      effect: "none" as const,
      start: item.start,
      end: item.end,
      ...(item.effectReasonId !== undefined ? { reasonId: item.effectReasonId } : {}),
    })),
  ];
  const final = effectItems(finalOverlays);
  const consumed = new Set<number>();
  const counts = new Map<string, {
    effectReasonId?: string;
    from: EffectDecisionType;
    to: EffectDecisionType;
    count: number;
  }>();

  const sameTime = (a: { start: number; end: number }, b: { start: number; end: number }): boolean =>
    Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01;
  const addTransition = (
    effectReasonId: string | undefined,
    from: EffectDecisionType,
    to: EffectDecisionType,
  ): void => {
    const key = JSON.stringify([effectReasonId ?? null, from, to]);
    const current = counts.get(key);
    if (current) {
      current.count += 1;
    } else {
      counts.set(key, {
        ...(effectReasonId !== undefined ? { effectReasonId } : {}),
        from,
        to,
        count: 1,
      });
    }
  };

  for (const item of initial) {
    const candidates = final
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => !consumed.has(index) && sameTime(item, candidate));
    const match = candidates.find(({ candidate }) => candidate.effect === item.effect) ?? candidates[0];
    if (match) {
      consumed.add(match.index);
      if (match.candidate.effect !== item.effect) {
        addTransition(item.reasonId, item.effect, match.candidate.effect);
      }
    } else if (item.effect !== "none") {
      addTransition(item.reasonId, item.effect, "none");
    }
  }

  const order: EffectDecisionType[] = ["zoom", "blur", "annotation", "none"];
  const reasonOrder = new Map<string, number>(EFFECT_REASON_IDS.map((id, index) => [id, index]));
  const transitions = [...counts.values()].sort((a, b) => {
    const aReason = a.effectReasonId === undefined
      ? Number.MAX_SAFE_INTEGER
      : (reasonOrder.get(a.effectReasonId) ?? EFFECT_REASON_IDS.length);
    const bReason = b.effectReasonId === undefined
      ? Number.MAX_SAFE_INTEGER
      : (reasonOrder.get(b.effectReasonId) ?? EFFECT_REASON_IDS.length);
    if (aReason !== bReason) return aReason - bReason;
    if (a.effectReasonId !== b.effectReasonId) return (a.effectReasonId ?? "").localeCompare(b.effectReasonId ?? "");
    const fromDiff = order.indexOf(a.from) - order.indexOf(b.from);
    return fromDiff !== 0 ? fromDiff : order.indexOf(a.to) - order.indexOf(b.to);
  });
  const flipped = transitions.reduce((sum, transition) => sum + transition.count, 0);
  const added = (["zoom", "blur", "annotation"] as const).flatMap((effect) => {
    const count = final.filter((item, index) => !consumed.has(index) && item.effect === effect).length;
    return count > 0 ? [{ effect, count }] : [];
  });
  return {
    source: first.source,
    effectReasonIdsEnabled: first.effectReasonIdsEnabled,
    pattern: first.pattern,
    compared: initial.length,
    flipped,
    rate: initial.length > 0 ? round2(flipped / initial.length) : 0,
    transitions,
    added,
  };
}

/** keep 区間の配列(すでに mergeIntervals 済み)+そのタイムラインから
 * KeepEntry[] を作る。本編 keeps と縦プロファイルの mergedRanges の両方が使う */
function buildKeepEntries(keeps: Interval[], timeline: TimelineEntry[]): KeepEntry[] {
  return keeps.map((k, index) => {
    const outStart = toOutputTime(k.start, timeline) ?? 0;
    return {
      index,
      start: k.start,
      end: k.end,
      durationSec: round2(k.end - k.start),
      outStart,
      outEnd: round2(outStart + (k.end - k.start)),
    };
  });
}

function buildProjection(inp: DescribeInputs, cfg?: Config): DescribeProjection {
  const { dir, manifest, cutplan, transcript, overlays, chapters, meta, timeline, keeps } = inp;
  const outputTimesForSourceAt = (at: number): number[] =>
    timeline
      .filter((e) => at >= e.sourceStart && at <= e.sourceEnd)
      .map((e) => round2(e.outputStart + (at - e.sourceStart) / e.speed));

  const source: SourceInfo = {
    file: manifest.source,
    durationSec: manifest.durationSec,
    layout: manifestLayout(manifest),
    ...(manifest.canvas !== undefined
      ? { canvas: { name: manifest.canvas, width: outputSize(manifest).w, height: outputSize(manifest).h } }
      : {}),
    ...(manifest.baseLayout !== undefined ? { baseLayout: manifest.baseLayout } : {}),
    video: {
      width: manifest.video.width,
      height: manifest.video.height,
      fps: manifest.video.fps,
      screenRegion: manifest.video.screenRegion,
      ...(hasCamera(manifest) ? { cameraRegion: manifest.video.cameraRegion! } : {}),
    },
    audio: { micWav: manifest.audio.micWav, systemStream: manifest.audio.systemStream },
  };

  const summary: Summary = {
    approved: cutplan.approved,
    outDurationSec: round2(inp.outDur),
    keptSec: round2(inp.keptSec),
    cutSec: round2(manifest.durationSec - inp.keptSec),
    keepCount: keeps.length,
    captionCount: transcript.segments.length,
  };

  // reasonIds は sticky(規則C の明示的な例外と同型): reasonId を1つも持たない
  // cutplan かつ plan.first.json も無ければキー自体を出さない(I5。既存収録は
  // 導入前と deepEqual)。firstVsFinal は plan.first.json があるときだけ
  // (§P5-5。読むだけ・plan.first.json は一切書かない)
  const hasAnyReasonId = cutplan.segments.some((s) => s.reasonId !== undefined);
  const firstPlanPath = join(dir, "plan.first.json");
  const hasFirstPlan = existsSync(firstPlanPath);
  if (hasAnyReasonId || hasFirstPlan) {
    const silenceReason = cfg?.detect?.silenceCutReason ?? DEFAULT_SILENCE_CUT_REASON;
    summary.reasonIds = { coverage: computeReasonIdCoverage(cutplan.segments, silenceReason) };
    if (hasFirstPlan) {
      try {
        const firstPlan = JSON.parse(readFileSync(firstPlanPath, "utf8")) as FirstPlan;
        summary.reasonIds.firstVsFinal = computeFirstVsFinal(firstPlan, cutplan.segments);
      } catch {
        // 壊れた plan.first.json は firstVsFinal を省略するだけ(coverage は出す。
        // plan.first.json は測定専用の副産物で、壊れていても describe を止めない)
      }
    }
  }


  const effects = [overlays.zooms ?? [], overlays.blurs ?? [], overlays.annotations ?? []].flat();
  const hasAnyEffectReasonId = effects.some((effect) => effect.reasonId !== undefined);
  const firstEffectsPath = join(dir, "plan-effects.first.json");
  const hasFirstEffectsPlan = existsSync(firstEffectsPath);
  if (hasAnyEffectReasonId || hasFirstEffectsPlan) {
    summary.effectReasonIds = { coverage: computeEffectReasonIdCoverage(overlays) };
    if (hasFirstEffectsPlan) {
      try {
        const parsed = JSON.parse(readFileSync(firstEffectsPath, "utf8")) as unknown;
        if (isFirstEffectsPlan(parsed)) {
          summary.effectReasonIds.firstVsFinal = computeEffectFirstVsFinal(parsed, overlays);
        }
      } catch {
        // 壊れた初版はfirstVsFinalだけ省略し、現在のcoverageは返す。
      }
    }
  }

  const keepEntries = buildKeepEntries(keeps, timeline);

  // keep 内の間(describe.pauses が真のときだけ本編 keeps に付ける。cfg 省略・
  // 無効なら pauses キーを一切足さない=既存 --json とバイト等価。縦プロファイルの
  // mergedRanges には付けない=buildKeepEntries を共有しつつ本編だけに後付け)
  const pausesCfg = cfg ? resolveDescribePausesCfg(cfg) : { enabled: false, max: 3, minSec: 0.6 };
  if (pausesCfg.enabled) {
    const autoPath = join(dir, "cuts.auto.json");
    const silences = existsSync(autoPath)
      ? (JSON.parse(readFileSync(autoPath, "utf8")) as AutoCuts).silences
      : [];
    const byKeep = new Map<number, KeepPause[]>();
    for (const p of pausesWithinKeeps(keeps, silences, pausesCfg.minSec)) {
      const arr = byKeep.get(p.keepIndex) ?? [];
      if (arr.length < pausesCfg.max) arr.push(p);
      byKeep.set(p.keepIndex, arr);
    }
    for (const ke of keepEntries) {
      const ps = byKeep.get(ke.index);
      if (ps && ps.length > 0) ke.pauses = ps;
    }
  }

  /* ---- cuts(gap を keep と同じ手順で走査。消える発言は全文) ---- */
  const cuts: CutEntry[] = [];
  for (let i = 0; i <= keeps.length; i++) {
    const gapStart = i === 0 ? 0 : keeps[i - 1].end;
    const gapEnd = i < keeps.length ? keeps[i].start : manifest.durationSec;
    if (gapEnd - gapStart <= 0.05) continue;
    const reasons = inp.cutRecords
      .filter((r) => overlaps(r, gapStart, gapEnd))
      .map((r) => r.reason);
    const lostCaptions: LostCaption[] = [];
    for (const s of transcript.segments) {
      if (overlaps(s, gapStart, gapEnd) && keepIndexOf(s, keeps, timeline) === null) {
        lostCaptions.push({ start: s.start, end: s.end, text: s.text, track: captionTrack(s) });
      }
    }
    cuts.push({
      start: gapStart,
      end: gapEnd,
      durationSec: round2(gapEnd - gapStart),
      reasons,
      lostCaptions,
    });
  }

  /* ---- captions(全文・全件。pos/style/words はセグメント個別指定のみ) ---- */
  const captions: CaptionEntry[] = transcript.segments.map((s, index): CaptionEntry => {
    const out = remapInterval(s.start, s.end, timeline);
    return {
      index,
      ...(s.id !== undefined ? { id: s.id } : {}),
      start: s.start,
      end: s.end,
      text: s.text,
      track: captionTrack(s),
      ...(s.pos !== undefined ? { pos: s.pos } : {}),
      ...(s.style !== undefined ? { style: s.style } : {}),
      ...(s.words !== undefined ? { words: s.words } : {}),
      out,
      keepIndex: keepIndexOf(s, keeps, timeline),
      visible: out.length > 0,
    };
  });

  /* ---- overlays(演出の全フィールド) ---- */
  const projectKeyframes = (
    keyframes: { at: number; easing?: string; values: Record<string, number> }[] | undefined,
  ): { keyframeCount?: number; keyframes?: KeyframeEntry[] } =>
    keyframes && keyframes.length > 0
      ? {
          keyframeCount: keyframes.length,
          keyframes: keyframes.map((k) => ({
            sourceAt: k.at,
            outputTimes: outputTimesForSourceAt(k.at),
            ...(k.easing !== undefined ? { easing: k.easing } : {}),
            values: k.values,
          })),
        }
      : {};
  const materials: MaterialEntry[] = (overlays.overlays ?? []).map((o): MaterialEntry => ({
    ...(o.id !== undefined ? { id: o.id } : {}),
    start: o.start,
    end: o.end,
    file: o.file,
    track: overlayTrack(o),
    ...(o.fit !== undefined ? { fit: o.fit } : {}),
    ...(o.startFrom !== undefined ? { startFrom: o.startFrom } : {}),
    ...(o.volume !== undefined ? { volume: o.volume } : {}),
    ...(o.opacity !== undefined ? { opacity: o.opacity } : {}),
    ...(o.fadeInSec !== undefined ? { fadeInSec: o.fadeInSec } : {}),
    ...(o.fadeOutSec !== undefined ? { fadeOutSec: o.fadeOutSec } : {}),
    ...(o.rect !== undefined ? { rect: o.rect } : {}),
    ...projectKeyframes(o.keyframes as { at: number; easing?: string; values: Record<string, number> }[] | undefined),
    exists: existsSync(join(dir, o.file)),
    out: remapInterval(o.start, o.end, timeline),
  }));

  // inserts は全件(存在しないファイルの insert も編集状態としては存在する)。
  // timeline に入るのは存在するものだけなので、position を filtered 配列
  // (=loadDescribeInputs が existsSync で絞った inp.inserts)内の参照一致で探す
  const allInserts = overlays.inserts ?? [];
  const filteredInserts = inp.inserts;
  const spans = insertSpans(keeps, filteredInserts);
  const inserts: InsertEntry[] = allInserts.map((ins): InsertEntry => {
    const exists = existsSync(join(dir, ins.file));
    let out: Interval | null = null;
    if (exists) {
      const filteredIndex = filteredInserts.indexOf(ins);
      const sp = spans.find((s) => s.index === filteredIndex);
      if (sp) out = { start: sp.start, end: sp.end };
    }
    return {
      ...(ins.id !== undefined ? { id: ins.id } : {}),
      at: ins.at,
      file: ins.file,
      durationSec: ins.durationSec,
      kind: isImageFile(ins.file) ? "image" : "video",
      ...(ins.startFrom !== undefined ? { startFrom: ins.startFrom } : {}),
      ...(ins.fit !== undefined ? { fit: ins.fit } : {}),
      ...(ins.volume !== undefined ? { volume: ins.volume } : {}),
      ...(ins.fadeInSec !== undefined ? { fadeInSec: ins.fadeInSec } : {}),
      ...(ins.fadeOutSec !== undefined ? { fadeOutSec: ins.fadeOutSec } : {}),
      exists,
      out,
    };
  });

  const wipeFull: MappedInterval[] = (overlays.wipeFull ?? []).map((w) => ({
    ...(w.id !== undefined ? { id: w.id } : {}),
    start: w.start,
    end: w.end,
    out: remapInterval(w.start, w.end, timeline),
  }));

  const zooms: ZoomEntry[] = (overlays.zooms ?? []).map((z): ZoomEntry => ({
    ...(z.id !== undefined ? { id: z.id } : {}),
    start: z.start,
    end: z.end,
    out: remapInterval(z.start, z.end, timeline),
    rect: z.rect,
    ...(z.reasonId !== undefined ? { reasonId: z.reasonId } : {}),
    ...(z.easeSec !== undefined ? { easeSec: z.easeSec } : {}),
  }));

  const blurs: BlurEntry[] = (overlays.blurs ?? []).map((b): BlurEntry => ({
    ...(b.id !== undefined ? { id: b.id } : {}),
    start: b.start,
    end: b.end,
    out: remapInterval(b.start, b.end, timeline),
    rect: b.rect,
    ...(b.reasonId !== undefined ? { reasonId: b.reasonId } : {}),
    ...(b.strength !== undefined ? { strength: b.strength } : {}),
    ...projectKeyframes(b.keyframes as { at: number; easing?: string; values: Record<string, number> }[] | undefined),
  }));

  const annotations: AnnotationEntry[] = (overlays.annotations ?? []).map((a): AnnotationEntry => {
    const base = {
      ...(a.id !== undefined ? { id: a.id } : {}),
      start: a.start,
      end: a.end,
      out: remapInterval(a.start, a.end, timeline),
      ...(a.reasonId !== undefined ? { reasonId: a.reasonId } : {}),
      ...projectKeyframes(a.keyframes as { at: number; easing?: string; values: Record<string, number> }[] | undefined),
    };
    switch (a.type) {
      case "arrow":
        return {
          ...base,
          type: "arrow",
          from: a.from,
          to: a.to,
          ...(a.color !== undefined ? { color: a.color } : {}),
          ...(a.widthPx !== undefined ? { widthPx: a.widthPx } : {}),
          ...(a.headPx !== undefined ? { headPx: a.headPx } : {}),
        };
      case "box":
        return {
          ...base,
          type: "box",
          rect: a.rect,
          ...(a.color !== undefined ? { color: a.color } : {}),
          ...(a.widthPx !== undefined ? { widthPx: a.widthPx } : {}),
          ...(a.radiusPx !== undefined ? { radiusPx: a.radiusPx } : {}),
          ...(a.fill !== undefined ? { fill: a.fill } : {}),
        };
      case "spotlight":
        return {
          ...base,
          type: "spotlight",
          rect: a.rect,
          ...(a.shape !== undefined ? { shape: a.shape } : {}),
          ...(a.dim !== undefined ? { dim: a.dim } : {}),
          ...(a.featherPx !== undefined ? { featherPx: a.featherPx } : {}),
          ...(a.radiusPx !== undefined ? { radiusPx: a.radiusPx } : {}),
        };
    }
  });

  const texts: TextEntry[] = (overlays.texts ?? []).map((t): TextEntry => ({
    ...(t.id !== undefined ? { id: t.id } : {}),
    start: t.start,
    end: t.end,
    out: remapInterval(t.start, t.end, timeline),
    ...(t.reasonId !== undefined ? { reasonId: t.reasonId } : {}),
    text: t.text,
    ...(textTrack(t) > 1 ? { track: textTrack(t) } : {}),
    pos: t.pos,
    ...(t.anchor !== undefined ? { anchor: t.anchor } : {}),
    ...(t.style !== undefined ? { style: t.style } : {}),
  }));

  const hideCaption: MappedInterval[] = (overlays.hideCaption ?? []).map((h) => ({
    ...(h.id !== undefined ? { id: h.id } : {}),
    start: h.start,
    end: h.end,
    out: remapInterval(h.start, h.end, timeline),
  }));

  const overlaysProjection: OverlaysProjection = {
    materials,
    inserts,
    wipeFull,
    zooms,
    blurs,
    annotations,
    texts,
    hideCaption,
    colorFilter: overlays.colorFilter ?? null,
    layerOrder: overlays.layerOrder ?? null,
    captionTracks: overlays.captionTracks ?? [],
  };

  /* ---- chapters(元秒 + snapToOutput・全文タイトル) ---- */
  const chaptersProj: ChapterEntry[] = chapters.chapters.map((c) => ({
    ...(c.id !== undefined ? { id: c.id } : {}),
    start: c.start,
    out: snapToOutput(c.start, timeline),
    title: c.title,
  }));

  /* ---- bgm ---- */
  let bgm: BgmProjection;
  if (inp.bgm && inp.bgm.tracks?.length) {
    bgm = {
      source: "bgm.json",
      tracks: inp.bgm.tracks.map((t) => ({
        ...t,
        out: t.timebase === "output"
          ? [{ start: Math.max(0, t.start), end: Math.min(inp.outDur, t.end) }].filter((iv) => iv.end > iv.start)
          : remapInterval(t.start, t.end, timeline),
      })),
    };
  } else {
    const fallbackFile = ["bgm.mp3", "bgm.m4a", "bgm.wav"].find((f) =>
      existsSync(join(dir, f)),
    );
    bgm = fallbackFile !== undefined ? { source: "fallback", file: fallbackFile } : { source: "none" };
  }

  // 画面区間(screen.probe/index.json)。ファイルが在るときだけ screen キーが
  // 出る(不在なら省略=既存 --json とバイト等価)。index.json の segments を
  // そのまま載せ、outSec の再計算はしない(video-perception-P1 §2.7)
  const screenIdx = readScreenIndex(dir);
  const screen: ScreenProjection | null = screenIdx
    ? {
        schemaVersion: screenIdx.schemaVersion,
        capturedAt: screenIdx.capturedAt,
        range: screenIdx.range,
        ocrAvailable: screenIdx.ocrAvailable,
        params: screenIdx.params,
        segments: screenIdx.segments,
      }
    : null;
  // システム音声(transcript.system.json)。ファイルが在るときだけ systemAudio
  // キーを足す(不在時は省略=既存 --json とバイト等価。規則C の明示的例外)
  const systemAudio: SystemAudioProjection | undefined = inp.systemTranscript
    ? {
        speaker: "system",
        segments: inp.systemTranscript.segments.map((s) => ({
          start: s.start,
          end: s.end,
          text: s.text,
          out: remapInterval(s.start, s.end, timeline),
        })),
      }
    : undefined;

  return {
    schemaVersion: 1,
    source,
    summary,
    keeps: keepEntries,
    cuts,
    captions,
    overlays: overlaysProjection,
    chapters: chaptersProj,
    meta: { titles: meta.titles, description: meta.description },
    bgm,
    ...(systemAudio !== undefined ? { systemAudio } : {}),
    ...(screen !== null ? { screen } : {}),
  };
}

/** 編集状態の機械可読な完全射影(`describe --json`)。発話・タイトルは
 * 一切切り捨てない(規則A)。CLI 配線はタスク4(このタスクではまだ未参照) */
export function describeJson(dir: string, cfg?: Config): DescribeProjection {
  return buildProjection(loadDescribeInputs(dir), cfg);
}
