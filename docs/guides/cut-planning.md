# カットを決める(plan / cutplan)

> 「AI にカット案を作らせて、それを人間が育てる」ための設定と概念をまとめる。
> 関連: [captions-layout.md](captions-layout.md) / [style-and-rules.md](style-and-rules.md) / [command-reference.md](command-reference.md) / [../usage.md](../usage.md)

## ⚠️ 最重要の注意: plan の再実行は手編集を消す

`plan`(と `run`)を再実行すると **cutplan.json / chapters.json / meta.json と
「章」トラックのテロップが上書きされる**(他のトラックのテロップは保たれる)。
手編集を始めたら plan は再実行しないこと。
「LLM の案は最初の1回だけ、以降は人間が育てる」が原則。

運用ルールだけには頼らない二重の防御がある:

- 生成物が既にあるときの `plan` / `run` は **`--force` を付けないとエラーで
  止まる**(初回は今までどおり何も聞かれない)
- `--force` で実行しても、上書き前に手編集ファイル一式(cutplan / chapters /
  meta / transcript / overlays)が **`backups/<日時>/` へ自動退避**される。
  消してしまったら退避先のファイルを収録フォルダ直下へコピーし直せば戻る
  (`transcribe` の単体再実行も transcript.json を同じ場所へ退避する)


## cutplan は元収録の全時間を keep/cut で連続被覆する(無音も戻せる)

`cutplan.segments` は元収録 `[0, 全長]` を **keep と cut で隙間なく覆う**。
`detect` が無音から作る「残す候補区間」は keep か(LLM がカットと判断すれば)
cut になり、**候補にすらならなかった無音区間も `action:"cut"` として記録される**
(reason は `config.yaml` の `detect.silenceCutReason`、既定「無音」)。

そのため切られた区間は**すべて**エディタのタイムライン(映像トラック)に
「カットされた区間」の印として現れ、選択して**「この区間を動画に戻す」**で
復元できる(隣の keep と重なる分だけ縮めて戻り、戻した区間は前後の keep と
連続再生される)。発話の語尾が無音判定で切れていても、その部分は無音 cut として
残っているので取り戻せる。**印が出るのは `action:"cut"` の区間だけ**なので、
無音を cut として明示記録することが「全ての映像を戻せる状態」の前提になる。

- 無音 cut を足しても **keep の start/end は変わらない**ので、承認レコード
  (`approvals.json` の keep 集合ハッシュ)は失効しない(承認スコープは cut 決定
  =keep 集合のみ)。無音 cut にも `@id`(`seg_*`)が採番され、他の segment と
  同じく apply の宛先にできる
- この挙動は `detect` → `plan`(単発 / `--cuts-only` / 観測ループ / harness)の
  全経路で自動。旧来の穴あき cutplan(本機能の導入前に生成したもの)を全被覆へ
  移すには `plan --cuts-only` で作り直す(cut 判断が変わりうる点に注意)


## plan の知覚(config.yaml の plan.perception。標準 config は audio/ocr を明示オン)

`plan` / `plan --cuts-only` / `remeta` は `config.yaml` の `plan.perception`
に従って、発話テキストに加えて detect の既存情報や画面 OCR を LLM 入力へ添えられる。
**現行の標準 `config.yaml` は `audio: true` / `ocr: true` を明示**している。
一方、古い config や最小 config で `plan.perception` 自体が無い場合は互換のため
コード fallback が全オフのままで、`plan` / `remeta` 実行時に CLI が警告する。
この未指定ケースでは LLM 入力・`plan.raw.txt` は導入前と1バイトも変わらない。

```yaml
plan:
  perception:
    audio: true        # 無音・間の注記(決定論・追加依存なし。まずこれから)
    ocr: true          # 画面OCRテキスト(macOS/Apple Vision 必要・区間数ぶん重い)
    ocrMaxSegments: 40
    ocrMaxLines: 6
    systemSpeech: false # システム音声の発話(要 whisper.systemAudio。下記参照)
    cursor: false       # カーソル操作(クリック/停留/待機カーソル比率。要 record --watch)
```

