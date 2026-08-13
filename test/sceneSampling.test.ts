// video-perception-P0 §3.1(T1〜T15)。av.probe/motion.json の motion[]/frozen[]
// から「画面変化+静止区間代表+端点」の時刻リストを選ぶ純関数 selectSceneTimes
// を固定する。T3・T10・T11・T14 は素朴な実装が落ちるように置かれている
// (docs/plans/2026-08-10-video-perception-p0-scene-sampling-design.md §3.1)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCENE_SAMPLING_CFG,
  selectSceneTimes,
} from "../src/lib/sceneSampling.ts";
import type { SceneSamplingCfg, SceneSamplingInput } from "../src/lib/sceneSampling.ts";

const range = { startSec: 0, endSec: 100 };

function cfg(overrides: Partial<SceneSamplingCfg> = {}): SceneSamplingCfg {
  return { ...DEFAULT_SCENE_SAMPLING_CFG, ...overrides };
}

test("T1: 変化点が sceneThreshold 未満だけの入力 → edge 2枚 + frozen のみ", () => {
  const input: SceneSamplingInput = {
    range,
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0.1 },
      { outSec: 5, sourceSec: 5, sceneScore: 0.1 },
      { outSec: 10, sourceSec: 10, sceneScore: 0.1 },
      { outSec: 15, sourceSec: 15, sceneScore: 0.1 },
      { outSec: 20, sourceSec: 20, sceneScore: 0.1 },
    ],
    frozen: [
      { outSec: 5, endOutSec: 15, sourceSec: 5, endSourceSec: 15, lenSec: 10 },
    ],
  };
  const { times, dropped } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, minGapSec: 1, maxShots: 10, frozenShotEverySec: 60 }),
  );
  assert.deepEqual(
    times.map((t) => t.reason),
    ["edge", "frozen", "edge"],
  );
  assert.deepEqual(
    times.map((t) => t.outSec),
    [0, 10, 20],
  );
  assert.deepEqual(dropped, { scene: 0, frozen: 0 });
});

test("T2: minGapSec 未満で連続する変化点 → sceneScore 最大の1件だけ残る", () => {
  const input: SceneSamplingInput = {
    range,
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0.05 },
      { outSec: 4, sourceSec: 4, sceneScore: 0.9 },
      { outSec: 6, sourceSec: 6, sceneScore: 0.5 },
      { outSec: 10, sourceSec: 10, sceneScore: 0.05 },
    ],
    frozen: [],
  };
  const { times, dropped } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.3, minGapSec: 5, maxShots: 10 }),
  );
  const scenes = times.filter((t) => t.reason === "scene");
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].outSec, 4);
  assert.equal(scenes[0].sceneScore, 0.9);
  assert.deepEqual(dropped, { scene: 0, frozen: 0 });
});

test("T3: 端点は motion[0]/motion[last] であって 0/maxOut ではない", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 30, endSec: 90 },
    motion: [
      { outSec: 30, sourceSec: 30, sceneScore: 0.05 },
      { outSec: 60, sourceSec: 60, sceneScore: 0.05 },
      { outSec: 90, sourceSec: 90, sceneScore: 0.05 },
    ],
    frozen: [],
  };
  const { times } = selectSceneTimes(input, cfg({ sceneThreshold: 0.5, maxShots: 10 }));
  const edges = times.filter((t) => t.reason === "edge").map((t) => t.outSec);
  assert.deepEqual(edges, [30, 90]);
  assert.equal(
    times.some((t) => t.outSec === 0),
    false,
  );
});

test("T4: lenSec:200 / frozenShotEverySec:60 / frozenMaxShotsPerSpan:3 → 3枚が1/4,2/4,3/4の位置", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 200 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0 },
      { outSec: 200, sourceSec: 200, sceneScore: 0 },
    ],
    frozen: [
      { outSec: 0, endOutSec: 200, sourceSec: 0, endSourceSec: 200, lenSec: 200 },
    ],
  };
  const { times } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, frozenShotEverySec: 60, frozenMaxShotsPerSpan: 3, maxShots: 10 }),
  );
  const frozenTimes = times.filter((t) => t.reason === "frozen").map((t) => t.outSec);
  assert.deepEqual(frozenTimes, [50, 100, 150]);
});

test("T5: lenSec:30 の静止区間 → 中点1枚(shots = clamp(1,0,3) = 1)", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 30 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0 },
      { outSec: 30, sourceSec: 30, sceneScore: 0 },
    ],
    frozen: [
      { outSec: 0, endOutSec: 30, sourceSec: 0, endSourceSec: 30, lenSec: 30 },
    ],
  };
  const { times } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, frozenShotEverySec: 60, frozenMaxShotsPerSpan: 3, maxShots: 10 }),
  );
  const frozenTimes = times.filter((t) => t.reason === "frozen").map((t) => t.outSec);
  assert.deepEqual(frozenTimes, [15]);
});

