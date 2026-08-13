// lib/perception.ts — plan(カット判断LLM)へ音特徴(§4)を添える純関数群。
// 最重要不変条件: 既定オフ(audio/ocr 未使用)のとき renderPrompt の出力は
// perception 導入前と1バイトも変わらない(golden。test/rules.test.ts の
// 既存回帰ガードと合わせて二重に固定する)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAudioFeatures,
  computeCursorFeatures,
  computeSystemSpeech,
  formatAudio,
  formatCursor,
  formatOcr,
  pausesWithinKeeps,
  renderPerceptionBlock,
  representativeSourceTime,
  selectOcrTargets,
} from "../src/lib/perception.ts";
import type { PerceptionCursorOptions, SegmentCursorFeature, SegmentOcr } from "../src/lib/perception.ts";
import { detectDwellCandidates } from "../src/lib/cursorAnchors.ts";
import type { CursorDwellSample } from "../src/lib/cursorAnchors.ts";
import { renderPrompt } from "../src/stages/plan.ts";
import type { NumberedSegment } from "../src/stages/plan.ts";
import type { CursorSample } from "../src/stages/record.ts";
import type { Interval } from "../src/types.ts";

/* ---------------- computeAudioFeatures ---------------- */

const numbered: NumberedSegment[] = [
  { id: 1, start: 0, end: 5, text: "導入" },
  { id: 2, start: 7, end: 13, text: "本編" },
  { id: 3, start: 13, end: 20, text: "まとめ" },
];

test("computeAudioFeatures: 先頭区間の gapBefore は常に0", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[0].gapBefore, 0);
});

test("computeAudioFeatures: len は end-start", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[0].len, 5);
  assert.equal(features[1].len, 6);
  assert.equal(features[2].len, 7);
});

test("computeAudioFeatures: gapBefore は直前 keep との間の落ちた秒数", () => {
  const features = computeAudioFeatures(numbered, []);
  assert.equal(features[1].gapBefore, 2); // 5 → 7 の間に2秒落ちている
  assert.equal(features[2].gapBefore, 0); // 13 → 13 は連続(間なし)
});

test("computeAudioFeatures: silenceWithin は区間内の無音の overlap 積算(部分重なり含む)", () => {
  const silences: Interval[] = [
    { start: 4, end: 6 }, // #1(0-5)と1秒重なる、#2(7-13)とは重ならない
    { start: 10, end: 11 }, // #2 に完全に内包(1秒)
    { start: 19, end: 25 }, // #3(13-20)と1秒重なる(末尾が区間外)
  ];
  const features = computeAudioFeatures(numbered, silences);
  assert.equal(features[0].silenceWithin, 1);
  assert.equal(features[1].silenceWithin, 1);
  assert.equal(features[2].silenceWithin, 1);
});

test("computeAudioFeatures: 秒は小数第1位に丸める", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 1.23456, text: "" }];
  const features = computeAudioFeatures(seg, []);
  assert.equal(features[0].len, 1.2);
});

/* ---------------- formatAudio / renderPerceptionBlock ---------------- */

