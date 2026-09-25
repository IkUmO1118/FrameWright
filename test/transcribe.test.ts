// stages/transcribe.ts の buildWords(whisper -ojf の tokens[] → WordTiming[])を固定する。
// 実機の whisper-cli -ojf 実測(docs/plans/2026-07-06-word-timestamps-design.md)を
// 模したミニ fixture で、特殊トークン除外・ms→秒変換・trim・confidence 転記を検査する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWords, applyTranscriptIds, resolveTranscriptLanguage } from "../src/stages/transcribe.ts";
import type { WhisperToken } from "../src/stages/transcribe.ts";
import { ID_RE } from "../src/lib/ids.ts";
import type { TranscriptSegment } from "../src/types.ts";

test("buildWords: 実測に近い tokens[] から特殊トークンを除いた words[] を組み立てる", () => {
  const tokens: WhisperToken[] = [
    { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.1 },
    { text: "から", offsets: { from: 880, to: 2630 }, p: 0.976 },
    { text: "テ", offsets: { from: 2630, to: 3100 }, p: 0.92 },
    { text: "スト", offsets: { from: 3100, to: 3600 }, p: 0.88 },
    { text: "[_TT_441]", offsets: { from: 4410, to: 4410 }, p: 0.05 },
  ];
  assert.deepEqual(buildWords(tokens), [
    { text: "から", start: 0.88, end: 2.63, confidence: 0.976 },
    { text: "テ", start: 2.63, end: 3.1, confidence: 0.92 },
    { text: "スト", start: 3.1, end: 3.6, confidence: 0.88 },
  ]);
});

test("buildWords: 英語トークンの先頭空白を trim する", () => {
  const tokens: WhisperToken[] = [
    { text: " Hello", offsets: { from: 0, to: 500 }, p: 0.9 },
    { text: " world", offsets: { from: 500, to: 1000 }, p: 0.9 },
  ];
  const words = buildWords(tokens);
  assert.equal(words[0].text, "Hello");
  assert.equal(words[1].text, "world");
});

test("buildWords: trim 後空文字のトークンは除外", () => {
  const tokens: WhisperToken[] = [
    { text: "  ", offsets: { from: 0, to: 100 }, p: 0.5 },
    { text: "本文", offsets: { from: 100, to: 600 }, p: 0.9 },
  ];
  assert.deepEqual(buildWords(tokens), [
    { text: "本文", start: 0.1, end: 0.6, confidence: 0.9 },
  ]);
});

test("buildWords: from>=to のゼロ幅トークンは除外(角括弧でなくても)", () => {
  const tokens: WhisperToken[] = [
    { text: "ゼロ幅", offsets: { from: 500, to: 500 }, p: 0.5 },
    { text: "逆転", offsets: { from: 700, to: 600 }, p: 0.5 },
    { text: "本文", offsets: { from: 600, to: 900 }, p: 0.9 },
  ];
  assert.deepEqual(buildWords(tokens), [
    { text: "本文", start: 0.6, end: 0.9, confidence: 0.9 },
  ]);
});

test("buildWords: confidence(p)が数値でなければ省略する", () => {
  const tokens: WhisperToken[] = [
    { text: "本文", offsets: { from: 0, to: 500 } },
  ];
  const words = buildWords(tokens);
  assert.equal(words.length, 1);
  assert.equal("confidence" in words[0], false);
});

test("buildWords: tokens が undefined なら空配列", () => {
  assert.deepEqual(buildWords(undefined), []);
});

test("buildWords: tokens が空配列なら空配列", () => {
  assert.deepEqual(buildWords([]), []);
});

/* ---------------- 安定 id(§docs/plans/2026-07-07-stable-ids-design.md) ---------------- */

const segments: TranscriptSegment[] = [
  { start: 0, end: 1, text: "こんにちは" },
  { start: 1, end: 2, text: "今日は" },
];

test("applyTranscriptIds: idCtx 省略時は id に一切触れない(導入前とバイト等価)", () => {
  const out = applyTranscriptIds(segments);
  assert.equal(out, segments); // 同一参照(何も変換していない)
  for (const s of out) assert.equal("id" in s, false);
});

