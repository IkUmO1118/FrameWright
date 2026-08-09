import { mkdtempSync, mkdirSync, chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EditorAiError,
  buildRefineEditorAiPrompt,
  buildEditorAiPrompt,
  parseAiPatchResponse,
  normalizeCutplanDoc,
  planEditorAiPatch,
  proposeEditorAi,
  refineEditorAi,
} from "../src/stages/editorAi.ts";
import { selectPreviewMedia } from "../editor/client/aiVisualReviewMedia.ts";
import type { Config } from "../src/lib/config.ts";
import type { CutPlan } from "../src/types.ts";
import { completeWithJsonSchema, openAiCompatibleSchema } from "../src/lib/llm.ts";
import type { ReviewStill } from "../src/stages/review.ts";

function withTmpProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "framewright-editor-ai-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", {
      dir,
      source: "raw.mp4",
      durationSec: 30,
      video: {
        width: 1280,
        height: 720,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1280, h: 720 },
      },
      layout: "plain",
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-08T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }],
    });
    write("overlays.json", {});
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTmpProjectAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "framewright-editor-ai-"));
  try {
    const write = (file: string, data: unknown) =>
      writeFileSync(join(dir, file), JSON.stringify(data, null, 2), "utf8");
    write("manifest.json", {
      dir,
      source: "raw.mp4",
      durationSec: 30,
      video: {
        width: 1280,
        height: 720,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1280, h: 720 },
      },
      layout: "plain",
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-08T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }],
    });
    write("overlays.json", {});
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cfg = {
  llm: { backend: "claude-cli", model: "" },
  describe: {},
} as Config;

const sampleStill: ReviewStill = {
  requested: { axis: "source", atSec: 1.2, reason: "caption", ocr: false, fullRes: false },
  before: { outSec: 1.2, sourceSec: 1.2, file: "review.probe/before/still-1.png" },
  after: { outSec: 1.2, sourceSec: 1.2, file: "review.probe/after/still-1.png" },
};

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("parseAiPatchResponse: JSON だけの AI 応答を parse できる", () => {
  const parsed = parseAiPatchResponse(
    JSON.stringify({
      title: "字幕短縮",
      summary: ["冗長語を削る"],
      patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "こんにちは世界" }] },
      review: {
        frames: [{ atSec: 1.2, reason: "字幕の中点" }],
        range: { startSec: 0.5, endSec: 2.5 },
        clip: true,
        observations: { ocr: true },
        notes: ["字幕を確認"],
      },
    }),
  );
  assert.equal(parsed.title, "字幕短縮");
  assert.equal(parsed.summary[0], "冗長語を削る");
  assert.equal(parsed.patch.ops?.length, 1);
  assert.deepEqual(parsed.review.frames, [{ axis: "source", atSec: 1.2, reason: "字幕の中点" }]);
  assert.deepEqual(parsed.review.range, { axis: "source", startSec: 0.5, endSec: 2.5 });
  assert.equal(parsed.review.clip, true);
  assert.deepEqual(parsed.review.observations, { ocr: true });
});

test("selectPreviewMedia: side-by-side は clips が揃うと同期 video を使う", () => {
  const media = selectPreviewMedia("side-by-side", sampleStill, {
    beforeFile: "review.probe/before/clip.mp4",
    afterFile: "review.probe/after/clip.mp4",
  });
  assert.deepEqual(media, {
    kind: "video-pair",
    beforeFile: "review.probe/before/clip.mp4",
    afterFile: "review.probe/after/clip.mp4",
  });
});

test("selectPreviewMedia: side-by-side は片側 clip だけなら still pair に fallback する", () => {
  const media = selectPreviewMedia("side-by-side", sampleStill, {
    afterFile: "review.probe/after/clip.mp4",
  });
  assert.deepEqual(media, {
    kind: "still",
    still: sampleStill,
  });
});

test("selectPreviewMedia: overlay は clips があっても still compare を使う", () => {
  const media = selectPreviewMedia("overlay", sampleStill, {
    beforeFile: "review.probe/before/clip.mp4",
    afterFile: "review.probe/after/clip.mp4",
  });
  assert.deepEqual(media, {
    kind: "still",
    still: sampleStill,
  });
});

test("parseAiPatchResponse: legacy review.frames string[] を正規化する", () => {
  const parsed = parseAiPatchResponse(
    JSON.stringify({
      patch: { ops: [] },
      review: { frames: ["1.2", "4.5"], notes: [] },
    }),
  );
  assert.deepEqual(parsed.review.frames, [
    { axis: "source", atSec: 1.2, reason: "legacy-frame" },
    { axis: "source", atSec: 4.5, reason: "legacy-frame" },
  ]);
});

test("parseAiPatchResponse: legacy update_caption intentを正規化する", () => {
  const parsed = parseAiPatchResponse(JSON.stringify({
    edit: {
      mode: "tasks",
      tasks: [{ type: "update_caption", target: "@cap_aaaaaa", text: "短い字幕" }],
    },
    review: { frames: [], notes: [] },
  }));
  assert.deepEqual(parsed.tasks, [{
    type: "set-caption-text",
    target: "@cap_aaaaaa",
    text: "短い字幕",
  }]);
});

test("parseAiPatchResponse: caption field aliasと@無しidを正規化する", () => {
  const parsed = parseAiPatchResponse(JSON.stringify({
    edit: {
      mode: "tasks",
      tasks: [{
        type: "set-caption-text",
        caption_id: "cap_aaaaaa",
        new_text: "短い字幕",
      }],
    },
    review: { frames: [], notes: [] },
  }));
  assert.equal(parsed.tasks?.[0].type, "set-caption-text");
  assert.deepEqual(parsed.tasks?.[0], {
    type: "set-caption-text",
    caption_id: "cap_aaaaaa",
    new_text: "短い字幕",
    target: "@cap_aaaaaa",
    text: "短い字幕",
  });
});