test("formatAudio: 見出しと #id 行を含む", () => {
  const text = formatAudio(computeAudioFeatures(numbered, []));
  assert.match(text, /^## 各区間の音の特徴/);
  assert.match(text, /#1 尺5\.0 \/ 直前カット0\.0 \/ 内無音0\.0/);
  assert.match(text, /#2 尺6\.0 \/ 直前カット2\.0 \/ 内無音0\.0/);
});

test("renderPerceptionBlock: audio も system も ocr も null → 空文字(不変条件の核)", () => {
  assert.equal(renderPerceptionBlock(null, null, null), "");
});

test("renderPerceptionBlock: audio が空配列でも空文字", () => {
  assert.equal(renderPerceptionBlock([], null, null), "");
});

test("renderPerceptionBlock: audio ありで先頭/末尾が改行、見出しと#idを含む", () => {
  const block = renderPerceptionBlock(computeAudioFeatures(numbered, []), null, null);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /AI 向け知覚情報/);
  assert.match(block, /#1 尺5\.0/);
});

test("renderPerceptionBlock: ocr が空配列(全区間 text 空)なら OCR ブロックを出さない(audio も無ければ空文字)", () => {
  assert.equal(renderPerceptionBlock(null, null, []), "");
});

test("renderPerceptionBlock: ocr ありで #id 画面: 行を含む", () => {
  const ocr: SegmentOcr[] = [{ id: 3, lines: ["npm test", "FAIL"], text: "npm test / FAIL" }];
  const block = renderPerceptionBlock(null, null, ocr);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /AI 向け知覚情報/);
  assert.match(block, /#3 画面: "npm test" \/ "FAIL"/);
});

test("renderPerceptionBlock: audio と ocr の両方があれば見出し1つの下に両ブロックが並ぶ", () => {
  const audio = computeAudioFeatures(numbered, []);
  const ocr: SegmentOcr[] = [{ id: 1, lines: ["git commit"], text: "git commit" }];
  const block = renderPerceptionBlock(audio, null, ocr);
  const iAudio = block.indexOf("各区間の音の特徴");
  const iOcr = block.indexOf("各区間の画面テキスト");
  assert.ok(iAudio >= 0 && iOcr >= 0);
  assert.ok(iAudio < iOcr, "audio ブロックが ocr ブロックより前");
  assert.match(block, /^\n## AI 向け知覚情報/);
});

/* ---------------- computeSystemSpeech / systemSpeech ブロック ---------------- */

test("computeSystemSpeech: 区間に overlap するシステム発話だけを集める", () => {
  // numbered[0] は §67 付近で start=0,end=5 / [1] は 10..15(このファイルの numbered)
  const sys = [
    { start: 1, end: 3, text: "デモ再生中" },   // #1 に overlap
    { start: 4.5, end: 6, text: "ピロン" },       // #1 に overlap(部分)
    { start: 100, end: 101, text: "圏外" },       // どの区間にも overlap しない
  ];
  const result = computeSystemSpeech(numbered, sys);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
  assert.deepEqual(result[0].lines, ["デモ再生中", "ピロン"]);
  assert.equal(result[0].text, "デモ再生中 / ピロン");
});

test("computeSystemSpeech: overlap ゼロなら空配列", () => {
  assert.deepEqual(computeSystemSpeech(numbered, [{ start: 99, end: 100, text: "x" }]), []);
});

test("pausesWithinKeeps: silence ∩ keep を minSec 以上・offset 付きで返す", () => {
  const keeps: Interval[] = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ];
  const silences: Interval[] = [
    { start: 2, end: 3.5 },   // keep0 内・1.5秒
    { start: 9.5, end: 10.5 }, // keep0 と 0.5秒だけ重なる(minSec=0.6 で落ちる)
    { start: 22, end: 24 },   // keep1 内・2秒・offset 2
    { start: 100, end: 101 }, // どの keep にも入らない
  ];
  const pauses = pausesWithinKeeps(keeps, silences, 0.6);
  assert.equal(pauses.length, 2);
  assert.deepEqual(pauses[0], { keepIndex: 0, start: 2, end: 3.5, len: 1.5, offset: 2 });
  assert.deepEqual(pauses[1], { keepIndex: 1, start: 22, end: 24, len: 2, offset: 2 });
});

test("pausesWithinKeeps: minSec 未満は全て落ちる", () => {
  const keeps: Interval[] = [{ start: 0, end: 10 }];
  const silences: Interval[] = [{ start: 1, end: 1.3 }];
  assert.deepEqual(pausesWithinKeeps(keeps, silences, 0.6), []);
});

test("renderPerceptionBlock: system=null は audio/ocr のみの出力とバイト等価(回帰)", () => {
  const audio = computeAudioFeatures(numbered, []);
  const ocr: SegmentOcr[] = [{ id: 1, lines: ["git commit"], text: "git commit" }];
  // system 引数に null を渡した3引数呼び出しが、systemSpeech 導入前の
  // audio/ocr のみの出力と1文字も変わらないことを固定する
  const withNull = renderPerceptionBlock(audio, null, ocr);
  const withEmpty = renderPerceptionBlock(audio, [], ocr);
  assert.equal(withNull, withEmpty);
  assert.equal(withNull.includes("システム音声"), false);
});

test("renderPerceptionBlock: systemSpeech ありで見出し行を含み audio と ocr の間に入る", () => {
  const audio = computeAudioFeatures(numbered, []);
  const system = computeSystemSpeech(numbered, [{ start: 1, end: 3, text: "デモ音" }]);
  const ocr: SegmentOcr[] = [{ id: 1, lines: ["git commit"], text: "git commit" }];
  const block = renderPerceptionBlock(audio, system, ocr);
  const iAudio = block.indexOf("各区間の音の特徴");
  const iSys = block.indexOf("各区間のシステム音声");
  const iOcr = block.indexOf("各区間の画面テキスト");
  assert.ok(iAudio < iSys && iSys < iOcr, "audio → systemSpeech → ocr の順");
  assert.match(block, /#1 音声: "デモ音"/);
});

/* ---------------- representativeSourceTime / selectOcrTargets / formatOcr ---------------- */

test("representativeSourceTime: 区間の中点を返す", () => {
  assert.equal(representativeSourceTime({ start: 10, end: 20 }), 15);
  assert.equal(representativeSourceTime({ start: 0, end: 5 }), 2.5);
});

test("selectOcrTargets: 上限以下なら全件そのまま(順序も不変)", () => {
  assert.deepEqual(selectOcrTargets(numbered, 10), numbered);
  assert.deepEqual(selectOcrTargets(numbered, 3), numbered);
});

test("selectOcrTargets: 上限超過時は尺の長い順に選び、返りは id 昇順", () => {
  // 尺: #1=5, #2=6, #3=7 → 上限2なら #3,#2 が選ばれ、id 昇順で #2,#3 の順に返る
  const picked = selectOcrTargets(numbered, 2);
  assert.deepEqual(
    picked.map((s) => s.id),
    [2, 3],
  );
});

test("formatOcr: text が空の区間は行に出ない(全区間空なら本文行なし)", () => {
  const ocr: SegmentOcr[] = [
    { id: 1, lines: [], text: "" },
    { id: 2, lines: ["hello"], text: "hello" },
  ];
  const text = formatOcr(ocr);
  assert.doesNotMatch(text, /#1 画面:/);
  assert.match(text, /#2 画面: "hello"/);
  assert.match(text, /記載のない区間は画面テキストなし/);
});

/* ---------------- computeCursorFeatures / formatCursor(video-perception-P3) ---------------- */

const CURSOR_CFG: PerceptionCursorOptions = {
  minDwellMs: 600,
  moveThreshold: 0.02,
  waitTypes: ["wait", "busybutclickable"],
};

/** テスト用 CursorSample を作る(未指定フィールドは無害な既定値) */
function mkSample(t: number, overrides: Partial<CursorSample> = {}): CursorSample {
  return {
    recTimeMs: t,
    cx: 0.5,
    cy: 0.5,
    inBounds: true,
    cursorType: null,
    assetId: null,
    leftButtonDown: false,
    leftButtonPressed: false,
    leftButtonReleased: false,
    ...overrides,
  };
}

const twoSegs: NumberedSegment[] = [
  { id: 1, start: 0, end: 10, text: "" },
  { id: 2, start: 10, end: 20, text: "" },
];

test("computeCursorFeatures T5: 帰属は左閉右開(seg.end ちょうどの秒は次の区間へ・二重計上なし)", () => {
  // t=10000ms(sec10)は seg1[0,10) には入らず seg2[10,20) にだけ入る
  const samples = [mkSample(10000, { cx: 0.5, cy: 0.5 })];
  const result = computeCursorFeatures(twoSegs, samples, CURSOR_CFG);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
});

test("computeCursorFeatures T6: inBounds:false のサンプルは全指標から除外される", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 10, text: "" }];
  const samples = [
    mkSample(1000, { inBounds: false, cx: 0.9, cy: 0.9, leftButtonPressed: true, cursorType: "wait" }),
    mkSample(2000, { inBounds: true, cx: 0.1, cy: 0.1, leftButtonPressed: false, cursorType: null }),
  ];
  const result = computeCursorFeatures(seg, samples, CURSOR_CFG);
  assert.equal(result.length, 1);
  // inBounds:false の click/waitType は数えられない。有効サンプルは1件のみ
  assert.equal(result[0].clicks, 0);
  assert.equal(result[0].idleRatio, 1); // 有効サンプルは1件だけ(0除算回避のケース)
  assert.equal(result[0].waitRatio, 0);
});

test("computeCursorFeatures T7: 属するサンプルが0件の区間は結果に含まれない", () => {
  // seg2 に属するサンプルが1件も無い
  const samples = [mkSample(1000, { cx: 0.5, cy: 0.5 })]; // seg1[0,10) だけに属する
  const result = computeCursorFeatures(twoSegs, samples, CURSOR_CFG);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
});

test("computeCursorFeatures T8: clicks は leftButtonPressed を数える(leftButtonDown連続は数えない)", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 100, text: "" }];
  const samples: CursorSample[] = [];
  for (let i = 0; i < 30; i++) {
    samples.push(
      mkSample(i * 100, {
        cx: 0.5,
        cy: 0.5,
        leftButtonDown: true, // 30件連続で押されている最中
        leftButtonPressed: i === 0, // 押した瞬間は先頭の1件だけ
      }),
    );
  }
  const result = computeCursorFeatures(seg, samples, CURSOR_CFG);
  assert.equal(result[0].clicks, 1);
});

