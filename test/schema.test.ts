// schemas/*.schema.json のドリフト検知テスト(docs/plans/2026-07-07-machine-contract-design.md
// §論点6)。JSON Schema も AGENTS_CONTRACT.md も新しい真実を宣言しない=「既存の単一の
// 出所」(types.ts / validate.ts / files.ts / ids.ts / profile.ts / applyEdits.ts)
// への射影であることを、以下の3層で機械的に強制する:
//   (a) 全単射: schemas/ にある7編集ファイル用スキーマの集合 == 実装の
//       「7編集ファイル」の単一の出所。GENERATED_FILES に対応するスキーマが無い。
//   (b) fixture/example 検証: 各 examples/*.max.json と実データ
//       (describe.test.ts の buildRichFixture)が対応スキーマに valid。
//   (c) enum/pattern ピン留め: スキーマ中の enum/pattern を、既存の単一の
//       出所(コード)へ1:1で assert する。
//
// (a)の「7編集ファイル」の一次資料について: files.ts の EDITABLE_FILES は
// plan/transcribe 再実行時に backup 退避する対象という狭い集合(5件。
// bgm/thumbnail を含まない)であり、CLAUDE.md が言う「7編集ファイル」
// 全体の出所ではない(test/files.test.ts が既にこの5件を固定している)。
// 8件全体の単一の出所は src/lib/applyEdits.ts の APPLY_FILE_NAME(7件。
// meta.json は「id を持つ要素が無いため apply の対象外」とコメントされている
// 意図的な欠落)+ "meta.json" とする。
//
// CaptionAnimKind/AnnotationType/SpotlightShape は types.ts の
// **型エイリアス**(TS の型は実行時に消える)なので、値としてimportできない。
// また test/**/*.ts は tsconfig.json の include 対象外で `npx tsc --noEmit`
// では検査されないため、型レベルの網羅性チェックは実効性が無い
// (このリポジトリの実際のゲートは `npm test` のみ)。そこで、production
// コードを一切変更せずに実行時ドリフト検知を行うため、対象ファイルを
// テキストとして読み、型/配列リテラルを正規表現で抽出して比較する
// (読むだけの consumer。§不変条件1・6)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRegistryResolver, validateAgainstSchema } from "./helpers/jsonSchema.ts";
import type { JsonSchema } from "./helpers/jsonSchema.ts";
import { EDITABLE_FILES, GENERATED_FILES } from "../src/lib/files.ts";
import { ID_RE } from "../src/lib/ids.ts";
import { APPLY_FILE_NAME } from "../src/lib/applyEdits.ts";
import { CUT_REASON_IDS } from "../src/lib/reasonIds.ts";
import { EFFECT_REASON_IDS } from "../src/lib/effectReasonIds.ts";
import { buildRichFixture } from "./describe.test.ts";

const SCHEMAS_DIR = join(import.meta.dirname, "..", "schemas");
const EXAMPLES_DIR = join(SCHEMAS_DIR, "examples");
const TYPES_TS = readFileSync(join(import.meta.dirname, "..", "src", "types.ts"), "utf8");
const VALIDATE_TS = readFileSync(join(import.meta.dirname, "..", "src", "stages", "validate.ts"), "utf8");
const APPLY_EDITS_TS = readFileSync(join(import.meta.dirname, "..", "src", "lib", "applyEdits.ts"), "utf8");

/** "export type <name> = ...;"(1行/複数行・行コメント混在OK)から
 * 文字列リテラルの union メンバーだけを抽出する(コメントには引用符が
 * 出てこない前提。types.ts の実際の書き方と一致) */