test("parseAiPatchResponse: add-annotation の top-level start/end を range に正規化する", () => {
  const parsed = parseAiPatchResponse(JSON.stringify({
    edit: {
      mode: "tasks",
      tasks: [{
        type: "add-annotation",
        start: 1.25,
        end: 2.5,
        annotation: { type: "box", rect: { x: 1, y: 2, w: 30, h: 40 } },
      }],
    },
    review: { frames: [], notes: [] },
  }));
  assert.deepEqual(parsed.tasks?.[0], {
    type: "add-annotation",
    start: 1.25,
    end: 2.5,
    range: { startSec: 1.25, endSec: 2.5 },
    annotation: { type: "box", rect: { x: 1, y: 2, w: 30, h: 40 } },
  });
});

test("parseAiPatchResponse: add-annotation の annotation.start/end を range に正規化する", () => {
  const parsed = parseAiPatchResponse(JSON.stringify({
    edit: {
      mode: "tasks",
      tasks: [{
        type: "add-annotation",
        annotation: {
          type: "spotlight",
          start: 3,
          end: 4.5,
          rect: { x: 10, y: 20, w: 100, h: 60 },
        },
      }],
    },
    review: { frames: [], notes: [] },
  }));
  assert.deepEqual(parsed.tasks?.[0], {
    type: "add-annotation",
    range: { startSec: 3, endSec: 4.5 },
    annotation: {
      type: "spotlight",
      rect: { x: 10, y: 20, w: 100, h: 60 },
    },
  });
});

test("parseAiPatchResponse: add-annotation の top-level shape を annotation に畳み込む", () => {
  const parsed = parseAiPatchResponse(JSON.stringify({
    edit: {
      mode: "tasks",
      tasks: [{
        type: "add-annotation",
        startSec: 8,
        endSec: 9.5,
        annotationType: "arrow",
        from: { x: 10, y: 20 },
        to: { x: 40, y: 60 },
        color: "#f00",
      }],
    },
    review: { frames: [], notes: [] },
  }));
  assert.deepEqual(parsed.tasks?.[0], {
    type: "add-annotation",
    startSec: 8,
    endSec: 9.5,
    annotationType: "arrow",
    from: { x: 10, y: 20 },
    to: { x: 40, y: 60 },
    color: "#f00",
    range: { startSec: 8, endSec: 9.5 },
    annotation: {
      type: "arrow",
      from: { x: 10, y: 20 },
      to: { x: 40, y: 60 },
      color: "#f00",
    },
  });
});

test("parseAiPatchResponse: markdown fenced JSON は rejected", () => {
  assert.throws(
    () => parseAiPatchResponse("```json\n{\"patch\":{\"ops\":[]}}\n```"),
    /AI 応答を JSON として読めません/,
  );
});

test("parseAiPatchResponse: patch 欠落を error にする", () => {
  assert.throws(() => parseAiPatchResponse("{\"title\":\"x\"}"), /edit または patch/);
});

test("parseAiPatchResponse: patch add overlays.annotations の中間shapeを最終annotationへ正規化する", () => {
  const parsed = parseAiPatchResponse(JSON.stringify({
    edit: {
      mode: "patch",
      patch: {
        ops: [{
          op: "add",
          target: "overlays.annotations",
          value: {
            range: { startSec: 1, endSec: 3 },
            annotationType: "box",
            rect: { x: 10, y: 20, w: 30, h: 40 },
            color: "#f00",
          },
        }],
      },
    },
    review: { frames: [], notes: [] },
  }));
  assert.deepEqual(parsed.patch.ops?.[0], {
    op: "add",
    target: "overlays.annotations",
    value: {
      type: "box",
      start: 1,
      end: 3,
      rect: { x: 10, y: 20, w: 30, h: 40 },
      color: "#f00",
    },
  });
});

test("planEditorAiPatch: planApply 結果から proposedDocs を作るが書き込まない", async () => {
  await withTmpProjectAsync(async (dir) => {
    const parsed = parseAiPatchResponse(
      JSON.stringify({
        title: "字幕短縮",
        patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "こんにちは世界" }] },
      }),
    );
    const res = await planEditorAiPatch(dir, parsed);
    assert.equal(res.proposedDocs.transcript.segments[0].text, "こんにちは世界");
    assert.equal(res.applyPlan.changedFiles.includes("transcript.json"), true);
  });
});

test("planEditorAiPatch: approved 変更 patch は planApply errors として 400", async () => {
  await withTmpProjectAsync(async (dir) => {
    const parsed = parseAiPatchResponse(
      JSON.stringify({
        patch: {
          replace: {
            cutplan: {
              approved: true,
              segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }],
            },
          },
        },
      }),
    );
    assert.throws(
      () => planEditorAiPatch(dir, parsed),
      (e) => e instanceof EditorAiError && e.status === 400 && /approved/.test(e.message),
    );
  });
});

test("planEditorAiPatch: tasks が不正でも併記 patch が有効なら patch を使う", async () => {
  await withTmpProjectAsync(async (dir) => {
    const parsed = parseAiPatchResponse(
      JSON.stringify({
        title: "fallback patch",
        edit: {
          mode: "tasks",
          tasks: [{ type: "set-range-action", action: "cut", reason: "bad" }],
        },
        patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "短い字幕" }] },
        review: { frames: [], notes: [] },
      }),
    );
    const res = await planEditorAiPatch(dir, parsed);
    assert.equal(res.proposedDocs.transcript.segments[0].text, "短い字幕");
    assert.equal(res.applyPlan.changedFiles.includes("transcript.json"), true);
  });
});

test("planEditorAiPatch: AI の素材配置 rect を出力範囲へクランプする", async () => {
  await withTmpProjectAsync(async (dir) => {
    const parsed = parseAiPatchResponse(JSON.stringify({
      title: "material place",
      edit: {
        mode: "tasks",
        tasks: [{
          type: "place-material",
          file: "materials/shot.png",
          range: { startSec: 1, endSec: 4 },
          placement: {
            mode: "overlay",
            rect: { x: 3000, y: -50, w: 2000, h: 900 },
            fit: "contain",
          },
        }],
      },
      review: { frames: [], notes: [] },
    }));
    mkdirSync(join(dir, "materials"), { recursive: true });
    writeFileSync(join(dir, "materials/shot.png"), "fake", "utf8");
    const res = await planEditorAiPatch(dir, parsed);
    assert.deepEqual(res.proposedDocs.overlays.overlays?.[0]?.rect, { x: 0, y: 0, w: 1280, h: 720 });
    assert.deepEqual((res.patch.replace?.overlays?.overlays?.[0] as { rect?: unknown })?.rect, { x: 0, y: 0, w: 1280, h: 720 });
  });
});

