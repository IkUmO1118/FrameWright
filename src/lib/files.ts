// 収録フォルダ内のファイル分類の単一の真実。
//
// EDITABLE_FILES(人間/AI が手編集する対象。plan/transcribe の再実行が
// backups/ へ退避してから上書きする)・GENERATED_FILES(中間生成物。
// CLAUDE.md の「中間生成物は編集しない」一覧と一致させる。手編集されても
// 次の実行で上書きされる/再生成できるので実害が薄い)・APPROVAL_FILE
// (承認レコード。編集ワークフローのどちらにも属さない第3カテゴリ。
// backup 退避の対象にはしない)の3分類を1箇所にまとめ、backup.ts・cli.ts・
// ドキュメント(§10 T8 の推奨 deny スニペット)がここから派生する。
import { APPROVALS_FILE } from "./approval.ts";

/** 人間(や AI)が手編集する対象で、plan / transcribe の再実行が上書きし得る
 * ファイル。上書き前の退避はこの一覧のうち存在するものを対象にする
 * (backup.ts の backupEditableFiles の既定値としても使う) */
export const EDITABLE_FILES = [
  "cutplan.json",
  "chapters.json",
  "meta.json",
  "transcript.json",
  "overlays.json",
] as const;

/** 中間生成物のうち、収録フォルダ直下で名前が固定のもの。CLAUDE.md の
 * 「中間生成物は編集しない」一覧と一致させる。
 * `plan.first.json` / `plan-effects.first.json`(AI 初版の write-once 保存。
 * 最初の判断を記録する測定資産。既に在れば `--force` でも上書きしない・
 * 再生成不可能なため GENERATED_CACHE_FILES にも GENERATED_LOG_FILES にも
 * 入れない=`clean` フルでのみ消える)は他と異なりこの性質を持つ */
export const GENERATED_FILES = [
  "manifest.json",
  "cuts.auto.json",
  "plan.raw.txt",
  "plan.loop.json",
  "plan-materials.raw.txt",
  "plan-effects.raw.txt",
  "plan-bgm.raw.txt",
  "render.props.json",
  "whisper-out.json",
  "whisper-out.srt",
  "transcript.system.json",
  "whisper-system-out.json",
  "cut.mp4",
  "cut.m4a",
  "cut.keeps.json",
  "render.key.json",
  "render.report.json",
  "preview.mp4",
  "preview-cut.mp4",
  "preview-cut.key.json",
  "proxy.mp4",
  "proxy.m4a",
  "proxy.key.json",
  "material-fit.suggested.json",
  "effect-check.json",
  "effect-fix.suggested.json",
  "bgm-fit.json",
  "bgm-fit.suggested.json",
  "style-check.json",
  "hyperframe-place.suggested.json",
  "plan.first.json",
  "plan-effects.first.json",
] as const;

/** 中間生成物のうち、HyperFrame カード名で可変になるファイル名パターン。 */
const GENERATED_NAME_PATTERNS: readonly RegExp[] = [
  /^hyperframe\.[^./]+\.key\.json$/,
];

/** 中間生成物のディレクトリ(配下は丸ごと中間生成物扱い): frames/(PNG・
 * props.json・OCR サイドカー。frames 実行のたびに全消しされる)・
 * render.design/(plain / obs-canvas 共通で、config.yaml の
 * render.design.backgroundFile が収録フォルダ外の絶対パスまたはrepo同梱素材の
 * とき、書き出しページが読める publicDir 配下へ取り込んだ背景画像のコピー。
 * 元ファイルからいつでも再取得できるので generated。materials/ に置くと
 * `materials` コマンドに「未使用素材」として計上されてしまうため別ディレクトリ)・
 * materials.probe/(`materials <dir>` が書く素材知覚の集約+キャッシュ。frames/ と違い実行のたびに
 * 全消しはされない差分更新型。`materials/` 自体(人間の素材置き場)とは
 * 別名の生成ディレクトリなので "other" にはならない)・
 * style.probe/(`style-profile` が channel 直下に書くスタイルプロファイル
 * 集約。生成物)・hyperframe.probe/(`hyperframe-check` が書く動的監査
 * レポート+still の集約。materials.probe/ 等と同じ差分更新型キャッシュ。
 * `hyperframe.probe/<name>/index.json` の形でカード名ごとのサブディレクトリを持つ)・
 * timeline.probe/(エディタサーバーが書くタイムライン用の派生資産。
 * waveform/ のピーク列と thumbstrip/ のスプライトシートを保持する差分更新型
 * キャッシュ。消しても編集データは失われず、次回エディタ表示で再生成される)・
 * render.fast/(歴史的な名前。かつての高速パスの置き場だった。現在の中身は
 * design 静的資産 render.fast/design/<key>.<role>.png(背景・影・角丸 mask の
 * 内容アドレス式キャッシュ。再生成が高価な「重いキャッシュ」)と、
 * BGM/インサート音声ミックスの一時 PCM(正常終了時は消える)。
 * ディレクトリ名を変えると既存収録の資産が全部無効化されるため名前は据え置く)・
 * .remotion/(レガシー。旧 Remotion 経路が収録フォルダ配下へ落とした
 * headless Chrome 本体(`chrome-headless-shell`)の残骸。FrameWright はもう作らないが、
 * 既存収録に約 200MB 残っているので `clean` の回収対象として残す。
 * 編集にも承認にも一切関与しない)・
 * hyperframe-freeze.suggested/(`hyperframe-freeze <dir> --name <name>` が書く
 * 使い捨ての DRAFT。中身は `<name>.html`(skeletonize 済みカード)+
 * `<name>.md`(採用手順+根拠)。material-fit.suggested.json 等と同じ
 * disposable-draft パターンだが単体ファイルではなくディレクトリ。channel
 * 直下の `hyperframe-seeds/`(fileRole は "other". FrameWright は書かない)への
 * 実採用は人間の仕事。「重いキャッシュ」ではないので isGeneratedCache は
 * false(--cache-only では残す)、`--logs-only` では掃除する) */
