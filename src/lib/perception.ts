// lib/perception.ts — plan(カット判断 LLM)へ発話テキスト以外の知覚を添える
// (opt-in・既定オフ)。§docs/plans/2026-07-07-plan-eyes-ears-design.md
//
// 音特徴(§4): detect が既に持つ cuts.auto.json の情報(silences[] +
// numberSegments の出力する NumberedSegment[])だけから計算する純関数。
// 新規の音量計測はしない(LLM に「間」の手掛かりを与えるだけ)。
//
// 画面 OCR(§5): plan 時点では frames 未実行(frames は cutplan を要求し、
// cutplan は plan の出力=鶏卵)なので、区間代表フレーム(source 秒の中点)を
// 既存プリミティブ(buildScreenStill + runOcr)で自前 OCR する。非対応環境
// (macOS 以外・swift 系なし・Vision 失敗)は runOcr が null を返すだけで、
// 例外を投げず優雅に劣化する(§9 不変条件3)。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOcr } from "./ocr.ts";
import { buildScreenStill } from "./screenStill.ts";
import { detectDwellCandidates, distance } from "./cursorAnchors.ts";
import type { DwellDetectionCfg } from "./cursorAnchors.ts";
import type { Interval, Manifest, SystemTranscript } from "../types.ts";
import type { NumberedSegment } from "../stages/plan.ts";
import type { CursorSample } from "../stages/record.ts";

/** 区間ごとの音の特徴(秒。丸め済み)。LLM に算術をさせないため、
 * こちらで計算し記述文として渡す(§4 D2) */
