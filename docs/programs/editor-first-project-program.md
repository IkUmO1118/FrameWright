# 編集器ファースト母艦 — 「収録1本のパイプライン」から「プロジェクトを開いて編集する」へ

> 状態: **COMPLETE / VERIFIED — P0–P5**(2026-08-02 発足・ユーザー批准済み)。FrameWright の入口を
> 「`run` を通したフォルダを後から覗く」から「**標準 NLE と同じくプロジェクトを
> 開いて編集を始める**」へ作り替えること。あわせて **shorts 動線を削除**し、
> その中に埋もれていた**キャンバス(出力サイズ)をプロジェクトの一級属性へ昇格**させる。
>
> **最重要の一線**: これは cut オーサリングモデルの変更**ではない**。
> `cutplan.json` をクリップ列へ作り替える案は引き続き**非目標**
> (`docs/programs/sequence-time-program.md` §7 の決定を継承。本母艦 §7)。
> プロジェクトは「**1本のベースメディア(master clock)+ その上の
> overlays / inserts**」のままで、変えるのは**入口と UI**である。

関連文書:
`AGENTS_CONTRACT.md`(編集ファイル/生成物境界・承認境界) / `CLAUDE.md`(運用) /
`docs/usage.md` / `docs/guides/editor.md` / `docs/guides/export.md` / `docs/decisions.md`。

交差する母艦:
`docs/programs/sequence-time-program.md`(シーケンス時間母艦。**直接の前提**。
S0〜S5 が landing 済みで、本母艦はその上に立つ) /
`docs/programs/editor-opencut-redesign-program.md`(エディタ UI) /
`docs/programs/adoption-and-onboarding.md`(activation 摩擦。本母艦は入口を扱うので直交しない)。

現行コード錨:
`src/stages/bootstrap.ts`(`bootstrapProjectWithLayout`= 編集器ファーストの既存の芯) /
`src/lib/findSource.ts:20-63`(ベースメディアの暗黙ヒューリスティック) /
`editor/server.ts:1480`(`loadProject`)・`:777`(`/api/upload`)・`:804`(`/api/material`) /
`src/lib/profile.ts`(`PROFILES`= キャンバスの実体) /
`src/lib/shorts.ts`・`src/types.ts:942`(`Shorts` / `Short`) /
`src/lib/approval.ts`(`approvals.shorts`) /
`src/stages/render.ts:342`(`renderShort` / `renderOneShort`) /
`src/cli.ts:1930`(`run`)。

---

## 0. 他エージェント向け: 現在地と次の一手

- **現在地(2026-08-02)**: **P0〜P5 の実装・独立検証・focused commit が完了**。
  編集器ファースト母艦は landing 可能な状態。
- **絶対に飛ばしてはいけない前提**: sequence-time 母艦(S0〜S5)が landing 済みで
  あること。特に S3(映像なしプロジェクト)は本母艦の「音声+画像ベースの編集」が
  既に成立している根拠で、本母艦はそこへ**入口と UI を足すだけ**である。
- **触ってはいけない一線**(§7 の非目標):
  - `cutplan.json` を「クリップ列」へ作り替えない
  - `manifest.source` を複数化しない(master clock は常に1本)
  - plan-* の LLM プロンプトに出力秒を持ち込まない
  - 承認レコード(`approvals.json`)の書き手を増やさない

---

## 1. 問題の実体 — 入口がパイプラインの尻についている

FrameWright の入口は現在こう読める:

```
収録 → run(ingest → transcribe → detect → plan)→ できたものを editor で覗く
```

ところが**コードは既にそうなっていない**。`editor <dir>` は
`bootstrapProjectWithLayout`(`src/stages/bootstrap.ts:33`)で
manifest / transcript(空)/ cutplan(全編 keep)のうち**無いものだけを決定論的に補う**。
whisper も LLM も呼ばない。つまり「`run` を打たないとエディタが開けない」という
制約は**既に存在しない**。

残っているのは、その手前の4点だけである。