test("computeCursorFeatures T9/T11: maxDwellMs は Number.MAX_SAFE_INTEGER(既定2600msに切られない)。dwellMaxSec=max(strength)/1000", () => {
  // 10秒の静止(0.1,0.1固定)。既定の DEFAULT_MAX_DWELL_MS(2600ms)なら
  // maxDwellMs超過で候補から除外されるはずだが、知覚では除外しない
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 30, text: "" }];
  const samples: CursorSample[] = [];
  for (let t = 0; t <= 10000; t += 200) {
    samples.push(mkSample(t, { cx: 0.1, cy: 0.1 }));
  }
  const result = computeCursorFeatures(seg, samples, CURSOR_CFG);
  assert.equal(result[0].dwellCount, 1);
  assert.equal(result[0].dwellMaxSec, 10.0);
});

test("computeCursorFeatures T10: spacingMs は0(plan.cursorの値を渡した場合よりdwellCountが多い=間引き無効化の実証)", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 30, text: "" }];
  const samples: CursorSample[] = [
    // run1: 0-800ms(0.1,0.1)。strength(duration)=800
    ...[0, 100, 200, 300, 400, 500, 600, 700, 800].map((t) => mkSample(t, { cx: 0.1, cy: 0.1 })),
    // jump(単独点。duration0なので候補にならない)
    mkSample(900, { cx: 0.9, cy: 0.9 }),
    // run2: 1000-1700ms(0.1,0.1)。strength=700。run1中心(400)から950ms
    ...[1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700].map((t) => mkSample(t, { cx: 0.1, cy: 0.1 })),
    // jump
    mkSample(1800, { cx: 0.9, cy: 0.9 }),
    // run3: 1900-2650ms(0.1,0.1)。strength=750。run1中心(400)から1875ms(>=1800)
    ...[1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2650].map((t) => mkSample(t, { cx: 0.1, cy: 0.1 })),
  ];

  const result = computeCursorFeatures(seg, samples, CURSOR_CFG);
  assert.equal(result[0].dwellCount, 3); // spacingMs:0 なので3件とも採用される

  // plan.cursor 相当の間引き値(maxDwellMs:8000 / spacingMs:1800)を渡すと、
  // run2(中心1350ms)が run1(中心400ms)・run3(中心2275ms)の両方から
  // spacingMs(1800ms)未満のため間引かれ、2件しか残らない
  const dwellCfg: CursorDwellSample[] = samples.map((s) => ({
    recTimeMs: s.recTimeMs,
    cx: s.cx,
    cy: s.cy,
    inBounds: s.inBounds,
    leftButtonPressed: s.leftButtonPressed,
  }));
  const thinned = detectDwellCandidates(dwellCfg, {
    minDwellMs: 600,
    maxDwellMs: 8000,
    moveThreshold: 0.02,
    spacingMs: 1800,
    clickBoost: 1,
    windowMs: 0,
  });
  assert.equal(thinned.length, 2);
  assert.ok(result[0].dwellCount > thinned.length, "間引き無効化により dwellCount が多い");
});