const GENERATED_DIRS: readonly string[] = [
  "frames",
  "render.design",
  "materials.probe",
  "av.probe",
  "review.probe",
  "style.probe",
  "hyperframe.probe",
  "timeline.probe",
  "hyperframe-freeze.suggested",
  "render.fast",
  ".remotion",
];

/** GENERATED_DIRS のうち「重いキャッシュ」ではなく使い捨ての下書きに過ぎない
 * ディレクトリ(isGeneratedCache の対象から除く。--cache-only では残し、
 * --logs-only では掃除する。frames/ 等の「両方で掃除される」ディレクトリとは
 * 扱いが違う)。GENERATED_DIRS の部分集合であること。 */
const GENERATED_DIRS_NOT_CACHE: readonly string[] = ["hyperframe-freeze.suggested"];

/** 収録フォルダ直下の承認レコードファイル名(src/lib/approval.ts の再輸出。
 * files.ts をファイル分類の唯一の出所にするため、他コードはここから参照する) */
export const APPROVAL_FILE = APPROVALS_FILE;

/** channel(recordingsDir) 直下にあるがプロジェクトではない共有/生成ディレクトリ。 */
export const PROJECT_DIRECTORY_EXCLUDES = ["hyperframe-seeds", "style.probe"] as const;

export type FileRole = "editable" | "generated" | "approval" | "other";

/** 収録フォルダからの相対パス(例: "cutplan.json" / "frames/out10s.png") から
 * ファイルの分類を返す。EDITABLE_FILES / GENERATED_FILES(+パターン・
 * ディレクトリ) / APPROVAL_FILE のどれにも該当しなければ "other"
 * (final.mp4 / thumbnail.png / bgm.* / materials/ / rules*.md / backups/ /
 * .editor-draft.json など、人間の成果物やその他の特別扱いファイル)。
 * `<recording base>.cursor.json`(`record --watch` が録画ごとに書くカーソル
 * 座標サイドカー。§docs/plans/2026-07-24-openscreen-d1-cursor-telemetry-design.md
 * D6)もここに含まれる: 再現不能な1回限りの収録入力であって再生成できる
 * 中間生成物ではないため、パターンを足さず(=個別列挙もせず)デフォルトの
 * "other" のまま扱う。AI は編集しない・`clean` は消さない */
export function fileRole(relPath: string): FileRole {
  if (relPath === APPROVAL_FILE) return "approval";
  if ((EDITABLE_FILES as readonly string[]).includes(relPath)) return "editable";
  if ((GENERATED_FILES as readonly string[]).includes(relPath)) return "generated";
  if (GENERATED_NAME_PATTERNS.some((re) => re.test(relPath))) return "generated";
  const top = relPath.split("/")[0];
  if (GENERATED_DIRS.includes(top)) return "generated";
  return "other";
}

/** 中間生成物のうち「再生成が重い/容量を食うキャッシュ」の固定名。--cache-only が
 * 消す対象の固定ファイル部分(GENERATED_DIRS 配下と cut.<name>.mp4 等のパターンは
 * isGeneratedCache が別途 true 判定する)。ここに載らない generated 固定名
 * (manifest.json / cuts.auto.json / whisper-out.* / *.raw.txt / *.suggested.json 等)は
 * 軽い/再生成が高価なので --cache-only では残す。GENERATED_FILES の部分集合であること。 */
