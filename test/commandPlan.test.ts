import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCheckPlan, resolveDraftPlan, resolveProbePlan } from "../src/lib/commandPlan.ts";

test("resolveProbePlan: 無指定と --all は materials→av で style を含めない", () => {
  assert.deepEqual(resolveProbePlan({}), ["materials", "av"]);
  assert.deepEqual(resolveProbePlan({ all: true }), ["materials", "av"]);
});

test("resolveProbePlan: --style は明示指定時だけ実行する", () => {
  assert.deepEqual(resolveProbePlan({ style: true }), ["style"]);
  assert.deepEqual(resolveProbePlan({ all: true, style: true }), ["materials", "av", "style"]);
});

test("resolveDraftPlan: 無指定と --all は materials→effects→bgm で zoom を含めない", () => {
  assert.deepEqual(resolveDraftPlan({}), ["materials", "effects", "bgm"]);
  assert.deepEqual(resolveDraftPlan({ all: true }), ["materials", "effects", "bgm"]);
});

test("resolveDraftPlan: --effects と --zoom は排他", () => {
  assert.throws(() => resolveDraftPlan({ effects: true, zoom: true }), /同時指定/);
});

test("resolveCheckPlan: --all は全検品を順序固定し、materials/av probe だけ自動前提にする", () => {
  assert.deepEqual(resolveCheckPlan({ all: true }), {
    steps: ["materials", "effects", "bgm", "style", "boundary"],
    autoProbe: ["materials", "av"],
    autoIdStamp: false,
    isAll: true,
  });
});

test("resolveCheckPlan: style は自動 probe 前提を持たない", () => {
  assert.deepEqual(resolveCheckPlan({ style: true }), {
    steps: ["style"],
    autoProbe: [],
    autoIdStamp: false,
    isAll: false,
  });
});

test("resolveCheckPlan: id-stamp は --fix のときだけ自動化する", () => {
  assert.equal(resolveCheckPlan({ materials: true }).autoIdStamp, false);
  assert.equal(resolveCheckPlan({ materials: true, fix: true }).autoIdStamp, true);
});

test("resolveCheckPlan: 無指定は --all 扱い、単独 domain は単独扱い", () => {
  assert.equal(resolveCheckPlan({}).isAll, true);
  assert.equal(resolveCheckPlan({ materials: true }).isAll, false);
});