test("computeCursorFeatures T12: サンプル1件だけの区間は idleRatio=1(0除算しない)", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 100, text: "" }];
  const samples = [mkSample(1000, { cx: 0.5, cy: 0.5 })];
  const result = computeCursorFeatures(seg, samples, CURSOR_CFG);
  assert.equal(result[0].idleRatio, 1);
});

test("computeCursorFeatures T13: idleRatio の隣接ペアは区間内だけで作られる(区間をまたがない)", () => {
  // seg1[0,10): (0.1,0.1)を3点(idleペア2件)。seg2[10,20): 境界直後に
  // 大きくジャンプした点(0.9,0.9)から始まり、その後は(0.9,0.9)で静止する3点。
  // 区間をまたいでペアを作ると seg2 の1ペア目が「移動」として誤計上され
  // idleRatio が 1 を下回ってしまう(2/3≈0.67)。正しくは区間内だけでペアを
  // 作るので seg2 も idleRatio=1 になる
  const samples = [
    mkSample(7000, { cx: 0.1, cy: 0.1 }),
    mkSample(8000, { cx: 0.1, cy: 0.1 }),
    mkSample(9000, { cx: 0.1, cy: 0.1 }),
    mkSample(10000, { cx: 0.9, cy: 0.9 }), // seg2 側(左閉右開)
    mkSample(11000, { cx: 0.9, cy: 0.9 }),
    mkSample(12000, { cx: 0.9, cy: 0.9 }),
  ];
  const result = computeCursorFeatures(twoSegs, samples, CURSOR_CFG);
  const seg1 = result.find((r) => r.id === 1);
  const seg2 = result.find((r) => r.id === 2);
  assert.equal(seg1?.idleRatio, 1);
  assert.equal(seg2?.idleRatio, 1);
});