export const GENERATED_CACHE_FILES = [
  "cut.mp4",
  "cut.m4a",
  "cut.keeps.json",
  "preview.mp4",
  "preview-cut.mp4",
  "preview-cut.key.json",
  "proxy.mp4",
  "proxy.m4a",
  "proxy.key.json",
  "render.key.json",
  "render.props.json",
] as const;

/** relPath が「再生成が重いキャッシュ」かどうか(--cache-only の対象判定)。
 * 前提として generated であること(generated 以外は常に false=belt)。判定:
 * 1) generated ディレクトリ配下(frames/ *.probe/)は全て cache
 * 2) 固定名は GENERATED_CACHE_FILES に載るものだけ cache */
export function isGeneratedCache(relPath: string): boolean {
  if (fileRole(relPath) !== "generated") return false;
  const top = relPath.split("/")[0];
  if (GENERATED_DIRS.includes(top) && !GENERATED_DIRS_NOT_CACHE.includes(top)) return true;
  if (GENERATED_NAME_PATTERNS.some((re) => re.test(relPath))) return true;
  return (GENERATED_CACHE_FILES as readonly string[]).includes(relPath);
}

/** 中間生成物のうち「ログ・使い捨て下書き・検品結果」= 消してもレンダー/エディタ/
 * proxy の動作に影響せず、かつ再生成が安価(LLM/whisper/ffprobe の重い再実行を
 * 伴わない)なものの固定名。--logs-only が消す対象。ここに載らない generated は
 * 意図的に残す: whisper-out.* / transcript.system.json / *.probe/(再生成が高価)、
 * manifest.json(エディタ起動・render の必須入力)、cut.mp4 / render.* / proxy.*
 * (リレンダー最適化・proxy)。GENERATED_FILES の部分集合であること。 */
export const GENERATED_LOG_FILES = [
  "cuts.auto.json",
  "plan.raw.txt",
  "plan.loop.json",
  "plan-materials.raw.txt",
  "plan-effects.raw.txt",
  "plan-bgm.raw.txt",
  "material-fit.suggested.json",
  "effect-fix.suggested.json",
  "bgm-fit.suggested.json",
  "hyperframe-place.suggested.json",
  "effect-check.json",
  "bgm-fit.json",
  "style-check.json",
  "render.report.json",
  "preview.mp4",
  "preview-cut.mp4",
  "preview-cut.key.json",
] as const;

/** --logs-only が消す generated ディレクトリ(配下丸ごと)。frames/ は撮影のたびに
 * 全消し・再撮影される自己確認 still なのでログ同然。hyperframe-freeze.suggested/
 * は使い捨ての DRAFT(重いキャッシュではない)なのでログ同然。他の *.probe/ や
 * 描画キャッシュ等は残す(高価キャッシュ or リレンダー最適化)。 */
const GENERATED_LOG_DIRS: readonly string[] = ["frames", "hyperframe-freeze.suggested"];

/** relPath が「ログ・使い捨て下書き」かどうか(--logs-only の対象判定)。
 * 前提として generated であること(generated 以外は常に false=belt)。判定:
 * 1) frames/ 配下は全て log 2) 固定名は GENERATED_LOG_FILES に載るものだけ log。
 */
export function isGeneratedLog(relPath: string): boolean {
  if (fileRole(relPath) !== "generated") return false;
  const top = relPath.split("/")[0];
  if (GENERATED_LOG_DIRS.includes(top)) return true;
  return (GENERATED_LOG_FILES as readonly string[]).includes(relPath);
}

/** GENERATED_FILES の一員(=手編集しない中間生成物)だが、収録フォルダの中身
 * だけからは復元できないため、clean はフルでも削除しない。ingest の再実行は
 * --layout / --canvas を知らないと screenRegion/cameraRegion/canvas を失う
 * (2026-07-28 に実際に事故として発生)。同じく再生成不可能な plan.first.json /
 * plan-effects.first.json は clean フルで削除される(=再生成不可能な測定資産
 * だが manifest.json のような編集不可逆損害ではない) */
export const CLEAN_PROTECTED_FILES = ["manifest.json"] as const;

/** relPath が clean の保護対象(=generated だが削除してはいけない)かどうか。
 * 前提として generated であること(generated 以外は常に false=belt)。
 * CLEAN_PROTECTED_FILES に載るものだけが true。 */
export function isCleanProtected(relPath: string): boolean {
  return (CLEAN_PROTECTED_FILES as readonly string[]).includes(relPath);
}
