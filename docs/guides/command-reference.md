# コマンド早見表

> 全コマンドを「いつ使うか」で引く一覧。分類は CLI の `framewright commands` と同じ
> (出所は `src/lib/cliHelp.ts`)。個々の全オプションは `framewright <コマンド> --help`、
> 機能ごとの詳しい説明は各ガイドを参照。
> 関連: [../usage.md](../usage.md) / [cut-planning.md](cut-planning.md) / [materials.md](materials.md) / [effects.md](effects.md) / [audio-bgm.md](audio-bgm.md) / [export.md](export.md) / [safe-editing.md](safe-editing.md) / [ai-agents.md](ai-agents.md) / [tools-and-ops.md](tools-and-ops.md)

## ヘルプの引き方

| 知りたいこと | 叩くもの |
|---|---|
| まず何をすればいいか | `node src/cli.ts --help`(基本の流れだけの短い案内) |
| どんなコマンドがあるか | `node src/cli.ts commands`(分類つきの全一覧) |
| このコマンドの全オプション | `node src/cli.ts <コマンド> --help` |
| どのファイルを直すと何が変わるか | [../usage.md](../usage.md) |

`framewright` は `npm link` 済みの人間向けの入口で、`node src/cli.ts` と同じコードに
落ちる。CLI が出すヒントは、実際に使われた入口に合わせて書き分けられる。

## セットアップ・診断

| コマンド | 使う場面 |
|---|---|
| `doctor` | **環境が揃っているか確認したい**とき。node(>=23.6)/ ffmpeg / ffprobe / エンコーダ整合 / whisper バイナリ・モデル / AI route 到達性を read-only で検査する。必須(node/ffmpeg/ffprobe)欠落は exit 1、収録・AI 系の欠落は warn(exit 0)。`--json` で機械可読、`--no-ai` でネットワークプローブを省略。収録フォルダには書かない |
| `ai doctor` | **AI provider の設定と到達性だけを確認したい**とき。text / structured output / image の各 route をプローブする |

## 取り込み〜カット案

