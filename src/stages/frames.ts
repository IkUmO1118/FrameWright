// 指定時刻のフレームを最終合成と同じ見た目で PNG に書き出す知覚コマンド。
// AI(Claude Code)は動画を再生できないが画像は読めるので、テロップの位置・
// ワイプとの被り・素材の見え方をこれで自己確認する(人間の確認は preview /
// エディタが担い、これは「AI が自分の編集結果を見る目」)。
//
// 仕組み: M4 エンジン(WebGPU compositor + CDP capture)で静止画を書き出す。
//
// frames/ 内の PNG は実行のたびに全削除してから書き直す。ファイル名が
// 出力秒ベースなので、cutplan 編集で時刻の写像が変わると旧ファイルが
// 別名のまま残り、AI が編集前の絵を見る事故が起きるため(全ファイル
// いつでも再生成できる中間生成物であり、消して困るものは無い)。
//
// --full-res: ベース映像を proxy.mp4 の代わりに元収録(manifest.source。
// フル解像度)にする合成 still(画面キャプチャ内の細かい文字を読みたいとき用。
// proxy は幅1280pxへ縮小済みなので画面領域はさらに小さく、既定の frames PNG
// では画面内テキストの可読性を判断できない)。canvas 座標系は proxy と
// 同一(違いは物理解像度だけ)なので buildRenderProps は無改造で流用できる。
// 未指定時は従来どおり proxy 経路(1バイトも変わらない)。

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtT } from "../lib/fmt.ts";
import { readEditSnapshot, resolveSnapshotRenderContext } from "../lib/renderSnapshot.ts";
import { prepareDesignAssetsForProps } from "../lib/designStill.ts";
import {
  buildTimeline,
  snapToOutput,
  toOutputTime,
  toSourceTime,
} from "../lib/timeline.ts";
import { writeFramesIndex } from "../lib/framesIndex.ts";
import { runOcr } from "../lib/ocr.ts";
import { panelRect, resolveDesign, screenRectToOutput } from "../lib/design.ts";
import { buildScreenStill } from "../lib/screenStill.ts";
import { createEngineSession } from "../lib/engineSession.ts";
import type { TimelineEntry } from "../lib/timeline.ts";
import type { Config } from "../lib/config.ts";
import { resolveCanvas, screenContentRect } from "../lib/profile.ts";
import type { Manifest } from "../types.ts";
import type { RenderProps } from "../lib/renderPropsTypes.ts";
import { AV_DIR, MOTION_FILE } from "./av.ts";
import type { MotionReport } from "./av.ts";
import {
  DEFAULT_SCENE_SAMPLING_CFG,
  selectSceneTimes,
} from "../lib/sceneSampling.ts";
import type { SceneSamplingCfg, SceneTimeReason } from "../lib/sceneSampling.ts";

export interface FrameShot {
  /** 指定された時刻(秒。times は axis の軸 / captions・every は出力の秒) */
  requested: number;
  /** 実際にレンダーした出力(カット後)の秒 */
  outSec: number;
  /** 書き出した PNG(絶対パス) */
  file: string;
  /** スナップ・丸めの説明や、そのフレームに映っているテロップの内容 */
  note?: string;
  /** --ocr のとき書いた OCR サイドカー(絶対パス)。省略時は OCR なし
   * (非対応環境での劣化・挿入クリップ内でのスキップを含む) */
  ocrFile?: string;
}

/** 何のフレームを撮るか。times = 時刻指定 / captions = テロップ全件の
 * 一巡監査(各テロップの表示中間で1枚)/ every = 出力全体の定間隔サンプル /
 * scenes = 画面の変化点+静止区間の代表を自動選択(要 av <dir>。
 * video-perception-P0 §2.1) */
export type FrameRequest =
  | { mode: "times"; times: number[]; axis: "source" | "output" }
  | { mode: "captions" }
  | { mode: "every"; stepSec: number }
  | { mode: "scenes"; maxShots: number };

export async function frames(
  dir: string,
  req: FrameRequest,
  cfg: Config,
  ocr?: boolean,
  fullRes?: boolean,
): Promise<FrameShot[]> {
  return framesEngine(dir, req, cfg, ocr, fullRes);
}

