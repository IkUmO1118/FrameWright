// video-perception-P1 §3.1(T1〜T16)。screen.probe/ の区間畳み込み
// (foldScreenSegments)・OCR行正規化(normalizeOcrLines)・Jaccard係数(jaccard)
// を固定する。T4・T9・T12 は素朴な実装が落ちるように置かれている
// (docs/plans/2026-08-10-video-perception-p1-screen-probe-design.md §3.1)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldScreenSegments, jaccard, normalizeOcrLines } from "../src/lib/screenSegments.ts";
import type { ScreenSample, ScreenSegmentCfg } from "../src/lib/screenSegments.ts";
import type { OcrResult, OcrLine } from "../src/lib/ocr.ts";

function cfg(overrides: Partial<ScreenSegmentCfg> = {}): ScreenSegmentCfg {
  return {
    mergeThreshold: 0.6,
    sceneThreshold: 0.5,
    minSegmentSec: 10,
    indexLines: 8,
    ...overrides,
  };
}

function sample(
  sourceSec: number,
  lines: string[] | null,
  sceneScore: number,
  outSec = sourceSec,
): ScreenSample {
  return { outSec, sourceSec, sceneScore, lines, raw: null };
}

function ocrLine(text: string): OcrLine {
  return { text, confidence: 1, box: { x: 0, y: 0, w: 0, h: 0 } };
}

function ocrResult(texts: string[]): OcrResult {
  return {
    text: texts.join("\n"),
    lines: texts.map(ocrLine),
    image: { w: 100, h: 100 },
  };
}

test("T1: 全サンプルの OCR が同一 → 区間 1 件", () => {
  const samples = [
    sample(0, ["a", "b"], 0.9),
    sample(5, ["a", "b"], 0.9),
    sample(10, ["a", "b"], 0.1),
    sample(15, ["a", "b"], 0.9),
    sample(20, ["a", "b"], 0.9),
  ];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 1 }));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].sourceSec, 0);
  assert.equal(segments[0].endSourceSec, 20);
  assert.equal(segments[0].sampleCount, 5);
});

test("T2: OCR が違っても sceneScore が閾値未満 → 境界にしない(AND の左だけ真)", () => {
  const samples = [sample(0, ["a"], 0.9), sample(5, ["b"], 0.1)];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 1, sceneThreshold: 0.5 }));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].sampleCount, 2);
});

test("T3: sceneScore が高くても OCR が同一 → 境界にしない(AND の右だけ真)", () => {
  const samples = [sample(0, ["a"], 0.1), sample(5, ["a"], 0.9)];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 1, sceneThreshold: 0.5 }));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].sampleCount, 2);
});

test("T4: 両方の行集合が空 → Jaccard = 1(同一扱い・0除算しない)", () => {
  assert.equal(jaccard([], []), 1);
});

test("T5: 片方だけ空集合 → Jaccard = 0", () => {
  assert.equal(jaccard(["a"], []), 0);
  assert.equal(jaccard([], ["a"]), 0);
});

test("T6: 正規化が NFKC → trim → 小文字化 → 空白畳み → 空行捨て の順に効く", () => {
  const raw = ocrResult(["  Foo   BAR ", "foo bar", "   "]);
  const normalized = normalizeOcrLines(raw);
  // "  Foo   BAR " と "foo bar" は同一行になる。空文字だけの行は捨てられる。
  assert.deepEqual(normalized, ["foo bar", "foo bar"]);
});

