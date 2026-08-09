// 編集ファイル(cutplan / transcript / overlays / chapters / meta)の整合性検査。
// 人間や AI(Claude Code)が JSON を直接編集した後に走らせ、preview / render で
// 数分かけて気づく壊れ方を数ミリ秒で検出する。
//
// 方針: エラー = レンダーが壊れる・結果が明らかに不正になるもの(exit 1)。
//       警告 = 動きはするが意図と違う可能性が高いもの(exit 0)。

import { cliCmd } from "../lib/cliName.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { isCutplanApproved } from "../lib/approval.ts";
import {
  DEFAULT_EFFECT_CHECK_DENSITY_WINDOW_SEC,
  DEFAULT_EFFECT_CHECK_MAX_PER_WINDOW,
} from "../lib/config.ts";
import { fmtT } from "../lib/fmt.ts";
import { isImageFile } from "../lib/overlayFade.ts";
import { resolveStillsCfg } from "../lib/config.ts";
import { framesFreshness } from "../lib/framesIndex.ts";
import { ID_PREFIX, ID_RE } from "../lib/ids.ts";
import { collectIdOccurrences } from "../lib/mention.ts";
import { CUT_REASON_IDS, REASON_ID_FAMILY } from "../lib/reasonIds.ts";
import type { CutReasonId } from "../lib/reasonIds.ts";
import { EFFECT_REASON_IDS, EFFECT_REASON_ID_FAMILY } from "../lib/effectReasonIds.ts";
import type { EffectReasonFamily, EffectReasonId } from "../lib/effectReasonIds.ts";
import { buildTimelineModel, insertSpansOf, playbackSegmentsOf, remapInterval } from "../lib/timeline.ts";
import type { TimelineEntry } from "../lib/timeline.ts";
import { transcriptHasWords } from "../lib/words.ts";
import {
  capNum,
  captionTrack,
  DEFAULT_PLAYBACK_SPEED,
  hasCamera,
  manifestLayout,
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
  ovNum,
  textNum,
} from "../types.ts";
import type { CutPlan, Interval, Manifest, Transcript, WipeAnchor } from "../types.ts";
import type { Config } from "../lib/config.ts";
import { isBaseLayoutPreset, isCanvasPreset, outputSize } from "../lib/profile.ts";

export interface Problem {
  /** 対象ファイル(収録フォルダ内の名前) */
  file: string;
  /** 位置の説明(例: "segments[3]") */
  where: string;
  message: string;
}

export interface ValidateResult {
  errors: Problem[];
  warnings: Problem[];
  /** 検査した内容の一行サマリ(問題ゼロのときの表示用) */
  summary: string;
}

/** keep 区間の重なり・隣接の判定猶予(秒)。mergeIntervals と同じ */
const EPS = 0.005;
/** 収録の長さ超えの許容(秒)。丸め誤差や whisper の末尾ずれを許す */
const DUR_EPS = 0.5;

/** validate が検査する編集ファイル群(パース済み。無ければ null)。
 * ディスクから読む CLI の validate と、メモリ上の編集を保存前に検査する
 * エディタの /api/save で共有し、同じ純粋検査を通して保証レベルを揃える */
export interface LoadedDocs {
  manifest: unknown;
  cutplan: unknown;
  transcript: unknown;
  overlays: unknown;
  bgm: unknown;
  chapters: unknown;
  meta: unknown;
  thumbnail: unknown;
}

export function validate(dir: string, cfg?: Config): ValidateResult {
  const preErrors: Problem[] = [];
  /** JSON を読む。無ければ null、壊れていればエラーに積んで null */
  const readJson = (file: string, required: boolean): unknown => {
    const p = join(dir, file);
    if (!existsSync(p)) {
      if (required) {
        preErrors.push({
          file,
          where: "-",
          message: `${cliCmd()} editor <dir> でベースメディアを選んでください`,
        });
      }
      return null;
    }
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      preErrors.push({ file, where: "-", message: `JSON として読めません: ${(e as Error).message}` });
      return null;
    }
  };
  const docs: LoadedDocs = {
    manifest: readJson("manifest.json", true),
    cutplan: readJson("cutplan.json", true),
    transcript: readJson("transcript.json", true),
    overlays: readJson("overlays.json", false),
    bgm: readJson("bgm.json", false),
    chapters: readJson("chapters.json", false),
    meta: readJson("meta.json", false),
    thumbnail: readJson("thumbnail.json", false),
  };
  const result = validateDocs(dir, docs, preErrors, cfg);
  if (existsSync(join(dir, "shorts.json"))) {
    result.warnings.push({
      file: "shorts.json",
      where: "-",
      message:
        "shorts.json は使われなくなりました(ショート機能は削除されました)。\n" +
        "  縦動画は「9:16 のプロジェクトを新しく作る」形で作成します。\n" +
        "  この収録の shorts.json / shorts/ / cut.*.mp4 は FrameWright が触らなくなるため、\n" +
        "  不要なら手で削除してください。",
    });
  }
  // 承認レコード(approvals.json)の陳腐化警告は fs 版ラッパにだけ足す
  // (approvals.json は validateDocs の LoadedDocs に含まれない=純関数のままにする)。
  // 既に error があるプロジェクトでは cutplan の形が保証されないため
  // スキップする(新たな error は出さない・警告どまりの方針を守る)
  if (result.errors.length === 0) checkApprovalFreshness(dir, docs, result.warnings);
  // frames の stale-PNG 罠対策(設計 docs/plans/2026-07-07-frames-server-design.md
  // 課題1)。frames/index.json は生JSONの内容ハッシュだけを見るため、
  // errors の有無に関わらず判定できる(承認鮮度チェックと違い docs の形に
  // 依存しない)
  checkFramesFreshness(dir, result.warnings);
  return result;
}

/**
 * frames/index.json(撮影入力のフィンガープリント)が現在の編集 JSON と
 * 食い違っていれば警告する。`none`(未撮影・機能導入前)は警告しない
 * (isProxyStale と同じ「未生成→陳腐化ではない」の判断)。config.yaml の
 * 変更はこの検出の対象外(既知の限界。設計 §論点1-B)
 */
function checkFramesFreshness(dir: string, warnings: Problem[]): void {
  const freshness = framesFreshness(dir);
  if (freshness.state !== "stale") return;
  warnings.push({
    file: "frames/index.json",
    where: "-",
    message:
      `frames は撮影後に ${freshness.changed.join("、")} が変更されており古い可能性があります。` +
      `古い PNG を読まないよう \`${cliCmd()} frames <dir> ...\` で撮り直してください` +
      "(config.yaml の変更はこの検出の対象外です)",
  });
}

/**
 * approved:true(人間の承認意図)なのに、承認レコード(approvals.json)が
 * 無い・陳腐化している(hash 不一致)ケースを警告する。render はこの状態を
 * 拒否するので、render を待たずに JSON 編集ループ(edit → validate)の中で
 * 気づけるようにする(§7)。exit 0 の警告どまり(既存の valid なプロジェクトに
 * 新たな error は出さない)。
 */
function checkApprovalFreshness(
  dir: string,
  docs: LoadedDocs,
  warnings: Problem[],
): void {
  const cutplan = docs.cutplan;
  if (isObj(cutplan) && cutplan.approved === true && Array.isArray(cutplan.segments)) {
    const gate = isCutplanApproved(dir, cutplan as unknown as CutPlan);
    if (!gate.ok) {
      warnings.push({
        file: "cutplan.json",
        where: "approved",
        message:
          `approved: true ですが承認レコードが無効です(${gate.reason})。` +
          "この状態では render は拒否されます。preview で確認のうえ " +
          `\`${cliCmd()} approve <dir>\` で再承認してください`,
      });
    }
  }
}

/**
 * パース済みの編集ドキュメントを検査する純関数。dir は overlays の file 参照の
 * 存在チェックにだけ使う。preErrors には呼び出し側が拾った読み込みエラー
 * (必須ファイルの欠落・JSON 破損)を渡す(検査結果の errors 先頭に積まれる)。
 */