test("planEditorAiPatch: AI の注釈と字幕位置を出力範囲へクランプする", async () => {
  await withTmpProjectAsync(async (dir) => {
    const parsed = parseAiPatchResponse(JSON.stringify({
      patch: {
        replace: {
          transcript: {
            language: "ja",
            model: "test",
            segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは", pos: { x: 5000, y: -200 } }],
          },
          overlays: {
            annotations: [{
              id: "ann_aaaaaa",
              type: "arrow",
              start: 1,
              end: 2,
              from: { x: -30, y: 9999 },
              to: { x: 3000, y: -40 },
            }],
          },
        },
      },
      review: { frames: [], notes: [] },
    }));
    const res = await planEditorAiPatch(dir, parsed);
    assert.deepEqual(res.proposedDocs.transcript.segments[0].pos, { x: 1280, y: 0 });
    assert.deepEqual(res.proposedDocs.overlays.annotations?.[0], {
      id: "ann_aaaaaa",
      type: "arrow",
      start: 1,
      end: 2,
      from: { x: 0, y: 720 },
      to: { x: 1280, y: 0 },
    });
  });
});

test("editorAi: 未採用の transcript を AI に書き換えさせない", () => {
  withTmpProject((dir) => {
    writeFileSync(join(dir, "transcript.json"), JSON.stringify({
      generatedBy: "transcribe",
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは" }],
    }, null, 2));
    const parsed = parseAiPatchResponse(JSON.stringify({
      patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "こんにちは世界" }] },
      review: { frames: [], notes: [] },
    }));
    assert.throws(
      () => planEditorAiPatch(dir, parsed),
      (e) =>
        e instanceof EditorAiError &&
        e.status === 400 &&
        /文字起こしをテロップにする/.test(e.message),
    );
  });
});

test("editorAi: 未採用でも transcript を触らない提案(カットだけ)は通る", () => {
  withTmpProject((dir) => {
    writeFileSync(join(dir, "transcript.json"), JSON.stringify({
      generatedBy: "transcribe",
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは" }],
    }, null, 2));
    const parsed = parseAiPatchResponse(JSON.stringify({
      patch: {
        ops: [{ op: "set", target: "@seg_aaaaaa", field: "reason", value: "base updated" }],
      },
      review: { frames: [], notes: [] },
    }));
    assert.doesNotThrow(() => planEditorAiPatch(dir, parsed));
  });
});

test("editorAi: 採用済みなら transcript の編集も通る", () => {
  withTmpProject((dir) => {
    const parsed = parseAiPatchResponse(JSON.stringify({
      patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "こんにちは世界" }] },
      review: { frames: [], notes: [] },
    }));
    const res = planEditorAiPatch(dir, parsed);
    assert.equal(res.proposedDocs.transcript.segments[0].text, "こんにちは世界");
  });
});

test("editorAi: 採用ガードは validate ガードより先に効く", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src/stages/editorAi.ts"), "utf8");
  assert.match(src, /assertCaptionsAdopted\(dir, normalizedApplyPlan\.changedFiles\);\s*\n\s*assertProposalValidates/);
  assert.match(src, /assertCaptionsAdopted\(dir, applyPlan\.changedFiles\);\s*\n\s*assertProposalValidates/);
});

test("buildEditorAiPrompt: 未採用 transcript では transcript 編集禁止を指示する", () => {
  withTmpProject((dir) => {
    writeFileSync(join(dir, "transcript.json"), JSON.stringify({
      generatedBy: "transcribe",
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは" }],
    }, null, 2));
    const prompt = buildEditorAiPrompt(dir, cfg, { instruction: "テロップを直して" });
    assert.match(prompt, /Captions are not enabled yet/);
    assert.match(prompt, /Do NOT edit `transcript`/);
  });
});

test("buildEditorAiPrompt: 採用済み transcript ではプロンプトに採用ガード文を足さない", () => {
  withTmpProject((dir) => {
    const prompt = buildEditorAiPrompt(dir, cfg, { instruction: "テロップを直して" });
    assert.doesNotMatch(prompt, /Captions are not enabled yet/);
  });
});

test("buildEditorAiPrompt: 指示と選択文脈と project projection を含める", () => {
  withTmpProject((dir) => {
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "ja",
        model: "test",
        segments: [
          { id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" },
          { id: "cap_bbbbbb", start: 24, end: 27, text: "遠い字幕です" },
        ],
      }, null, 2),
      "utf8",
    );
    const prompt = buildEditorAiPrompt(dir, cfg, {
      instruction: "この字幕を短く",
      selection: {
        scope: "selection",
        selectedRange: { startSec: 1, endSec: 3 },
        selectedKind: "caption",
        selectedIds: ["cap_aaaaaa"],
        selectedText: "こんにちは",
      },
    });
    assert.match(prompt, /この字幕を短く/);
    assert.match(prompt, /"scope": "selection"/);
    assert.match(prompt, /cap_aaaaaa/);
    assert.doesNotMatch(prompt, /遠い字幕です/);
    assert.match(prompt, /Current project projection/);
    assert.match(prompt, /"required": \[\s*"title",\s*"summary",\s*"edit",\s*"review"\s*\]/s);
    assert.match(prompt, /"op": \{\s*"const": "set"\s*\}/s);
    assert.match(prompt, /All on-screen coordinates must stay inside the visible output frame/);
    assert.match(prompt, /x \+ w <= width/);
  });
});

test("buildEditorAiPrompt: global scope は project-level summary + 全件タイムライン候補を渡す", () => {
  withTmpProject((dir) => {
    const prompt = buildEditorAiPrompt(dir, cfg, {
      instruction: "全体のBGMを調整",
      selection: { scope: "global" },
    });
    assert.match(prompt, /"scope": "global"/);
    assert.match(prompt, /"counts"/);
    assert.match(prompt, /timelineCandidates/);
    // キーワードに依存せず、global scope なら常に全キャプションが候補として渡る
    assert.match(prompt, /こんにちは、ええと、世界/);
  });
});