- `audio`: 各区間の `尺` / `直前カット`(直前に落ちた素材秒)/ `内無音`(区間内に
  残った無音の合計秒)を秒で記述文にして添える。すべて `cuts.auto.json`(detect
  の結果)と番号区間だけから計算する純関数で、**新規の音量計測はしない**。
  決定論・追加依存なしなので、まず有効にするならこちら
- `ocr`: 各区間の代表フレーム(元収録の中点)を `frames --ocr` と同じ
  Apple Vision OCR にかけ、画面内の文字(コード・ターミナル・エラー文)を
  記述文にして添える。macOS + Apple Vision が必要で、無い環境では警告のうえ
  OCR 部分を省いて続行する(plan 自体は止まらない)。区間数ぶんの ffmpeg
  クロップ+Vision が走るため `ocrMaxSegments`(既定40。超過時は尺の長い区間を
  優先)・`ocrMaxLines`(区間ごとにプロンプトへ載せる行数の上限。既定6)で
  コストを抑える
- `plan` / `remeta` / `run` は実行前に今回の知覚状態を必ず表示する。
  例: `plan 知覚: audio=on / ocr=on(max 40 segments, 6 lines) / systemSpeech=off / cursor=off`
- `plan.perception` 未指定時は
  `警告: plan.perception が config.yaml にありません。...` を先に出し、
  `audio=off / ocr=off / systemSpeech=off / cursor=off` と表示して継続する
- どちらも LLM に算術はさせない(値はこちらで丸めて記述文として渡し、番号選択
  だけをさせる)
- 画像(スクリーンショット)そのものを LLM に渡すマルチモーダル入力は
  **やらない**(CLI provider(claude-code / codex)では画像添付ができず、
  provider 非依存の `complete` 設計に反するため。開発系チャンネルは画面の
  主役が文字なので OCR で代替する)
- `systemSpeech`: システム音声(デモ音・再生動画・TTS)の発話を各区間へ添える。
  `whisper.systemAudio: true`(下記)で `transcript.system.json` を先に作っておく
  必要があり、無ければ自動で省略(劣化)する
- `cursor`: 各区間のカーソル操作(クリック回数・停留(dwell)回数と最長秒・静止
  比率・待機カーソル比率)を記述文にして添える。`record --watch` が書く
  `<recording base>.cursor.json` サイドカーだけから計算する純関数(新規計測は
  しない)。サイドカー不在は異常ではないので警告は出さず注入をスキップするが、
  `cursor: true` なのに不在のときだけ情報ログを1行出す。`cursorDwell`
  (`minDwellMs`/`moveThreshold`。既定 600ms/0.02)・`cursorWaitTypes`
  (待機系 `cursorType` の完全一致リスト。既定 `["wait", "busybutclickable"]`)
  で調整できる。演出用の `plan.cursor`(ズーム候補の閾値)とは別軸(演出は
  長い/密集した停留を間引くが、知覚では全 dwell を数えたい)なので値も独立
  している。`plan` / `plan --cuts-only` にのみ配線され、`remeta`(章立て・
  タイトル・概要欄の生成)には配線されない(カーソル操作は判断材料にならない
  ため。`docs/decisions.md` 参照)


## plan の候補格子を語境界で細分化する(config.yaml の candidates。既定オフ)

`plan` / `plan --cuts-only` は、`detect` が無音から作った「残す候補区間」に
番号を振って LLM に渡し、LLM は番号単位で cut/keep を選ぶ(番号選択方式で
ハルシネーションを抑える)。`config.yaml` の
`candidates.enabled: true`(既定 false)にすると、この候補格子を **語タイムスタンプ
(`transcript.json` の `words[]`。要 `whisper.wordTimestamps: true`、既定オン)由来の
語境界でも細分化**し、無音検出だけでは拾えない微小ポーズ・フィラーの境界を
候補に足す。**番号選択方式そのものは変わらない**(LLM は今までどおり
`cuts: [{id, reason}]` を返すだけで、時刻を書いたり apply したりはしない)。

