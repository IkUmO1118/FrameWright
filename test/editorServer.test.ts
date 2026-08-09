// editor/server.ts — GUI 保存(saveProject)の id 採番ロジック(stampSaveBody)。
// サーバー本体(HTTP・esbuild バンドル)は起動せず、export された純関数だけを
// 固定する(実 UI の round-trip は人間の GUI 実測に委ねる。MEMORY: エディタの
// コードはサーバー再起動まで反映されない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analysisStatus,
  buildAiReviewCandidateFromStoredProposal,
  buildHyperframeCards,
  loadProject,
  loadScript,
  saveBaseUpload,
  saveUpload,
  selectBaseMedia,
  refineRequestKey,
  stampSaveBody,
  validateRefineRequest,
  validateHyperframeRenderRequest,
  validateReviewRequest,
  jobStartDecision,
  saveHeavyJobDecision,
} from "../editor/server.ts";
import { ID_RE } from "../src/lib/ids.ts";
import type { AiProfileStatus, Config } from "../src/lib/config.ts";
import type { AiRefineRequest, AiReviewRequest, SaveRequest } from "../editor/client/apiTypes.ts";
import { parseComposition, SAMPLE_HTML } from "../src/lib/hyperframe.ts";
import {
  hyperframeCacheKey,
  HYPERFRAME_RENDERER_GENERATION,
  resolveHyperframeBuild,
} from "../src/stages/hyperframe.ts";
import {
  hyperframeAuthorConflict,
  hyperframeAuthorReadiness,
  validateHyperframeAuthorRequest,
} from "../src/lib/hyperframeAuthor.ts";

test("saveHeavyJobDecision: review だけ中止して保存を通す", () => {
  assert.equal(saveHeavyJobDecision(null), "allow");
  assert.equal(saveHeavyJobDecision("review"), "cancel");
  for (const stage of [
    "preview",
    "render",
    "propose",
    "hyperframe-render",
    "hyperframe-author",
  ] as const) {
    assert.equal(saveHeavyJobDecision(stage), "reject", stage);
  }
});

test("jobStartDecision: 何も走っていなければ開始する", () => {
  assert.equal(jobStartDecision(null, "render"), "start");
  assert.equal(jobStartDecision(null, "preview"), "start");
});

test("jobStartDecision: 同種のジョブが走っていれば同じ job を返す", () => {
  assert.equal(jobStartDecision({ stage: "render", kind: "render" }, "render"), "same");
  assert.equal(jobStartDecision({ stage: "preview", kind: "preview" }, "preview"), "same");
});

test("jobStartDecision: 別種の書き出しは 409", () => {
  assert.equal(jobStartDecision({ stage: "preview", kind: "preview" }, "render"), "conflict");
  assert.equal(jobStartDecision({ stage: "render", kind: "render" }, "preview"), "conflict");
});

test("jobStartDecision: 書き出し以外の重いジョブ中も 409", () => {
  for (const stage of [
    "propose",
    "review",
    "hyperframe-render",
    "hyperframe-author",
  ] as const) {
    assert.equal(jobStartDecision({ stage, kind: null }, "render"), "conflict", stage);
    assert.equal(jobStartDecision({ stage, kind: null }, "preview"), "conflict", stage);
  }
});

test("analysisStatus: bootstrap の transcript だけを解析対象にする", () => {
  const dir = mkdtempSync(join(tmpdir(), "fw-analyze-"));
  const cfg = { whisper: { model: join(dir, "model.bin") } } as unknown as Config;
  writeFileSync(join(dir, "model.bin"), "x");

  assert.deepEqual(analysisStatus(dir, cfg), { needed: false, blocked: null });

  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ durationSec: 10 }));
  writeFileSync(join(dir, "transcript.json"), JSON.stringify({ generatedBy: "bootstrap", segments: [] }));
  assert.equal(analysisStatus(dir, cfg).needed, true);

  writeFileSync(join(dir, "transcript.json"), JSON.stringify({ language: "ja", model: "m", segments: [] }));
  assert.equal(analysisStatus(dir, cfg).needed, false);

  rmSync(dir, { recursive: true, force: true });
});