export function validateDocs(
  dir: string,
  docs: LoadedDocs,
  preErrors: Problem[] = [],
  cfg?: Config,
): ValidateResult {
  const errors: Problem[] = [...preErrors];
  const warnings: Problem[] = [];
  const stillsCfg = cfg ? resolveStillsCfg(cfg) : {
    defaultDurationSec: 5,
    maxShareWarnRatio: 0.5,
  };
  const err = (file: string, where: string, message: string): void => {
    errors.push({ file, where, message });
  };
  const warn = (file: string, where: string, message: string): void => {
    warnings.push({ file, where, message });
  };

  /** overlays の effectReasonId は未知/系不整合を警告に留める。
   * 人間が型だけ戻した履歴を保持できる一方、非文字列は構造破損なので error。 */
  const checkEffectReasonId = (
    file: string,
    where: string,
    value: unknown,
    // null = 系を持たない配置(texts)。未知 id の警告と非文字列のエラーだけ効かせる
    actualFamily: Exclude<EffectReasonFamily, "none"> | null,
  ): void => {
    if (value === undefined) return;
    if (typeof value !== "string") {
      err(file, `${where}.reasonId`, "reasonId は文字列です");
      return;
    }
    if (!(EFFECT_REASON_IDS as readonly string[]).includes(value)) {
      warn(
        file,
        `${where}.reasonId`,
        `未知の演出分類 id です(docs/edit-skills/effects/recipes/ にある id を使ってください): "${value}"`,
      );
      return;
    }
    const expectedFamily = EFFECT_REASON_ID_FAMILY[value as EffectReasonId];
    if (actualFamily !== null && expectedFamily !== actualFamily) {
      warn(
        file,
        `${where}.reasonId`,
        `演出分類 "${value}" は ${expectedFamily} 系ですが配置は ${actualFamily} です(AI の判断を人間が戻した可能性)`,
      );
    }
  };

  const { cutplan, transcript, overlays, bgm, chapters, meta, thumbnail } = docs;
  const manifest = docs.manifest as Manifest | null;
  const duration = manifest?.durationSec;
  if (manifest && !isNum(duration)) {
    err("manifest.json", "durationSec", "数値ではありません(ingest をやり直してください)");
  }
  const dur = isNum(duration) ? duration : null;
  const canvasValid = manifest?.canvas === undefined || isCanvasPreset(manifest.canvas);
  const outputRegion = manifest?.video && canvasValid ? outputSize(manifest) : null;
  /** ワイプ(カメラ)を持つレイアウトか。manifest / video 欠落時は obs-canvas
   * 扱い(欠落自体は他の検査が拾う。durationSec 検査と同じ他フィールドは
   * 未定義でも構わない緩さ) */
  const cameraPresent = manifest?.video ? hasCamera(manifest) : true;
  if (manifest?.layout !== undefined && !["obs-canvas", "plain", "stills"].includes(manifest.layout)) {
    err("manifest.json", "layout", `layout は obs-canvas / plain / stills のいずれかです: ${JSON.stringify(manifest.layout)}`);
  }
  if (manifest?.canvas !== undefined && !isCanvasPreset(manifest.canvas)) {
    err("manifest.json", "canvas", `未知の canvas 名です: ${JSON.stringify(manifest.canvas)}`);
  }
  if (manifest?.baseLayout !== undefined && !isBaseLayoutPreset(manifest.baseLayout)) {
    err("manifest.json", "baseLayout", `未知の baseLayout 名です: ${JSON.stringify(manifest.baseLayout)}`);
  }
  if (
    manifest?.baseLayout !== undefined &&
    isBaseLayoutPreset(manifest.baseLayout) &&
    (manifest.baseLayout === "camera" || manifest.baseLayout === "stack") &&
    !cameraPresent
  ) {
    err(
      "manifest.json",
      "baseLayout",
      `この収録にはカメラがありません(layout: ${manifestLayout(manifest)})。` +
        `baseLayout ${manifest.baseLayout} は camera 領域を持つ obs-canvas 収録でだけ使えます`,
    );
  }
  if (manifest?.layout === "stills" && manifest.video?.cameraRegion !== undefined) {
    err("manifest.json", "video.cameraRegion", "映像なしプロジェクトにカメラ領域は持てません");
  }

  /* ---------------- cutplan.json ---------------- */

  const counts = { keep: 0, cut: 0, captions: 0, overlays: 0, bgm: 0 };
  let keeps: Interval[] = [];
  let playbackKeeps: { start: number; end: number; speed: number }[] = [];
  if (isObj(cutplan)) {
    const f = "cutplan.json";
    if (typeof cutplan.approved !== "boolean") {
      err(f, "approved", "true / false のどちらかにしてください");
    }
    if (!Array.isArray(cutplan.segments)) {
      err(f, "segments", "配列ではありません");
    } else {
      cutplan.segments.forEach((s: unknown, i: number) => {
        const w = `segments[${i}]`;
        if (!isObj(s)) return err(f, w, "オブジェクトではありません");
        checkSpan(f, w, s, dur, err);
        if (s.action !== "keep" && s.action !== "cut") {
          err(f, w, `action は "keep" か "cut" です(現在: ${JSON.stringify(s.action)})`);
        }
        if (s.speed !== undefined) {
          if (!isNum(s.speed) || !Number.isFinite(s.speed)) {
            err(f, `${w}.speed`, `speed は ${MIN_PLAYBACK_SPEED}〜${MAX_PLAYBACK_SPEED} の数値です`);
          } else if (s.speed < MIN_PLAYBACK_SPEED || s.speed > MAX_PLAYBACK_SPEED) {
            err(f, `${w}.speed`, `speed は ${MIN_PLAYBACK_SPEED}〜${MAX_PLAYBACK_SPEED} にしてください`);
          } else if (s.action === "cut") {
            err(f, `${w}.speed`, "cut segment に speed は指定できません");
          } else {
            if (s.speed < 0.5) warn(f, `${w}.speed`, "speed < 0.5 は補間なしのためカクつく可能性があります");
            if (s.speed > 2) warn(f, `${w}.speed`, "speed > 2 は声が聞き取りづらくなる可能性があります");
            if (isNum(s.start) && isNum(s.end) && (s.end - s.start) / s.speed < 0.1) {
              warn(f, `${w}.speed`, "速度変更後の出力区間が 0.1 秒未満です");
            }
          }
        }
        if (typeof s.reason !== "string") {
          warn(f, w, "reason(人間が確認するための説明)がありません");
        }
        if (s.reasonId !== undefined) {
          if (typeof s.reasonId !== "string") {
            err(f, `${w}.reasonId`, "reasonId は文字列です");
          } else if (!(CUT_REASON_IDS as readonly string[]).includes(s.reasonId)) {
            warn(
              f,
              `${w}.reasonId`,
              `未知の分類 id です(docs/edit-skills/cut/recipes/ にある id を使ってください): "${s.reasonId}"`,
            );
          } else {
            const family = REASON_ID_FAMILY[s.reasonId as CutReasonId];
            if (family === "cut" && s.action === "keep") {
              warn(
                f,
                `${w}.reasonId`,
                `分類 "${s.reasonId}" は切る系ですが action は keep です(AI の判断を人間が戻した可能性)`,
              );
            } else if (family === "keep" && s.action === "cut") {
              warn(f, `${w}.reasonId`, `分類 "${s.reasonId}" は残す系ですが action は cut です`);
            }
          }
        }
      });
      const segs = cutplan.segments.filter(
        (s: unknown): s is { start: number; end: number; action: "keep" | "cut"; reason?: string; speed?: number; id?: string } =>
          isObj(s) &&
          isNum(s.start) &&
          isNum(s.end) &&
          s.start < s.end &&
          (s.action === "keep" || s.action === "cut"),
      );
      keeps = segs.filter((s) => s.action === "keep");
      playbackKeeps = errors.length === 0
        ? playbackSegmentsOf({
            approved: cutplan.approved === true,
            segments: segs.map((s) => ({ ...s, reason: s.reason ?? "" })),
          })
        : [];
      counts.keep = keeps.length;
      counts.cut = segs.length - keeps.length;
      if (keeps.length === 0) {
        err(f, "segments", "keep 区間が1つもありません(すべてカットすると動画が空になります)");
      }
      // keep は時系列順かつ重なりなし(timeline の写像とffmpegの結合の前提)
      for (let i = 1; i < keeps.length; i++) {
        const prev = keeps[i - 1];
        const cur = keeps[i];
        if (cur.start < prev.start) {
          err(f, `segments`, `keep 区間が時系列順ではありません(${fmtT(prev.start)} の後に ${fmtT(cur.start)})`);
        } else if (cur.start < prev.end - EPS) {
          err(f, `segments`, `keep 区間が重なっています(${fmtT(prev.start)}–${fmtT(prev.end)} と ${fmtT(cur.start)}–${fmtT(cur.end)})`);
        }
      }
    }
  } else if (cutplan !== null) {
    err("cutplan.json", "-", "オブジェクトではありません");
  }

  // テロップ・演出の「カット内で表示されない」警告に使う時刻写像。
  // 挿入(overlays.inserts)は出力タイムラインを伸ばすので renderProps と同じく
  // 挿入込みで組む。壊れた insert 要素は insertSpansOf で落とす。
  const insertSpans = isObj(overlays) && Array.isArray((overlays as { inserts?: unknown }).inserts)
    ? insertSpansOf((overlays as { inserts?: { at?: unknown; durationSec?: unknown }[] }).inserts)
    : [];
  const built = errors.length === 0 && playbackKeeps.length > 0
    ? buildTimelineModel(playbackKeeps, insertSpans)
    : null;
  const timeline: TimelineEntry[] | null = built ? built.entries : null;
  /** 出力(カット後・挿入込み)の総尺。S1/S2 の検証がこれを使う */
  const outputDurationSec: number | null = built ? built.durationSec : null;
  /** 区間がカット後の動画に一瞬でも現れるか(写像が作れないときは true 扱い) */
  const visible = (start: number, end: number): boolean =>
    !timeline || remapInterval(start, end, timeline).length > 0;
  /** 区間がカット後の動画に実際に映る秒数(写像が作れないときは区間長)。
   * フェードの長すぎ警告は元収録の区間長ではなくこちらで判定する
   * (途中がカットされて表示が縮んでいるケースを拾う) */
  const visibleSec = (start: number, end: number): number =>
    timeline
      ? remapInterval(start, end, timeline).reduce((s, iv) => s + (iv.end - iv.start), 0)
      : end - start;

  /* ---------------- transcript.json ---------------- */

  if (isObj(transcript)) {
    const f = "transcript.json";
    if (!Array.isArray(transcript.segments)) {
      err(f, "segments", "配列ではありません");
    } else {
      counts.captions = transcript.segments.length;
      if (transcript.generatedBy === "transcribe" && transcript.segments.length > 0) {
        warn(
          f, "-",
          "文字起こしはあるがテロップとして未採用です(このままレンダーするとテロップは出ません)",
        );
      }
      transcript.segments.forEach((s: unknown, i: number) => {
        const w = `segments[${i}]`;
        if (!isObj(s)) return err(f, w, "オブジェクトではありません");
        checkSpan(f, w, s, dur, err, warn);
        if (typeof s.text !== "string" || s.text === "") {
          warn(f, w, "text が空です(表示されないテロップ)");
        }
        if (s.track !== undefined && !isPosInt(s.track)) {
          err(f, w, `track は 1 以上の整数です(現在: ${JSON.stringify(s.track)})`);
        }
        if (s.pos !== undefined && !(isObj(s.pos) && isNum(s.pos.x) && isNum(s.pos.y))) {
          err(f, w, `pos は {x, y}(出力px の数値)です(現在: ${JSON.stringify(s.pos)})`);
        }
        checkStyle(f, w, s.style, err, warn);
        if (isNum(s.start) && isNum(s.end) && s.start < s.end && !visible(s.start, s.end)) {
          warn(f, w, `全体がカット区間内にあり表示されません(${fmtT(s.start)}–${fmtT(s.end)}「${String(s.text).slice(0, 12)}」)`);
        }
        checkWords(
          f, w,
          isNum(s.start) && isNum(s.end) && s.start < s.end ? { start: s.start, end: s.end } : null,
          s.words, err, warn,
        );
        // karaoke 指定だが words[] が無い/空 → 通常表示にフォールバックするだけ
        // (壊れない)なので警告にとどめる。checkStyle は words を知らないので
        // ここで(このセグメント個別の karaoke 指定のときだけ)確認する。
        // トラック標準(captionTracks)側の karaoke は各セグメントの words 有無に
        // 依存するため対象外(過検出を避ける)
        if (
          isObj(s.style) && isObj(s.style.karaoke) &&
          !(Array.isArray(s.words) && s.words.length > 0)
        ) {
          warn(
            f, w,
            "karaoke 指定がありますが words[] がありません(通常表示になります。" +
              "config の whisper.wordTimestamps を true にして transcribe し直してください)",
          );
        }
      });
      if (
        transcript.segments.length > 0 &&
        !transcriptHasWords(transcript as unknown as Transcript)
      ) {
        warn(
          f, "-",
          "transcript.json に語タイムスタンプ(words)がありません。config の " +
            "whisper.wordTimestamps は既定 true ですが、この収録は words 無しで " +
            "transcribe されています。語境界カット(C1)・カラオケを使うには " +
            "transcribe し直してください",
        );
      }
    }
  } else if (transcript !== null) {
    err("transcript.json", "-", "オブジェクトではありません");
  }

  /* ---------------- overlays.json ---------------- */

  if (isObj(overlays)) {
    const f = "overlays.json";
    const KNOWN = [
      "overlays", "inserts", "wipeFull", "wipeStyle", "layerOrder", "captionTracks",
      "hideCaption", "zooms", "colorFilter", "blurs", "annotations", "texts",
    ];
    for (const k of Object.keys(overlays)) {
      if (!KNOWN.includes(k)) warn(f, k, `不明なキーです(有効: ${KNOWN.join(" / ")})`);
    }

    const checkFile = (w: string, file: unknown): void => {
      if (typeof file !== "string" || file === "") {
        return err(f, w, "file(収録フォルダからの相対パス)がありません");
      }
      const abs = normalize(join(dir, file));
      if (!abs.startsWith(resolve(dir) + sep)) {
        err(f, w, `file が収録フォルダの外を指しています: ${file}`);
      } else if (!existsSync(abs)) {
        err(f, w, `素材ファイルがありません: ${file}`);
      }
    };
    const checkFit = (w: string, fit: unknown): void => {
      if (fit !== undefined && fit !== "contain" && fit !== "cover") {
        err(f, w, `fit は "contain" か "cover" です(現在: ${JSON.stringify(fit)})`);
      }
    };
    /** overlays / inserts 共通の再生系オプション(頭出し・音量・フェード)の検査。
     * spanSec = 表示される長さ(フェードの長すぎ警告用。不明なら null) */
    const checkPlayback = (
      w: string,
      o: Record<string, unknown>,
      spanSec: number | null,
    ): void => {
      if (o.startFrom !== undefined) {
        if (!isNum(o.startFrom) || o.startFrom < 0) {
          err(f, w, `startFrom(頭出し・素材内の開始秒)は0以上の数です: ${JSON.stringify(o.startFrom)}`);
        } else if (o.startFrom > 0 && typeof o.file === "string" && isImageFile(o.file)) {
          warn(f, w, "startFrom は動画素材のみ有効です(画像では無視されます)");
        }
      }
      if (o.volume !== undefined) {
        if (!isNum(o.volume) || o.volume < 0 || o.volume > 2) {
          err(f, w, `volume は 0〜2 の数値です(1=素材のまま。現在: ${JSON.stringify(o.volume)})`);
        } else if (typeof o.file === "string" && isImageFile(o.file)) {
          warn(f, w, "画像素材に音声はありません(volume は無視されます)");
        }
      }
      let fadeSum = 0;
      for (const k of ["fadeInSec", "fadeOutSec"] as const) {
        if (o[k] === undefined) continue;
        if (!isNum(o[k]) || (o[k] as number) < 0) {
          err(f, w, `${k}(フェード秒)は0以上の数です: ${JSON.stringify(o[k])}`);
        } else {
          fadeSum += o[k] as number;
        }
      }
      if (spanSec !== null && fadeSum > spanSec + EPS) {
        warn(f, w, `フェード(${fmtT(fadeSum)})が表示時間(${fmtT(spanSec)})より長く、素材が最後まで明るくなりません`);
      }
    };

    if (overlays.overlays !== undefined && !Array.isArray(overlays.overlays)) {
      err(f, "overlays", "配列ではありません");
    }
    (Array.isArray(overlays.overlays) ? overlays.overlays : []).forEach(
      (o: unknown, i: number) => {
        const w = `overlays[${i}]`;
        if (!isObj(o)) return err(f, w, "オブジェクトではありません");
        counts.overlays++;
        checkSpan(f, w, o, dur, err, warn);
        checkFile(w, o.file);
        checkFit(w, o.fit);
        checkPlayback(
          w,
          o,
          // 実際に映る秒数で判定(全体がカット内 = 0 のときは下の
          // 「表示されません」警告に任せ、フェード警告は重ねない)
          isNum(o.start) && isNum(o.end) && o.start < o.end && visibleSec(o.start, o.end) > EPS
            ? visibleSec(o.start, o.end)
            : null,
        );
        if (o.track !== undefined && !isPosInt(o.track)) {
          err(f, w, `track は 1 以上の整数です(現在: ${JSON.stringify(o.track)})`);
        }
        if (o.layer !== undefined && o.layer !== "under" && o.layer !== "over") {
          err(f, w, `layer は "under" か "over" です(現在: ${JSON.stringify(o.layer)})`);
        }
        if (o.opacity !== undefined && (!isNum(o.opacity) || o.opacity < 0 || o.opacity > 1)) {
          err(f, w, `opacity は 0〜1 の数値です(現在: ${JSON.stringify(o.opacity)})`);
        } else if (o.opacity === 0) {
          warn(f, w, "opacity が 0 のため表示されません(消したいならエントリごと削除を)");
        }
        const r = o.rect;
        if (r !== undefined) {
          if (!isObj(r) || !isNum(r.x) || !isNum(r.y) || !isNum(r.w) || !isNum(r.h)) {
            err(f, w, `rect は {x, y, w, h}(出力px の数値)です(現在: ${JSON.stringify(r)})`);
          } else if (r.w <= 0 || r.h <= 0) {
            err(f, w, `rect の w / h は正の数です(現在: ${r.w} x ${r.h})`);
          }
        }
        if (isObj(o) && isNum(o.start) && isNum(o.end) && o.start < o.end && !visible(o.start, o.end)) {
          warn(f, w, `全体がカット区間内にあり表示されません(${fmtT(o.start)}–${fmtT(o.end)})`);
        }
      },
    );

    if (overlays.inserts !== undefined && !Array.isArray(overlays.inserts)) {
      err(f, "inserts", "配列ではありません");
    }
    (Array.isArray(overlays.inserts) ? overlays.inserts : []).forEach(
      (o: unknown, i: number) => {
        const w = `inserts[${i}]`;
        if (!isObj(o)) return err(f, w, "オブジェクトではありません");
        if (!isNum(o.at) || o.at < 0) {
          err(f, w, `at(挿入位置・元収録の秒)が不正です: ${JSON.stringify(o.at)}`);
        } else if (dur !== null && o.at > dur + DUR_EPS) {
          err(f, w, `at(${fmtT(o.at)})が収録の長さ(${fmtT(dur)})を超えています`);
        }
        if (!isNum(o.durationSec) || o.durationSec <= 0) {
          err(f, w, `durationSec(挿入する尺)は正の数です: ${JSON.stringify(o.durationSec)}`);
        }
        if (
          stillsCfg.maxShareWarnRatio > 0 &&
          outputDurationSec !== null &&
          outputDurationSec > 0 &&
          isNum(o.durationSec) &&
          o.durationSec / outputDurationSec > stillsCfg.maxShareWarnRatio
        ) {
          warn(
            f,
            w,
            `durationSec(${fmtT(o.durationSec)})が出力尺(${fmtT(outputDurationSec)})の` +
              `${Math.round((o.durationSec / outputDurationSec) * 100)}%を占めます` +
              `(桁の書き間違いでなければ無視してください)`,
          );
        }
        checkPlayback(w, o, isNum(o.durationSec) && o.durationSec > 0 ? o.durationSec : null);
        checkFile(w, o.file);
        checkFit(w, o.fit);
      },
    );
    if (
      insertSpans.length > 0 &&
      playbackKeeps.some((keep) => keep.speed !== DEFAULT_PLAYBACK_SPEED)
    ) {
      err(
        f,
        "inserts",
        "挿入クリップと可変速 keep は併用できません(音声ベッドを組み立てられません)。" +
          "挿入を消すか、keep の speed を 1 に戻してください",
      );
    }

    for (const key of ["wipeFull", "hideCaption"] as const) {
      if (overlays[key] !== undefined && !Array.isArray(overlays[key])) {
        err(f, key, "配列ではありません");
        continue;
      }
      (Array.isArray(overlays[key]) ? (overlays[key] as unknown[]) : []).forEach(
        (o: unknown, i: number) => {
          const w = `${key}[${i}]`;
          if (!isObj(o)) return err(f, w, "オブジェクトではありません");
          checkSpan(f, w, o, dur, err, warn);
          if (key === "wipeFull") {
            for (const transitionKey of [
              "transitionSec", "transitionInSec", "transitionOutSec",
            ] as const) {
              if (o[transitionKey] !== undefined &&
                  (!isNum(o[transitionKey]) || o[transitionKey] < 0)) {
                err(f, `${w}.${transitionKey}`, `${transitionKey} は0以上の数値です`);
              }
            }
          }
        },
      );
    }
    // plain(カメラ無し)にはワイプの crop 元が無いため wipeFull は使えない
    if (!cameraPresent && Array.isArray(overlays.wipeFull) && overlays.wipeFull.length > 0) {
      err(f, "wipeFull", "plain 動画にはカメラ(ワイプ)が無いため wipeFull は使えません");
    }

    if (overlays.wipeStyle !== undefined) {
      const w = "wipeStyle";
      const style = overlays.wipeStyle;
      const anchors: WipeAnchor[] = [
        "top-left", "top", "top-right", "left",
        "right", "bottom-left", "bottom", "bottom-right",
      ];
      if (!isObj(style)) {
        err(f, w, "オブジェクトではありません");
      } else {
        for (const k of ["anchor", "marginPx", "sizePx", "radiusPx", "shadow"]) {
          if (!(k in style)) err(f, `${w}.${k}`, "必須項目です");
        }
        if (!anchors.includes(style.anchor as WipeAnchor)) {
          err(f, `${w}.anchor`, `anchor は中央以外の8位置です(現在: ${JSON.stringify(style.anchor)})`);
        }
        if (!isNum(style.marginPx) || style.marginPx < 0) {
          err(f, `${w}.marginPx`, "marginPx は有限の0以上の数値です");
        }
        if (!isNum(style.sizePx) || style.sizePx <= 0) {
          err(f, `${w}.sizePx`, "sizePx は有限の正の数値です");
        }
        if (!isNum(style.radiusPx) || style.radiusPx < 0) {
          err(f, `${w}.radiusPx`, "radiusPx は有限の0以上の数値です");
        }
        if (typeof style.shadow !== "boolean") {
          err(f, `${w}.shadow`, "shadow は boolean です");
        }
        if (isNum(style.radiusPx) && isNum(style.sizePx) && style.radiusPx > style.sizePx / 2) {
          err(f, `${w}.radiusPx`, "radiusPx は sizePx / 2 以下です");
        }
        if (outputRegion && anchors.includes(style.anchor as WipeAnchor) && isNum(style.marginPx) && isNum(style.sizePx)) {
          const { w: outW, h: outH } = outputRegion;
          const s = style.sizePx;
          const m = style.marginPx;
          const anchor = style.anchor as WipeAnchor;
          const x = anchor.endsWith("left")
            ? m
            : anchor.endsWith("right")
              ? outW - m - s
              : Math.round((outW - s) / 2);
          const y = anchor.startsWith("top")
            ? m
            : anchor.startsWith("bottom")
              ? outH - m - s
              : Math.round((outH - s) / 2);
          if (x < 0 || y < 0 || x + s > outW || y + s > outH) {
            err(f, w, `矩形が出力解像度(${outW}x${outH})の外にはみ出しています`);
          }
        }
        if (!cameraPresent) {
          warn(f, w, "この録画にはcameraRegionがないためwipeStyleは描画されません");
        }
      }
    }

    if (overlays.zooms !== undefined && !Array.isArray(overlays.zooms)) {
      err(f, "zooms", "配列ではありません");
    }
    const zoomSpans: { start: number; end: number }[] = [];
    // E5(密度ガード・軽量版)用: zoom/blur/annotation の有効区間をここへ集める。
    // 見せ場(highlightSpans)による抑制はしない(それは `effect-check` の仕事。
    // validate は本数だけを見る数ミリ秒の軽量版。§設計書 §3 C)
    const densitySpans: { start: number; end: number }[] = [];
    const checkPoint = (p: unknown): p is { x: number; y: number } =>
      isObj(p) && isNum(p.x) && isNum(p.y);
    const checkOutOfBounds = (rw: string, x: number, y: number): void => {
      if (!outputRegion) return;
      const { w: outW, h: outH } = outputRegion;
      if (x < 0 || y < 0 || x > outW || y > outH) {
        warn(f, rw, `座標(x${x} y${y})が出力解像度(${outW}x${outH})の外です(画面外から指す等の意図的な用途もあります)`);
      }
    };
    (Array.isArray(overlays.zooms) ? overlays.zooms : []).forEach((z: unknown, i: number) => {
      const w = `zooms[${i}]`;
      if (!isObj(z)) return err(f, w, "オブジェクトではありません");
      checkEffectReasonId(f, w, z.reasonId, "zoom");
      // start<end・収録尺内はどちらもエラー(warn を渡さない。ズームは背景
      // レイヤー全体に効くため、overlays/wipeFull より厳しく扱う)
      checkSpan(f, w, z, dur, err);
      const r = z.rect;
      if (!isObj(r) || !isNum(r.x) || !isNum(r.y) || !isNum(r.w) || !isNum(r.h)) {
        err(f, w, `rect は {x, y, w, h}(出力px の数値)です(現在: ${JSON.stringify(r)})`);
      } else if (r.w <= 0 || r.h <= 0) {
        err(f, w, `rect の w / h は正の数です(現在: ${r.w} x ${r.h})`);
      } else {
        if (outputRegion) {
          const { w: outW, h: outH } = outputRegion;
          if (r.x < 0 || r.y < 0 || r.x + r.w > outW || r.y + r.h > outH) {
            err(
              f, w,
              `rect が出力解像度(${outW}x${outH})の外にはみ出しています` +
                `(現在: x${r.x} y${r.y} w${r.w} h${r.h})`,
            );
          }
          const rectAr = r.w / r.h;
          const outAr = outW / outH;
          if (Math.abs(rectAr / outAr - 1) > 0.01) {
            warn(
              f, w,
              `rect のアスペクト比(${rectAr.toFixed(2)})が出力(${outAr.toFixed(2)})と` +
                "1%を超えてずれています(拡大後に歪んで見えることがあります)",
            );
          }
          const scale = outW / r.w;
          if (scale > 8) {
            warn(f, w, `拡大率(${scale.toFixed(1)}倍)が大きすぎます(rect.w=${r.w})。画質が粗くなることがあります`);
          }
        }
        if (isNum(z.start) && isNum(z.end) && z.start < z.end) {
          zoomSpans.push({ start: z.start, end: z.end });
          densitySpans.push({ start: z.start, end: z.end });
        }
      }
      if (z.easeSec !== undefined && (!isNum(z.easeSec) || z.easeSec < 0)) {
        err(f, w, `easeSec(遷移秒数)は0以上の数です(現在: ${JSON.stringify(z.easeSec)})`);
      }
      if (z.easeOutSec !== undefined && (!isNum(z.easeOutSec) || z.easeOutSec < 0)) {
        err(f, w, `easeOutSec(退出遷移秒数)は0以上の数です(現在: ${JSON.stringify(z.easeOutSec)})`);
      }
      if (z.focusMode !== undefined && z.focusMode !== "manual" && z.focusMode !== "auto") {
        err(f, w, `focusMode は "manual" か "auto" です(現在: ${JSON.stringify(z.focusMode)})`);
      }
      if (
        z.depth !== undefined &&
        (!isNum(z.depth) || !Number.isInteger(z.depth) || z.depth < 1 || z.depth > 6)
      ) {
        err(f, w, `depth は 1〜6 の整数です(現在: ${JSON.stringify(z.depth)})`);
      }
      if (
        z.customScale !== undefined &&
        (!isNum(z.customScale) || z.customScale < 1.0 || z.customScale > 5.0)
      ) {
        err(f, w, `customScale は 1.0〜5.0 の数値です(現在: ${JSON.stringify(z.customScale)})`);
      }
    });
    // 重なり禁止(エラー)。ユーザーが時系列順に書くとは限らないので開始時刻でソートしてから隣接比較
    const sortedZooms = [...zoomSpans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sortedZooms.length; i++) {
      const prev = sortedZooms[i - 1];
      const cur = sortedZooms[i];
      if (cur.start < prev.end - EPS) {
        err(
          f, "zooms",
          `ズーム区間が重なっています(${fmtT(prev.start)}–${fmtT(prev.end)} と ${fmtT(cur.start)}–${fmtT(cur.end)})`,
        );
      }
    }

    if (overlays.blurs !== undefined && !Array.isArray(overlays.blurs)) {
      err(f, "blurs", "配列ではありません");
    }
    (Array.isArray(overlays.blurs) ? overlays.blurs : []).forEach((b: unknown, i: number) => {
      const w = `blurs[${i}]`;
      if (!isObj(b)) return err(f, w, "オブジェクトではありません");
      checkEffectReasonId(f, w, b.reasonId, "blur");
      // start<end・収録尺内はどちらもエラー(warn を渡さない。秘匿目隠しは
      // zooms と同じ厳しさで扱う)
      checkSpan(f, w, b, dur, err);
      const r = b.rect;
      if (!isObj(r) || !isNum(r.x) || !isNum(r.y) || !isNum(r.w) || !isNum(r.h)) {
        err(f, w, `rect は {x, y, w, h}(出力px の数値)です(現在: ${JSON.stringify(r)})`);
      } else if (r.w <= 0 || r.h <= 0) {
        err(f, w, `rect の w / h は正の数です(現在: ${r.w} x ${r.h})`);
      } else if (outputRegion) {
        const { w: outW, h: outH } = outputRegion;
        if (r.x < 0 || r.y < 0 || r.x + r.w > outW || r.y + r.h > outH) {
          err(
            f, w,
            `rect が出力解像度(${outW}x${outH})の外にはみ出しています` +
              `(現在: x${r.x} y${r.y} w${r.w} h${r.h})`,
          );
        }
      }
      if (b.strength !== undefined && (!isNum(b.strength) || b.strength < 0 || b.strength > 1)) {
        err(f, w, `strength は 0〜1 の数値です(現在: ${JSON.stringify(b.strength)})`);
      }
      if (isNum(b.start) && isNum(b.end) && b.start < b.end) {
        const bStart = b.start;
        const bEnd = b.end;
        densitySpans.push({ start: bStart, end: bEnd });
        if (!visible(bStart, bEnd)) {
          warn(f, w, `全体がカット区間内にあり表示されません(${fmtT(bStart)}–${fmtT(bEnd)})`);
        }
        // zoom と時間が重なると、blur 矩形が zoom に追従しないため
        // 隠したい情報が矩形からずれて露出しうる(判断4)
        if (zoomSpans.some((z) => bStart < z.end && z.start < bEnd)) {
          warn(
            f, w,
            `zoom 区間と時間が重なっています(${fmtT(bStart)}–${fmtT(bEnd)})。` +
              "blur は zoom に追従しないため、隠したい情報が矩形からずれて見える" +
              "ことがあります(zoom を外すか rect を広げてください)",
          );
        }
      }
    });
    if (overlays.annotations !== undefined && !Array.isArray(overlays.annotations)) {
      err(f, "annotations", "配列ではありません");
    }
    (Array.isArray(overlays.annotations) ? overlays.annotations : []).forEach(
      (a: unknown, i: number) => {
        const w = `annotations[${i}]`;
        if (!isObj(a)) return err(f, w, "オブジェクトではありません");
        checkEffectReasonId(f, w, a.reasonId, "annotation");
        // start<end・収録尺内はどちらもエラー(warn を渡さない。blurs/zooms と
        // 同じ厳しさで扱う)
        checkSpan(f, w, a, dur, err);
        if (isNum(a.start) && isNum(a.end) && a.start < a.end) {
          const aStart = a.start;
          const aEnd = a.end;
          densitySpans.push({ start: aStart, end: aEnd });
          if (!visible(aStart, aEnd)) {
            warn(f, w, `全体がカット区間内にあり表示されません(${fmtT(aStart)}–${fmtT(aEnd)})`);
          }
          // zoom と時間が重なると、annotation も blur と同様に zoom に追従しないため
          // 指したい位置が矩形/座標からずれて見えることがある(E4)
          if (zoomSpans.some((z) => aStart < z.end && z.start < aEnd)) {
            warn(
              f, w,
              `zoom 区間と時間が重なっています(${fmtT(aStart)}–${fmtT(aEnd)})。` +
                "annotation は zoom に追従しないため、指す位置が矩形/座標からずれて見える" +
                "ことがあります(zoom を外すか、zoom の後ろへずらしてください)",
            );
          }
        }
        if (a.type !== "arrow" && a.type !== "box" && a.type !== "spotlight") {
          return err(f, w, `type は "arrow" / "box" / "spotlight" のいずれかです(現在: ${JSON.stringify(a.type)})`);
        }
        if (a.type === "arrow") {
          const from = a.from;
          const to = a.to;
          if (!checkPoint(from)) {
            err(f, w, `from は {x, y}(出力px の数値)です(現在: ${JSON.stringify(from)})`);
          }
          if (!checkPoint(to)) {
            err(f, w, `to は {x, y}(出力px の数値)です(現在: ${JSON.stringify(to)})`);
          }
          if (isObj(from) && isNum(from.x) && isNum(from.y) && isObj(to) && isNum(to.x) && isNum(to.y)) {
            if (Math.hypot(to.x - from.x, to.y - from.y) < EPS) {
              err(f, w, "from と to が同一点です(向きが定まらない退化した矢印)");
            } else {
              checkOutOfBounds(w, from.x, from.y);
              checkOutOfBounds(w, to.x, to.y);
            }
          }
          if (a.color !== undefined && (typeof a.color !== "string" || a.color === "")) {
            err(f, w, `color は CSS カラー文字列です(現在: ${JSON.stringify(a.color)})`);
          }
          for (const k of ["widthPx", "headPx"] as const) {
            if (a[k] !== undefined && (!isNum(a[k]) || (a[k] as number) <= 0)) {
              err(f, w, `${k} は正の数です(現在: ${JSON.stringify(a[k])})`);
            }
          }
        } else {
          // box / spotlight 共通: rect
          const r = a.rect;
          if (!isObj(r) || !isNum(r.x) || !isNum(r.y) || !isNum(r.w) || !isNum(r.h)) {
            err(f, w, `rect は {x, y, w, h}(出力px の数値)です(現在: ${JSON.stringify(r)})`);
          } else if (r.w <= 0 || r.h <= 0) {
            err(f, w, `rect の w / h は正の数です(現在: ${r.w} x ${r.h})`);
          } else if (outputRegion) {
            // はみ出しは blurs と違い警告どまり(画面端でクリップされるだけで
            // render は壊れず、画面外から指す構図もありうるため。決定6)
            const { w: outW, h: outH } = outputRegion;
            if (r.x < 0 || r.y < 0 || r.x + r.w > outW || r.y + r.h > outH) {
              warn(
                f, w,
                `rect が出力解像度(${outW}x${outH})の外にはみ出しています` +
                  `(現在: x${r.x} y${r.y} w${r.w} h${r.h})`,
              );
            }
          }
          if (a.type === "box") {
            for (const k of ["color", "fill"] as const) {
              if (a[k] !== undefined && (typeof a[k] !== "string" || a[k] === "")) {
                err(f, w, `${k} は CSS カラー文字列です(現在: ${JSON.stringify(a[k])})`);
              }
            }
            for (const k of ["widthPx", "radiusPx"] as const) {
              if (a[k] !== undefined && (!isNum(a[k]) || (a[k] as number) < 0)) {
                err(f, w, `${k} は0以上の数です(現在: ${JSON.stringify(a[k])})`);
              }
            }
          } else {
            // spotlight
            if (a.shape !== undefined && a.shape !== "rect" && a.shape !== "ellipse") {
              err(f, w, `shape は "rect" か "ellipse" です(現在: ${JSON.stringify(a.shape)})`);
            }
            if (a.dim !== undefined && (!isNum(a.dim) || a.dim < 0 || a.dim > 1)) {
              err(f, w, `dim は 0〜1 の数値です(現在: ${JSON.stringify(a.dim)})`);
            }
            for (const k of ["featherPx", "radiusPx"] as const) {
              if (a[k] !== undefined && (!isNum(a[k]) || (a[k] as number) < 0)) {
                err(f, w, `${k} は0以上の数です(現在: ${JSON.stringify(a[k])})`);
              }
            }
          }
        }
      },
    );
    if (overlays.texts !== undefined && !Array.isArray(overlays.texts)) {
      err(f, "texts", "配列ではありません");
    }
    (Array.isArray(overlays.texts) ? overlays.texts : []).forEach((t: unknown, i: number) => {
      const w = `texts[${i}]`;
      if (!isObj(t)) return err(f, w, "オブジェクトではありません");
      // texts は「見せる/隠す/指す」のどの系でもないので系の照合はしない
      checkEffectReasonId(f, w, t.reasonId, null);
      checkSpan(f, w, t, dur, err);
      if (typeof t.text !== "string" || t.text.length === 0) {
        err(f, w, "text は空でない文字列です");
      }
      if (t.track !== undefined && (!Number.isInteger(t.track) || (t.track as number) < 1)) {
        err(f, `${w}.track`, "1以上の整数ではありません");
      }
      if (!checkPoint(t.pos)) {
        err(f, w, `pos は {x, y}(出力px の数値)です(現在: ${JSON.stringify(t.pos)})`);
      } else {
        checkOutOfBounds(w, t.pos.x, t.pos.y);
      }
      if (t.anchor !== undefined && t.anchor !== "center" && t.anchor !== "topLeft") {
        err(f, w, `anchor は "center" か "topLeft" です(現在: ${JSON.stringify(t.anchor)})`);
      }
      if (isNum(t.start) && isNum(t.end) && t.start < t.end && !visible(t.start, t.end)) {
        warn(f, w, `全体がカット区間内にあり表示されません(${fmtT(t.start)}–${fmtT(t.end)})`);
      }
      if (isObj(t.style) && t.style.karaoke !== undefined) {
        warn(f, w, "texts は words[] を持たないためカラオケは無視されます");
      }
    });
    // E5(密度ガード・軽量版): zoom/blur/annotation を合わせた開始時刻が
    // densityWindowSec の窓に maxPerWindow を超えて詰まっていたら警告する。
    // 見せ場による抑制・still での確認は `effect-check` に委ねる(§設計書 §3 C)
    {
      const sortedDensity = [...densitySpans].sort((a, b) => a.start - b.start);
      const reportedWindows = new Set<number>();
      for (const anchor of sortedDensity) {
        const windowEnd = anchor.start + DEFAULT_EFFECT_CHECK_DENSITY_WINDOW_SEC;
        const count = sortedDensity.filter((s) => s.start >= anchor.start && s.start < windowEnd).length;
        if (count <= DEFAULT_EFFECT_CHECK_MAX_PER_WINDOW) continue;
        const key = Math.round(anchor.start * 100);
        if (reportedWindows.has(key)) continue;
        reportedWindows.add(key);
        warn(
          f, "overlays",
          `${DEFAULT_EFFECT_CHECK_DENSITY_WINDOW_SEC}秒の窓(${fmtT(anchor.start)}〜)に演出(zoom/blur/annotation)が` +
            `${count}件詰まっています(上限${DEFAULT_EFFECT_CHECK_MAX_PER_WINDOW}件)。密度が高いと視聴体験を損ねる` +
            "ことがあります(詳細な見せ場判定は `effect-check` で確認できます)",
        );
      }
    }
    if (overlays.colorFilter !== undefined) {
      const cfw = "colorFilter";
      if (!isObj(overlays.colorFilter)) {
        err(f, cfw, `オブジェクトです({brightness?, contrast?, saturate?})(現在: ${JSON.stringify(overlays.colorFilter)})`);
      } else {
        const cf = overlays.colorFilter;
        const CF_KEYS = ["brightness", "contrast", "saturate"] as const;
        for (const k of Object.keys(cf)) {
          if (!(CF_KEYS as readonly string[]).includes(k)) {
            warn(f, `${cfw}.${k}`, `不明なキーです(有効: ${CF_KEYS.join(" / ")})`);
          }
        }
        for (const k of CF_KEYS) {
          if (cf[k] !== undefined && (!isNum(cf[k]) || (cf[k] as number) <= 0 || (cf[k] as number) > 3)) {
            err(f, `${cfw}.${k}`, `0 より大きく3以下の数値です(現在: ${JSON.stringify(cf[k])})`);
          }
        }
        if (CF_KEYS.every((k) => cf[k] === undefined)) {
          warn(f, cfw, "brightness / contrast / saturate のいずれも指定されていません(書く意味がありません)");
        }
      }
    }

    if (overlays.layerOrder !== undefined) {
      if (!Array.isArray(overlays.layerOrder)) {
        err(f, "layerOrder", "配列ではありません");
      } else {
        const seen = new Set<string>();
        overlays.layerOrder.forEach((id: unknown, i: number) => {
          const w = `layerOrder[${i}]`;
          if (typeof id !== "string" ||
              (id !== "wipe" && ovNum(id) === null && capNum(id) === null &&
                textNum(id) === null)) {
            return err(
              f,
              w,
              `不明なレイヤーです: ${JSON.stringify(id)}` +
                "(wipe / caption / text / ov<N> / cap<N> / text<N>)",
            );
          }
          if (seen.has(id)) err(f, w, `レイヤーが重複しています: ${id}`);
          seen.add(id);
        });
        if (cameraPresent) {
          if (!seen.has("wipe")) warn(f, "layerOrder", "wipe がありません(ワイプが描画されません)");
        } else if (seen.has("wipe")) {
          warn(f, "layerOrder", "plain 動画にはカメラ(ワイプ)が無いため wipe は無視されます");
        }
        if (!seen.has("caption")) warn(f, "layerOrder", "caption がありません(テロップ T1 が描画されません)");
      }
    }

    checkCaptionTracks(f, "captionTracks", overlays.captionTracks, err, warn);
  } else if (overlays !== null) {
    err("overlays.json", "-", "オブジェクトではありません");
  }

  if (manifest?.layout === "stills") {
    // スライドは全画面 overlay(出力尺を変えない)。inserts は intro/ending の
    // ような「本当に尺を足すクリップ」専用で、スライドには使わない(S3-fix)。
    const slides = isObj(overlays) && Array.isArray(overlays.overlays) ? overlays.overlays : [];
    if (slides.length === 0) {
      warn(
        "overlays.json",
        "overlays",
        "スライド(overlays の全画面画像)が1件もありません。画面が背景だけになります",
      );
    }
    const imageInserts = (isObj(overlays) && Array.isArray(overlays.inserts) ? overlays.inserts : [])
      .filter((o) => isObj(o) && typeof o.file === "string" && isImageFile(o.file));
    if (imageInserts.length > 0 && slides.length === 0) {
      warn(
        "overlays.json",
        "inserts",
        `静止画が inserts に${imageInserts.length}件あります。` +
          "映像なしプロジェクトのスライドは overlays(全画面画像)で置きます" +
          "(inserts は出力尺を伸ばすため、ナレーションより動画が長くなります)",
      );
    }
  }

  /* ---------------- bgm.json ---------------- */

  if (isObj(bgm)) {
    const f = "bgm.json";
    for (const k of Object.keys(bgm)) {
      if (k !== "tracks") warn(f, k, "不明なキーです(有効: tracks)");
    }
    if (bgm.tracks !== undefined && !Array.isArray(bgm.tracks)) {
      err(f, "tracks", "配列ではありません");
    }
    (Array.isArray(bgm.tracks) ? bgm.tracks : []).forEach((t: unknown, i: number) => {
      const w = `tracks[${i}]`;
      if (!isObj(t)) return err(f, w, "オブジェクトではありません");
      counts.bgm++;
      if (t.timebase !== undefined && t.timebase !== "source" && t.timebase !== "output") {
        err(f, w, `timebase は "source" か "output" です: ${JSON.stringify(t.timebase)}`);
      } else if (t.timebase === "output") {
        checkSpan(f, w, t, outputDurationSec, err, warn, "出力の長さ");
      } else {
        checkSpan(f, w, t, dur, err, warn);
      }
      // file: 収録フォルダ内の相対パスで実在すること
      if (typeof t.file !== "string" || t.file === "") {
        err(f, w, "file(収録フォルダからの相対パス)がありません");
      } else {
        const abs = normalize(join(dir, t.file));
        if (!abs.startsWith(resolve(dir) + sep)) {
          err(f, w, `file が収録フォルダの外を指しています: ${t.file}`);
        } else if (!existsSync(abs)) {
          err(f, w, `BGM ファイルがありません: ${t.file}`);
        }
      }
      if (t.volumeDb !== undefined && !isNum(t.volumeDb)) {
        err(f, w, `volumeDb(音量・dB。0=原音量)は数値です: ${JSON.stringify(t.volumeDb)}`);
      }
      if (t.startFrom !== undefined && (!isNum(t.startFrom) || t.startFrom < 0)) {
        err(f, w, `startFrom(頭出し・ファイル内の開始秒)は0以上の数です: ${JSON.stringify(t.startFrom)}`);
      }
      let fadeSum = 0;
      for (const k of ["fadeInSec", "fadeOutSec"] as const) {
        if (t[k] === undefined) continue;
        if (!isNum(t[k]) || (t[k] as number) < 0) {
          err(f, w, `${k}(フェード秒)は0以上の数です: ${JSON.stringify(t[k])}`);
        } else {
          fadeSum += t[k] as number;
        }
      }
      // 実際に流れる秒数(カットで縮む場合を拾う)でフェード長・不表示を判定
      if (isNum(t.start) && isNum(t.end) && t.start < t.end) {
        const played = visibleSec(t.start, t.end);
        if (played <= EPS) {
          warn(f, w, `全体がカット区間内にあり流れません(${fmtT(t.start)}–${fmtT(t.end)})`);
        } else if (fadeSum > played + EPS) {
          warn(f, w, `フェード(${fmtT(fadeSum)})が再生時間(${fmtT(played)})より長く、途中までしか鳴りません`);
        }
      }
    });
  } else if (bgm !== null) {
    err("bgm.json", "-", "オブジェクトではありません");
  }

  /* ---------------- chapters.json / meta.json ---------------- */

  if (isObj(chapters)) {
    const f = "chapters.json";
    if (!Array.isArray(chapters.chapters)) {
      err(f, "chapters", "配列ではありません");
    } else {
      let prev = -1;
      chapters.chapters.forEach((c: unknown, i: number) => {
        const w = `chapters[${i}]`;
        if (!isObj(c)) return err(f, w, "オブジェクトではありません");
        if (!isNum(c.start) || c.start < 0) {
          err(f, w, `start(元収録の秒)が不正です: ${JSON.stringify(c.start)}`);
        } else {
          if (dur !== null && c.start > dur + DUR_EPS) {
            err(f, w, `start(${fmtT(c.start)})が収録の長さ(${fmtT(dur)})を超えています`);
          }
          if (c.start < prev) warn(f, w, "章が時系列順ではありません");
          prev = c.start;
        }
        if (typeof c.title !== "string" || c.title === "") {
          warn(f, w, "title が空です");
        }
      });
    }
  } else if (chapters !== null) {
    err("chapters.json", "-", "オブジェクトではありません");
  }

  if (meta !== null && isObj(meta)) {
    const f = "meta.json";
    if (!Array.isArray(meta.titles) || meta.titles.some((t: unknown) => typeof t !== "string")) {
      warn(f, "titles", "文字列の配列ではありません");
    }
    if (typeof meta.description !== "string") {
      warn(f, "description", "文字列ではありません");
    }
  }

  /* ---------------- thumbnail.json ---------------- */

  if (isObj(thumbnail)) {
    const f = "thumbnail.json";
    // frames と違いスナップしないので、カット区間内かどうかは問わない
    // (収録尺内であればよい)
    if (!isNum(thumbnail.t) || thumbnail.t < 0) {
      err(f, "t", `t(元収録の秒)は0以上の数値です(現在: ${JSON.stringify(thumbnail.t)})`);
    } else if (dur !== null && thumbnail.t > dur + DUR_EPS) {
      err(f, "t", `t(${fmtT(thumbnail.t)})が収録の長さ(${fmtT(dur)})を超えています`);
    }
    if (!Array.isArray(thumbnail.texts) || thumbnail.texts.length === 0) {
      err(f, "texts", "配列で1件以上必要です");
    } else {
      thumbnail.texts.forEach((t: unknown, i: number) => {
        const w = `texts[${i}]`;
        if (!isObj(t)) return err(f, w, "オブジェクトではありません");
        if (typeof t.text !== "string" || t.text === "") {
          err(f, w, "text(表示する文言)が空です");
        }
        if (!isObj(t.pos) || !isNum(t.pos.x) || !isNum(t.pos.y)) {
          err(f, w, `pos は {x, y}(出力px の数値)です(現在: ${JSON.stringify(t.pos)})`);
        }
        checkStyle(f, w, t.style, err, warn);
      });
    }
  } else if (thumbnail !== null && thumbnail !== undefined) {
    err("thumbnail.json", "-", "オブジェクトではありません");
  }

  /* -------- chapters.json ⇔「章」トラックのテロップ の乖離検知 -------- */
  // plan / remeta は概要欄チャプター(chapters.json)と画面表示の章タイトル
  // (transcript の「章」トラックのテロップ)を同じ元から書くが、以降どちらか
  // だけ手編集すると、概要欄と動画内表示のタイトル・位置がずれる。二重管理で
  // 検知手段がなかった食い違いを警告する(動くので警告どまり)
  checkChapterSync(chapters, transcript, overlays, warn);

  /* -------- 安定 id(§docs/plans/2026-07-07-stable-ids-design.md) -------- */
  // id は render に一切影響しない(アドレッシング専用)ため、不備はすべて warn。
  // docs に id が1つも無ければこのブロックは完全に no-op(未使用時バイト等価)
  checkIds(docs, warn);

  const keptSec = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const summary =
    `keep ${counts.keep}区間(${fmtT(keptSec)})+ カット記録 ${counts.cut} / ` +
    `テロップ ${counts.captions} / 素材・演出 ${counts.overlays}` +
    (counts.bgm > 0 ? ` / BGM ${counts.bgm}区間` : "");
  return { errors, warnings, summary };
}

