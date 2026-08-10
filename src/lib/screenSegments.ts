// video-perception-P1: screen.probe/ 画面状態の区間トラック(本丸)。
// §docs/plans/2026-08-10-video-perception-p1-screen-probe-design.md §2.3
//
// OCR行の正規化・Jaccard類似度による境界判定・区間畳み込み(最小区間長の
// 吸収→代表選定→時刻の埋め込み)を行う純関数。I/O(fs / ffmpeg / OCR実行)は
// 一切しない(索引 §2.9)。呼び出し側(I/O層)が `av.probe/motion.json` 由来の
// サンプル時刻へ OCR をかけて `ScreenSample[]` を組み立て、本関数へ渡す。
//
// 前提(§2.3.0。P0 の selectSceneTimes が返す時刻の性質を引き継ぐ):
//   - サンプルは av.everySec グリッドの上にあり、必ず keep の内側にある。
//   - サンプルは sourceSec 昇順(= outSec 昇順)で渡される前提。
//
// 純関数の制約により、outSec/endOutSec は toOutputTime を呼ばず、常に
// サンプル自身が既に持つ outSec から引く(呼び出し側の指示による固定規則。
// 設計書 §2.3.5 の toOutputTime 経路は I/O 層の責務であり、本関数では使わない)。

import type { OcrResult } from "./ocr.ts";

/** 1サンプル = 1時刻の観測。OCR 済み(または OCR 不可) */
export interface ScreenSample {
  outSec: number;
  sourceSec: number;
  sceneScore: number;
  /** 正規化済みの OCR 行集合(§2.3.3)。OCR 不可なら null */
  lines: string[] | null;
  /** OCR 全行(サイドカーへ書く用)。OCR 不可なら null */
  raw: OcrResult | null;
}

export interface ScreenSegmentCfg {
  /** Jaccard 係数がこれ以上なら同一画面 */
  mergeThreshold: number;
  /** 境界の追認に使う sceneScore */
  sceneThreshold: number;
  /** これ未満の区間は前へ吸収 */
  minSegmentSec: number;
  /** index.json に載せる OCR 行数(本関数は未使用。I/O 層が使う) */
  indexLines: number;
}

export interface ScreenSegment {
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
  /** samples 配列内の添字(呼び出し側が still/ocr を書く) */
  representativeIndex: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * OCR行の正規化(§2.3.3)。この順で適用する:
 * NFKC → trim → toLowerCase → 連続空白を半角スペース1個へ畳む → 空文字は捨てる。
 * `confidence` による足切りはしない。
 */
export function normalizeOcrLines(raw: OcrResult): string[] {
  const out: string[] = [];
  for (const line of raw.lines) {
    const normalized = line.text
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/\s+/gu, " ");
    if (normalized.length === 0) continue;
    out.push(normalized);
  }
  return out;
}

/**
 * Jaccard 係数 |A∩B| / |A∪B|(§2.3.3)。
 * 両方空集合なら 1(同一扱い・0除算しない)。片方だけ空集合なら 0。
 */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * 隣接サンプル間の境界判定(§2.3.4)。2条件 AND:
 *   jaccard(prev.lines, cur.lines) < mergeThreshold && cur.sceneScore >= sceneThreshold
 * どちらか一方の lines が null なら第1条件を真とみなす(式は sceneScore だけに退化)。
 */
function isBoundary(prev: ScreenSample, cur: ScreenSample, cfg: ScreenSegmentCfg): boolean {
  const contentChanged =
    prev.lines === null || cur.lines === null
      ? true
      : jaccard(prev.lines, cur.lines) < cfg.mergeThreshold;
  return contentChanged && cur.sceneScore >= cfg.sceneThreshold;
}

/** 境界判定(手順4)だけを終えた、まだ吸収前の生区間。samples[] への添字範囲(両端含む) */
interface RawGroup {
  start: number;
  end: number;
}

function buildRawGroups(samples: ScreenSample[], cfg: ScreenSegmentCfg): RawGroup[] {
  const groups: RawGroup[] = [];
  let groupStart = 0;
  for (let i = 1; i < samples.length; i++) {
    if (isBoundary(samples[i - 1], samples[i], cfg)) {
      groups.push({ start: groupStart, end: i - 1 });
      groupStart = i;
    }
  }
  groups.push({ start: groupStart, end: samples.length - 1 });
  return groups;
}

/**
 * 生区間 i が「自分だけの区間」だったと仮定したときの長さ(§2.3.5 の定義を
 * 生区間単位に適用したもの)。endSourceSec は次の生区間の開始、無ければ
 * 最後のサンプルの sourceSec。吸収の判定はこの長さを使う(生区間の境界は
 * isBoundary だけで決まり、吸収の有無に左右されないため、この値は
 * 吸収処理全体を通じて不変)。
 */
function rawGroupLenSec(groups: RawGroup[], i: number, samples: ScreenSample[]): number {
  const g = groups[i];
  const startSourceSec = samples[g.start].sourceSec;
  const endSourceSec =
    i < groups.length - 1 ? samples[groups[i + 1].start].sourceSec : samples[samples.length - 1].sourceSec;
  return endSourceSec - startSourceSec;
}

