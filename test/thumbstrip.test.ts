import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildThumbstripFilter,
  planThumbstrip,
  sheetCellFor,
  sheetFileName,
  thumbIndexForSourceSec,
  THUMBSTRIP_MAX_SHEETS,
  tileRefForSourceSec,
} from "../src/lib/thumbstrip.ts";

test("planThumbstrip: 尺と間隔からタイル数とシート分割を決める", () => {
  const level = planThumbstrip({
    durationSec: 600,
    intervalSec: 10,
    columns: 10,
    rows: 10,
    tileWidth: 160,
    tileHeight: 90,
  });
  assert.equal(level.count, 60);
  assert.equal(level.format, "webp");
  assert.deepEqual(level.sheets, [
    { file: "timeline.probe/thumbstrip/coarse-000.webp", startIndex: 0, count: 60 },
  ]);
});

test("planThumbstrip: format=jpeg なら jpg シートを返す", () => {
  const level = planThumbstrip({
    durationSec: 600,
    intervalSec: 10,
    columns: 10,
    rows: 10,
    tileWidth: 160,
    tileHeight: 90,
    format: "jpeg",
  });
  assert.equal(level.format, "jpeg");
  assert.deepEqual(level.sheets, [
    { file: "timeline.probe/thumbstrip/coarse-000.jpg", startIndex: 0, count: 60 },
  ]);
});

test("planThumbstrip: シート境界でちょうど割り切れる", () => {
  const base = {
    intervalSec: 10,
    columns: 10,
    rows: 10,
    tileWidth: 160,
    tileHeight: 90,
  };
  const exact = planThumbstrip({ ...base, durationSec: 1000 });
  assert.equal(exact.count, 100);
  assert.equal(exact.sheets.length, 1);
  assert.equal(exact.sheets[0].count, 100);

  const overflow = planThumbstrip({ ...base, durationSec: 1010 });
  assert.equal(overflow.count, 101);
  assert.equal(overflow.sheets.length, 2);
  assert.equal(overflow.sheets[0].count, 100);
  assert.equal(overflow.sheets[1].count, 1);
});

test("planThumbstrip: MAX_SHEETS を超える尺では間隔を引き伸ばす", () => {
  const level = planThumbstrip({
    durationSec: 100000,
    intervalSec: 10,
    columns: 10,
    rows: 10,
    tileWidth: 160,
    tileHeight: 90,
  });
  assert.ok(level.sheets.length <= THUMBSTRIP_MAX_SHEETS);
  assert.ok(level.intervalSec > 10);
});

test("planThumbstrip: 尺 0 でも 1 タイルを返す", () => {
  const level = planThumbstrip({
    durationSec: 0,
    intervalSec: 10,
    columns: 10,
    rows: 10,
    tileWidth: 160,
    tileHeight: 90,
  });
  assert.equal(level.count, 1);
  assert.equal(level.sheets.length, 1);
  assert.equal(level.sheets[0].count, 1);
});

test("buildThumbstripFilter: fps→scale→tile を組む", () => {
  assert.equal(
    buildThumbstripFilter({ intervalSec: 10, tileWidth: 160, columns: 10, rows: 10 }),
    "fps=1/10,scale=160:-2,tile=10x10",
  );
});

test("thumbIndexForSourceSec: 秒をタイル番号へ写す", () => {
  const level = planThumbstrip({
    durationSec: 600,
    intervalSec: 10,
    columns: 10,
    rows: 10,
    tileWidth: 160,
    tileHeight: 90,
  });
  assert.equal(thumbIndexForSourceSec(0, level), 0);
  assert.equal(thumbIndexForSourceSec(9.9, level), 0);
  assert.equal(thumbIndexForSourceSec(10, level), 1);
  assert.equal(thumbIndexForSourceSec(-0.1, level), null);
  assert.equal(thumbIndexForSourceSec(600, level), null);
});

test("sheetCellFor: 通し番号をシート・行・列へ分解する", () => {
  const level = planThumbstrip({
    durationSec: 1010,
    intervalSec: 10,
    columns: 10,
    rows: 10,
    tileWidth: 160,
    tileHeight: 90,
  });
  assert.deepEqual(sheetCellFor(0, level), { sheetIndex: 0, col: 0, row: 0 });
  assert.deepEqual(sheetCellFor(9, level), { sheetIndex: 0, col: 9, row: 0 });
  assert.deepEqual(sheetCellFor(10, level), { sheetIndex: 0, col: 0, row: 1 });
  assert.deepEqual(sheetCellFor(100, level), { sheetIndex: 1, col: 0, row: 0 });
  assert.equal(sheetCellFor(101, level), null);
});

test("sheetFileName: 3 桁ゼロ埋め", () => {
  assert.equal(sheetFileName("coarse", 0), "coarse-000.webp");
  assert.equal(sheetFileName("coarse", 0, "jpeg"), "coarse-000.jpg");
});

test("level.id は sheet ファイル名の接頭辞と一致する(段を増やしたときの取りこぼし防止)", () => {
  // stages/thumbstrip.ts の generatedSheets は level.id を接頭辞に ffmpeg 出力を拾う。
  // planThumbstrip 側が別の接頭辞を書くと 0 件になり黙って unavailable へ落ちるので、
  // 両者が同じ id から出ていることをここで固定する
  for (const format of ["webp", "jpeg"] as const) {
    const level = planThumbstrip({
      durationSec: 1010,
      intervalSec: 10,
      columns: 10,
      rows: 10,
      tileWidth: 160,
      tileHeight: 90,
      format,
    });
    for (const sheet of level.sheets) {
      const base = sheet.file.slice(sheet.file.lastIndexOf("/") + 1);
      assert.ok(base.startsWith(`${level.id}-`), `${base} が ${level.id}- で始まらない`);
      assert.match(base, new RegExp(`^${level.id}-\\d{3}\\.(webp|jpg)$`));
    }
  }
});

test("tileRefForSourceSec: source 秒から sheet セル参照を返す", () => {
  const level = planThumbstrip({
    durationSec: 1010,
    intervalSec: 10,
    columns: 10,
    rows: 10,
    tileWidth: 160,
    tileHeight: 90,
  });
  assert.deepEqual(tileRefForSourceSec(1000, level), {
    file: "timeline.probe/thumbstrip/coarse-001.webp",
    col: 0,
    row: 0,
    tileWidth: 160,
    tileHeight: 90,
    columns: 10,
    rows: 10,
  });
  assert.equal(tileRefForSourceSec(1010, level), null);
});
