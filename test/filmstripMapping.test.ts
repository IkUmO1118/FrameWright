import { strict as assert } from "node:assert";
import test from "node:test";
import { tileSourceSec, visibleTileRange } from "../src/lib/thumbstrip.ts";

test("フィルムストリップ: speed=1 のクリップでタイル中央が元収録秒へ写る", () => {
  assert.equal(
    tileSourceSec({ srcStart: 100, speed: 1, pps: 10, dispW: 50, k: 0 }),
    102.5,
  );
});

test("フィルムストリップ: speed=2 のクリップは元収録秒が倍速で進む", () => {
  assert.equal(
    tileSourceSec({ srcStart: 100, speed: 2, pps: 10, dispW: 50, k: 0 }),
    105,
  );
});

test("フィルムストリップ: 可視窓の外のタイル番号を作らない", () => {
  assert.deepEqual(
    visibleTileRange({
      clipOutStart: 100,
      clipW: 1000,
      pps: 10,
      dispW: 50,
      winStart: 110,
      winEnd: 120,
    }),
    { k0: 2, k1: 4 },
  );
  assert.equal(
    visibleTileRange({
      clipOutStart: 100,
      clipW: 1000,
      pps: 10,
      dispW: 50,
      winStart: 250,
      winEnd: 260,
    }),
    null,
  );
});