/** M4: エンジン経路の frames 実装。createEngineSession でヘッドレス Chrome を
 * 起動し、各 target フレームを renderAndCapture → PNG に書き出す。
 * OCR は既存の ffmpeg 生クロップ経路なので触らない(無関係)。
 * warmSession を渡すと起動済み session を使い回す(frames-serve が使う)。
 * 省略時は自前で session を作り finally で閉じる(frames CLI が使う)。 */
export async function framesEngine(
  dir: string,
  req: FrameRequest,
  cfg: Config,
  ocr?: boolean,
  fullRes?: boolean,
  warmSession?: Awaited<ReturnType<typeof createEngineSession>>,
): Promise<FrameShot[]> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const snapshot = readEditSnapshot(dir);

  const renderCtx = resolveSnapshotRenderContext({ dir, cfg, snapshot, fullRes });
  const { keeps, overlays } = renderCtx;

  const props = await prepareDesignAssetsForProps({
    dir,
    props: renderCtx.props,
    warn: (message) => console.warn(`警告: ${message}`),
  });

  const timeline = buildTimeline(
    keeps,
    (overlays.inserts ?? []).filter((i) => existsSync(join(dir, i.file))),
  );
  const maxOut = Math.max(0, props.durationSec - 1 / props.fps);
  const targets = buildTargets(req, props, maxOut, timeline, dir, cfg);
  if (targets.length === 0) {
    throw new Error(
      req.mode === "captions"
        ? "テロップが0件です(transcript.json を確認してください)"
        : "撮るフレームが0件です",
    );
  }

  const byFrame = new Map<number, Target>();
  for (const t of targets) {
    const frame = Math.round(t.outSec * props.fps);
    const prev = byFrame.get(frame);
    if (prev) prev.notes.push(...t.notes);
    else byFrame.set(frame, { ...t, notes: [...t.notes] });
  }
  const unique = [...byFrame.entries()].sort((a, b) => a[0] - b[0]);

  const outDir = join(dir, "frames");
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) {
    if (f.endsWith(".png") || f.endsWith(".ocr.json")) rmSync(join(outDir, f));
  }

  const sourceUrls: Record<string, string> = {};
  if (props.videoFile) sourceUrls[props.videoFile] = `/${props.videoFile}`;
  for (const o of props.overlays) sourceUrls[o.file] = `/${o.file}`;
  for (const i of props.inserts ?? []) sourceUrls[i.file] = `/${i.file}`;

  const ownSession = !warmSession;
  const session = warmSession ?? (await createEngineSession(dir, {
    props,
    sourceUrls,
  }));

  try {
    const shots: FrameShot[] = [];
    for (const [frame, t] of unique) {
      const pngBase64 = await session.renderAndCapture(t.outSec);
      const outPath = join(outDir, `out${t.outSec.toFixed(2)}s.png`);
      writeFileSync(outPath, Buffer.from(pngBase64, "base64"));
      const notes = [...t.notes];
      let ocrFile: string | undefined;
      if (ocr) {
        ocrFile = await ocrFrame(dir, manifest, timeline, t.outSec, outDir, notes, cfg);
      }
      const note = notes.join(" / ");
      shots.push({
        requested: t.requested,
        outSec: t.outSec,
        file: outPath,
        ...(note ? { note } : {}),
        ...(ocrFile ? { ocrFile } : {}),
      });
    }
    writeFramesIndex(dir, {
      mode: req.mode,
      ocr: ocr ?? false,
      fullRes: fullRes ?? false,
      count: unique.length,
    });
    return shots;
  } finally {
    if (ownSession) await session.close();
  }
}

interface Target {
  requested: number;
  outSec: number;
  notes: string[];
}