test("T7: lines === null のサンプルは第1条件が真とみなされ、sceneScore だけで判定される", () => {
  // s1.lines は null → 第1条件は自動的に真。s1.sceneScore(0.9) >= threshold なので境界になる。
  const boundarySamples = [sample(0, ["x"], 0.1), sample(5, null, 0.9), sample(10, ["x"], 0.1)];
  const withBoundary = foldScreenSegments(boundarySamples, cfg({ minSegmentSec: 1 }));
  assert.equal(withBoundary.length, 2);
  assert.equal(withBoundary[0].sourceSec, 0);
  assert.equal(withBoundary[0].endSourceSec, 5);
  assert.equal(withBoundary[1].sourceSec, 5);
  assert.equal(withBoundary[1].endSourceSec, 10);

  // s1.sceneScore が閾値未満なら、lines が null でも境界にならない(第2条件が偽)。
  const noBoundarySamples = [sample(0, ["x"], 0.1), sample(5, null, 0.1), sample(10, ["x"], 0.1)];
  const noBoundary = foldScreenSegments(noBoundarySamples, cfg({ minSegmentSec: 1 }));
  assert.equal(noBoundary.length, 1);
});

test("T8: minSegmentSec 未満の区間が前へ吸収され、sampleCount 加算・absorbed が +1+被吸収のabsorbedになる", () => {
  // 生区間: G0=[0,1](0,10, "a") / G1=[2](12, "b") / G2=[3,4](14,30, "c")
  // rawLen(G0)=12-0=12>=10 → 単独区間。rawLen(G1)=14-12=2<10 → G0へ吸収。
  // rawLen(G2)=30-14=16>=10 → 単独区間。
  const samples = [
    sample(0, ["a"], 0.1),
    sample(10, ["a"], 0.1),
    sample(12, ["b"], 0.9),
    sample(14, ["c"], 0.9),
    sample(30, ["c"], 0.1),
  ];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 10 }));
  assert.equal(segments.length, 2);
  assert.equal(segments[0].sourceSec, 0);
  assert.equal(segments[0].endSourceSec, 14);
  assert.equal(segments[0].sampleCount, 3);
  assert.equal(segments[0].absorbed, 1);
  assert.equal(segments[1].sourceSec, 14);
  assert.equal(segments[1].sampleCount, 2);
  assert.equal(segments[1].absorbed, 0);
});

test("T9: 先頭区間が minSegmentSec 未満のときは次へ吸収され、吸収先が boundary.in と sourceSec を引き継ぐ", () => {
  // 生区間: G0=[0](0,"a") / G1=[1..4](5,10,15,20,"b") / G2=[5,6](25,40,"c")
  // rawLen(G0)=5-0=5<10 → 先頭なので保留(次へ吸収)。
  // rawLen(G1)=25-5=20>=10 → 単独区間として確定し、保留中のG0を先頭吸収する
  //   (sourceSec・boundary.in はG0=0/"start"を引き継ぐ)。
  // rawLen(G2)=40-25=15>=10 → 単独区間。
  const samples = [
    sample(0, ["a"], 0.1),
    sample(5, ["b"], 0.9),
    sample(10, ["b"], 0.1),
    sample(15, ["b"], 0.1),
    sample(20, ["b"], 0.1),
    sample(25, ["c"], 0.9),
    sample(40, ["c"], 0.1),
  ];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 10 }));
  assert.equal(segments.length, 2);
  assert.equal(segments[0].sourceSec, 0);
  assert.equal(segments[0].boundary.in, "start");
  assert.equal(segments[0].sampleCount, 5);
  assert.equal(segments[0].absorbed, 1);
  assert.equal(segments[1].sourceSec, 25);
  assert.equal(segments[1].absorbed, 0);
});

test("T10: 吸収は1パスで、吸収後に再帰しない(3連続の短い生区間が1つの前区間へまとめて吸収される)", () => {
  // 生区間: G0=[0,1](0,10,"a") 単独 / G1=[2](20,"b") / G2=[3](23,"c") / G3=[4](26,"d")
  // はいずれも rawLen<10 で連続して G0 へ吸収 / G4=[5,6](30,55,"e") 単独。
  const samples = [
    sample(0, ["a"], 0.1),
    sample(10, ["a"], 0.1),
    sample(20, ["b"], 0.9),
    sample(23, ["c"], 0.9),
    sample(26, ["d"], 0.9),
    sample(30, ["e"], 0.9),
    sample(55, ["e"], 0.1),
  ];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 10 }));
  assert.equal(segments.length, 2);
  assert.equal(segments[0].sourceSec, 0);
  assert.equal(segments[0].endSourceSec, 30);
  assert.equal(segments[0].sampleCount, 5);
  assert.equal(segments[0].absorbed, 3);
  assert.equal(segments[1].sourceSec, 30);
  assert.equal(segments[1].absorbed, 0);
});