test("T6: lenSec:0 の静止区間で0除算せず sourceSec をそのまま返す", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 100 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0 },
      { outSec: 100, sourceSec: 100, sceneScore: 0 },
    ],
    frozen: [
      { outSec: 50, endOutSec: 50, sourceSec: 123.45, endSourceSec: 123.45, lenSec: 0 },
    ],
  };
  const { times } = selectSceneTimes(input, cfg({ sceneThreshold: 0.5, maxShots: 10 }));
  const frozenPoint = times.find((t) => t.reason === "frozen");
  assert.ok(frozenPoint);
  assert.equal(frozenPoint!.outSec, 50);
  assert.equal(frozenPoint!.sourceSec, 123.45);
});

test("T7: frozen由来の点の sceneScore は |outSec-t| 最小の motion 要素の値。同値なら outSec が小さいほう", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 30 },
    motion: [
      { outSec: 10, sourceSec: 10, sceneScore: 0.3 },
      { outSec: 20, sourceSec: 20, sceneScore: 0.6 },
    ],
    frozen: [
      // 中点 15: outSec10(距離5)と outSec20(距離5)の同値 → outSec小さいほう(10, score0.3)
      { outSec: 10, endOutSec: 20, sourceSec: 10, endSourceSec: 20, lenSec: 10 },
    ],
  };
  const { times } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.9, frozenShotEverySec: 1000, frozenMaxShotsPerSpan: 3, maxShots: 10 }),
  );
  const frozenPoint = times.find((t) => t.reason === "frozen");
  assert.ok(frozenPoint);
  assert.equal(frozenPoint!.outSec, 15);
  assert.equal(frozenPoint!.sceneScore, 0.3);
});

test("T8: frozen由来の点の sourceSec は線形内挿と一致(toSourceTime を呼ばない)", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 200 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0 },
      { outSec: 200, sourceSec: 200, sceneScore: 0 },
    ],
    frozen: [
      { outSec: 100, endOutSec: 110, sourceSec: 200, endSourceSec: 224, lenSec: 10 },
    ],
  };
  const { times } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, frozenShotEverySec: 1000, frozenMaxShotsPerSpan: 3, maxShots: 10 }),
  );
  const frozenPoint = times.find((t) => t.reason === "frozen");
  assert.ok(frozenPoint);
  // 中点 105 → ratio 0.5 → sourceSec = 200 + (224-200)*0.5 = 212
  assert.equal(frozenPoint!.outSec, 105);
  assert.equal(frozenPoint!.sourceSec, 212);
});

test("T9: protected.length <= maxShots のとき scenes だけが sceneScore 降順に切られる", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 50 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0.05 },
      { outSec: 10, sourceSec: 10, sceneScore: 0.9 },
      { outSec: 20, sourceSec: 20, sceneScore: 0.8 },
      { outSec: 30, sourceSec: 30, sceneScore: 0.7 },
      { outSec: 40, sourceSec: 40, sceneScore: 0.6 },
      { outSec: 50, sourceSec: 50, sceneScore: 0.05 },
    ],
    frozen: [
      { outSec: 25, endOutSec: 25, sourceSec: 25, endSourceSec: 25, lenSec: 0 },
    ],
  };
  const { times, dropped } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, minGapSec: 5, maxShots: 5 }),
  );
  // protected = edge(0,50) + frozen(25) = 3、scenes候補 = 4(10,20,30,40)
  // keepCount = 5 - 3 = 2 → sceneScore 降順で 10(0.9),20(0.8) だけ残る
  const scenes = times.filter((t) => t.reason === "scene").map((t) => t.outSec);
  assert.deepEqual(scenes, [10, 20]);
  assert.equal(times.length, 5);
  assert.deepEqual(dropped, { scene: 2, frozen: 0 });
});

test("T10: protected.length > maxShots のとき scenes が全件消え、frozen が lenSec 降順に切られ、edge は残る", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 100 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0.05 },
      { outSec: 10, sourceSec: 10, sceneScore: 0.9 },
      { outSec: 95, sourceSec: 95, sceneScore: 0.85 },
      { outSec: 100, sourceSec: 100, sceneScore: 0.05 },
    ],
    frozen: [
      { outSec: 20, endOutSec: 30, sourceSec: 20, endSourceSec: 30, lenSec: 10 }, // 中点25
      { outSec: 40, endOutSec: 80, sourceSec: 40, endSourceSec: 80, lenSec: 40 }, // 中点60
      { outSec: 82, endOutSec: 84, sourceSec: 82, endSourceSec: 84, lenSec: 2 }, // 中点83
      { outSec: 86, endOutSec: 90, sourceSec: 86, endSourceSec: 90, lenSec: 4 }, // 中点88
    ],
  };
  const { times, dropped } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, minGapSec: 5, maxShots: 4, frozenShotEverySec: 1000, frozenMaxShotsPerSpan: 3 }),
  );
  // protected = edge(2) + frozen(4) = 6 > maxShots(4)。
  // scenes(10,95)は全件捨て、frozen は lenSec 降順(40,10,4,2)で
  // maxShots - edge.length = 2 件だけ残る(lenSec40→中点60, lenSec10→中点25)
  assert.deepEqual(
    times.map((t) => t.reason),
    ["edge", "frozen", "frozen", "edge"],
  );
  assert.deepEqual(
    times.map((t) => t.outSec),
    [0, 25, 60, 100],
  );
  assert.deepEqual(dropped, { scene: 2, frozen: 2 });
});

