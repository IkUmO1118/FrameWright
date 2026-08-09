import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/lib/config.ts";
import { loadConfig } from "../src/lib/config.ts";
import { validate } from "../src/stages/validate.ts";
import { executeClean, planCleanWithRemuxDup } from "../src/stages/clean.ts";
import {
  buildDerivedCutplan,
  deriveProject,
  parseDeriveRange,
  transferDerivedSource,
} from "../src/stages/derive.ts";
import type { Manifest } from "../src/types.ts";

test("derive range: parse・逆順入力・重複を正規化し全尺を連続被覆する", () => {
  assert.deepEqual(parseDeriveRange("120-165.5"), { start: 120, end: 165.5 });
  const plan = buildDerivedCutplan(100, [
    { start: 40, end: 60 },
    { start: 10, end: 30 },
    { start: 25, end: 45 },
  ]);
  assert.equal("generatedBy" in plan, false);
  assert.deepEqual(plan.segments, [
    { action: "cut", start: 0, end: 10, reason: "派生プロジェクト: 範囲外" },
    { action: "keep", start: 10, end: 60, reason: "derive --range" },
    { action: "cut", start: 60, end: 100, reason: "派生プロジェクト: 範囲外" },
  ]);
  assert.throws(() => buildDerivedCutplan(10, []), /range/);
  assert.throws(() => buildDerivedCutplan(10, [{ start: 8, end: 11 }]), /尺/);
});

test("source transfer: symlink → hardlink → copy の順でフォールバックする", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-derive-transfer-"));
  try {
    const source = join(root, "raw.mp4");
    writeFileSync(source, "media");
    const calls: string[] = [];
    const result = transferDerivedSource(source, join(root, "derived.mp4"), {
      symlink: (() => { calls.push("symlink"); throw new Error("no symlink"); }) as never,
      hardlink: (() => { calls.push("hardlink"); throw new Error("no hardlink"); }) as never,
      copy: ((a: string, b: string) => { calls.push("copy"); copyFileSync(a, b); }) as never,
    });
    assert.equal(result, "copy");
    assert.deepEqual(calls, ["symlink", "hardlink", "copy"]);
    assert.equal(readFileSync(join(root, "derived.mp4"), "utf8"), "media");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derive source symlink: clean/remux計画は元メディアlinkを絶対に対象にしない", async () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-derive-clean-"));
  try {
    const original = join(root, "original");
    const derived = join(root, "derived");
    mkdirSync(original);
    mkdirSync(derived);
    writeFileSync(join(original, "raw.mkv"), "source-media");
    symlinkSync("../original/raw.mkv", join(derived, "raw.mkv"));
    writeFileSync(join(derived, "manifest.json"), JSON.stringify({ source: "raw.mkv" }));

    const plan = await planCleanWithRemuxDup(derived);
    assert.equal(plan.targets.some((target) => target.relPath === "raw.mkv"), false);
    executeClean(derived, plan);
    assert.equal(existsSync(join(derived, "raw.mkv")), true);
    assert.equal(readFileSync(join(derived, "raw.mkv"), "utf8"), "source-media");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveProject: transcript無しの元は派生先mkdir前に拒否する", async () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-derive-no-transcript-"));
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "raw.mp4"), "media");
  writeFileSync(join(sourceDir, "manifest.json"), JSON.stringify({
    dir: sourceDir,
    source: "raw.mp4",
    durationSec: 10,
    layout: "plain",
    video: { width: 1, height: 1, fps: 30, screenRegion: { x: 0, y: 0, w: 1, h: 1 } },
    audio: { micStream: 0, systemStream: null, micWav: "audio/mic.wav" },
    createdAt: new Date(0).toISOString(),
  }));
  const destination = join(root, "derived");
  try {
    await assert.rejects(
      () => deriveProject({ sourceDir, name: "derived", canvas: "portrait", ranges: [{ start: 1, end: 2 }], cfg: loadConfig() }),
      /transcript\.json/,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveProject: 必要な入力だけを引き継ぎ、派生先が validate を通る", async () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-derive-project-"));
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir);
  const fixture = join(process.cwd(), "test/fixtures/engine/parity-project");
  copyFileSync(join(fixture, "raw.mp4"), join(sourceDir, "raw.mp4"));
  copyFileSync(join(fixture, "transcript.json"), join(sourceDir, "transcript.json"));
  const sourceManifest = JSON.parse(readFileSync(join(fixture, "manifest.json"), "utf8")) as Manifest;
  writeFileSync(join(sourceDir, "manifest.json"), JSON.stringify({ ...sourceManifest, dir: sourceDir }, null, 2));
  for (const file of ["overlays.json", "bgm.json", "chapters.json", "meta.json", "approvals.json"]) {
    writeFileSync(join(sourceDir, file), "{}");
  }
  const cfg = loadConfig();
  try {
    const result = await deriveProject({
      sourceDir,
      name: "portrait-cut",
      canvas: "portrait",
      ranges: [{ start: 2, end: 8 }],
      cfg,
    }, {
      ingest: (async (dir: string, source: string, _cfg: Config, layout: Manifest["layout"], _tracks: unknown, canvas: string) => {
        const manifest = { ...sourceManifest, dir, source, layout, canvas } as Manifest;
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
        return manifest;
      }) as never,
    });
    assert.equal(existsSync(join(result.dir, "transcript.json")), true);
    assert.equal(existsSync(join(result.dir, "cutplan.json")), true);
    const derivedManifest = JSON.parse(readFileSync(join(result.dir, "manifest.json"), "utf8")) as Manifest;
    assert.deepEqual(derivedManifest.derivedFrom, {
      name: "source",
      ranges: [{ start: 2, end: 8 }],
    });
    for (const file of ["overlays.json", "bgm.json", "chapters.json", "meta.json", "approvals.json"]) {
      assert.equal(existsSync(join(result.dir, file)), false, `${file} must not be inherited`);
    }
    assert.equal(validate(result.dir, cfg).errors.length, 0);
    await assert.rejects(() => deriveProject({ sourceDir, name: "portrait-cut", canvas: "portrait", ranges: [{ start: 2, end: 8 }], cfg }), /既に存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