test("T11: 代表は (sourceSec+endSourceSec)/2 に最も近いサンプル。同距離なら添字の小さいほう", () => {
  const samples = [sample(0, ["a"], 0.1), sample(10, ["a"], 0.1), sample(20, ["a"], 0.1), sample(30, ["a"], 0.1)];
  // 全サンプル同一OCRで区間1件。mid=(0+30)/2=15。idx1(10,距離5)とidx2(20,距離5)が同距離
  // → 添字の小さい idx1 を選ぶ。
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 1 }));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].representativeIndex, 1);
});

test("T12: endSourceSec は次区間の開始であって s[b].sourceSec ではない(区間に穴が空かない)", () => {
  // G0=[0,1](0,5,"a") / G1=[2,3](10,15,"b")。両方 rawLen>=minSegmentSec なので吸収なし。
  const samples = [sample(0, ["a"], 0.1), sample(5, ["a"], 0.1), sample(10, ["b"], 0.9), sample(15, ["b"], 0.1)];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 0.01 }));
  assert.equal(segments.length, 2);
  // もし誤って s[b].sourceSec(=5)を使うと 5〜10 に穴が空く。正しくは次区間の開始(10)。
  assert.equal(segments[0].endSourceSec, 10);
});

test("T13: 最後の区間だけ endSourceSec === s[b].sourceSec", () => {
  const samples = [sample(0, ["a"], 0.1), sample(5, ["a"], 0.1), sample(10, ["b"], 0.9), sample(15, ["b"], 0.1)];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 0.01 }));
  assert.equal(segments.length, 2);
  assert.equal(segments[1].endSourceSec, samples[samples.length - 1].sourceSec);
  assert.equal(segments[1].endSourceSec, 15);
});

test("T14: 先頭区間の sceneScore は s[0].sceneScore(入り境界が無くても値が入る)", () => {
  const samples = [sample(0, ["a"], 0.37), sample(5, ["a"], 0.1), sample(10, ["a"], 0.1)];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 1 }));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].sceneScore, 0.37);
});

test("T15: boundary.in は先頭のみ 'start'、boundary.out は最後のみ 'end'", () => {
  // 3区間になるよう2箇所で境界を作る
  const samples = [
    sample(0, ["a"], 0.1),
    sample(5, ["a"], 0.1),
    sample(10, ["b"], 0.9),
    sample(15, ["b"], 0.1),
    sample(20, ["c"], 0.9),
    sample(25, ["c"], 0.1),
  ];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 0.01 }));
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((s) => s.boundary),
    [
      { in: "start", out: "scene" },
      { in: "scene", out: "scene" },
      { in: "scene", out: "end" },
    ],
  );
});

test("T16: id が sourceSec 昇順に scr-001 から3桁ゼロ埋めで振られる", () => {
  const samples = [
    sample(0, ["a"], 0.1),
    sample(5, ["a"], 0.1),
    sample(10, ["b"], 0.9),
    sample(15, ["b"], 0.1),
    sample(20, ["c"], 0.9),
    sample(25, ["c"], 0.1),
  ];
  const segments = foldScreenSegments(samples, cfg({ minSegmentSec: 0.01 }));
  assert.deepEqual(
    segments.map((s) => s.id),
    ["scr-001", "scr-002", "scr-003"],
  );
});

test("空配列を渡すと空配列を返す(例外を投げない)", () => {
  assert.deepEqual(foldScreenSegments([], cfg()), []);
});
