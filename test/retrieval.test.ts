import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchIndex, tokenizeRetrievalText, type RetrievalDocument, type RetrievalIndex } from "../src/lib/retrieval.ts";
import { buildRetrievalIndex } from "../src/stages/retrievalIndex.ts";

test("tokenizeRetrievalText: NFKC、ASCII、日本語2/3-gram", () => {
  const tokens = tokenizeRetrievalText("ＡＰＩ ログイン画面");
  assert.ok(tokens.includes("api"));
  assert.ok(tokens.includes("ログ"));
  assert.ok(tokens.includes("画面"));
});

test("searchIndex: weighting、scope、stable result", () => {
  const index: RetrievalIndex = {
    schemaVersion: 1,
    builtAt: "2026-01-01",
    root: "recordings",
    warnings: [],
    recordings: [
      { name: "current", fingerprint: "a", mtimeMs: 2 },
      { name: "old", fingerprint: "b", mtimeMs: 1 },
    ],
    documents: [
      { id: "a", recordingDir: "current", kind: "material", title: "other", text: "ログイン", file: "materials/a.png", fingerprint: "a", tokens: tokenizeRetrievalText("ログイン") },
      { id: "b", recordingDir: "old", kind: "material", title: "ログイン", text: "", file: "materials/b.png", fingerprint: "b", tokens: [] },
    ],
  };
  const results = searchIndex(index, { query: "ログイン", kind: "material", scope: "other", currentRecording: "current" });
  assert.equal(results.length, 1);
  assert.equal(results[0].recording, "old");
  assert.equal(results[0].relativePath, "materials/b.png");
});