test("analysisStatus: whisper モデルが無ければ needed=false で理由を返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "fw-analyze-"));
  const cfg = { whisper: { model: join(dir, "missing.bin") } } as unknown as Config;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ durationSec: 10 }));
  writeFileSync(join(dir, "transcript.json"), JSON.stringify({ generatedBy: "bootstrap", segments: [] }));
  const status = analysisStatus(dir, cfg);
  assert.equal(status.needed, false);
  assert.match(status.blocked ?? "", /文字起こしモデルが見つかりません/);
  rmSync(dir, { recursive: true, force: true });
});

const authorProfile = (overrides: Partial<AiProfileStatus> = {}): AiProfileStatus => ({
  name: "local",
  adapter: "claude-code",
  model: "auto",
  origin: null,
  credential: "not-required",
  capabilities: {
    textInput: true,
    textOutput: true,
    structuredOutput: "native-json-schema",
    imageInput: false,
    maxImages: 0,
  },
  ...overrides,
});

function p2Cfg(editor?: Config["editor"]): Config {
  return {
    recordingsDir: "/tmp",
    ingest: {
      screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
      micTrack: 1,
      systemTrack: 2,
    },
    whisper: { bin: "whisper-cli", model: "model.bin", language: "ja" },
    detect: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.4 },
    plan: { targetMinutes: 10 },
    preview: { width: 1280 },
    render: {} as Config["render"],
    editor,
  };
}

function tinyWav(): Buffer {
  const samples = 1600;
  const dataBytes = samples * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0); out.writeUInt32LE(36 + dataBytes, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  return out;
}

function uploadRequest(bytes: Buffer, declared = bytes.length): IncomingMessage {
  return Object.assign(Readable.from([bytes]), {
    headers: { "content-length": String(declared) },
  }) as unknown as IncomingMessage;
}

test("validateHyperframeAuthorRequest: {name,brief,assets?} だけを厳格に受理する", () => {
  assert.deepEqual(validateHyperframeAuthorRequest({ name: "ending-card.v2", brief: "締めカード" }), []);
  assert.deepEqual(validateHyperframeAuthorRequest({
    name: "ending-card.v2",
    brief: "ロゴ入り",
    assets: [
      { name: "logo.png", data: "YWJjZA==" },
      { name: "subset.woff2", data: "d09GMg==" },
    ],
  }), []);
  assert.match(validateHyperframeAuthorRequest({ name: "../x", brief: "x" }).join(" / "), /ファイル名は英数字/);
  assert.match(validateHyperframeAuthorRequest({ name: "x", brief: "  " }).join(" / "), /作りたい内容/);
  assert.match(validateHyperframeAuthorRequest({ name: "x", brief: "x", force: true }).join(" / "), /指定できない項目/);
  assert.match(validateHyperframeAuthorRequest(null).join(" / "), /形式が正しくありません/);
  assert.match(validateHyperframeAuthorRequest({
    name: "x",
    brief: "x",
    assets: [{ name: "logo.png", data: "not base64" }],
  }).join(" / "), /データが正しくありません/);
});

test("hyperframeAuthorConflict: HTML / MP4 / sidecar のどれか1つでも同名なら conflict", () => {
  const base = { name: "card", htmlNames: [] as string[], mp4Names: [] as string[], sidecarNames: [] as string[] };
  assert.equal(hyperframeAuthorConflict(base), false);
  assert.equal(hyperframeAuthorConflict({ ...base, htmlNames: ["card"] }), true);
  assert.equal(hyperframeAuthorConflict({ ...base, mp4Names: ["card"] }), true);
  assert.equal(hyperframeAuthorConflict({ ...base, sidecarNames: ["card"] }), true);
  assert.equal(hyperframeAuthorConflict({ ...base, htmlNames: ["other"] }), false);
});

test("hyperframeAuthorReadiness: structured route/profile/capability/credential をUI gateにする", () => {
  assert.deepEqual(
    hyperframeAuthorReadiness({ structuredRoute: "local", profiles: [authorProfile()] }),
    { ready: true },
  );
  assert.match(
    hyperframeAuthorReadiness({ structuredRoute: "missing", profiles: [authorProfile()] }).disabledReason ?? "",
    /設定が見つかりません/,
  );
  assert.match(
    hyperframeAuthorReadiness({
      structuredRoute: "local",
      profiles: [authorProfile({
        capabilities: { ...authorProfile().capabilities, structuredOutput: "none" },
      })],
    }).disabledReason ?? "",
    /素材の生成に対応していません/,
  );
  assert.match(
    hyperframeAuthorReadiness({
      structuredRoute: "local",
      profiles: [authorProfile({ credential: "missing" })],
    }).disabledReason ?? "",
    /認証情報/,
  );
});

