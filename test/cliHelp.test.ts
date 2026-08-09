// CLI ヘルプの分類(src/lib/cliHelp.ts)が cli.ts のコマンド登録と食い違ったら
// 落ちるドリフト検知テスト。test/agentsMd.test.ts と同じ方針で、散文の言い回しは
// 検査せず「列挙の網羅」だけを機械照合する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMAND_GROUPS,
  commandSummaries,
  formatCommandList,
  formatRootHelp,
  listedCommandNames,
} from "../src/lib/cliHelp.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI_TS = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");

/** cli.ts のトップレベル `.command("<name> ...")` 登録名。`ai doctor` の
 * ネストした doctor も同名で拾えるので、集合として比較する
 * (test/agentsMd.test.ts の extractCliCommandNames と同じ抽出) */
function registeredCommandNames(): Set<string> {
  return new Set([...CLI_TS.matchAll(/\.command\("([a-zA-Z0-9-]+)/g)].map((m) => m[1]));
}

test("cliHelp: 登録済みの全コマンドが分類のどこかに載っている", () => {
  const listed = new Set(listedCommandNames());
  for (const name of registeredCommandNames()) {
    assert.ok(listed.has(name), `${name} が COMMAND_GROUPS に載っていません`);
  }
});

test("cliHelp: 分類に存在しないコマンドを載せていない", () => {
  const registered = registeredCommandNames();
  for (const name of listedCommandNames()) {
    assert.ok(registered.has(name), `${name} は cli.ts に登録されていません`);
  }
});

test("cliHelp: コマンドの重複掲載が無い", () => {
  const names = listedCommandNames();
  assert.equal(names.length, new Set(names).size);
});

test("cliHelp: 要約は端末1行に収まる短さ(全角2桁換算で60以内)", () => {
  for (const [name, summary] of commandSummaries()) {
    assert.ok(summary.length > 0, `${name} の要約が空です`);
    const width = [...summary].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0);
    assert.ok(width <= 60, `${name} の要約が長すぎます(${width}桁)`);
  }
});

test("cliHelp: 一覧は全コマンドと全グループ名を含む", () => {
  const out = formatCommandList("framewright");
  for (const g of COMMAND_GROUPS.filter((group) => group.hidden !== true)) {
    assert.ok(out.includes(g.title), `グループ ${g.title} が一覧に出ていません`);
    for (const c of g.commands) assert.ok(out.includes(c.name), `${c.name} が一覧に出ていません`);
  }
});

test("cliHelp: ルートヘルプは短く保つ(端末1画面ぶん=35行以内)", () => {
  const out = formatRootHelp("framewright", ["--config <path>   config.yaml のパス"]);
  assert.ok(out.split("\n").length <= 35, "ルートヘルプが長すぎます(全コマンドは commands へ)");
  // 基本の流れ(初見で叩く順)と、全コマンドへの導線が必ずあること
  for (const name of ["doctor", "editor", "run", "preview", "approve", "render"]) {
    assert.ok(out.includes(name), `${name} がルートヘルプにありません`);
  }
  // 知覚→下書き→検品の3層は、旧12コマンドの入口を兼ねるのでルートヘルプに出す
  for (const name of ["probe", "draft", "check"]) {
    assert.ok(out.includes(name), `${name} がルートヘルプにありません`);
  }
  assert.ok(out.includes("framewright commands"), "全コマンドへの導線がありません");
});