/** リクエストを「出力秒のリスト」に展開する */
function buildTargets(
  req: FrameRequest,
  props: RenderProps,
  maxOut: number,
  timeline: TimelineEntry[],
  dir: string,
  cfg: Config,
): Target[] {
  const clamp = (sec: number) => Math.min(Math.max(0, sec), maxOut);

  if (req.mode === "scenes") {
    return buildSceneTargets(req, dir, cfg, maxOut, clamp);
  }

  if (req.mode === "captions") {
    // props.captions は出力秒へ変換・表示対象の絞り込みが済んだ「実際に
    // 描画されるテロップ」そのもの。ここから中間時刻を取れば transcript の
    // 再解釈(カット判定・時刻換算)を繰り返さずに全件を一巡できる
    return props.captions.map((c) => {
      const mid = clamp((c.start + c.end) / 2);
      const label =
        c.text.length > 24 ? `${c.text.slice(0, 24)}…` : c.text;
      return {
        requested: mid,
        outSec: mid,
        notes: [`テロップ${c.track > 1 ? `(track${c.track})` : ""}「${label}」`],
      };
    });
  }

  if (req.mode === "every") {
    if (!(req.stepSec > 0)) {
      throw new Error(`間隔は正の秒数で指定してください: ${req.stepSec}`);
    }
    const targets: Target[] = [];
    for (let t = 0; t < maxOut; t += req.stepSec) {
      targets.push({ requested: t, outSec: clamp(t), notes: [] });
    }
    targets.push({ requested: maxOut, outSec: maxOut, notes: ["最終フレーム"] });
    return targets;
  }

  // 元収録の秒 → カット後の秒(カット内なら直後の keep へスナップ)
  return req.times.map((t) => {
    let outSec: number;
    const notes: string[] = [];
    if (req.axis === "output") {
      outSec = t;
      if (outSec > maxOut) notes.push(`出力の長さ(${fmtT(props.durationSec)})を超えるため末尾へ丸め`);
    } else {
      const direct = toOutputTime(t, timeline);
      const snapped = direct ?? snapToOutput(t, timeline);
      if (snapped === null) {
        // 最後の keep より後ろのカット内 → 末尾フレームで代用
        outSec = maxOut;
        notes.push("カット区間内でスナップ先もないため最終フレームで代用");
      } else {
        outSec = snapped;
        if (direct === null) notes.push(`カット区間内のため直後の keep 先頭(出力 ${fmtT(snapped)})へスナップ`);
      }
    }
    return { requested: t, outSec: clamp(outSec), notes };
  });
}

const SCENE_REASON_LABEL: Record<SceneTimeReason, string> = {
  edge: "端点",
  scene: "画面変化",
  frozen: "静止区間",
};

/**
 * scenes モードの対象時刻を組み立てる(video-perception-P0 §2.2)。
 * av.probe/motion.json(要 av <dir> の事前実行)を読み、selectSceneTimes
 * (src/lib/sceneSampling.ts の純関数)で時刻を選ぶ。前提資産が無ければ
 * 告知して例外(共通規約 §2.5。material-fit / bgm-fit と同じ「前提エラー」の形)。
 * motion.json のキャッシュキーの陳腐化は判定しない(§2.5 後半)。
 */
function buildSceneTargets(
  req: { mode: "scenes"; maxShots: number },
  dir: string,
  cfg: Config,
  maxOut: number,
  clamp: (sec: number) => number,
): Target[] {
  const motionPath = join(dir, AV_DIR, MOTION_FILE);
  if (!existsSync(motionPath)) {
    throw new Error(
      "av.probe/motion.json がありません。先に `node src/cli.ts av <dir>` を実行してください。",
    );
  }
  const motion = JSON.parse(readFileSync(motionPath, "utf8")) as MotionReport;

  // range(motion.json 測定時の出力秒範囲)が全域をカバーしていないと、
  // motion[0]/motion[last] が動画全体の端点ではなく部分測定の端点になる。
  // エラーにはしない(§2.5 後半の非強制の姿勢)が、AI/人間が気づけるよう告知する
  const isFullRange = motion.range.startSec <= 0.01 && motion.range.endSec >= maxOut - 0.5;
  if (!isFullRange) {
    console.log(
      `--scenes: av.probe/motion.json は範囲 ${motion.range.startSec}s〜${motion.range.endSec}s のみ` +
        `(av --range で部分測定されたもの)。動画全体をカバーしていません。`,
    );
  }

  const sceneCfg = cfg.frames?.scenes ?? {};
  const avEverySec = cfg.av?.everySec ?? 5;
  const effectiveCfg: SceneSamplingCfg = {
    sceneThreshold: sceneCfg.sceneThreshold ?? DEFAULT_SCENE_SAMPLING_CFG.sceneThreshold,
    minGapSec: sceneCfg.minGapSec ?? DEFAULT_SCENE_SAMPLING_CFG.minGapSec,
    maxShots: req.maxShots,
    frozenShotEverySec: sceneCfg.frozenShotEverySec ?? DEFAULT_SCENE_SAMPLING_CFG.frozenShotEverySec,
    frozenMaxShotsPerSpan:
      sceneCfg.frozenMaxShotsPerSpan ?? DEFAULT_SCENE_SAMPLING_CFG.frozenMaxShotsPerSpan,
  };
  if (effectiveCfg.minGapSec <= avEverySec) {
    console.warn(
      `警告: frames.scenes.minGapSec(${effectiveCfg.minGapSec})が av.everySec(${avEverySec})以下です。` +
        `motion.json のグリッド間隔以下のため、変化点の間引きが機能しません。`,
    );
  }

  const { times, dropped } = selectSceneTimes(motion, effectiveCfg);
  // "no silent caps"(共通規約 §2.2.4 末尾): 間引き件数は必ず stdout に出す。
  // 0 件のときに「上限超のため間引き」と書くと事実と食い違うので文言を分ける
  const capped = dropped.scene > 0 || dropped.frozen > 0;
  console.log(
    `--scenes: ${times.length} 件のフレームを選択しました` +
      (capped
        ? `(上限 ${effectiveCfg.maxShots} 件のため間引き: 画面変化 ${dropped.scene} 件 / 静止区間 ${dropped.frozen} 件)`
        : `(上限 ${effectiveCfg.maxShots} 件・間引きなし)`),
  );

  return times.map((st) => ({
    requested: st.outSec,
    outSec: clamp(st.outSec),
    notes: [SCENE_REASON_LABEL[st.reason]],
  }));
}