/* ---------------- 共通チェック ---------------- */

/** start / end を持つ区間の共通検査。範囲超えは warn があれば警告、無ければエラー */
function checkSpan(
  file: string,
  where: string,
  s: Record<string, unknown>,
  dur: number | null,
  err: (f: string, w: string, m: string) => void,
  warn?: (f: string, w: string, m: string) => void,
  durLabel = "収録の長さ",
): void {
  if (!isNum(s.start) || !isNum(s.end)) {
    return err(file, where, `start / end が数値ではありません(現在: ${JSON.stringify(s.start)} / ${JSON.stringify(s.end)})`);
  }
  if (s.start < 0) err(file, where, `start が負です: ${s.start}`);
  if (s.start >= s.end) {
    return err(file, where, `start(${fmtT(s.start)})>= end(${fmtT(s.end)})`);
  }
  if (dur !== null && s.end > dur + DUR_EPS) {
    const msg = `end(${fmtT(s.end)})が${durLabel}(${fmtT(dur)})を超えています`;
    if (warn) warn(file, where, msg);
    else err(file, where, msg);
  }
}

/** 章の開始時刻がずれているとみなす猶予(秒)。丸め差は無視する */
const CHAP_EPS = 0.05;

/**
 * 概要欄チャプター(chapters.json)と画面表示の章タイトル(transcript の
 * 「章」トラックのテロップ)の食い違いを警告する。「章」トラックは
 * overlays.captionTracks の name === "章" の track 番号で特定する。
 * タイトルを鍵に突き合わせ、片側にしか無い章・開始位置がずれた章を報告する。
 */