function freshHyperframeSidecar(html = SAMPLE_HTML): string {
  const parsed = parseComposition(html);
  const build = resolveHyperframeBuild({ parsed, cliVars: {} });
  assert.equal(build.ok, true);
  if (!build.ok) throw new Error(build.error);
  return JSON.stringify({
    key: hyperframeCacheKey({
      rendererGeneration: HYPERFRAME_RENDERER_GENERATION,
      htmlSha256: createHash("sha256").update(html).digest("hex"),
      variables: build.variables,
      width: build.width,
      height: build.height,
      fps: build.fps,
      durationSec: build.durationSec,
      codec: "h264",
      hardwareAcceleration: "none",
      profile: "default",
    }),
    width: build.width,
    height: build.height,
    durationSec: build.durationSec,
  });
}

test("buildHyperframeCards: HTML / MP4 の和集合を name 順に返す", () => {
  const cards = buildHyperframeCards({
    htmlByName: { source: SAMPLE_HTML, both: SAMPLE_HTML },
    mp4Names: ["rendered", "both"],
    sidecarByName: { both: freshHyperframeSidecar() },
  });
  assert.deepEqual(cards.map((card) => card.name), ["both", "rendered", "source"]);
  assert.deepEqual(
    cards.map((card) => [card.htmlExists, card.rendered]),
    [[true, true], [false, true], [true, false]],
  );
  assert.equal(cards[1].mp4Path, "materials/hyperframes/rendered.mp4");
});

test("buildHyperframeCards: 現 HTML と sidecar key が一致すれば fresh", () => {
  const [card] = buildHyperframeCards({
    htmlByName: { card: SAMPLE_HTML },
    mp4Names: ["card"],
    sidecarByName: { card: freshHyperframeSidecar() },
  });
  assert.equal(card.stale, false);
  assert.equal(card.error, undefined);
  assert.ok((card.durationSec ?? 0) > 0);
  assert.ok((card.width ?? 0) > 0);
  assert.ok((card.height ?? 0) > 0);
});

test("buildHyperframeCards: HTML drift は stale", () => {
  const changed = SAMPLE_HTML.replace('"default":"FrameWright"', '"default":"Changed"');
  const [card] = buildHyperframeCards({
    htmlByName: { card: changed },
    mp4Names: ["card"],
    sidecarByName: { card: freshHyperframeSidecar(SAMPLE_HTML) },
  });
  assert.equal(card.stale, true);
});

test("buildHyperframeCards: 壊れた sidecar はそのカードだけ error + stale", () => {
  const cards = buildHyperframeCards({
    htmlByName: { broken: SAMPLE_HTML, good: SAMPLE_HTML },
    mp4Names: ["broken", "good"],
    sidecarByName: { broken: "{not-json", good: freshHyperframeSidecar() },
  });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, "broken");
  assert.equal(cards[0].stale, true);
  assert.match(cards[0].error ?? "", /生成情報が壊れています/);
  assert.equal(cards[1].stale, false);
});

test("buildHyperframeCards: sidecar 不在のときは stale のみで error は立てない", () => {
  const [card] = buildHyperframeCards({
    htmlByName: { card: SAMPLE_HTML },
    mp4Names: ["card"],
  });
  assert.equal(card.stale, true);
  assert.equal(card.error, undefined);
});

test("buildHyperframeCards: sidecar の key が非文字列のときは error を立てる", () => {
  const [card] = buildHyperframeCards({
    htmlByName: { card: SAMPLE_HTML },
    mp4Names: ["card"],
    sidecarByName: { card: JSON.stringify({ key: 123 }) },
  });
  assert.equal(card.stale, true);
  assert.match(card.error ?? "", /生成情報が不正です/);
});

