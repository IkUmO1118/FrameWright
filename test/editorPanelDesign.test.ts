import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("P2 header primitives and the later P4 Sonner dependency stay exact-pinned", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies["radix-ui"], "1.6.4");
  assert.equal(pkg.dependencies["lucide-react"], "1.25.0");
  assert.equal(pkg.dependencies.sonner, "2.0.7");

  const tooltip = read("editor/client/components/ui/tooltip.tsx");
  const popover = read("editor/client/components/ui/popover.tsx");
  assert.match(tooltip, /import \{ Tooltip as TooltipPrimitive \} from "radix-ui"/);
  assert.match(tooltip, /TooltipPrimitive\.Provider/);
  assert.match(tooltip, /TooltipPrimitive\.Portal/);
  assert.match(popover, /import \{ Popover as PopoverPrimitive \} from "radix-ui"/);
  assert.match(popover, /PopoverPrimitive\.Portal/);
});

test("header owns one TooltipProvider and lets the controlled Radix Popover own trigger interaction", () => {
  const app = read("editor/client/App.tsx");
  assert.equal((app.match(/<TooltipProvider\b/g) ?? []).length, 1);
  assert.match(app, /<TooltipProvider delayDuration=\{350\}>/);
  assert.match(app, /<header className="ocHeader">/);
  assert.match(app, /<Popover open=\{exportOpen\} onOpenChange=\{setExportOpen\}>/);
  assert.match(app, /<PopoverTrigger asChild>/);
  assert.match(app, /<PopoverContent className="exportPanel" aria-label="書き出し">/);
  assert.match(app, /aria-expanded=\{exportOpen\}/);

  const exportPopoverStart = app.indexOf("<Popover open={exportOpen} onOpenChange={setExportOpen}>");
  const triggerStart = app.indexOf("<PopoverTrigger asChild>", exportPopoverStart);
  const triggerEnd = app.indexOf("</PopoverTrigger>", triggerStart);
  const trigger = app.slice(triggerStart, triggerEnd);
  assert.ok(triggerStart >= 0 && triggerEnd > triggerStart);
  assert.match(trigger, /<Button[\s\S]*className="exportTrigger"/);
  assert.doesNotMatch(trigger, /onClick=/);
  assert.doesNotMatch(app, /setExportOpen\(\(o\) => !o\)/);

  // Radix Trigger must remain the sole pointer/Enter/Space toggle owner. Its
  // controlled Root also owns Escape dismissal and focus return to this child.
  assert.match(app, /<Popover open=\{exportOpen\} onOpenChange=\{setExportOpen\}>/);
  assert.match(trigger, /aria-expanded=\{exportOpen\}/);
});