function checkChapterSync(
  chapters: unknown,
  transcript: unknown,
  overlays: unknown,
  warn: (f: string, w: string, m: string) => void,
): void {
  if (!isObj(chapters) || !Array.isArray(chapters.chapters)) return;
  if (!isObj(transcript) || !Array.isArray(transcript.segments)) return;

  const chaps = chapters.chapters
    .filter((c): c is { start: number; title: string } => isObj(c) && isNum(c.start))
    .map((c) => ({ start: c.start, title: typeof c.title === "string" ? c.title.trim() : "" }));

  const tracks =
    isObj(overlays) && Array.isArray(overlays.captionTracks) ? overlays.captionTracks : [];
  const chapDef = tracks.find(
    (t: unknown): t is { track: number } => isObj(t) && t.name === "章" && isPosInt(t.track),
  );
  const chapTrack = chapDef ? chapDef.track : null;
  const telops =
    chapTrack === null
      ? []
      : transcript.segments
          .filter(
            (s: unknown): s is { start: number; text?: unknown } =>
              isObj(s) && isNum(s.start) && captionTrack(s) === chapTrack,
          )
          .map((s) => ({ start: s.start, title: typeof s.text === "string" ? s.text.trim() : "" }));

  if (chaps.length === 0 && telops.length === 0) return;

  const cf = "chapters.json";
  // 章テロップトラックが無い(全部消した)のに概要欄チャプターだけ残っている
  if (chapTrack === null && chaps.length > 0) {
    warn(
      cf,
      "chapters",
      `概要欄チャプターが ${chaps.length} 件ありますが、画面に表示する「章」テロップトラックがありません` +
        "(概要欄と画面表示がずれています。remeta で作り直せます)",
    );
    return;
  }

  const teloByTitle = new Map(telops.map((t) => [t.title, t.start]));
  const chapByTitle = new Map(chaps.map((c) => [c.title, c.start]));
  for (const c of chaps) {
    const at = teloByTitle.get(c.title);
    if (at === undefined) {
      warn(
        cf,
        "chapters",
        `概要欄チャプター「${c.title}」(${fmtT(c.start)})に対応する画面の章テロップがありません` +
          "(概要欄だけ編集した可能性)",
      );
    } else if (Math.abs(at - c.start) >= CHAP_EPS) {
      warn(
        cf,
        "chapters",
        `章「${c.title}」の開始位置が概要欄(${fmtT(c.start)})と画面テロップ(${fmtT(at)})でずれています`,
      );
    }
  }
  for (const t of telops) {
    if (!chapByTitle.has(t.title)) {
      warn(
        "transcript.json",
        "segments",
        `画面の章テロップ「${t.title}」(${fmtT(t.start)})が概要欄チャプター(chapters.json)にありません` +
          "(画面だけ編集した可能性)",
      );
    }
  }
}

