import test from "node:test";
import assert from "node:assert/strict";
import { compileEditIntents } from "../src/lib/editIntent.ts";
import type { EditIntent } from "../src/lib/editIntent.ts";
import type { LoadedDocs } from "../src/stages/validate.ts";

const docs = (): LoadedDocs => ({
  manifest: { durationSec: 10, video: { width: 100, height: 100, fps: 30, screenRegion: { x: 0, y: 0, w: 100, h: 100 } } },
  cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
  transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 2, text: "old" }] },
  overlays: {},
  chapters: null,
  bgm: null,
  meta: null,
  shorts: null,
  thumbnail: null,
});

test("compileEditIntents: range中央を3分割しapprovedを変えない", () => {
  const result = compileEditIntents(docs(), [{
    type: "set-range-action",
    range: { startSec: 2, endSec: 4 },
    action: "cut",
    reason: "pause",
  }], { recordingDir: "/tmp" });
  assert.equal(result.errors.length, 0);
  const cutplan = result.patch.replace?.cutplan;
  assert.equal(cutplan?.approved, false);
  assert.deepEqual(cutplan?.segments.map((segment) => [segment.start, segment.end, segment.action]), [
    [0, 2, "keep"], [2, 4, "cut"], [4, 10, "keep"],
  ]);
  assert.equal(cutplan?.segments[0].id, "seg_aaaaaa");
});

test("compileEditIntents: caption textだけを変更する", () => {
  const result = compileEditIntents(docs(), [{
    type: "set-caption-text",
    target: "@cap_aaaaaa",
    text: "new",
  }], { recordingDir: "/tmp" });
  assert.equal(result.errors.length, 0);
  assert.equal(result.patch.replace?.transcript?.segments[0].text, "new");
  assert.equal(result.patch.replace?.transcript?.segments[0].start, 1);
});

test("compileEditIntents: set-caption-timing は下限なしで表示区間を短くし words をクリップする", () => {
  const d = docs();
  (d.transcript as { segments: Record<string, unknown>[] }).segments[0].words = [
    { text: "a", start: 1, end: 1.1 },
    { text: "b", start: 1.1, end: 1.5 },
    { text: "c", start: 1.6, end: 2 },
  ];
  const result = compileEditIntents(d, [{
    type: "set-caption-timing",
    target: "@cap_aaaaaa",
    endSec: 1.2,
  }], { recordingDir: "/tmp" });
  assert.equal(result.errors.length, 0);
  const seg = result.patch.replace?.transcript?.segments[0];
  assert.equal(seg?.start, 1);
  assert.equal(seg?.end, 1.2);
  assert.equal(seg?.text, "old");
  assert.deepEqual(seg?.words, [
    { text: "a", start: 1, end: 1.1 },
    { text: "b", start: 1.1, end: 1.2 },
  ]);
});

test("compileEditIntents: set-caption-timing の逆転区間・時刻欠落は validation error にする", () => {
  for (const intent of [
    { type: "set-caption-timing", target: "@cap_aaaaaa", startSec: 2, endSec: 1.5 },
    { type: "set-caption-timing", target: "@cap_aaaaaa", endSec: 0.5 },
    { type: "set-caption-timing", target: "@cap_aaaaaa" },
    { type: "set-caption-timing", target: "@cap_zzzzzz", endSec: 1.5 },
  ]) {
    const result = compileEditIntents(docs(), [intent as EditIntent], { recordingDir: "/tmp" });
    assert.equal(result.errors.length, 1, JSON.stringify(intent));
    assert.deepEqual(result.patch, {});
  }
});

test("compileEditIntents: range 欠落 task は TypeError でなく validation error にする", () => {
  const result = compileEditIntents(docs(), [{
    type: "set-range-action",
    action: "cut",
    reason: "pause",
  } as unknown as EditIntent], { recordingDir: "/tmp" });
  assert.deepEqual(result.patch, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /range\/action\/reason が不正です/);
});

test("compileEditIntents: reason 欠落 task は TypeError でなく validation error にする", () => {
  const result = compileEditIntents(docs(), [{
    type: "set-range-action",
    range: { startSec: 2, endSec: 4 },
    action: "cut",
  } as unknown as EditIntent], { recordingDir: "/tmp" });
  assert.deepEqual(result.patch, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /range\/action\/reason が不正です/);
});

test("compileEditIntents: add-blur の rect 欠落は TypeError でなく validation error にする", () => {
  const result = compileEditIntents(docs(), [{
    type: "add-blur",
    range: { startSec: 2, endSec: 4 },
  } as unknown as EditIntent], { recordingDir: "/tmp" });
  assert.deepEqual(result.patch, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /blur のrange\/rect\/strengthが不正です/);
});

test("compileEditIntents: place-material の placement 欠落は TypeError でなく validation error にする", () => {
  const result = compileEditIntents(docs(), [{
    type: "place-material",
    range: { startSec: 2, endSec: 4 },
    file: "missing.png",
  } as unknown as EditIntent], { recordingDir: "/tmp" });
  assert.deepEqual(result.patch, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /material のrangeまたはfileが不正です|material placement が不正です/);
});

test("compileEditIntents: add-annotation は id mode で annotation id を採番する", () => {
  const result = compileEditIntents(docs(), [{
    type: "add-annotation",
    range: { startSec: 2, endSec: 4 },
    annotation: { type: "box", rect: { x: 5, y: 6, w: 20, h: 30 } },
  }], { recordingDir: "/tmp" });
  assert.equal(result.errors.length, 0);
  assert.match(result.patch.replace?.overlays?.annotations?.[0].id ?? "", /^ann_[0-9a-z]{6}$/);
  assert.equal(result.patch.replace?.overlays?.annotations?.[0].start, 2);
  assert.equal(result.patch.replace?.overlays?.annotations?.[0].end, 4);
});

test("compileEditIntents: add-annotation の body 不正は overlays validate 前に validation error にする", () => {
  const result = compileEditIntents(docs(), [{
    type: "add-annotation",
    range: { startSec: 2, endSec: 4 },
    annotation: { rect: { x: 5, y: 6, w: 20, h: 30 } } as unknown as EditIntent["annotation"],
  }], { recordingDir: "/tmp" });
  assert.deepEqual(result.patch, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /annotation のrange\/bodyが不正です/);
});