- `splitOnlyLongerThanSec`(既定 6): これより長い keep だけを分割対象にする
- `minSplitGapSec`(既定 0.3): 語間ギャップがこの秒以上なら分割点候補にする
  (通常 `detect.minSilenceSec` 未満の間を拾う)
- `minCandidateSec`(既定 0.5): 分割後の各断片の最小尺。これ未満になる分割は
  間引かれる(隣へ併合)
- `fillers`(既定 `["えー","えっと","あの","あのー","まあ","その","なんか"]`):
  フィラー語の前後を分割点にし、フィラー単体を候補として切り出せるようにする
- 分割点は必ず語間ギャップの中点に置かれる(カット境界が語の途中に落ちない)
- 候補のテキストは、その候補内に**実際に残る語**(語の中点が候補区間に入るもの)
  だけを連結する。既存の「重なる whisper チャンクの全文」方式(境界をまたぐと
  実際には残らない語が混ざる)より正確
- **すべての sub-candidate を keep したままなら最終出力は分割前と完全に同一**
  (分割はタイル状=隙間なく元 keep を覆うだけで、隣接する同速 keep は
  describe/render 側で自動的に繋がる)。`enabled` が出力を変えるのは LLM が
  実際に sub-candidate を cut したときだけ
- words を持たない収録(`whisper.wordTimestamps` 無効時に撮った素材等)では
  分割点が作れず候補は分割されない(例外を投げず、実質 disabled 相当に劣化)
- `enabled: false`(既定)のときは候補格子・LLM 入力とも導入前とバイト等価
- `remeta` は対象外(触らない)


## plan --cuts-only の観測ループ(config.yaml の plan.loop。既定オフ)

`plan --cuts-only` だけは opt-in で、カット判断を「生成 → describe/assert による
観測 → LLM への再調整依頼」の有限反復にできる。`maxIterations` が未指定・0・1
のときは従来どおり1ショットで、`plan.loop.json` も書かない。

```yaml
plan:
  loop:
    maxIterations: 3              # 2以上で有効。生成1回 + 再調整を最大2回
    targetOutDurationSec: 300     # 任意。outDuration <= 300 を内部期待値に足す
    stopWhenAssertionsPass: true  # assertions.json + 目標尺が満たされたら停止
```

- 対象は `plan --cuts-only` のみ。通常の `plan`、`remeta` は従来どおり
  1ショット
- 観測は `describe --json` 相当の構造射影と `assertions.json` の Tier 1 構造評価だけを
  使う。OCR や実 A/V の重い観測はこのループには接続しない
- ループ有効時は各反復の候補 `cutplan.json` を書いて観測し、最終応答を
  `plan.raw.txt`、全履歴を `plan.loop.json` に残す。`cutplan.approved` は常に
  `false` で、`approvals.json` は触らない
- 停止条件は `maxIterations` 到達、期待値の fail/error が0、直前と同じ cut 集合の
  3つ。どれも決定論的に判定される


## plan のエージェント化(config.yaml の plan.harness。既定オフ・H1/H2)

`plan --cuts-only` だけは opt-in で、カット判断を「事前計算した知覚をプロンプトへ
焼き込む push 型・単発 completion」から、判断 LLM が read-only の tool を自分で
引きながら生成する「pull 型知覚 + 検証ループ主体」のエージェントに切り替えられる。

```yaml
plan:
  harness:
    agentic: true      # 既定 false。要 ai の structured route が anthropic 等
                        # completeAgentic 対応アダプタ(非対応なら警告のうえ
                        # 従来の単発/pushループ経路へ自動フォールバック)
    maxToolCalls: 16    # 1生成ターンあたりの tool 呼び出し上限(コスト/レイテンシの天井)
    tools:
      frames: true      # 迷った候補だけ最終合成の実画像を見る(get_frames)
      av: true          # 出力レンジの motion/sound を読む(probe_av)
      materials: true   # 素材(B-roll)のメタを読む(probe_materials)
      ocr: true         # 候補の画面テキストを OCR で読む(ocr_screen)
```