/**
 * 1フレーム(出力秒 outSec)ぶんの画面 OCR。toSourceTime で元収録秒へ逆写像し、
 * フル解像度 screenRegion クロップ(screenStill.ts)→ Vision OCR(ocr.ts)の順で
 * 実行し `frames/out<sec>s.ocr.json` を書く。outSec が挿入クリップ内に落ちて
 * toSourceTime が null を返す場合(=その時刻に画面の生映像が無い)は OCR を
 * スキップし notes にその旨を追記するだけで、例外は投げない。非対応環境
 * (macOS 以外・swift 系が無い等)による劣化も同様に例外を投げず、
 * runOcr 内部の warn で警告するだけに留める(frames 本体の PNG 出力は
 * 常に成功で返す)。書いたサイドカーの絶対パスを返す(スキップ・劣化時は undefined)
 */
async function ocrFrame(
  dir: string,
  manifest: Manifest,
  timeline: TimelineEntry[],
  outSec: number,
  outDir: string,
  notes: string[],
  cfg: Config,
): Promise<string | undefined> {
  const sourceSec = toSourceTime(outSec, timeline);
  if (sourceSec === null) {
    notes.push("OCR: 挿入クリップ内のためスキップ(画面の生映像がありません)");
    return undefined;
  }
  const cropPath = join(tmpdir(), `framewright-ocr-${process.pid}-${outSec.toFixed(2)}.png`);
  try {
    await buildScreenStill(dir, manifest, sourceSec, cropPath);
    const result = await runOcr(cropPath, manifest.video.screenRegion, {
      languages: cfg.ocr?.languages,
      warn: (msg) => console.warn(`警告: ${msg}`),
    });
    if (result === null) return undefined; // 非対応環境等(warn 済み)
    // box は「テロップ pos / blurs.rect と同じ出力px」で書く契約。デザイン有効時は
    // 画面がパネルへ縮んで置かれるので、screenRegion 画素 = 出力px の恒等が
    // 崩れる。パネルへ写してから書く(design 無しでは恒等 = 従来と同じ値)
    const sr = manifest.video.screenRegion;
    const canvas = resolveCanvas(manifest);
    const canvasPanel = screenContentRect(manifest);
    if (!canvasPanel) {
      notes.push(`OCR: canvas ${manifest.canvas} に screen パネルが無いため座標化をスキップ`);
      return undefined;
    }
    const design = canvas.layout
      ? undefined
      : resolveDesign(cfg.render.design, canvas.width, canvas.height, !!manifest.video.cameraRegion);
    const panel = design ? panelRect(design, canvas.width, canvas.height) : canvasPanel;
    const mapped = {
      ...result,
      lines: result.lines.map((l) => ({ ...l, box: screenRectToOutput(l.box, panel, sr) })),
    };
    const ocrPath = join(outDir, `out${outSec.toFixed(2)}s.ocr.json`);
    writeFileSync(
      ocrPath,
      JSON.stringify({ outSec, sourceSec, ...mapped }, null, 2),
    );
    return ocrPath;
  } finally {
    if (existsSync(cropPath)) rmSync(cropPath);
  }
}