| # | 欠落 | 実体 |
|---|---|---|
| (1) | **空フォルダで開けない** | `findSource()` がメディア0本で throw(`findSource.ts:35`)。「プロジェクトを作る → 中でメディアを選ぶ」順序が無い |
| (2) | **ベースメディアを GUI で選べない** | `manifest.source` はファイル名ヒューリスティック(`raw.*` 優先 / 動画が無ければ音声 / 音声が複数ならエラー)で決まり、一度書かれると sticky(`findSource.ts:21-24`)。「これをベースにする」「差し替える」UI が無い |
| (3) | **`inserts[]` がクリップとして扱われていない** | 型は既に `(file, startFrom, durationSec) @ at`(`types.ts:609-636`)= クリップそのものなのに、UI では「演出」の一種。並べ替え・トリムの affordance が無い |
| (4) | **プロジェクト一覧が無い** | `editor <dir>` は dir 必須。`recordingsDir` を開くランチャーが無い |

**つまり編集器ファースト化のコストは見た目よりずっと安い。**
データモデルは sequence-time 母艦が既に整えており、足りないのは入口と UI である。

## 2. shorts の実体 — 4つの別物の束

`Short`(`src/types.ts:946-967`)は分解すると4つの独立した概念の束である。

| フィールド | 正体 | 本母艦での行き先 |
|---|---|---|
| `profile` | **キャンバス**(width/height + ベース映像のパネル配置 + テロップ既定) | **プロジェクトへ昇格**(P1) |
| `ranges` | 第二の cutplan | 派生プロジェクトの `cutplan` へ(P0 の移行) |
| `captionTracks` | 第二の overlays | 派生プロジェクトの `overlays` へ |
| `approved` / `approvals.shorts` | 第二の承認レコード | 派生プロジェクトの `approvals.json` へ |

**shorts とは「同一フォルダ内の第二プロジェクト」を1つの型に押し込んだものである。**
これを認めると、削除の道筋が一意に決まる: **1プロジェクト = 1出力**に統一し、
縦ショートは「元メディアを参照する別プロジェクト」にする(§4 の決定1)。

`src/lib/profile.ts` の `PROFILES`(`vertical` / `vertical-cover` / `vertical-screen`)は
**捨てない**。`layout.panels` は「ベース映像を非ネイティブなキャンバスへどう置くか」の
答えそのもので、P1 のキャンバス機能の中身になる。

## 3. 目標アーキ

```
┌────────────────────────────────────────────────────────────┐
│ プロジェクト(= 1フォルダ = 1出力)                          │
│   canvas    : 出力サイズ(作成時固定)                        │
│   baseLayout: ベース映像の置き方(作成時固定。P6 で canvas から分離)│
│   base media: master clock。1本(動画 or 音声)              │
│   overlays / inserts / transcript / bgm / cutplan            │
└────────────────────────────────────────────────────────────┘
        ▲ 作る・開く              ▲ 知覚・生成・検査・確定
        │                         │
    エディタ(主)  ←────────  CLI(同じ関数を叩く別の口)
```

- **エディタが主で CLI が従、ではない。** 両方が同じ stage 関数を呼ぶ対等な口である
  (現在も `editor/server.ts` は `frames` / `preview` / `render` / `validate` を
  直接 import している)。変えるのは「どちらが入口として自然か」であって、
  CLI を格下げしない。
- **`run` は「AI に初版を作らせる」1ボタンになる**(§5 P3)。

## 4. 決定(2026-08-02・ユーザー批准)

1. **複数出力 = 派生プロジェクト。** 1プロジェクト = 1出力に統一する。縦ショートは
   「元メディアを参照する別プロジェクト」を作るコマンドで表現する。
   → `Short` 型・`profile` フィールド・`approvals.shorts`・`plan-shorts`・
   `--short` 系フラグが丸ごと消え、型が1つ減る。
2. **データモデルは読み A(ベース1本 + inserts 昇格)。**
   複数動画の連結は既存の `inserts[]` で表現し、UI 側でクリップとして掴めるようにする。
   `cutplan` のクリップ列化(読み B)は**非目標**として §7 に記録する。