test("computeCursorFeatures T14: cursorType:null は waitTypes に一致しない", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 10, text: "" }];
  const samples = [
    mkSample(1000, { cursorType: null }),
    mkSample(2000, { cursorType: null }),
  ];
  // waitTypes に "null" という文字列を含めても、実際の値(JS の null)には一致しない
  const result = computeCursorFeatures(seg, samples, { ...CURSOR_CFG, waitTypes: ["null", "wait"] });
  assert.equal(result[0].waitRatio, 0);
});

test("computeCursorFeatures T15: waitTypes の比較は完全一致(\"wait\"は\"waiting\"に一致しない)", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 10, text: "" }];
  const samples = [
    mkSample(1000, { cursorType: "waiting" }),
    mkSample(2000, { cursorType: "wait" }),
  ];
  const result = computeCursorFeatures(seg, samples, { ...CURSOR_CFG, waitTypes: ["wait"] });
  assert.equal(result[0].waitRatio, 0.5); // "wait" の1件だけが一致
});

test("computeCursorFeatures T16: idleRatio/waitRatioは0〜1に収まり小数第2位へ丸められる", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 10, text: "" }];
  const samples = [
    mkSample(0, { cx: 0.1, cy: 0.1, cursorType: "wait" }),
    mkSample(1000, { cx: 0.1, cy: 0.1, cursorType: "wait" }),
    mkSample(2000, { cx: 0.1, cy: 0.1, cursorType: "wait" }), // idle pair (0-1)(1-2)
    mkSample(3000, { cx: 0.1, cy: 0.1, cursorType: null }), // idle pair (2-3) → 3 idle pairs
    mkSample(4000, { cx: 0.9, cy: 0.9, cursorType: null }), // moved (3-4)
    mkSample(5000, { cx: 0.2, cy: 0.9, cursorType: null }), // moved (4-5)
    mkSample(6000, { cx: 0.9, cy: 0.2, cursorType: null }), // moved (5-6)
    mkSample(7000, { cx: 0.3, cy: 0.3, cursorType: null }), // moved (6-7) → 4 moved pairs, 7 pairs total
  ];
  const result = computeCursorFeatures(seg, samples, { ...CURSOR_CFG, waitTypes: ["wait"] });
  assert.equal(result[0].idleRatio, 0.43); // 3/7 = 0.428571... → 0.43
  assert.equal(result[0].waitRatio, 0.38); // 3/8 = 0.375 → 0.38
  assert.ok(result[0].idleRatio >= 0 && result[0].idleRatio <= 1);
  assert.ok(result[0].waitRatio >= 0 && result[0].waitRatio <= 1);
});