test("applyTranscriptIds: idCtx ありで (start,end,text) 完全一致の旧 id を運ぶ", () => {
  const existingSegments: TranscriptSegment[] = [
    { id: "cap_aaaaaa", start: 0, end: 1, text: "こんにちは" },
  ];
  const used = new Set<string>(["cap_aaaaaa"]);
  const out = applyTranscriptIds(segments, { existingSegments, used });
  assert.equal(out[0].id, "cap_aaaaaa");
  assert.match(out[1].id as string, ID_RE);
});

test("applyTranscriptIds: 内容が変わった(再分割された)セグメントは新 id になる", () => {
  const existingSegments: TranscriptSegment[] = [
    { id: "cap_aaaaaa", start: 0, end: 1, text: "こんにちは(旧文言)" },
  ];
  const used = new Set<string>(["cap_aaaaaa"]);
  const out = applyTranscriptIds(segments, { existingSegments, used });
  assert.notEqual(out[0].id, "cap_aaaaaa");
  assert.match(out[0].id as string, ID_RE);
});

test("buildWords: t_dtw があれば規約A(区間=[直前の点, 自分の点])で組む", () => {
  // whisper -dtw の実測形: t_dtw はセンチ秒の「言い終えた点」。-1 は無効
  const tokens: WhisperToken[] = [
    { text: "[_BEG_]", offsets: { from: 0, to: 0 }, t_dtw: -1 },
    { text: "動画", offsets: { from: 0, to: 720 }, p: 0.99, t_dtw: 65 },
    { text: "編集", offsets: { from: 720, to: 1440 }, p: 0.98, t_dtw: 120 },
    { text: "って", offsets: { from: 1440, to: 2160 }, p: 0.97, t_dtw: 180 },
  ];
  assert.deepEqual(buildWords(tokens), [
    // 先頭は自分の offsets 開始 → 自分の点
    { text: "動画", start: 0, end: 0.65, confidence: 0.99 },
    { text: "編集", start: 0.65, end: 1.2, confidence: 0.98 },
    { text: "って", start: 1.2, end: 1.8, confidence: 0.97 },
  ]);
});

test("buildWords: t_dtw の同一点(速い発話)はゼロ幅にせず 10ms へ丸めて文字を落とさない", () => {
  const tokens: WhisperToken[] = [
    { text: "あ", offsets: { from: 0, to: 200 }, t_dtw: 50 },
    { text: "っ", offsets: { from: 200, to: 300 }, t_dtw: 50 }, // 同一点
    { text: "と", offsets: { from: 300, to: 500 }, t_dtw: 90 },
  ];
  const words = buildWords(tokens);
  assert.equal(words.length, 3);
  assert.equal(words[1].text, "っ");
  assert.ok(words[1].end > words[1].start);
  assert.deepEqual([words[2].start, words[2].end], [0.5, 0.9]);
});

test("buildWords: DTW 実行でも t_dtw 無効(-1)のトークンは出さず、無い実行では offsets 経路のまま", () => {
  const dtwRun: WhisperToken[] = [
    { text: "有効", offsets: { from: 0, to: 400 }, t_dtw: 40 },
    { text: "無効", offsets: { from: 400, to: 800 }, t_dtw: -1 },
    { text: "続き", offsets: { from: 800, to: 1200 }, t_dtw: 110 },
  ];
  assert.deepEqual(buildWords(dtwRun).map((w) => w.text), ["有効", "続き"]);
  // t_dtw フィールドが全く無い(旧 whisper-out)→ 従来とバイト等価
  const legacy: WhisperToken[] = [
    { text: "従来", offsets: { from: 100, to: 500 }, p: 0.9 },
  ];
  assert.deepEqual(buildWords(legacy), [{ text: "従来", start: 0.1, end: 0.5, confidence: 0.9 }]);
});

test("resolveTranscriptLanguage: auto なら whisper の判定結果を記録し、固定指定ならそのまま", () => {
  assert.equal(resolveTranscriptLanguage("auto", "en"), "en");
  assert.equal(resolveTranscriptLanguage("auto", "ja"), "ja");
  // 判定結果が無い(古い whisper.cpp 等)ときは auto のまま
  assert.equal(resolveTranscriptLanguage("auto", undefined), "auto");
  assert.equal(resolveTranscriptLanguage("auto", ""), "auto");
  // 固定指定は判定結果に関係なく config の値
  assert.equal(resolveTranscriptLanguage("ja", "en"), "ja");
});
