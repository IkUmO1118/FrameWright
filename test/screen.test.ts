// video-perception-P1 §3.2(C1〜C7)。screen.probe/ の **2層キャッシュ**を固定する。
// C2 と C3 が本 P の設計判断そのもの: 1層キャッシュ実装ではこの2本が必ず落ちる
// (どちらも「全 OCR 再実行」になるため)。
//
// Apple Vision(runOcr)も ffmpeg(buildScreenStill)も実際には呼ばない。
// screen() の deps 引数で注入し、runOcr の**呼び出し回数**を数える。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screen, SCREEN_DIR } from "../src/stages/screen.ts";
import type { ScreenDeps } from "../src/stages/screen.ts";
import type { Config } from "../src/lib/config.ts";
import type { OcrResult } from "../src/lib/ocr.ts";

/** motion.json の1点(sourceSec = outSec の素直な keep 全域を想定) */
function motionSample(sec: number, sceneScore: number) {
  return { outSec: sec, sourceSec: sec, sceneScore };
}

/** サンプル時刻が 0/20/40/60 になる motion.json を書く。
 *  sceneThreshold 0.25 / minGapSec 6 の既定で 20/40 が変化点、0/60 が端点になる */
function writeMotion(dir: string, secs: number[], keepsHash = "hash-A"): void {
  const motion = {
    schemaVersion: 2,
    capturedAt: "2026-08-10T00:00:00.000Z",
    key: { axisGeneration: 2, keepsHash, base: { file: "proxy.mp4", mtimeMs: 1, size: 2 } },
    range: { startSec: 0, endSec: secs[secs.length - 1] },
    base: "proxy",
    strip: { file: "motion.strip.png", cols: 5, rows: 1, tiles: [] },
    // 端点(先頭/末尾)以外は全部 sceneScore 高め=変化点にする
    motion: secs.map((s, i) => motionSample(s, i === 0 || i === secs.length - 1 ? 0.01 : 0.9)),
    frozen: [],
  };
  mkdirSync(join(dir, "av.probe"), { recursive: true });
  writeFileSync(join(dir, "av.probe", "motion.json"), JSON.stringify(motion, null, 2));
}

function makeFixture(secs = [0, 20, 40, 60]): string {
  const dir = mkdtempSync(join(tmpdir(), "framewright-screen-"));
  writeFileSync(join(dir, "raw.mkv"), "fake-source-bytes");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      source: "raw.mkv",
      canvas: "landscape",
      video: { screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
    }),
  );
  writeMotion(dir, secs);
  return dir;
}

/** 各サンプル秒ごとに違う OCR テキストを返す(=境界が立つ)スタブ */
function makeDeps(counter: { runOcr: number; still: number }, opts: { fail?: boolean } = {}): ScreenDeps {
  return {
    buildScreenStill: async (_dir, _manifest, sourceSec, outPath) => {
      counter.still++;
      mkdirSync(join(outPath, ".."), { recursive: true });
      writeFileSync(outPath, `png-${sourceSec}`);
      return outPath;
    },
    runOcr: async (imagePath): Promise<OcrResult | null> => {
      counter.runOcr++;
      if (opts.fail) return null;
      const body = readFileSync(imagePath, "utf8");
      return {
        text: body,
        lines: [{ text: body, confidence: 0.9, box: { x: 0, y: 0, w: 10, h: 10 } }],
        image: { w: 1920, h: 1080 },
      };
    },
  };
}

/** minSegmentSec を小さくして吸収を無効化した config(区間数を素直に見るため)。
 *  av.everySec も下げて「minSegmentSec <= av.everySec」の警告を避ける */
function makeCfg(over: Record<string, unknown> = {}): Config {
  return {
    av: { everySec: 1 },
    screen: { minGapSec: 6, minSegmentSec: 2, maxSamples: 120, ...over },
  } as unknown as Config;
}

function ocrFiles(dir: string): string[] {
  const p = join(dir, SCREEN_DIR, "ocr");
  return existsSync(p) ? readdirSync(p).sort() : [];
}