test("buildHyperframeCards: key が期待値と不一致のときは stale のみで error は立てない", () => {
  const changed = SAMPLE_HTML.replace('"default":"FrameWright"', '"default":"Changed"');
  const [card] = buildHyperframeCards({
    htmlByName: { card: changed },
    mp4Names: ["card"],
    sidecarByName: { card: freshHyperframeSidecar(SAMPLE_HTML) },
  });
  assert.equal(card.stale, true);
  assert.equal(card.error, undefined);
});

test("validateHyperframeRenderRequest: name だけを厳格に受理する", () => {
  assert.deepEqual(validateHyperframeRenderRequest({ name: "ending-card.v2" }), []);
  assert.match(validateHyperframeRenderRequest({ name: "../escape" }).join(" / "), /英数字/);
  assert.match(validateHyperframeRenderRequest({ name: "card", force: true }).join(" / "), /name だけ/);
  assert.match(validateHyperframeRenderRequest({ name: 1 }).join(" / "), /英数字/);
  assert.match(validateHyperframeRenderRequest(null).join(" / "), /JSON object/);
});

test("stampSaveBody: idEnabled=false は body をそのまま返す(参照も同一・バイト等価)", () => {
  const body: SaveRequest = {
    cutplan: { approved: false, segments: [{ start: 0, end: 1, action: "keep", reason: "" }] },
  };
  const out = stampSaveBody(body, false, new Set());
  assert.equal(out, body);
});

test("stampSaveBody: idEnabled=true で新規要素(id 無し)に採番する", () => {
  const body: SaveRequest = {
    cutplan: {
      approved: false,
      segments: [
        { id: "seg_aaaaaa", start: 0, end: 1, action: "keep", reason: "" },
        { start: 1, end: 2, action: "keep", reason: "" },
      ],
    },
  };
  const used = new Set<string>(["seg_aaaaaa"]);
  const out = stampSaveBody(body, true, used);
  assert.equal(out.cutplan!.segments[0].id, "seg_aaaaaa");
  assert.match(out.cutplan!.segments[1].id as string, ID_RE);
});

test("stampSaveBody: idEnabled=true でも既存 id は保持する(round-trip)", () => {
  const body: SaveRequest = {
    transcript: {
      segments: [{ id: "cap_bbbbbb", start: 0, end: 1, text: "hi" }],
    },
  };
  const used = new Set<string>(["cap_bbbbbb"]);
  const out = stampSaveBody(body, true, used);
  assert.equal(out.transcript!.segments[0].id, "cap_bbbbbb");
});

