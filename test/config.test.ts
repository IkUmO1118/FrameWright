// lib/configEdit.ts — エディタの設定画面が config.yaml を書き戻すための純関数群。
// 「コメントを保ったまま該当キーだけ変える」「~ のパスを絶対パス化しない」
// 「書き戻し後の YAML からメモリ上 cfg を取り込み直す(cfg の参照は保つ)」を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  applyConfigEdits,
  syncEditorCfgFromYaml,
  validateConfigPatch,
} from "../src/lib/configEdit.ts";
import {
  aiCapabilities,
  DEFAULT_AI_CANDIDATES,
  DEFAULT_CANDIDATES_FILLERS,
  DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC,
  DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC,
  DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC,
  DEFAULT_DESCRIBE_PAUSE_MAX,
  DEFAULT_DESCRIBE_PAUSE_MIN_SEC,
  DEFAULT_AV_COLS,
  DEFAULT_AV_EVERY_SEC,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  DEFAULT_PERCEPTION_OCR_MAX_LINES,
  DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
  DEFAULT_PERCEPTION_CURSOR_MIN_DWELL_MS,
  DEFAULT_PERCEPTION_CURSOR_MOVE_THRESHOLD,
  DEFAULT_PERCEPTION_CURSOR_WAIT_TYPES,
  DEFAULT_PLAN_HARNESS_MAX_TOOL_CALLS,
  DEFAULT_PLAN_HARNESS_MAX_SPLITS,
  DEFAULT_PLAN_LOOP_MAX_ITERATIONS,
  DEFAULT_PLAN_LOOP_SECONDARY_MAX_CALLS,
  DEFAULT_PLAN_LOOP_SECONDARY_MAX_IMAGES,
  DEFAULT_PLAN_CURSOR_MIN_DWELL_MS,
  DEFAULT_PLAN_CURSOR_MAX_DWELL_MS,
  DEFAULT_PLAN_CURSOR_MOVE_THRESHOLD,
  DEFAULT_PLAN_CURSOR_SPACING_MS,
  DEFAULT_PLAN_CURSOR_DEFAULT_SCALE,
  DEFAULT_PLAN_CURSOR_CLICK_BOOST,
  DEFAULT_PLAN_CURSOR_MAX_WINDOW_MS,
  DEFAULT_PLAN_CURSOR_SCROLL_MOTION_THRESHOLD,
  DEFAULT_PLAN_CURSOR_AUTO_ZOOM,
  resolvePlanCursorCfg,
  DEFAULT_STYLE_PROFILE_NAME,
  loadConfig,
  MAX_AI_IMAGES,
  planHarnessEnabled,
  planLoopEnabled,
  formatPerceptionStatusLines,
  formatStyleProfileStatusLines,
  DEFAULT_LOG_LEVEL,
  resolveAiCfg,
  resolveAiRuntimeConfig,
  resolveAvCfg,
  resolveCandidatesCfg,
  resolveDescribePausesCfg,
  resolveHyperframeAssetLimits,
  resolveLogCfg,
  resolvePerceptionCfg,
  resolvePerceptionStatus,
  resolvePlanHarnessCfg,
  resolvePlanLoopCfg,
  resolvePlanLoopSecondaryObservationCfg,
  recordingRootState,
  resolveRecordingRoots,
  resolveReasonIdsCfg,
  resolveStyleProfileCfg,
  resolveStyleProfileStatus,
} from "../src/lib/config.ts";
import {
  DEFAULT_HYPERFRAME_ASSET_MAX_BYTES,
  DEFAULT_HYPERFRAME_ASSET_MAX_TOTAL_BYTES,
} from "../src/lib/hyperframeAssets.ts";
import type { Config } from "../src/lib/config.ts";

/** リポジトリ既定の config.yaml を模した fixture(コメント・~ パス入り) */
const RAW = `# framewright 設定ファイル
# パスの ~ はホームディレクトリに展開されます
recordingsDir: ~/Movies/framewright

whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja

# カット確認用プレビュー動画
preview:
  # 出力する横幅(px)
  width: 1280

render:
  # 右下ワイプ(カメラ)の横幅(px)
  wipeWidthPx: 480
  wipeMarginPx: 32
  captionFontSizePx: 52
  chapterCardSec: 3
  targetLufs: -14
  # システム音声の扱い
  systemAudio:
    mix: true
    # 合成時のシステム音声の音量(dB)
    volumeDb: 0
  denoise:
    mic: false
    noiseFloorDb: -25
  bgm:
    volumeDb: -22
    fadeOutSec: 2
    ducking:
      duckDb: -8
      fadeSec: 0.4
`;

test("applyConfigEdits: 指定キーだけ変わり、読み戻せる", () => {
  const out = applyConfigEdits(RAW, {
    render: { wipeWidthPx: 400, bgm: { volumeDb: -18 } },
    preview: { width: 960 },
  });
  const cfg = parse(out) as Config;
  assert.equal(cfg.render.wipeWidthPx, 400);
  assert.equal(cfg.render.bgm.volumeDb, -18);
  assert.equal(cfg.preview.width, 960);
  // 触っていないキーは元のまま
  assert.equal(cfg.render.captionFontSizePx, 52);
  assert.equal(cfg.render.bgm.fadeOutSec, 2);
  assert.deepEqual(cfg.render.bgm.ducking, { duckDb: -8, fadeSec: 0.4 });
});

test("applyConfigEdits: コメントが保持される", () => {
  const out = applyConfigEdits(RAW, { render: { wipeWidthPx: 400 } });
  assert.ok(out.includes("# framewright 設定ファイル"));
  assert.ok(out.includes("# 右下ワイプ(カメラ)の横幅(px)"));
  assert.ok(out.includes("# 合成時のシステム音声の音量(dB)"));
});

test("applyConfigEdits: ~ のパスが絶対パス化されない", () => {
  const out = applyConfigEdits(RAW, { render: { targetLufs: -16 } });
  assert.ok(out.includes("recordingsDir: ~/Movies/framewright"));
  assert.ok(out.includes("~/Models/whisper/"));
});

test("applyConfigEdits: 未存在ブロックへの書き込みはブロックごと生成", () => {
  const out = applyConfigEdits(RAW, {
    editor: { defaultImageDurationSec: 6 },
    render: { captionColor: "#ffee00" },
  });
  const cfg = parse(out) as Config;
  assert.equal(cfg.editor?.defaultImageDurationSec, 6);
  assert.equal(cfg.render.captionColor, "#ffee00");
});

test("applyConfigEdits: null でキーが消える(無いキーへの null は no-op)", () => {
  const withColor = applyConfigEdits(RAW, { render: { captionColor: "#ffee00" } });
  const removed = applyConfigEdits(withColor, { render: { captionColor: null } });
  assert.equal((parse(removed) as Config).render.captionColor, undefined);
  // 元から無いキーへの null は何も起きない
  const noop = applyConfigEdits(RAW, { render: { captionFontFamily: null } });
  assert.equal((parse(noop) as Config).render.captionFontFamily, undefined);
});

test("applyConfigEdits: テロップ既定の背景帯を追加・削除できる", () => {
  const added = applyConfigEdits(RAW, {
    render: {
      captionBackground: { color: "rgba(0, 0, 0, 0.75)", paddingPx: 18, radiusPx: 10 },
    },
  });
  assert.deepEqual((parse(added) as Config).render.captionBackground, {
    color: "rgba(0, 0, 0, 0.75)",
    paddingPx: 18,
    radiusPx: 10,
  });
  const removed = applyConfigEdits(added, { render: { captionBackground: null } });
  assert.equal((parse(removed) as Config).render.captionBackground, undefined);
});