/** 吸収処理の途中経過(手順5)。まだ sourceSec/endSourceSec は確定しない
 * (次の最終区間が決まらないと endSourceSec が決まらないため、手順7で確定する) */
interface BuildingSegment {
  /** samples[] への添字(このセグメントに属する先頭サンプル) */
  sampleStart: number;
  /** samples[] への添字(このセグメントに属する末尾サンプル) */
  sampleEnd: number;
  /** このセグメントを構成する生区間の数(absorbed = groupCount - 1) */
  groupCount: number;
}

/**
 * 純関数。I/O を一切しない。samples を境界判定→最小区間長の吸収→代表選定→
 * 時刻の埋め込みの順で畳み込み、ScreenSegment[] を返す(§2.3.2)。
 * samples が空配列なら空配列を返す。
 */
export function foldScreenSegments(samples: ScreenSample[], cfg: ScreenSegmentCfg): ScreenSegment[] {
  if (samples.length === 0) return [];

  // 手順4: 境界判定により生区間(RawGroup[])を作る
  const groups = buildRawGroups(samples, cfg);

  // 手順5: 最小区間長の吸収。1回のパスで前から順に処理する(再帰しない)。
  const building: BuildingSegment[] = [];
  let pendingHead: RawGroup[] = [];
  for (let i = 0; i < groups.length; i++) {
    const lenSec = rawGroupLenSec(groups, i, samples);
    if (lenSec < cfg.minSegmentSec) {
      if (building.length === 0) {
        // 前に区間が無い(先頭、または先頭から続く短い区間の連なり)ので、
        // 次に見つかる「十分な長さの」区間へまとめて吸収させる
        pendingHead.push(groups[i]);
      } else {
        // 前の区間へ吸収する
        const target = building[building.length - 1];
        target.sampleEnd = groups[i].end;
        target.groupCount += 1;
      }
    } else {
      // 十分な長さがあるのでこれ自身が区間になる。保留中の先頭吸収があれば
      // ここで一括して引き継ぐ(sourceSec・boundary.in は先頭のものになる)
      const sampleStart = pendingHead.length > 0 ? pendingHead[0].start : groups[i].start;
      const groupCount = pendingHead.length + 1;
      building.push({ sampleStart, sampleEnd: groups[i].end, groupCount });
      pendingHead = [];
    }
  }
  // 全区間が minSegmentSec 未満だった場合(=1件も作られなかった場合)は、
  // 保留中の生区間をすべて合わせて1つの区間にする(他に選択肢が無い)
  if (building.length === 0) {
    building.push({
      sampleStart: pendingHead.length > 0 ? pendingHead[0].start : 0,
      sampleEnd: samples.length - 1,
      groupCount: groups.length,
    });
  }

  // 手順6・7: 代表選定 + 時刻の埋め込み
  const n = building.length;
  const segments: ScreenSegment[] = building.map((seg, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === n - 1;
    const sourceSec = samples[seg.sampleStart].sourceSec;
    const outSec = samples[seg.sampleStart].outSec;
    const endSampleIdx = isLast ? samples.length - 1 : building[idx + 1].sampleStart;
    const endSourceSec = samples[endSampleIdx].sourceSec;
    const endOutSec = samples[endSampleIdx].outSec;
    const lenSec = round2(endSourceSec - sourceSec);
    const sampleCount = seg.sampleEnd - seg.sampleStart + 1;
    const absorbed = seg.groupCount - 1;
    const sceneScore = samples[seg.sampleStart].sceneScore;

    // 手順6: 代表は (sourceSec+endSourceSec)/2 に最も近いサンプル。
    // 同距離なら添字の小さいほう(厳密未満のときだけ更新するため、先着優先)。
    const mid = (sourceSec + endSourceSec) / 2;
    let representativeIndex = seg.sampleStart;
    let bestDist = Math.abs(samples[seg.sampleStart].sourceSec - mid);
    for (let j = seg.sampleStart + 1; j <= seg.sampleEnd; j++) {
      const dist = Math.abs(samples[j].sourceSec - mid);
      if (dist < bestDist) {
        bestDist = dist;
        representativeIndex = j;
      }
    }

    return {
      id: "", // 全区間確定後に sourceSec 昇順で振り直す
      sourceSec,
      endSourceSec,
      outSec,
      endOutSec,
      lenSec,
      sampleCount,
      absorbed,
      sceneScore,
      boundary: {
        in: isFirst ? "start" : "scene",
        out: isLast ? "end" : "scene",
      },
      representativeIndex,
    };
  });

  // §2.4: id は sourceSec 昇順に scr-001 から3桁ゼロ埋め(building は既に
  // sourceSec 昇順で構築されているので、この配列順のまま振ればよい)
  segments.forEach((seg, i) => {
    seg.id = `scr-${String(i + 1).padStart(3, "0")}`;
  });

  return segments;
}