export interface SegmentAudioFeature {
  id: number;
  /** 区間の尺(end - start) */
  len: number;
  /** 直前の keep との間に落ちた素材秒(先頭区間は0) */
  gapBefore: number;
  /** 区間内に残った無音の合計秒(silences との overlap 積算) */
  silenceWithin: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 2つの区間の重なり秒(重ならなければ0) */
function overlapSec(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * numbered(残す候補区間に番号を振ったもの)+ silences(cuts.auto.json の
 * 無音区間)だけから区間ごとの音特徴を計算する純関数(detect への新規計測は
 * 要しない。§4)。
 */
export function computeAudioFeatures(
  numbered: NumberedSegment[],
  silences: Interval[],
): SegmentAudioFeature[] {
  return numbered.map((seg, i) => {
    const prev = numbered[i - 1];
    const gapBefore = i === 0 ? 0 : seg.start - prev.end;
    const silenceWithin = silences.reduce((sum, s) => sum + overlapSec(s, seg), 0);
    return {
      id: seg.id,
      len: round1(seg.end - seg.start),
      gapBefore: round1(gapBefore),
      silenceWithin: round1(silenceWithin),
    };
  });
}

/** keep 内に残った無音(間)1件(§audio-perception-design D5/§6.2)。
 * 既存 silenceWithin(区間内無音の合計スカラ)と違い「どこに・何秒」を持つ。
 * cuts.auto.json の silences ∩ keep から算出=新規計測ゼロ */
export interface KeepPause {
  /** この間が属する keep のインデックス(0始まり) */
  keepIndex: number;
  /** 元収録秒の区間(silence ∩ keep をクリップしたもの) */
  start: number;
  end: number;
  /** 長さ(秒・丸め済み) */
  len: number;
  /** keep 先頭からのオフセット(秒・丸め済み) */
  offset: number;
}

/** 各 keep に残った無音(間)を、minSec 以上・keepIndex/start 昇順で返す純関数。
 * cuts.auto.json の silences だけから引ける(detect への新規計測なし)。keeps は
 * 呼び出し側が mergeIntervals 済みの前提(describe が渡す keeps はそうなっている) */
export function pausesWithinKeeps(
  keeps: Interval[],
  silences: Interval[],
  minSec: number,
): KeepPause[] {
  const out: KeepPause[] = [];
  keeps.forEach((k, keepIndex) => {
    for (const s of silences) {
      const start = Math.max(k.start, s.start);
      const end = Math.min(k.end, s.end);
      const len = end - start;
      if (len >= minSec) {
        out.push({ keepIndex, start, end, len: round1(len), offset: round1(start - k.start) });
      }
    }
  });
  return out;
}

/** 音特徴をプロンプト用の記述文に整形する(純関数)。番号の連続性のため
 * 全区間を含める(§4 の「省略しない」側の選択。バイト等価の不変条件には
 * 無関係=このブロック自体が opt-in なので影響しない) */
export function formatAudio(features: SegmentAudioFeature[]): string {
  const lines = features.map(
    (f) =>
      `#${f.id} 尺${f.len.toFixed(1)} / 直前カット${f.gapBefore.toFixed(1)} / 内無音${f.silenceWithin.toFixed(1)}`,
  );
  return ["## 各区間の音の特徴(秒)", ...lines].join("\n");
}

/** 区間ごとの画面 OCR テキスト(§5)。lines は先頭 ocrMaxLines 件に切り詰め済み。
 * text は lines.join(" / ") の便宜フィールド(空判定・renderPerceptionBlock の
 * ゲートに使う) */
export interface SegmentOcr {
  id: number;
  lines: string[];
  text: string;
}

/** 区間の代表 source 秒(元収録秒。中点)。純関数(§5.2 手順1) */
export function representativeSourceTime(seg: Interval): number {
  return (seg.start + seg.end) / 2;
}

/**
 * OCR をかける区間を選ぶ(コスト制御。§5.2)。区間数が maxSegments 以下なら
 * 全件そのまま。超過時は尺(len)の長い順に maxSegments 件を選び、
 * 返り値は id 昇順に戻す(プロンプト上での並びを崩さないため)。
 */
export function selectOcrTargets(
  numbered: NumberedSegment[],
  maxSegments: number,
): NumberedSegment[] {
  if (numbered.length <= maxSegments) return numbered;
  return [...numbered]
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, maxSegments)
    .sort((a, b) => a.id - b.id);
}

/** computeSegmentOcr が使うコスト制御・言語設定(resolvePerceptionCfg の
 * ocrMaxSegments/ocrMaxLines + config.yaml の ocr.languages) */
export interface PerceptionOcrOptions {
  ocrMaxSegments: number;
  ocrMaxLines: number;
  /** Vision 認識言語の優先順(省略時 runOcr の既定 = DEFAULT_OCR_LANGUAGES) */
  languages?: string[];
}

/**
 * 区間ごとの代表フレーム(source 秒の中点)を screenRegion フル解像度で
 * クロップし(buildScreenStill)、Vision OCR(runOcr)にかける。tmp PNG は
 * 使用後に必ず削除する(frames.ts の ocrFrame と同じ tmp+finally パターン)。
 * runOcr が null(非対応環境・失敗)を返した区間は例外を投げず飛ばす
 * (§9 不変条件3)。OCR テキストが空だった区間は結果に含めない
 * (=全区間で空なら戻り値は空配列 → renderPerceptionBlock が OCR ブロックを
 * 出さない)。
 */
export async function computeSegmentOcr(
  dir: string,
  manifest: Manifest,
  numbered: NumberedSegment[],
  opts: PerceptionOcrOptions,
  warn: (msg: string) => void,
): Promise<SegmentOcr[]> {
  const targets = selectOcrTargets(numbered, opts.ocrMaxSegments);
  const results: SegmentOcr[] = [];
  for (const seg of targets) {
    const sourceSec = representativeSourceTime(seg);
    const cropPath = join(tmpdir(), `framewright-plan-ocr-${process.pid}-${seg.id}.png`);
    try {
      await buildScreenStill(dir, manifest, sourceSec, cropPath);
      const result = await runOcr(cropPath, manifest.video.screenRegion, {
        languages: opts.languages,
        warn,
      });
      if (result === null) continue; // 非対応環境等(warn 済み)。優雅な劣化
      const lines = result.lines
        .slice(0, opts.ocrMaxLines)
        .map((l) => l.text)
        .filter((t) => t.trim().length > 0);
      if (lines.length > 0) results.push({ id: seg.id, lines, text: lines.join(" / ") });
    } finally {
      if (existsSync(cropPath)) rmSync(cropPath);
    }
  }
  return results;
}

/** 画面 OCR をプロンプト用の記述文に整形する(純関数)。テキストが空の区間は
 * 出さない(§5.2「全区間で OCR が空 → OCR ブロックは出さない」はこの結果と
 * renderPerceptionBlock のゲートで担保される) */
export function formatOcr(ocr: SegmentOcr[]): string {
  const rows = ocr
    .filter((o) => o.lines.length > 0)
    .map((o) => `#${o.id} 画面: ${o.lines.map((l) => `"${l}"`).join(" / ")}`);
  return [
    "## 各区間の画面テキスト(OCR。開発系は画面が主役)",
    ...rows,
    "(記載のない区間は画面テキストなし)",
  ].join("\n");
}

/* ==================================================================== */
/* システム音声(アプリ・デモ・TTS)の発話を各区間へ帰属する(§audio-perception
 * -design D7)。transcript.system.json(知覚専用・描画しない)を読み、区間に
 * overlap する発話を集める。computeSegmentOcr の overlap 帰属を踏襲。 ======= */

/** 区間ごとのシステム音声発話(§D7)。lines は overlap した system 発話の
 * text 列、text は lines.join(" / ") の便宜フィールド(空判定・
 * renderPerceptionBlock のゲートに使う) */
export interface SegmentSystemSpeech {
  id: number;
  lines: string[];
  text: string;
}

/** transcript.system.json を読む(無ければ null=優雅な劣化)。純関数ではない
 * (fs 読み込み)が、存在チェックのみで例外は投げない */
export function loadSystemTranscript(dir: string): SystemTranscript | null {
  const p = join(dir, "transcript.system.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SystemTranscript;
}

/** 各区間に overlap するシステム発話を集める純関数(computeSegmentOcr と同型の
 * overlap 帰属)。発話が無い区間は結果に含めない(=全区間で空なら空配列 →
 * renderPerceptionBlock が systemSpeech ブロックを出さない) */
export function computeSystemSpeech(
  numbered: NumberedSegment[],
  systemSegments: SystemTranscript["segments"],
): SegmentSystemSpeech[] {
  const results: SegmentSystemSpeech[] = [];
  for (const seg of numbered) {
    const lines = systemSegments
      .filter((s) => overlapSec(s, seg) > 0)
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0);
    if (lines.length > 0) results.push({ id: seg.id, lines, text: lines.join(" / ") });
  }
  return results;
}

/** システム音声をプロンプト用の記述文に整形する(純関数)。text が空の区間は
 * 出さない(computeSystemSpeech の時点で除外済みだが二重に守る) */
export function formatSystemSpeech(system: SegmentSystemSpeech[]): string {
  const rows = system
    .filter((s) => s.lines.length > 0)
    .map((s) => `#${s.id} 音声: ${s.lines.map((l) => `"${l}"`).join(" / ")}`);
  return [
    "## 各区間のシステム音声(アプリ/デモ/TTS。マイク発話ではない)",
    ...rows,
    "(記載のない区間はシステム音声なし)",
  ].join("\n");
}

/* ==================================================================== */
/* カーソル知覚(video-perception-P3)。record --watch が書く
 * `<recording base>.cursor.json` サイドカー(CursorSample[])だけから
 * 区間ごとの操作特徴を計算する純関数。新規計測はしない(既存
 * detectDwellCandidates を再利用する)。
 * §docs/plans/2026-08-10-video-perception-p3-cursor-perception-design.md ==== */

/** computeCursorFeatures が読む、config.yaml の plan.perception.cursorDwell /
 *  cursorWaitTypes を既定値で解決した後の値(§2.4)。`plan.cursor`(演出用の
 *  ズーム閾値)とは別軸(目標が逆=演出は間引く、知覚は間引かない)なので
 *  混同しないこと */
export interface PerceptionCursorOptions {
  minDwellMs: number;
  moveThreshold: number;
  waitTypes: string[];
}

/** 区間ごとのカーソル操作特徴(§2.2.1)。丸めは computeCursorFeatures 内部で
 *  適用済み(dwellMaxSec は小数第1位、idleRatio/waitRatio は小数第2位) */
export interface SegmentCursorFeature {
  id: number;
  clicks: number;
  dwellCount: number;
  dwellMaxSec: number;
  idleRatio: number;
  waitRatio: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * numbered(残す候補区間)+ samples(cursor サイドカーの生テレメトリ)だけから
 * 区間ごとのカーソル操作特徴を計算する純関数(§2.2)。`recTimeMs / 1000` は
 * 元収録秒と同じ軸なので写像を通さない(§2.2.2)。`inBounds:false` のサンプルは
 * 全指標から除外し、属するサンプルが0件の区間は結果に含めない。
 */
export function computeCursorFeatures(
  numbered: NumberedSegment[],
  samples: readonly CursorSample[],
  cfg: PerceptionCursorOptions,
): SegmentCursorFeature[] {
  // detectDwellCandidates は演出用に「間引き」を内蔵している
  // (spacingMs の近接除去・windowMs の重なり除去)。知覚では全 dwell が
  // 欲しいので、以下の固定値で間引きを無効化する(§2.2.4。設定に出さない
  // — これは「間引きを無効化する」という不変条件の表現であって
  // チューニング対象ではない):
  //   maxDwellMs: Number.MAX_SAFE_INTEGER … 上限による除外をしない
  //     (知覚では長い停留こそ情報)
  //   spacingMs: 0 … Math.abs(Δcenter) < 0 は常に偽 → 近接除去が無効化される
  //   windowMs: 0 … startMs===endMs===centerMs になり重なり判定
  //     (c.start < a.end && a.start < c.end)が常に偽 → 重なり除去が無効化される
  //   clickBoost: 1 … strength === durationMs にする
  //     (dwellMaxSec = max(strength)/1000 の前提)
  const dwellCfg: DwellDetectionCfg = {
    minDwellMs: cfg.minDwellMs,
    maxDwellMs: Number.MAX_SAFE_INTEGER,
    moveThreshold: cfg.moveThreshold,
    spacingMs: 0,
    clickBoost: 1,
    windowMs: 0,
  };
  const dwellCandidates = detectDwellCandidates(samples, dwellCfg);

  const results: SegmentCursorFeature[] = [];
  for (const seg of numbered) {
    // 左閉右開の帰属(§2.2.2)。inBounds:false は撮影ディスプレイ外=観測対象外
    const inSeg = samples.filter(
      (s) => s.inBounds && seg.start <= s.recTimeMs / 1000 && s.recTimeMs / 1000 < seg.end,
    );
    if (inSeg.length === 0) continue;

    // clicks: leftButtonPressed(押下の立ち上がり)を数える。leftButtonDown
    // (押されている最中は毎サンプル true)を数えると30Hzぶん過剰計上になる(§2.2.3)
    const clicks = inSeg.filter((s) => s.leftButtonPressed).length;

    // dwellCount/dwellMaxSec: centerMs/1000 の帰属は §2.2.2 と同じ左閉右開(§2.2.4)
    const segDwells = dwellCandidates.filter(
      (c) => seg.start <= c.centerMs / 1000 && c.centerMs / 1000 < seg.end,
    );
    const dwellCount = segDwells.length;
    // windowMs:0 のため endMs-startMs は常に0。strength が durationMs
    // (clickBoost:1 の前提)なのでこちらを使う(§2.2.4)
    const dwellMaxSec = segDwells.length
      ? round1(Math.max(...segDwells.map((c) => c.strength)) / 1000)
      : 0;

    // idleRatio: 隣接サンプル間の距離が moveThreshold 以下だった隣接ペアの
    // 比率(区間内のみ)。サンプル1件(隣接ペア0件)なら1とする(0除算回避。§2.2.5)
    let idleRatio: number;
    if (inSeg.length <= 1) {
      idleRatio = 1;
    } else {
      let idlePairs = 0;
      for (let i = 1; i < inSeg.length; i++) {
        if (distance(inSeg[i], inSeg[i - 1]) <= cfg.moveThreshold) idlePairs++;
      }
      idleRatio = idlePairs / (inSeg.length - 1);
    }

    // waitRatio: cursorType の完全一致(null は待機系ではない。§2.2.6)
    const waitCount = inSeg.filter(
      (s) => s.cursorType !== null && cfg.waitTypes.includes(s.cursorType),
    ).length;
    const waitRatio = waitCount / inSeg.length;

    results.push({
      id: seg.id,
      clicks,
      dwellCount,
      dwellMaxSec,
      idleRatio: round2(idleRatio),
      waitRatio: round2(waitRatio),
    });
  }
  return results;
}

/** カーソル操作特徴をプロンプト用の記述文に整形する(純関数)。数値は
 *  computeCursorFeatures で丸め済みのものを整形するだけで算術はしない
 *  (`* 100` の百分率化だけは表示のためここで行う。§2.3)。解釈は書かない
 *  (観測だけを渡し、判断は LLM に委ねる) */
export function formatCursor(cursor: SegmentCursorFeature[]): string {
  const lines = cursor.map(
    (f) =>
      `#${f.id} クリック${f.clicks} / 停留${f.dwellCount}(最長${f.dwellMaxSec.toFixed(1)}秒)` +
      ` / 静止${Math.round(f.idleRatio * 100)}% / 待機カーソル${Math.round(f.waitRatio * 100)}%`,
  );
  return [
    "## 各区間のカーソル操作(画面上で何をしていたか)",
    ...lines,
    "(記載のない区間はカーソル情報なし)",
  ].join("\n");
}

/**
 * 知覚ブロック({{perception}} に入る全文)を組み立てる純関数。
 * `renderRulesBlock`(stages/plan.ts)と完全に同じ契約: 全て null/空 →
 * `""`、存在時のみ前後 `\n` を伴う1ブロック。呼び出し側はこの値をそのまま
 * `{{perception}}` に replaceAll するだけでよい(§6.1)。ブロック順は
 * audio → systemSpeech → ocr → cursor(§D7・video-perception-P3 §2.1)。
 * system=null(既定オフ or ファイル不在)のときは audio/ocr だけの従来出力と
 * 完全に一致する(バイト等価)。cursor も同様に省略可(既定 undefined/null)で、
 * 省略時は cursor 導入前の3引数呼び出しと完全に一致する(バイト等価)。
 */
export function renderPerceptionBlock(
  audio: SegmentAudioFeature[] | null,
  system: SegmentSystemSpeech[] | null,
  ocr: SegmentOcr[] | null,
  cursor?: SegmentCursorFeature[] | null,
): string {
  const aLines = audio && audio.length ? formatAudio(audio) : null;
  const sLines = system && system.some((s) => s.text) ? formatSystemSpeech(system) : null;
  const oLines = ocr && ocr.some((o) => o.text) ? formatOcr(ocr) : null;
  const cLines = cursor && cursor.length ? formatCursor(cursor) : null;
  if (!aLines && !sLines && !oLines && !cLines) return "";
  const parts = ["## AI 向け知覚情報(発話以外の手掛かり)"];
  if (aLines) parts.push(aLines);
  if (sLines) parts.push(sLines);
  if (oLines) parts.push(oLines);
  if (cLines) parts.push(cLines);
  return `\n${parts.join("\n\n")}\n`;
}