- 対象は `plan --cuts-only` のみ。通常の `plan`、`remeta` は従来どおり
  1ショット(触らない)
- LLM が握れるのは read-only の知覚 tool(`describe_timeline` / `get_frames` /
  `probe_av` / `probe_materials` / `ocr_screen`)と検証 tool(`set_cuts` /
  `run_assert`)の7種のみ。`describe_timeline`/`set_cuts`/`run_assert` は常時
  有効で、`plan.harness.tools` で個別に切れるのは `frames`/`av`/`materials`/
  `ocr` の4つだけ
- **最終出力は今までと同じ番号選択(`cuts:[{id,reason}]`)**。`set_cuts` は
  候補 id 配列しか受理せず、存在しない id は拒否されて書込みが起きない
  (ハルシネーション耐性・R0(候補内部を割らない)は不変)
- `plan.harness.agentic: true` でも `plan.loop.maxIterations` が2未満なら、
  agentic の検証往復が最低1回の再調整を持てるよう内部で2へ昇格する
  (プロンプト・cutplan は harness off のときと無関係に決まる)
- tool-use 非対応のアダプタ(anthropic 以外)や実行中の回復不能なエラーは、
  警告のうえ tool 無しの単発経路へ自動フォールバックする(例外で `plan` 全体を
  落とさない・`cutplan.json` は必ず生成される)
- 各反復の tool 往復(引数・結果は生値ではなく短いダイジェストのみ)は
  `plan.loop.json` の該当 iteration に `agenticTrace` として残る(中間生成物・
  手編集対象外)
- `plan.harness` を省略、または `agentic: false`(既定)のときは、生成
  プロンプト・`cutplan.json` は導入前と**バイト等価**

### 候補内部の語境界分割(config.yaml の plan.harness.applySplit。既定オフ・H6)

`plan.harness.agentic: true` の**内側**でさらに opt-in すると、判断 LLM は候補丸ごとの
keep/cut(番号選択)に加えて、**1つの候補の内部を語境界で割って一部だけを cut** にできる
(SD1〜SD4 が保存してきた「候補は分割しない」という壁=R0 を初めて直接崩す施策)。

```yaml
plan:
  harness:
    agentic: true
    applySplit: true   # 既定 false。要 agentic:true + whisper.wordTimestamps:true
    maxSplits: 4        # 1ターンの分割上限(確信区間のみ=全面移行はしない)
```

- **LLM は時刻を一切生成しない。** 新しい read tool `list_words {id}` が候補内の語を
  1始まり index 付きで返し、write tool `split_candidate {id, cutWordRanges:[{i,j,reason}], ...}`
  で「語 i〜j(両端含む)の sub-span を cut にする」と指す。境界時刻は必ず
  `transcript.words` の語境界(gap 中点。SD2/C1 と同じ規約)へスナップされる。
  存在しない語 index・逆順・語タイムスタンプの無い候補は機械的に**拒否**される
  (番号選択と同型のハルシネーション耐性を語粒度で維持)
- **書込みゲートは `validate`+`assert`。** `split_candidate` は分割後の試作 cutplan を
  一度 `cutplan.json` へ書き、`validate(dir)` と `assert(dir)` を走らせる。どちらかに
  error があれば**直前の内容へロールバック**し(部分書き込みは残らない)、LLM へ却下理由を
  返す。番号選択が担っていた「候補格子=安全網」を `apply`+検査へ置き換える(母艦 D1)
- **確信区間だけ・有界。** `maxSplits`(既定4)で1ターンの分割数を上限し、各
  sub-segment は `candidates.minCandidateSec`(既定 0.5 秒)未満になる分割は拒否される
