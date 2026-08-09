# FrameWright

撮影後の編集を自動化するローカルファーストな動画パイプライン。
収録1本 = 1フォルダ(例: `~/Movies/framewright/2026-07-02-xxx/`)で、その中の
JSON がプロジェクトの正のデータ。**このリポジトリで「動画を編集して」と
頼まれたら、コードではなく収録フォルダの JSON を編集する。**

> 機械可読・エージェント非依存の契約(編集可能ファイル一覧・JSON Schema・
> 承認境界・@id・コマンド一覧)は **`AGENTS_CONTRACT.md`**(リポジトリ直下・英語)を
> 正とする。本書(CLAUDE.md)は Claude Code 向けの日本語の運用ニュアンス
> (バックアップの復元手順・frames の陳腐化の罠など)を補足する。

## AI が動画を編集するときの決まり

- 編集 = 収録フォルダ内の `cutplan.json` / `transcript.json` / `overlays.json` /
  `bgm.json` / `chapters.json` / `meta.json` / `thumbnail.json`
  の編集。動画ファイル自体は触らない
- 旧 `shorts.json` は削除済み機能のデータで、FrameWright は読み書きも自動削除も
  しない。`validate` は移行警告を1件出すだけで成功する。縦動画は同じ収録の派生物
  ではなく、P1以降のキャンバスを使った独立した9:16プロジェクトとして作る
- **時刻はすべて「元収録(raw ファイル)の秒」**。カット後の時刻への換算は
  ツールが自動でやる。頭の中で引き算しないこと
- JSON を編集したら**必ず `node src/cli.ts validate <dir>` を実行**する。
  エラーが出たら直してから次へ進む(preview / render で数分かけて気づく
  壊れ方を数ミリ秒で検出できる)。`approved: true` なのに承認レコード
  (`approvals.json`)が無い/陳腐化しているときは警告(exit 0)で知らせる
- **`plan` と `run` は再実行禁止**(cutplan / chapters / meta と「章」トラックの
  テロップが LLM の生成物で上書きされ、手編集が消える)。明示的に頼まれた
  ときだけ、上書きされることを伝えてから実行する。生成物が既にあると
  `--force` なしではエラーで止まり、`--force` 時は実行前に手編集ファイルが
  `backups/<日時>/` へ退避される(誤って消えたら退避先から収録フォルダ直下へ
  コピーで復元)。**自分の判断で `--force` を付けない**。カットの手編集を
  保ったまま章立て・タイトル案・概要欄だけを作り直したいときは `plan` では
  なく `remeta`(cutplan は触らず、実行前に transcript / chapters / meta を
  `backups/` へ退避する)を使う
- **`cutplan.json` の `approved` を自分で true にしない**。承認は人間の仕事
  (preview か GUI エディタで確認してもらう)
- **承認の実体は `approved` という boolean ではなく `approvals.json`**
  (収録フォルダ直下の別ファイル。cutplan の keep 集合の sha256 ハッシュに
  束縛された承認レコード)。`render` はこのレコードの hash が現内容と一致する
  ときだけ通す**strict ゲート**で、`cutplan.approved: true` を書くだけでは
  render は通らない。承認後に keep(cut の内容)を編集すると hash 不一致で
  **自動失効**し、古い内容のまま render されることはない(reason・cut
  セグメント・境界維持のままの分割・overlays/transcript/bgm の編集は失効させ
  ない=承認スコープは cut 決定のみ)。承認・取消は専用コマンドで行う:
  `node src/cli.ts approve <dir>` / `unapprove <dir>`(`approve` は preview 確認前提の対話
  操作で、非対話環境では `--yes` が無いと拒否される=AI が「承認して」と
  頼まれても reflex では通らない)。**`approvals.json` は自分で書かない・
  直接編集しない**(cutplan.json 等の編集ワークフローにも中間生成物にも
  属さない第3カテゴリ。書けるのは `approve`/`unapprove` コマンドと GUI
  エディタの保存(チェックボックス)だけ)