| コマンド | 使う場面 |
|---|---|
| `run <dir>` | CLI で **AI 初版まで作りたい**とき(transcribe → detect → plan → id-stamp)。`manifest.json` がまだ無いフォルダでは先に `ingest` も走る(このときだけ `--layout` / `--canvas` / `--base-layout` / `--mic-track` / `--system-track` が効く)。**人間の編集がある**生成物を上書きするときだけ `--force` が必要(実行前に backups/ へ退避)。エディタで開くと自動解析が走るため、開いた後の `run` / `plan` は `--force` が要る。`--force` なしで通るのは「一度もエディタで開いていない収録」の bootstrap 生成物だけ。末尾で条件を満たすときだけ `autozoom` を非破壊に自動実行する。`--full` は続けて `probe --all` と `draft --all` まで走らせる |
| `probe <dir>` | **素材や A/V をまず知覚したい**とき。無指定または `--all` は `materials.probe/` と `av.probe/` を作る。`--deep` は素材の frames/OCR/transcribe まで実行。`--style` は循環参照を避けるため明示指定時だけ `style-profile --from <dir>` を実行する |
| `draft <dir>` | **cutplan 以外の下書きをまとめて作りたい**とき。無指定または `--all` は materials → effects → bgm。素材配置の質を上げたいときは先に `probe <dir> --materials --deep`。`--zoom` は `--all` に含めず、`--effects` と同時指定不可。実行時に `cutplan.json` / `approvals.json` が変わっていないことを assert する |
| `check <dir>` | **検品をまとめて実行したい**とき。無指定または `--all` は materials/effects/bgm/style/boundary。素材/BGM の安全な知覚前提は自動実行するが、style-profile と id-stamp は通常モードでは自動実行しない。`--fix` は id-stamp 後、生成済み suggested patch を `apply` 経由で当てる。`--dry-run` は `--fix` と併用 |
| `ingest` / `transcribe` / `detect` | config.yaml を変えて部分的にやり直すとき(例: `detect.silenceDb` 調整)。detect をやり直すとカット候補が変わるので cutplan も作り直しになる。transcribe の再実行はテロップの手編集ごと上書きする(既存の transcript.json は backups/ へ退避される)。`whisper.wordTimestamps`(既定 true)が有効だと transcribe が各テロップに `words[]`(語単位タイミング。テロップの `style.karaoke` が消費する)を付ける。既存収録は再 transcribe が要る。`whisper.captionSplit`(省略時オフ)を書くと、長い1発話を意味の切れ目で折った読みやすい1テロップへ決定論で割り直す(区切りの強さ(句点 > 述語の終止形 > 接続助詞 > 格助詞 > 連体の「の」)+ 無音の「間」+ 行頭禁則をスコア化し、全体最適を動的計画法で選ぶ。LLM も再文字起こしも使わない) |
| `editor <dir> --layout <plain\|obs-canvas\|auto>` / `ingest <dir> --layout …` / `run <dir> --layout …` | **入力**の収録形式を明示するとき。既定は `plain`=通常動画(1画面・カメラ無し。出力解像度=収録の実寸)。画面+カメラを1本に同時収録した横長素材を左右に分けて使う場合だけ `--layout obs-canvas`。`auto` はキャンバス寸法が `screenRegion + cameraRegion` と完全一致、または十分な超横長なら obs-canvas、それ以外は plain |
| `editor <dir> --canvas <preset>` / `ingest <dir> --canvas …`(`run` は manifest が無いときだけ) | **出力**サイズを明示するとき(`landscape` 既定 / `landscape-hd` / `landscape-4k` / `portrait` / `portrait-4k` / `square` / `portrait-4x5` / `cinema` / `classic`)。**作成時固定**で後から変えられない。一覧と寸法は [../usage.md の「出力キャンバス」](../usage.md) |
| `editor <dir> --base-layout <auto\|screen\|camera\|stack>` / `ingest <dir> --base-layout …` | 出力キャンバス上への**ベース映像の置き方**を明示するとき。既定 `auto`。`camera` / `stack` はカメラ領域を持つ `obs-canvas` 収録でだけ有効。`--canvas` と同じく作成時固定。エディタの新規作成 UI には出ないので、`auto` 以外はこのフラグで作る |
| `ingest <dir> --mic-track <n>` / `--system-track <n>`(`run` も同じ) | 音声トラックの割当が `config.yaml` の `ingest.micTrack`/`systemTrack`(既定 1/2)と違うとき、一時的に上書きする(1始まりの番号)。`ingest` はまず設定値を尊重し、範囲外なら音声トラックが1本ならそれを mic とみなし、複数本ならメタデータ(タイトル)から推定し、それでも判別できなければ**見つかった全トラックの一覧を提示して停止**する(黙って別トラックを mic として抽出することはない) |
| `plan <dir>` | プロンプト(prompts/plan.md)改良後など、LLM 判断だけやり直すとき。**上書き注意**(2回目以降は `--force` が必要) |
| `plan <dir> --cuts-only` | カット判断だけをやり直したいとき(章立て・タイトル案・概要欄は変えたくない)。cutplan.json / plan.raw.txt だけを書く |
| `remeta <dir>` | **カットは手編集済みだが、章立て・タイトル案・概要欄だけ作り直したい**とき。現在の keep 区間(=完成動画)を見て chapters / meta と「章」トラックのテロップだけを再生成する。cutplan は触らない(実行前に transcript / chapters / meta を backups/ へ退避) |

## 確認・承認・書き出し

