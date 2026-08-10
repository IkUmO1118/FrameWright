// CLI ヘルプの分類と整形(cli.ts のコマンド登録に対する「目次」)。
//
// コマンドが50本を超えた結果、commander 既定の一覧(全コマンド × 長い
// .description())は端末1画面に収まらず、初見の人間が「まず何を叩くか」を
// 読み取れなくなった。そこでヘルプを2段にする:
//   `framewright --help`   … 基本の流れ+編集まわりだけの短い案内(この画面で完結)
//   `framewright commands` … 全コマンドを分類つきで一覧(要約1行のみ)
// 各コマンドの詳細(全オプション)は従来どおり `framewright <cmd> --help`。
//
// COMMAND_GROUPS が分類の単一の出所で、要約は commander の .summary()
// (一覧用の短文。.description() は個別ヘルプ用の詳細)として流し込む。
// コマンドを足したらここにも1行足す(test/cliHelp.test.ts が網羅を固定する)。

/** 一覧に出す1コマンド。summary は端末1行に収まる長さに保つ */
export type CommandEntry = { name: string; summary: string };

export type CommandGroup = { title: string; note?: string; hidden?: true; commands: CommandEntry[] };

/** 分類の単一の出所。並び順がそのまま `framewright commands` の出力順になる */
export const COMMAND_GROUPS: CommandGroup[] = [
  {
    title: "セットアップ・診断",
    commands: [
      { name: "doctor", summary: "環境チェック(node/ffmpeg/whisper/AI 到達性)" },
      { name: "ai", summary: "AI provider の診断(ai doctor)" },
    ],
  },
  {
    title: "取り込み〜カット案",
    note: "run は AI 初版の一括生成。以下は個別のやり直し用",
    commands: [
      { name: "run", summary: "AI に初版を作らせる(transcribe→detect→plan)" },
      { name: "ingest", summary: "収録ファイルを解析(manifest.json・音声抽出)" },
      { name: "transcribe", summary: "文字起こし(transcript.json / .srt)" },
      { name: "detect", summary: "無音からカット候補(cuts.auto.json)" },
      { name: "plan", summary: "LLM で意味カット・章立て・タイトル案" },
      { name: "remeta", summary: "章・タイトル・概要欄だけ作り直す(カットは不変)" },
    ],
  },
  {
    title: "確認・承認・書き出し",
    commands: [
      { name: "editor", summary: "GUI エディタを開く(編集・承認・レンダーまで)" },
      { name: "derive", summary: "選択範囲を別キャンバスの派生プロジェクトにする" },
      { name: "preview", summary: "カット確認用の軽い動画(preview.mp4)" },
      { name: "approve", summary: "カットを承認(人間の操作。render の唯一のゲート)" },
      { name: "unapprove", summary: "承認を取り消す" },
      { name: "render", summary: "最終レンダー(final.mp4)" },
      { name: "thumbnail", summary: "サムネイル静止画を生成(thumbnail.png)" },
      { name: "clean", summary: "中間生成物・キャッシュを安全削除" },
    ],
  },
  {
    title: "編集を当てる",
    commands: [
      { name: "validate", summary: "編集ファイルの整合性を検査(JSON を直したら毎回)" },
      { name: "apply", summary: "@id 指定の編集を検査付きで当てる(全適用 or ゼロ書込)" },
      { name: "id-stamp", summary: "各要素に @id を一括採番(冪等)" },
      { name: "describe", summary: "タイムライン要約(--json で機械可読な完全射影)" },
      { name: "assert", summary: "宣言した編集意図(assertions.json)を検証" },
    ],
  },
  {
    title: "中身を知る(知覚)",
    commands: [
      { name: "frames", summary: "指定時刻・変化点(--scenes)を最終合成の見た目で PNG に" },
      { name: "frames-serve", summary: "frames を高速化する常駐サーバ(opt-in)" },
      { name: "screen", summary: "画面状態の区間トラックを作る(要 av)" },
      { name: "probe", summary: "素材・A/V・画面の知覚をまとめて実行" },
      { name: "record", summary: "収録に連動してカーソル座標を記録(macOS)" },
      { name: "index", summary: "収録横断のローカル検索インデックスを更新" },
      { name: "search", summary: "収録・素材・OCR・文字起こしをローカル検索" },
      { name: "review", summary: "before/after のレビュー束を生成" },
    ],
  },
  {
    title: "AI に下書きさせる",
    note: "いずれも下書き止まり。cutplan(カット)と承認には触れない",
    commands: [
      { name: "draft", summary: "素材・演出・BGM の下書きをまとめて実行" },
      { name: "learn", summary: "次回用のチャンネルルール追記案を下書き" },
    ],
  },
  {
    title: "検品する",
    note: "編集ファイルは書かない。修正案は apply パッチの下書きとして出る",
    commands: [
      { name: "check", summary: "素材・演出・BGM・型・境界をまとめて検品" },
    ],
  },
  {
    title: "旧名(互換)",
    hidden: true,
    commands: [
      { name: "materials", summary: "素材(B-roll)の尺・解像度・参照/未使用を調べる" },
      { name: "av", summary: "keep 後タイムラインの動き・音を計測" },
      { name: "style-profile", summary: "動画からスタイルプロファイルを抽出" },
      { name: "plan-materials", summary: "素材の配置を下書き(overlays.json)" },
      { name: "plan-effects", summary: "演出(ズーム・ぼかし・注釈)を下書き" },
      { name: "plan-bgm", summary: "BGM の区間配置を下書き(bgm.json)" },
      { name: "autozoom", summary: "カーソル dwell からズームを自動配置(LLM 不使用)" },
      { name: "material-fit", summary: "素材の尺不整合・未使用/参照切れを検出" },
      { name: "effect-check", summary: "演出(ズーム・ぼかし・注釈)を検品" },
      { name: "bgm-fit", summary: "BGM の音量・発話被り・フェードを検品" },
      { name: "style-check", summary: "学習した型からの逸脱を測る" },
      { name: "boundary-check", summary: "keep 終端の語尾食いを実音声で検品" },
    ],
  },
  {
    title: "HyperFrames(無音の作図素材)",
    commands: [
      { name: "hyperframe", summary: "カードを下書き・render する" },
      { name: "hyperframe-backends", summary: "backend の利用状態を表示(収録フォルダ不要)" },
      { name: "hyperframe-place", summary: "render 済みカードの配置案を書く" },
      { name: "hyperframe-check", summary: "カードの動的監査(render 不要)" },
      { name: "hyperframe-freeze", summary: "再利用のための凍結 DRAFT を書く" },
    ],
  },
  {
    title: "エージェント連携",
    commands: [
      { name: "mcp", summary: "MCP サーバ(read+安全編集だけを露出。承認は非露出)" },
    ],
  },
  {
    title: "研究・較正(上級)",
    note: "detect の閾値を実測で決めるための read-only 比較。収録フォルダには書かない",
    commands: [
      { name: "silence-sweep", summary: "固定 silenceDb を4水準で比較" },
      { name: "floor-calibration", summary: "収録ごとの無音床から閾値を較正" },
      { name: "boundary-direction", summary: "人間の最終版と detect の境界差を分類" },
      { name: "compaction-sweep", summary: "無音圧縮の時間3ノブ36条件を比較" },
      { name: "calibration-evaluate", summary: "固定10 variant を同一測定系で比較" },
    ],
  },
  {
    title: "その他",
    commands: [
      { name: "commands", summary: "この一覧を表示する" },
    ],
  },
];