3. **キャンバスは作成時に固定。** プロジェクト作成時に 16:9 / 9:16 / 1:1 等を選び、
   以後は変えない。`pos` / `rect` / `blurs.rect` / `annotations` / `zooms.rect` が
   すべて出力px絶対であるため、後から変えると全座標が壊れる。座標マイグレーションは
   採らない(§6 に理由を記録)。

## 5. フェーズ

枝分かれ plan(すべて `docs/plans/2026-08-02-editor-first-*`):

| 段 | plan | 状態 | 出荷されるもの |
|---|---|---|---|
| P0 | `2026-08-02-editor-first-p0-shorts-removal-design.md` | COMPLETE / VERIFIED | shorts 削除(113ファイル) |
| P1 | `2026-08-02-editor-first-p1-canvas-promotion-design.md` | COMPLETE / VERIFIED | キャンバスのプロジェクト昇格。9:16 が第一級に |
| P2 | `2026-08-02-editor-first-p2-entry-design.md` | COMPLETE / VERIFIED | 空フォルダで開く / ベースメディアを GUI で選ぶ |
| P3 | `2026-08-02-editor-first-p3-run-redefinition-design.md` | COMPLETE / VERIFIED | `run` = 「AI に初版を作らせる」+ bootstrap マーカー |
| P4 | `2026-08-02-editor-first-p4-insert-clips-design.md` | COMPLETE / VERIFIED | inserts の移動・順序・クリップ表示 |
| P5 | `2026-08-02-editor-first-p5-launcher-and-derive-design.md` | COMPLETE / VERIFIED | ランチャー + `derive`(shorts の後継動線) |
| P6 | `2026-08-02-editor-first-p6-canvas-two-axis-design.md` | IMPLEMENTED | キャンバスの2軸分離(サイズ / ベース映像の置き方) |
| P7 | `2026-08-03-editor-first-p7-obs-canvas-cost-design.md` | IMPLEMENTED(④(a) は §P8 §1 の理由で打ち切り) | obs-canvas のコスト整理(ガード・露出縮小・高速パス計測) |
| P8 | `2026-08-03-editor-first-p8-burnwipe-removal-design.md` | IMPLEMENTED | ワイプ焼き込み高速パスの削除 |
| P9 | `2026-08-07-editor-open-analysis-design.md` | IMPLEMENTED | エディタ起動時の自動解析 + 旧 run ボタン削除 |

各段の概要は以下。**詳細は必ず plan を正とする**(以下は要約)。

### P0 — shorts 削除

**状態: COMPLETE / VERIFIED(2026-08-02)。** 実装・判断・実測の詳細は
`docs/plans/2026-08-02-editor-first-p0-shorts-removal-design.md` §9。

`shorts.json` を編集ファイルから外し、関連する CLI 表面・UI・型・スキーマ・
承認レコードを削除する。**キャンバス機能(P1)より先**に置くのは、shorts が
消えないとキャンバスの置き場所(プロジェクト or Short)が二重になるため。

消える表面:

| 種別 | 実体 |
|---|---|
| CLI | `plan-shorts` / `render --short` / `render --shorts` / `approve --short` / `unapprove --short` / `frames --short` / `av --short` |
| 型 | `Shorts` / `Short` / `ApprovalsFile.shorts` / `EditableDocs.shorts` |
| ファイル | `shorts.json`(編集ファイル)/ `shorts/`(出力)/ `cut.<name>.mp4` / `cut.<name>.keeps.json` / `render.<name>.props.json` / `render.<name>.key.json` |
| スキーマ | `schemas/shorts.schema.json` / `schemas/examples/shorts.max.json` / `schemas/apply-patch.schema.json` の shorts 宛先 |
| UI | `ShortsPanel`(`editor/client/Panels.tsx:1055`)/ Inspector のショート節 / App.tsx の activeShortName 系状態 |
| その他 | `src/lib/shorts.ts` / `src/stages/planShorts.ts` / `prompts/plan-shorts.md` / MCP の shorts 表面 |

残すもの: **`src/lib/profile.ts` の `PROFILES`**(P1 が使う)。