/** captionTracks 配列(overlays.json)の検査:
 * track は正整数で重複禁止、anchor は center/topLeft、x/y は数値、
 * style は checkStyle。onEntry があれば妥当なエントリごとに呼び出し側固有の
 * 追加チェックを行う */
function checkCaptionTracks(
  file: string,
  key: string,
  tracks: unknown,
  err: (f: string, w: string, m: string) => void,
  warn?: (f: string, w: string, m: string) => void,
  onEntry?: (t: Record<string, unknown>, where: string) => void,
): void {
  if (tracks === undefined) return;
  if (!Array.isArray(tracks)) {
    err(file, key, "配列ではありません");
    return;
  }
  const seen = new Set<number>();
  tracks.forEach((t: unknown, i: number) => {
    const w = `${key}[${i}]`;
    if (!isObj(t)) return err(file, w, "オブジェクトではありません");
    if (!isPosInt(t.track)) {
      return err(file, w, `track は 1 以上の整数です(現在: ${JSON.stringify(t.track)})`);
    }
    if (seen.has(t.track)) err(file, w, `track ${t.track} の設定が重複しています`);
    seen.add(t.track);
    if (t.anchor !== undefined && t.anchor !== "center" && t.anchor !== "topLeft") {
      err(file, w, `anchor は "center" か "topLeft" です(現在: ${JSON.stringify(t.anchor)})`);
    }
    if ((t.x !== undefined && !isNum(t.x)) || (t.y !== undefined && !isNum(t.y))) {
      err(file, w, "x / y は数値(出力px)です");
    }
    checkStyle(file, w, t.style, err, warn);
    onEntry?.(t, w);
  });
}