- `set_cuts`(候補id単位)は引き続き残り、置き換えられない。最終 cutplan は
  「候補選択(`buildCutplan`)→確定済み分割の適用(`applyCandidateSplits`)」の2段で
  組み立てられ、候補を後から `set_cuts` で丸ごと cut にすると、その候補に対する
  分割は自然に無意味化する
- **候補内部分割は keep 集合を変えるので、既存の承認(`approvals.json`)は
  hash 不一致で自動失効する**(正しい挙動。人間の再承認待ちになる)
- 分割の試行(候補id・語 range・採否・検査結果ダイジェスト。生の args は含まない)は
  `plan.loop.json` の該当 iteration に `splitOps` として残る(中間生成物)
- `plan.harness.applySplit` を省略、または `false`(既定)のときは、tool セット・
  cutplan は `applySplit` 導入前(SD4)と**バイト等価**


## plan の編集モード(config.yaml の plan.editMode。既定 balanced)

`plan` / `plan --cuts-only`(生成・再調整の両方)は、プロンプトの
「カットの判断基準」の最後の1行を編集モードで切り替える。3値:

- `safe`: 「迷ったら残す。過剰カットより冗長の方がまし」(X4 導入前の固定文と
  **バイト等価**。回帰基準線の再現に使う)
- `balanced`(**既定**): 明確な冗長・言い直し・脱線は積極的に切ってテンポを作る。
  見せ場と説明の要点は必ず残す。判断がつかない中間区間は残す
- `aggressive`: 冗長・重複・長い沈黙・脱線はためらわず切る。テンポ最優先。
  見せ場だけは必ず残し、それ以外は「残す理由があるか」で判断する

```yaml
plan:
  editMode: balanced   # safe / balanced(既定) / aggressive
```

- 優先順位: `brief.md` のマーカー行 > `rules.md` のマーカー行 > `config.yaml`
  の `plan.editMode` > 既定(balanced)。マーカー行の書式は
  `編集モード: aggressive` または `edit-mode: safe`(前後空白可・大小文字不問)。
  同じファイル内に複数あれば最後の一致が勝つ
- `config.yaml` に未対応の値(`safe`/`balanced`/`aggressive` 以外)が来ても
  例外は投げず、警告のうえ既定(balanced)にフォールバックする
- 効くのは「カットの判断基準」の最後の1行だけ。言い直し/脱線/エラーの3行や
  章立て・タイトル・概要欄の指示、brief/rules 本文は不変
- `plan.loop.targetOutDurationSec` が設定されていれば(ループが無効でも)、
  モード行の直後に「目標の出力尺は約 N 秒。冗長を削ってこの尺に近づける」の
  1行が単発 `plan` のプロンプトにも足される。未設定なら何も足されない
- `remeta` は対象外(cut 判断ではないので触らない)


## plan のスタイル注入(config.yaml の plan.styleProfile。既定オフ)

`plan` / `plan --cuts-only` は、`style-profile` が抽出した style profile
(`style.probe/<name>.json`)を **候補選択のソフトな prior** として LLM の
プロンプトへ添えられる。
既定オフで、オフのとき LLM 入力・`plan.raw.txt` は導入前と1バイトも変わらない
(`plan.perception` と同じ不変条件)。

```yaml
plan:
  styleProfile:
    enabled: true    # 既定 false(バイト等価)
    profile: default # 読む profile 名(style.probe/<profile>.json)。既定 "default"
```

- 有効化には先に `node src/cli.ts style-profile --from <dir>` で
  `style.probe/<name>.json`(このプロジェクトの**親ディレクトリ=channel**直下)を
  作っておく必要がある。無い/壊れている場合は警告して注入をスキップするだけで
  `plan` は止まらない(前提エラーにしない。§優雅な劣化)
- 注入されるのは **cut / caption / structure の3面だけ**(音量・章タイムライン
  そのものは載せない)。それぞれ「目標平均ショット長・積極度・学習帯」
  「字幕カバレッジ・密度・位置・強調スタイル」「冒頭フック秒・CTA有無」を
  日本語の圧縮 summary(raw JSON ではない)として1ブロックにまとめる