影響規模の実測(2026-08-02、`grep -ci short`):
`src` + `editor` + `schemas` + `prompts` で **57ファイル**、
`test` + `docs` + `AGENTS_CONTRACT.md` で **56ファイル**。合計 **113ファイル**。
最大は `editor/client/App.tsx`(213)/ `Inspector.tsx`(74)/ `src/cli.ts`(68)。

移行: 既存収録の `shorts.json` は削除しない(人間のデータ)。`validate` が
「shorts.json は使われなくなった。派生プロジェクト化は `<コマンド>` を参照」と
**警告(exit 0)**で知らせる。FrameWright は勝手に消さない。

### P1 — キャンバスのプロジェクト昇格

**状態: COMPLETE / VERIFIED(2026-08-02)。** 実装・判断・実測の詳細は
`docs/plans/2026-08-02-editor-first-p1-canvas-promotion-design.md` §8。

`PROFILES` を Short から切り離し、プロジェクトの一級属性にする。

- `manifest.video` の隣に `canvas`(width / height / layout.panels / caption 既定)を置く。
  省略時は現行どおり `screenRegion` のサイズ = **既存収録はバイト等価**
- プロジェクト作成時にプリセット(16:9 / 9:16 / 1:1 / 4:5)を選べる
- `resolveProfile()` の呼び出し元を「Short の profile」から「プロジェクトの canvas」へ付け替える

**出荷**: 9:16 のプロジェクトが第一級で作れる。

### P2 — 入口の編集器ファースト化

**状態: COMPLETE / VERIFIED(2026-08-02)。** 実装・判断・実測の詳細は
`docs/plans/2026-08-02-editor-first-p2-entry-design.md` §8。

(1)(2) を潰す。

- 空フォルダでもエディタが開く(メディア0本を正常状態として扱う)
- GUI でベースメディアを選ぶ / 差し替える(`findSource` の暗黙ヒューリスティックからの撤退)
- 音声候補が複数あるときのハードエラー(`findSource.ts:49-54`)を GUI の選択へ置き換える

### P3 — `run` の再定義

**状態: COMPLETE / VERIFIED(2026-08-02)。** 実装・判断・実測の詳細は
`docs/plans/2026-08-02-editor-first-p3-run-redefinition-design.md` §7。

- `run` から `ingest` を外す(プロジェクト作成時に済んでいる)。
  `run` = **transcribe → detect → plan** =「AI に初版を作らせる」
- エディタから実行できるようにする
- ⚠️ **新しい設計課題**: `guardRerun` は「transcript / cutplan が既にある」を
  再実行禁止の根拠にするが、bootstrap が作った空 transcript / 全編 keep cutplan は
  **人間の編集ではない**。両者を区別するマーカー(例 `cutplan.generatedBy: "bootstrap"`)が要る

### P4 — inserts のタイムライン一級化

**状態: COMPLETE / VERIFIED(2026-08-02)。** 実装・判断・実測の詳細は
`docs/plans/2026-08-02-editor-first-p4-insert-clips-design.md` §7。

(3) を潰す。データモデルは変えない。**plan 起草時の調査で、想定より遥かに
小さいことが判明した**: トリム・分割・複製・素材ドロップは既に実装済みで、
欠けているのは**本体ドラッグでの移動(`at`)と同一 `at` の順序**だけ。

### P5 — プロジェクトランチャーと派生プロジェクト

**状態: COMPLETE / VERIFIED(2026-08-02)。** 実装・判断・実測の詳細は
`docs/plans/2026-08-02-editor-first-p5-launcher-and-derive-design.md` §6。

(4) を潰す。`recordingsDir` の一覧から開く。**派生プロジェクト(`derive`)=
§4 決定1 の実体**もここに置く(旧 `Short` の各フィールドがプロジェクトの
どこへ行くかの対応表は P5 plan §3.1)。

## 6. 未決の決定(着手前に潰す go/no-go)

- **P0**: 既存 `shorts.json` の派生プロジェクトへの自動変換コマンドを出すか、
  手動移行の案内だけにするか。**P0 plan §6 で「案内だけ」に決着**(変換先の形が
  P1 + P5 で決まるまで定義できないため)。P5 landing 後に再検討してよい