test("buildEditorAiPrompt: global のタイムライン候補はキーワードに依存せず動画全体をカバーする", () => {
  withTmpProject((dir) => {
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "ja",
        model: "test",
        segments: [
          { id: "cap_aaaaaa", start: 1, end: 3, text: "ここが重要です" },
          { id: "cap_bbbbbb", start: 6, end: 8, text: "次に設定を確認します" },
        ],
      }, null, 2),
      "utf8",
    );
    // 「タイミング/注釈」等のトリガーキーワードを含まない指示でも候補は付く
    const prompt = buildEditorAiPrompt(dir, cfg, {
      instruction: "全体のテンポを整えて",
      selection: { scope: "global" },
    });
    assert.match(prompt, /timelineCandidates/);
    assert.match(prompt, /ここが重要です/);
    assert.match(prompt, /次に設定を確認します/);
    assert.match(prompt, /Do not refuse merely because the user did not provide an exact timecode/);
    assert.match(prompt, /Choose a best-effort timing from the candidates/);
    assert.doesNotMatch(prompt, /Ask for a narrower scope if exact local timing context is needed/);
  });
});

test("buildEditorAiPrompt: annotation request では patch-only ルールを追加できる", () => {
  withTmpProject((dir) => {
    const prompt = buildEditorAiPrompt(
      dir,
      cfg,
      {
        instruction: "注釈を追加して",
        selection: { scope: "selection", selectedKind: "annotation", selectedIds: ["ann_aaaaaa"] },
      },
      { patchOnly: true, patchOnlyReason: "annotation edits must bypass intent compilation" },
    );
    assert.match(prompt, /Patch-only requirement:/);
    assert.match(prompt, /Return `edit\.mode: "patch"` only/);
    assert.match(prompt, /The only valid annotation `type` values are exactly `arrow`, `box`, and `spotlight`\./);
    assert.match(prompt, /Never use aliases or natural-language labels such as `note`/);
    assert.match(prompt, /`box` requires `rect` as `\{x, y, w, h\}` in output pixels\./);
    assert.match(prompt, /Never omit `rect` for `box` or `spotlight`/);
    assert.match(prompt, /Do not use `target: "overlays\.annotations"` for `set` edits to an existing annotation\./);
    assert.match(prompt, /Collection selectors such as `overlays\.overlays`, `overlays\.inserts`, and `overlays\.annotations`/);
  });
});

test("buildRefineEditorAiPrompt: deterministic checks を一次観測として含める", () => {
  const prompt = buildRefineEditorAiPrompt({
    mode: "normal",
    originalInstruction: "字幕を短くする",
    baseDocs: {
      cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
      overlays: {},
      transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "長い字幕です" }] },
      bgm: null,
      shorts: null,
    },
    candidateDocs: {
      cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
      overlays: {},
      transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "短い字幕" }] },
      bgm: null,
      shorts: null,
    },
    applyWarnings: [],
    acceptedHunkLabels: ["transcript segments cap_aaaaaa .text"],
    rejectedHunkLabels: ["overlays annotations ann_aaaaaa .rect.x"],
    priorProposalDiff: [
      {
        label: "transcript segments cap_aaaaaa .text",
        kind: "field",
        current: "長い字幕です",
        proposed: "短い字幕",
      },
      {
        label: "overlays annotations ann_aaaaaa .rect.x",
        kind: "field",
        current: 10,
        proposed: 20,
      },
    ],
    priorProposal: {
      title: "字幕短縮",
      summary: ["字幕を短くする"],
      patch: { ops: [] },
      applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
      proposedDocs: {
        cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
        overlays: {},
        transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "短い字幕" }] },
        bgm: null,
        shorts: null,
      },
      review: { frames: [{ axis: "source", atSec: 1.5, reason: "caption" }], notes: [] },
    },
    reviewBundle: {
      observation: {
        checks: [{ severity: "warn", category: "readability", message: "字幕が長い" }],
        delta: { changedCaptionIds: ["cap_aaaaaa"] },
      },
    },
  });
  assert.match(prompt, /Deterministic checks are the primary observation/);
  assert.match(prompt, /deterministicObservation/);
  assert.match(prompt, /acceptedHunkLabels/);
  assert.match(prompt, /rejectedHunkLabels/);
  assert.match(prompt, /overlays annotations ann_aaaaaa \.rect\.x/);
  assert.match(prompt, /字幕を短くする/);
  assert.match(prompt, /"mode": "normal"/);
});

test("buildRefineEditorAiPrompt: VLM summary を二次観測として含める", () => {
  const prompt = buildRefineEditorAiPrompt({
    mode: "normal",
    originalInstruction: "字幕を短くする",
    additionalInstruction: "画面右下に被らないように",
    baseDocs: {
      cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
      overlays: {},
      transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "長い字幕です" }] },
      bgm: null,
      shorts: null,
    },
    candidateDocs: {
      cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
      overlays: {},
      transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "短い字幕" }] },
      bgm: null,
      shorts: null,
    },
    applyWarnings: [],
    acceptedHunkLabels: ["transcript segments cap_aaaaaa .text"],
    rejectedHunkLabels: [],
    priorProposalDiff: [
      {
        label: "transcript segments cap_aaaaaa .text",
        kind: "field",
        current: "長い字幕です",
        proposed: "短い字幕",
      },
    ],
    priorProposal: {
      title: "字幕短縮",
      summary: ["字幕を短くする"],
      patch: { ops: [] },
      applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
      proposedDocs: {
        cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
        overlays: {},
        transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "短い字幕" }] },
        bgm: null,
        shorts: null,
      },
      review: { frames: [{ axis: "source", atSec: 1.5, reason: "caption" }], notes: [] },
    },
    reviewBundle: {
      observation: {
        checks: [{ severity: "warn", category: "readability", message: "字幕が長い" }],
        delta: { changedCaptionIds: ["cap_aaaaaa"] },
      },
      vlm: {
        summary: ["右下で字幕が素材と競合して見える"],
        observations: [{ frame: 1, severity: "warn", category: "occlusion", message: "右下が混雑" }],
        confidence: "medium",
      },
    },
  });
  assert.match(prompt, /VLM summary is secondary observation only/);
  assert.match(prompt, /secondaryObservation/);
  assert.match(prompt, /右下で字幕が素材と競合して見える/);
});