| コマンド | 使う場面 |
|---|---|
| `editor`(引数なし) | **どのプロジェクトを開くか選びたい / 新しく作りたい**とき。`config.yaml` の `recordingsDir` 直下、または `recordingsDirs` の全 root のプロジェクト一覧(ランチャー)をブラウザで開く。単一 root ではカードから `/p/<フォルダ名>/`、複数 root では `/p/<root>/<フォルダ名>/` へ移る。「+ 新規プロジェクト」は名前・キャンバス・保存先 root(複数 root 時)を決めてフォルダを作るだけ(`ingest` は走らず、次の画面でベースメディアを選ぶ)。`--detach` / `--status` / `--stop` はプロジェクト単位の機能なので引数なしでは使えない |
| `editor <dir>` | **GUI で編集したい**とき。カット境界のドラッグ・テロップの配置と文言・素材の挿入・AI 初版生成・派生プロジェクト作成・承認・プレビュー生成・レンダーまでブラウザで完結する。**まだ無いフォルダを指定しても作って開ける**。ベースメディアが未確定なら画面内で選ぶ(候補が複数あってもファイル名から推測せず人間が選ぶ)。外部(手編集や AI)の JSON 変更はホットリロードで反映される。`--detach` でバックグラウンド起動(`--status` / `--stop`)。**画面と操作の一覧は [editor.md](editor.md)**(画面内はヘッダーの「?」) |
| `derive <dir> --name <名前> --canvas <preset> --range <開始-終了>` | **同じ収録から別サイズの出力も作りたい**とき(縦ショート等。旧 shorts 動線の後継)。元プロジェクトの兄弟フォルダに新しいプロジェクトを作り、ベースメディアを symlink(非対応ならハードリンク → コピー)で共有し `transcript.json` を引き継ぐ。`--range` は**元収録の秒**で複数指定でき、その範囲が keep になる。`overlays` / `bgm` / `chapters` / `meta` / `approvals` は引き継がない。派生先が既にあればエラー(`--force` は無い)。エディタでは keep 区間を選んでヘッダーの「この範囲で派生」 |
| `preview <dir>` | cutplan.json を編集するたび。承認前でも動く |
| `approve <dir>` | previewを確認してcutplanを承認したいとき。`approvals.json` に keep 集合のハッシュを記録する。対話操作で、非対話環境からは `--yes` が無いと拒否される |
| `unapprove <dir>` | cutplanの承認を取り消すとき |
| `render <dir>` | `approve` 済み(= 現内容のハッシュと一致するレコードがある状態)のときだけ実行できる。`cutplan.json` の `approved: true` を書くだけでは通らない。transcript.json 修正後の再実行は速い(再文字起こし不要) |
| `thumbnail <dir>` | `thumbnail.json` からサムネイル静止画(`thumbnail.png`)を作りたいとき。元収録のフル解像度で描く |
| `clean <dir>` | **収録フォルダのディスクを空けたい**とき。中間生成物/キャッシュを安全削除(分類は `src/lib/files.ts` の `GENERATED_FILES`/`fileRole` 由来。編集ファイル・`approvals.json`・`materials/`・元収録・成果物には触れない)。元収録の自動リマックス複製(`.mkv` の隣に残る同一内容の `.mp4`)だけは ffprobe で内容一致を確認のうえ削除する。`--dry-run` / `--cache-only`(重いキャッシュだけ)/ `--logs-only`(ログ・使い捨て下書き・検品結果・preview・frames だけ)/ `--json` |

## 編集を当てる

| コマンド | 使う場面 |
|---|---|
| `validate <dir>` | JSON を手編集した後は毎回。整合性エラー(exit 1)と警告を出す。概要欄チャプター(chapters.json)と画面表示の章タイトル(「章」トラックのテロップ)の食い違い、`frames/index.json` の陳腐化(「frames を撮り直せ」)も警告する。GUI の保存も同じ検査を通す |
| `apply <dir> --patch <file>` | **`@id` 指定の編集を検査付きで当てたい**とき(生 JSON を丸ごと書き換えず、配列添字も書かない)。全部 valid なら全書き込み、1つでもエラーなら1バイトも書かない。`--dry-run` で書かずに変更要約だけ見られる。`approved` は変更できない |
| `id-stamp <dir>` | **既存プロジェクトの各要素に `@id` を一括採番したい**とき(冪等。既存 id は保持し、無い要素にだけ振る)。`material-fit` / `bgm-fit` の前提でもある |
| `describe <dir>` | JSON 群を全部読まずに編集状態(keep/カットの並び・各区間の発言・カット理由・演出・章)を把握したいとき。人間可読の散文(発言は36字で切り捨て、タイトル案は先頭3件のみ)。元秒⇔出力秒を併記し、末尾に frames の現況か撮り直し勧告を添える |
| `describe <dir> --json` | **散文では切り捨てられる情報まで機械的に処理したい**とき。発言・タイトルを切り捨てない完全射影を stdout に純 JSON で出す(`keeps` / `cuts` / `captions` / `overlays` / `chapters` / `meta` / `bgm`)。パイプ / `JSON.parse` 可能(診断行は stderr)。id-stamp 済みなら各要素に `id` が載る(@-mention の発見手段) |
| `assert <dir>` | **宣言した編集意図(`assertions.json`)が保たれているか検証したい**とき。`describe --json` の射影に対して照合する。`--visual` で OCR ベースの検査も評価する |