決着済み(§9 へ移した): P1 の `canvas` の置き場所 / P3 のマーカーの置き場所。

## 7. 非目標(この母艦がやらないこと)

- **`cutplan.json` をクリップ列へ作り替えない**(読み B)。
  sequence-time 母艦 §7 の決定をそのまま継承する。承認 hash・`plan` の番号選択・
  `detect`・`boundaryCheck`・エディタの source↔output 変換約40箇所・`transcript` の
  source 秒がすべて前提を失い、得られるもの(複数動画の対等な連結)は
  `inserts[]` + P4 の UI で実質得られる。
  **将来これが必要になったら独立した母艦として起草する**(実例のトリガー:
  複数カメラ収録の連結編集、素材主体のモンタージュ)。
- **`manifest.source` を複数化しない。** master clock は常に1本。
- **キャンバスの後からの変更をサポートしない**(§4 決定3)。
- **CLI を格下げしない。** エディタが主になっても、全機能は CLI から到達できる。

## 8. 全段が満たし続ける不変条件

1. **バイト等価**: 新しい属性(`canvas` 等)を1つも書かないプロジェクトは、
   全コマンドの出力が本母艦の導入前と**バイト等価**。各 plan にこの回帰テストを置く。
2. **JSON が正**: 新しい状態はすべて既存ファイル内のフィールドとして表現する。
3. **承認境界の不可侵**: `approvals.json` の書き手は `approve` / `unapprove` と
   GUI 保存だけ。本母艦のどの段もこれを増やさない。
4. **人間のデータを勝手に消さない**: P0 は `shorts.json` を削除せず警告に留める。
5. **5点セットの追随**: スキーマを変えたら `src/types.ts` / `src/stages/validate.ts` /
   `docs/usage.md` / `schemas/*.schema.json` + `schemas/examples/*.max.json` /
   (ファイル分類・コマンドが変わったときのみ)`AGENTS_CONTRACT.md`。
   `test/schema.test.ts` と `test/agentsMd.test.ts` がピン留めしている。
   **P0 はコマンドとファイル分類の両方を変えるので `AGENTS_CONTRACT.md` 必須。**

## 9. 意思決定ログ

- **2026-08-03(P8 IMPLEMENTED)**: ワイプ焼き込み高速パスを削除。`render.design.enabled`
  と cursor auto zoom の常用で発火条件を満たす実収録が構造的に無く、今後の
  canvas/baseLayout 変更のたびに未使用経路へガードを足す維持費だけが残っていたため。
  `cut.mp4` の通常キャッシュは維持し、旧焼き込みキーは deep-equal のキー差で
  自動的に不一致になる。

- **2026-08-02(P5 COMPLETE / VERIFIED)**: 引数なし editor のランチャー、安全な
  `/p/<name>/` 束縛、一覧/空project作成、CLI/API共通 `derive`、symlink→hardlink→copy、
  keep 選択の派生UIを実装。主担当の独立実測で typecheck、2736/2736 tests、
  focused 10/10、実HTTP、実derive + validate 0 errors、本番bundleを確認した。

- **2026-08-02(P4 COMPLETE / VERIFIED)**: insert の本体ドラッグ移動と keep 吸着、
  同一 `at` 内の順序操作、basename + 動画/静止画表示を実装。主担当の
  独立実測で typecheck、2726/2726 tests、focused 8/8、本番エディタbundleを確認した。

- **2026-08-02(P3 COMPLETE / VERIFIED)**: bootstrap marker の完全内容照合、
  共通 `runDraft`、manifest 有り ingest 省略、API/UI/force/backups/進捗を実装。
  主担当の独立実測で typecheck、2718/2718 tests、既存projectのforce無しHTTP拒否、
  approval hash不変、CLI helpを確認した。
- **2026-08-02(P2 COMPLETE / VERIFIED)**: 空フォルダを正常状態にし、source候補の
  列挙/一意解決、`state:empty|ready`、base-media API/upload、canvas付きempty UI、
  未存在dir作成を実装。主担当の独立実測で typecheck、2704/2704 tests、空bootstrap
  no-write、HTTP empty応答と配信bundleを確認した。
