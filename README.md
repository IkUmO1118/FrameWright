# FrameWright

撮影後の編集をエディタ起点で進める、ローカルファーストな動画パイプライン。

手元の動画1本(スマホで撮った縦動画・画面録画・カメラ動画など)から、
文字起こし → カット案の生成 → **人間の承認** → 最終レンダーまでを CLI で行います。
特別な収録設定は要りません。動画を1本フォルダに置けば始められます
(→ [すぐに触ってみる](#すぐに触ってみるサンプル))。
文字起こしと無音検出は完全ローカル(無料)。LLM を使うのは意味的な
カット判断・章立てのみで、Claude Code のサブスク(`claude` CLI)、
Codex CLI、従量課金 API のいずれでも動きます。
LLM に渡るのは**文字起こしテキスト**(と任意の `brief.md`)だけで、映像・音声・
画面は PC 内に留まります(→ [プライバシー](docs/getting-started.md#データはどこへ行くかプライバシー))。

## パイプライン

入口は**エディタでプロジェクトを開くこと**です(標準的な NLE と同じ)。
エディタで開いた直後、文字起こしが未実行なら文字起こしと無音検出だけを自動で走らせます。

```
① editor          プロジェクトを開く(空フォルダでもよい)
     └─ 画面内でベース動画/音声とキャンバス(16:9 / 9:16 / 1:1 …)を選ぶ
     └─ ingest が走り manifest.json + 空 transcript + 全編 keep cutplan ができる
  │
② 自動解析       エディタで開くと必要時だけ transcribe → detect
     ├─ transcribe  whisper.cpp で文字起こし    → transcript.json / .srt
     ├─ detect      無音検出(ffmpeg・決定的)   → cuts.auto.json
  │
③ run(任意)      CLI で初版まで作りたいときだけ plan まで実行
     └─ plan        LLMで意味カット・章立て     → cutplan.json / chapters.json / meta.json
  │
④ 編集            エディタ、または収録フォルダの JSON を直接編集
  │
⑤ preview         カット結果の確認用動画       → preview.mp4
  │
  ├─ ★ 人間が preview を見て approve(承認ゲート。AI は通せない)
  │
⑥ render          合成エンジンで書き出し        → cut.mp4(中間)/ final.mp4
```

各ステージは JSON を読んで JSON を書くだけなので、単独で再実行できます。
`run` は CLI で transcribe → detect → plan をまとめて走らせるコマンドです。
収録直後に1発叩く従来の使い方もそのまま通ります
(`manifest.json` がまだ無いフォルダでは `ingest` から始めます)。

**1プロジェクト = 1フォルダ = 1出力**です。同じ収録から縦のショートも作りたい
場合は、元メディアを共有する**派生プロジェクト**を `derive` で作ります
(→ [縦動画・別サイズを作る](#縦動画別サイズを作る))。

## セットアップ

> **セットアップを AI エージェントに任せる場合**: このリポジトリを Claude Code などの
> AI コーディングエージェントに渡しているなら、[SETUP_WITH_AI.md](SETUP_WITH_AI.md) を
> 読ませるだけで、環境チェック(`doctor`)が緑になるまで自動でセットアップさせられます
> (エージェントは環境構築だけを行い、承認・render・収録データには触れません)。
> 手で進める場合は以下。

必要なもの: macOS / Node.js 23.6+ / Homebrew

```sh
brew install ffmpeg whisper-cpp
mkdir -p ~/Models/whisper
curl -L -o ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
npm install
npm link      # `framewright` コマンドをどこからでも使えるようにする(任意・推奨)
```

> whisper モデルはまず軽い `base`(≈150MB)で即試し、本番で `large-v3-turbo` に上げる
> 2段運用ができます(切替は `config.yaml` の `whisper.model` 1行)。手順は
> [docs/getting-started.md](docs/getting-started.md#whisper-モデルは2段で選ぶまず小さく試す--本番で精度を上げる) を参照。

インストール後、環境が揃っているかは1コマンドで確認できます:

```sh
framewright doctor
```

### コマンドの2つの入口

`npm link` すると `framewright <コマンド>` がどこからでも打てます(収録フォルダ側で
作業しているときもリポジトリへ `cd` しなくてよく、Node のバージョン不足も
人間可読なメッセージで弾かれるので、**人間はこちらを使う**のがおすすめ)。

リンクしていなくても、リポジトリのルートから同じことができます:

```sh
framewright doctor            # npm link 済み(推奨)
node src/cli.ts doctor    # リンク不要。リポジトリのルートから
```

以下このリポジトリのドキュメントは、リンク前提を置かないため
`node src/cli.ts …` で書いています。`framewright …` と読み替えて構いません
(CLI が出すヒントも、実際に使った入口に合わせて書き分けます)。

必須(Node / ffmpeg / ffprobe / config)が欠けていれば exit 1、収録・AI 系(whisper・
モデル・エンコーダ・AI provider)の不足は warn(exit 0)で一覧表示されます。`--json` を
付けると機械可読な `DoctorReport` を標準出力に出せます(エージェント委任時のループに使う)。
詳細は [docs/usage.md の「環境プリフライト(doctor)」](docs/usage.md) を参照。

> **Linux で試す / mac が無い場合は Docker で再現環境を作れます。** リポジトリ直下で
> `docker build -t framewright .` → `docker run --rm framewright doctor --no-ai` を叩くと、
> 必須チェック(Node / ffmpeg / ffprobe / config)が緑になった Linux 環境をそのまま
> 確認できます(whisper は同梱しないので warn=想定内)。収録フォルダは
> `-v ~/Movies/framewright:/recordings` でマウントして編集します。

> **AI の既定は API です。** `config.yaml` に `ai:` を書かない場合、
> `.env` か環境変数の `ANTHROPIC_API_KEY`(無ければ `OPENAI_API_KEY`)で
> 接続先が決まります。どちらも無いと `plan` 段で「config.yaml の ai を
> 設定するか、鍵を .env に入れてください」で止まります。`claude` CLI
> (Claude Code)や Codex CLI を使いたい場合は `ai.profiles` で
> `adapter: claude-code` / `codex` を明示してください
> (→ [設定](#設定) の「AI provider」)。文字起こし・無音検出・レンダーは
> LLM 不要です。

> **収録は普通の動画1本で構いません。** スマホの縦動画・QuickTime 等の画面録画・
> カメラ動画を1本、収録フォルダに入れて `editor` で開けば、そのまま **plain レイアウト**
> (カメラワイプ無し・収録の実寸のまま)で編集できます。手元に動画がまだ無くても、
> [すぐに触ってみる](#すぐに触ってみるサンプル)の同梱サンプルで `editor`→`render` を
> 体験できます。画面とカメラを1つのキャンバスに同時収録して右下ワイプに合成する
> 使い方は[発展: 画面+カメラを1本に収録する(拡張キャンバス)](#発展-画面カメラを1本に収録する拡張キャンバス)にまとめました。

## 使い方

### すぐに触ってみる(サンプル)

収録した動画も whisper モデルのダウンロードも無しで、`editor`→`render` を最短で体験できます。
`ffmpeg` で数秒のサンプル動画を合成し、編集可能な収録フォルダ(`examples/sample/`)を
用意します。

```sh
npm run sample        # = bash scripts/make-sample.sh
```

実行後に表示される3コマンド(`editor` / `approve` / `render`)をそのまま叩けば、
自動カット済みのサンプルが `examples/sample/final.mp4` として書き出されます。
片付けは `rm -rf examples/sample`。詳細は
[docs/getting-started.md の「サンプルで試す」](docs/getting-started.md#22-サンプルで試すobswhisper-不要)。

### プロジェクトを開く

引数なしで `editor` を起動すると、`config.yaml` の `recordingsDir`
(既定 `~/Movies/framewright`)にあるプロジェクトの一覧(ランチャー)が開きます。

```sh
node src/cli.ts editor            # プロジェクト一覧。「+ 新規プロジェクト」から作れる
```

一覧では各プロジェクトの尺・キャンバス比・書き出し済みバッジが並び、
「+ 新規プロジェクト」で名前とキャンバスを選ぶと空のプロジェクトができます。
開いた先で**ベースになる動画/音声を画面から選ぶ**と(候補が1本しか無ければ自動で
確定)、そこが編集開始点です。

フォルダを直接指定しても同じです(まだ存在しないフォルダ名でも作って開きます)。

```sh
# プロジェクトを1つ開く。全編 keep の状態から編集を始められる
node src/cli.ts editor ~/Movies/framewright/2026-07-02-my-recording

# 縦(9:16)のプロジェクトとして作る
node src/cli.ts editor ~/Movies/framewright/2026-08-03-short --canvas portrait

# CLI で AI に初版(文字起こし・自動カット案・章立て)を作らせる
#   エディタで開く場合、文字起こしと無音検出は必要時に自動で走る
node src/cli.ts run ~/Movies/framewright/2026-07-02-my-recording
```

キャンバス(出力サイズ)と `--base-layout`(ベース映像の置き方)は
**プロジェクト作成時に固定**され、後から変更できません(テロップ・ぼかし・
注釈・ズームの座標がすべて出力px絶対のため)。一覧は
[docs/usage.md の「出力キャンバス」](docs/usage.md)。

### 縦動画・別サイズを作る

本編から縦のショートも出したい、という場合は**派生プロジェクト**を作ります。
元メディア(と `transcript.json`)を共有したまま、別キャンバス・別のカット・
別の承認を持つ独立したプロジェクトになります。

```sh
node src/cli.ts derive <元プロジェクト> --name 2026-08-03-short \
  --canvas portrait --range 120-165 --range 300-330
```

エディタからは、タイムラインで keep 区間を選んでヘッダーの
**「この範囲で派生」**を押すと同じことができます。`--range` は元収録の秒です。
overlays / BGM / 章 / タイトル / 承認は、キャンバスも構成も違うので引き継ぎません
(派生先で作り直します)。

### コマンドの全体像

コマンドは50本以上ありますが、日常的に叩くのは下の「基本の流れ」だけです。
残りは目的別のグループに分かれていて、**`node src/cli.ts commands` で分類つきの
全一覧**が、**`node src/cli.ts <コマンド> --help` で個別の詳細**が読めます
(`node src/cli.ts --help` は基本の流れだけの短い案内です)。

| グループ | 代表的なコマンド | 何のためか |
|---|---|---|
| 基本の流れ | `doctor` / `editor` / `run` / `preview` / `approve` / `render` | 環境確認 → 編集 → 承認 → 書き出し |
| 取り込み〜カット案 | `ingest` / `transcribe` / `detect` / `plan` / `remeta` | `run` の各段を個別にやり直す |
| 別サイズを出す | `derive` | 元メディアを共有する派生プロジェクトを作る(縦ショート等) |
| 編集を当てる | `validate` / `describe` / `apply` / `id-stamp` / `assert` | JSON 編集の検査・要約・アトミック適用 |
| 中身を知る(知覚) | `frames` / `materials` / `av` / `search` | 人間や AI が動画の中身を確認する |
| AI に下書きさせる | `plan-materials` / `plan-effects` / `plan-bgm` | 素材・演出・BGM の下書き(カットと承認には触れない) |
| 検品する | `material-fit` / `effect-check` / `bgm-fit` / `style-check` | 編集の不整合を検出し修正案を出す(書き込まない) |
| HyperFrames | `hyperframe` ほか | 無音の作図素材(章タイトル・図解)を作る |
| エージェント連携 | `mcp` | MCP 対応エージェントにこのフォルダを開かせる |

使い分けの詳細は [docs/guides/command-reference.md](docs/guides/command-reference.md)、
目的別の索引は [docs/usage.md](docs/usage.md) にあります。

編集は GUI エディタ(`editor`)でも、収録フォルダ内の JSON 直接編集でも行えます。
GUI はブラウザ上でカット境界のドラッグ・テロップの配置・素材の挿入・承認・
プレビュー生成・レンダーまで完結でき、外部(手編集や AI)による JSON の変更は
ホットリロードで反映されます。AI コマンドは「提案だけ」で終わらず、差分確認
→ 適用 → 保存 → 必要ならフレーム確認までを 1 回の workflow として扱います。
エディタの画面と操作(カットのドラッグ・文字からのカット・テロップ・素材・承認)は
[docs/guides/editor.md](docs/guides/editor.md) にまとまっています(エディタ内でも
ヘッダーの「?」から同じ内容を開けます)。運用まわりは
[docs/guides/tools-and-ops.md](docs/guides/tools-and-ops.md)、索引は
[docs/usage.md](docs/usage.md)。

**AI エージェントに編集させる(MCP)**: Claude Desktop / Claude Code / Cursor など
MCP 対応ホストから、この収録フォルダを直接編集させられます。`node src/cli.ts mcp <dir>`
を1エントリ登録するだけで、read + 承認スコープ外の安全編集の tool
(`describe` / `validate` / `frames` / `apply` / `id-stamp` 等)が露出します
(承認・`render`・`plan` は露出しません=**設計上、承認できません**)。
ホスト別の copy-paste 設定と、承認を人間だけの行為に固定する
`.claude/settings.json` の deny テンプレ(`docs/examples/claude-settings-deny.json`)は
[docs/guides/ai-agents.md の「MCP サーバ」](docs/guides/ai-agents.md) を参照してください。

新規取り込みの既定レイアウトは通常動画(`plain`)=1画面・カメラワイプ無し・
収録の実寸のままです。画面とカメラを1本に同時収録した横長素材を左右に分けて
使う場合だけ、[拡張キャンバス](#発展-画面カメラを1本に収録する拡張キャンバス)の
`--layout obs-canvas` を付けます。

render は2段構成です。まず ffmpeg が keep 区間をフル解像度のまま結合して
`cut.mp4` を作り(音声はマイクと**システム音声(収録の2トラック目)の自動ミックス**を
ツーパスの loudnorm で **-14 LUFS に自動正規化**。音声トラックが1本の収録では
そのままマイク扱いになります)、
次に合成エンジン(`src/engine/` の WebCodecs + WebGPU)がその上に
「画面クロップ+字幕+章カード」(拡張キャンバスなら右下ワイプも)を
キャンバス寸法で合成して `final.mp4` を出力します。収録フォルダに `bgm.mp3` を置けば
**BGM も自動で合成**されます(ループ+終端フェードアウト+**発話中の自動
ダッキング**)。
字幕サイズ・目標音量・BGM音量(拡張キャンバスならワイプの大きさも)は
config.yaml の `render` セクションで変更できます。

plan は LLM に「残す候補区間」の番号リストを渡し、番号単位で
カット判断させます(理由付き)。結果の `cutplan.json` を確認・編集し、
`approve` で承認すると render に進めます。収録フォルダに
`brief.md`(企画ブリーフのコピー)を置いておくと、その「見せ場リスト」が
誤カット防止の材料として LLM に渡ります。プロンプトは
[prompts/plan.md](prompts/plan.md) で自由に調整できます。

**人間がテロップやカットを調整しながら使う手順は [docs/usage.md](docs/usage.md)
(概要+目的別索引)を参照してください。目的別ガイドは [docs/guides/](docs/guides/):
どのJSONを直すと何が変わるかは usage.md、plan 再実行の注意点は
[cut-planning.md](docs/guides/cut-planning.md)、テロップとレイアウトの調整は
[captions-layout.md](docs/guides/captions-layout.md)。**

標準 `config.yaml` は `plan.perception.audio/ocr` を明示オンにしており、
`plan` / `remeta` / `run` は実行時に今回の知覚状態を表示します。古い config で
`plan.perception` が無い場合は、互換のため知覚はオフのまま動作し、その旨を警告します。

## 発展: 画面+カメラを1本に収録する(拡張キャンバス)

画面とカメラを同時に録って**右下ワイプ**として合成したい場合は、収録側の
**キャンバスを 3840x1080** にして左半分に画面・右半分にカメラを並べた1本の
動画として録ります(「拡張キャンバス方式」)。これは plain より手間のかかる
**発展的な**使い方で、必須ではありません。OBS を使う場合の初期設定(約30分)と
撮影チェックリストは [docs/recording-guide.md](docs/recording-guide.md) にあります。

拡張キャンバスの収録は、取り込み時に `--layout obs-canvas` を付けます:

```sh
node src/cli.ts editor <dir> --layout obs-canvas
node src/cli.ts ingest <dir> --layout obs-canvas
node src/cli.ts run    <dir> --layout obs-canvas
```

`--layout auto` でも 3840x1080 のような超横長素材は obs-canvas と判定されます
(既定は plain)。plain との違い(ワイプの有無・出力解像度・使える演出)は
[docs/getting-started.md](docs/getting-started.md#通常動画スマホカメラ画面録画の場合) を参照。

## 設定

すべて [config.yaml](config.yaml) で変更できます(収録レイアウト、無音判定の
閾値、whisper モデル、AI provider 等)。コード側にハードコードされた
設定はありません。

AI provider(`ai:` 省略時の既定は **API**。`ANTHROPIC_API_KEY` があれば
`anthropic` / `claude-sonnet-5`、無くて `OPENAI_API_KEY` があれば `openai` /
`gpt-5.4-mini`、どちらも無ければ AI 呼び出し時にエラー):

- `claude-code`: `claude` CLI をサブプロセス実行。API キー不要(明示設定が必要)
- `codex`: `codex exec` を read-only で実行。Codex CLI 認証が必要(実験的・明示設定が必要)
- `anthropic`: Anthropic API。`.env` または環境変数に `ANTHROPIC_API_KEY`、
  `ai.model` にモデル名を指定
- `openai`: OpenAI API。`.env` または環境変数に `OPENAI_API_KEY`、
  `ai.model` にモデル名を指定

旧設定 `llm.backend: claude-cli | api` は互換のため読み続けます。新規設定では
`ai.provider` を使ってください。

## スコープ(できること / 意図的に持たないこと)

FrameWright は「画面デモ+解説の収録 → YouTube」という**単一ワークフローに特化**した
オピニオネイテッドな道具です。汎用 NLE(Premiere / Final Cut)の代替ではなく、
その前段の「一次編集を自動化して人が仕上げる」層を担います。

**できること**: 無音検出+LLM 意味カット / 多トラック・テロップ(位置・色・
フォント・座布団)/ 素材オーバーレイ(全画面・PiP)/ インサート編集 / ワイプ
全画面+遷移 / ズーム / ディップ・トゥ・ブラック / 簡易カラー調整(明るさ・
コントラスト・彩度の全編一律3値)/ BGM(区間配置・発話ダッキング・フェード)/
章立て / サムネイル / 出力キャンバス(16:9・9:16・1:1・4:5・21:9・4:3 と
ベース映像の置き方の組み合わせ)/ 派生プロジェクト(元メディアを共有する
別サイズの出力)/ マイク+システム音声ミックス+-14 LUFS 自動正規化 / ノイズ除去。

**意図的に持たない機能**(欠落ではなく設計上の割り切り):

- 任意区間の速度変更 / タイムリマップ
- トランジション集(クロスディゾルブ等。現状は dip-to-black とワイプ遷移のみ)
- カラーグレーディング(カーブ / ホイール / LUT。現状は全編一律の3値のみ)
- マスク / クロマキー / 高度な合成(現状は矩形配置まで)
- クリップ単位の音量エンベロープ・オーディオエフェクト(EQ / コンプ / ゲート)
- モーション・キーフレーム / タイトルアニメ / MOGRT
- マルチカム(2分割キャンバスを超える)/ ネストシーケンス / 調整レイヤー
- 書き出しプリセット・フォーマット選択(mp4 固定パイプライン)

これらの不在は、対象ジャンル(画面デモ+解説)で使わないか、「JSON 駆動+
ローカル AI 編集」という設計の不変条件と引き合わないためです。

## License

MIT