## 中身を知る(知覚)

| コマンド | 使う場面 |
|---|---|
| `frames <dir> --t ... \| --captions \| --every N` | その時刻の絵を確認したいとき(テロップ位置・ワイプ被り・素材の見え方)。`frames/*.png` に出力(実行のたびに古い PNG は全消し) |
| `frames <dir> --scenes` | **画面が変わった瞬間だけ見たいとき**(一律間隔だと変化点を取り逃す/静止区間を撮りすぎる)。要 `av <dir>` の事前実行。`av.probe/motion.json` の scene score・freeze 区間から変化点+静止区間の代表+端点を自動選択する。上限は `--max-shots`(既定は `config.yaml` の `frames.scenes.maxShots`、省略時60) |
| `frames <dir> ... --ocr` | 画面内のコード・ターミナル・エラー文をテキストとして読みたいとき。元収録のフル解像度の画面領域を Apple Vision で OCR し `frames/out<秒>s.ocr.json` に書く。macOS 専用・オフライン。非対応環境では警告のうえ PNG 出力のみ続行 |
| `frames <dir> ... --full-res` | 画面キャプチャ内の文字を絵として鮮明に見たいとき。ベース映像をプロキシではなく元収録のフル解像度にした**合成込み**の still を出す。`--ocr` と併用可 |
| `frames-serve <dir>` | **JSON 微調整ループ(編集 → `frames --t …` → 確認 → …)を何度も回すとき**。bundle+headless Chrome を暖めたまま待ち受ける opt-in の常駐デーモン。起動していなければ `frames` は従来どおりの単発実行(挙動・出力は不変) |
| `materials <dir>` | **素材(B-roll)の中身を知りたい**とき(尺・解像度・fps・音声有無・`overlays.json`/`bgm.json` との参照クロスリンク・未使用/dangling 検出)。既定は ffprobe だけ。`--frames`/`--ocr`/`--transcribe`/`--all` で見た目・画面文字・音声発話まで opt-in で取得 |
| `av <dir>` | **keep 後タイムラインの動きと音を知りたい**とき。`av.probe/motion.json` / `sound.json` / `motion.strip.png` に motion(scene score・freeze・フィルムストリップ)と sound(LUFS 包絡・無音・mic/system 被り・BGM/duck 設定)を出す。`--range`(出力秒)/ `--every` / `--full-res` / `--motion-only` / `--sound-only` |
| `screen <dir>` | **画面が「いつ何を映していたか」を区間で知りたい**とき(`frames --ocr` の「点」に対する「区間」)。要 `av <dir>` 事前実行。scene score 駆動でサンプル時刻を選び、各時刻の画面 OCR を「OCR 行 Jaccard < 閾値 **かつ** scene score >= 閾値」の2条件 AND で区間へ畳んで `screen.probe/index.json` に書く。`--stills` / `--json` / `--force`。キャッシュは2層で、OCR 結果は cutplan 非依存(カットを編集し直しても増分だけ)。編集ファイルには一切書かない |
| `record --watch` | **カーソル座標を収録と一緒に記録したい**とき(`autozoom` / `plan-effects` のカーソル dwell アンカーの元データ)。録画ボタンに連動して `<収録ファイル名>.cursor.json` を収録ファイルの隣に書く常駐 watcher。macOS 専用・ingest より前に走る |
| `index` / `search <query>` | **収録をまたいで探したい**とき。`index` が `recordingsDir` のローカル検索インデックスを更新し、`search` が収録・素材の metadata / OCR / 文字起こし / `screen.probe/index.json`(画面区間の OCR。video-perception-P2)を横断検索する(収録フォルダ引数を取らない)。**過去収録の画面に映っていた文字列(エラーメッセージ・コマンド・ファイル名)を探すときは `search "<文字列>" --kind screen`**(`--kind` は `recording \| material \| caption \| screen`)。`recordingsDirs` 設定時も検索対象は primary root のみで、複数 root 横断はランチャーだけが対応する |
| `review <dir>` | **before/after の差分を人間がレビューできる形で束ねたい**とき。決定論のレビュー束を `review.probe/index.json` に書く |