- **2026-08-02(P1 COMPLETE / VERIFIED)**: `manifest.canvas`、6プリセット、
  `resolveCanvas` / `outputSize`、CLI/bootstrap/editor 配線を実装。canvas 省略時の
  landscape は従来寸法を維持する。主担当の独立実測で typecheck、2692/2692 tests、
  pixel 11/11、square 1080x1080 / 4:5 1080x1350 の実 frames と目視を確認した。
- **2026-08-02(P0 COMPLETE / VERIFIED)**: shorts 専用の CLI・型・承認・render・
  MCP・editor・schema・prompt を削除。legacy `shorts.json` は内容を読まず警告だけを
  出し、削除しない。主担当の独立実測で typecheck、2691/2691 tests、pixel 11/11、
  CLI 表面消滅、legacy 移行警告の exit 0 を確認。`PROFILES` は P1 用に維持した。

- **2026-08-02(発足)**: ユーザーから「標準 NLE のようにプロジェクトごとに
  エディタを開く」「run を打たないとエディタを開けない、ではない」「shorts 動線と
  UI を削除し、代わりに Canva のようにキャンバスサイズを調節できるように」の
  3点の要望。調査の結果、**編集器ファースト化は sequence-time 母艦の landing に
  よって既に8割成立しており、欠けているのは入口4点だけ**と診断(§1)。
- **2026-08-02(批准)**: 複数出力は**派生プロジェクト**、データモデルは
  **読み A**、キャンバスは**作成時固定**。3点ともユーザー確認済み(§4)。
- **2026-08-02**: `shorts` は「同一フォルダ内の第二プロジェクト」を1型に押し込んだ
  ものであると診断(§2)。この診断が「削除して派生プロジェクトへ」の根拠。
- **2026-08-02**: `PROFILES` は削除対象から除外。キャンバス機能の中身そのもの。
- **2026-08-02(P1 の未決を決着)**: **`canvas` は `manifest.json` に置き、
  `ingest` が書く。** `manifest.json` は既に「収録フォルダの中身だけからは
  復元できない ingest の決定」(`layout` / `screenRegion` / 音声トラック番号)を
  保持する場所であり、キャンバスは同じ性質の値。`--layout` に完全な先例があり、
  `bootstrapProjectWithLayout` の「既に別の layout で作成済み」ガードを
  そのまま写せば**作成時固定が実装として得られる**。新しい編集ファイルは
  増やさない(§8-2)。AI が `manifest.json` を編集しないルールは不変で、
  書く主体は `ingest` だけ。詳細 = P1 plan §2。
- **2026-08-02(P3 の未決を決着)**: bootstrap 生成物のマーカーは
  **編集ファイル自身の `generatedBy?: "bootstrap"`**(`CutPlan` / `Transcript`)。
  省略時は「手編集とみなす」で既存収録はバイト等価。ただしマーカーだけでは
  人間の直接編集(Write/Edit)で消えないため、**内容が bootstrap の初期値と
  一致するかの二重判定**を必須とする。詳細 = P3 plan §2。
- **2026-08-02(P4 の規模を下方修正)**: plan 起草時の調査で、inserts の
  トリム(`durationSec` / 静止画の左端 / 動画の `startFrom`)・分割・複製・
  素材ドロップは**すべて実装済み**と判明。P4 に残るのは移動(`at`)と
  同一 `at` の順序と見た目だけ。母艦 §5 の記述をこれに合わせて修正した。
- **2026-08-02(派生の方式を確定)**: 派生プロジェクトは**元メディアへの
  symlink**(失敗時はハードリンク→コピー)で共有する。`manifest.source` の
  「フォルダ内のファイル名」という不変条件を崩さずに済むため。
  `transcript.json` は同じメディアで source 秒が一致するのでコピーするが、
  `overlays.json` / `bgm.json` は**コピーしない**(座標が出力px絶対で
  キャンバスが変われば無意味。旧 shorts が blurs/annotations を継承しなかったのと
  同じ理由)。詳細 = P5 plan §3。
