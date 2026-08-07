import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stampDocs } from "../src/lib/ids.ts";
import type { EditableDocs } from "../src/lib/ids.ts";
import { ID_RE } from "../src/lib/ids.ts";

const root = join(import.meta.dirname, "..");
const server = readFileSync(join(root, "editor/server.ts"), "utf8");
const app = readFileSync(join(root, "editor/client/App.tsx"), "utf8");
const widgets = readFileSync(join(root, "editor/client/widgets.tsx"), "utf8");
const apiTypes = readFileSync(join(root, "editor/client/apiTypes.ts"), "utf8");
const transcribeSrc = readFileSync(join(root, "src/stages/transcribe.ts"), "utf8");

test("editor analyze: POST /api/analyze は heavy job に乗せず dir キーの専用スロットを使う", () => {
  assert.match(server, /path === "\/api\/analyze"/);
  assert.match(server, /analysisJobs = new Map<string, Promise<AnalyzeResult>>\(\)/);
  assert.doesNotMatch(server, /runHeavyJob\("analyze"/);
  assert.match(widgets, /request\("\/api\/analyze", \{\}\)/);
});

test("editor analyze: plan は走らせない(cutplan / chapters / meta を書かない)", () => {
  const body = /async function runAnalysis[\s\S]*?\n\}/.exec(server)?.[0] ?? "";
  assert.match(body, /transcribe\(dir, cfg/);
  assert.match(body, /markUnadopted: true/);
  assert.match(body, /idStamp\(dir\)/);
  assert.match(body, /detect\(dir, cfg\)/);
  assert.doesNotMatch(body, /\bplan\(/);
  assert.doesNotMatch(body, /runDraft/);
});

test("runAnalysis: transcribe の直後に idStamp を呼ぶ(AI 編集の行単位割当の前提)", () => {
  const body = /async function runAnalysis[\s\S]*?\n\}/.exec(server)?.[0] ?? "";
  assert.match(body, /transcribe\(dir, cfg[\s\S]*?idStamp\(dir\)[\s\S]*?detect\(dir, cfg\)/);
});

test("stampDocs: generatedBy を落とさない(id 採番が字幕を勝手に採用しない)", () => {
  const before = {
    cutplan: null,
    overlays: null,
    chapters: null,
    bgm: null,
    thumbnail: null,
    transcript: {
      generatedBy: "transcribe",
      language: "ja",
      model: "m",
      segments: [{ start: 0, end: 1, text: "あ" }],
    },
  } as unknown as EditableDocs;
  const after = stampDocs(before);
  assert.equal(after.transcript?.generatedBy, "transcribe");
  assert.match(after.transcript?.segments[0].id ?? "", ID_RE);
});

test("editor analyze: 書き込み直前に bootstrap 判定をやり直して手編集を守る", () => {
  assert.match(server, /beforeWrite:[\s\S]*?isBootstrapArtifact\(join\(dir, "transcript\.json"\)\)/);
  assert.match(server, /TranscribeAbortedError/);
  assert.match(
    transcribeSrc,
    /opts\.beforeWrite\?\.\(\);\s*\n\s*writeFileSync\(\s*\n?\s*join\(dir, "transcript\.json"\)/,
  );
});

test("editor analyze: 開いた瞬間に1回だけ自動起動し、実行中は AI 編集だけ止める", () => {
  assert.match(app, /analysisKickedRef/);
  assert.match(app, /if \(!proj \|\| !proj\.analysisNeeded \|\| analysisKickedRef\.current\.has\(proj\.dir\)\) return/);
  assert.match(app, /analysisKickedRef\.current\.add\(proj\.dir\)/);
  assert.match(app, /disabled=\{anyDirty \|\| aiWorkflowLocked \|\| analysisBusy\}/);
  assert.match(app, /文字起こし中です。終わると AI 編集を使えます/);
});

test("editor analyze: 自動文字起こしは未採用マーカーを付け、CLI 既定では付けない", () => {
  assert.match(transcribeSrc, /markUnadopted\?: boolean/);
  assert.match(
    transcribeSrc,
    /\.\.\.\(opts\.markUnadopted \? \{ generatedBy: "transcribe" as const \} : \{\}\)/,
  );
});

test("editor analyze: AI 編集モーダルに文字起こし採用コマンドを持つ", () => {
  assert.match(app, /const adoptCaptions = \(\) => \{/);
  assert.match(app, /transcript\.generatedBy !== "transcribe"/);
  assert.match(app, /delete next\.generatedBy/);
  assert.match(app, /文字起こしをテロップにする/);
  assert.match(app, /disabled=\{analysisBusy\}/);
});

test("editor analyze: 「AI に初版を作らせる」は削除済み", () => {
  assert.doesNotMatch(app, /AI に初版を作らせる/);
  assert.doesNotMatch(app, /runInitialDraft/);
  assert.doesNotMatch(server, /path === "\/api\/run"/);
  assert.doesNotMatch(server, /runNeedsForce/);
  assert.doesNotMatch(widgets, /postRun/);
  assert.doesNotMatch(apiTypes, /runNeedsForce/);
});