test("T11: maxShots:1 のとき maxShots を無視して edge 2枚を返す", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 100 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0.05 },
      { outSec: 10, sourceSec: 10, sceneScore: 0.9 },
      { outSec: 100, sourceSec: 100, sceneScore: 0.05 },
    ],
    frozen: [
      { outSec: 50, endOutSec: 60, sourceSec: 50, endSourceSec: 60, lenSec: 10 },
    ],
  };
  const { times, dropped } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, maxShots: 1 }),
  );
  assert.deepEqual(
    times.map((t) => t.reason),
    ["edge", "edge"],
  );
  assert.deepEqual(
    times.map((t) => t.outSec),
    [0, 100],
  );
  assert.equal(dropped.scene, 1);
  assert.equal(dropped.frozen, 1);
});

test("T12: 切った件数が dropped: { scene, frozen } として返る", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 50 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0.05 },
      { outSec: 10, sourceSec: 10, sceneScore: 0.9 },
      { outSec: 20, sourceSec: 20, sceneScore: 0.8 },
      { outSec: 50, sourceSec: 50, sceneScore: 0.05 },
    ],
    frozen: [],
  };
  const { dropped } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, minGapSec: 5, maxShots: 3 }),
  );
  // protected = edge(2) のみ、scenes候補2件。keepCount = 3 - 2 = 1 → 1件切られる
  assert.deepEqual(dropped, { scene: 1, frozen: 0 });
});

test("T13: 出力は outSec 昇順・round2(outSec) で重複なし。衝突時の優先は edge > frozen > scene", () => {
  const input: SceneSamplingInput = {
    range: { startSec: 0, endSec: 100 },
    motion: [
      { outSec: 0, sourceSec: 0, sceneScore: 0.9 }, // edge かつ scene 候補(衝突 → edge優先)
      { outSec: 50, sourceSec: 50, sceneScore: 0.8 }, // scene 候補(frozen と衝突 → frozen優先)
      { outSec: 100, sourceSec: 100, sceneScore: 0.05 },
    ],
    frozen: [
      // 中点ちょうど50 → outSec50のscene候補と衝突
      { outSec: 45, endOutSec: 55, sourceSec: 45, endSourceSec: 55, lenSec: 10 },
    ],
  };
  const { times, dropped } = selectSceneTimes(
    input,
    cfg({ sceneThreshold: 0.5, minGapSec: 1, frozenShotEverySec: 1000, frozenMaxShotsPerSpan: 3, maxShots: 10 }),
  );
  assert.deepEqual(
    times.map((t) => t.reason),
    ["edge", "frozen", "edge"],
  );
  assert.deepEqual(
    times.map((t) => t.outSec),
    [0, 50, 100],
  );
  // 昇順であることも併せて確認
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i].outSec >= times[i - 1].outSec);
  }
  assert.deepEqual(dropped, { scene: 0, frozen: 0 });
});

test("T14: motion[] が空配列 → 空配列を返す(端点も出さない・例外を投げない)", () => {
  const input: SceneSamplingInput = { range, motion: [], frozen: [] };
  const { times, dropped } = selectSceneTimes(input, cfg());
  assert.deepEqual(times, []);
  assert.deepEqual(dropped, { scene: 0, frozen: 0 });
});

test("T15: 入力の motion[] が outSec 昇順でなくても結果が同じ(先頭でソートする)", () => {
  const unsorted: SceneSamplingInput = {
    range: { startSec: 0, endSec: 20 },
    motion: [
      { outSec: 20, sourceSec: 20, sceneScore: 0.05 },
      { outSec: 0, sourceSec: 0, sceneScore: 0.05 },
      { outSec: 10, sourceSec: 10, sceneScore: 0.05 },
    ],
    frozen: [],
  };
  const sorted: SceneSamplingInput = {
    range: unsorted.range,
    motion: [...unsorted.motion].sort((a, b) => a.outSec - b.outSec),
    frozen: [],
  };
  const c = cfg({ sceneThreshold: 0.5, maxShots: 10 });
  const a = selectSceneTimes(unsorted, c);
  const b = selectSceneTimes(sorted, c);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.times.map((t) => t.outSec),
    [0, 20],
  );
});