/** アニメ種別(CaptionAnimKind)の許可リスト。src/types.ts の型定義と揃える */
const CAPTION_ANIM_KINDS = ["fade", "slide-up", "slide-down", "slide-left", "slide-right", "pop", "none"];

/** テロップの style({fontSizePx, color, outlineColor, outlineWidthPx,
 * fontFamily, fontWeight, background, anim, karaoke})の検査 */
function checkStyle(
  file: string,
  where: string,
  style: unknown,
  err: (f: string, w: string, m: string) => void,
  warn?: (f: string, w: string, m: string) => void,
): void {
  if (style === undefined) return;
  if (!isObj(style)) return err(file, where, `style はオブジェクトです(現在: ${JSON.stringify(style)})`);
  const w = `${where}.style`;
  if (style.fontSizePx !== undefined && (!isNum(style.fontSizePx) || style.fontSizePx <= 0)) {
    err(file, w, `fontSizePx は正の数です(現在: ${JSON.stringify(style.fontSizePx)})`);
  }
  for (const k of ["color", "outlineColor"] as const) {
    if (style[k] !== undefined && (typeof style[k] !== "string" || style[k] === "")) {
      err(file, w, `${k} は CSS カラー文字列です(現在: ${JSON.stringify(style[k])})`);
    }
  }
  if (style.outlineWidthPx !== undefined && (!isNum(style.outlineWidthPx) || style.outlineWidthPx < 0)) {
    err(file, w, `outlineWidthPx は 0 以上の数値です(現在: ${JSON.stringify(style.outlineWidthPx)})`);
  }
  if (style.fontFamily !== undefined && (typeof style.fontFamily !== "string" || style.fontFamily === "")) {
    err(file, w, `fontFamily は CSS フォント指定の文字列です(現在: ${JSON.stringify(style.fontFamily)})`);
  }
  if (
    style.fontWeight !== undefined &&
    (!isNum(style.fontWeight) || style.fontWeight < 100 || style.fontWeight > 900)
  ) {
    err(file, w, `fontWeight は 100〜900 の数値です(現在: ${JSON.stringify(style.fontWeight)})`);
  }
  const bg = style.background;
  // "none" は「下の層(トラック標準 → config の render.captionBackground)から
  // 継承した帯をこの層で明示的に消す」番兵(outlineColor: "none" と同じ流儀)
  if (bg !== undefined && bg !== "none") {
    if (!isObj(bg)) {
      err(file, w, `background はオブジェクト({color, paddingPx?, radiusPx?})か "none"(帯なし)です(現在: ${JSON.stringify(bg)})`);
    } else {
      if (typeof bg.color !== "string" || bg.color === "") {
        err(file, `${w}.background`, `color(帯の CSS カラー)がありません(現在: ${JSON.stringify(bg.color)})`);
      }
      for (const k of ["paddingPx", "radiusPx"] as const) {
        if (bg[k] !== undefined && (!isNum(bg[k]) || (bg[k] as number) < 0)) {
          err(file, `${w}.background`, `${k} は 0 以上の数値です(現在: ${JSON.stringify(bg[k])})`);
        }
      }
    }
  }
  const anim = style.anim;
  if (anim !== undefined) {
    const aw = `${w}.anim`;
    if (!isObj(anim)) {
      err(file, w, `anim はオブジェクト({in?, out?, durationSec?})です(現在: ${JSON.stringify(anim)})`);
    } else {
      for (const k of ["in", "out"] as const) {
        if (anim[k] !== undefined && !CAPTION_ANIM_KINDS.includes(String(anim[k]))) {
          err(file, aw, `${k} は ${CAPTION_ANIM_KINDS.join(" / ")} のいずれかです(現在: ${JSON.stringify(anim[k])})`);
        }
      }
      if (anim.durationSec !== undefined && (!isNum(anim.durationSec) || anim.durationSec < 0)) {
        err(file, aw, `durationSec は 0 以上の数値です(現在: ${JSON.stringify(anim.durationSec)})`);
      }
      const known = ["in", "out", "durationSec"];
      for (const k of Object.keys(anim)) {
        if (!known.includes(k)) warn?.(file, aw, `不明なキーです(有効: ${known.join(" / ")})`);
      }
    }
  }
  const karaoke = style.karaoke;
  if (karaoke !== undefined) {
    const kw = `${w}.karaoke`;
    if (!isObj(karaoke)) {
      err(file, w, `karaoke はオブジェクト({activeColor?, inactiveColor?, inactiveOpacity?, mode?})です(現在: ${JSON.stringify(karaoke)})`);
    } else {
      for (const k of ["activeColor", "inactiveColor"] as const) {
        if (karaoke[k] !== undefined && (typeof karaoke[k] !== "string" || karaoke[k] === "")) {
          err(file, kw, `${k} は CSS カラー文字列です(現在: ${JSON.stringify(karaoke[k])})`);
        }
      }
      if (
        karaoke.inactiveOpacity !== undefined &&
        (!isNum(karaoke.inactiveOpacity) || karaoke.inactiveOpacity < 0 || karaoke.inactiveOpacity > 1)
      ) {
        err(file, kw, `inactiveOpacity は 0〜1 の数値です(現在: ${JSON.stringify(karaoke.inactiveOpacity)})`);
      }
      if (karaoke.mode !== undefined && karaoke.mode !== "word" && karaoke.mode !== "fill") {
        err(file, kw, `mode は "word" / "fill" のいずれかです(現在: ${JSON.stringify(karaoke.mode)})`);
      }
      const known = ["activeColor", "inactiveColor", "inactiveOpacity", "mode"];
      for (const k of Object.keys(karaoke)) {
        if (!known.includes(k)) warn?.(file, kw, `不明なキーです(有効: ${known.join(" / ")})`);
      }
    }
  }
}