## AI に下書きさせる

いずれも**下書き止まり**で、`cutplan.json`(カット)と `approvals.json`(承認)には
触れない。既存の生成物があるときは `--force` が必要で、実行前に `backups/` へ退避される。
時刻・座標・ファイルパスは LLM に生成させず、決定論で列挙した候補の**番号選択**だけをさせる。

| コマンド | 使う場面 |
|---|---|
| `plan-materials <dir>` | **手持ちの素材(B-roll)をどこに置くか下書きしたい**とき。要 `materials <dir> --all` の事前実行。keep span(アンカー)× 実在素材に番号を振り、(アンカー番号, 素材番号) のペアだけを選ばせて `overlays.json` の `overlays[]` を書く |
| `plan-effects <dir>` | **画面の一部を拡大/隠す/囲みたい下書きが欲しい**とき。要 `frames <dir> --ocr` と `av <dir>` のいずれか(両方推奨)の事前実行。演出アンカーに番号を振り、(アンカー番号, 種別) のペアだけを選ばせて `zooms`/`blurs`/`annotations` を書く(座標は知覚が決めた実在矩形から)。`--observe` で前回の `effect-check.json` の警告を参考情報として渡す |
| `autozoom <dir>` | **カーソルの滞留からズームを機械的に置きたい**とき(LLM 不使用)。要 `record --watch` のカーソルサイドカー。`overlays.json` の `zooms` だけを置換し、`blurs`/`annotations` は不変。`plan.cursor.autoZoom`(既定 true)なら `run` の末尾でも非破壊に自動実行される |
| `plan-bgm <dir>` | **手持ちの曲をどこに敷くか下書きしたい**とき。区間境界は章境界+大カット境界から決定論で列挙し、曲は `materials/` の音声ファイル ∪ 収録直下 `bgm.*` から番号選択する |
| `learn <dir>` | **直前の LLM 生成を人間がどう仕上げたかから、次回用のチャンネルルール追記案を作りたい**とき。`rules.suggested.md` に下書きを書き、**channel の `rules.md` には一切書き込まない**(採用は人間が手で転記)。`plan.raw.txt` が無ければ先に `plan` か `run` |

## 検品する

いずれも**収録フォルダの編集ファイルを1バイトも書かない**。修正候補があるものは
`apply` にそのまま食わせられるパッチ下書き(`*.suggested.json`)として出るので、
**適用は人間が確認して `apply --patch …` を叩く**。

| コマンド | 使う場面 |
|---|---|
| `material-fit <dir>` | **素材参照の尺不整合(overrun/underrun)や dangling/unused を直したい**とき。要 `materials <dir>` の事前実行と overlays の `@id`。→ `material-fit.suggested.json` |
| `effect-check <dir>` | **置いた演出が目的を果たしているか検品したい**とき。zoom と固定px演出の相互作用・演出密度・テロップとの座標重なりを決定論で検査し、任意で VLM に after still を見せて yes/no を問う(座標は生成させない)。`--no-vlm` / vision route 未設定でも決定論レポートは exit 0 で返る。→ `effect-check.json` / `effect-fix.suggested.json` |
| `bgm-fit <dir>` | **BGM の音量/duck/フェードが実測と合っているか直したい**とき。要 `av <dir>` の事前実行。発話被り・無音浮き・大音量・フェード無しを検出し、章が複数あるのに単調/fallback のままなら `plan-bgm` へ誘導する。→ `bgm-fit.json` / `bgm-fit.suggested.json` |
| `style-profile --from <path>` | **任意の動画/収録からテンポ・字幕密度/位置・ラウドネス・構成の統計(スタイルプロファイル)を抽出したい**とき。`<dir>` ではなく `--from`(複数可)で入力を集め、channel 直下の `style.probe/<name>.json` に書く |
| `style-check <dir>` | **今の編集が学習した型からどれだけ外れているか測りたい**とき。要 `style-profile` の事前実行。cut/caption/audio の逸脱を warn/info で報告する(逸脱は不正ではないので常に exit 0)。→ `style-check.json` |
| `boundary-check <dir>` | **カットで語尾を食っていないか実音声で確かめたい**とき。keep 終端直後 120ms の RMS を収録ごとのノイズ床相対で検品する(文字起こし・LLM 不使用・read-only) |