test("applyConfigEdits: 子を全部コメントアウトした null スカラーの親でも投げない", () => {
  // `editor:` の中身が全部コメントアウトされ null スカラーになっている config
  const raw = `recordingsDir: ~/Movies/framewright
editor:
  # maxUploadMb: 2048
  # defaultImageDurationSec: 4
render:
  wipeWidthPx: 480
`;
  // setIn(null スカラーの親)も、そこへの null 削除も投げずに済む
  const set = applyConfigEdits(raw, { editor: { defaultImageDurationSec: 6 } });
  assert.equal((parse(set) as Config).editor?.defaultImageDurationSec, 6);
  const del = applyConfigEdits(raw, { editor: { defaultImageDurationSec: null } });
  assert.equal((parse(del) as Config).editor?.defaultImageDurationSec, undefined);
});

test("applyConfigEdits: 親ブロックごと欠落していても深いキーを生成できる", () => {
  const raw = `recordingsDir: ~/Movies/framewright
render:
  wipeWidthPx: 480
`;
  // render.bgm / render.bgm.ducking が丸ごと無い状態への深いブロック書き込み
  const out = applyConfigEdits(raw, {
    render: { bgm: { volumeDb: -18, ducking: { duckDb: -10, fadeSec: 0.5 } } },
    editor: { maxUploadMb: 4096, maxBaseUploadMb: 16384 },
  });
  const cfg = parse(out) as Config;
  assert.equal(cfg.render.bgm.volumeDb, -18);
  assert.deepEqual(cfg.render.bgm.ducking, { duckDb: -10, fadeSec: 0.5 });
  assert.equal(cfg.editor?.maxUploadMb, 4096);
  assert.equal(cfg.editor?.maxBaseUploadMb, 16384);
  assert.equal(cfg.render.wipeWidthPx, 480); // 既存キーは保たれる
});

test("applyConfigEdits: systemAudio のブロック更新で兄弟キー・コメントが残る", () => {
  const out = applyConfigEdits(RAW, {
    render: { systemAudio: { mix: false, volumeDb: -6 } },
  });
  const cfg = parse(out) as Config;
  assert.deepEqual(cfg.render.systemAudio, { mix: false, volumeDb: -6 });
  assert.ok(out.includes("# システム音声の扱い"));
  assert.equal(cfg.render.bgm.volumeDb, -22);
});

test("applyConfigEdits: denoise のブロック更新で兄弟キーが残る(未設定時の既定は mic:false/noiseFloorDb:-25)", () => {
  assert.deepEqual((parse(RAW) as Config).render.denoise, { mic: false, noiseFloorDb: -25 });
  const out = applyConfigEdits(RAW, {
    render: { denoise: { mic: true, noiseFloorDb: -18 } },
  });
  const cfg = parse(out) as Config;
  assert.deepEqual(cfg.render.denoise, { mic: true, noiseFloorDb: -18 });
  assert.equal(cfg.render.bgm.volumeDb, -22);
});

test("validateConfigPatch: 正常系は空配列", () => {
  assert.deepEqual(
    validateConfigPatch({
      render: {
        wipeWidthPx: 480,
        captionColor: "#ffffff",
        captionOutlineColor: "none",
        captionFontWeight: null,
        captionBackground: { color: "rgba(0, 0, 0, 0.75)", paddingPx: 18, radiusPx: 10 },
        systemAudio: { mix: true, volumeDb: 0 },
        denoise: { mic: false, noiseFloorDb: -25 },
        bgm: { volumeDb: -22, ducking: { duckDb: -8, fadeSec: 0.4 } },
        cutTransition: { type: "dip-to-black", sec: 0.4 },
        hardwareAcceleration: "disable",
        zoom: { easeSec: 0.4 },
      },
      preview: { width: 1280, videoEncoder: "videotoolbox" },
      editor: {
        maxUploadMb: 2048,
        maxBaseUploadMb: 16384,
        defaultImageDurationSec: 4,
        aiReview: { vlm: true, maxImages: 4, maxRefinements: 2 },
      },
      ai: {
        profiles: { local: { adapter: "openai", model: "gpt-5.4-mini" } },
        routes: { text: "local", structured: "local", vision: "local" },
      },
    }),
    [],
  );
});

test("validateConfigPatch: design.backgroundEnabled は真偽値だけを許可する", () => {
  assert.deepEqual(
    validateConfigPatch({ render: { design: { backgroundEnabled: false } } }),
    [],
  );
  assert.ok(
    validateConfigPatch({ render: { design: { backgroundEnabled: "false" } } }).length > 0,
  );
});

test("applyConfigEdits: ai は単一provider設定として置き換える", () => {
  const out = applyConfigEdits(RAW, {
    ai: {
      profiles: { local: { adapter: "codex", model: "auto" } },
      routes: { text: "local", structured: "local" },
    },
  });
  const cfg = parse(out) as Config;
  assert.deepEqual(cfg.ai, {
    profiles: { local: { adapter: "codex", model: "auto" } },
    routes: { text: "local", structured: "local" },
  });
});

test("validateConfigPatch: hardwareAcceleration は if-possible/disable/null のみ許可", () => {
  assert.deepEqual(
    validateConfigPatch({ render: { hardwareAcceleration: "if-possible" } }),
    [],
  );
  assert.deepEqual(
    validateConfigPatch({ render: { hardwareAcceleration: null } }),
    [],
  );
  assert.ok(
    validateConfigPatch({ render: { hardwareAcceleration: "always" } }).length > 0,
  );
});

test("validateConfigPatch: 範囲外・型違い・未知キーを拒否", () => {
  assert.ok(validateConfigPatch({ preview: { width: 1281 } }).length > 0); // 奇数
  assert.ok(validateConfigPatch({ render: { targetLufs: 0 } }).length > 0);
  assert.ok(validateConfigPatch({ render: { captionFontWeight: 1000 } }).length > 0);
  assert.ok(
    validateConfigPatch({ render: { captionBackground: { paddingPx: 12 } } }).length > 0,
  );
  assert.ok(
    validateConfigPatch({ render: { captionBackground: { color: "#000", radiusPx: -1 } } }).length > 0,
  );
  assert.ok(validateConfigPatch({ render: { wipeWidthPx: "480" } }).length > 0);
  assert.ok(validateConfigPatch({ detect: { silenceDb: -35 } }).length > 0); // 対象外セクション
  assert.ok(validateConfigPatch({ render: { nope: 1 } }).length > 0);
  // 削除(null)を受けないキーへの null
  assert.ok(validateConfigPatch({ render: { wipeWidthPx: null } }).length > 0);
  // ブロック更新の欠けを拒否
  assert.ok(validateConfigPatch({ render: { systemAudio: { mix: true } } }).length > 0);
  assert.ok(
    validateConfigPatch({ render: { bgm: { ducking: { duckDb: -8 } } } }).length > 0,
  );
  assert.ok(validateConfigPatch({ render: { denoise: { mic: true } } }).length > 0);
});

test("validateConfigPatch: denoise は mic/noiseFloorDb のブロック更新のみ許可", () => {
  assert.deepEqual(
    validateConfigPatch({ render: { denoise: { mic: true, noiseFloorDb: -25 } } }),
    [],
  );
  assert.ok(
    validateConfigPatch({ render: { denoise: { mic: "true", noiseFloorDb: -25 } } }).length > 0,
  );
  assert.ok(
    validateConfigPatch({ render: { denoise: { mic: true, noiseFloorDb: -10 } } }).length > 0,
  );
  assert.ok(
    validateConfigPatch({ render: { denoise: { mic: true, noiseFloorDb: -90 } } }).length > 0,
  );
});