/** transcript の segment.words[](WordTiming[])の検査。省略時(undefined)は
 * 何もしない(既存の検査結果と完全に同一)。words[] は描画専用の補助データ
 * なので、「壊れると render がクラッシュ/明らかに不正になる」もの
 * (配列型・text 型・start<end)だけエラー、「意図と違うかも」なもの
 * (親 segment 範囲逸脱・時系列順・confidence 範囲)は警告にとどめる。
 * seg は親 segment の [start,end](親側が不正で確定できないときは null。
 * その場合は範囲逸脱チェックだけ省略し、word 自体の型検査は続ける) */
function checkWords(
  file: string,
  where: string,
  seg: { start: number; end: number } | null,
  words: unknown,
  err: (f: string, w: string, m: string) => void,
  warn: (f: string, w: string, m: string) => void,
): void {
  if (words === undefined) return;
  if (!Array.isArray(words)) {
    return err(file, `${where}.words`, `words は配列です(現在: ${JSON.stringify(words)})`);
  }
  let prevEnd = -Infinity;
  words.forEach((w: unknown, i: number) => {
    const ww = `${where}.words[${i}]`;
    if (!isObj(w)) return err(file, ww, "オブジェクトではありません");
    if (typeof w.text !== "string") {
      err(file, ww, `text は文字列です(現在: ${JSON.stringify(w.text)})`);
    } else if (w.text === "") {
      warn(file, ww, "text が空です(表示に使わない語)");
    }
    if (!isNum(w.start) || !isNum(w.end) || !(w.start < w.end)) {
      err(
        file, ww,
        `start / end は start < end の数値です(現在: ${JSON.stringify(w.start)} / ${JSON.stringify(w.end)})`,
      );
    } else {
      if (seg && (w.start < seg.start - EPS || w.end > seg.end + EPS)) {
        warn(
          file, ww,
          `親セグメント(${fmtT(seg.start)}–${fmtT(seg.end)})の範囲外です(${fmtT(w.start)}–${fmtT(w.end)})`,
        );
      }
      if (w.start < prevEnd - EPS) {
        warn(file, ww, "words[] が時系列順ではありません");
      }
      prevEnd = w.end;
    }
    if (
      w.confidence !== undefined &&
      (!isNum(w.confidence) || w.confidence < 0 || w.confidence > 1)
    ) {
      warn(file, ww, `confidence は 0〜1 の数値です(現在: ${JSON.stringify(w.confidence)})`);
    }
  });
}

