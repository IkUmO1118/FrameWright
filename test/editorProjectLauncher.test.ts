import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HttpError,
  createProjectDirectory,
  findRecordingRoot,
  listProjectsAcrossRoots,
  listProjects,
  normalizeProjectName,
  resolveLauncherProject,
} from "../editor/server.ts";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("project launcher: 直下ディレクトリを列挙し共有/hiddenを除外する", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-launcher-"));
  try {
    for (const name of ["empty", "ready", "hyperframe-seeds", "style.probe", ".hidden"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "ready", "manifest.json"), JSON.stringify({ durationSec: 42, canvas: "portrait" }));
    writeFileSync(join(root, "ready", "final.mp4"), "done");
    const projects = listProjects(root, "main");
    assert.deepEqual(projects.map((p) => p.name).sort(), ["empty", "ready"]);
    const empty = projects.find((p) => p.name === "empty")!;
    assert.equal(empty.hasManifest, false);
    assert.equal(empty.durationSec, null);
    assert.equal(empty.canvas, "landscape");
    const ready = projects.find((p) => p.name === "ready")!;
    assert.equal(ready.hasManifest, true);
    assert.equal(ready.durationSec, 42);
    assert.equal(ready.canvas, "portrait");
    assert.equal(ready.rendered, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project launcher: 複数ルートを横断して一覧し、未接続ルートを落とさず警告する", () => {
  const rootA = mkdtempSync(join(tmpdir(), "framewright-launcher-a-"));
  const blocker = mkdtempSync(join(tmpdir(), "framewright-launcher-blocker-"));
  const blockerFile = join(blocker, "not-a-dir");
  writeFileSync(blockerFile, "x");
  const unreachable = join(blockerFile, "framewright");
  try {
    mkdirSync(join(rootA, "talk-a"));
    writeFileSync(join(rootA, "talk-a", "manifest.json"), JSON.stringify({ durationSec: 10, canvas: "landscape" }));
    const result = listProjectsAcrossRoots([
      { key: "main", path: rootA },
      { key: "usb-a", path: unreachable },
    ]);
    assert.deepEqual(result.roots.map((r) => r.key), ["main", "usb-a"]);
    assert.equal(result.roots[0].available, true);
    assert.equal(result.roots[1].available, false);
    assert.ok(result.roots[1].reason);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].root, "main");
    assert.equal(result.projects[0].name, "talk-a");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(blocker, { recursive: true, force: true });
  }
});