test("buildRefineEditorAiPrompt: warning-fix 専用ルールと context を含める", () => {
  const prompt = buildRefineEditorAiPrompt({
    mode: "warning-fix",
    originalInstruction: "字幕を短くする",
    additionalInstruction: "検証警告を直す",
    baseDocs: {
      cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
      overlays: {},
      transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "長い字幕です" }] },
      bgm: null,
      shorts: null,
    },
    candidateDocs: {
      cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
      overlays: {},
      transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "短い字幕" }] },
      bgm: null,
      shorts: null,
    },
    applyWarnings: [
      "chapters.json chapters: 概要欄チャプターに対応する画面の章テロップがありません",
      "overlays.json zooms[0]: rect aspect ratio must match output",
    ],
    acceptedHunkLabels: ["transcript segments cap_aaaaaa .text"],
    rejectedHunkLabels: ["overlays annotations ann_aaaaaa .rect.x"],
    priorProposalDiff: [
      {
        label: "transcript segments cap_aaaaaa .text",
        kind: "field",
        current: "長い字幕です",
        proposed: "短い字幕",
      },
      {
        label: "overlays annotations ann_aaaaaa .rect.x",
        kind: "field",
        current: 10,
        proposed: 20,
      },
    ],
    priorProposal: {
      title: "字幕短縮",
      summary: ["字幕を短くする"],
      patch: { ops: [] },
      applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
      proposedDocs: {
        cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
        overlays: {},
        transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "短い字幕" }] },
        bgm: null,
        shorts: null,
      },
      review: { frames: [{ axis: "source", atSec: 1.5, reason: "caption" }], notes: [] },
    },
    reviewBundle: {
      observation: {
        checks: [{ severity: "warn", category: "readability", message: "字幕が長い" }],
        delta: { changedCaptionIds: ["cap_aaaaaa"] },
      },
    },
  });
  assert.match(prompt, /"mode": "warning-fix"/);
  assert.match(prompt, /applyWarnings/);
  assert.match(prompt, /acceptedHunkLabels/);
  assert.match(prompt, /rejectedHunkLabels/);
  assert.match(prompt, /priorProposalDiff/);
  assert.match(prompt, /The only goal is to reduce or resolve applyWarnings/);
  assert.match(prompt, /Do not reintroduce rejectedHunkLabels unless the additional instruction explicitly asks for it/);
  assert.match(prompt, /Do not edit chapters\.json in this implementation\. If chapters\.json should change, leave a review note instead/);
  assert.match(prompt, /Prefer transcript\.json chapter telop edits over chapters\.json edits/);
  assert.match(prompt, /adjust only the affected zoom rect and preserve id\/start\/end/);
  assert.match(prompt, /chapters\.json の編集が必要/);
});

test("buildRefineEditorAiPrompt: patch-only retry ルールを追加できる", () => {
  const prompt = buildRefineEditorAiPrompt({
    mode: "warning-fix",
    originalInstruction: "検証警告を直す",
    baseDocs: {
      cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
      overlays: {},
      transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "長い字幕です" }] },
      bgm: null,
      shorts: null,
    },
    candidateDocs: {
      cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
      overlays: {},
      transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "短い字幕" }] },
      bgm: null,
      shorts: null,
    },
    applyWarnings: ["overlays.json zooms[0]: rect aspect ratio must match output"],
    acceptedHunkLabels: [],
    rejectedHunkLabels: [],
    priorProposalDiff: [],
    priorProposal: {
      title: "warning fix",
      summary: [],
      patch: { ops: [] },
      applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
      proposedDocs: {
        cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
        overlays: {},
        transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "短い字幕" }] },
        bgm: null,
        shorts: null,
      },
      review: { frames: [], notes: [] },
    },
    reviewBundle: {
      observation: { checks: [], delta: {} },
    },
  }, { patchOnly: true, retryReason: "AI 提案を適用できません: (intent) tasks[0]" });
  assert.match(prompt, /Return `edit\.mode: "patch"` only/);
  assert.match(prompt, /Previous failure:/);
});