test("stampSaveBody: overlays の全「指せる配列」に採番する", () => {
  const body: SaveRequest = {
    overlays: {
      overlays: [{ start: 0, end: 1, file: "a.png" }],
      inserts: [{ at: 1, file: "b.mp4", durationSec: 2 }],
      wipeFull: [{ start: 0, end: 1 }],
      hideCaption: [{ start: 0, end: 1 }],
      zooms: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      blurs: [{ start: 0, end: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      captionTracks: [{ track: 1 }],
    },
  };
  const out = stampSaveBody(body, true, new Set());
  assert.match(out.overlays!.overlays![0].id as string, ID_RE);
  assert.match(out.overlays!.inserts![0].id as string, ID_RE);
  assert.match(out.overlays!.wipeFull![0].id as string, ID_RE);
  assert.match(out.overlays!.hideCaption![0].id as string, ID_RE);
  assert.match(out.overlays!.zooms![0].id as string, ID_RE);
  assert.match(out.overlays!.blurs![0].id as string, ID_RE);
  assert.match(out.overlays!.captionTracks![0].id as string, ID_RE);
});

test("stampSaveBody: body に無いドキュメントは undefined のまま(触らない)", () => {
  const body: SaveRequest = {};
  const out = stampSaveBody(body, true, new Set());
  assert.equal(out.cutplan, undefined);
  assert.equal(out.overlays, undefined);
  assert.equal(out.transcript, undefined);
  assert.equal(out.bgm, undefined);
  assert.equal(out.shorts, undefined);
});

test("loadProject: /api/project 相当の payload に planPerception を含む", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-editor-project-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
  try {
    write("manifest.json", {
      dir,
      source: "raw.mkv",
      durationSec: 12,
      layout: "plain",
      video: {
        width: 1920,
        height: 1080,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-08T00:00:00Z",
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ start: 0, end: 1, text: "hello" }],
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ start: 0, end: 12, action: "keep", reason: "" }],
    });
    const project = loadProject(dir, {
      render: {} as Config["render"],
      preview: { width: 1280 },
      plan: { perception: { audio: true, ocr: true, systemSpeech: false } },
    } as Config);
    assert.equal(project.state, "ready");
    if (project.state !== "ready") throw new Error("ready expected");
    assert.deepEqual(project.planPerception, {
      explicit: true,
      audio: true,
      ocr: true,
      ocrMaxSegments: 40,
      ocrMaxLines: 6,
      systemSpeech: false,
      warnings: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProject: manifest が無いフォルダは empty 状態と候補を返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-editor-empty-"));
  try {
    writeFileSync(join(dir, "a.mp4"), "x");
    const project = loadProject(dir, { render: {}, preview: { width: 1280 } } as Config);
    assert.deepEqual(project, {
      state: "empty",
      dir,
      candidates: [{ file: "a.mp4", kind: "video", current: false }],
      dirFiles: ["a.mp4"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectBaseMedia: 候補外/パストラバーサルを拒否し、既存 manifest は409", async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-base-media-reject-"));
  try {
    writeFileSync(join(dir, "base.wav"), tinyWav());
    await assert.rejects(
      () => selectBaseMedia(dir, p2Cfg(), { file: "../base.wav", canvas: "landscape" }),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
    writeFileSync(join(dir, "manifest.json"), "{}");
    await assert.rejects(
      () => selectBaseMedia(dir, p2Cfg(), { file: "base.wav", canvas: "landscape" }),
      (error: unknown) => (error as { status?: number }).status === 409,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectBaseMedia: 成功時に manifest/transcript/cutplan を揃えて ready を返す", async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-base-media-ready-"));
  try {
    writeFileSync(join(dir, "voice.wav"), tinyWav());
    const project = await selectBaseMedia(dir, p2Cfg(), { file: "voice.wav", canvas: "square" });
    assert.equal(project.state, "ready");
    assert.equal(project.manifest.source, "voice.wav");
    assert.equal(project.manifest.canvas, "square");
    for (const file of ["manifest.json", "transcript.json", "cutplan.json"]) {
      assert.equal(existsSync(join(dir, file)), true, file);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upload helpers: base は直下、通常素材は materials/ へバイト等価で保存する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-upload-dest-"));
  const baseBytes = tinyWav();
  const materialBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  try {
    const base = await saveBaseUpload(dir, "voice.wav", uploadRequest(baseBytes), p2Cfg());
    const material = await saveUpload(dir, "image.png", uploadRequest(materialBytes), p2Cfg());
    assert.equal(base.file, "voice.wav");
    assert.equal(material.file, "materials/image.png");
    assert.deepEqual(readFileSync(join(dir, base.file)), baseBytes);
    assert.deepEqual(readFileSync(join(dir, material.file)), materialBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveBaseUpload: maxBaseUploadMb の Content-Length 上限を413で拒否する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-base-upload-limit-"));
  try {
    await assert.rejects(
      () => saveBaseUpload(dir, "large.mp4", uploadRequest(Buffer.alloc(0), 1024 * 1024 + 1), p2Cfg({ maxBaseUploadMb: 1 })),
      (error: unknown) => (error as { status?: number }).status === 413,
    );
    assert.equal(existsSync(join(dir, "large.mp4")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAiReviewCandidateFromStoredProposal: acceptedHunkLabels から candidate を再構築し approved は base を保つ", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-editor-review-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
  try {
    write("manifest.json", {
      dir,
      source: "raw.mp4",
      durationSec: 12,
      layout: "plain",
      video: {
        width: 1280,
        height: 720,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1280, h: 720 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-09T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "base" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
    });
    write("overlays.json", {});
    const candidate = buildAiReviewCandidateFromStoredProposal(dir, {
      baseDocs: {
        cutplan: {
          approved: false,
          segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "base" }],
        },
        overlays: {},
        transcript: {
          language: "ja",
          model: "test",
          segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
        },
        bgm: null,
        shorts: null,
      },
      proposal: {
        title: "title",
        summary: [],
        patch: { ops: [] },
        applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
        proposedDocs: {
          cutplan: {
            approved: true,
            segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "proposal" }],
          },
          overlays: {},
          transcript: {
            language: "ja",
            model: "test",
            segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
          },
          bgm: null,
          shorts: null,
        },
        review: { frames: [{ axis: "source", atSec: 1, reason: "caption" }], notes: [] },
      },
    }, ["cutplan segments seg_aaaaaa .reason"]);
    assert.equal(candidate.cutplan.approved, false);
    assert.equal(candidate.cutplan.segments[0].reason, "proposal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateReviewRequest: proposalId / acceptedHunkLabels / secondaryObservation 以外を拒否し、重複も弾く", () => {
  const extra = validateReviewRequest({
    proposalId: "p1",
    acceptedHunkLabels: [],
    extra: true,
  } as unknown as AiReviewRequest);
  assert.match(extra.join(" / "), /proposalId \/ acceptedHunkLabels \/ secondaryObservation だけ/);

  const badSecondary = validateReviewRequest({
    proposalId: "p1",
    acceptedHunkLabels: [],
    secondaryObservation: "yes",
  } as unknown as AiReviewRequest);
  assert.match(badSecondary.join(" / "), /secondaryObservation は none \/ vlm/);

  const dup = validateReviewRequest({
    proposalId: "p1",
    acceptedHunkLabels: ["a", "a"],
  });
  assert.match(dup.join(" / "), /重複/);
});

test("validateRefineRequest: proposalId 必須、unknown key 拒否、重複拒否", () => {
  const missing = validateRefineRequest({
    acceptedHunkLabels: [],
  } as unknown as AiRefineRequest);
  assert.match(missing.join(" / "), /proposalId は空でない文字列/);

  const extra = validateRefineRequest({
    proposalId: "p1",
    acceptedHunkLabels: [],
    instruction: "字幕を短く",
    extra: true,
  } as unknown as AiRefineRequest);
  assert.match(extra.join(" / "), /proposalId \/ acceptedHunkLabels \/ instruction \/ vlm \/ mode だけ/);

  const dup = validateRefineRequest({
    proposalId: "p1",
    acceptedHunkLabels: ["a", "a"],
  });
  assert.match(dup.join(" / "), /重複/);

  const invalidMode = validateRefineRequest({
    proposalId: "p1",
    acceptedHunkLabels: [],
    mode: "unexpected",
  } as unknown as AiRefineRequest);
  assert.match(invalidMode.join(" / "), /mode は normal \/ warning-fix/);
});

test("refineRequestKey: mode を含み、省略時は normal 扱い", () => {
  const record = {
    proposalId: "p1",
  } as Parameters<typeof refineRequestKey>[0];
  const normal = refineRequestKey(record, {
    proposalId: "ignored",
    acceptedHunkLabels: ["b", "a"],
    instruction: "  字幕を短く  ",
  });
  const warningFix = refineRequestKey(record, {
    proposalId: "ignored",
    acceptedHunkLabels: ["a", "b"],
    instruction: "字幕を短く",
    mode: "warning-fix",
  });
  const explicitNormal = refineRequestKey(record, {
    proposalId: "ignored",
    acceptedHunkLabels: ["a", "b"],
    instruction: "字幕を短く",
    mode: "normal",
  });
  assert.equal(normal, explicitNormal);
  assert.notEqual(normal, warningFix);
  assert.match(warningFix, /"mode":"warning-fix"/);
});

test("buildAiReviewCandidateFromStoredProposal: unknown hunk labels は 400", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-editor-review-"));
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
  try {
    write("manifest.json", {
      dir,
      source: "raw.mp4",
      durationSec: 12,
      layout: "plain",
      video: {
        width: 1280,
        height: 720,
        fps: 30,
        screenRegion: { x: 0, y: 0, w: 1280, h: 720 },
      },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-09T00:00:00Z",
    });
    write("cutplan.json", {
      approved: false,
      segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "base" }],
    });
    write("transcript.json", {
      language: "ja",
      model: "test",
      segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
    });
    write("overlays.json", {});
    assert.throws(
      () =>
        buildAiReviewCandidateFromStoredProposal(dir, {
          baseDocs: {
            cutplan: {
              approved: false,
              segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "base" }],
            },
            overlays: {},
            transcript: {
              language: "ja",
              model: "test",
              segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
            },
            bgm: null,
            shorts: null,
          },
          proposal: {
            title: "title",
            summary: [],
            patch: { ops: [] },
            applyPlan: { body: {}, changedFiles: [], diff: [], warnings: [], errors: [] },
            proposedDocs: {
              cutplan: {
                approved: false,
                segments: [{ id: "seg_aaaaaa", start: 0, end: 12, action: "keep", reason: "proposal" }],
              },
              overlays: {},
              transcript: {
                language: "ja",
                model: "test",
                segments: [{ id: "cap_aaaaaa", start: 1, end: 3, text: "hello" }],
              },
              bgm: null,
              shorts: null,
            },
            review: { frames: [{ axis: "source", atSec: 1, reason: "caption" }], notes: [] },
          },
        }, ["missing-label"]),
      /unknown hunk labels/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- loadScript(スクリプトタブの元データ) ---------------- */

test("loadScript: whisper-out.json から ms→秒・trim・words(特殊トークン除外)を組み立てる", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-script-"));
  try {
    writeFileSync(
      join(dir, "whisper-out.json"),
      JSON.stringify({
        transcription: [
          {
            offsets: { from: 0, to: 6480 },
            text: " 動画編集って ",
            tokens: [
              { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
              { text: "動画", offsets: { from: 0, to: 720 }, p: 0.99 },
              { text: "編集", offsets: { from: 720, to: 1440 } },
              { text: "って", offsets: { from: 1440, to: 2160 } },
            ],
          },
          // 空文(trim 後空)は segments から除外される
          { offsets: { from: 6480, to: 7000 }, text: "   " },
        ],
      }),
    );
    const s = loadScript(dir);
    assert.equal(s.source, "whisper");
    assert.equal(s.segments.length, 1);
    assert.equal(s.segments[0].start, 0);
    assert.equal(s.segments[0].end, 6.48);
    assert.equal(s.segments[0].text, "動画編集って");
    assert.deepEqual(
      s.segments[0].words?.map((w) => [w.text, w.start, w.end]),
      [
        ["動画", 0, 0.72],
        ["編集", 0.72, 1.44],
        ["って", 1.44, 2.16],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadScript: whisper-out.json が無ければ transcript.json から代替する(source で区別)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-script-"));
  try {
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "ja",
        model: "m",
        segments: [
          {
            start: 1,
            end: 2,
            text: "こんにちは",
            track: 2,
            words: [{ text: "こんにちは", start: 1, end: 2 }],
          },
          { start: 2, end: 3, text: "世界" },
        ],
      }),
    );
    const s = loadScript(dir);
    assert.equal(s.source, "transcript");
    assert.deepEqual(
      s.segments.map((x) => [x.start, x.end, x.text, x.words?.length ?? 0]),
      [
        [1, 2, "こんにちは", 1],
        [2, 3, "世界", 0],
      ],
    );
    // words の無い文は words キー自体を持たない(表示側が文単位選択へ落とす)
    assert.equal("words" in s.segments[1], false);
    // transcript のテロップ用フィールド(track 等)は持ち込まない
    assert.equal("track" in (s.segments[0] as Record<string, unknown>), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadScript: どちらも無ければ空(エラーにしない)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-script-"));
  try {
    assert.deepEqual(loadScript(dir), { source: "transcript", segments: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadScript: t_dtw 付き whisper-out は aligned: true になり words が DTW 時刻で組まれる", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-script-"));
  try {
    writeFileSync(
      join(dir, "whisper-out.json"),
      JSON.stringify({
        transcription: [
          {
            offsets: { from: 0, to: 2000 },
            text: "動画編集",
            tokens: [
              { text: "[_BEG_]", offsets: { from: 0, to: 0 }, t_dtw: -1 },
              { text: "動画", offsets: { from: 0, to: 720 }, t_dtw: 65 },
              { text: "編集", offsets: { from: 720, to: 1440 }, t_dtw: 120 },
            ],
          },
        ],
      }),
    );
    const s = loadScript(dir);
    assert.equal(s.aligned, true);
    assert.deepEqual(
      s.segments[0].words?.map((w) => [w.text, w.start, w.end]),
      [
        ["動画", 0, 0.65],
        ["編集", 0.65, 1.2],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