function extractUnionLiterals(source: string, typeName: string): string[] {
  const re = new RegExp(`export type ${typeName} =([\\s\\S]*?);`, "m");
  const m = re.exec(source);
  if (!m) throw new Error(`type ${typeName} が types.ts に見つかりません(実装が変わった可能性)`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** "const <name> = [...]"(validate.ts のローカル定数。export されていない
 * ため import できず、テキストから抽出する)から文字列リテラルを抽出する */
function extractArrayLiteral(source: string, constName: string): string[] {
  const re = new RegExp(`const ${constName}(?::[^=]+)? = \\[([\\s\\S]*?)\\]`, "m");
  const m = re.exec(source);
  if (!m) throw new Error(`${constName} が validate.ts に見つかりません(実装が変わった可能性)`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** "const <name>: ... = { "key": {...}, ... }"(applyEdits.ts のローカル
 * オブジェクト定数。export されていないため import できず、テキストから
 * オブジェクトキー(先頭の引用符付きキー)だけを抽出する) */
function extractObjectKeys(source: string, constName: string): string[] {
  const re = new RegExp(`const ${constName}[^=]*= \\{([\\s\\S]*?)\\n\\};`, "m");
  const m = re.exec(source);
  if (!m) throw new Error(`${constName} が applyEdits.ts に見つかりません(実装が変わった可能性)`);
  return [...m[1].matchAll(/^\s*"([^"]+)":/gm)].map((x) => x[1]);
}

const sortedEq = (a: readonly string[], b: readonly string[]): void => {
  assert.deepEqual([...a].sort(), [...b].sort());
};

/* ------------------------------------------------------------------ */
/* (a) 全単射                                                          */
/* ------------------------------------------------------------------ */

/** 7編集ファイルの一次資料。APPLY_FILE_NAME(applyEdits.ts。6件)+
 * meta.json(apply の対象外だが編集ファイルではある)で全8件を構成する */
const EDITABLE_FILE_NAMES: string[] = [...Object.values(APPLY_FILE_NAME), "meta.json"];

function schemaFileNames(): string[] {
  return readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".schema.json"));
}

test("全単射: schemas/ の編集ファイル用スキーマ == 7編集ファイル(APPLY_FILE_NAME+meta.json)", () => {
  const editableSchemas = schemaFileNames().filter(
    (f) =>
      f !== "common.schema.json" &&
      f !== "apply-patch.schema.json" &&
      // assertions.json は7編集ファイル(EDITABLE_FILES/APPLY_FILE_NAME)に
      // 属さない「other」カテゴリ(rules.md/brief.md と同種の宣言ファイル。
      // docs/plans/2026-07-07-visual-assertions-design.md 論点1)。
      // common/apply-patch と同じくこの全単射テストの対象外にする
      f !== "assertions.schema.json",
  );
  const expected = EDITABLE_FILE_NAMES.map((f) => f.replace(/\.json$/, ".schema.json"));
  sortedEq(editableSchemas, expected);
  assert.equal(EDITABLE_FILE_NAMES.length, 7, "7編集ファイルであること");
});

test("全単射: files.ts の EDITABLE_FILES(backup対象。5件)は7編集ファイルの部分集合", () => {
  for (const f of EDITABLE_FILES) {
    assert.ok(EDITABLE_FILE_NAMES.includes(f), `${f} が7編集ファイルに含まれない`);
  }
});

test("全単射: GENERATED_FILES に対応するスキーマが無い", () => {
  const schemas = new Set(schemaFileNames());
  for (const f of GENERATED_FILES) {
    const asSchema = f.replace(/\.[^.]+$/, ".schema.json");
    assert.ok(!schemas.has(asSchema), `${f} に対応するスキーマが誤って存在する: ${asSchema}`);
  }
});

/* ------------------------------------------------------------------ */
/* スキーマレジストリ(fixture/example 検証・enum ピン留めの両方で使う)     */
/* ------------------------------------------------------------------ */

// "assertions" は7編集ファイルには属さない(other カテゴリ)が、kitchen-sink
// example 検証(examples/assertions.max.json が assertions.schema.json に
// valid)はここに加えるだけで自動的に対象になる(全単射テストとは別軸)
const FILE_KEYS = [
  "cutplan",
  "transcript",
  "overlays",
  "bgm",
  "chapters",
  "meta",
  "thumbnail",
  "assertions",
];

function loadRegistry(): Record<string, JsonSchema> {
  const registry: Record<string, JsonSchema> = {};
  registry["common.schema.json"] = JSON.parse(readFileSync(join(SCHEMAS_DIR, "common.schema.json"), "utf8"));
  for (const key of FILE_KEYS) {
    registry[`${key}.schema.json`] = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${key}.schema.json`), "utf8"));
  }
  registry["apply-patch.schema.json"] = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, "apply-patch.schema.json"), "utf8"),
  );
  return registry;
}

/* ------------------------------------------------------------------ */
/* (b) fixture / example 検証                                          */
/* ------------------------------------------------------------------ */

test("kitchen-sink example: 各 schemas/examples/<file>.max.json が対応スキーマに valid", () => {
  const registry = loadRegistry();
  for (const key of FILE_KEYS) {
    const schema = registry[`${key}.schema.json`];
    const example = JSON.parse(readFileSync(join(EXAMPLES_DIR, `${key}.max.json`), "utf8"));
    const resolve = makeRegistryResolver(registry, `${key}.schema.json`);
    const errs = validateAgainstSchema(example, schema, resolve);
    assert.deepEqual(errs, [], `${key}.max.json が invalid: ${errs.join("; ")}`);
  }
});

test("実データ: buildRichFixture が書く編集ファイルが対応スキーマに valid", () => {
  const dir = mkdtempSync(join(tmpdir(), "framewright-schema-fixture-"));
  try {
    buildRichFixture(dir);
    const registry = loadRegistry();
    // buildRichFixture は thumbnail.json を書かないため対象外(examples 側で
    // 既に valid を確認済み)
    for (const key of ["cutplan", "transcript", "overlays", "bgm", "chapters", "meta"]) {
      const schema = registry[`${key}.schema.json`];
      const data = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8"));
      const resolve = makeRegistryResolver(registry, `${key}.schema.json`);
      const errs = validateAgainstSchema(data, schema, resolve);
      assert.deepEqual(errs, [], `実データの ${key}.json が invalid: ${errs.join("; ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* (c) enum / pattern ピン留め                                          */
/* ------------------------------------------------------------------ */

test("ピン留め: common.schema.json の id.pattern === ID_RE.source(ids.ts)", () => {
  const common = loadRegistry()["common.schema.json"];
  assert.equal(common.$defs?.id.pattern, ID_RE.source);
});

test("ピン留め: transcript.generatedBy enum === Transcript.generatedBy(types.ts)", () => {
  const types = /generatedBy\?: ([^;]+);/.exec(TYPES_TS)?.[1] ?? "";
  const values = [...types.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(values.length > 0);
  const transcript = loadRegistry()["transcript.schema.json"];
  sortedEq(transcript.properties?.generatedBy.enum as string[], values);
});

test("ピン留め: CaptionAnim の in/out enum === CaptionAnimKind(types.ts)", () => {
  const kinds = extractUnionLiterals(TYPES_TS, "CaptionAnimKind");
  assert.ok(kinds.length > 0);
  const common = loadRegistry()["common.schema.json"];
  const anim = common.$defs?.CaptionAnim;
  sortedEq(anim?.properties?.in.enum as string[], kinds);
  sortedEq(anim?.properties?.out.enum as string[], kinds);
});

test("ピン留め: blurs は効果種別を持たない(モザイク廃止・ぼかし一本)", () => {
  const overlays = loadRegistry()["overlays.schema.json"];
  assert.equal(overlays.properties?.blurs.items?.properties?.type, undefined);
});

test("ピン留め: annotations の type 判別子集合 === AnnotationType(types.ts)", () => {
  const kinds = extractUnionLiterals(TYPES_TS, "AnnotationType");
  assert.ok(kinds.length > 0);
  const common = loadRegistry()["common.schema.json"];
  const branchDefs = ["ArrowAnnotation", "BoxAnnotation", "SpotlightAnnotation"];
  const consts = branchDefs.map((name) => common.$defs?.[name].properties?.type.const as string);
  sortedEq(consts, kinds);
});

test("ピン留め: SpotlightAnnotation.shape の enum === SpotlightShape(types.ts)", () => {
  const shapes = extractUnionLiterals(TYPES_TS, "SpotlightShape");
  assert.ok(shapes.length > 0);
  const common = loadRegistry()["common.schema.json"];
  const shapeEnum = common.$defs?.SpotlightAnnotation.properties?.shape.enum as string[];
  sortedEq(shapeEnum, shapes);
});

test("ピン留め: WipeStyle.anchor の enum === WipeAnchor(types.ts) === validate.ts", () => {
  const anchors = extractUnionLiterals(TYPES_TS, "WipeAnchor");
  assert.ok(anchors.length > 0);
  const validateAnchors = extractArrayLiteral(VALIDATE_TS, "anchors");
  const overlays = loadRegistry()["overlays.schema.json"];
  const schemaAnchors = overlays.$defs?.WipeStyle.properties?.anchor.enum as string[];
  sortedEq(schemaAnchors, anchors);
  sortedEq(validateAnchors, anchors);
});

test("ピン留め: overlays.json トップの許可キー === validate.ts の KNOWN", () => {
  const known = extractArrayLiteral(VALIDATE_TS, "KNOWN");
  assert.ok(known.length > 0);
  const overlays = loadRegistry()["overlays.schema.json"];
  assert.equal(overlays.additionalProperties, false);
  sortedEq(Object.keys(overlays.properties ?? {}), known);
});

test("ピン留め: colorFilter の許可キー === validate.ts の CF_KEYS", () => {
  const cfKeys = extractArrayLiteral(VALIDATE_TS, "CF_KEYS");
  assert.ok(cfKeys.length > 0);
  const overlays = loadRegistry()["overlays.schema.json"];
  const colorFilter = overlays.properties?.colorFilter;
  assert.equal(colorFilter?.additionalProperties, false);
  sortedEq(Object.keys(colorFilter?.properties ?? {}), cfKeys);
});

test("ピン留め: bgm.json トップの許可キーは tracks のみ(validate.ts と一致)", () => {
  const bgm = loadRegistry()["bgm.schema.json"];
  assert.equal(bgm.additionalProperties, false);
  sortedEq(Object.keys(bgm.properties ?? {}), ["tracks"]);
});

test("T-b ピン留め: cutplan.schema.json の segments[].reasonId enum === CUT_REASON_IDS(reasonIds.ts)", () => {
  const cutplan = loadRegistry()["cutplan.schema.json"];
  const reasonIdEnum = cutplan.properties?.segments.items?.properties?.reasonId.enum as string[];
  sortedEq(reasonIdEnum, [...CUT_REASON_IDS]);
});

test("ピン留め: overlaysの全effect reasonId enum === EFFECT_REASON_IDS", () => {
  const registry = loadRegistry();
  const overlays = registry["overlays.schema.json"];
  const enums = [
    overlays.properties?.zooms.items?.properties?.reasonId.enum,
    overlays.properties?.blurs.items?.properties?.reasonId.enum,
    overlays.$defs?.ArrowAnnotation.properties?.reasonId.enum,
    overlays.$defs?.BoxAnnotation.properties?.reasonId.enum,
    overlays.$defs?.SpotlightAnnotation.properties?.reasonId.enum,
    registry["common.schema.json"].$defs?.ArrowAnnotation.properties?.reasonId.enum,
    registry["common.schema.json"].$defs?.BoxAnnotation.properties?.reasonId.enum,
    registry["common.schema.json"].$defs?.SpotlightAnnotation.properties?.reasonId.enum,
  ] as string[][];
  for (const values of enums) sortedEq(values, [...EFFECT_REASON_IDS]);
});

/* ------------------------------------------------------------------ */
/* apply-patch.schema.json(ApplyPatch / EditOp。docs/plans/2026-07-07-      */
/* atomic-apply-design.md)                                              */
/* ------------------------------------------------------------------ */

test("ピン留め: add の target 選択子 enum === applyEdits.ts の ADD_SELECTORS", () => {
  const selectors = extractObjectKeys(APPLY_EDITS_TS, "ADD_SELECTORS");
  assert.ok(selectors.length > 0);
  const patch = loadRegistry()["apply-patch.schema.json"];
  const addTargetEnum = patch.$defs?.AddOp.properties?.target.enum as string[];
  sortedEq(addTargetEnum, selectors);
});

test("apply-patch: set/remove/add の実例パッチ(test/applyEdits.test.ts 相当)が valid", () => {
  const registry = loadRegistry();
  const schema = registry["apply-patch.schema.json"];
  const resolve = makeRegistryResolver(registry, "apply-patch.schema.json");
  const patches: unknown[] = [
    { ops: [{ op: "set", target: "@seg_a1a1a1", field: "reason", value: "更新後" }] },
    { ops: [{ op: "remove", target: "@seg_a1a1a1" }] },
    {
      ops: [
        { op: "add", target: "cutplan.segments", value: { start: 20, end: 30, action: "keep", reason: "新規" } },
      ],
    },
    { ops: [{ op: "add", target: "bgm.tracks", value: { start: 0, end: 10, file: "bgm.mp3" }, at: 0 }] },
    { replace: { chapters: { chapters: [{ start: 0, title: "導入" }] } } },
    { replace: { bgm: null } },
  ];
  for (const patch of patches) {
    const errs = validateAgainstSchema(patch, schema, resolve);
    assert.deepEqual(errs, [], `${JSON.stringify(patch)} が invalid: ${errs.join("; ")}`);
  }
});

test("apply-patch: allow-list外のadd選択子・未知のop種別はschema段でinvalid", () => {
  const registry = loadRegistry();
  const schema = registry["apply-patch.schema.json"];
  const resolve = makeRegistryResolver(registry, "apply-patch.schema.json");
  // target が ADD_SELECTORS の allow-list に無いものは enum 違反で invalid
  const badAdd = { ops: [{ op: "add", target: "unknown.items", value: { name: "x" } }] };
  assert.ok(validateAgainstSchema(badAdd, schema, resolve).length > 0);
  // 未知の op 種別は oneOf のどの分岐にもマッチしない
  const badOp = { ops: [{ op: "unknown", target: "@seg_a1a1a1" }] };
  assert.ok(validateAgainstSchema(badOp, schema, resolve).length > 0);
});