test("project launcher: 派生プロジェクトは同一rootの親直下に孫まで並べる", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-launcher-derived-"));
  try {
    for (const name of ["parent", "newer", "child", "grand"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "parent", "manifest.json"), JSON.stringify({ durationSec: 10, canvas: "landscape" }));
    writeFileSync(join(root, "newer", "manifest.json"), JSON.stringify({ durationSec: 10, canvas: "landscape" }));
    writeFileSync(join(root, "child", "manifest.json"), JSON.stringify({
      durationSec: 4,
      canvas: "portrait",
      derivedFrom: { name: "parent", ranges: [{ start: 1, end: 5 }] },
    }));
    writeFileSync(join(root, "grand", "manifest.json"), JSON.stringify({
      durationSec: 2,
      canvas: "square",
      derivedFrom: { name: "child", ranges: [{ start: 2, end: 4 }] },
    }));
    const result = listProjectsAcrossRoots([{ key: "main", path: root }]);
    const names = result.projects.map((p) => p.name);
    assert.equal(names.indexOf("child"), names.indexOf("parent") + 1);
    assert.equal(names.indexOf("grand"), names.indexOf("child") + 1);
    assert.equal(result.projects.find((p) => p.name === "child")?.derivedFrom, "parent");
    assert.equal(result.projects.find((p) => p.name === "grand")?.derivedFrom, "child");
    assert.equal(result.projects.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project launcher: 派生の循環参照でもプロジェクトを消さない", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-launcher-cycle-"));
  try {
    for (const name of ["a", "b"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "a", "manifest.json"), JSON.stringify({
      durationSec: 10,
      canvas: "landscape",
      derivedFrom: { name: "b", ranges: [{ start: 1, end: 5 }] },
    }));
    writeFileSync(join(root, "b", "manifest.json"), JSON.stringify({
      durationSec: 10,
      canvas: "landscape",
      derivedFrom: { name: "a", ranges: [{ start: 2, end: 6 }] },
    }));
    const result = listProjectsAcrossRoots([{ key: "main", path: root }]);
    assert.deepEqual(result.projects.map((p) => p.name).sort(), ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project launcher: findRecordingRoot は未知キーを 404 で拒否する", () => {
  const roots = [{ key: "main", path: "/tmp/a" }, { key: "usb-a", path: "/tmp/b" }];
  assert.equal(findRecordingRoot(roots, "usb-a").path, "/tmp/b");
  assert.throws(() => findRecordingRoot(roots, "nope"), (e) => e instanceof HttpError && e.status === 404);
});

test("project launcher: 新規作成は正規化し、衝突と traversal を拒否する", () => {
  const root = mkdtempSync(join(tmpdir(), "framewright-launcher-create-"));
  try {
    assert.equal(normalizeProjectName("../bad:name"), "bad_name");
    const created = createProjectDirectory(root, { name: "../bad:name", canvas: "square", layout: "plain" });
    assert.equal(created.name, "bad_name");
    assert.throws(() => createProjectDirectory(root, { name: "bad_name", canvas: "square" }), (e) => e instanceof HttpError && e.status === 409);
    for (const name of ["../outside", "/tmp/outside", "a/b", ".hidden"]) {
      assert.throws(() => resolveLauncherProject(root, name), HttpError);
    }
    assert.equal(resolveLauncherProject(root, "safe"), join(root, "safe"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project creation UI hides baseLayout inputs while API helpers keep defaulted signatures", () => {
  const app = read("editor/client/App.tsx");
  const widgets = read("editor/client/widgets.tsx");
  const panels = read("editor/client/Panels.tsx");

  assert.doesNotMatch(app, /aria-label="ベース配置"/);
  assert.doesNotMatch(app, /window\.prompt\("ベース配置/);
  assert.doesNotMatch(app, /initialBaseLayoutFromSearch/);
  assert.doesNotMatch(app, /baseLayout=\$\{encodeURIComponent\(baseLayout\)\}/);
  assert.match(app, /createProject\(name\.trim\(\), canvas, "auto", "plain", effectiveRoot\)/);
  assert.match(app, /postBaseMedia\(file, baseCanvas\)/);
  assert.match(app, /uploadBaseMedia\(file, baseCanvas\)/);
  assert.match(app, /postDerive\(name, canvas, \[\{ start: segment\.start, end: segment\.end \}\]\)/);

  assert.match(widgets, /createProject\(\s*name: string,\s*canvas: string,\s*baseLayout = "auto",\s*layout = "plain",\s*root\?: string,\s*\)/);
  assert.match(widgets, /postDerive\(name: string, canvas: string, ranges: Array<\{ start: number; end: number \}>, baseLayout = "auto"\)/);
  assert.match(widgets, /postBaseMedia\(file: string, canvas: string, baseLayout = "auto"\)/);
  assert.match(widgets, /uploadBaseMedia\(file: File, canvas: string, baseLayout = "auto"\)/);

  assert.match(app, /baseLayout=\{proj\.manifest\.baseLayout \?\? "auto"\}/);
  assert.match(panels, /<span className="ocSettingsLabel">ベース配置<\/span>/);
  assert.match(panels, /<span className="ocSettingsValue mono">\{baseLayout\}<\/span>/);
});

test("project launcher: 未接続ルートは探しに行かず「未接続」として返す(生の EACCES を見せない)", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ではパーミッション判定にならない");
  const rootA = mkdtempSync(join(tmpdir(), "framewright-launcher-ok-"));
  // 書き込み不可の親 = 未マウントのマウント点(/Volumes 直下)相当
  const mountBase = mkdtempSync(join(tmpdir(), "framewright-launcher-mount-"));
  try {
    mkdirSync(join(rootA, "talk-a"));
    chmodSync(mountBase, 0o500);
    const result = listProjectsAcrossRoots([
      { key: "main", path: rootA },
      { key: "usb-siro1", path: join(mountBase, "USB_SIRO1", "framewright") },
    ]);
    assert.equal(result.roots[0].available, true);
    assert.equal(result.roots[1].available, false);
    assert.equal(result.roots[1].reason, "未接続(マウントされていません)");
    // 未接続でも一覧そのものは成功し、繋がっているルートは普通に出る
    assert.deepEqual(result.projects.map((p) => p.name), ["talk-a"]);
  } finally {
    chmodSync(mountBase, 0o700);
    rmSync(rootA, { recursive: true, force: true });
    rmSync(mountBase, { recursive: true, force: true });
  }
});