test("syncEditorCfgFromYaml: cfg の参照を保ったままサブツリーを取り込み直す", () => {
  const cfg = parse(RAW) as Config;
  cfg.recordingsDir = "/abs/Movies/framewright"; // expandHome 済みを模す
  const before = cfg; // クロージャで共有される cfg 自身の参照
  const nextYaml = applyConfigEdits(RAW, {
    render: { wipeWidthPx: 400, captionColor: "#ffee00" },
    preview: { width: 960 },
    editor: { defaultImageDurationSec: 6 },
  });
  syncEditorCfgFromYaml(cfg, nextYaml);
  assert.equal(cfg, before); // cfg 自身は同じ参照(preview/render/proxy が見続ける)
  assert.equal(cfg.render.wipeWidthPx, 400);
  assert.equal(cfg.render.captionColor, "#ffee00");
  assert.equal(cfg.preview.width, 960);
  assert.equal(cfg.editor?.defaultImageDurationSec, 6);
  // render/preview/editor 以外(~ を含むキー)は取り込みで壊されない
  assert.equal(cfg.recordingsDir, "/abs/Movies/framewright");
});

test("syncEditorCfgFromYaml: null 削除で省略時の既定へ戻る", () => {
  const cfg = parse(RAW) as Config;
  const withColor = applyConfigEdits(RAW, { render: { captionColor: "#ffee00" } });
  syncEditorCfgFromYaml(cfg, withColor);
  assert.equal(cfg.render.captionColor, "#ffee00");
  const removed = applyConfigEdits(withColor, { render: { captionColor: null } });
  syncEditorCfgFromYaml(cfg, removed);
  assert.equal(cfg.render.captionColor, undefined);
});

test("resolveHyperframeAssetLimits: 省略時既定と config 上書きを解決する", () => {
  const cfg = parse(RAW) as Config;
  assert.deepEqual(resolveHyperframeAssetLimits(cfg), {
    maxBytes: DEFAULT_HYPERFRAME_ASSET_MAX_BYTES,
    maxTotalBytes: DEFAULT_HYPERFRAME_ASSET_MAX_TOTAL_BYTES,
  });
  cfg.hyperframe = { assets: { maxBytes: 1000, maxTotalBytes: 3000 } };
  assert.deepEqual(resolveHyperframeAssetLimits(cfg), { maxBytes: 1000, maxTotalBytes: 3000 });
});