test("refineEditorAi: warning-fix の intent 失敗時は patch-only で再試行する", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const prompt = body.input ?? "";
      if (calls === 1) {
        assert.doesNotMatch(prompt, /Return `edit\.mode: "patch"` only/);
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              title: "warning fix",
              summary: ["bad tasks"],
              edit: { mode: "tasks", tasks: [{ type: "set-range-action", action: "cut", reason: "bad" }] },
              review: { frames: [], notes: [] },
            }),
          }),
          text: async () => "",
        } as Response;
      }
      assert.match(prompt, /Return `edit\.mode: "patch"` only/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            title: "warning fix",
            summary: ["retry with patch"],
            edit: {
              mode: "patch",
              patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "短い字幕" }] },
            },
            review: { frames: [], notes: [] },
          }),
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      await withTmpProjectAsync(async (dir) => {
        const proposal = await refineEditorAi(
          dir,
          { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
          {
            mode: "warning-fix",
            originalInstruction: "検証警告を直す",
            baseDocs: {
              cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
              overlays: {},
              transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }] },
              bgm: null,
              shorts: null,
            },
            candidateDocs: {
              cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
              overlays: {},
              transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }] },
              bgm: null,
              shorts: null,
            },
            applyWarnings: ["transcript.json segments[0]: 字幕が長い"],
            acceptedHunkLabels: [],
            rejectedHunkLabels: [],
            priorProposalDiff: [],
            priorProposal: {
              title: "warning fix",
              summary: [],
              patch: { ops: [] },
              applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
              proposedDocs: {
                cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
                overlays: {},
                transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }] },
                bgm: null,
                shorts: null,
              },
              review: { frames: [], notes: [] },
            },
            reviewBundle: { observation: { checks: [], delta: {} } },
          },
        );
        assert.equal(proposal.proposedDocs.transcript.segments[0].text, "短い字幕");
      });
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refineEditorAi: annotation の patch target 失敗時も patch-only で再試行する", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const prompt = body.input ?? "";
      if (calls === 1) {
        assert.doesNotMatch(prompt, /Previous failure:/);
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              title: "annotation refine",
              summary: ["bad patch target"],
              edit: {
                mode: "patch",
                patch: { ops: [{ op: "set", target: "overlays.annotations", field: "rect.x", value: 20 }] },
              },
              review: { frames: [], notes: [] },
            }),
          }),
          text: async () => "",
        } as Response;
      }
      assert.match(prompt, /Return `edit\.mode: "patch"` only/);
      assert.match(prompt, /Previous failure:/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            title: "annotation refine",
            summary: ["retry with stable id"],
            edit: {
              mode: "patch",
              patch: { ops: [{ op: "set", target: "@ann_aaaaaa", field: "rect.x", value: 20 }] },
            },
            review: { frames: [], notes: [] },
          }),
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      await withTmpProjectAsync(async (dir) => {
        writeFileSync(
          join(dir, "overlays.json"),
          JSON.stringify({
            annotations: [{ id: "ann_aaaaaa", type: "box", start: 1, end: 3, rect: { x: 10, y: 2, w: 30, h: 40 } }],
          }, null, 2),
          "utf8",
        );
        const proposal = await refineEditorAi(
          dir,
          { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
          {
            mode: "normal",
            originalInstruction: "この注釈を右へ動かす",
            baseDocs: {
              cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
              overlays: {
                annotations: [{ id: "ann_aaaaaa", type: "box", start: 1, end: 3, rect: { x: 10, y: 2, w: 30, h: 40 } }],
              },
              transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }] },
              bgm: null,
              shorts: null,
            },
            candidateDocs: {
              cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
              overlays: {
                annotations: [{ id: "ann_aaaaaa", type: "box", start: 1, end: 3, rect: { x: 10, y: 2, w: 30, h: 40 } }],
              },
              transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }] },
              bgm: null,
              shorts: null,
            },
            applyWarnings: [],
            acceptedHunkLabels: [],
            rejectedHunkLabels: [],
            priorProposalDiff: [],
            priorProposal: {
              title: "annotation refine",
              summary: [],
              patch: { ops: [] },
              applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
              proposedDocs: {
                cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
                overlays: {
                  annotations: [{ id: "ann_aaaaaa", type: "box", start: 1, end: 3, rect: { x: 10, y: 2, w: 30, h: 40 } }],
                },
                transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは、ええと、世界" }] },
                bgm: null,
                shorts: null,
              },
              review: { frames: [], notes: [] },
            },
            reviewBundle: { observation: { checks: [], delta: {} } },
          },
        );
        assert.equal(proposal.proposedDocs.overlays.annotations?.[0]?.rect.x, 20);
      });
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proposeEditorAi: overlays.inserts の collection target 失敗でも patch-only で再試行する", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const prompt = body.input ?? "";
      if (calls === 1) {
        assert.doesNotMatch(prompt, /Patch-only requirement:/);
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              title: "insert refine",
              summary: ["bad patch target"],
              edit: {
                mode: "patch",
                patch: { ops: [{ op: "set", target: "overlays.inserts", field: "durationSec", value: 2 }] },
              },
              review: { frames: [], notes: [] },
            }),
          }),
          text: async () => "",
        } as Response;
      }
      assert.match(prompt, /Patch-only requirement:/);
      assert.match(prompt, /Collection selectors such as `overlays\.overlays`, `overlays\.inserts`, and `overlays\.annotations`/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            title: "caption retry",
            summary: ["retry with stable id"],
            edit: {
              mode: "patch",
              patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "短い字幕" }] },
            },
            review: { frames: [], notes: [] },
          }),
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      await withTmpProjectAsync(async (dir) => {
        const proposal = await proposeEditorAi(
          dir,
          { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
          {
            instruction: "挿入クリップを調整して",
            selection: { scope: "selection", selectedKind: "range" },
          },
        );
        assert.equal(proposal.proposedDocs.transcript.segments[0].text, "短い字幕");
      });
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proposeEditorAi: replace.transcript.segments が配列でない失敗でも再試行して自己修正できる", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const prompt = body.input ?? "";
      if (calls === 1) {
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              title: "全体の字幕を整理",
              summary: ["segments を誤った形で書いた失敗例"],
              edit: {
                mode: "patch",
                patch: {
                  // 壊れた出力を意図的に再現: segments が配列ではなくオブジェクト
                  replace: { transcript: { language: "ja", model: "test", segments: { cap_aaaaaa: "短く" } } },
                },
              },
              review: { frames: [], notes: [] },
            }),
          }),
          text: async () => "",
        } as Response;
      }
      // 2回目は失敗理由がプロンプトへ渡り、正しい形で自己修正できていることを確認
      assert.match(prompt, /Patch-only requirement:/);
      assert.match(prompt, /transcript\.json segments: 配列ではありません/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            title: "全体の字幕を整理(修正版)",
            summary: ["segments を配列のまま維持"],
            edit: {
              mode: "patch",
              patch: { ops: [{ op: "set", target: "@cap_aaaaaa", field: "text", value: "短い字幕" }] },
            },
            review: { frames: [], notes: [] },
          }),
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      await withTmpProjectAsync(async (dir) => {
        const proposal = await proposeEditorAi(
          dir,
          { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
          {
            instruction: "全体の字幕を短く整理して",
            selection: { scope: "global" },
          },
        );
        assert.equal(proposal.proposedDocs.transcript.segments[0].text, "短い字幕");
      });
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proposeEditorAi: annotation request は patch-only を要求し intent 失敗時も再試行する", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const prompt = body.input ?? "";
      assert.match(prompt, /Patch-only requirement:/);
      assert.match(prompt, /Return `edit\.mode: "patch"` only/);
      if (calls === 1) {
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              title: "annotation add",
              summary: ["bad tasks"],
              edit: {
                mode: "tasks",
                tasks: [{ type: "add-annotation", annotation: { rect: { x: 1, y: 2, w: 30, h: 40 } } }],
              },
              review: { frames: [], notes: [] },
            }),
          }),
          text: async () => "",
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            title: "annotation add",
            summary: ["retry with patch"],
            edit: {
              mode: "patch",
              patch: {
                ops: [{
                  op: "add",
                  target: "overlays.annotations",
                  value: { type: "box", start: 1, end: 3, rect: { x: 1, y: 2, w: 30, h: 40 } },
                }],
              },
            },
            review: { frames: [], notes: [] },
          }),
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      await withTmpProjectAsync(async (dir) => {
        const proposal = await proposeEditorAi(
          dir,
          { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
          {
            instruction: "注釈を追加して",
            selection: { scope: "selection", selectedKind: "annotation" },
          },
        );
        assert.equal(proposal.proposedDocs.overlays.annotations?.[0]?.type, "box");
      });
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proposeEditorAi: annotation patch が validate 失敗しても failure reason 付きで再試行する", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const prompt = body.input ?? "";
      assert.match(prompt, /Patch-only requirement:/);
      if (calls === 1) {
        assert.doesNotMatch(prompt, /rect は \{x, y, w, h\}/);
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              title: "annotation add",
              summary: ["missing rect"],
              edit: {
                mode: "patch",
                patch: {
                  ops: [{
                    op: "add",
                    target: "overlays.annotations",
                    value: { type: "box", start: 1, end: 3 },
                  }],
                },
              },
              review: { frames: [], notes: [] },
            }),
          }),
          text: async () => "",
        } as Response;
      }
      assert.match(prompt, /Reason: AI 提案を適用できません:/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            title: "annotation add",
            summary: ["retry with rect"],
            edit: {
              mode: "patch",
              patch: {
                ops: [{
                  op: "add",
                  target: "overlays.annotations",
                  value: { type: "box", start: 1, end: 3, rect: { x: 1, y: 2, w: 30, h: 40 } },
                }],
              },
            },
            review: { frames: [], notes: [] },
          }),
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      await withTmpProjectAsync(async (dir) => {
        const proposal = await proposeEditorAi(
          dir,
          { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
          {
            instruction: "注釈を追加して",
            selection: { scope: "selection", selectedKind: "annotation" },
          },
        );
        assert.deepEqual(proposal.proposedDocs.overlays.annotations?.[0]?.rect, { x: 1, y: 2, w: 30, h: 40 });
      });
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refineEditorAi: zoom rect が出力外なら patch-only で再試行する", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string };
      const prompt = body.input ?? "";
      if (calls === 1) {
        assert.doesNotMatch(prompt, /Previous failure:/);
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              title: "zoom warning fix",
              summary: ["bad zoom rect"],
              edit: {
                mode: "patch",
                patch: {
                  ops: [{
                    op: "set",
                    target: "@zm_aaaaaa",
                    field: "rect",
                    value: { x: 320, y: 90, w: 3200, h: 900 },
                  }],
                },
              },
              review: { frames: [], notes: [] },
            }),
          }),
          text: async () => "",
        } as Response;
      }
      assert.match(prompt, /Return `edit\.mode: "patch"` only/);
      assert.match(prompt, /Previous failure: AI 提案を適用できません: overlays\.json zooms\[0\]: rect/);
      assert.match(prompt, /keep the affected zoom rect inside the output resolution/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            title: "zoom warning fix",
            summary: ["retry with bounded zoom rect"],
            edit: {
              mode: "patch",
              patch: {
                ops: [{
                  op: "set",
                  target: "@zm_aaaaaa",
                  field: "rect",
                  value: { x: 160, y: 90, w: 960, h: 540 },
                }],
              },
            },
            review: { frames: [], notes: [] },
          }),
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      await withTmpProjectAsync(async (dir) => {
        writeFileSync(
          join(dir, "overlays.json"),
          JSON.stringify({
            zooms: [{ id: "zm_aaaaaa", start: 1, end: 3, rect: { x: 0, y: 0, w: 640, h: 360 } }],
          }, null, 2),
          "utf8",
        );
        const proposal = await refineEditorAi(
          dir,
          { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
          {
            mode: "warning-fix",
            originalInstruction: "検証警告を直す",
            baseDocs: {
              cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
              overlays: { zooms: [{ id: "zm_aaaaaa", start: 1, end: 3, rect: { x: 0, y: 0, w: 640, h: 360 } }] },
              transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは" }] },
              bgm: null,
              shorts: null,
            },
            candidateDocs: {
              cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
              overlays: { zooms: [{ id: "zm_aaaaaa", start: 1, end: 3, rect: { x: 0, y: 0, w: 640, h: 360 } }] },
              transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは" }] },
              bgm: null,
              shorts: null,
            },
            applyWarnings: ["overlays.json zooms[0]: rect のアスペクト比が出力とずれています"],
            acceptedHunkLabels: [],
            rejectedHunkLabels: [],
            priorProposalDiff: [],
            priorProposal: {
              title: "zoom warning fix",
              summary: [],
              patch: { ops: [] },
              applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
              proposedDocs: {
                cutplan: { approved: false, segments: [{ id: "seg_aaaaaa", start: 0, end: 10, action: "keep", reason: "base" }] },
                overlays: { zooms: [{ id: "zm_aaaaaa", start: 1, end: 3, rect: { x: 0, y: 0, w: 640, h: 360 } }] },
                transcript: { language: "ja", model: "test", segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "こんにちは" }] },
                bgm: null,
                shorts: null,
              },
              review: { frames: [], notes: [] },
            },
            reviewBundle: { observation: { checks: [], delta: {} } },
          },
        );
        assert.deepEqual(proposal.proposedDocs.overlays.zooms?.[0]?.rect, { x: 160, y: 90, w: 960, h: 540 });
      });
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeWithJsonSchema: openai provider は text.format=json_schema を送る", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let body: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ ok: true }) }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ OPENAI_API_KEY: "test-openai" }, async () => {
      const res = await completeWithJsonSchema(
        "hello",
        { ...cfg, ai: { provider: "openai", model: "gpt-x" } } as Config,
        { name: "test_schema", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      );
      assert.equal(res, '{"ok":true}');
    });
    const req = body as { text?: { format?: { type?: string; name?: string; strict?: boolean; schema?: { properties?: Record<string, unknown> } } } };
    assert.equal(req.text?.format?.type, "json_schema");
    assert.equal(req.text?.format?.name, "test_schema");
    assert.equal(req.text?.format?.strict, true);
    assert.ok("ok" in (req.text?.format?.schema?.properties ?? {}));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openAiCompatibleSchema: oneOfを再帰的にanyOfへ変換する", () => {
  const converted = openAiCompatibleSchema({
    type: "object",
    properties: {
      edit: {
        oneOf: [
          { type: "object", properties: { mode: { const: "tasks" } } },
          { type: "object", properties: { mode: { const: "patch" } } },
        ],
      },
    },
  });
  const json = JSON.stringify(converted);
  assert.doesNotMatch(json, /"oneOf"/);
  assert.match(json, /"anyOf"/);
});

