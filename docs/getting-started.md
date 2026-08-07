# FrameWright をはじめて使う人へ

1本の動画を、エディタで開く → 必要なら文字起こし/AIカット提案 →
**人間の承認** → 最終レンダーまで通す一連の流れを、**このページだけ読めば一通り動かせる**
ようにまとめたガイドです。

- コマンドで動かす人 → [1. セットアップ](#1-セットアップ最初の1回だけ) →
  [2. クイックスタート](#2-クイックスタート最短の流れ) →
  [4. コマンド一覧](#4-ユーザーが起動するコマンド一覧)
- GUI で編集したい人 → [6. GUI エディタ](#6-gui-エディタの起動と使い方)
- AI(Claude Code)に編集させる人 → [7. AI に編集させるときの仕様](#7-ai-claude-code-に編集させるときの仕様)

---

## 0. これは何をするツールか

**1プロジェクト = 1フォルダ = 1出力**(例:
`~/Movies/framewright/2026-07-02-my-recording/`)。標準的な NLE と同じで、
**まずプロジェクトを開き**、そこにベースになる動画/音声を選ぶところから始めます。

```
① editor         プロジェクトを開く(空フォルダでもよい)
     └─ 画面内でベース動画/音声とキャンバス(16:9 / 9:16 / 1:1 …)を選ぶ
     └─ ingest(映像解析・マイク音声抽出)→ manifest.json
        + 空の transcript.json + 全編 keep の cutplan.json
  │
② 自動解析      エディタで開くと必要時だけ transcribe → detect
     ├─ transcribe  whisper.cpp で文字起こし     → transcript.json / .srt
     ├─ detect      無音検出(決定的・LLM不使用) → cuts.auto.json
  │
③ run(任意)     CLI で初版まで作りたいときだけ plan まで実行
     └─ plan        LLMで意味カット・章立て       → cutplan.json / chapters.json / meta.json
  │
④ 編集           GUI エディタ、または収録フォルダの JSON を直接編集
  │
⑤ 確認 → 承認    preview / GUI で確認 → approve(承認レコード approvals.json)
  │
⑤ render         合成エンジンで書き出し          → cut.mp4(中間)→ final.mp4
```

大事な考え方が4つあります。

1. **入口はエディタ。** 開いた直後は全編 keep(何もカットしていない状態)で、
   自動処理はユーザーが明示したときだけ実行します。`run` は「AI に初版を
   作らせる」1ボタン(= ②)で、パイプラインの入口ではありません。
2. **編集するのはコードではなく、収録フォルダ内の JSON。** 動画ファイル自体は
   触りません。
3. **時刻はすべて「元収録(raw)の秒」で書く。** カット後の秒への換算はツールが
   自動でやるので、頭の中で引き算しないこと。
4. **キャンバス(出力サイズ)は作成時に固定。** 同じ収録から別サイズも出したい
   ときは、`derive` で**派生プロジェクト**を作ります(→
   [縦動画・別サイズ](#縦動画別サイズを作るderive))。

---

## 1. セットアップ(最初の1回だけ)

必要なもの: macOS / Node.js 23.6+ / Homebrew

```sh
brew install ffmpeg whisper-cpp
mkdir -p ~/Models/whisper
curl -L -o ~/Models/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
npm install
```

#### whisper モデルは2段で選ぶ(まず小さく試す → 本番で精度を上げる)

上の `curl` は**本番用の `large-v3-turbo`(≈1.5GB)**。ダウンロードが重い・とりあえず
文字起こしを試したいだけなら、**先に小さいモデルで即試す**のがおすすめです。

```sh
# ① 即試す: base（≈150MB、数十秒でDL。粗いが日本語も出る）
curl -L --progress-bar -o ~/Models/whisper/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
# 中間: small（≈500MB。base より明確に良い）
#   ...ggml-small.bin

# ② config.yaml の whisper.model を切り替える（この1行だけ）
#     whisper:
#       model: ~/Models/whisper/ggml-base.bin
```

- DL の**進捗**は `curl --progress-bar` で出ます。途中で切れたら同じコマンドを
  再実行(`-o` 先を上書き)。**検証**は `ls -lh ~/Models/whisper/`(サイズが 0 や
  極端に小さければ失敗)。
- **本番**は既定の `large-v3-turbo-q5_0`(精度が要るとき)。モデルを戻すときも
  `config.yaml` の `whisper.model` を戻すだけで、収録データは作り直し不要
  (テロップを更新したいなら `node src/cli.ts transcribe <dir>` を再実行)。
- どのモデルでも `language: ja`(config 既定)のまま。`.en` 付きは英語専用なので
  日本語には使わない。

- 文字起こし・無音検出は**完全ローカル(無料)**。
- LLM を使うのは `plan`(意味カット・章立て)だけ。**デフォルトは `claude` CLI**
  (Claude Code のサブスクで動く / API キー不要)。Codex CLI や従量課金 API を
  使う場合は `config.yaml` の `ai.provider` を切り替えます。API provider では
  `.env` または環境変数に API key を置き、`ai.model` を設定します。
  - **既定の `ai.provider: claude-code` は `claude` CLI(Claude Code)本体のインストールと
    認証が前提**です。未導入だと `plan` 段で `コマンド 'claude' が見つかりません`
    で止まります。`claude --version` が通り、`claude` にログイン済みであることを
    確認してください(不要にするには `ai.provider: codex` / `anthropic` / `openai` に切り替え)。
- 設定はすべて [`config.yaml`](../config.yaml)(収録レイアウト・無音判定の閾値・
  whisper モデル・AI provider・ワイプ/字幕サイズ・音量など)。コードに
  ハードコードされた設定はありません。
- OBS 側の収録設定は [recording-guide.md](recording-guide.md) を参照
  (**キャンバス 3840×1080・左に画面/右にカメラを並べる「拡張キャンバス方式」**が前提)。

### データはどこへ行くか(プライバシー)

FrameWright は**ローカルファースト**です。映像・画面・カメラ・音声と、whisper に
よる**文字起こし処理そのもの**は PC 内で完結し、外部には出ません。

外部に出るのは**テキストだけ**で、LLM を使う3コマンドに限られます。

- `plan` / `remeta` は、**文字起こしテキスト(`transcript.json` の
  発話内容)**と、あれば **`brief.md`(企画ブリーフ)**を LLM に送ります。
- 送り先は `config.yaml` の `ai.provider` 次第です。既定 `claude-code` は
  `claude` CLI 経由、`codex` は Codex CLI 経由、`anthropic` / `openai` は各 API へ
  送られます。**映像・音声ファイルや画面の中身は送りません。**

したがって、**機密を口に出す収録では発話内容が外部 LLM に渡る**点に注意して
ください(画面に機密を映さない注意は
[recording-guide.md](recording-guide.md) のチェックリスト参照)。LLM を一切
使いたくない場合は `plan` / `remeta` を実行しなければ、
パイプラインは完全ローカルで完結します(カットは手編集で作れます)。

---

### Docker で試す(Linux 再現環境)

mac が無い / Linux で動作を確認したい場合は、同梱の `Dockerfile` で再現環境を作れます。

```sh
docker build -t framewright .
docker run --rm framewright doctor --no-ai        # 必須チェックが緑(exit 0)
docker run --rm -v ~/Movies/framewright:/recordings framewright doctor /recordings/2026-07-02-xxx
```

イメージには ffmpeg(libx264 込み)・日本語フォント・合成エンジンの依存が
入っており、`ingest`〜`preview`、`render` まで動きます。whisper とモデルは焼き込んでいないので、文字起こしを
使うときはホストのモデルを `-v ~/Models/whisper:/models` でマウントし、
`config.yaml` の `whisper.model` をそのパスへ向けてください(未マウントでも
`doctor` は whisper 系を warn として通します)。

---

## 2. クイックスタート(最短の流れ)

### 2.2 サンプルで試す(OBS/whisper 不要)

実データもモデルDLも無しで、`editor`→`render` を体験できます。リポジトリ直下で:

```sh
npm run sample        # ffmpeg で数秒のサンプルを合成し examples/sample/ を用意
```

表示された3コマンド(`editor` / `approve` / `render`)を順に叩くと
`examples/sample/final.mp4` が出ます(初回 render は headless Chrome 取得で数分)。
片付けは `rm -rf examples/sample`。このサンプルは whisper を使わないので、
モデルのダウンロードは不要です(字幕とカットはスクリプトが最小限を用意します)。

```sh
# ⓪ プロジェクト一覧(ランチャー)から始める場合
#    config.yaml の recordingsDir(既定 ~/Movies/framewright)が開く
#    recordingsDirs を使うと複数の保存先を横断できる
node src/cli.ts editor
#    → 「+ 新規プロジェクト」で名前とキャンバスを選ぶ → 空プロジェクトが開く
#    → 画面内でベースにする動画/音声を選ぶ(ドラッグ&ドロップでも可)

# ① フォルダを直接指定してもよい(まだ無いフォルダ名でも作って開く)
#    フォルダに動画/音声が1本だけなら、それが自動でベースになる
node src/cli.ts editor ~/Movies/framewright/2026-07-02-my-recording

# OBS 拡張キャンバス(左=画面、右=カメラ)ならこちら
node src/cli.ts editor ~/Movies/framewright/2026-07-02-my-recording --layout obs-canvas

# 縦(9:16)のプロジェクトとして作るならこちら(作成時固定)
node src/cli.ts editor ~/Movies/framewright/2026-08-03-short --canvas portrait

# ② 必要なら文字起こしや自動カット案を明示実行
#    エディタで開く場合、文字起こしと無音検出は必要時に自動で走る
node src/cli.ts transcribe ~/Movies/framewright/2026-07-02-my-recording
node src/cli.ts plan       ~/Movies/framewright/2026-07-02-my-recording

# ③ preview / GUI で確認して承認(GUI なら「書き出し」→「承認済み」チェック)
node src/cli.ts approve ~/Movies/framewright/2026-07-02-my-recording

# ④ 最終レンダー
node src/cli.ts render ~/Movies/framewright/2026-07-02-my-recording
```

> `node src/cli.ts <cmd>` は `npm run framewright -- <cmd>` でも同じです。
> エディタは `npm run editor -- <dir>` でも起動できます。

### 縦動画・別サイズを作る(derive)

キャンバスはプロジェクト作成時に固定されるので、同じ収録から 16:9 の本編と
9:16 のショートを両方出したいときは、**元メディアを共有する派生プロジェクト**を
作ります。

```sh
node src/cli.ts derive <元プロジェクト> --name 2026-08-03-short \
  --canvas portrait --range 120-165 --range 300-330
```

- `--range` は**元収録の秒**。複数指定でき、その範囲だけが keep になります
- 派生先は元プロジェクトの**兄弟フォルダ**。元メディアは symlink
  (非対応ならハードリンク → コピー)で共有し、`transcript.json` はそのまま
  引き継ぎます(同じメディアなので秒が一致する)
- `overlays.json` / `bgm.json` / `chapters.json` / `meta.json` / `approvals.json` は
  **引き継ぎません**(座標が出力px絶対でキャンバスが変わると無意味・構成が本編前提)。
  派生先で改めて編集して承認します
- エディタからは、タイムラインで keep 区間を選んでヘッダーの
  **「この範囲で派生」**を押すと同じことができます

### 通常動画(スマホ・カメラ・画面録画)の場合

OBS の拡張キャンバス方式でない**普通の動画**(1画面。スマホ縦動画・カメラ・
画面録画など)も一級で扱えます。これを FrameWright では **plain レイアウト**と呼び、
「カメラ(ワイプ)の無い収録」として表現します。

- **動画または音声だけを入れたフォルダを `editor` で開く**と、plain として自動
  bootstrap されます(manifest / 空の transcript・cutplan を生成)。これが通常動画の
  一番簡単な入口です。候補が複数ある場合はファイル名から推測せず、画面で選ばせます。
- コマンドから明示するには `editor` / `ingest` / `run` に
  **`--layout plain`** を付けます(`--layout obs-canvas` / `auto` も可)。
  既定は plain です。`auto` はキャンバス寸法が `screenRegion + cameraRegion` と
  完全一致、または十分な超横長のときだけ obs-canvas、それ以外は plain と判定します。
- plain の既定の出力解像度は**収録の実寸**(縦動画は縦のまま・4K は 4K のまま)。
  `--canvas portrait` などを付ければ別サイズにもできます。
  カメラが無いので**ワイプ関連は使えません**(本編でワイプ非描画・字幕は全幅中央。
  エディタにワイプトラックは出ず、`overlays.json` の `wipeFull` は `validate` が
  エラーにする)。同じ理由で `--base-layout camera` / `stack`(カメラ領域を使う配置)も
  plain では指定できません。ズーム・カラー調整・サムネイルは plain でも使えます。

---

### OBS 拡張キャンバス(画面+カメラ)の場合

OBS の 3840×1080 拡張キャンバス(左=画面、右=カメラ)でワイプを使う収録は、
初回取り込み時に `--layout obs-canvas` を付けます。

```sh
node src/cli.ts editor <dir> --layout obs-canvas
node src/cli.ts ingest <dir> --layout obs-canvas
node src/cli.ts run    <dir> --layout obs-canvas
```

`--layout auto` でも 3840×1080 のような超横長素材は obs-canvas と判定されます。
ただし判定に迷う素材では、意図したレイアウトを明示してください。

### `--layout` と `--canvas` は別の軸

紛らわしいので整理すると:

| フラグ | 決めるもの | 例 |
|---|---|---|
| `--layout` | **入力**の収録形式(素材の中に何がどう入っているか) | `plain` / `obs-canvas` / `auto` |
| `--canvas` | **出力**のサイズ | `landscape`(既定・収録のまま)/ `portrait` / `square` … |
| `--base-layout` | 出力キャンバス上への**ベース映像の置き方** | `auto`(既定)/ `screen` / `camera` / `stack` |

3つとも**初回の作成時にだけ**有効で(`ingest` / `editor` の初回、または
`manifest.json` がまだ無いフォルダでの `run`)、以後は変更できません。
プリセットの一覧は [usage.md の「出力キャンバス」](usage.md)。

## 3. どのファイルが何を決めるか

編集対象は収録フォルダ内のこの5つ。**時刻は全部「元収録の秒」。**

| ファイル | 決めるもの |
|---|---|
| `cutplan.json` | **どこを残すか**。`segments[]` の `action: "keep"/"cut"`(keep は時系列順・重なり禁止)。`approved` は承認の**意図表示**で、render のゲートは別ファイルの `approvals.json`(下記) |
| `transcript.json` | **テロップ**の文言・表示時間。`track`(トラック番号)/ `pos`(`{x,y}` 出力px)/ `style`(`fontSizePx`・`color`・`outlineColor`(`"none"`で縁なし)・`fontFamily`・`fontWeight`・`background`(座布団))は省略可で個別上書き |
| `overlays.json` | **演出**。`overlays`(素材の全画面表示)/ `inserts`(インサート編集)/ `wipeFull`(ワイプ全画面)/ `hideCaption` / `layerOrder`(重なり順)/ `captionTracks`(トラックの標準位置・スタイル) |
| `chapters.json` | YouTube 概要欄チャプター(`start`/`title`)。**動画には描画されない** |
| `meta.json` | タイトル案・概要欄の下書き。**動画に影響なし** |

**触ってはいけない中間生成物**(再実行で上書きされる):
`manifest.json`(キャンバス・レイアウト・音声トラックなど `ingest` の決定を持つ) /
`cuts.auto.json` / `plan.raw.txt` / `render.props.json` /
`whisper-out.*` / `cut.mp4` / `preview.mp4` / `proxy.mp4` / `frames/*.png`。
`backups/`(上書き前の退避)と `.editor-draft.json`(GUI の未保存編集の自動退避)も触らない。

**触らない第3カテゴリ**: `approvals.json`(**承認レコード**。keep 集合の sha256 に
束縛され、`render` の唯一のゲート。カットを編集すると自動失効する)。書けるのは
`approve` / `unapprove` コマンドと GUI の保存だけで、人間も AI も直接編集しない。

素材(B-roll 等)は `materials/` に置いて相対パスで参照。BGM は収録フォルダ直下の
`bgm.mp3`(置くだけで自動ループ・終端フェード・発話中ダッキング付きで合成)。

---

## 4. ユーザーが起動するコマンド一覧

すべて `node src/cli.ts <コマンド> <収録フォルダ>` の形。

| コマンド | 何をするか | 使う場面 |
|---|---|---|
| `editor` (引数なし) | `recordingsDir` / `recordingsDirs` のプロジェクト一覧(ランチャー)を開く | どのプロジェクトを開くか選ぶ / 新規プロジェクトを作る |
| `run <dir>` | CLI で **AI 初版まで作る**(transcribe→detect→plan)。`manifest.json` が無いフォルダでは `ingest` から始める | 文字起こし+自動カット案を一気に作りたいとき。手編集済みのファイルを上書きする場合だけ `--force` が必要(実行前に `backups/` へ退避) |
| `derive <dir> --name … --canvas … --range …` | 元メディアと transcript を共有する**派生プロジェクト**を作る | 同じ収録から縦ショートなど別サイズも出したいとき |
| `ingest <dir>` | 映像解析・マイク音声抽出 → manifest.json | config を変えて部分的にやり直すとき |
| `transcribe <dir>` | whisper で文字起こし → transcript.json / .srt | 再実行はテロップ手編集を上書き(既存は backups/ へ退避) |
| `detect <dir>` | 無音検出 → cuts.auto.json(決定的・LLM不使用) | `detect.silenceDb` 調整後など |
| `plan <dir>` | LLM で意味カット・章立て・タイトル案 | プロンプト改良後など。**上書き注意**(2回目以降は `--force` 必須) |
| `remeta <dir>` | 章立て・タイトル案・概要欄だけ作り直す(**cutplan は触らない**) | カットを手編集済みで、概要欄/章だけ再生成したいとき |
| `preview <dir>` | keep 区間を繋いだ確認用の軽い動画 → preview.mp4 | カットのテンポ確認。`approved` false でも動く |
| `editor <dir>` | GUI エディタをブラウザで起動(無ければフォルダを作って開く) | カット・テロップ・演出を視覚的に編集(→ [6章](#6-gui-エディタの起動と使い方)) |
| `validate <dir>` | 編集した JSON の整合性検査(エラーで exit 1) | **JSON を編集したら毎回** |
| `describe <dir>` | タイムラインのテキスト要約(元秒⇔出力秒対応) | 全 JSON を読む前の把握 |
| `frames <dir> --t 90,2:30` | 指定時刻を**最終合成の見た目**で PNG 出力 | テロップ位置・ワイプ被りの目視確認(主に AI 用) |
| `approve <dir>` | 承認レコード(`approvals.json`)を書く | preview で確認したあと。**人間の操作**(非対話環境では `--yes` が無いと拒否) |
| `render <dir>` | 最終レンダー → cut.mp4 → final.mp4 | **承認レコードが必須**(承認ゲート) |

再実行ガード: **人間が編集した**生成物がある状態で `plan` / `run` を再実行するには
`--force` が必要で、その際も手編集ファイル一式が `backups/<日時>/` へ自動退避されます
(**自分の判断で `--force` を付けない**)。エディタで開いた直後の「空の transcript /
全編 keep の cutplan」は bootstrap が作った初期値と分かるので、`--force` なしで
`run` を通せます。エディタで開く場合は、文字起こしと無音検出だけが必要時に自動で走ります。

---

## 5. 人間が編集する場合の仕様

正しい使い方は「**まず `editor` でプロジェクトを開く → 必要な自動処理だけ明示実行 → 編集 ↔ 確認を往復 → 承認 → render**」。

```
① 収録 → ~/Movies/framewright/<日付-内容>/ に動画を置く(空フォルダから始めてもよい)
② node src/cli.ts editor            一覧から開く / 「+ 新規プロジェクト」で作る
   または node src/cli.ts editor <dir>        フォルダを直接開く
   OBS 拡張キャンバスなら: --layout obs-canvas / 縦なら: --canvas portrait
   ベースメディアが未確定なら、開いた画面で動画/音声を選ぶ
③ 必要なら transcribe / plan を明示実行(GUI では文字起こしと無音検出だけ自動実行)
④ 編集タイム(3章の表のファイルを直す) ── GUI か JSON 直接編集
⑤ preview か GUI で確認 → 気に入らなければ ④⑤ を往復
⑥ node src/cli.ts approve <dir>     承認(GUI なら「書き出し」→「承認済み」チェック)
⑦ node src/cli.ts render <dir>      final.mp4 完成
   → テロップだけ直したくなったら transcript.json を編集して ⑦ だけ再実行(速い。
      承認はカット内容にだけ束縛されるので、テロップ編集では失効しない)
⑧ meta.json / chapters.json を YouTube 投稿に使う
⑨ 縦ショートも要るなら derive で派生プロジェクトを作り、②〜⑦ をそちらでもう一巡
```

編集手段は2つ。どちらを使ってもよく、混在もできます(GUI 起動中に JSON を
直接編集すると、保存された変更はホットリロードで GUI に反映されます)。

- **GUI エディタ**(→ [6章](#6-gui-エディタの起動と使い方)):カット境界のドラッグ、
  テロップの配置・スタイル、素材の挿入、承認、プレビュー生成・レンダーまで完結。
- **JSON 直接編集**:3章の表のファイルをエディタで直接書き換える。
  編集後は **`validate` を必ず実行**。

### 人間が特に気をつけること

- **承認は人間の仕事。** preview か GUI で確認して初めて `approve` する。
  承認の実体は `approvals.json`(keep 集合のハッシュに束縛された承認レコード)で、
  `cutplan.json` の `approved: true` を書くだけでは render は通らない。
- **⚠️ 手編集を始めたあとに `plan` / `run` を再実行するとカットとタイトル/章立てが
  上書きされる。** 概要欄・章だけ作り直したいなら `remeta` を使う
  (cutplan は触らない)。
- **キャンバスは後から変えられない。** 別サイズが要るときは `derive` で
  派生プロジェクトを作る。
- **収録ゲインが低すぎると発話が無音カットされる**ことがある。OBS のメーターで
  普通に喋って黄色ゾーン(-20〜-10dB)を目安に。最終音量は自動で -14 LUFS に
  正規化されるので、収録音量の多少のばらつきは気にしなくてよい。

---

## 6. GUI エディタの起動と使い方

### 起動

```sh
# プロジェクト一覧(ランチャー)。config.yaml の recordingsDir / recordingsDirs を開く
node src/cli.ts editor

# 1つのプロジェクトを直接開く(まだ無いフォルダ名でも作って開く)
node src/cli.ts editor ~/Movies/framewright/2026-07-02-my-recording
# または:  npm run editor -- ~/Movies/framewright/2026-07-02-my-recording

# OBS 拡張キャンバスでワイプを使う場合
node src/cli.ts editor ~/Movies/framewright/2026-07-02-my-recording --layout obs-canvas

# 縦(9:16)のプロジェクトとして作る場合(作成時固定)
node src/cli.ts editor ~/Movies/framewright/2026-08-03-short --canvas portrait
```

- 起動すると `http://127.0.0.1:4310` を案内するので、ブラウザで開く
  (ポートは環境変数 `PORT` で変更可)。**終了は Ctrl+C**。
- 引数なしで起動したときはプロジェクトのカード一覧が出る(尺 / キャンバス比 /
  「書き出し済み」バッジ / 更新日時。更新日時の新しい順)。カードを押すと
  `/p/<フォルダ名>/` へ移ってそのプロジェクトが開く。`--detach` / `--status` /
  `--stop` はプロジェクト単位の機能なので、引数なしでは使えない。
- **空のプロジェクト**(ベースメディア未確定)を開くと、編集画面ではなく
  「この動画の元になるファイルを選んでください」の画面が出る。フォルダ内の候補を
  押すか、ファイルをドラッグ&ドロップして確定する。ここでキャンバスも選べる。
- 初回に**軽量プロキシ `proxy.mp4`**(元収録を縮小したもの)を1回だけ生成します
  (数十秒)。プレビューはこのプロキシを **keep 区間に従って飛び飛び再生**するので、
  **カット境界を編集してもファイル再生成なしで即反映**されます(本物の NLE と同じ方式)。

### 画面と操作

起動するとタブパネル(素材 / スクリプト / テロップ / プロパティ)+ プレビュー +
タイムラインの3面が出る。カットのドラッグ、文字からのカット、テロップの配置、
素材の差し込み、⌘S 保存、ヘッダーの「承認済み / プレビュー生成 / レンダー」——
**操作の一覧は [guides/editor.md](guides/editor.md) にまとめた**(画面内でも
ヘッダーの「?」から同じ内容を開ける)。

- **正のデータは常に収録フォルダの JSON 側**。エディタはそれを読み書きするビュー
- 未保存のまま閉じるとブラウザが確認を出し、クラッシュ時の保険として
  `.editor-draft.json` に自動退避される(次回起動時に復元するか選べる)
- **エディタ起動中に手編集や AI が JSON を変えても構わない**(ホットリロードで反映)

---

## 7. AI(Claude Code)に編集させるときの仕様

このリポジトリで Claude Code に「動画を編集して」と頼むと、AI は**コードではなく
収録フォルダの JSON を編集**します。AI が守る決まり:

- **編集 = `cutplan.json` / `transcript.json` / `overlays.json` / `chapters.json` /
  `meta.json` の編集。** 動画ファイルは触らない。時刻は元収録の秒。
- **編集したら必ず `node src/cli.ts validate <dir>` を実行**し、エラーを直してから進む
  (preview/render で数分かけて気づく壊れ方を数ミリ秒で検出できる)。
- **`plan` と `run` は再実行禁止**(手編集が LLM 生成物で上書きされる)。カットを
  保ったまま章立て・タイトル・概要だけ作り直すときは `remeta`。**自分の判断で
  `--force` を付けない。**
- **`approved` を自分で true にしない**(承認は人間の仕事)。承認レコード
  `approvals.json` は**直接編集・作成しない**(書けるのは `approve` / `unapprove`
  コマンドと GUI の保存だけ)。
- 中間生成物・`backups/`・`.editor-draft.json` は編集しない。

### AI が動画の中身を「見る」方法

Read で JSON を全部読む前に、まずこれらで把握します。

- `transcript.json` … 何をいつ喋っているか(内容把握と時刻特定の主ソース)
- `cutplan.json` … どこが残り/切られたか(`reason` 付き)
- `node src/cli.ts describe <dir>` … タイムライン要約(元秒⇔出力秒の対応付き)
- `node src/cli.ts frames <dir> --t 90,2:30.5` … 指定時刻を**最終合成と同じ見た目**で
  `frames/*.png` に出し、Read で画像を見てテロップ位置・ワイプ被りを自己確認
  (`--captions` で全テロップ1件1枚、`--every 10` でカット後を10秒間隔サンプル)
  - `frames/` の古い PNG は実行のたびに全削除される。**JSON を編集したら撮り直す**
    (古い PNG を見ると編集前の絵を見ることになる)
  - ベースはプロキシのアップスケールなので、位置・被りの確認には十分だが、
    **画面内の細かい文字の可読性はこの画像では判断できない**(最終判断は人間が
    preview/render で行う)

### AI の基本ループ

```
JSON 編集 → validate → describe か frames で自己確認 → 人間には preview / GUI で見てもらう
```

---

## 8. 困ったときは

- **`コマンド 'claude' が見つかりません`(plan / run で停止)** → 既定の AI provider は
  Claude Code の `claude` CLI です。Claude Code をインストールして `claude` に
  ログインするか、Codex CLI / API provider に切り替える(`config.yaml` の
  `ai.provider` と、API の場合は `ai.model` + API key)。
  文字起こし・無音検出・レンダーは LLM 不要なので、この前段では止まりません。
- **`whisper モデルが見つかりません`** → [1章](#1-セットアップ最初の1回だけ)のモデル
  ダウンロードをやり直す(パスは `config.yaml` の `whisper.model`)。まず軽い `base`
  で試すなら [whisper モデルは2段で選ぶ](#whisper-モデルは2段で選ぶまず小さく試す--本番で精度を上げる)
  を参照(`config.yaml` の `whisper.model` を差し替えるだけ)。
- **`マイクトラックが見つかりません`** → `config.yaml` の `ingest.micTrack` /
  `systemTrack`(OBS のトラック番号、1始まり)を収録に合わせる。
- **承認レコードが無い / 失効していて render が止まる** → 承認ゲート。preview/GUI で
  確認して `approve <dir>`(GUI なら「書き出し」→「承認済み」チェック)。承認後に
  カットを編集すると自動失効するので、承認し直す。
- **エディタが「ベースメディアが未確定です」と出る** → 空のプロジェクト。
  画面の候補から動画/音声を選ぶか、ファイルをドロップして確定する。
- **手編集が消えた** → `backups/<日時>/` から収録フォルダ直下へコピーで復元。
- **render が「切りすぎ」** → 発話が無音カットされている可能性。`config.yaml` の
  `detect.silenceDb` を下げて `detect`→ cutplan を作り直すか、cutplan を手で直す。
- **見た目(ワイプ/字幕サイズ/テロップ既定の色・フォント)を変えたい** →
  GUI エディタの設定画面(ヘッダーの「設定」/ ⌘,)。実体は `config.yaml` の
  `render` セクション。ベースレイアウトのデザイン(背景・画面パネル・ワイプの形)は
  `render.design`(→ [guides/captions-layout.md](guides/captions-layout.md))。
- **出力サイズを変えたい** → キャンバスは作成時固定なので後から変えられない。
  `derive` で別キャンバスの派生プロジェクトを作る。

より詳しい運用は [usage.md](usage.md)(人間が調整しながら使うワークフローの
概要+目的別索引)を参照してください。目的別の詳細ガイドは
[guides/](guides/) 配下に分かれています(カット調整・見た目・素材・演出・音・
書き出し・AI 連携など)。