## HyperFrames(無音の作図素材)

章タイトル・図解・キネティックタイポグラフィなどの**無音の作図素材**を作って
`materials/hyperframes/<name>.mp4` として置くライン。詳細は [../usage.md](../usage.md) の
HyperFrames 各節を参照。

| コマンド | 使う場面 |
|---|---|
| `hyperframe-backends` | どの backend が使える状態かを知りたいとき(収録フォルダ不要・read-only。`--json` で機械可読) |
| `hyperframe <dir> --name <name> --from-brief` | カードの HTML を LLM に下書きさせたいとき(固定パターンメニューからの番号選択+check ゲート通過必須) |
| `hyperframe <dir> --name <name>` | 下書き済みの `hyperframes/<name>.html` を mp4 へ render したいとき(check ゲート・キャッシュ付き) |
| `hyperframe <dir> --name <name> --embed-lottie <json>` | 人間が持ち込んだ AE/bodymovin JSON を1枚のカードへ決定論でインライン化したいとき |
| `hyperframe-place <dir> --name <name> --at <秒>` | render 済みカードをタイムラインへ置く案が欲しいとき。→ `hyperframe-place.suggested.json` |
| `hyperframe-check <dir> --name <name>` | render 前にカードの動的な破綻(終端未完了・空終端・画面外・seek 無反応・dead zone・一斉登場)を監査したいとき。決定論のみ・常に exit 0 |
| `hyperframe-freeze <dir> --name <name>` | 出来のよいカードを次回の雛形として凍結したいとき。DRAFT を書くだけで、channel の `hyperframe-seeds/` への採用は人間が手で行う |

## エージェント連携

| コマンド | 使う場面 |
|---|---|
| `mcp <dir>` | **任意の MCP 対応エージェント(Claude Desktop / Claude Code / Cursor 等)にこの収録フォルダを機械的に開かせたい**とき。stdio 上で read(`describe`/`validate`/`frames`/`materials`/`assert`)+ 承認スコープ外の安全編集(`apply`/`id-stamp`)の tool だけを露出する常駐サーバ。**承認・`render`・`plan` 等は露出しない**(汎用の「CLI を実行する」tool も無い)= 設計上、エージェントは承認できない。ホスト別の設定例・信頼モデルは [ai-agents.md の「MCP サーバ」](ai-agents.md) |

## 研究・較正(上級)

`detect` の閾値を実測で決めるための read-only 比較。いずれも**収録フォルダには
何も書かず**、文字起こし・LLM も使わない。`--json` の出力にパスや時刻は含まない。
背景と結果は [../usage.md](../usage.md) の「detect の較正と無音圧縮 preset」を参照。

| コマンド | 使う場面 |
|---|---|
| `silence-sweep <dir>` | 固定 `silenceDb`(-35/-40/-45/-50)を他ノブ固定で比較したいとき |
| `floor-calibration <fitDir>` | 収録ごとの無音床から相対閾値を較正し、`--verify <dir>` で他収録に当てたいとき |
| `boundary-direction <dir>` | 承認済みの人間最終版と現設定の detect keep の境界差を分類したいとき(要ハッシュ一致の承認) |
| `compaction-sweep <dir>` | 較正済み閾値を固定して、無音圧縮の時間3ノブ36条件を比較したいとき |
| `calibration-evaluate <dir>` | 固定10 variant を `boundary-check` と同じ測定系で比較したいとき(人間最終版は任意) |

---

`frames` は撮影のたびに、その絵を決める編集 JSON(本編経路は cutplan/
transcript/overlays)の内容
フィンガープリントを `frames/index.json` に記録する(stale-PNG 対策。
frames は毎回全消し+撮り直すので安全だが、frames を**呼ばずに**古い PNG を
Read すると編集前の絵を見てしまう罠がある)。これを踏まえ、`validate`(必ず
編集後に叩く)と `describe`(最初に見る)が現在の JSON と突き合わせ、
食い違えば「frames を撮り直せ」と警告する。`frames/index.json` が無い
(未撮影・機能導入前)フォルダでは警告しない。**`config.yaml` の変更
(caption サイズ等)はこの検出の対象外**(JSON 手編集の撮り直し漏れが対象
のため。config を変えたときは自分で撮り直す)。