test("completeWithJsonSchema: anthropic provider は tool schema を送る", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let body: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: "tool_use",
              input: { ok: true },
            },
          ],
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
    await withEnv({ ANTHROPIC_API_KEY: "test-anthropic" }, async () => {
      const res = await completeWithJsonSchema(
        "hello",
        { ...cfg, ai: { provider: "anthropic", model: "claude-x" } } as Config,
        { name: "test_schema", schema: { type: "object" } },
      );
      assert.equal(res, '{"ok":true}');
    });
    const req = body as {
      tools?: { name?: string; input_schema?: { type?: string } }[];
      tool_choice?: { type?: string; name?: string };
    };
    assert.equal(req.tools?.[0]?.name, "structured_output");
    assert.equal(req.tools?.[0]?.input_schema?.type, "object");
    assert.equal(req.tool_choice?.type, "tool");
    assert.equal(req.tool_choice?.name, "structured_output");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeWithJsonSchema: claude-code provider は --json-schema を付ける", async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-claude-code-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const argsFile = join(dir, "args.txt");
  const script = join(binDir, "claude");
  writeFileSync(
    script,
    `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
cat >/dev/null
printf '%s' '{"ok":true}'
`,
    "utf8",
  );
  chmodSync(script, 0o755);
  const originalPath = process.env.PATH ?? "";
  try {
    process.env.PATH = `${binDir}:${originalPath}`;
    const res = await completeWithJsonSchema(
      "hello",
      { ...cfg, ai: { provider: "claude-code", model: "sonnet" } } as Config,
      { name: "test_schema", schema: { type: "object" } },
    );
    assert.equal(res, '{"ok":true}');
    const got = readFileSync(argsFile, "utf8");
    assert.match(got, /--json-schema/);
    assert.match(got, /--output-format/);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AI 提案の cutplan 正規化(keep の時系列順) ---
// plan を通していない bootstrap の「全編 keep」から AI にカットさせると、
// cutplan.segments の配列順が崩れて保存時の validate
//(「keep 区間が時系列順ではありません」)で弾かれることがあった。
// 正規化は normalizeAiApplyBody(提案の唯一の合流点)で行う。

test("normalizeCutplanDoc: 順序が崩れた segments を start 昇順へ直す", () => {
  const cutplan = {
    approved: false,
    segments: [
      { action: "keep", start: 8.2, end: 12.0 },
      { action: "keep", start: 7.7, end: 8.2 },
      { action: "cut", start: 0, end: 7.7, reason: "冗長" },
    ],
  } as unknown as CutPlan;
  const out = normalizeCutplanDoc(cutplan);
  assert.deepEqual(out.segments.map((s) => s.start), [0, 7.7, 8.2]);
  // 並べ替え以外は変えない
  assert.equal(out.approved, false);
  assert.equal(out.segments.length, 3);
});

test("normalizeCutplanDoc: 既に昇順なら同一参照を返す(バイト等価)", () => {
  const cutplan = {
    approved: false,
    segments: [
      { action: "cut", start: 0, end: 7.7, reason: "冗長" },
      { action: "keep", start: 7.7, end: 12.0 },
    ],
  } as unknown as CutPlan;
  assert.equal(normalizeCutplanDoc(cutplan), cutplan);
});

test("normalizeCutplanDoc: 同じ start は元の相対順を保つ(安定ソート)", () => {
  const cutplan = {
    approved: false,
    segments: [
      { action: "keep", start: 5, end: 6, reason: "b" },
      { action: "keep", start: 1, end: 2, reason: "a" },
      { action: "cut", start: 5, end: 5, reason: "c" },
    ],
  } as unknown as CutPlan;
  const out = normalizeCutplanDoc(cutplan);
  assert.deepEqual(out.segments.map((s) => s.reason), ["a", "b", "c"]);
});

test("editorAi: 提案の cutplan は normalizeAiApplyBody で正規化される", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src/stages/editorAi.ts"),
    "utf8",
  );
  assert.match(
    src,
    /function normalizeAiApplyBody[\s\S]*?body\.cutplan \? \{ cutplan: normalizeCutplanDoc\(body\.cutplan\) \}/,
  );
  // 提案は保存を待たずにこの場で検査する(差分レビューまで進んでから
  // 保存で弾かれるのを防ぐ)
  assert.match(src, /assertProposalValidates\(dir, mergedDocs, normalizedApplyPlan\.changedFiles\)/);
  assert.match(src, /assertProposalValidates\(dir, mergedDocs, applyPlan\.changedFiles\)/);
});

test("applyProposalResolution: hunk マージの出口で cutplan の時系列順を直す", () => {
  // 提案側(proposedDocs)が昇順でも、採用/不採用の組み合わせで base 側の
  // 要素と混ざると配列順が逆転しうる。保存時の validate で弾かれるので
  // マージの出口で必ず正規化する
  const src = readFileSync(
    join(import.meta.dirname, "..", "src/lib/docDiff.ts"),
    "utf8",
  );
  assert.match(
    src,
    /restoreApprovalsFrom\(base, merged\);[\s\S]*?merged\.cutplan = normalizeCutplanSegments\(merged\.cutplan\)/,
  );
});