test("formatCursor: 見出し・行書式・末尾注記を含む", () => {
  const cursor: SegmentCursorFeature[] = [
    { id: 3, clicks: 4, dwellCount: 2, dwellMaxSec: 2.1, idleRatio: 0.38, waitRatio: 0 },
    { id: 7, clicks: 0, dwellCount: 1, dwellMaxSec: 5.4, idleRatio: 0.91, waitRatio: 0.68 },
  ];
  const text = formatCursor(cursor);
  assert.match(text, /^## 各区間のカーソル操作/);
  assert.match(text, /#3 クリック4 \/ 停留2\(最長2\.1秒\) \/ 静止38% \/ 待機カーソル0%/);
  assert.match(text, /#7 クリック0 \/ 停留1\(最長5\.4秒\) \/ 静止91% \/ 待機カーソル68%/);
  assert.match(text, /記載のない区間はカーソル情報なし/);
});

/* ---------------- renderPerceptionBlock + cursor(video-perception-P3 §2.1) ---------------- */

test("renderPerceptionBlock T1: 4引数(cursor=null)は3引数呼び出しとバイト等価(最重要)", () => {
  const audio = computeAudioFeatures(numbered, []);
  const ocr: SegmentOcr[] = [{ id: 1, lines: ["git commit"], text: "git commit" }];
  const with3 = renderPerceptionBlock(audio, null, ocr);
  const with4Null = renderPerceptionBlock(audio, null, ocr, null);
  assert.equal(with4Null, with3);
});

test("renderPerceptionBlock T2: 全ブロック null(cursor含む)→ 空文字", () => {
  assert.equal(renderPerceptionBlock(null, null, null, null), "");
  assert.equal(renderPerceptionBlock(null, null, null, []), "");
});

test("renderPerceptionBlock T3: cursor だけ非null → 前後改行を伴う1ブロック", () => {
  const seg: NumberedSegment[] = [{ id: 1, start: 0, end: 10, text: "" }];
  const cursor = computeCursorFeatures(seg, [mkSample(1000, { leftButtonPressed: true })], CURSOR_CFG);
  const block = renderPerceptionBlock(null, null, null, cursor);
  assert.match(block, /^\n/);
  assert.match(block, /\n$/);
  assert.match(block, /AI 向け知覚情報/);
  assert.match(block, /各区間のカーソル操作/);
});

test("renderPerceptionBlock T4: ブロック順は audio → system → ocr → cursor", () => {
  const audio = computeAudioFeatures(numbered, []);
  const system = computeSystemSpeech(numbered, [{ start: 1, end: 3, text: "デモ音" }]);
  const ocr: SegmentOcr[] = [{ id: 1, lines: ["git commit"], text: "git commit" }];
  const cursor = computeCursorFeatures(numbered, [mkSample(1000, { leftButtonPressed: true })], CURSOR_CFG);
  const block = renderPerceptionBlock(audio, system, ocr, cursor);
  const iAudio = block.indexOf("各区間の音の特徴");
  const iSys = block.indexOf("各区間のシステム音声");
  const iOcr = block.indexOf("各区間の画面テキスト");
  const iCursor = block.indexOf("各区間のカーソル操作");
  assert.ok(iAudio >= 0 && iSys >= 0 && iOcr >= 0 && iCursor >= 0);
  assert.ok(iAudio < iSys && iSys < iOcr && iOcr < iCursor, "audio → systemSpeech → ocr → cursor の順");
});

/* ---------------- バイト等価 golden(§9 不変条件1) ---------------- */

let recDir: string;
let channelDir: string;

before(() => {
  channelDir = mkdtempSync(join(tmpdir(), "framewright-perception-"));
  recDir = join(channelDir, "2026-07-07-rec");
  mkdirSync(recDir);
});

after(() => {
  rmSync(channelDir, { recursive: true, force: true });
});

const numberedForPrompt: NumberedSegment[] = [
  { id: 1, start: 0, end: 10, text: "こんにちは" },
];
const BRIEF_DEFAULT = "(見せ場リストなし。カット判断基準に従って判断してください)";

test("renderPrompt: perception 省略時(既定オフ)は3テンプレとも brief 既定文の直後に見出しが隣接する(バイト等価 golden)", () => {
  const planPrompt = renderPrompt(recDir, "plan.md", numberedForPrompt, 42);
  assert.doesNotMatch(planPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(planPrompt, /\{\{/); // プレースホルダの残骸が無い
  assert.match(
    planPrompt,
    new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## カットの判断基準`),
  );

  const planCutsPrompt = renderPrompt(recDir, "plan-cuts.md", numberedForPrompt, 42);
  assert.doesNotMatch(planCutsPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(planCutsPrompt, /\{\{/);
  assert.match(
    planCutsPrompt,
    new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## カットの判断基準`),
  );

  const metaPrompt = renderPrompt(recDir, "meta.md", numberedForPrompt, 42);
  assert.doesNotMatch(metaPrompt, /AI 向け知覚情報/);
  assert.doesNotMatch(metaPrompt, /\{\{/);
  assert.match(metaPrompt, new RegExp(`${escapeRe(BRIEF_DEFAULT)}\\n\\n## 出力形式`));
});

test("renderPrompt: perception を渡すと {{rules}} の直後(区切りなし)に挿入される", () => {
  const perception = "\n## AI 向け知覚情報(発話以外の手掛かり)\n\nダミー\n";
  const planPrompt = renderPrompt(recDir, "plan.md", numberedForPrompt, 42, perception);
  assert.match(planPrompt, /ダミー\n\n## カットの判断基準/);
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