/**
 * 安定 id(§docs/plans/2026-07-07-stable-ids-design.md)の検査。
 * docs に id が1つも無ければ何も push しない(=id 無しプロジェクトでは
 * validate の警告件数が導入前と完全に不変)。id は render に無関係なので
 * すべて warn(重複・形式不正・接頭辞ミスマッチ・欠落密度の集約1件)。
 */
function checkIds(
  docs: LoadedDocs,
  warn: (f: string, w: string, m: string) => void,
): void {
  const occurrences = collectIdOccurrences(docs);
  if (occurrences.length === 0) return;

  // 重複 id: 2件目以降を、既出の所在を添えて警告
  const firstSeen = new Map<string, { file: string; path: string }>();
  for (const [id, target] of occurrences) {
    const prev = firstSeen.get(id);
    if (prev) {
      warn(
        target.file,
        target.path,
        `@id が重複しています: ${id}(既出: ${prev.file} ${prev.path})`,
      );
    } else {
      firstSeen.set(id, { file: target.file, path: target.path });
    }
  }

  // 形式不正(id は文字列だが正規表現に合わない)
  for (const [id, target] of occurrences) {
    if (!ID_RE.test(id)) {
      warn(
        target.file,
        target.path,
        `id の形式が不正です(期待: <2〜3文字の接頭辞>_<英数字6桁>。現在: ${JSON.stringify(id)})`,
      );
    }
  }

  // 接頭辞ミスマッチ(コピペ由来の取り違え検出)
  const kindPrefix: Record<string, string | undefined> = ID_PREFIX;
  for (const [id, target] of occurrences) {
    const expected = kindPrefix[target.kind];
    if (expected && ID_RE.test(id) && !id.startsWith(`${expected}_`)) {
      warn(
        target.file,
        target.path,
        `id の接頭辞が種別と一致しません(期待: ${expected}_...。現在: ${id})`,
      );
    }
  }

  // id 欠落(密度): per-要素では出さず、1本の集約警告にとどめる
  const missing = countAddressableMissingIds(docs);
  if (missing > 0) {
    warn("-", "-", `${missing} 個の要素に id がありません(\`id-stamp\` で採番できます)`);
  }
}

/** id が有効なプロジェクトで、id を持たない「指せる要素」の数を数える
 * (欠落密度の集約警告に使う。id 自体の妥当性は問わない) */
function countAddressableMissingIds(docs: LoadedDocs): number {
  let missing = 0;
  const scan = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) {
      if (isObj(x) && typeof x.id !== "string") missing++;
    }
  };
  const cutplan = docs.cutplan;
  if (isObj(cutplan)) scan(cutplan.segments);
  const transcript = docs.transcript;
  if (isObj(transcript)) scan(transcript.segments);
  const overlays = docs.overlays;
  if (isObj(overlays)) {
    scan(overlays.overlays);
    scan(overlays.inserts);
    scan(overlays.wipeFull);
    scan(overlays.hideCaption);
    scan(overlays.zooms);
    scan(overlays.blurs);
    scan(overlays.captionTracks);
  }
  const chapters = docs.chapters;
  if (isObj(chapters)) scan(chapters.chapters);
  const bgm = docs.bgm;
  if (isObj(bgm)) scan(bgm.tracks);
  const thumbnail = docs.thumbnail;
  if (isObj(thumbnail)) scan(thumbnail.texts);
  return missing;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isPosInt(v: unknown): v is number {
  return isNum(v) && Number.isInteger(v) && v >= 1;
}