test("loadConfig: hyperframe.assets の未知キー・非正値・逆転した上限を拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(path, `${RAW}\nhyperframe:\n  assets:\n    maxBytes: 20\n    maxTotalBytes: 10\n`);
    assert.throws(() => loadConfig(path), /maxTotalBytes は maxBytes 以上/);
    writeFileSync(path, `${RAW}\nhyperframe:\n  assets:\n    maxBytes: 0\n    maxTotalBytes: 10\n`);
    assert.throws(() => loadConfig(path), /maxBytes は正の整数/);
    writeFileSync(path, `${RAW}\nhyperframe:\n  assets:\n    extra: 1\n`);
    assert.throws(() => loadConfig(path), /hyperframe\.assets\.extra は未対応/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: recordingsDir と recordingsDirs は併記できない", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(path, `${RAW}\nrecordingsDirs:\n  usb-a: /Volumes/FootageSSD/framewright\n`);
    assert.throws(() => loadConfig(path), /recordingsDir と recordingsDirs は併記できません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: recordingsDirs のキー形式・空件数を検証する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    const base = RAW.replace(/^recordingsDir: .*\n/m, "");
    writeFileSync(path, `recordingsDirs:\n  Bad-Key: /tmp/a\n${base}`);
    assert.throws(() => loadConfig(path), /recordingsDirs のキー "Bad-Key" が不正です/);
    writeFileSync(path, `recordingsDirs: {}\n${base}`);
    assert.throws(() => loadConfig(path), /recordingsDirs は最低1件必要です/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: recordingsDirs は全ルートを ~ 展開し、先頭が recordingsDir 互換の primary になる", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    const base = RAW.replace(/^recordingsDir: .*\n/m, "");
    writeFileSync(path, `recordingsDirs:\n  main: ~/Movies/framewright\n  usb-a: /Volumes/FootageSSD/framewright\n${base}`);
    const cfg = loadConfig(path);
    assert.equal(cfg.recordingsDir, join(homedir(), "Movies/framewright"));
    assert.deepEqual(resolveRecordingRoots(cfg), [
      { key: "main", path: join(homedir(), "Movies/framewright") },
      { key: "usb-a", path: "/Volumes/FootageSSD/framewright" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRecordingRoots: recordingsDirs 未指定なら単一ルート(key=main)を返す", () => {
  const cfg = parse(RAW) as Config;
  cfg.recordingsDir = "/abs/Movies/framewright";
  assert.deepEqual(resolveRecordingRoots(cfg), [{ key: "main", path: "/abs/Movies/framewright" }]);
});

test("loadConfig: whisper.wordTimestamps 未指定時は true(語タイムスタンプ既定資産化=W0)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.whisper.wordTimestamps, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: whisper.wordTimestamps: true を指定すればそのまま通る", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
  wordTimestamps: true
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.whisper.wordTimestamps, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: whisper.wordTimestamps: false を明示すればそのまま false(逃げ道)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
  wordTimestamps: false
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.whisper.wordTimestamps, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: preview.engine 未指定時は既定 'canvas'(M3b)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
preview:
  width: 1280
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.preview.engine, "canvas");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: preview.engine: legacy を指定すればそのまま通る", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
preview:
  width: 1280
  engine: legacy
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.preview.engine, "legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: ocr 省略時は languages が [en, ja](既存挙動と完全一致)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
`,
    );
    const cfg = loadConfig(path);
    assert.deepEqual(cfg.ocr?.languages, ["en", "ja"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: ocr.languages を指定すればそのまま通る", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
ocr:
  languages: [en]
`,
    );
    const cfg = loadConfig(path);
    assert.deepEqual(cfg.ocr?.languages, ["en"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DEFAULT_CURSOR_OPTIONS = {
  minDwellMs: DEFAULT_PERCEPTION_CURSOR_MIN_DWELL_MS,
  moveThreshold: DEFAULT_PERCEPTION_CURSOR_MOVE_THRESHOLD,
  waitTypes: DEFAULT_PERCEPTION_CURSOR_WAIT_TYPES,
};

test("resolvePerceptionCfg: plan 省略時は全オフ+既定値", () => {
  assert.deepEqual(resolvePerceptionCfg({} as Config), {
    audio: false,
    ocr: false,
    ocrMaxSegments: DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
    ocrMaxLines: DEFAULT_PERCEPTION_OCR_MAX_LINES,
    systemSpeech: false,
    cursor: false,
    cursorOptions: DEFAULT_CURSOR_OPTIONS,
  });
  assert.equal(DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS, 40);
  assert.equal(DEFAULT_PERCEPTION_OCR_MAX_LINES, 6);
  assert.equal(DEFAULT_PERCEPTION_CURSOR_MIN_DWELL_MS, 600);
  assert.equal(DEFAULT_PERCEPTION_CURSOR_MOVE_THRESHOLD, 0.02);
  assert.deepEqual(DEFAULT_PERCEPTION_CURSOR_WAIT_TYPES, ["wait", "busybutclickable"]);
});

test("resolvePerceptionCfg: plan.perception 省略時も全オフ+既定値", () => {
  assert.deepEqual(resolvePerceptionCfg({ plan: {} } as Config), {
    audio: false,
    ocr: false,
    ocrMaxSegments: DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
    ocrMaxLines: DEFAULT_PERCEPTION_OCR_MAX_LINES,
    systemSpeech: false,
    cursor: false,
    cursorOptions: DEFAULT_CURSOR_OPTIONS,
  });
});

test("resolvePerceptionCfg: audio だけ指定すれば他は既定のまま", () => {
  assert.deepEqual(
    resolvePerceptionCfg({ plan: { perception: { audio: true } } } as Config),
    {
      audio: true,
      ocr: false,
      ocrMaxSegments: DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
      ocrMaxLines: DEFAULT_PERCEPTION_OCR_MAX_LINES,
      systemSpeech: false,
      cursor: false,
      cursorOptions: DEFAULT_CURSOR_OPTIONS,
    },
  );
});

test("resolvePerceptionCfg: 全項目を明示指定すればそのまま通る", () => {
  assert.deepEqual(
    resolvePerceptionCfg({
      plan: {
        perception: {
          audio: true,
          ocr: true,
          ocrMaxSegments: 10,
          ocrMaxLines: 3,
          systemSpeech: true,
          cursor: true,
          cursorDwell: { minDwellMs: 800, moveThreshold: 0.05 },
          cursorWaitTypes: ["wait"],
        },
      },
    } as Config),
    {
      audio: true,
      ocr: true,
      ocrMaxSegments: 10,
      ocrMaxLines: 3,
      systemSpeech: true,
      cursor: true,
      cursorOptions: { minDwellMs: 800, moveThreshold: 0.05, waitTypes: ["wait"] },
    },
  );
});

test("resolvePerceptionCfg: systemSpeech 省略時は false", () => {
  assert.equal(
    resolvePerceptionCfg({ plan: { perception: { audio: true } } } as Config).systemSpeech,
    false,
  );
});

test("resolvePerceptionCfg: cursor 省略時は false、cursorDwell の一部だけ指定すれば残りは既定", () => {
  const pc = resolvePerceptionCfg({
    plan: { perception: { cursorDwell: { minDwellMs: 900 } } },
  } as Config);
  assert.equal(pc.cursor, false);
  assert.deepEqual(pc.cursorOptions, {
    minDwellMs: 900,
    moveThreshold: DEFAULT_PERCEPTION_CURSOR_MOVE_THRESHOLD,
    waitTypes: DEFAULT_PERCEPTION_CURSOR_WAIT_TYPES,
  });
});

test("resolveCandidatesCfg: candidates 省略時は enabled=false+既定値(バイト等価の要)", () => {
  assert.deepEqual(resolveCandidatesCfg({} as Config), {
    enabled: false,
    splitOnlyLongerThanSec: DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC,
    minSplitGapSec: DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC,
    minCandidateSec: DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC,
    fillers: DEFAULT_CANDIDATES_FILLERS,
  });
});

test("resolveCandidatesCfg: enabled だけ指定すれば他は既定のまま", () => {
  assert.deepEqual(
    resolveCandidatesCfg({ candidates: { enabled: true } } as Config),
    {
      enabled: true,
      splitOnlyLongerThanSec: DEFAULT_CANDIDATES_SPLIT_ONLY_LONGER_THAN_SEC,
      minSplitGapSec: DEFAULT_CANDIDATES_MIN_SPLIT_GAP_SEC,
      minCandidateSec: DEFAULT_CANDIDATES_MIN_CANDIDATE_SEC,
      fillers: DEFAULT_CANDIDATES_FILLERS,
    },
  );
});

test("resolveCandidatesCfg: 全項目を明示指定すればそのまま通る", () => {
  assert.deepEqual(
    resolveCandidatesCfg({
      candidates: {
        enabled: true,
        splitOnlyLongerThanSec: 4,
        minSplitGapSec: 0.2,
        minCandidateSec: 0.3,
        fillers: ["えー"],
      },
    } as Config),
    {
      enabled: true,
      splitOnlyLongerThanSec: 4,
      minSplitGapSec: 0.2,
      minCandidateSec: 0.3,
      fillers: ["えー"],
    },
  );
});

test("resolvePerceptionStatus: plan.perception 未指定なら explicit=false と warning を返す", () => {
  assert.deepEqual(resolvePerceptionStatus({} as Config), {
    explicit: false,
    audio: false,
    ocr: false,
    ocrMaxSegments: DEFAULT_PERCEPTION_OCR_MAX_SEGMENTS,
    ocrMaxLines: DEFAULT_PERCEPTION_OCR_MAX_LINES,
    systemSpeech: false,
    cursor: false,
    warnings: [
      "plan.perception が config.yaml にありません。plan の知覚(audio/ocr/systemSpeech/cursor)は全てオフです。",
    ],
  });
});

test("resolvePerceptionStatus: 明示 config なら warning なし", () => {
  assert.deepEqual(
    resolvePerceptionStatus({
      plan: { perception: { audio: true, ocr: true, ocrMaxSegments: 10, ocrMaxLines: 3, cursor: true } },
    } as Config),
    {
      explicit: true,
      audio: true,
      ocr: true,
      ocrMaxSegments: 10,
      ocrMaxLines: 3,
      systemSpeech: false,
      cursor: true,
      warnings: [],
    },
  );
});

test("formatPerceptionStatusLines: warning と status 行を CLI 向け文言で返す", () => {
  assert.deepEqual(
    formatPerceptionStatusLines(resolvePerceptionStatus({} as Config)),
    [
      "警告: plan.perception が config.yaml にありません。plan の知覚(audio/ocr/systemSpeech/cursor)は全てオフです。",
      "plan 知覚: audio=off / ocr=off / systemSpeech=off / cursor=off",
    ],
  );
  assert.deepEqual(
    formatPerceptionStatusLines(
      resolvePerceptionStatus({
        plan: { perception: { audio: true, ocr: true, systemSpeech: true, cursor: true } },
      } as Config),
    ),
    [
      "plan 知覚: audio=on / ocr=on(max 40 segments, 6 lines) / systemSpeech=on / cursor=on",
    ],
  );
});

test("resolvePlanLoopCfg: plan/loop 省略時はループ無効の既定値", () => {
  assert.deepEqual(resolvePlanLoopCfg({} as Config), {
    maxIterations: DEFAULT_PLAN_LOOP_MAX_ITERATIONS,
    targetOutDurationSec: null,
    stopWhenAssertionsPass: true,
  });
  assert.equal(DEFAULT_PLAN_LOOP_MAX_ITERATIONS, 0);
  assert.equal(planLoopEnabled({} as Config), false);
  assert.equal(planLoopEnabled({ plan: { loop: { maxIterations: 1 } } } as Config), false);
});

test("resolvePlanLoopCfg: 明示値を解決し maxIterations>=2 だけ有効", () => {
  const cfg = {
    plan: {
      loop: {
        maxIterations: 3,
        targetOutDurationSec: 300,
        stopWhenAssertionsPass: false,
      },
    },
  } as Config;
  assert.deepEqual(resolvePlanLoopCfg(cfg), {
    maxIterations: 3,
    targetOutDurationSec: 300,
    stopWhenAssertionsPass: false,
  });
  assert.equal(planLoopEnabled(cfg), true);
});

test("resolvePlanLoopSecondaryObservationCfg: 省略時は無効+既定値、指定時はそのまま", () => {
  assert.deepEqual(resolvePlanLoopSecondaryObservationCfg({} as Config), {
    enabled: false,
    maxCalls: DEFAULT_PLAN_LOOP_SECONDARY_MAX_CALLS,
    maxImages: DEFAULT_PLAN_LOOP_SECONDARY_MAX_IMAGES,
  });
  assert.deepEqual(resolvePlanLoopSecondaryObservationCfg({
    plan: { loop: { secondaryObservation: { enabled: true, maxCalls: 2, maxImages: 1 } } },
  } as Config), {
    enabled: true,
    maxCalls: 2,
    maxImages: 1,
  });
});

test("resolvePlanHarnessCfg: plan.harness 省略時はオフ+既定値(SD4 H1/H2)", () => {
  assert.deepEqual(resolvePlanHarnessCfg({} as Config), {
    agentic: false,
    maxToolCalls: DEFAULT_PLAN_HARNESS_MAX_TOOL_CALLS,
    applySplit: false,
    maxSplits: DEFAULT_PLAN_HARNESS_MAX_SPLITS,
    tools: { frames: true, av: true, materials: true, ocr: true },
  });
  assert.equal(DEFAULT_PLAN_HARNESS_MAX_TOOL_CALLS, 16);
  assert.equal(DEFAULT_PLAN_HARNESS_MAX_SPLITS, 4);
  assert.equal(planHarnessEnabled({} as Config), false);
});

test("resolvePlanHarnessCfg: 明示値を解決し個別 tool の on/off を保つ", () => {
  const cfg = {
    plan: {
      harness: {
        agentic: true,
        maxToolCalls: 8,
        applySplit: true,
        maxSplits: 2,
        tools: { frames: false, av: true, materials: false, ocr: true },
      },
    },
  } as Config;
  assert.deepEqual(resolvePlanHarnessCfg(cfg), {
    agentic: true,
    maxToolCalls: 8,
    applySplit: true,
    maxSplits: 2,
    tools: { frames: false, av: true, materials: false, ocr: true },
  });
});

test("planHarnessEnabled: agentic=true でも claude-code は completeAgentic 非対応なので false", () => {
  const cfg = { ai: { provider: "claude-code" }, plan: { harness: { agentic: true } } } as Config;
  assert.equal(planHarnessEnabled(cfg), false);
});

test("planHarnessEnabled: anthropic ルートで agentic=true なら true(completeAgentic 実装済み)", () => {
  const cfg = {
    ai: { provider: "anthropic", model: "claude-x" },
    plan: { harness: { agentic: true } },
  } as Config;
  assert.equal(planHarnessEnabled(cfg), true);
});

test("resolveStyleProfileCfg: plan.styleProfile 省略時は off+既定 profile 名(SD-T4)", () => {
  assert.deepEqual(resolveStyleProfileCfg({} as Config), {
    enabled: false,
    profile: DEFAULT_STYLE_PROFILE_NAME,
  });
  assert.equal(DEFAULT_STYLE_PROFILE_NAME, "default");
});

test("resolveStyleProfileCfg: 明示値を解決し、空白/空文字 profile は既定名へフォールバック", () => {
  assert.deepEqual(
    resolveStyleProfileCfg({ plan: { styleProfile: { enabled: true, profile: "punchy" } } } as Config),
    { enabled: true, profile: "punchy" },
  );
  assert.deepEqual(
    resolveStyleProfileCfg({ plan: { styleProfile: { enabled: true, profile: "   " } } } as Config),
    { enabled: true, profile: DEFAULT_STYLE_PROFILE_NAME },
  );
  assert.deepEqual(
    resolveStyleProfileCfg({ plan: { styleProfile: { enabled: false } } } as Config),
    { enabled: false, profile: DEFAULT_STYLE_PROFILE_NAME },
  );
});

test("resolveStyleProfileStatus/formatStyleProfileStatusLines: 未設定は警告+off", () => {
  const status = resolveStyleProfileStatus({} as Config);
  assert.equal(status.explicit, false);
  assert.equal(status.enabled, false);
  assert.equal(status.profile, DEFAULT_STYLE_PROFILE_NAME);
  assert.deepEqual(formatStyleProfileStatusLines(status), [
    "警告: plan.styleProfile が config.yaml にありません。スタイル注入はオフです。",
    "plan スタイル注入: off",
  ]);
});

test("resolveStyleProfileStatus/formatStyleProfileStatusLines: enabled=true は on(profile=名) を返し警告なし", () => {
  const status = resolveStyleProfileStatus({
    plan: { styleProfile: { enabled: true, profile: "punchy" } },
  } as Config);
  assert.equal(status.explicit, true);
  assert.deepEqual(formatStyleProfileStatusLines(status), [
    "plan スタイル注入: on(profile=punchy)",
  ]);
});

test("resolveStyleProfileStatus/formatStyleProfileStatusLines: explicit だが enabled=false(明示 off)は警告なしで off", () => {
  const status = resolveStyleProfileStatus({ plan: { styleProfile: { enabled: false } } } as Config);
  assert.equal(status.explicit, true);
  assert.deepEqual(formatStyleProfileStatusLines(status), ["plan スタイル注入: off"]);
});

/** loadConfig 経由で validateWorkflowConfig の plan.styleProfile 検査を固定する
 * (plan.harness 系と同じく、この検査自体は非 export のため loadConfig 越しに
 * 確認する。最小限の valid な config.yaml へ plan.styleProfile を足す) */
function writeMinimalConfigWithPlanStyleProfile(dir: string, styleProfileYaml: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/m.bin
  language: ja
detect: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 }
preview: { width: 1280, videoEncoder: videotoolbox }
render:
  wipeWidthPx: 480
  wipeMarginPx: 32
  wipeTransitionSec: 0.3
  cutTransition: { type: none, sec: 0.3 }
  captionFontSizePx: 52
  captionColor: "#fff"
  captionOutlineColor: "#000"
  captionFontFamily: sans-serif
  captionFontWeight: 700
  chapterCardSec: 3
  targetLufs: -14
  systemAudio: { mix: true, volumeDb: 0 }
  denoise: { mic: false, noiseFloorDb: -25 }
  bgm: { volumeDb: -22, fadeOutSec: 2, ducking: { duckDb: -8, fadeSec: 0.4 } }
  hardwareAcceleration: if-possible
  chunkSec: 15
  zoom: { easeSec: 0.4 }
editor: { maxUploadMb: 2048, defaultImageDurationSec: 4, defaultShortRangeSec: 10 }
planShorts: { maxDurationSec: 60 }
llm: { backend: claude-cli, model: x }
plan:
  styleProfile: ${styleProfileYaml}
`,
  );
  return path;
}

test("loadConfig: plan.styleProfile の正常系は素通り(enabled/profile が解決できる)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanStyleProfile(dir, "{ enabled: true, profile: punchy }");
    const cfg = loadConfig(path);
    assert.deepEqual(resolveStyleProfileCfg(cfg), { enabled: true, profile: "punchy" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.styleProfile の未知キーは拒否される(SD-T4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanStyleProfile(dir, "{ enabled: true, foo: 1 }");
    assert.throws(() => loadConfig(path), /plan\.styleProfile\.foo は未対応です/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.styleProfile.enabled は boolean 以外を拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanStyleProfile(dir, "{ enabled: yes-please }");
    assert.throws(() => loadConfig(path), /plan\.styleProfile\.enabled は boolean で指定してください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.styleProfile.profile は文字列以外を拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanStyleProfile(dir, "{ profile: 123 }");
    assert.throws(() => loadConfig(path), /plan\.styleProfile\.profile は文字列で指定してください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* D2: plan.cursor(カーソル dwell 閾値。§2026-07-24-openscreen-d2-dwell-suggestion-design.md) */

test("resolvePlanCursorCfg: plan.cursor 省略時は OpenScreen 既定値", () => {
  assert.deepEqual(resolvePlanCursorCfg({} as never), {
    minDwellMs: DEFAULT_PLAN_CURSOR_MIN_DWELL_MS,
    maxDwellMs: DEFAULT_PLAN_CURSOR_MAX_DWELL_MS,
    moveThreshold: DEFAULT_PLAN_CURSOR_MOVE_THRESHOLD,
    spacingMs: DEFAULT_PLAN_CURSOR_SPACING_MS,
    defaultScale: DEFAULT_PLAN_CURSOR_DEFAULT_SCALE,
    clickBoost: DEFAULT_PLAN_CURSOR_CLICK_BOOST,
    maxWindowMs: DEFAULT_PLAN_CURSOR_MAX_WINDOW_MS,
    scrollMotionThreshold: DEFAULT_PLAN_CURSOR_SCROLL_MOTION_THRESHOLD,
    autoZoom: DEFAULT_PLAN_CURSOR_AUTO_ZOOM,
  });
});

/** loadConfig 経由で validateWorkflowConfig の plan.cursor 検査を固定する
 * (plan.styleProfile と同じく、この検査自体は非 export のため loadConfig 越しに
 * 確認する) */
function writeMinimalConfigWithPlanCursor(dir: string, cursorYaml: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/m.bin
  language: ja
detect: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 }
preview: { width: 1280, videoEncoder: videotoolbox }
render:
  wipeWidthPx: 480
  wipeMarginPx: 32
  captionFontSizePx: 52
  chapterCardSec: 3
  targetLufs: -14
editor: { maxUploadMb: 2048, defaultImageDurationSec: 4, defaultShortRangeSec: 10 }
planShorts: { maxDurationSec: 60 }
llm: { backend: claude-cli, model: x }
plan:
  cursor: ${cursorYaml}
`,
  );
  return path;
}

test("loadConfig: plan.cursor の正常系は素通り", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(
      dir,
      "{ minDwellMs: 300, maxDwellMs: 2000, moveThreshold: 0.03, spacingMs: 1500, defaultScale: 3, clickBoost: 2 }",
    );
    const cfg = loadConfig(path);
    assert.deepEqual(resolvePlanCursorCfg(cfg), {
      minDwellMs: 300,
      maxDwellMs: 2000,
      moveThreshold: 0.03,
      spacingMs: 1500,
      defaultScale: 3,
      clickBoost: 2,
      maxWindowMs: DEFAULT_PLAN_CURSOR_MAX_WINDOW_MS,
      scrollMotionThreshold: DEFAULT_PLAN_CURSOR_SCROLL_MOTION_THRESHOLD,
      autoZoom: DEFAULT_PLAN_CURSOR_AUTO_ZOOM,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.cursor の未知キーは拒否される", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(dir, "{ foo: 1 }");
    assert.throws(() => loadConfig(path), /plan\.cursor\.foo は未対応です/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.cursor.minDwellMs は maxDwellMs 未満でなければ拒否される", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(dir, "{ minDwellMs: 3000, maxDwellMs: 2000 }");
    assert.throws(() => loadConfig(path), /plan\.cursor\.minDwellMs は maxDwellMs 未満で指定してください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.cursor.moveThreshold は正の数値以外を拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(dir, "{ moveThreshold: 0 }");
    assert.throws(() => loadConfig(path), /plan\.cursor\.moveThreshold は正の数値で指定してください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.cursor.clickBoost は正の数値以外を拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(dir, "{ clickBoost: -1 }");
    assert.throws(() => loadConfig(path), /plan\.cursor\.clickBoost は正の数値で指定してください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 枝D: plan.cursor.scrollMotionThreshold(スクロール誤爆抑制の scene score 閾値。
 * §2026-07-24-openscreen-zoom-D-scroll-suppression-design.md) */

test("loadConfig: plan.cursor.scrollMotionThreshold の正常系は素通り", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(dir, "{ scrollMotionThreshold: 0.6 }");
    const cfg = loadConfig(path);
    assert.equal(resolvePlanCursorCfg(cfg).scrollMotionThreshold, 0.6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.cursor.scrollMotionThreshold は正の数値以外を拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(dir, "{ scrollMotionThreshold: 0 }");
    assert.throws(() => loadConfig(path), /plan\.cursor\.scrollMotionThreshold は正の数値で指定してください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* plan.cursor.autoZoom(run 末尾の自動挿入の on/off。
 * §2026-07-24-openscreen-autozoom-placement-design.md D6) */

test("loadConfig: plan.cursor.autoZoom の正常系(false)は素通り", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(dir, "{ autoZoom: false }");
    const cfg = loadConfig(path);
    assert.equal(resolvePlanCursorCfg(cfg).autoZoom, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.cursor.autoZoom は真偽値以外を拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanCursor(dir, "{ autoZoom: 1 }");
    assert.throws(() => loadConfig(path), /plan\.cursor\.autoZoom は真偽値で指定してください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* render.zoom.webcamReactiveMinScale(baked ズーム中のワイプ縮小の下限。
 * §docs/plans/2026-07-24-openscreen-d3-zoom-look-and-feel-design.md 系) */
/* ------------------------------------------------------------------ */

function writeMinimalConfigWithRenderZoom(dir: string, zoomYaml: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/m.bin
  language: ja
detect: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 }
preview: { width: 1280, videoEncoder: videotoolbox }
render:
  wipeWidthPx: 480
  wipeMarginPx: 32
  captionFontSizePx: 52
  chapterCardSec: 3
  targetLufs: -14
  zoom: ${zoomYaml}
editor: { maxUploadMb: 2048, defaultImageDurationSec: 4, defaultShortRangeSec: 10 }
planShorts: { maxDurationSec: 60 }
llm: { backend: claude-cli, model: x }
`,
  );
  return path;
}

test("loadConfig: render.zoom.webcamReactiveMinScale の正常系は素通り", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithRenderZoom(dir, "{ webcamReactiveMinScale: 0.55 }");
    const cfg = loadConfig(path);
    assert.equal(cfg.render.zoom?.webcamReactiveMinScale, 0.55);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: render.zoom.webcamReactiveMinScale は 0 より大きく 1 以下でなければ拒否される", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithRenderZoom(dir, "{ webcamReactiveMinScale: 0 }");
    assert.throws(() => loadConfig(path), /render\.zoom\.webcamReactiveMinScale は 0 より大きく 1 以下の数値です/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: render.zoom.webcamReactiveMinScale は 1 を超えると拒否される", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithRenderZoom(dir, "{ webcamReactiveMinScale: 1.5 }");
    assert.throws(() => loadConfig(path), /render\.zoom\.webcamReactiveMinScale は 0 より大きく 1 以下の数値です/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* P3-4: plan.reasonIds.pattern(収録タイプの選択注入)                     */
/* ------------------------------------------------------------------ */

test("resolveReasonIdsCfg: plan.reasonIds 省略時は off+pattern既定 general(バイト等価)", () => {
  assert.deepEqual(resolveReasonIdsCfg({} as Config), { enabled: false, pattern: "general" });
});

test("resolveReasonIdsCfg: pattern 明示値(tool-demo)をそのまま解決する", () => {
  assert.deepEqual(resolveReasonIdsCfg({ plan: { reasonIds: { enabled: true, pattern: "tool-demo" } } } as Config), {
    enabled: true,
    pattern: "tool-demo",
  });
});

test("resolveReasonIdsCfg: 未知の pattern は warn して general へ劣化する(前提エラーで止めない)", () => {
  const warns: string[] = [];
  const result = resolveReasonIdsCfg({ plan: { reasonIds: { enabled: true, pattern: "nonexistent" } } } as Config, (m) =>
    warns.push(m),
  );
  assert.deepEqual(result, { enabled: true, pattern: "general" });
  assert.ok(warns.some((w) => w.includes("nonexistent")));
});

test("resolveReasonIdsCfg: warn を渡さなければ黙って(例外を投げず)general へ劣化する", () => {
  assert.deepEqual(resolveReasonIdsCfg({ plan: { reasonIds: { pattern: "bogus" } } } as Config), {
    enabled: false,
    pattern: "general",
  });
});

function writeMinimalConfigWithPlanReasonIds(dir: string, reasonIdsYaml: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/m.bin
  language: ja
detect: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 }
preview: { width: 1280, videoEncoder: videotoolbox }
render:
  wipeWidthPx: 480
  wipeMarginPx: 32
  wipeTransitionSec: 0.3
  cutTransition: { type: none, sec: 0.3 }
  captionFontSizePx: 52
  captionColor: "#fff"
  captionOutlineColor: "#000"
  captionFontFamily: sans-serif
  captionFontWeight: 700
  chapterCardSec: 3
  targetLufs: -14
  systemAudio: { mix: true, volumeDb: 0 }
  denoise: { mic: false, noiseFloorDb: -25 }
  bgm: { volumeDb: -22, fadeOutSec: 2, ducking: { duckDb: -8, fadeSec: 0.4 } }
  hardwareAcceleration: if-possible
  chunkSec: 15
  zoom: { easeSec: 0.4 }
editor: { maxUploadMb: 2048, defaultImageDurationSec: 4, defaultShortRangeSec: 10 }
planShorts: { maxDurationSec: 60 }
llm: { backend: claude-cli, model: x }
plan:
  reasonIds: ${reasonIdsYaml}
`,
  );
  return path;
}

test("loadConfig: plan.reasonIds の正常系(enabled/pattern)は素通り", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanReasonIds(dir, "{ enabled: true, pattern: tool-demo }");
    const cfg = loadConfig(path);
    assert.deepEqual(resolveReasonIdsCfg(cfg), { enabled: true, pattern: "tool-demo" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.reasonIds の未知キーは拒否される", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanReasonIds(dir, "{ enabled: true, foo: 1 }");
    assert.throws(() => loadConfig(path), /plan\.reasonIds\.foo は未対応です/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.reasonIds.pattern は文字列以外を拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanReasonIds(dir, "{ pattern: 123 }");
    assert.throws(() => loadConfig(path), /plan\.reasonIds\.pattern は文字列で指定してください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan.reasonIds.pattern に未知の収録タイプ文字列を書いても loadConfig 自体は止まらない(劣化は resolve 時)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = writeMinimalConfigWithPlanReasonIds(dir, "{ enabled: true, pattern: nonexistent-type }");
    const cfg = loadConfig(path);
    // loadConfig 自体は例外を投げない(前提エラーで止めない)。値の妥当性検査
    // (未知の収録タイプ → "general" へ劣化)は resolveReasonIdsCfg の責務
    assert.deepEqual(resolveReasonIdsCfg(cfg), { enabled: true, pattern: "general" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDescribePausesCfg: describe 省略時は無効+既定値", () => {
  assert.deepEqual(resolveDescribePausesCfg({} as Config), {
    enabled: false,
    max: DEFAULT_DESCRIBE_PAUSE_MAX,
    minSec: DEFAULT_DESCRIBE_PAUSE_MIN_SEC,
  });
  assert.equal(DEFAULT_DESCRIBE_PAUSE_MAX, 3);
  assert.equal(DEFAULT_DESCRIBE_PAUSE_MIN_SEC, 0.6);
});

test("resolveDescribePausesCfg: 部分指定で他は既定のまま", () => {
  assert.deepEqual(
    resolveDescribePausesCfg({ describe: { pauses: true } } as Config),
    { enabled: true, max: DEFAULT_DESCRIBE_PAUSE_MAX, minSec: DEFAULT_DESCRIBE_PAUSE_MIN_SEC },
  );
  assert.deepEqual(
    resolveDescribePausesCfg({ describe: { pauses: true, pauseMax: 5, pauseMinSec: 1.2 } } as Config),
    { enabled: true, max: 5, minSec: 1.2 },
  );
});

test("resolveAiCfg: ai.provider を優先する", () => {
  assert.deepEqual(
    resolveAiCfg({ ai: { provider: "codex" } } as Config),
    { provider: "codex", model: "auto" },
  );
  assert.deepEqual(
    resolveAiCfg({
      ai: { provider: "openai", model: "gpt-x" },
      llm: { backend: "claude-cli", model: "" },
    } as Config),
    { provider: "openai", model: "gpt-x" },
  );
});

test("resolveAiCfg: 旧 llm 設定を互換解決する", () => {
  assert.deepEqual(
    resolveAiCfg({ llm: { backend: "claude-cli", model: "" } } as Config),
    { provider: "claude-code", model: "auto" },
  );
  assert.deepEqual(
    resolveAiCfg({ llm: { backend: "api", model: "claude-x" } } as Config),
    { provider: "anthropic", model: "claude-x" },
  );
});

test("resolveAiRuntimeConfig: ai/llm 未設定の既定は CLI ではなく API(env の鍵で選ぶ)", () => {
  const anthropic = resolveAiRuntimeConfig({} as Config, { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" });
  assert.equal(anthropic.source, "default");
  assert.deepEqual(anthropic.routes, { text: "legacy-default", structured: "legacy-default", vision: "legacy-default" });
  const anthropicProfile = anthropic.profiles.get("legacy-default")!;
  assert.equal(anthropicProfile.adapter, "anthropic");
  assert.equal(anthropicProfile.model, DEFAULT_AI_CANDIDATES[0]!.model);
  assert.equal(anthropicProfile.capabilities.imageInput, true);

  // ANTHROPIC が無ければ次の候補(openai)へ落ちる
  const openai = resolveAiRuntimeConfig({} as Config, { OPENAI_API_KEY: "y" });
  assert.equal(openai.source, "default");
  assert.equal(openai.profiles.get("legacy-default")!.adapter, "openai");
  assert.equal(openai.profiles.get("legacy-default")!.model, DEFAULT_AI_CANDIDATES[1]!.model);

  // 空文字の鍵は「無い」と同じ扱い
  assert.equal(resolveAiRuntimeConfig({} as Config, { ANTHROPIC_API_KEY: "  " }).source, "unconfigured");
});

test("resolveAiRuntimeConfig: 鍵が1つも無ければ unconfigured(投げずに知覚系は劣化する)", () => {
  const runtime = resolveAiRuntimeConfig({} as Config, {});
  assert.equal(runtime.source, "unconfigured");
  // VLM 経路は「AI 無し」として決定論のみへ落ちる(例外にしない)
  assert.equal(aiCapabilities({} as Config, "vision", {}), null);
  assert.equal(planHarnessEnabled({ plan: { harness: { agentic: true } } } as Config, {}), false);
});

test("resolveAiRuntimeConfig: 明示設定は env より優先される(CLI も従来どおり選べる)", () => {
  const runtime = resolveAiRuntimeConfig(
    { ai: { provider: "claude-code" } } as Config,
    { ANTHROPIC_API_KEY: "x" },
  );
  assert.equal(runtime.source, "legacy-ai");
  assert.equal(runtime.profiles.get("legacy-default")!.adapter, "claude-code");
});

test("resolveAiRuntimeConfig: routed ai config を route/profile へ解決する", () => {
  const runtime = resolveAiRuntimeConfig({
    ai: {
      profiles: {
        local: {
          adapter: "openai-compatible",
          protocol: "chat-completions",
          baseUrl: "http://127.0.0.1:11434/v1/",
          model: "qwen-local",
          auth: { type: "none" },
          capabilities: { structuredOutput: "json-object", imageInput: false },
        },
        vision: {
          adapter: "openai",
          model: "gpt-vision",
        },
      },
      routes: { text: "local", structured: "local", vision: "vision" },
    },
  } as Config);
  assert.equal(runtime.source, "routed");
  assert.equal(runtime.routes.text, "local");
  assert.equal(runtime.routes.vision, "vision");
  assert.equal(runtime.profiles.get("local")?.protocol, "chat-completions");
  assert.equal(runtime.profiles.get("local")?.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(runtime.profiles.get("local")?.capabilities.structuredOutput, "json-object");
  assert.equal(runtime.profiles.get("local")?.maxOutputTokens, DEFAULT_AI_MAX_OUTPUT_TOKENS);
  assert.equal(runtime.profiles.get("vision")?.capabilities.imageInput, true);
  assert.equal(runtime.profiles.get("vision")?.capabilities.maxImages, MAX_AI_IMAGES);
});

test("resolveAiRuntimeConfig: openai-compatible は capability 明示必須", () => {
  assert.throws(
    () => resolveAiRuntimeConfig({
      ai: {
        profiles: {
          local: {
            adapter: "openai-compatible",
            protocol: "chat-completions",
            baseUrl: "http://127.0.0.1:8000/v1",
            auth: { type: "none" },
          },
        },
        routes: { text: "local", structured: "local" },
      },
    } as Config),
    /structuredOutput/,
  );
});

test("aiCapabilities: vision route 未設定なら null、設定なら capability を返す", () => {
  // 既定は env の鍵で決まるので、鍵無しの環境を明示して未設定側を固定する
  assert.equal(aiCapabilities({} as Config, "vision", {}), null);
  assert.equal(aiCapabilities({ ai: { provider: "claude-code" } } as Config, "vision"), null);
  const caps = aiCapabilities({
    ai: {
      profiles: {
        main: { adapter: "anthropic", model: "claude-x" },
      },
      routes: { text: "main", structured: "main", vision: "main" },
    },
  } as Config, "vision");
  assert.equal(caps?.imageInput, true);
  assert.equal(caps?.structuredOutput, "native-json-schema");
});

test("loadConfig: whisper.systemAudio 省略時は false へ defaulting・cfg.describe は生成しない(バイト等価)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/m.bin
  language: ja
detect: { silenceDb: -35, minSilenceSec: 0.7, padSec: 0.15, minKeepSec: 0.5 }
preview: { width: 1280, videoEncoder: videotoolbox }
render:
  wipeWidthPx: 480
  wipeMarginPx: 32
  wipeTransitionSec: 0.3
  cutTransition: { type: none, sec: 0.3 }
  captionFontSizePx: 52
  captionColor: "#fff"
  captionOutlineColor: "#000"
  captionFontFamily: sans-serif
  captionFontWeight: 700
  chapterCardSec: 3
  targetLufs: -14
  systemAudio: { mix: true, volumeDb: 0 }
  denoise: { mic: false, noiseFloorDb: -25 }
  bgm: { volumeDb: -22, fadeOutSec: 2, ducking: { duckDb: -8, fadeSec: 0.4 } }
  hardwareAcceleration: if-possible
  chunkSec: 15
  zoom: { easeSec: 0.4 }
editor: { maxUploadMb: 2048, defaultImageDurationSec: 4, defaultShortRangeSec: 10 }
planShorts: { maxDurationSec: 60 }
llm: { backend: claude-cli, model: x }
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.whisper.systemAudio, false);
    assert.equal(cfg.describe, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: plan 省略時は cfg.plan が undefined のまま(defaulting しない=バイト等価)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-config-"));
  try {
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      `recordingsDir: ~/Movies/framewright
whisper:
  bin: whisper-cli
  model: ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin
  language: ja
`,
    );
    const cfg = loadConfig(path);
    assert.equal(cfg.plan, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAvCfg: 省略時は既定、指定時は上書き", () => {
  assert.deepEqual(resolveAvCfg({} as Config), {
    everySec: DEFAULT_AV_EVERY_SEC,
    cols: DEFAULT_AV_COLS,
    windowSec: 1,
    scdetThreshold: 8,
    freeze: { noiseDb: -50, durationSec: 1 },
    stripWidthPx: 320,
  });
  assert.deepEqual(
    resolveAvCfg({ av: { everySec: 2, cols: 4, freeze: { noiseDb: -40 } } } as Config),
    {
      everySec: 2,
      cols: 4,
      windowSec: 1,
      scdetThreshold: 8,
      freeze: { noiseDb: -40, durationSec: 1 },
      stripWidthPx: 320,
    },
  );
});

test("resolveLogCfg: log 省略時は既定 normal", () => {
  assert.deepEqual(resolveLogCfg({} as Config), { level: DEFAULT_LOG_LEVEL });
  assert.equal(DEFAULT_LOG_LEVEL, "normal");
});

test("resolveLogCfg: 指定値を尊重する", () => {
  assert.deepEqual(resolveLogCfg({ log: { level: "verbose" } } as Config), { level: "verbose" });
  assert.deepEqual(resolveLogCfg({ log: { level: "quiet" } } as Config), { level: "quiet" });
});

test("resolveLogCfg: 不正値は既定 normal へフォールバック", () => {
  assert.deepEqual(
    resolveLogCfg({ log: { level: "bogus" as unknown as "normal" } } as Config),
    { level: "normal" },
  );
});

test("syncEditorCfgFromYaml: 外部編集ぶん(パッチ外のキー)も反映される", () => {
  const cfg = parse(RAW) as Config;
  // エディタ起動中に config.yaml が外部編集され wipeMarginPx が変わったと想定。
  // その YAML にパッチ(preview.width)を当てた結果を取り込むと、パッチ外の
  // 外部編集ぶん(wipeMarginPx)もメモリへ反映される
  const externallyEdited = RAW.replace("wipeMarginPx: 32", "wipeMarginPx: 64");
  const nextYaml = applyConfigEdits(externallyEdited, { preview: { width: 960 } });
  syncEditorCfgFromYaml(cfg, nextYaml);
  assert.equal(cfg.preview.width, 960);
  assert.equal(cfg.render.wipeMarginPx, 64);
});

test("config.minimal.yaml は loadConfig で読めて必須セクションが揃う", () => {
  const p = join(import.meta.dirname, "..", "config.minimal.yaml");
  const cfg = loadConfig(p);
  assert.ok(cfg.recordingsDir);
  assert.equal(typeof cfg.ingest.micTrack, "number");
  assert.ok(cfg.ingest.screenRegion && cfg.ingest.cameraRegion);
  assert.ok(cfg.whisper.model && cfg.whisper.bin);
  assert.equal(typeof cfg.detect.silenceDb, "number");
  assert.equal(typeof cfg.preview.width, "number");
  assert.equal(typeof cfg.render.targetLufs, "number");
  assert.equal(typeof cfg.render.bgm.volumeDb, "number");
  // 任意調整セクションを省いても resolve* が既定を返す(crash しない)
  assert.equal(resolvePerceptionCfg(cfg).audio, false);
  assert.equal(cfg.whisper.wordTimestamps, true); // loadConfig の ??= true が効く
});

// ---- 収録ルートの接続状態(未接続の外付けを「エラー」にしない) ----

test("recordingRootState: 実在するルートは present", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-root-"));
  try {
    assert.equal(recordingRootState(dir), "present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordingRootState: 未作成でも書ける親の下なら creatable(初回起動でそのまま作る)", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-root-"));
  try {
    assert.equal(recordingRootState(join(dir, "framewright")), "creatable");
    // 数段深くても、実在する直近の祖先が書ければ creatable
    assert.equal(recordingRootState(join(dir, "a", "b", "framewright")), "creatable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordingRootState: 書けない親の下(未マウントのマウント点相当)は disconnected", (t) => {
  // /Volumes 直下に mkdir できないのと同じ状況を、書き込み不可の親で再現する。
  // root で実行すると W_OK が常に通ってしまうので、その場合だけスキップ
  if (process.getuid?.() === 0) return t.skip("root ではパーミッション判定にならない");
  const dir = mkdtempSync(join(tmpdir(), "framewright-root-"));
  try {
    chmodSync(dir, 0o500);
    assert.equal(recordingRootState(join(dir, "USB_LABEL", "framewright")), "disconnected");
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
