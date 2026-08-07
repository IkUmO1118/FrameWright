import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("Tailwind source excludes Preflight and isolates OpenCut tokens from legacy names", () => {
  const css = read("editor/client/styles.css");
  assert.match(css, /tailwindcss\/theme\.css/);
  assert.match(css, /tailwindcss\/utilities\.css/);
  assert.doesNotMatch(css, /@import\s+["']tailwindcss["']/);
  assert.doesNotMatch(css, /tailwindcss\/preflight\.css/);
  assert.doesNotMatch(css, /^\s*--(?:accent|border):/m);
  assert.match(css, /:root\s*\{/);
  assert.match(css, /\.dark\s*\{/);
  assert.match(css, /\.panel\s*\{/);
  assert.match(css, /\.dark \.panel\s*\{/);
  assert.match(css, /--oc-text-xs:\s*0\.72rem/);
  assert.match(css, /--oc-radius:/);
});

test("the first design-system component is a native CVA Button using cn", () => {
  const button = read("editor/client/components/ui/button.tsx");
  const utils = read("editor/client/lib/utils.ts");
  assert.match(button, /cva\(/);
  assert.match(button, /VariantProps/);
  assert.match(button, /forwardRef<HTMLButtonElement, ButtonProps>/);
  assert.match(button, /ref=\{ref\}/);
  assert.match(button, /Button\.displayName = "Button"/);
  assert.match(button, /<button/);
  assert.match(button, /cn\(buttonVariants/);
  assert.doesNotMatch(button, /Radix|Slot|asChild|ButtonPrimitive/);
  assert.match(utils, /twMerge\(clsx\(inputs\)\)/);
});

test("the header AI launcher keeps its behavior props during the P2 header migration", () => {
  const app = read("editor/client/App.tsx");
  // F1 で AI編集はトグルになった(aiEditEnabled)。className / variant / ラベルは
  // 素の文字列から aiEditEnabled 分岐の式へ変わっているが、ref / size / disabled と
  // 「未提案なら AiCommand を開く」導線はそのまま保つ、というのがこの test の意図
  const classAt = app.indexOf("className={`aiCommandLauncher");
  assert.ok(classAt >= 0, "AI launcher の className が見つからない");
  const launcher = app.slice(app.lastIndexOf("<Button", classAt), app.indexOf("onClick=", classAt));
  assert.match(launcher, /variant=\{aiEditEnabled \? "default" : "secondary"\}/);
  assert.match(launcher, /size="sm"/);
  assert.match(launcher, /className=\{`aiCommandLauncher\$\{aiEditEnabled \? " on" : ""\}`\}/);
  assert.match(launcher, /ref=\{aiCommandLauncherRef\}/);
  assert.match(launcher, /disabled=\{aiWorkflowLocked \|\| analysisBusy\}/);
  assert.match(launcher, /title=\{[\s\S]*aiWorkflowLocked[\s\S]*aiWorkflowTitle[\s\S]*analysisBusy[\s\S]*"文字起こし中です。終わると AI 編集を使えます"[\s\S]*aiEditEnabled[\s\S]*"AI編集モードを終了"[\s\S]*anyDirty[\s\S]*"保存してから AI 一発編集"[\s\S]*"AI 一発編集を開く"[\s\S]*\}/);
  assert.match(app, /setAiCommandScope\("global"\);\s+setAiCommandOpen\(true\);/);
  assert.match(app, /\{aiWorkflowLocked\s+\? "編集中" : aiEditEnabled \? "AI編集 ON" : "AI編集"\}/);
});

test("editor HTML bootstraps the resolved theme before one generated stylesheet", () => {
  const html = read("editor/client/index.html");
  assert.match(html, /<html lang="ja">/);
  assert.doesNotMatch(html, /<html[^>]+class="dark"/);
  assert.match(html, /<meta name="color-scheme" content="light dark"/);
  assert.ok(html.indexOf("data-framewright-theme-bootstrap") < html.indexOf('href="/styles.css"'));
  assert.equal((html.match(/<link rel="stylesheet" href="\/styles\.css" \/>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<style\b|<link[^>]+stylesheet[^>]+href=(?!"\/styles\.css")/);
});

test("server integrates the recursive client watcher without reusing the JSON watcher", () => {
  const server = read("editor/server.ts");
  const listenAt = server.indexOf('server.listen(port, "127.0.0.1", ok)');
  const clientWatchAt = server.indexOf('clientWatcher = watch(join(editorDir, "client"), { recursive: true }');
  assert.ok(listenAt >= 0 && clientWatchAt > listenAt);
  assert.match(server, /clientReloader\.schedule\(\)/);
  // catch は「reloader を閉じる → 生成済み watcher を閉じる → server を閉じる」。
  // watcher の後片付けが間に挟まるので緩く繋ぐ(順序と両端は固定したまま)
  assert.match(server, /catch \(error\) \{\s+clientReloader\.close\(\);[\s\S]*?await new Promise<void>\(\(resolveClose\) => server\.close/);
  assert.match(server, /clientWatcher\?\.close\(\)/);
  assert.match(server, /watch\(dir, \(_event, filename\) =>/);
  // client バンドルは editor/client だけで閉じない(EnginePreview が
  // src/engine/describeFrame を import している)。src を監視しないと
  // 「DOM オーバーレイだけ更新され、キャンバスの描画は古いまま」になる
  assert.match(server, /engineWatcher = watch\(join\(editorDir, "\.\.", "src"\), \{ recursive: true \}/);
  assert.match(server, /engineWatcher\?\.close\(\)/);
});

test("CaptionOverlay aligns multiline topLeft text like the renderer", () => {
  const overlay = read("editor/client/CaptionOverlay.tsx");
  assert.match(
    overlay,
    /textAlign: \(c\.anchor === "topLeft" \? "left" : "center"\) as "left" \| "center"/,
  );
});

test("OpenCut provenance pins exact sources, adaptation, and the MIT notice", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  assert.match(provenance, /cf5e79e919144200294fb9fed22a222592a0aeea/);
  const revisionUrl =
    "https://github.com/OpenCut-app/OpenCut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/";
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/app/globals.css`));
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/components/ui/button.tsx`));
  assert.ok(provenance.includes(`${revisionUrl}apps/web/src/lib/utils.ts`));
  assert.ok(provenance.includes(`${revisionUrl}LICENSE`));
  assert.match(provenance, /## Adaptation in FrameWright/);
  assert.match(provenance, /Copyright 2025-2026 OpenCut/);
  assert.match(provenance, /Permission is hereby granted/);
  assert.doesNotMatch(provenance, /verbatim/i);
});

test("Tailwind core and CLI are locked to the same exact version", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies.tailwindcss, pkg.dependencies["@tailwindcss/cli"]);
  assert.match(pkg.dependencies.tailwindcss, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies.tailwindcss, undefined);
  assert.equal(pkg.devDependencies["@tailwindcss/cli"], undefined);
});

/** `@layer <name> { … }` のブロック本体を(入れ子の括弧を数えて)全部抜き出す */
function layerBodies(css: string, name: string): string[] {
  const bodies: string[] = [];
  const head = new RegExp(`@layer\\s+${name}\\s*\\{`, "g");
  for (let m = head.exec(css); m; m = head.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    bodies.push(css.slice(from, i - 1));
  }
  return bodies;
}

test("Button variant を上書きする !important は ocOverrides レイヤーの中だけに置く", () => {
  const css = read("editor/client/styles.css");
  // レイヤー宣言順が要。!important 同士はレイヤー順が逆転する(CSS Cascade 5)ので、
  // utilities より前に宣言したレイヤーだけが Tailwind の `!` ユーティリティに勝てる
  const order = /^@layer\s+([^;]+);/m.exec(css)?.[1] ?? "";
  const names = order.split(",").map((s) => s.trim());
  assert.ok(names.indexOf("ocOverrides") >= 0, "ocOverrides レイヤーが宣言されていない");
  assert.ok(
    names.indexOf("ocOverrides") < names.indexOf("utilities"),
    "ocOverrides は utilities より前に宣言する(!important の優先度が逆順のため)",
  );

  const bodies = layerBodies(css, "ocOverrides");
  assert.ok(bodies.length > 0);
  // 状態表示(ループ ON など)の色は必ずレイヤーの中。無レイヤーだと Tailwind の
  // `text-foreground!` / `bg-transparent!` に負けて押しても見た目が変わらない
  const inLayer = bodies.join("\n");
  assert.match(inLayer, /\.ocTransport button\.icon\.active\s*\{/);
  assert.match(inLayer, /\.ocHeader \.settingsBtn\.active/);
  assert.match(inLayer, /\.ocSidePanel \.ocIconRail \[role="tab"\]\.active/);
  assert.match(inLayer, /\.ocInspector \.inspTabBtn\.inspTabBtnIdle/);

  // レイヤー外に色系の !important が残っていないこと(残っていれば黙って無効になる)
  let outside = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const body of bodies) outside = outside.replace(body.replace(/\/\*[\s\S]*?\*\//g, ""), "");
  const stray = outside
    .split("\n")
    .filter((line) => /!important/.test(line) && /(^|[\s;{])(color|background|background-color|border|border-color)\s*:/.test(line));
  assert.deepEqual(stray, []);
});