test("header migration preserves AI, layout, settings, save, approval, and export behavior", () => {
  const app = read("editor/client/App.tsx");

  assert.match(app, /disabled=\{aiWorkflowLocked \|\| analysisBusy\}/);
  // F1 で aiEditEnabled(トグル)の分岐が入り複数行になった。ロック中・未保存・
  // 通常の3つの文言が生きていることだけを固定する
  assert.match(app, /title=\{[\s\S]*aiWorkflowLocked[\s\S]*aiWorkflowTitle[\s\S]*analysisBusy[\s\S]*"文字起こし中です。終わると AI 編集を使えます"[\s\S]*anyDirty[\s\S]*"保存してから AI 一発編集"[\s\S]*"AI 一発編集を開く"[\s\S]*\}/);
  assert.match(app, /setAiCommandScope\("global"\);\s+setAiCommandOpen\(true\);/);
  assert.match(app, /className=\{anyDirty \? "saveStatus dirty" : "saveStatus"\}/);
  assert.match(app, /busy === "save" \? "保存中…" : anyDirty \? "● 未保存 \(⌘S\)" : "保存済み"/);

  for (const [label, handler] of [
    ["左パネルの表示切替", "setPanelOpen"],
    ["タイムラインの表示切替", "setTimelineOpen"],
    ["右パネルの表示切替", "setInspOpen"],
  ]) {
    assert.ok(app.includes(`aria-label="${label}"`));
    assert.match(app, new RegExp(`onClick=\\{\\(\\) => ${handler}\\(\\(v\\) => !v\\)\\}`));
  }
  assert.match(app, /title=\{`左パネル\(素材\/テロップ\)を\$\{panelOpen \? "隠す" : "表示"\}/);
  assert.match(app, /title=\{`タイムラインを\$\{timelineOpen \? "隠す" : "表示"\}`\}/);
  assert.match(app, /title=\{`右パネル\(プロパティ\)を\$\{inspOpen \? "隠す" : "表示"\}/);
  assert.match(app, /onClick=\{\(\) => \(settingsOpen \? cancelSettings\(\) : openSettings\(\)\)\}/);

  assert.match(app, /type="checkbox"\s+checked=\{cutplan\.approved\}/);
  assert.match(app, /pushHistory\(\);\s+setCutplan\(\(p\) => p && \{ \.\.\.p, approved: e\.target\.checked \}\);/);
  assert.match(app, /!cutplan\.approved \|\| job\?\.status === "running" \|\| busy !== null/);
  assert.match(app, /cutplan\.approved\s+\? "最終レンダー\(final\.mp4\)を生成する。完了すると Finder で開く"/);
  assert.match(app, /setExportOpen\(false\);\s+void runExport\("render"\);/);
  assert.match(app, /disabled=\{job\?\.status === "running" \|\| busy !== null\}/);
  assert.match(app, /setExportOpen\(false\);\s+void runExport\("preview"\);/);
});

test("P2 panel scopes remain present while Inspector and Timeline advance in later checkpoints", () => {
  const app = read("editor/client/App.tsx");
  const css = read("editor/client/styles.css");
  assert.match(app, /<MaterialsPanel\b/);
  assert.match(app, /<ScriptPanel\b/);
  assert.match(app, /<CaptionsPanel\b/);
  assert.match(app, /<Inspector\b/);
  assert.match(app, /<Timeline\b/);
  assert.match(app, /<div className="transport ocTransport">/);
  assert.match(css, /P2 checkpoint 1: OpenCut compact header/);
  assert.match(css, /\.ocSidePanel\b/);
  assert.match(css, /\.ocTransport\b/);
  assert.match(css, /\.ocInspector\b/);
  assert.match(css, /\.ocTimeline\b/);

  // P6.5: timecode reads as classic (font-mono + tabular-nums, muted)
  assert.match(css, /\.ocTransport \.tcode \{[\s\S]*font-family:\s*ui-monospace[\s\S]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.ocTransport \.tRight \{ gap: 0\.45rem; \}/);

  // P6.3 left inspector: rail chrome loses its left-bar and tightens to Classic sizing.
  assert.match(css, /\.ocSidePanel \.ocIconRail \[role="tab"\]\s*\{[^}]*width:\s*2rem;/s);
  assert.doesNotMatch(css, /\.ocIconRail \[role="tab"\]::before/);
  assert.match(css, /\.ocSidePanel \.ocPaneAction\s*\{/);

  // P6.6 timeline parity: no explicit add-track button remains in the left pane.
  assert.doesNotMatch(app, /onClick=\{\(\) => addTrack\("caption"\)\}/);
  assert.doesNotMatch(app, /テロップトラックを追加/);
});

test("P2 checkpoint 2 mounts exactly eight accessible FrameWright icon-rail tabs", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  const tabs = app.slice(app.indexOf("const PANEL_TABS"), app.indexOf("] as const", app.indexOf("const PANEL_TABS")));
  for (const entry of [
    '["materials", "素材"]',
    '["hyperframes", "AI 生成"]',
    '["script", "スクリプト"]',
    '["captions", "テロップ"]',
    '["stickers", "ステッカー"]',
    '["effects", "エフェクト"]',
    '["adjust", "色調整"]',
    '["settings", "設定"]',
  ]) assert.ok(tabs.includes(entry), `missing rail capability ${entry}`);
  assert.ok(!tabs.includes('["sounds"'), "sounds tab should be removed (P1)");
  assert.ok(!tabs.includes('["transitions"'), "transitions tab should be removed (P2)");
  assert.equal((tabs.match(/^\s*\["/gm) ?? []).length, 8);
  // 「AI 生成」はレール末尾の「設定」の直上(道具の並びの後ろ)
  assert.match(tabs, /\["hyperframes", "AI 生成"\][\s\S]*\["settings", "設定"\]/);
  assert.match(app, /<nav className="tabs ocIconRail" role="tablist" aria-label="編集パネル">/);
  assert.match(app, /PANEL_TABS\.map\(\(\[id, label\]\) => \(\s*<Tooltip key=\{id\}>/);
  assert.match(app, /role="tab"[\s\S]*aria-label=\{label\}[\s\S]*aria-selected=\{tab === id\}/);
  assert.match(app, /aria-controls=\{`panel-\$\{id\}`\}/);
  assert.match(app, /onClick=\{\(\) => setTab\(id\)\}/);
  assert.match(app, /<TooltipContent side="right">\{label\}<\/TooltipContent>/);
  assert.match(app, /id=\{`panel-\$\{tab\}`\}[\s\S]*role="tabpanel"/);

  for (const capability of [
    "materials",
    "hyperframes",
    "script",
    "captions",
    "stickers",
    "effects",
    "adjust",
    "settings",
  ]) {
    assert.match(app, new RegExp(`\\{tab === "${capability}" && `));
  }
  assert.match(panels, /export const PanelHeader = \(/);
  assert.match(panels, /export const SettingsPanel = \(/);
  assert.match(app, /<SettingsPanel[\s\S]*onOpenFullSettings=\{openSettings\}/);
  assert.match(app, /if \(tab !== "script" \|\| script !== null \|\| scriptFetchingRef\.current\) return;/);
});

test("Materials reskin preserves actions, cards, drag/drop, placement, and context states", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  const css = read("editor/client/styles.css");

  for (const prop of [
    "onUploadClick={onUploadClick}",
    "onUploadFiles={(files) => void uploadOnly(files)}",
    "onDelete={(f) => void deleteMaterialFile(f)}",
    "onDeleteCard={(name) => void deleteHyperframeCard(name)}",
    "onRenderHyperframe={(name) => void runHyperframeRender(name)}",
    "onDragBegin={onMaterialDragBegin}",
    "onDragEnd={onMaterialDragEnd}",
  ]) assert.ok(app.includes(prop), `missing MaterialsPanel handler ${prop}`);
  assert.match(app, /void placeMaterial\(\s*f,\s*null,\s*AUDIO_ONLY_RE\.test\(f\) \? "bgm" : "overlay",/);

  assert.match(panels, /className=\{`matPanel ocMaterialsPanel\$\{dragOver \? " dragOver" : ""\}`\}/);
  assert.match(panels, /e\.dataTransfer\.types\.includes\("Files"\)/);
  assert.match(panels, /const files = Array\.from\(e\.dataTransfer\.files\);\s+if \(files\.length > 0\) onUploadFiles\(files\);/);
  assert.match(panels, /className="matDropOverlay"/);
  assert.match(panels, /e\.dataTransfer\.setData\(MATERIAL_MIME, file\)/);
  assert.match(panels, /chip\.className = "dragChip"/);
  assert.match(panels, /e\.dataTransfer\.setDragImage\(chip, 12, 12\)/);
  assert.match(panels, /onDragBegin\(file\)/);
  assert.match(panels, /onDoubleClick=\{\(\) => file && !busy && onPlace\(file\)\}/);
  assert.match(panels, /onDoubleClick=\{\(\) => !busy && onPlace\(m\)\}/);
  assert.match(panels, /title="素材"/);
  assert.match(panels, /const \[viewMode, setViewMode\] = useState<"grid" \| "list">\("grid"\)/);
  assert.match(panels, /const \[sortMenuOpen, setSortMenuOpen\] = useState\(false\)/);
  assert.match(panels, /const \[sortKey, setSortKey\] = useState<"name" \| "type" \| "duration" \| "size">\("name"\)/);
  assert.match(panels, /onClick=\{\(\) => setViewMode\(\(mode\) => \(mode === "grid" \? "list" : "grid"\)\)\}/);
  assert.match(panels, /viewMode === "grid" \? \(\s*<LayoutGrid size=\{14\}/);
  assert.match(panels, /onClick=\{\(\) => setSortMenuOpen\(\(v\) => !v\)\}/);
  assert.match(panels, /className="ocMaterialSortMenu" role="menu"/);
  assert.match(panels, /\["name", `Name \$\{sortKey === "name" && sortAsc \? "↑" : ""\}`\]/);
  assert.match(panels, /className="ocMaterialImport"[\s\S]*onClick=\{onUploadClick\}[\s\S]*Import/);
  assert.match(panels, /className="ocMaterialEmptyDrop"[\s\S]*onClick=\{onUploadClick\}[\s\S]*Drag and drop videos, photos, and audio files here/);
  assert.match(panels, /className=\{`matGrid \$\{viewMode\}`\}/);
  assert.match(panels, /sortedHyperframes\.map\(\(card\) =>/);
  assert.match(panels, /sortedMaterials\.map\(\(m\) =>/);
  // 配置ボタンは共有 DraggableItem 側に1つだけあり、ラベルと配置先は各カードが渡す
  // (旧: カードごとに matAddBtn を直書き。DOM とクラス名は抽出前と同一)
  assert.match(panels, /className="matAddBtn"[\s\S]*aria-label=\{addLabel\}/);
  assert.match(panels, /if \(!busy\) onPlace\(m\);[\s\S]*addLabel=\{`\$\{name\} を配置`\}/);
  assert.match(panels, /onContextMenu=\{\(event\) => openMenu/);
  assert.match(panels, /onContextMenu=\{\(e\) => openMenu\(e, \{ file: m \}\)\}/);

  for (const state of [
    "authorPendingName &&",
    "sortedHyperframes.map((card)",
    "sortedMaterials.map((m)",
    "matThumbUnplayable",
    "hyperframesLoading",
    "hyperframesError",
    "materialCount === 0",
    "inlineError",
    "needsUpdate",
    "isRendering",
  ]) assert.ok(panels.includes(state), `missing material state ${state}`);
  assert.match(panels, /disabled=\{busy\}[\s\S]*onClick=\{onUploadClick\}/);
  assert.match(panels, /onRenderHyperframe\(card\.name\)/);
  assert.match(panels, /onPlace\(menu\.file!\)/);
  assert.match(panels, /onDelete\(menu\.file!\)/);
  assert.match(panels, /onDeleteCard\(name\)/);
  for (const selector of [
    ".ocMaterialsPanel .matCard",
    ".ocMaterialsPanel .matThumbUnplayable",
    ".ocMaterialsPanel .aiMaterialPending",
    ".ocMaterialsPanel .aiMaterialPlaceholder",
    ".ocMaterialsPanel .aiMaterialUpdateBadge",
    ".ocMaterialsPanel .aiMaterialBusy",
    ".ocMaterialsPanel .aiMaterialSpinner",
    ".ocMaterialsPanel .ocMaterialHeaderIcon",
    ".ocMaterialsPanel .ocMaterialSortMenu",
    ".ocMaterialsPanel .ocMaterialImport",
    ".ocMaterialsPanel .ocMaterialEmptyDrop",
    ".ocMaterialsPanel .matGrid.list",
    ".ocMaterialsPanel .matAddBtn",
    ".ocMaterialsPanel .matDropOverlay",
    ".ocMaterialsPanel .ctxMenu",
  ]) assert.ok(css.includes(selector), `missing token skin ${selector}`);
});

test("AI generation tab hosts the author form while materials keeps the cards", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");

  assert.match(panels, /export const HyperframeAuthorPanel = \(/);

  // モーダル廃止の pin: 開閉 state・返却フォーカス管理はもう存在しない
  for (const gone of [
    "hyperframeAuthorOpen",
    "openHyperframeAuthor",
    "hyperframeAuthorReturnFocusRef",
  ]) assert.ok(!app.includes(gone), `should have removed ${gone}`);
  assert.doesNotMatch(app, /<Dialog[\s\S]*ocHyperframeAuthor/);

  // 送信直後にタブが切り替わる(§2.2)。setHyperframeAuthorPendingName の直後、
  // 非同期の postHyperframeAuthor 呼び出しより前(try の外)にある
  const runStart = app.indexOf("const runHyperframeAuthor = async");
  const runBody = app.slice(runStart, app.indexOf("\n  };", runStart));
  assert.match(runBody, /setHyperframeAuthorPendingName\(name\);\s*setTab\("materials"\);\s*try \{/);

  // カードは引き続き素材タブ(§1.4 の回帰防止=二重表示しない)
  assert.match(app, /!file\.startsWith\("materials\/hyperframes\/"\)/);

  // 生成中はどのタブに居ても一覧 pull を続ける(§8)
  assert.match(
    app,
    /if \(tab !== "materials" && !hyperframeAuthorPendingName\) return;/,
  );

  // HF タブはカードのライフサイクルを持たない(配置・ドラッグ・DraggableItem 無し)
  const panelStart = panels.indexOf("export const HyperframeAuthorPanel = (");
  const panelBody = panels.slice(panelStart, panels.indexOf("\n/**", panelStart));
  assert.doesNotMatch(panelBody, /DraggableItem/);

  // 出力ファイル名は人間に書かせない: 入力欄は無く、App が既存カードと
  // 衝突しない `ai-<n>` を自動採番する
  assert.doesNotMatch(panelBody, /hfAuthorNameField|ファイル名/);
  for (const gone of ["hyperframeAuthorName", "onNameChange"]) {
    assert.ok(!app.includes(gone), `filename input state should be gone: ${gone}`);
  }
  assert.match(app, /const nextHyperframeName = \(\): string => \{[\s\S]*`ai-\$\{n\}`/);
  assert.match(runBody, /const name = nextHyperframeName\(\);/);
});

test("asset drop zones share the OpenCut assets placeholder shape", () => {
  const panels = read("editor/client/Panels.tsx");
  const css = read("editor/client/styles.css");
  const command = read("editor/client/AiCommand.tsx");

  // 素材の空状態と AI タブの添付ドロップは同じ部品(丸アイコン+タイトル+補足)
  assert.equal((panels.match(/className="ocDropIcon"/g) ?? []).length, 2);
  assert.equal((panels.match(/className="ocDropTitle"/g) ?? []).length, 2);
  assert.equal((panels.match(/className="ocDropMeta"/g) ?? []).length, 2);
  for (const selector of [
    ".ocSidePanel .ocMaterialsPanel .ocMaterialEmptyDrop,\n.ocHyperframeAuthor .hfAssetDrop",
    ".ocHyperframeAuthor .hfAssetDrop .ocDropIcon",
    ".ocHyperframeAuthor .hfAssetDrop .ocDropTitle",
  ]) assert.ok(css.includes(selector), `missing shared drop-zone skin ${selector}`);
  // 空状態はパネル本体を占める(上端に小箱が浮かない)
  assert.match(css, /\.ocSidePanel \.ocMaterialsPanel \{ display: flex;[\s\S]*min-height: 100%; \}/);

  // 複数行の指示文は composer(本文の下に送信ボタンだけのフッタ行)。
  // 装飾のバッジ・キーヒントは持たない
  assert.match(css, /\.ocAiCommand:not\(\.modalStyle\):has\(textarea\) \{[\s\S]*grid-template-areas:/);
  for (const gone of ["aiBadge", "aiCommandHint"]) {
    assert.ok(!command.includes(gone), `composer chrome should be gone: ${gone}`);
    assert.ok(!css.includes(gone), `composer chrome style should be gone: ${gone}`);
  }
  assert.match(command, /e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey\)/);
});

test("DraggableItem is the one shared asset-card shell for every asset card", () => {
  const panels = read("editor/client/Panels.tsx");

  // 共有シェルは1つだけ。素材カード3種(生成待ち / HyperFrames / 通常素材)+
  // PresetPanel(ステッカー/エフェクト)が別々に組み立てていた DOM をここへ寄せた
  assert.equal(panels.match(/export const DraggableItem = \(/g)?.length, 1);
  assert.equal(panels.match(/<DraggableItem\b/g)?.length, 4);
  // 抽出前と同じ DOM 骨格(styles.css と .ocMaterialsPanel のトークン皮膚が効く条件)
  assert.match(
    panels,
    /<div className="materialThumbWrap">\s*\{preview\}\s*\{overlay\}\s*\{onAdd && \(/,
  );
  assert.match(panels, /\{name !== undefined && \(\s*<div className="matName" title=\{nameTitle\}>/);
  // OpenCut のポータル製ドラッグゴーストは採らず、FrameWright の dragChip を呼び出し側に残す
  // (タイムラインのドロップゴーストと二重に出さないため)
  assert.ok(!panels.includes("createPortal"), "DraggableItem must not adopt OpenCut's portal ghost");
  // 配置先の時刻は App の再生ヘッドが持つので onAdd は引数を取らない
  assert.match(panels, /onAdd\?: \(\) => void;/);
  // 生成待ちカードだけが読み上げ対象。配置もドラッグもできない(+ ボタンを出さない)
  assert.match(panels, /ariaLive\?: "polite" \| "assertive";/);
  assert.match(panels, /className="matCard aiMaterialCard"\s*ariaLive="polite"/);
});

test("P6.6 track creation is preserved through Inspector track selects, not add-track buttons", () => {
  const app = read("editor/client/App.tsx");
  const inspector = read("editor/client/Inspector.tsx");
  const timeline = read("editor/client/Timeline.tsx");

  assert.match(app, /const addTrack = \(kind: "caption" \| "overlay" \| "text"\) =>/);
  assert.doesNotMatch(app, /onAddTrack=\{addTrack\}/);
  assert.doesNotMatch(timeline, /onAddTrack|addMenuOpen|トラックを追加\(種類を選択\)/);
  assert.match(inspector, /<option value="__new">＋ 新規トラック<\/option>/);
  assert.match(inspector, /updateCaption\(selection\.index, \{ track: capTracks \+ 1 \}\)/);
  assert.match(inspector, /patch\(\{ track: ovTracks \+ 1, layer: undefined \}\)/);
  assert.match(inspector, /setTextTrack\(selection\.index, n\)/);
});

test("transport has a scoped deterministic 1024px wrap rule", () => {
  const css = read("editor/client/styles.css");
  assert.match(css, /@media \(max-width: 1024px\) \{[\s\S]*\.ocTransport \.tRow \{[\s\S]*flex-wrap: wrap;/);
  assert.match(css, /\.ocTransport \.tCenter \{[\s\S]*order: 1;[\s\S]*width: 100%;[\s\S]*justify-content: center;/);
  assert.match(css, /\.ocTransport \.tLeft \{ order: 2; \}/);
  assert.match(css, /\.ocTransport \.tRight \{ order: 3; \}/);
  assert.match(css, /\.ocTransport \.tLeft,[\s\S]*\.ocTransport \.tRight \{[\s\S]*flex: 1 1 100%;[\s\S]*width: 100%;[\s\S]*justify-content: center;[\s\S]*flex-wrap: wrap;[\s\S]*overflow: visible;/);
});

test("P2 checkpoint 1 provenance records exact header primitive sources and adaptations", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  const revision = "cf5e79e919144200294fb9fed22a222592a0aeea";
  assert.ok(provenance.includes(`${revision}/apps/web/src/components/ui/popover.tsx`));
  assert.ok(provenance.includes(`${revision}/apps/web/src/components/ui/tooltip.tsx`));
  assert.match(provenance, /`radix-ui` 1\.6\.4/);
  assert.match(provenance, /`lucide-react` 1\.25\.0/);
  assert.match(provenance, /native approval\s+checkbox/);
  assert.match(provenance, /controlled\s+Popover/);
});

test("P2 checkpoint 2 provenance records assets rail and transport adaptation boundaries", () => {
  const provenance = read("editor/client/vendor/opencut/PROVENANCE.md");
  const revision = "cf5e79e919144200294fb9fed22a222592a0aeea";
  for (const source of [
    "apps/web/src/app/globals.css",
    "apps/web/src/components/ui/button.tsx",
    "apps/web/src/components/ui/native-select.tsx",
    "apps/web/src/components/ui/slider.tsx",
  ]) assert.ok(provenance.includes(`${revision}/${source}`), `missing provenance ${source}`);
  assert.match(provenance, /OS-file upload, HyperFrames AI\s+authoring/);
  assert.match(provenance, /scoped 1024px multi-row rule/);
  assert.match(provenance, /dual-axis Timeline and Inspector remain untouched/);
});

test("P7.2 adds click-to-edit timecode and a preview-only zoom control", () => {
  const app = read("editor/client/App.tsx");
  const css = read("editor/client/styles.css");

  assert.match(app, /<NativeSelect[\s\S]*className="zoomSel"[\s\S]*setPreviewZoom\(/);
  assert.match(app, /className="viewerScale"[\s\S]*transform: `scale\(\$\{previewZoom\}\)`/);
  // 表示倍率はプレビュー上のフローティングではなく transport の右クラスタ
  // (OpenCut の PreviewToolbar 右=ZoomSelect+fullscreen と同じ並び)
  assert.match(css, /\.ocTransport select\.zoomSel/);
  assert.match(css, /\.ocTransport \.tSlash \{[\s\S]*padding: 0 0\.4rem;/);
});

test("P7.3a Adjustment tab is the first colorFilter UI, global and cleaned to undefined", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  const tabsStart = app.indexOf("const PANEL_TABS");
  const tabs = app.slice(tabsStart, app.indexOf("] as const", tabsStart));
  assert.ok(tabs.includes('["adjust", "色調整"]'), "missing adjust PANEL_TABS entry");
  assert.match(app, /const updateColorFilter = \(patch: Partial<ColorFilter>/);
  assert.match(app, /Object\.keys\(merged\)\.length === 0/); // all-default -> drop colorFilter
  assert.match(app, /const resetColorFilter = \(\)/);
  assert.match(app, /<AdjustmentPanel[\s\S]*onChange=\{updateColorFilter\}[\s\S]*onReset=\{resetColorFilter\}/);
  assert.match(panels, /export const AdjustmentPanel = \(/);
  assert.match(panels, /"overlays:colorFilter"/); // coalesce key collapses drag to one undo
});

test("left rail presets add at playhead and drop onto a revealed track", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  const presets = read("editor/client/presets.ts");
  const model = read("editor/client/model.ts");
  const timeline = read("editor/client/Timeline.tsx");

  const tabsStart = app.indexOf("const PANEL_TABS");
  const tabs = app.slice(tabsStart, app.indexOf("] as const", tabsStart));
  assert.equal((tabs.match(/^\s*\["/gm) ?? []).length, 8);
  assert.ok(!tabs.includes('["sounds"'));
  assert.ok(!tabs.includes('["transitions"'));

  // old launcher/picker panels are gone; PresetPanel is the one shared library UI
  assert.match(panels, /export const PresetPanel = \(/);
  for (const removed of ["export const AssetPickerPanel", "export const EffectsPanel", "export const TransitionsPanel"])
    assert.ok(!panels.includes(removed), `${removed} should have been removed`);

  // presets.ts covers all three annotation shapes and all effect kinds
  assert.match(presets, /export const ANNOTATION_PRESETS: EditorPreset\[\] = \[/);
  assert.match(presets, /export const EFFECT_PRESETS: EditorPreset\[\] = \[/);
  for (const kind of ['type: "arrow"', 'type: "box"', 'type: "spotlight"'])
    assert.ok(presets.includes(kind) || presets.includes('kind: "annotation"'), `annotation presets missing ${kind}`);
  assert.match(presets, /"ann-box"/);
  assert.match(presets, /"ann-arrow-right"/);
  assert.match(presets, /"ann-spotlight"/);
  for (const kind of ['kind: "zoom"', 'kind: "blur"', 'kind: "wipeFull"'])
    assert.ok(presets.includes(kind), `effect presets missing ${kind}`);

  // addPresetAt: srcAt -> addByKind order, shared with the + button and DnD
  const addPresetAtStart = app.indexOf("const addPresetAt = (preset: EditorPreset, outT: number");
  assert.ok(addPresetAtStart >= 0);
  const addPresetAtEnd = app.indexOf("\n  };", addPresetAtStart);
  const addPresetAtBody = app.slice(addPresetAtStart, addPresetAtEnd);
  assert.match(addPresetAtBody, /srcAt\(outT\)/);
  assert.match(addPresetAtBody, /addByKind\(preset\.kind, round2\(s\), round2\(e\), options\?\.track\)/);
  // §8.1.1 regression pin: the preset add path never touches layerOrder/track creation
  assert.ok(!addPresetAtBody.includes("layerOrder"), "addPresetAt must not touch layerOrder");
  assert.ok(!addPresetAtBody.includes("createOverlayTrack"), "addPresetAt must not create tracks");
  assert.ok(!addPresetAtBody.includes("onAddTrack"), "addPresetAt must not call onAddTrack");

  assert.match(app, /<PresetPanel[\s\S]*presets=\{ANNOTATION_PRESETS\}[\s\S]*onAdd=\{\(p\) => addPresetAt\(p, playhead\.get\(\)\)\}/);
  assert.match(app, /<PresetPanel[\s\S]*presets=\{EFFECT_PRESETS\}[\s\S]*onAdd=\{\(p\) => addPresetAt\(p, playhead\.get\(\)\)\}/);
  assert.match(app, /disabledIds=\{proj\?\.hasCamera === false \? \["wipe-full"\] : undefined\}/);

  // §2 regression pin: visibleTracks reveals the preset's target track while dragging
  assert.match(app, /t\.id === presetDrag\?\.track \|\|/);

  // DnD: PRESET_MIME checked before MATERIAL_MIME in onDropTimeline, and
  // accepted (alongside Files/MATERIAL_MIME) in onDragOverTimeline
  assert.match(model, /export const PRESET_MIME = "application\/x-framewright-preset";/);
  assert.match(timeline, /types\.includes\(PRESET_MIME\)/);
  const dropStart = timeline.indexOf("const onDropTimeline = (e: ReactDragEvent) => {");
  const dropEnd = timeline.indexOf("\n  };", dropStart);
  const dropBody = timeline.slice(dropStart, dropEnd);
  assert.ok(dropBody.indexOf("getData(PRESET_MIME)") < dropBody.indexOf("getData(MATERIAL_MIME)"));
  assert.match(timeline, /presetDragTrack: TrackId \| null;/);
  assert.match(timeline, /onDropPreset: \(outT: number, presetId: string\) => void;/);
  assert.match(timeline, /onDropPresetNewTrack: \(outT: number, presetId: string\) => void;/);
  assert.match(timeline, /ocTrackDropLane/);

  // CSS pins for the preset panel/card shell and the drop-lane row styling
  const css = read("editor/client/styles.css");
  for (const selector of [".ocPresetPanel", ".ocPresetCard", ".ocTrackDropLane"])
    assert.ok(css.includes(selector), `missing CSS pin ${selector}`);
});

test("P7.4b duplicate (⌘D) reuses the vetted paste clone path and adds insert", () => {
  const app = read("editor/client/App.tsx");
  const timeline = read("editor/client/Timeline.tsx");
  // shared clone+place path
  assert.match(app, /const insertClipAt = \(clip: Clipboard, base: number\)/);
  assert.match(app, /const pasteClipboard = \(\) => \{[\s\S]*insertClipAt\(clip, base\)/);
  // duplicate places immediately after the original (source end) via the same path
  assert.match(app, /insertClipAt\(clip, clip\.entry\.end\)/);
  // insert branch (Clipboard-unsupported) duplicates via at+durationSec
  assert.match(app, /at: round2\(ins\.at \+ ins\.durationSec\), id: undefined/);
  // ⌘D keybind
  assert.match(app, /e\.key\.toLowerCase\(\) === "d"[\s\S]*duplicateSelected\(\)/);
  // toolbar button, no context menu
  assert.match(timeline, /aria-label="複製"[\s\S]*onClick=\{onDuplicate\}/);
  assert.doesNotMatch(timeline, /onContextMenu=/);
});

test("captions panel keeps an add path when the timeline track is hidden", () => {
  const app = read("editor/client/App.tsx");
  const panels = read("editor/client/Panels.tsx");
  assert.match(app, /title="テロップ"[\s\S]*addAtPlayhead\("caption"\)/);
  assert.match(app, /<CaptionsPanel[\s\S]*onAdd=\{\(\) => addAtPlayhead\("caption"\)\}/);
  assert.match(panels, /title="テロップはまだありません"[\s\S]*テロップを追加/);
});