- 各行に `[prior:強め/中程度/弱い(cold-start・参考程度)]` を付け、profile の
  confidence(観測数が少ないほど低い)をそのまま LLM に伝える。承認済み収録
  1本だけの cold-start(N=1)では常に「弱い」になり、LLM に「参考程度」と
  明示する
- ブロックの先頭に「brief.md(今回の意図)に劣後する参考情報」である旨と
  「番号選択の重み付けにだけ使い、精密な数値やタイムスタンプは生成しない」旨を
  明記する。**番号選択方式(`cuts: [{id, reason}]`)は変わらない**。LLM に
  座標や秒数を新たに書かせることは一切ない
- プロンプト内の配置順は `brief` → `rules` → `perception` → `styleProfile`
  で、style prior は最も弱い・最後尾の参考情報として置かれる(brief/rules が
  常に優先)
- `plan` 実行時に知覚状態と同様、注入状態を必ず表示する。
  例: `plan スタイル注入: on(profile=default)` / 未設定時は
  `警告: plan.styleProfile が config.yaml にありません。スタイル注入はオフです。`
  に続けて `plan スタイル注入: off`
- v1 の注入先は **plan / plan --cuts-only の cut 判断プロンプトのみ**。
  `remeta`(章立て・タイトル・概要欄) / `plan-materials` /
  `plan-effects` / `plan-bgm` は対象外(v2 拡張点として明示 defer)。
  `plan --cuts-only` の観測ループ(`plan.loop`)を使う場合も、再調整の
  critique 反復にはこのブロックを渡さない(生成ターンにだけ渡す)


## plan の分類 id(reasonId)と収録タイプ(config.yaml の plan.reasonIds。既定オフ)

`plan` / `plan --cuts-only` は、カット判断の各候補に **分類 id**
(`docs/edit-skills/cut/recipes/<id>.md` の13分類。単一の出所は
`src/lib/reasonIds.ts` の `CUT_REASON_IDS`)を付けさせられる。既定オフで、
オフのとき LLM 入力・`cutplan.json` の `reasonId` は導入前と1バイトも変わらない
(`plan.perception`/`plan.styleProfile` と同じ不変条件)。

```yaml
plan:
  reasonIds:
    enabled: true      # 既定 false(バイト等価)
    pattern: tool-demo # 既定 general(13分類全部)。収録タイプで部分集合+
                        # blueprint(文脈)を選ぶ。docs/edit-skills/patterns.md 参照
```

- 有効時は本編 `plan`・単発 `plan --cuts-only`・`plan.loop` の生成/再調整
  反復すべてに注入される(`remeta` には注入しない。v1 は cut 判断のみ)
- `keeps` 配列(「切る誘惑があったが残した」区間だけを列挙。上限
  `max(12, 候補数の10%)`)も同時に依頼できる。config が off のときに LLM が
  誤って `keeps` を返しても無視される(明示ゲート)
- 未知の `pattern`(`docs/edit-skills/patterns.md` に無い id)は警告のうえ
  `general` へ劣化する(前提エラーで `plan` を止めない)

### 語彙カバレッジを測る(`describe --json` の `summary.reasonIds`)

`node src/cli.ts describe <dir> --json` の `summary.reasonIds.coverage` に、
この収録の cut 判断のうち何%に分類 id が付いているかが出る(**sticky**:
`reasonId` を1つも持たない cutplan で `plan.first.json` も無ければキー自体が
無い=導入前と `describeJson` の出力が完全に同一):