test("buildRetrievalIndex: recording 外を指す material path は結果へ載せない", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-"));
  const recording = join(root, "rec-1");
  try {
    mkdirSync(recording, { recursive: true });
    mkdirSync(join(recording, "materials.probe"), { recursive: true });
    writeFileSync(join(recording, "manifest.json"), JSON.stringify({
      source: "raw.mp4",
      durationSec: 10,
      video: { width: 1280, height: 720, fps: 30, screenRegion: { x: 0, y: 0, w: 1280, h: 720 } },
      audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
      createdAt: "2026-07-09T00:00:00Z",
      layout: "plain",
    }, null, 2));
    writeFileSync(join(recording, "materials.probe", "index.json"), JSON.stringify({
      materials: [{
        file: "../secret.png",
        ocr: "hidden text",
      }],
    }, null, 2));
    const index = buildRetrievalIndex(root);
    const results = searchIndex(index, { query: "hidden text", kind: "material" });
    assert.ok(results.length >= 1);
    assert.ok(results.every((result) => result.relativePath === undefined));
    assert.ok(index.warnings.some((warning) => warning.includes("invalid material path")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// video-perception-P2: screen.probe/index.json → RetrievalDocumentKind "screen"
// (docs/plans/2026-08-10-video-perception-p2-retrieval-visual-design.md §3.1)
// ---------------------------------------------------------------------------

function writeManifest(recording: string): void {
  mkdirSync(recording, { recursive: true });
  writeFileSync(join(recording, "manifest.json"), JSON.stringify({
    source: "raw.mp4",
    durationSec: 60,
    video: { width: 1280, height: 720, fps: 30, screenRegion: { x: 0, y: 0, w: 1280, h: 720 } },
    audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
    createdAt: "2026-07-09T00:00:00Z",
    layout: "plain",
  }, null, 2));
}

interface ScreenSegmentFixture {
  id: string;
  sourceSec: number;
  endSourceSec: number;
  representativeSourceSec: number;
  ocr: { lines: string[]; lineCount: number; file: string } | null;
  summary: { text: string; confidence: string } | null;
}

function screenSegment(overrides: Partial<ScreenSegmentFixture> & { id: string }): ScreenSegmentFixture {
  return {
    sourceSec: 10,
    endSourceSec: 20,
    representativeSourceSec: 15,
    ocr: { lines: ["hello world"], lineCount: 1, file: "screen.probe/ocr/15.00.json" },
    summary: null,
    ...overrides,
  };
}

// recordingFingerprint は mtime+size だけで差分検知する(内容の暗号学的ハッシュは
// 使わない・共通規約 §2.2)ため、同一テスト内で複数回書き直すときは実時計に頼らず
// 呼び出しごとに単調増加する未来 mtime を明示的に割り当てて再構築を確実に誘発する
let screenIndexMtimeTick = 0;

/** screen.probe/index.json を書く(呼ぶたびに一意に進む未来 mtime を付与) */
function writeScreenIndex(recording: string, segments: ScreenSegmentFixture[]): void {
  const dir = join(recording, "screen.probe");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "index.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    capturedAt: "2026-01-01T00:00:00Z",
    key: {},
    range: { startSec: 0, endSec: 60 },
    ocrAvailable: true,
    params: {},
    segments,
    warnings: [],
  }, null, 2));
  screenIndexMtimeTick += 1;
  const future = new Date(Date.now() + 60_000 + screenIndexMtimeTick * 1_000);
  utimesSync(path, future, future);
}

function screenDocs(index: RetrievalIndex, recording?: string): RetrievalDocument[] {
  return index.documents.filter((doc) => doc.kind === "screen" && (recording === undefined || doc.recordingDir === recording));
}

test("T1: screen.probe/index.json がある収録で screen 文書が区間数ぶん生成される", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const recording = join(root, "rec-1");
  try {
    writeManifest(recording);
    writeScreenIndex(recording, [
      screenSegment({ id: "scr-001", sourceSec: 0, endSourceSec: 10, representativeSourceSec: 5 }),
      screenSegment({ id: "scr-002", sourceSec: 10, endSourceSec: 20, representativeSourceSec: 15 }),
      screenSegment({ id: "scr-003", sourceSec: 20, endSourceSec: 30, representativeSourceSec: 25 }),
    ]);
    const index = buildRetrievalIndex(root);
    assert.equal(screenDocs(index, "rec-1").length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T2: screen.probe/ が無い収録では screen 文書が0件(例外を投げない)", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const recording = join(root, "rec-1");
  try {
    writeManifest(recording);
    const index = buildRetrievalIndex(root);
    assert.equal(screenDocs(index, "rec-1").length, 0);
    assert.deepEqual(index.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T3: title の優先順は summary → OCR先頭行 → 画面<id>", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const recording = join(root, "rec-1");
  try {
    writeManifest(recording);
    writeScreenIndex(recording, [
      screenSegment({
        id: "scr-001", representativeSourceSec: 1,
        ocr: { lines: ["OCRの先頭行"], lineCount: 1, file: "x" },
        summary: { text: "VLM要約テキスト", confidence: "high" },
      }),
      screenSegment({
        id: "scr-002", representativeSourceSec: 2,
        ocr: { lines: ["OCRの先頭行その2", "2行目"], lineCount: 2, file: "x" },
        summary: null,
      }),
      screenSegment({ id: "scr-003", representativeSourceSec: 3, ocr: null, summary: null }),
    ]);
    const index = buildRetrievalIndex(root);
    const docs = screenDocs(index, "rec-1");
    assert.equal(docs.find((d) => d.text.includes("OCRの先頭行") && !d.text.includes("その2"))?.title, "VLM要約テキスト");
    assert.equal(docs.find((d) => d.text.startsWith("OCRの先頭行その2"))?.title, "OCRの先頭行その2");
    assert.equal(docs.find((d) => d.text === "")?.title, "画面 scr-003");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T4: ocr:null かつ summary:null の区間で title=\"画面 scr-003\" / text=\"\"", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const recording = join(root, "rec-1");
  try {
    writeManifest(recording);
    writeScreenIndex(recording, [
      screenSegment({ id: "scr-003", representativeSourceSec: 42, ocr: null, summary: null }),
    ]);
    const index = buildRetrievalIndex(root);
    const doc = screenDocs(index, "rec-1")[0];
    assert.equal(doc.title, "画面 scr-003");
    assert.equal(doc.text, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T5: sourceRange が区間の sourceSec/endSourceSec と一致", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const recording = join(root, "rec-1");
  try {
    writeManifest(recording);
    writeScreenIndex(recording, [
      screenSegment({ id: "scr-001", sourceSec: 84.2, endSourceSec: 128.9, representativeSourceSec: 100 }),
    ]);
    const index = buildRetrievalIndex(root);
    const doc = screenDocs(index, "rec-1")[0];
    assert.deepEqual(doc.sourceRange, { startSec: 84.2, endSec: 128.9 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T6: 区間を畳み直して scr-NNN が変わっても representativeSourceSec が同じなら文書 id は不変", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const recording = join(root, "rec-1");
  try {
    writeManifest(recording);
    writeScreenIndex(recording, [
      screenSegment({ id: "scr-003", sourceSec: 10, endSourceSec: 20, representativeSourceSec: 15.2 }),
    ]);
    const before = buildRetrievalIndex(root);
    const idBefore = screenDocs(before, "rec-1")[0].id;

    // 区間を畳み直す: id は変わり、境界(sourceSec/endSourceSec)も変わるが
    // representativeSourceSec は同じ場面を指したまま 15.2 で不変
    writeScreenIndex(recording, [
      screenSegment({ id: "scr-099", sourceSec: 8, endSourceSec: 24, representativeSourceSec: 15.2 }),
    ]);
    const after = buildRetrievalIndex(root);
    const idAfter = screenDocs(after, "rec-1")[0].id;

    assert.equal(idAfter, idBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7: representativeSourceSec が変われば文書 id も変わる", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const recording = join(root, "rec-1");
  try {
    writeManifest(recording);
    writeScreenIndex(recording, [
      screenSegment({ id: "scr-003", representativeSourceSec: 15.2 }),
    ]);
    const before = buildRetrievalIndex(root);
    const idBefore = screenDocs(before, "rec-1")[0].id;

    writeScreenIndex(recording, [
      screenSegment({ id: "scr-003", representativeSourceSec: 16.7 }),
    ]);
    const after = buildRetrievalIndex(root);
    const idAfter = screenDocs(after, "rec-1")[0].id;

    assert.notEqual(idAfter, idBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T8: --kind screen で screen 文書だけが返る", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const recording = join(root, "rec-1");
  try {
    writeManifest(recording);
    writeFileSync(join(recording, "meta.json"), JSON.stringify({ title: "画面のミーティング議事録" }, null, 2));
    writeScreenIndex(recording, [
      screenSegment({
        id: "scr-001", representativeSourceSec: 5,
        ocr: { lines: ["珍しいエラーメッセージxyzzy"], lineCount: 1, file: "x" },
      }),
    ]);
    const index = buildRetrievalIndex(root);
    const results = searchIndex(index, { query: "xyzzy", kind: "screen" });
    assert.ok(results.length >= 1);
    assert.ok(results.every((r) => r.kind === "screen"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9: screen.probe/index.json の mtime 変化でその収録だけが再構築される", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const rec1 = join(root, "rec-1");
  const rec2 = join(root, "rec-2");
  try {
    writeManifest(rec1);
    writeManifest(rec2);
    writeScreenIndex(rec1, [screenSegment({ id: "scr-001", representativeSourceSec: 1 })]);
    writeScreenIndex(rec2, [
      screenSegment({
        id: "scr-001", representativeSourceSec: 2,
        ocr: { lines: ["hello world"], lineCount: 1, file: "x" },
      }),
    ]);
    buildRetrievalIndex(root);

    // rec-1 だけ mtime を進めて書き換える(再構築を誘発)
    writeScreenIndex(rec1, [
      screenSegment({
        id: "scr-001", representativeSourceSec: 1,
        ocr: { lines: ["変更後のテキスト"], lineCount: 1, file: "x" },
      }),
    ]);

    // rec-2 は内容だけ同じ長さの別文字列へ差し替え、mtime/size は前回ビルド時点の
    // まま(statSync で記録した値へ utimesSync で正確に戻す)にして「fingerprint が
    // 一致する=再読込されない」状況を人工的に作る。もし実装が誤ってキャッシュを
    // 無視して読み直せば、この書き換え後の内容("hello xorld")が出てしまう
    const rec2Path = join(rec2, "screen.probe", "index.json");
    const rec2StatBefore = statSync(rec2Path);
    writeFileSync(rec2Path, readFileSync(rec2Path, "utf8").replace("hello world", "hello xorld"));
    utimesSync(rec2Path, rec2StatBefore.atime, rec2StatBefore.mtime);

    const after = buildRetrievalIndex(root);
    assert.equal(screenDocs(after, "rec-1")[0].text, "変更後のテキスト");
    // fingerprint が変わっていないので、ディスク上の新しい内容ではなく
    // 前回ビルド時点の文書がそのまま再利用される(= 再構築されていない証拠)
    assert.equal(screenDocs(after, "rec-2")[0].text, "hello world");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T10: index.json が壊れた JSON でも warnings に積んで他の収録の索引は成功する", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-retrieval-screen-"));
  const rec1 = join(root, "rec-1");
  const rec2 = join(root, "rec-2");
  try {
    writeManifest(rec1);
    mkdirSync(join(rec1, "screen.probe"), { recursive: true });
    writeFileSync(join(rec1, "screen.probe", "index.json"), "{not valid json");

    writeManifest(rec2);
    writeScreenIndex(rec2, [screenSegment({ id: "scr-001", representativeSourceSec: 1 })]);

    const index = buildRetrievalIndex(root);
    assert.ok(index.warnings.some((w) => w.includes("rec-1") && w.includes("screen.probe/index.json")));
    assert.equal(screenDocs(index, "rec-2").length, 1);
    assert.ok(index.recordings.some((r) => r.name === "rec-1"));
    assert.ok(index.recordings.some((r) => r.name === "rec-2"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