test("C1: 同じ状態で2回連続実行 → 2回目は runOcr を1回も呼ばない", async () => {
  const dir = makeFixture();
  try {
    const c = { runOcr: 0, still: 0 };
    await screen(dir, {}, makeCfg(), makeDeps(c));
    const first = c.runOcr;
    assert.ok(first > 0, "1回目は OCR が走る");
    await screen(dir, {}, makeCfg(), makeDeps(c));
    assert.equal(c.runOcr, first, "2回目は runOcr を1回も呼ばない(Layer 2 ヒット)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2: mergeThreshold だけを変える → runOcr を1回も呼ばず、区間だけが変わる(Layer 分離の核心)", async () => {
  const dir = makeFixture();
  try {
    const c = { runOcr: 0, still: 0 };
    // mergeThreshold 0.6: 各サンプルの OCR が全部違うので境界が立つ
    const a = await screen(dir, {}, makeCfg({ mergeThreshold: 0.6 }), makeDeps(c));
    const afterFirst = c.runOcr;
    assert.ok(afterFirst > 0);

    // mergeThreshold 0(= どんなに違っても「同一画面」扱い)→ 区間は1件へ畳まれる
    const b = await screen(dir, {}, makeCfg({ mergeThreshold: 0 }), makeDeps(c));
    assert.equal(c.runOcr, afterFirst, "閾値を変えただけで runOcr は1回も呼ばれない(Layer 1 全ヒット)");
    assert.notEqual(a.segments.length, b.segments.length, "区間の畳み方だけが変わる");
    assert.equal(b.segments.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C3: motion.json を差し替えてサンプル時刻を1点だけずらす → その1点だけ runOcr が呼ばれる(Layer 分離の核心)", async () => {
  const dir = makeFixture([0, 20, 40, 60]);
  try {
    const c = { runOcr: 0, still: 0 };
    await screen(dir, {}, makeCfg(), makeDeps(c));
    const afterFirst = c.runOcr;
    assert.equal(afterFirst, 4, "4サンプルぶん OCR が走る");

    // 40 → 41 の1点だけずらす(keepsHash も変えて Layer 2 をミスさせる)
    writeMotion(dir, [0, 20, 41, 60], "hash-B");
    await screen(dir, {}, makeCfg(), makeDeps(c));
    assert.equal(
      c.runOcr - afterFirst,
      1,
      "新しくグリッドに乗った1点だけ OCR が走る(0/20/60 は Layer 1 ヒット)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C4: manifest.source の mtime を変える → Layer 1 が全ミスし全再計算", async () => {
  const dir = makeFixture();
  try {
    const c = { runOcr: 0, still: 0 };
    await screen(dir, {}, makeCfg(), makeDeps(c));
    const afterFirst = c.runOcr;

    // 元収録の mtime を動かす(内容アドレス式キーの source が変わる)
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "raw.mkv"), future, future);
    // Layer 2 もミスさせる(そうしないと index.json のヒットで早期 return する)
    writeMotion(dir, [0, 20, 40, 60], "hash-B");

    await screen(dir, {}, makeCfg(), makeDeps(c));
    assert.equal(c.runOcr - afterFirst, afterFirst, "全サンプルで再 OCR される");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C5: --force で Layer 1・Layer 2 の両方を無視する", async () => {
  const dir = makeFixture();
  try {
    const c = { runOcr: 0, still: 0 };
    await screen(dir, {}, makeCfg(), makeDeps(c));
    const afterFirst = c.runOcr;
    await screen(dir, { force: true }, makeCfg(), makeDeps(c));
    assert.equal(c.runOcr - afterFirst, afterFirst, "--force は両層を無視して全再計算する");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C6: 実行後、今回のサンプルが参照しない ocr/*.json が sweep される", async () => {
  const dir = makeFixture([0, 20, 40, 60]);
  try {
    const c = { runOcr: 0, still: 0 };
    await screen(dir, {}, makeCfg(), makeDeps(c));
    assert.deepEqual(ocrFiles(dir), ["0.00.json", "20.00.json", "40.00.json", "60.00.json"]);

    // サンプル時刻から 40 が消える(= 40.00.json は未参照になる)
    writeMotion(dir, [0, 20, 60], "hash-B");
    await screen(dir, {}, makeCfg(), makeDeps(c));
    assert.deepEqual(ocrFiles(dir), ["0.00.json", "20.00.json", "60.00.json"], "未参照の 40.00.json が消える");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C7: ocr/*.json は実行のたびに全消しされない(frames/ とは違う。C1 の前提)", async () => {
  const dir = makeFixture();
  try {
    const c = { runOcr: 0, still: 0 };
    await screen(dir, {}, makeCfg(), makeDeps(c));
    const before = ocrFiles(dir);
    assert.ok(before.length > 0);
    // 閾値だけを変えて再実行しても Layer 1 のファイルは残り続ける
    await screen(dir, {}, makeCfg({ mergeThreshold: 0 }), makeDeps(c));
    assert.deepEqual(ocrFiles(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OCR 非対応環境: runOcr が null でも区間は成立し ocrAvailable=false になる", async () => {
  const dir = makeFixture();
  try {
    const c = { runOcr: 0, still: 0 };
    const index = await screen(dir, {}, makeCfg(), makeDeps(c, { fail: true }));
    assert.equal(index.ocrAvailable, false);
    assert.ok(index.segments.length > 0, "sceneScore だけで区間トラックは成立する");
    assert.equal(index.segments[0].ocr, null);
    assert.deepEqual(ocrFiles(dir), [], "OCR できなかった秒は Layer 1 に書かない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summary は P1 では常に null(P4 のための予約)", async () => {
  const dir = makeFixture();
  try {
    const index = await screen(dir, {}, makeCfg(), makeDeps({ runOcr: 0, still: 0 }));
    for (const seg of index.segments) assert.equal(seg.summary, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