```jsonc
"summary": {
  "reasonIds": {
    "coverage": {
      "semanticCuts": 79,   // fillSilenceGaps の穴埋め cut を除いた「意味カット」
      "labeled": 61,        // うち reasonId 付き
      "ratio": 0.77,
      "byId": { "restatement": 23, "gap-trim": 20, "...": 0 } // cut系7分類を固定鍵順で
    },
    // plan.first.json(AI 初版。write-once)がある収録だけ。無ければキーごと無い
    "firstVsFinal": {
      "source": "plan --cuts-only",
      "reasonIdsEnabled": true,
      // 初版で cut と判断された reasonId のうち、最終的に keep へ反転した割合
      "flippedToKeep": [{ "reasonId": "dead-air", "first": 12, "flipped": 4, "rate": 0.33 }],
      // 初版で「切る誘惑があったが残した」(keeps)reasonId のうち、最終的に cut へ反転した割合
      "flippedToCut": [{ "reasonId": "demo-wait", "first": 9, "flipped": 1, "rate": 0.11 }]
    }
  }
}
```

散文 `describe`(既定)には、このブロックが存在するときだけ1行出る:
`分類: 意味カット 79 件中 61 件に分類 id(77%)`(`plan.first.json` があれば
末尾に `/ 初版から反転 5 件` が付く)。閾値ゲートは無い(測るだけ。N=1 で
閾値を切ると次の収録で無意味に落ちるため)。

`firstVsFinal` は `plan.first.json`(候補 id ではなく元収録の秒を持つ)と
現在の `cutplan.json` を**元秒で突き合わせて**求める(`detect`/`candidates`
の再実行で候補番号が変わっていても正しく join できる)。区間が分割・統合
されて元秒がどちらの segment とも一致しなくなった場合はその件だけ集計から
外れる(過大/過小に倒さない)。`describe` は `plan.first.json` を**読むだけ**
(書き換えない・存在しなければ `firstVsFinal` を省くだけで落ちない)。

## システム音声の文字起こし・keep 内の間(AI の耳の強化。既定オフ)

マイク音声(あなたの声)は `transcript.json` に描画用テロップとして起こされるが、
最終出力に mix される**システム音声**(デモアプリの音・再生した動画・TTS の
読み上げ)は従来 AI から不可視だった。これを**知覚専用**に文字起こしできる。

```yaml
whisper:
  systemAudio: false  # true でシステム音声(ingest.systemTrack)を第2トラックとして
                      # 文字起こしし transcript.system.json を書く
describe:
  pauses: false       # keep 内に残った無音(間)の位置と長さを describe に出す
  pauseMax: 3         # 1 keep あたりに出す間の件数上限
  pauseMinSec: 0.6    # これ以上の長さの間だけ出す(秒)
```

- **システム音声の文字起こし(`whisper.systemAudio`)**: 収録にシステム音声トラック
  (`ingest.systemTrack`)があるとき、`ingest` が `audio/system.wav` を抽出し、
  `transcribe` が第2回 whisper で `transcript.system.json`(`speaker: "system"`)を
  書く。これは**描画されない・編集されない・`@id`/承認/apply の対象外の知覚専用
  生成物**で、`transcript.json`(テロップの描画契約)には混ざらない。`describe`
  (散文は `[システム音声]「…」`、`--json` は `systemAudio` キー)と、`plan` の
  `plan.perception.systemSpeech` で読める。既定 false のとき出力は一切変わらない
  (収録に system トラックが無ければ true でも自動で無視)。
- **話者分離について(正直な宣言)**: FrameWright の「話者分離」は**収録トラック起源の
  音源分離**(マイク=あなた / システム=アプリ・デモ・TTS)であって、1本の音声波形
  から複数の人間の声を聞き分ける**音響的 diarization ではない**。OBS の2トラック
  収録では声とアプリ音が物理的に別トラックに録れているため、トラックを分けて
  文字起こしするだけで実用上の分離になる。1マイクに複数人が乗る収録の分離は
  重い ML 依存(pyannote 等)を招くため**やらない**(ローカル・決定論・ソロ保守の
  方針)。
- **keep 内の間(`describe.pauses`)**: `plan.perception.audio` が区間内無音の
  **合計秒**を渡すのに対し、これは残した keep の**どこに何秒**の間があるかを
  `describe`(散文/`--json`)に出す(「ここを詰める/カットを足す」判断の材料)。
  `cuts.auto.json` の無音区間から算出する純関数で**新規計測はしない**。既定 false。