/** 分類に載っている全コマンド名(重複なし)。ドリフト検知テストが使う */
export function listedCommandNames(): string[] {
  return COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => c.name));
}

/** name → summary。cli.ts が commander の .summary() へ流し込む */
export function commandSummaries(): Map<string, string> {
  return new Map(COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => [c.name, c.summary] as const)));
}

/** 全角を2桁と数えた表示幅(端末の桁揃え用。CJK 統合漢字・かな・全角記号だけを
 *  広い文字として扱う簡易判定で、絵文字や結合文字は想定しない) */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(1, width - displayWidth(text)));
}

/** `framewright commands` の本文(分類つきの全コマンド一覧) */
export function formatCommandList(bin: string): string {
  const visibleNames = COMMAND_GROUPS.filter((g) => g.hidden !== true).flatMap((g) => g.commands.map((c) => c.name));
  const width = Math.max(...visibleNames.map((n) => displayWidth(n))) + 2;
  const out: string[] = ["", `${bin} のコマンド一覧(詳細は ${bin} <コマンド> --help)`, ""];
  for (const g of COMMAND_GROUPS) {
    if (g.hidden === true) continue;
    out.push(`${g.title}`);
    if (g.note) out.push(`  ※ ${g.note}`);
    for (const c of g.commands) out.push(`  ${pad(c.name, width)}${c.summary}`);
    out.push("");
  }
  out.push("収録フォルダを引数に取らないコマンド: doctor / ai doctor / record / index / search /");
  out.push("  style-profile / hyperframe-backends / commands");
  out.push("");
  out.push("ドキュメント: docs/usage.md(目的別索引)/ docs/guides/command-reference.md(使い分け)");
  out.push("");
  return out.join("\n");
}

/** 一覧から指定コマンドの要約を引く(短いヘルプの組み立て用) */
function summaryOf(name: string): string {
  return commandSummaries().get(name) ?? "";
}

/** `framewright --help` の本文。全コマンドは出さず、初見で叩く順に絞る */
export function formatRootHelp(bin: string, globalOptions: string[]): string {
  const core = ["doctor", "editor", "run", "preview", "approve", "render"];
  // 知覚 → 下書き → 検品。書き込み権限で割れた3層(probe は *.probe/ だけ、
  // draft は編集ファイル、check は --fix なしなら *.suggested.json だけ)。
  const layers = ["probe", "draft", "check"];
  const editing = ["validate", "describe", "frames", "apply", "clean"];
  const width = Math.max(...[...core, ...layers, ...editing].map((n) => displayWidth(n))) + 2;
  const section = (title: string, names: string[]): string[] => [
    title,
    ...names.map((n) => `  ${pad(n, width)}${summaryOf(n)}`),
    "",
  ];
  return [
    "",
    `${bin} — 撮影後の編集を自動化するローカルファーストな動画パイプライン`,
    "",
    `  ${bin} <コマンド> <収録フォルダ> [オプション]`,
    "",
    ...section("基本の流れ", core),
    ...section("知覚・下書き・検品", layers),
    ...section("編集まわり", editing),
    "グローバルオプション",
    ...globalOptions.map((l) => `  ${l}`),
    "",
    `全コマンド(分類つき)   ${bin} commands`,
    `コマンドごとの詳細      ${bin} <コマンド> --help`,
    "ドキュメント            docs/usage.md",
    "",
  ].join("\n");
}