- 中間生成物は編集しない(再実行で上書きされる): `manifest.json`(**`clean` では削除されない**。
  収録フォルダの中身だけからは復元できず、`ingest` の再実行は `--layout` を
  知らないと `screenRegion`/`cameraRegion` を失う) /
  `cuts.auto.json` / `plan.raw.txt` / `plan.loop.json`(plan --cuts-only の
  反復ログ。ループ有効時のみ) / `plan-materials.raw.txt`
  (plan-materials の LLM 生応答の記録。plan.raw.txt と同じ用途) /
  `plan-effects.raw.txt`(plan-effects の LLM 生応答の記録。plan.raw.txt と同じ用途) /
  `plan-bgm.raw.txt`(plan-bgm の LLM 生応答の記録。plan.raw.txt と同じ用途) /
  `render.props.json` / `whisper-out.*` /
  `transcript.system.json`(システム音声の知覚専用文字起こし=描画・編集しない。
  `whisper.systemAudio` 有効時のみ) / `whisper-system-out.json`(その whisper 生出力) /
  `cut.mp4` / `cut.m4a` / `cut.keeps.json`(cut.mp4/cut.m4a の再利用可否を判定するキャッシュキー。
  削除すれば常にフル再生成に戻る) / `render.key.json`(final.mp4 の再利用
  可否を判定するキャッシュキー。render.props.json・cut.mp4・参照素材ファイル・
  hardwareAcceleration 設定が前回と同じなら engine render を丸ごと省略する。
  削除すれば常にフル再生成に戻る) /
  `render.report.json`(直近の本編 `render()` の構造化サマリ。採用経路
  `full-skip`/`engine` + フォールバック理由・
  段階ごとの所要時間と成否・キャッシュヒット・
  実効 concurrency・入力スナップショットの sha256・出力プローブ・
  ok/failed を記録する。純ローカルの副産物で外部送信しない) / `preview.mp4` /
  `preview-cut.mp4` / `preview-cut.key.json`(レガシー。エディタの
  連続プレビュー用に keep を焼き込んだ動画とそのキャッシュキー。
  **FrameWright はもう作らない**が、既存収録に残っているので `clean` が
  回収する) / `proxy.mp4` / `proxy.m4a` /
  `proxy.key.json`(proxy.* の陳腐化を判定するキャッシュキー。ラウドネス・
  システム音声・プレビュー幅・エンコーダ・元収録ファイルが前回の生成と
  同じなら陳腐化なしと判定する。削除すれば陳腐化判定が効かなくなる=常に
  「陳腐化なし」扱い) / `frames/*.png` / `frames/props.json` /
  `frames/*.ocr.json`(`frames --ocr` が書く画面 OCR のサイドカー。
  `frames` 実行のたびに PNG と同様に全消しされる) /
  `frames/index.json`(`frames` が撮影のたびに書く、撮影入力(cutplan/
  transcript/overlays 等)の内容フィンガープリント。
  props.json と同じ扱いで全消し対象外。古さ判定に使う=次に編集 JSON を
  変えて `frames` を撮り直さないと、`validate`/`describe` が「frames が
  古い」と警告する) /
  `frames/.serve.json`(`frames-serve <dir>`(常駐フレームサーバ。opt-in)が
  起動中だけ書く `{port, pid}`。`frames` はこれを検出したらデーモンへ委譲し、
  無ければ従来どおりの単発実行。デーモン終了(Ctrl+C)で自動的に消える) /
  `render.design/`(`config.yaml` の `render.design.backgroundFile` に収録フォルダ外の
  絶対パスを書いたとき、書き出しページが読める publicDir(=収録フォルダ)配下へ
  取り込まれた背景画像のコピー。元ファイルからいつでも再取得されるので消してよい。
  `materials/`(人間の素材置き場)には置かない=背景は overlays から参照されないため
  `materials` コマンドに永久に「未使用素材」として計上されてしまう) /
  `render.fast/`(歴史的な名前。現在は design 静的資産
  `render.fast/design/<key>.<role>.png` の内容アドレス式キャッシュと、
  BGM/インサート音声ミックスの一時 PCM の置き場。正常終了時の一時 PCM は消える。
  design 資産は再生成が高価な重いキャッシュなので `--cache-only` の対象) /
  `hyperframe.<name>.key.json`(HyperFrames カード `hyperframes/<name>.html` の
  再利用可否を判定するキャッシュキー。仕組みは render.key.json と同じ
  (html の sha256・variables・width/height/fps/durationSec・codec・
  hardwareAcceleration が前回と同じなら `hyperframe <dir> --name <name>` の
  render(bundle+headless Chrome)を丸ごと省略し `materials/hyperframes/<name>.mp4`
  を再利用する)。削除すれば常にフル再生成に戻る。`hyperframes/<name>.html`
  (composition source。`hyperframe --from-brief` が LLM 下書きを書く、
  `hyperframe --embed-lottie` が人間持ち込み AE JSON を埋め込む、または
  人間が手で置く。編集ファイルではないが中間生成物でもない=`materials/` と
  同じ「他」カテゴリ)と `hyperframes/<name>.raw.txt`(`--from-brief` の LLM
  生応答の記録。plan.raw.txt と同じ用途。check ゲート不合格でも常に書かれる)
  もこの隣に置かれるが、これらは中間生成物ではなく触ってよい/触られる側の
  ファイル(`materials/hyperframes/<name>.mp4` は成果物=`final.mp4` と同格) /
  `materials.probe/`(`materials <dir>` が書く素材(B-roll)知覚の集約+
  キャッシュ。`index.json`=素材ごとの尺・解像度・音声有無・参照クロスリンク
  (未使用/dangling 判定)+ 素材ごとの mtime+size フィンガープリント・
  `<slug>.png`(`--frames`。動画の代表フレーム。画像は複製せず自身のパスを
  参照するので生成されない)・`<slug>.ocr.json`(`--ocr`。素材フレーム/画像の
  画面 OCR。box は素材自身のピクセル座標=本編 screenRegion 出力px とは別
  座標系)・`<slug>.transcribe.json`(`--transcribe`。音声付き素材の文字
  起こし)。`frames/` と違い実行のたびの全消しはされない差分更新型の
  キャッシュ。`materials/`(人間の素材
  置き場)とは別名の生成ディレクトリなので混同しないこと) /
  `av.probe/`(`av <dir>` が書く A/V 知覚の集約+キャッシュ。
  `motion.json` / `sound.json` / `motion.strip.png`。`materials.probe/` と
  同じく実行のたびの全消しはしない差分更新型で、同じ入力 key なら前回結果を
  再利用する) /
  `timeline.probe/`(GUI エディタが書くタイムライン用の差分更新型キャッシュ。
  `waveform.json` + `waveform/*.bin`、`thumbstrip.json` + `thumbstrip/*.webp` / `*.jpg`。
  編集データではなく、削除しても次回エディタ表示で再生成される) /
  `material-fit.suggested.json`(`material-fit <dir>` が書く使い捨ての下書き。
  次回実行で黙って上書きされる。`rules.suggested.md` と同カテゴリだが中身は
  `apply --patch` にそのまま食わせられる ops 形式。**自分で `apply` しない**
  =適用は人間が確認して `apply --patch material-fit.suggested.json` を叩く) /
  `effect-check.json`(`effect-check <dir>` が書く演出の検品結果。zoom×固定px
  演出の相互作用・密度ガード・caption/素材との座標重なりの警告一覧+撮った
  still のパス+VLM 実行有無を機械可読で記録) /
  `effect-fix.suggested.json`(`effect-check <dir>` が警告に補正候補があるとき
  だけ書く使い捨ての下書き。`material-fit.suggested.json` と同じ位置づけで
  `apply --patch` にそのまま食わせられる ops 形式。**自分で `apply` しない**
  =適用は人間が確認して `apply --patch effect-fix.suggested.json` を叩く) /
  `bgm-fit.json`(`bgm-fit <dir>` が書く BGM 補正の検出結果。発話被り/無音浮き/
  大音量/フェード無しの findings + 単調/fallback 判定を機械可読で記録) /
  `bgm-fit.suggested.json`(`bgm-fit <dir>` が補正候補があるときだけ書く
  使い捨ての下書き。`material-fit.suggested.json` と同じ位置づけで
  `apply --patch` にそのまま食わせられる ops 形式。**自分で `apply` しない**
  =適用は人間が確認して `apply --patch bgm-fit.suggested.json` を叩く) /
  `style.probe/`(`style-profile` が書くスタイルプロファイル集約。収録
  フォルダ直下ではなく **channel 直下**(最初の `--from` の親ディレクトリ)に
  `<name>.json` を書く点が他の `*.probe/` と異なる。実行のたびに丸ごと
  再計算・上書きされる=差分更新型キャッシュではない) /
  `style-check.json`(`style-check <dir>` が書く、候補の編集が style profile の
  学習分散帯からどれだけ逸脱しているかの検出結果。cut/caption/audio の
  metric ごとに observed/expected/band/confidence/severity を機械可読で記録。
  warn/info のみで fail は無い) /
  `hyperframe-place.suggested.json`(`hyperframe-place <dir>` が書く使い捨ての
  下書き。`material-fit.suggested.json` と同じ位置づけで `apply --patch` に
  そのまま食わせられる ops 形式(`overlays.overlays` または
  `overlays.inserts` への `add` 1件)。**自分で `apply` しない**=適用は
  人間が確認して `apply --patch hyperframe-place.suggested.json` を叩く)。
  `plan.first.json`(`plan` / `plan --cuts-only` が最初の cuts/keeps 応答を
  パースした直後に書く、AI 初版判断の **write-once** 記録。**既に存在すれば
  `--force` 実行時でも一切上書きしない**(「AI の最初の判断」という定義その
  ものを壊さないため)。候補 id に加え元収録の秒(`start`/`end`)を併記する
  ので、`detect` の再実行や `candidates` 設定変更で候補番号が変わっても
  最終 `cutplan.json` と元秒で突き合わせられる。測定専用の副産物で
  `render`/承認 hash には一切影響しない。「重いキャッシュ」でも「安全に
  消せるログ」でもない(再生成不可能=1度しか生まれない)ので
  `clean --cache-only` にも `--logs-only` にも含まれず、フル `clean` を
  実行したときだけ削除される(このコマンドの出力メッセージでは明示されない
  ため、ここに明記する)) /
  `hyperframe.probe/`(`hyperframe-check <dir> --name <name>` が書く render
  不要な動的監査の集約。`<name>/index.json` にカードごとの findings(dead
  zone/終端未完了/画面外終端/seek無反応/一斉登場。決定論のみ・warn/info
  のみ)を記録する。`materials.probe/` と同じ差分更新型キャッシュ(実行の
  たびの全消しはされない。ディレクトリごと削除すれば常にフル再監査に戻る)。
  still 抽出・VLM 二次確認は将来のコミットで追加予定(現状はスタブ)) /
  `hyperframe-freeze.suggested/`(`hyperframe-freeze <dir> --name <name>` が書く
  使い捨ての DRAFT。`<name>.html`(check 済みの `hyperframes/<name>.html` を
  skeletonize したコピー。string 型の `data-composition-variables` の
  default だけをラベル(空なら "Text")へリセットし、color/number/レイアウト/
  モーションはそのまま保つ)+ `<name>.md`(用途1行の空欄+採用コマンド+
  根拠(overlays 参照済み/render 済み/監査 warn 件数))。
  `material-fit.suggested.json` と同じ使い捨て下書きパターンだがディレクトリ。
  実行のたびに黙って上書きされる。**「重いキャッシュ」ではない**ので
  `--cache-only` では残り、`--logs-only`(`frames/` と同じ)では消える。
  channel の `hyperframe-seeds/` への実採用は人間の仕事(下記参照。FrameWright は
  そこへは一切書かない)) /
  `backups/`(上書き前の退避)と
  `.editor-draft.json`(GUI の未保存編集の自動退避)も触らない。
  `thumbnail.png` は中間生成物ではなく成果物(`final.mp4` と同格。
  `thumbnail.json` を編集したら `thumbnail` コマンドで作り直す)。
  `rules.suggested.md`(`learn` が書く下書き。使い捨てで次回の `learn` で
  黙って上書きされる。採用したい項目は人間が読んで手で `rules.md` に転記する。
  `learn` はこのファイルにしか書かず、channel の `rules.md` を自分で
  書き換えることは絶対にしない)も編集・削除以外では触らない。
  `.remotion/`(レガシー。旧 Remotion 経路が収録フォルダへ落とした
  headless Chrome 本体の残骸。FrameWright はもう作らないが、既存収録に残っている
  ので `clean` が回収する)も中間生成物。
  これらの中間生成物・キャッシュはまとめて `node src/cli.ts clean <dir>` で安全に削除できる
   (削除は files.ts の generated 分類だけが対象で、編集ファイル・approvals.json は触れない。
   **`manifest.json` は `clean` の保護対象でフルでも削除されない**)。
  **唯一の例外が「元収録の自動リマックス複製」**: OBS は既定で `.mkv` に録画し、停止後に
  同じ内容を `.mp4` へストリームコピーした複製を隣に残すが、FrameWright が読むのは
  `manifest.json` の `source` が指す1本だけなので、もう一方は収録フォルダ内で最大級の
  純粋な重複になる。`clean` はこれを名前ではなく**実行時の内容照合**(manifest の source が
  `.mp4` 以外で実在する・候補の `fileRole` が other・ffprobe で codec/解像度/fps/音声が
  完全一致し尺差1秒以内・サイズ差が5%以内または1MB以内)で確認したうえで削除する。
  1つでも欠ければ残し、理由を警告に出す(判定は `src/lib/remuxDup.ts` が正)。
- GUI エディタ(`npm run editor`)が起動中でも JSON を直接編集してよい。
  保存された変更はホットリロードで GUI に自動反映される(人間側に未保存の
  編集がある場合は GUI にバナーが出る)。同じ区間・フィールドを双方が触った
  ときは、GUI の「差分をレビュー」から自分の版/ディスク版を hunk 単位で
  選べる。衝突しない外部変更は GUI 側の未保存編集を残したまま自動マージされる

### 権限設定(推奨・任意)

上記の運用ルールは FrameWright のコード(承認 hash・非対話拒否)がある程度まで
強制するが、**AI に無制限の Write/Bash 権限がある限り、意図的な偽装(hash も
自分で計算して approvals.json に書く・`approve --yes` を強行する)は
コードでは塞げない**。これを塞ぐ唯一の層は Claude Code の権限設定
(`.claude/settings.json` 等)。分類は `src/lib/files.ts` が単一の出所
(`EDITABLE_FILES` / `GENERATED_FILES` / `APPROVAL_FILE` / `fileRole`)。
このリポジトリで承認を人間だけの行為にしたい場合、収録フォルダ配下に
次のような deny ルールを足すと「cut は編集させるが承認は書かせない」を
表現できる(このルールを入れて初めて AI は物理的に承認レコードを書けなく
なる。入れなければ偶発事故は塞がるが意図的なバイパスは残る):

```jsonc
{
  "permissions": {
    "deny": [
      // 承認レコード(第3カテゴリ)。approve/unapprove コマンド・GUI 保存
      // だけが書く。cutplan.json 等の通常編集は引き続き許可される
      "Write(**/approvals.json)",
      "Edit(**/approvals.json)",
      // 承認コマンド自体も封じたい場合(Bash 経由の FrameWright CLI 実行を想定)
      "Bash(node src/cli.ts approve*)",
      // 中間生成物・キャッシュ(手編集されても再生成されるだけで実害は薄いが、
      // 誤書込みで無駄な陳腐化判定を招くことがある)
      "Write(**/manifest.json)",
      "Write(**/cuts.auto.json)",
      "Write(**/*.key.json)",
      "Write(**/cut*.mp4)",
      "Write(**/frames/**)",
      "Write(**/materials.probe/**)",
      "Write(**/av.probe/**)"
    ]
  }
}
```

上のリストは網羅ではなく例。厳密な一覧が欲しいときは
`src/lib/files.ts` の `GENERATED_FILES` + `APPROVAL_FILE` を参照する
(このファイルが変わればここも追随させる)。

## 動画の中身を知る方法(AI の知覚)

- `transcript.json` … 何をいつ喋っているか(全文・秒付き)。内容の把握と
  「◯◯と言っているあたり」の時刻特定はこれを読む
- `transcript.system.json` … システム音声(デモ音・再生動画・TTS)の発話。
  `config.yaml` の `whisper.systemAudio: true` のときだけ生成される**知覚専用**の
  文字起こし(描画・編集・`@id`/承認の対象外)。マイク=あなた / system=アプリ、
  というトラック起源の話者帰属で、`describe`(`[システム音声]` / `--json` の
  `systemAudio`)と plan(`plan.perception.systemSpeech`)から読める。音響的な
  話者分離ではない(詳細は docs/usage.md)
- `cutplan.json` … どこが残っていてどこが切られたか(`reason` 付き)。
  keep 内に残った無音(間)の位置は `describe.pauses: true` で `describe` に出せる
- `manifest.json` … 収録の長さ・解像度(読み取り専用)
- `node src/cli.ts describe <dir>` … タイムラインの要約(keep/カットの並び・
  各区間の発言・カット理由・演出・章を、元秒⇔出力秒の対応付きで)。。JSON を全部読むよりこれを先に見る
  - **発言・タイトルを一切切り捨てずに機械的に処理したいときは `--json` を
    付ける**(例: `describe <dir> --json`)。散文(既定)は発言36字切り捨て・
    タイトル先頭3件のみだが、`--json` は編集状態から完全復元できる JSON
    (`schemaVersion` / `source` / `summary` / `keeps` / `cuts`(消える発言も
    全文)/ `captions`(全文・`pos`/`style`/`words`・元秒⇔出力秒)/
    `overlays`(素材・挿入・ワイプ・ズーム・ぼかし・色調整の全フィールド)/
    `chapters` / `meta`(タイトル全件・概要欄全文)/ `bgm`)を
    stdout に純 JSON で出す(パイプ/`JSON.parse` 可能。所要時間の診断行は
    stderr へ逃げる)。`--json` を付けない限り既存の `describe` 挙動は
    完全に不変
- `node src/cli.ts frames <dir> --t 90,2:30.5` … 指定時刻のフレームを
  **最終合成と同じ見た目**(クロップ+ワイプ+テロップ+素材)で
  `<dir>/frames/*.png` に出力。Read で画像を見て、テロップ位置・ワイプ被り・
  素材の見え方を自己確認する。時刻は元収録の秒(カット内なら直後の keep へ
  自動スナップ)。`--out` を付けるとカット後の秒として解釈
  - 一巡監査は時刻リストを自作せず専用モードを使う: `--captions` で
    テロップ全件(各テロップの表示中間で1枚。どのテロップかはコマンド
    出力に付く)、`--every 10` でカット後タイムラインを10秒間隔+最終
    フレームでサンプリング
  - 実行のたびに `frames/` 内の古い PNG は全削除される。逆に言うと、
    JSON 編集後に frames を撮り直さず古い PNG を Read すると編集前の絵を
    見ることになるので、編集したら必ず撮り直す。これはコードでも検出される:
    `frames` は撮影した cutplan/transcript/overlaysの内容フィンガープリントを `frames/index.json`
    に記録し、その後 `validate`/`describe` を実行したときに現在の JSON と
    食い違っていれば「frames を撮り直せ」と警告する(`frames/index.json` が
    無い=未撮影のときは警告しない)。ただし `config.yaml` の変更(caption
    サイズ等)はこの検出の対象外なので、config を変えたときは自分で撮り直す
  - ベース映像はプロキシ(幅は config.yaml の preview.width。既定 2560px=
    画面領域 1280px 相当)のアップスケールなので、テロップの
    位置・被り・レイアウト確認には十分だが、**画面キャプチャ内の細かい
    文字の可読性はこの画像では判断できない**(ぼやけていても最終出力では
    読める。可読性の最終判断は人間が preview / render で行う)
  - **画面キャプチャ内の文字を絵として鮮明に見たいときは `--full-res` を
    付ける**(例: `frames <dir> --t 90 --full-res`)。ベース映像をプロキシ
    ではなく元収録のフル解像度にした**合成込み**(テロップ/ワイプ/素材/
    ズーム/ぼかし込み)still を出す。`--ocr`(下記)がテキスト抽出なのに
    対し、こちらは見た目そのものを鮮明にする用途(レイアウト込みで細かい
    文字を目視したいとき)。`--full-res` を付けない限り従来どおりプロキシ
    経路で、既存の `frames` 挙動は完全に不変。`--ocr` と併用可
  - **画面内のコード・ターミナル・エラー文をテキストとして読みたいときは
    `--ocr` を付ける**(例: `frames <dir> --t 90 --ocr` /
    `frames <dir> --every 10 --ocr`)。元収録のフル解像度で画面領域だけを
    ffmpeg クロップし、Apple Vision(macOS 専用・オフライン)で OCR して
    `frames/out<秒>s.ocr.json` に書く(`text`=読み順の全文、`lines[]`=
    `text`/`confidence`/`box`。`box` は caption の `pos`・`blurs.rect` と同じ
    出力px座標系で表現される)。stdout にも先頭数行を要約表示するので、まず
    それを読めば足りることが多い。その時刻が挿入クリップ(`overlays.inserts`)
    内で画面の生映像が無い場合は自動でスキップされ(`.ocr.json` は書かれない)、
    非対応環境(macOS 以外等)では警告のうえ PNG 出力だけ続行する。
    `--ocr` を付けない限り一切実行されず、既存の `frames` 挙動は完全に不変
- `node src/cli.ts materials <dir>` … **素材(B-roll)の中身**(尺・解像度・
  fps・音声有無)を知る知覚コマンド。`materials/` 配下の実在ファイル ∪
  `overlays.json`(`overlays[].file` / `inserts[].file`)・`bgm.json`
  (`tracks[].file`)の参照集合を突き合わせ、**参照されているのに
  `materials/` に無い(dangling)**・**`materials/` にあるのに一度も
  参照されていない(未使用)**を検出する。既定は ffprobe だけ(重い処理
  なし)で、結果は `materials.probe/index.json` に書きつつ stdout にも
  1行要約を出す。素材の実尺と `inserts[].durationSec`(編集者が書いた
  想定尺)の乖離が見えるので、**尺超過に気づけない**問題はこれで解ける
  - **見た目を見たいときは `--frames`**(動画は尺の中点1枚を
    `materials.probe/<slug>.png` に抽出。画像は複製せず自身のパスを記録)
  - **素材内の画面文字(スライドの文言・コード等)を読みたいときは
    `--ocr`**(動画に対しては `--frames` を含意。box は**素材フレーム自身の
    ピクセル座標**で、`frames --ocr` の本編 screenRegion 出力px とは別の
    座標系なので混同しないこと)
  - **素材の音声発話を文字として読みたいときは `--transcribe`**
    (音声付き素材だけ。whisper モデルが無ければその素材だけ警告して
    スキップ)。`--all` で3つ全部
  - opt-in 層は素材ごとの mtime+size フィンガープリントでキャッシュされる
    (`materials.probe/` は `frames/` と違い実行のたびの全消しはされない
    差分更新型。不変素材は再取得せず前回の結果を再利用する)
  - `materials/` 自体は編集ファイルでも中間生成物でもない人間の素材置き場
    (`fileRole` は `"other"`)。生成物は別名の `materials.probe/` に集約
    される(混同しないこと)
- `node src/cli.ts material-fit <dir>` … **素材参照の不整合を検出し、修正案を
  `apply` パッチ下書きとして出す**コマンド。要 `materials <dir>` の事前実行
  (`materials.probe/index.json` が無ければ告知して exit 1)。overlays/inserts
  に `@id` が1つも無ければ「先に `id-stamp`」を告げて exit 1。検出対象:
  素材の実尺(`probe.durationSec`)と overlay(`end - start`)/insert
  (`durationSec`)の宣言尺の食い違い(尺超過=末尾フレームで停止・尺不足=
  素材の大半が未使用)、`used:true, present:false`(dangling。参照先が
  `materials/` に無い。実在・未使用ファイルへの貼り替え候補を名前類似で提示)、
  `used:false, present:true`(unused。`plan-materials` へ誘導)。**収録
  フォルダの編集ファイルは1バイトも書かない**(出力は `material-fit.suggested.json`
  という使い捨てのパッチ下書きと stdout レポートだけ。適用は人間が
  `apply --patch material-fit.suggested.json` で行う)。補正値はすべて実尺
  からの算術(LLM 生成値ではない)
- `node src/cli.ts effect-check <dir>` … **演出(zoom/blur/annotation)を
  検品する**コマンド(`plan-effects` が作る側、こちらは検品する側)。決定論
  チェック(常に成功): zoom と blur/annotation(出力px固定・zoom非追従)の
  時間重なりから「rect を zoom 領域へ広げる/zoom 終端の後ろへずらす」補正
  候補を出す(E4)、演出密度が窓(既定5秒・3本)を超えたり annotation の
  表示尺が長すぎると警告する(E5)、テロップ(`pos` 明示のみ)と
  blur/annotation/素材 rect の座標重なりを検出する(E3 の決定論一次判定)。
  still 撮影は既存 `frames` 経路を再利用。任意で VLM(`ai.routes.vision`)に
  after still を見せ「目的(隠す/指す/見せる)を満たすか」を yes/no+理由で
  問う(**座標は生成させない。判定専用**)。vision route が無い/`--no-vlm`/
  呼び出し失敗はすべて「VLM 未実行(決定論のみ)」で優雅に劣化し、決定論
  レポートは exit 0 で返る。**収録フォルダの編集ファイルは1バイトも書かない**
  (出力は検品結果 `effect-check.json` + 補正候補があるときだけの
  `effect-fix.suggested.json` というパッチ下書き。適用は人間が
  `apply --patch effect-fix.suggested.json` で行う)。`cutplan.json` /
  `approvals.json` は読まない・書かない
- `node src/cli.ts av <dir>` … **keep 後タイムラインの動き+音**を知る知覚
  コマンド。既定は motion/sound の両方を取り、`av.probe/motion.json` /
  `av.probe/sound.json` / `av.probe/motion.strip.png` を書く
  - **motion**: keep 後タイムラインを時系列に連結した基映像を対象に、
    フィルムストリップ PNG、タイル時刻、scene score、freeze 区間を出す。
    既定は `proxy.mp4`、`--full-res` で元収録を使う
  - **sound**: keep 後の mic+system 音声ベッドを対象に、統合 LUFS・
    short-term LUFS 包絡・true peak・無音区間・mic/system の RMS 被りを出す。
    BGM と duck は render props から**解析的に**併記する
  - `--range <a-b>` は**出力(カット後)秒**、`--every <sec>` は motion の
    サンプル間隔。
    `--motion-only` / `--sound-only` で片側だけにもできる
  - `av.probe/` は `materials.probe/` と同じ差分更新型キャッシュ。keep 集合・
    range・設定が同じなら ffmpeg を再実行せず前回 JSON を再利用する
- `node src/cli.ts bgm-fit <dir>` … **既存の `bgm.json` の音量/duck/フェードを
  実測から補正する**コマンド(`plan-bgm` が BGM を**作る**側、こちらは**直す**側)。
  要 `av <dir>` の事前実行(`av.probe/sound.json` が無ければ告知して exit 1)。
  決定論チェック(常に成功。LLM 不使用): 発話に BGM が被っている区間
  (`av.probe/sound.json` の `tracks.samples`)→ 発話 RMS を
  `bgmFit.speechHeadroomDb` 下回るよう `volumeDb` を下げる補正、無音区間
  (`silences`)に BGM が原音量で浮いている→ `bgmFit.silenceDuckDb` 下げる補正、
  全体ラウドネス(`mix.integratedLufs`)が `bgmFit.targetLufs` を超過→ 全体
  `volumeDb` 減の補正、動画終端まで続くのに `fadeOutSec` が無い→ 付与の補正。
  `av` の `bgm.duckSpans` で既に下がっている区間は二重に下げない。加えて
  「章が複数あるのに BGM が単一ファイルで全編を覆っている/`bgm.json` が無く
  収録直下 `bgm.*` の fallback のまま」を検出し `plan-bgm` へ誘導する(区間割り・
  選曲はしない=そちらの責務)。id-stamp は **B2 補正が実際に出るときだけ**
  必要(id の無いトラックに volumeDb/fadeOutSec の補正候補が出る場合に限り
  「先に `id-stamp <dir>`」と告げて exit 1)。B4 の単調誘導だけ・検出なしの
  ときは id 不要で通し exit 0(plan-bgm の出力は id 無しなので、これで通常鎖
  plan-bgm → av → bgm-fit が止まらない)。**収録フォルダの編集ファイルは1バイトも
  書かない**(出力は検出結果 `bgm-fit.json` + 補正候補があるときだけの
  `bgm-fit.suggested.json` というパッチ下書き。適用は人間が
  `apply --patch bgm-fit.suggested.json` で行う)。render の duck 実装
  (`src/lib/duck.ts`)には触らない。`cutplan.json` / `approvals.json` は
  読まない・書かない
- `node src/cli.ts style-check <dir>` … **この収録の現在の編集(候補)が
  `style-profile` の学習分散帯からどれだけ逸脱しているかを測る**知覚コマンド
  (プロファイル導入で審美眼の J(主観)次元の一部が D(決定論)へ落ちる、
  その測定面。`style-profile` が的=プロファイルを**作る**側、こちらは
  既存の編集をそこへ**照らす**側)。要 `style-profile --from <dir>` の事前実行
  (channel 直下 `style.probe/<名前>.json` が無ければ「先に実行」と告げて
  exit 1)。候補は `describeJson` の射影を `style-profile` と同じ集約経路
  (`observeOwnProject` → `mergeObservations`)に通して同じ形へ畳んでから、
  cut(ショット長・シーンチェンジ頻度)/caption(coverage・表示秒・密度・
  位置)/audio(LUFS・true peak・無音比率・BGM 有無)の距離を測る(v1 は
  この3 section に閉じる。演出密度・BGM 切替 cadence・構成は profile v2
  待ちで対象外)。参照 section の `confidence` で許容帯を広げる二層帯
  (inner/outer)により、cold-start(N=1)の低 confidence でも桁違いの逸脱
  だけが warn になり軽微な差は info(borderline)に収まる。**逸脱は不正
  ではなく学習帯からのズレ**という位置づけで**常に exit 0**(前提エラー=
  profile 不在のときだけ exit 1)。**収録フォルダの編集ファイルは1バイトも
  書かない**(出力は検出結果 `style-check.json` のみ)
- ここまでは AI(操作者)が動画を知覚する手段。**カット判断 LLM 自身**
  (`plan` / `plan --cuts-only` / `remeta`)にも、`config.yaml` の
  `plan.perception`(既定オフ。書かない限り LLM 入力はこの機能導入前と
  バイト等価)で音特徴(無音・間。`audio: true`。決定論・追加依存なし)と
  画面 OCR(区間代表フレームを自前 Vision OCR。`ocr: true`。macOS 依存・
  非対応環境は警告のうえ自動で劣化)を添えられる。詳細は docs/usage.md
  「plan の知覚(config.yaml の plan.perception)」参照
- 同じく `plan` / `plan --cuts-only` には、`config.yaml` の
  `plan.styleProfile`(既定オフ。書かない限り LLM 入力・`plan.raw.txt` は
  この機能導入前とバイト等価)で `style-profile` が抽出した style profile
  (`style.probe/<name>.json`)を**候補選択のソフトな prior**として添えられる
  (目標ショット長・積極度/字幕密度・位置/冒頭フック・CTA 有無の3面だけ。
  raw JSON や精密な数値・タイムスタンプは書かせない=番号選択方式は不変)。
  brief.md(今回の意図)に劣後する参考情報として最後尾に置かれ、profile が
  見つからない/壊れているときは警告のうえ注入をスキップするだけで `plan` は
  止まらない。**v1 は cut 判断(`plan`/`plan --cuts-only`)だけが対象**
  (`remeta`・`plan-materials`・`plan-effects`・`plan-bgm`
  には注入しない)。詳細は docs/usage.md「plan のスタイル注入
  (config.yaml の plan.styleProfile)」参照
- 編集の基本ループ: JSON 編集 → `validate` → `describe` か `frames` で
  自己確認 → 人間には `preview` かエディタ(ホットリロード)で見てもらう
- **JSON を Write/Edit で丸ごと書き換える代わりに、`apply <dir>` で当てると
  検査(validate と同じ)が書き込み前に効く**(壊れた JSON・不変条件違反を
  書いてしまう前に止まる。全部 valid なら全書き込み、1つでもエラーなら
  1バイトも書かない)。`@id`(`describe --json` / `id-stamp` で確認)を宛先に
  した高水準オペレーション列(`set`/`remove`/`add`)を第一級の入力とし、
  配列添字を書かずに編集を当てられる。`--dry-run` で書かずに変更要約だけ
  確認できる。**`approved` は apply では変更できない**(cutplan の
  承認意図を変えたいときは `approve <dir>` / `unapprove <dir>` を使う。
  apply は `approvals.json` に一切触れない)。詳細は `docs/usage.md`
  「検査付きアトミック適用(apply)」参照
- **`frames --t ...` を何度も撮り直すループ(JSON 微調整の自己確認)を
  何度も回すときは `frames-serve <dir>` を先に起動しておく**(opt-in の
  常駐デーモン。bundle+headless Chrome を暖めたまま待ち受け、`frames` が
  自動検出して使う。起動していなければ `frames` は従来どおりの単発実行で
  挙動・出力は不変)。詳細は `docs/usage.md`「frames-serve(常駐フレーム
  サーバ)」参照。異常時は Ctrl+C で再起動すれば復旧する

## どのファイルが何を決めるか

| ファイル | 決めるもの |
|---|---|
| `cutplan.json` | どこを残すか。`segments[]` の `action: "keep" / "cut"`。keep は時系列順・重なり禁止 |
| `transcript.json` | テロップの文言・表示時間。`track`(トラック番号)、`pos`(`{x,y}` 出力px)、`style`(`{fontSizePx, color, outlineColor, outlineWidthPx, fontFamily, fontWeight, background, anim, karaoke}`。`outlineColor: "none"` で縁なし、`outlineWidthPx` は縁取りの太さ=出力px(省略時はフォントサイズの0.25倍)、`fontWeight` の中間ウェイトは同梱の Noto Sans JP 可変フォントで描き分ける、`background` は座布団 `{color, paddingPx?, radiusPx?}` または `"none"`。
**省略は「帯なし」ではなく「指定なし=下の層から継承」**(下=トラック標準
`captionTracks[].style` → `config.yaml` の `render.captionBackground`)。
継承した帯をこの層で消すには、キーを消すのではなく `"none"` を書く
(`outlineColor: "none"` と同じ流儀)。「テロップ」と「章」でデザインを
分けたいときは**トラック標準**(`overlays.json` の `captionTracks[].style`)で
表現する。詳細は docs/usage.md「テロップのデザインは3層」参照。`anim` は登場/退場アニメ `{in?, out?, durationSec?}`(種別: `fade`/`slide-up`/`slide-down`/`slide-left`/`slide-right`/`pop`/`none`。省略時アニメ無し)。`karaoke` はカラオケ表示 `{activeColor?, inactiveColor?, inactiveOpacity?, mode?}`(`mode` は `word`(既定)/`fill`。`words[]` を消費し、無ければ通常表示にフォールバック)は省略可で個別上書き。`words`(語/トークン単位のタイミング。whisper `-ojf` 由来、`config.yaml` の `whisper.wordTimestamps: true` のときだけ付く。省略可・**`style.karaoke` が消費する描画専用の補助データで text/start/end が常に正**。人間が text を手編集しても words は追随しない) |
| `overlays.json` | 演出。`overlays`(素材の表示。全画面または `rect` `{x,y,w,h}` で部分配置。`startFrom` 頭出し・`volume` 音量(省略時 0=無音)・`opacity`・`fadeInSec`/`fadeOutSec`)/ `inserts`(インサート編集。`volume`(省略時 1)・フェード付き)/ `wipeFull`(ワイプ全画面。入り/戻りは `transitionInSec`/`transitionOutSec` で独立指定でき、省略時は config の `render.wipeTransitionSec` で遷移。旧 `transitionSec` は両方向のフォールバック)/ `zooms`(ズーム。画面の一部(`rect` `{x,y,w,h}`)を全画面へ拡大。倍率は書かず `rect` から一意に決まる。区間は重ならないこと。出入りは `easeSec`(省略時 config の `render.zoom.easeSec`)で遷移。隣の区間と隙間なく接する(`end` = 次の `start`)と連鎖になり、境界で等倍へ戻らず次の `rect` へ直接パンする(次区間の `easeSec` がパンの遷移時間)。かかるのは背景(design の背景画像)+画面パネルの合成面全体で、ワイプ・テロップ・素材・blur/annotation/text は不動)/ `blurs`(領域ぼかし。秘匿情報の目隠し。`rect`(出力px)/ `strength`(0〜1、省略時0.5。0=効果なし)。かかるのは下層(ベース映像+挿入)だけ・テロップ/素材はぼかしの上に出る。rect は zoom に追従せず出力px固定(zoom と時間が重なると警告)。)/ `annotations`(注釈グラフィック。矢印(`arrow`: `from`/`to`)・囲み(`box`: `rect`)・スポットライト(`spotlight`: `rect`)で「ここを見ろ」を示す。独立レイヤーで最前面(テロップより上)。zoom には追従せず出力px固定(blurs と違い zoom 重なりは警告しない)。遷移の無い硬い ON/OFF。)/ `texts`(タイトル・ラベルなど発話に由来しない動画内テキスト。transcript と違い再 transcribe で消えず、describe/plan から発話として読まれない。`pos` 必須、CaptionStyle 共有、`style.karaoke` は無視)/ `layerOrder`(重なり順。`text` を明示可。省略時 texts はレイヤースタックの上・注釈より下)/ `captionTracks`(テロップトラックの標準位置・スタイル)/ `hideCaption` / `colorFilter`(全編一律の簡易カラー調整。`{brightness?, contrast?, saturate?}`。各キー省略可・既定 1.0。かかるのはベース映像(画面クロップ+カメラ)だけで、素材・挿入には効かない。縦プロファイルにも適用される) |
| `bgm.json` | BGM の区間配置。`tracks[]` の `{start, end, file}`(時系列でなくてよい・重ねてよい)。覆っていない区間は無音、別 `file` の区間で曲の切り替え。`volumeDb`(省略時 config 既定)・`startFrom` 頭出し・`fadeInSec`/`fadeOutSec` は省略可。無ければ収録フォルダ直下の `bgm.*` を全編1曲で流す(後方互換) |
| `chapters.json` | YouTube 概要欄チャプター(`start` / `title`)。動画には描画されない |
| `meta.json` | タイトル案・概要欄の下書き。動画に影響なし |
| `approvals.json` | **承認レコード**(cutplan)。`render` の唯一のゲート: keep 集合の sha256 ハッシュに束縛され、内容が変わると自動失効する。`node src/cli.ts approve` / `unapprove` コマンドと GUI エディタの保存だけが書く**第3カテゴリ**(編集ファイルにも中間生成物にも属さない)。**AI は直接編集・作成しない** |
| `thumbnail.json` | サムネイル静止画(`thumbnail.png`)の元データ。`{t, texts[]}`。`t`(元収録の秒)は frames と違いスナップしない(カットされた瞬間も指定できる)。`texts[]` は `{text, pos: {x,y}, style?}`(`style` は transcript のテロップと同じ `CaptionStyle` を共有)。`overlays.json` の `wipeFull` / `zooms` / `colorFilter` は本編と同じに乗る |
| `rules.md` | チャンネルの恒久ルール(自由 Markdown。テロップ様式・トーン/声色・禁止語・ペーシング・章の付け方・タイトルの型)。収録フォルダの**親ディレクトリ**に置くとチャンネル共通、**収録フォルダ直下**に置くとこの収録だけの上書き/追加(両方あれば連結・収録固有が優先)。`plan`/`plan --cuts-only`/`remeta`/`plan-materials`/`plan-effects`/`plan-bgm` のプロンプトに注入される。`brief.md`(今回の見せ場・中身)とは役割が別:brief=「今回の中身」、rules=「毎回守る型」 |

素材ファイル(B-roll 等)は収録フォルダの `materials/` に置き、相対パスで
参照する。BGM は `bgm.json` で区間ごとに配置(素材と同じく `materials/` の
別ファイルも参照できる)。`bgm.json` が無ければ収録フォルダ直下の `bgm.mp3`
(または bgm.m4a / bgm.wav)を全編1曲で流す。

`hyperframe-seeds/`(人間が手で管理するチャンネル共通の置き場。`rules.md` と
同じく収録フォルダの**親ディレクトリ**(channel 直下)に置く。中身は
`<name>.html`(凍結カード。`hyperframe-freeze` の DRAFT を人間が確認して
コピーしたもの)+ 任意の `<name>.md`(用途1行の gloss))は中間生成物でも
編集ファイルでもない「他」カテゴリ(`materials/` と同格。FrameWright はここへは
一切書かない)。存在すると `hyperframe --name <name> --from-brief` が
`checkComposition` 0 エラーの凍結カードだけを番号メニュー末尾(既存パターン
番号の続き。check に落ちる凍結カードは警告のうえスキップ・番号は詰める)へ
追加で連結する。存在しない/1件も通らないときはメニューは従来とバイト等価。

## コマンド

入口は2つあり同じコードに落ちる: `node src/cli.ts <cmd>`(リンク不要。**AI は
常にこちらを使う**=どの環境でも動く)と `framewright <cmd>`(`npm link` 済みの
人間向け)。人間が `framewright …` と書いてきたら同じコマンドを指している。

以下はよく使うものの抜粋。**全コマンドは `node src/cli.ts commands`**(分類つき
一覧。出所は `src/lib/cliHelp.ts`)、個別の全オプションは
`node src/cli.ts <cmd> --help`、「いつ使うか」は
`docs/guides/command-reference.md` を見る(`--help` 単体は基本の流れだけの
短い案内で、全コマンドは出ない)。

```sh
node src/cli.ts doctor            # 環境プリフライト(read-only)。node/ffmpeg/ffprobe/エンコーダ/whisper/AI到達性を検査
node src/cli.ts validate <dir>    # JSON 編集後は必ず(エラーで exit 1)
node src/cli.ts apply <dir> --patch edit.json  # @id 指定の編集を検査付きで当てる(全部valid→全書込 / 1つでもエラー→ゼロ書込)
node src/cli.ts apply <dir> --patch edit.json --dry-run  # 検査・変更要約だけ(書かない)
node src/cli.ts describe <dir>    # タイムライン要約(元秒⇔出力秒の対応付き)
node src/cli.ts describe <dir> --json  # 機械可読な完全射影(発言・タイトルを切り捨てない純 JSON)
node src/cli.ts frames <dir> --t <times>  # 指定時刻を最終合成の見た目で PNG に
node src/cli.ts frames <dir> --captions   # テロップ全件を一巡監査(1件1枚)
node src/cli.ts frames <dir> --every 10   # カット後全体を10秒間隔でサンプル
node src/cli.ts plan <dir> --cuts-only  # カット判断だけやり直す(章・タイトル・概要欄は触らない)
node src/cli.ts frames <dir> --every 10 --ocr  # 画面内テキストを Apple Vision で OCR(frames/*.ocr.json)
node src/cli.ts frames <dir> --t 90 --full-res  # ベース映像を元収録のフル解像度にして合成 still を鮮明に
node src/cli.ts frames-serve <dir>  # 常駐フレームサーバ(opt-in。bundle+headless Chrome を暖機。起動中は frames が自動検出)
node src/cli.ts materials <dir>  # 素材(B-roll)の中身を知る(尺・解像度・音声有無+参照/未使用/dangling。materials.probe/index.json)
node src/cli.ts materials <dir> --frames --ocr --transcribe  # (= --all)見た目・画面文字・音声発話まで知覚
node src/cli.ts material-fit <dir>  # 素材の尺整合・dangling/unused を検出し apply パッチ下書きを書く(要 materials 済み・overlays の @id)
node src/cli.ts effect-check <dir>  # 演出(zoom/blur/annotation)を検品する(決定論+任意VLM。effect-check.json / effect-fix.suggested.json)
node src/cli.ts effect-check <dir> --no-vlm  # 決定論チェックのみ(vision route 未設定でも同じ結果になる)
node src/cli.ts av <dir>  # keep後タイムラインの motion/sound を知る(av.probe/*.json + motion.strip.png)
node src/cli.ts av <dir> --range 10-25 --motion-only  # 出力10-25秒の動きだけ調べる
node src/cli.ts bgm-fit <dir>  # 要 av <dir> 事前実行。BGM の音量/duck/フェードを実測から補正提案(bgm-fit.json / bgm-fit.suggested.json)。決定論のみ(LLM不使用)
node src/cli.ts style-profile --from <path> [--from <path> ...] [--name <名前>]  # 任意の動画/収録からスタイルプロファイルを抽出(テンポ・字幕密度/位置・ラウドネス・構成+補正デルタ)。決定論のみ・channel直下の style.probe/<名前>.json に書く(<dir> ではなく --from 主導)
node src/cli.ts style-check <dir>  # 候補の編集が style profile の学習帯からどれだけ逸脱するかを測る(warn/info・exit 0。要 style-profile 事前実行)
node src/cli.ts thumbnail <dir>  # thumbnail.json からサムネイル静止画を生成(thumbnail.png)
node src/cli.ts remeta <dir>      # 章立て・タイトル案・概要欄だけ作り直す(cutplan は触らない)
node src/cli.ts plan-materials <dir>  # 要 materials --all 事前実行。LLM で素材配置候補を選び overlays.json の overlays[] を下書き生成(番号選択のみ・cut/承認には触れない。既存 overlays.json ありは --force 必須+backups/ へ退避)
node src/cli.ts plan-effects <dir>  # 要 frames --ocr / av のいずれか事前実行。LLM で演出(zoom/blur/annotation)の種別を選び overlays.json の zooms/blurs/annotations を下書き生成(番号+種別選択のみ・座標は知覚由来・cut/承認には触れない。既存 zooms/blurs/annotations ありは --force 必須+backups/ へ退避)
node src/cli.ts autozoom <dir>    # 要 record --watch のカーソルサイドカーのみ。LLM 不使用でカーソル dwell 全件を zoom として決定論配置(overlays.json の zooms のみ置換・blurs/annotations は不変・cut/承認には触れない。既存 zooms ありは --force 必須+backups/ へ退避。config の plan.cursor.autoZoom=true(既定)なら run 末尾でも非破壊に自動実行)
node src/cli.ts plan-bgm <dir>    # LLM で BGM の配置候補(区間×曲、または無音)を選び bgm.json の下書きを生成(区間境界は章/大カット境界からの決定論・曲は番号選択のみ・cut/承認には触れない。既存 bgm.json ありは --force 必須+backups/ へ退避)
node src/cli.ts hyperframe-backends --json  # 収録dir不要・read-only。backendの4状態/tier/CDN pin/authoring経路/usable実render fixtureを純JSONで表示(Anime.js 3.2.2はmanual/byte、Three.js r160とraw WebGPU/WGSLはmanual/perceptualでusable。TypeGPUはout。既定は散文)
node src/cli.ts hyperframe <dir> --name <name> --from-brief  # HyperFrames カード(無音の作図素材)を LLM で下書き(hyperframes/<name>.html。番号選択のパターンメニュー+check ゲート通過必須。既存ありは --force 必須)
node src/cli.ts hyperframe <dir> --name <name> --embed-lottie <animation.json>  # 人間持ち込み AE/bodymovin JSON+画像を canonical SVG/byte card にインライン化(check 0/0・atomic publish。既存ありは --force 必須。render はしない)
node src/cli.ts hyperframe <dir> --name <name>  # 上の下書きを native HyperFrames interpreter で materials/hyperframes/<name>.mp4 へ render(check ゲート・atomic publish・hyperframe.<name>.key.json でキャッシュ。--var k=v / --width / --height / --fps / --durationSec で上書き可)
node src/cli.ts hyperframe-place <dir> --name <name> --at <秒>  # render 済みの HyperFrames カードを overlay(既定)/insert として配置する apply パッチ下書き(hyperframe-place.suggested.json)を書く。cut/承認には触れない
node src/cli.ts hyperframe-check <dir> --name <name>  # render 不要な動的監査(終端未完了(進捗判定)/空終端/画面外要素/seek無反応/dead zone/一斉登場)。決定論のみ・常に exit 0・warn/info のみ。render 済み mp4 があれば head/mid/tail+finding still を抽出し任意で VLM 二次確認も行う。hyperframe.probe/<name>/index.json に書く
node src/cli.ts hyperframe-freeze <dir> --name <name>  # check 済みの hyperframes/<name>.html を skeletonize した DRAFT(hyperframe-freeze.suggested/<name>.{html,md})を書く。channel の hyperframe-seeds/ への採用は人間が手で。cut/承認には触れない
node src/cli.ts learn <dir>       # 直前の生成案と人間の仕上げからチャンネル rules 追記案を生成(rules.suggested.md に下書き。channel の rules.md は人間が手で採用)
node src/cli.ts preview <dir>     # カット確認用の軽い動画(人間に見せる)
node src/cli.ts approve <dir>     # cutplan を承認(approvals.json にレコード。対話操作。非対話は --yes 必須)
node src/cli.ts render <dir>      # 最終レンダー(approvals.json の承認レコードが必要。boolean approved だけでは通らない)
node src/cli.ts clean <dir>       # 中間生成物/キャッシュを安全削除(files.ts 分類由来。編集ファイル・approvals.json・materials/・元収録・成果物は触れない。ただし元収録の remux 複製(OBS が .mkv の隣に残す同一内容の .mp4)は ffprobe で内容一致を確認のうえ削除する)。--dry-run / --cache-only(重いキャッシュだけ) / --logs-only(ログ・使い捨て下書き・検品結果・preview・frames だけ。リレンダー最適化 cut/render.*・proxy・whisper-out.*・manifest。--cache-only と排他) / --json
node src/cli.ts editor            # config.yaml の recordingsDir を開くプロジェクトランチャー
node src/cli.ts editor <dir>      # 1プロジェクトを直接開くGUIエディタ(終了は Ctrl+C)
node src/cli.ts editor <dir> --detach  # バックグラウンド起動でターミナルを返す(--status / --stop で確認・停止。待受情報とログは ~/.framewright/editor/)
node src/cli.ts derive <dir> --name <name> --canvas portrait --range 120-165  # 元メディア/transcriptを共有し、指定source秒だけkeepする兄弟プロジェクトを作る
node src/cli.ts mcp <dir>         # MCP サーバ(stdio。1収録フォルダに束縛。describe/validate/frames/materials/assert/apply/id-stamp だけを露出。承認/render/plan 等は露出しない)
node src/cli.ts probe <dir> --all  # 素材/A-V の知覚をまとめて実行(--style は明示時のみ)
node src/cli.ts draft <dir> --all  # cutplan/承認に触れず overlays/bgm の下書きをまとめて作る
node src/cli.ts check <dir> --all  # 検品をまとめて実行。通常は編集ファイルを書かない
node src/cli.ts check <dir> --all --fix  # suggested patch を id-stamp 後に安全適用
node src/cli.ts run <dir>         # 収録直後の初回一括(再実行は --force 必須+backups/ へ退避。末尾で config の plan.cursor.autoZoom=true(既定)+cursorサイドカー有り+zooms空のときだけ autozoom を非破壊で自動実行)
node src/cli.ts run <dir> --full  # 初版 + probe --all + draft --all(thumbnail は作らない)
```

`mcp <dir>` は任意の MCP 対応エージェントにこの収録フォルダを機械的に
開かせるための常駐サーバ(標準入出力で JSON-RPC 2.0)。露出するのは
「読む」(`describe`/`validate`/`frames`/`materials`/`assert` 相当)+
「承認スコープ外の安全編集」(`apply`/`id-stamp` 相当)だけで、
`approve`/`unapprove`/`render`/`plan`/`remeta`/`plan-materials`/`plan-effects`/`plan-bgm`/`run` 等は
tool として一切露出しない(汎用の「CLI を実行する」tool も無い)。詳細・
tool 一覧・信頼モデル宣言は `AGENTS_CONTRACT.md` §11 と `docs/usage.md`
「MCP サーバ(mcp)」を正とする。

## コードを触るとき

- Node 23 の type stripping で TS を直接実行(ビルド工程なし)。**型を消すだけ**の
  モードなので、変換が要る TS 構文は使えない: enum・`namespace`・実行時の
  デコレータ・**コンストラクタのパラメータプロパティ**(`constructor(readonly x)`)
  は実行時に落ちる。フィールドは明示的に宣言して代入する
- 型検査: `npx tsc --noEmit`(= `npm run typecheck`)
- テスト: `npm test`(`node --test`。純関数の単体テストが `test/*.test.ts`。
  `lib/timeline.ts` の時刻写像・`stages/validate.ts` の検査・`lib/renderProps.ts`・
  `lib/fmt.ts` を固定している。ロジックを変えたら追随する)
- エンジンの合成(`src/engine/` の描画)を変えたら `npm run gate:pixel`
  (画素ゲート。`npm test` には入っていない独立コマンド。golden との画素比較。
  2026-07-29 時点で全フレーム一致)
- 構成: `src/stages/`(パイプライン各段。JSON in → JSON out)、
  `src/lib/`(共有ロジック。時刻写像は `lib/timeline.ts`)、
  `editor/`(GUI。server.ts + client/ の React。正のデータは常にファイル側)、
  `src/engine/`(WebCodecs + WebGPU の合成エンジン。最終合成はここ)
- 設定はすべて `config.yaml`(コードにハードコードしない方針)
- スキーマを変えたら次の**5点セット**を揃えて更新する(旧・3点セットに
  `schemas/*.json` を追加。ファイル分類・コマンドが変わったときだけ
  `AGENTS_CONTRACT.md` も追加): `src/types.ts` のコメント / `src/stages/validate.ts` /
  `docs/usage.md` の表 / **`schemas/*.schema.json`**(該当ファイルのスキーマと
  `schemas/examples/<file>.max.json`。`test/schema.test.ts` が types.ts /
  validate.ts の enum・許可キー・`src/lib/ids.ts` の `ID_RE` 等へピン留めして
  いるため、ずれると `npm test` が落ちる) / (ファイル分類・CLI コマンドが
  変わったときだけ)**`AGENTS_CONTRACT.md`**(`test/agentsMd.test.ts` が編集ファイル
  一覧・`GENERATED_FILES`・コマンド名・`ID_PREFIX` の網羅をピン留めしている)
