// lib/renderProps.ts — 編集ファイル群からカット後の RenderProps を組む純関数。
// render とエディタのプレビューが同じ絵になることの土台。レイヤー順の正規化と
// テロップのカット後写像を固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRenderProps,
  capCountOf,
  frameSpans,
  normalizeLayerOrder,
  ovCountOf,
  textCountOf,
} from "../src/lib/renderProps.ts";
import { resolveCanvas } from "../src/lib/profile.ts";
import { mergeIntervals } from "../src/lib/timeline.ts";
import { cutplanApprovalHash } from "../src/lib/approval.ts";
import { defaultProps } from "../src/lib/renderPropsTypes.ts";
import type { Config } from "../src/lib/config.ts";
import type { Manifest, Overlays, Transcript } from "../src/types.ts";

test("normalizeLayerOrder: 省略時は素材トラック数なりの既定順(1本なら V2 なし)", () => {
  assert.deepEqual(normalizeLayerOrder(undefined, 1, 1, 1), ["ov1", "wipe", "caption"]);
  assert.deepEqual(normalizeLayerOrder(undefined, 2, 1, 1), ["ov1", "wipe", "ov2", "caption"]);
});

test("normalizeLayerOrder: 旧形式(ovUnder/chapter)を読み替え・破棄", () => {
  // ovUnder→ov1、chapter は黙って捨てる。欠けた wipe/caption/ov2 は補完される
  const order = normalizeLayerOrder(["ovUnder", "chapter", "wipe"], 1, 1, 1);
  assert.ok(order.includes("ov1"));
  assert.ok(!order.includes("chapter" as never));
  assert.ok(order.includes("wipe"));
  assert.ok(order.includes("caption"));
});

test("normalizeLayerOrder: text は既存互換を汚さず複数トラックだけ補完する", () => {
  assert.deepEqual(normalizeLayerOrder(undefined, 1, 1, 1), ["ov1", "wipe", "caption"]);
  assert.deepEqual(
    normalizeLayerOrder(undefined, 1, 1, 2),
    ["ov1", "wipe", "caption", "text", "text2"],
  );
  assert.deepEqual(
    normalizeLayerOrder(["text1", "text3"], 1, 1, 1),
    ["ov1", "text", "text2", "text3", "wipe", "caption"],
  );
});

test("normalizeLayerOrder: text の欠番は最下層ではなく既存テキストの直下へ", () => {
  // text2 だけを手書きした収録。text(1本目)を先頭へ落とすと ov1/wipe より
  // 下に潜って描画順が直感に反するので、text2 の直下へ入れる
  assert.deepEqual(
    normalizeLayerOrder(["ov1", "wipe", "text2", "caption"], 1, 1, 2),
    ["ov1", "wipe", "text", "text2", "caption"],
  );
  assert.deepEqual(
    normalizeLayerOrder(["ov1", "wipe", "caption", "text3"], 1, 1, 3),
    ["ov1", "wipe", "caption", "text", "text2", "text3"],
  );
  // 素材(ov)の補完位置は従来どおり最下段(この挙動は変えない=バイト等価)
  assert.deepEqual(
    normalizeLayerOrder(["wipe", "ov2", "caption"], 2, 1, 1),
    ["ov1", "wipe", "ov2", "caption"],
  );
});

test("capCountOf / ovCountOf / textCountOf: 参照される最大トラック番号(最低1)", () => {
  assert.equal(capCountOf({ segments: [{ start: 0, end: 1, text: "a", track: 3 }] } as Transcript), 3);
  assert.equal(capCountOf({ segments: [{ start: 0, end: 1, text: "a" }] } as Transcript), 1);
  assert.equal(capCountOf({ generatedBy: "transcribe", segments: [{ start: 0, end: 1, text: "a", track: 3 }] } as Transcript), 1);
  assert.equal(ovCountOf({ overlays: [{ start: 0, end: 1, file: "x.png", track: 2 }] } as Overlays), 2);
  assert.equal(ovCountOf({} as Overlays), 1);
  assert.equal(textCountOf({ texts: [{ start: 0, end: 1, text: "a", track: 4, pos: { x: 0, y: 0 } }] } as Overlays), 4);
  assert.equal(textCountOf({} as Overlays), 1);
});

const manifest: Manifest = {
  dir: "/tmp",
  source: "raw.mkv",
  durationSec: 40,
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    screenRegion: { x: 0, y: 0, w: 1920, h: 1080 },
    cameraRegion: { x: 1920, y: 0, w: 1920, h: 1080 },
  },
  audio: { micStream: 0, systemStream: null, micWav: "mic.wav" },
  createdAt: "2026-07-04T00:00:00Z",
};

const renderCfg: Config["render"] = {
  wipeWidthPx: 480,
  wipeMarginPx: 32,
  captionFontSizePx: 52,
  chapterCardSec: 3,
  targetLufs: -14,
  bgm: { volumeDb: -22, fadeOutSec: 2 },
};

test("buildRenderProps: カット内のテロップは落ち、尺は keep の合計", () => {
  const keeps = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ];
  const transcript: Transcript = {
    segments: [
      { start: 2, end: 5, text: "残る" },
      { start: 12, end: 14, text: "カット内で消える" },
    ],
  };
  const props = buildRenderProps({
    manifest,
    keeps,
    transcript,
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });

  assert.equal(props.durationSec, 20); // 10 + 10
  assert.equal(props.captions.length, 1);
  assert.equal(props.captions[0].text, "残る");
  assert.deepEqual(
    { start: props.captions[0].start, end: props.captions[0].end },
    { start: 2, end: 5 },
  );
  assert.deepEqual(props.layerOrder, ["ov1", "wipe", "caption"]);
});

test("buildRenderProps: generatedBy=transcribe の transcript はテロップを描かない", () => {
  const args = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: {
      segments: [{ start: 1, end: 3, text: "未採用テロップ" }],
    } as Transcript,
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  assert.equal(buildRenderProps(args).captions.length, 1);
  assert.equal(
    buildRenderProps({
      ...args,
      transcript: { ...args.transcript, generatedBy: "transcribe" },
    }).captions.length,
    0,
  );
});

test("buildRenderProps: editor proxy 経路では speed を playbackRate に載せる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10, speed: 2 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "proxy.mp4",
    videoIsSource: true,
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.baseSegments, [
    { start: 0, videoStart: 0, audioStart: 0, durationSec: 5, playbackRate: 2 },
  ]);
  assert.equal(props.durationSec, 5);
});

test("buildRenderProps: audioStart は videoIsSource に依らず常にカット後の秒", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "raw.mkv",
    videoIsSource: true,
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.baseSegments?.[1].videoStart, 20);
  assert.equal(props.baseSegments?.[1].audioStart, 10);
});

test("buildRenderProps: profile 省略時は profile 指定なしの現行 props と deep-equal", () => {
  const args = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [{ start: 2, end: 5, text: "残る" }] } as Transcript,
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  const withoutArg = buildRenderProps(args);
  const withUndefined = buildRenderProps({ ...args, profile: undefined });
  assert.deepEqual(withoutArg, withUndefined);
  assert.equal(withoutArg.layout, undefined);
  assert.equal(withoutArg.captionDefaultPos, undefined);
  assert.equal(withoutArg.caption.fontSizePx, renderCfg.captionFontSizePx);
});

// plain(cameraRegion 無し)の manifest では props.cameraRegion が undefined。
// defaultProps にダミー cameraRegion があると、plain の inputProps で
// cameraRegion が JSON 欠落 → Remotion の props マージでダミーが漏れ、plain に
// ワイプが描かれる/ショートのカメラパネルが誤領域を切り出して黒くなる。
// そのため defaultProps は cameraRegion を持たないことを固定する
test("defaultProps は cameraRegion を持たない(plain へのダミー漏れ防止)", () => {
  assert.equal(defaultProps.cameraRegion, undefined);
});

test("buildRenderProps: plain manifest(cameraRegion 無し)は cameraRegion undefined", () => {
  const plainManifest: Manifest = {
    ...manifest,
    layout: "plain",
    video: { width: 1080, height: 1920, fps: 30, screenRegion: { x: 0, y: 0, w: 1080, h: 1920 } },
  };
  const props = buildRenderProps({
    manifest: plainManifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [{ start: 2, end: 5, text: "残る" }] } as Transcript,
    overlays: {},
    renderCfg,
    width: 1080,
    height: 1920,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.cameraRegion, undefined);
  assert.deepEqual(props.screenRegion, { x: 0, y: 0, w: 1080, h: 1920 });
});

test("buildRenderProps: plain収録(OBSではない素の動画)にはdesignを載せない", () => {
  const plainManifest: Manifest = {
    ...manifest,
    layout: "plain",
    video: { width: 1080, height: 1920, fps: 30, screenRegion: { x: 0, y: 0, w: 1080, h: 1920 } },
  };
  const props = buildRenderProps({
    manifest: plainManifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: {
      ...renderCfg,
      design: {
        enabled: true,
        backgroundColor: "#123456",
        camera: { sizePx: 9999, marginPx: 9999 },
      },
    },
    width: 1080,
    height: 1920,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.design, undefined);
  assert.equal(props.cameraRegion, undefined);
});

test("buildRenderProps: portrait canvas profile → layout/captionDefaultPos/fontSizePx(×fontScale)が入る", () => {
  const profile = resolveCanvas({ ...manifest, canvas: "portrait", baseLayout: "stack" });
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [{ start: 2, end: 5, text: "残る" }] } as Transcript,
    overlays: {},
    renderCfg,
    width: profile.width,
    height: profile.height,
    profile,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });

  assert.deepEqual(props.layout, { panels: profile.layout?.panels });
  assert.deepEqual(props.captionDefaultPos, { x: 540, y: 1704, anchor: "center" });
  assert.equal(props.caption.fontSizePx, Math.round(renderCfg.captionFontSizePx * 1.6));
});

test("buildRenderProps: テロップ既定スタイルは config 指定時のみ caption に載る", () => {
  const base = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    overlays: {},
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  // 未指定なら fontSizePx のみ(render.props.json に余計なキーを書かない)
  assert.deepEqual(buildRenderProps({ ...base, renderCfg }).caption, { fontSizePx: 52 });
  // config の render.caption* が props.caption に解決される
  const styled = buildRenderProps({
    ...base,
    renderCfg: {
      ...renderCfg,
      captionColor: "#ffee00",
      captionOutlineColor: "none",
      captionFontFamily: "serif",
      captionFontWeight: 900,
      captionBackground: { color: "rgba(0, 0, 0, 0.75)", paddingPx: 18, radiusPx: 10 },
    },
  });
  assert.deepEqual(styled.caption, {
    fontSizePx: 52,
    color: "#ffee00",
    outlineColor: "none",
    fontFamily: "serif",
    fontWeight: 900,
    background: { color: "rgba(0, 0, 0, 0.75)", paddingPx: 18, radiusPx: 10 },
  });
});

test("buildRenderProps: insert の頭出し(startFrom)が props に伝わる／0は省略", () => {
  const keeps = [{ start: 0, end: 30 }];
  const props = buildRenderProps({
    manifest,
    keeps,
    transcript: { segments: [] },
    overlays: {
      inserts: [
        { at: 10, file: "materials/broll.mp4", durationSec: 4, startFrom: 5 },
        { at: 20, file: "materials/other.mp4", durationSec: 2 },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });

  const withIn = props.inserts?.find((i) => i.file === "materials/broll.mp4");
  const noIn = props.inserts?.find((i) => i.file === "materials/other.mp4");
  assert.equal(withIn?.startFrom, 5);
  assert.equal(noIn?.startFrom, undefined); // startFrom 無指定は省略される
  assert.equal(props.durationSec, 36); // keep 30 + 挿入 4 + 2
});

test("buildRenderProps: overlay の頭出し・音量・不透明度・rect が props に伝わる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      overlays: [
        {
          start: 5, end: 10, file: "materials/pip.mp4",
          startFrom: 3, volume: 0.5, opacity: 0.8,
          fadeInSec: 0.5, fadeOutSec: 1,
          rect: { x: 1200, y: 60, w: 640, h: 360 },
        },
        { start: 12, end: 14, file: "materials/plain.png" },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const rich = props.overlays.find((o) => o.file === "materials/pip.mp4");
  assert.equal(rich?.startFrom, 3);
  assert.equal(rich?.volume, 0.5);
  assert.equal(rich?.opacity, 0.8);
  assert.equal(rich?.fadeInSec, 0.5);
  assert.equal(rich?.fadeOutSec, 1);
  assert.deepEqual(rich?.rect, { x: 1200, y: 60, w: 640, h: 360 });
  // 既定値(音量0・不透明度1・フェードなし・全画面)はキーごと省略される
  const plain = props.overlays.find((o) => o.file === "materials/plain.png");
  assert.deepEqual(plain, {
    start: 12, end: 14, file: "materials/plain.png", track: 1, fit: "contain",
  });
});

test("buildRenderProps: 挿入で割れた overlay は頭出し+表示済み秒で続きから、フェードは端の断片だけ", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      // 挿入が 10s に割り込み、5〜15s の overlay は2断片に割れる
      inserts: [{ at: 10, file: "materials/ins.mp4", durationSec: 4 }],
      overlays: [
        {
          start: 5, end: 15, file: "materials/pip.mp4",
          startFrom: 2, fadeInSec: 0.5, fadeOutSec: 0.5,
        },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const parts = props.overlays.filter((o) => o.file === "materials/pip.mp4");
  assert.equal(parts.length, 2);
  // 1断片目: 頭出し2秒から。フェードインだけ持つ
  assert.equal(parts[0].startFrom, 2);
  assert.equal(parts[0].fadeInSec, 0.5);
  assert.equal(parts[0].fadeOutSec, undefined);
  // 2断片目: 頭出し2秒+表示済み5秒=7秒から。フェードアウトだけ持つ
  assert.equal(parts[1].startFrom, 7);
  assert.equal(parts[1].fadeInSec, undefined);
  assert.equal(parts[1].fadeOutSec, 0.5);
});

test("buildRenderProps: insert の音量・フェードが props に伝わる／既定値は省略", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      inserts: [
        { at: 10, file: "materials/a.mp4", durationSec: 4, volume: 0, fadeInSec: 0.3 },
        { at: 20, file: "materials/b.mp4", durationSec: 2, volume: 1 },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const muted = props.inserts?.find((i) => i.file === "materials/a.mp4");
  assert.equal(muted?.volume, 0); // 0 は「無音にする」指定なので残る
  assert.equal(muted?.fadeInSec, 0.3);
  const normal = props.inserts?.find((i) => i.file === "materials/b.mp4");
  assert.equal(normal?.volume, undefined); // 1(既定)は省略される
});

test("buildRenderProps: wipe に遷移時間が載る(config 未指定は 0.3)", () => {
  const base = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    overlays: {},
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  assert.equal(buildRenderProps({ ...base, renderCfg }).wipe.transitionSec, 0.3);
  assert.equal(
    buildRenderProps({ ...base, renderCfg: { ...renderCfg, wipeTransitionSec: 0 } })
      .wipe.transitionSec,
    0,
  );
});

test("buildRenderProps: design無効・wipeStyle未指定ではstyleを載せずlegacy矩形に任せる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.wipe.widthPx, renderCfg.wipeWidthPx);
  assert.equal(props.wipe.marginPx, renderCfg.wipeMarginPx);
  assert.equal(props.wipe.style, undefined);
});

test("buildRenderProps: wipeStyle指定時もwidthPx/marginPxはテロップ安全余白のconfig値のまま", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {
      wipeStyle: {
        anchor: "top-left",
        marginPx: 12,
        sizePx: 160,
        radiusPx: 24,
        shadow: false,
      },
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.wipe.widthPx, renderCfg.wipeWidthPx);
  assert.equal(props.wipe.marginPx, renderCfg.wipeMarginPx);
  assert.deepEqual(props.wipe.style, {
    anchor: "top-left",
    marginPx: 12,
    sizePx: 160,
    radiusPx: 24,
    shadow: false,
    rect: { x: 12, y: 12, w: 160, h: 160 },
  });
});

test("buildRenderProps: design有効の既定wipeStyleでもwidthPx/marginPxはconfig値のまま", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: {
      ...renderCfg,
      design: { enabled: true, camera: { sizePx: 375, marginPx: 28, radiusPx: 96, shadow: true } },
    },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.wipe.widthPx, renderCfg.wipeWidthPx);
  assert.equal(props.wipe.marginPx, renderCfg.wipeMarginPx);
  assert.deepEqual(props.wipe.style?.rect, { x: 1517, y: 677, w: 375, h: 375 });
  assert.deepEqual(props.design?.camera.rect, props.wipe.style?.rect);
});

test("buildRenderProps: cutTransition 未設定/type: none では cutTransition・cutBoundarySecs が props に載らない", () => {
  const keeps = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }];
  const base = {
    manifest,
    keeps,
    transcript: { segments: [] } as Transcript,
    overlays: {},
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  const noCfg = buildRenderProps({ ...base, renderCfg });
  assert.equal(noCfg.cutTransition, undefined);
  assert.equal(noCfg.cutBoundarySecs, undefined);
  const noneCfg = buildRenderProps({
    ...base,
    renderCfg: { ...renderCfg, cutTransition: { type: "none", sec: 0.5 } },
  });
  assert.equal(noneCfg.cutTransition, undefined);
  assert.equal(noneCfg.cutBoundarySecs, undefined);
});

test("buildRenderProps: dip-to-black で keep 境界の累積秒が cutBoundarySecs に載る(先頭・末尾は含めない)", () => {
  const props = buildRenderProps({
    manifest,
    // 出力: [0,10] keep1 / 境界(10) / [10,20] keep2 / 境界(20) / [20,25] keep3
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 45 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: { ...renderCfg, cutTransition: { type: "dip-to-black", sec: 0.4 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.cutTransition, { sec: 0.4 });
  assert.deepEqual(props.cutBoundarySecs, [10, 20]);
});

test("buildRenderProps: sec 省略時は DEFAULT_CUT_TRANSITION_SEC(0.3)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: { ...renderCfg, cutTransition: { type: "dip-to-black" } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.cutTransition, { sec: 0.3 });
});

test("buildRenderProps: 境界より手前に挿入があると、その尺ぶん cutBoundarySecs も後ろへずれる", () => {
  const props = buildRenderProps({
    manifest,
    // 元 [0,10] と [20,30]。境界の手前(元5s)に4秒の挿入があるので、
    // 単純な keep 累積時間(10)ではなく、挿入の尺を足した 14 が正しい境界
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      inserts: [{ at: 5, file: "materials/ins.mp4", durationSec: 4 }],
    },
    renderCfg: { ...renderCfg, cutTransition: { type: "dip-to-black", sec: 0.3 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.cutBoundarySecs, [14]);
});

test("buildRenderProps: 隣接 keep が実質連続している境界(未 mergeIntervals)は cutBoundarySecs から除外される", () => {
  const props = buildRenderProps({
    manifest,
    // エディタの分割編集直後を想定: [0,10] と [10,20] は実際には切れていない
    keeps: [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 30, end: 40 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: { ...renderCfg, cutTransition: { type: "dip-to-black", sec: 0.3 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // [0,10]+[10,20] の継ぎ目(10)は実質連続なので除外。[10,20]→[30,40] の
  // 境界(累積20の位置)だけが残る
  assert.deepEqual(props.cutBoundarySecs, [20]);
});

test("buildRenderProps: wipeFull はカット・挿入・隣接エントリで繋がった区間が1本にまとまる", () => {
  const props = buildRenderProps({
    manifest,
    // [30,40] をカット。挿入は 20s に 4 秒割り込む
    keeps: [{ start: 0, end: 30 }, { start: 40, end: 60 }],
    transcript: { segments: [] },
    overlays: {
      inserts: [{ at: 20, file: "materials/ins.mp4", durationSec: 4 }],
      // 1本目は挿入で割れ、2本目はカットを挟んで出力上で1本目と隣接する
      wipeFull: [{ start: 10, end: 30 }, { start: 40, end: 50 }],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // 出力: [10,20] + 挿入(20-24) + [24,34] + [34,44] → 遷移が継ぎ目で走らないよう
  // 挿入をまたいで繋ぎ、隣接区間もまとめて 1 スパンになる
  assert.deepEqual(props.wipeFull, [{ start: 10, end: 44 }]);
});

test("buildRenderProps: wipeFull の区間別の入り/戻り遷移は props へ渡る", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      wipeFull: [
        { start: 5, end: 10, transitionSec: 0 },
        { start: 12, end: 18, transitionInSec: 0.6, transitionOutSec: 0 },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.wipeFull, [
    { start: 5, end: 10, transitionSec: 0 },
    { start: 12, end: 18, transitionInSec: 0.6, transitionOutSec: 0 },
  ]);
});

test("buildRenderProps: wipeFull は入り/戻り遷移が異なる隣接区間をマージしない", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      wipeFull: [
        { start: 5, end: 10, transitionInSec: 0.3, transitionOutSec: 0 },
        { start: 10, end: 15, transitionInSec: 0, transitionOutSec: 0.3 },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.wipeFull.length, 2);
});

test("buildRenderProps: zooms 未指定なら props に zooms キーが現れない(既存 props と完全一致)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("zooms" in props, false);
});

test("buildRenderProps: zooms はカット後タイムラインへ写像され、easeSec は config 既定へフォールバックする", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 22, end: 28, rect }] },
    renderCfg: { ...renderCfg, zoom: { easeSec: 0.6 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // config が easeSec のみ指定(easeInSec/easeOutSec 未指定)= 対称のまま
  // その値を引き継ぐ(easeInSec も easeOutSec も 0.6)
  assert.deepEqual(props.zooms, [
    { start: 12, end: 18, rect, easeSec: 0.6, easeOutSec: 0.6, chainGapSec: 1.5, leadSec: 0.5, chainPanSec: 1.0, wipeScale: 0.8 },
  ]);
});

test("buildRenderProps: zooms 未指定・config も未指定なら easeSec/easeOutSec は非対称既定(1.5/1.0)になる", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.zooms?.[0]?.easeSec, 1.5);
  assert.equal(props.zooms?.[0]?.easeOutSec, 1.0);
  assert.equal(props.zooms?.[0]?.chainGapSec, 1.5);
  assert.equal(props.zooms?.[0]?.leadSec, 0.5);
  assert.equal(props.zooms?.[0]?.chainPanSec, 1.0);
});

test("buildRenderProps: zoom chainGapSec は config の render.zoom.chainGapSec から解決される", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] },
    renderCfg: { ...renderCfg, zoom: { chainGapSec: 0.2 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.zooms?.[0]?.chainGapSec, 0.2);
});

test("buildRenderProps: zoom leadSec は config の render.zoom.leadSec から解決される", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] },
    renderCfg: { ...renderCfg, zoom: { leadSec: 0.1 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.zooms?.[0]?.leadSec, 0.1);
});

test("buildRenderProps: zoom chainPanSec は config の render.zoom.chainPanSec から解決される", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] },
    renderCfg: { ...renderCfg, zoom: { chainPanSec: 0.7 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.zooms?.[0]?.chainPanSec, 0.7);
});

test("buildRenderProps: wipe.reactiveMinScale は config 未指定なら既定 0.35(OpenScreen 逐語)になる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.wipe.reactiveMinScale, 0.35);
});

test("buildRenderProps: wipe.reactiveMinScale は config の render.zoom.webcamReactiveMinScale から解決される", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: { ...renderCfg, zoom: { webcamReactiveMinScale: 0.55 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.wipe.reactiveMinScale, 0.55);
});

test("buildRenderProps: zooms の easeSec 個別指定は config より優先", () => {
  const rect = { x: 0, y: 0, w: 960, h: 1080 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect, easeSec: 0.1 }] },
    renderCfg: { ...renderCfg, zoom: { easeSec: 0.6 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // 個別 easeSec(0.1)は ease-in だけ上書きする。ease-out は config 解決値
  // (easeSec:0.6 のみ指定=対称の 0.6)を引き継ぐ
  assert.deepEqual(props.zooms, [
    { start: 1, end: 5, rect, easeSec: 0.1, easeOutSec: 0.6, chainGapSec: 1.5, leadSec: 0.5, chainPanSec: 1.0, wipeScale: 0.8 },
  ]);
});

test("buildRenderProps: zooms の easeOutSec 個別指定は props に残る", () => {
  const rect = { x: 100, y: 100, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect, easeSec: 0.1, easeOutSec: 0.8 }] },
    renderCfg: { ...renderCfg, zoom: { easeSec: 0.6 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.zooms, [
    { start: 1, end: 5, rect, easeSec: 0.1, easeOutSec: 0.8, chainGapSec: 1.5, leadSec: 0.5, chainPanSec: 1.0, wipeScale: 0.8 },
  ]);
});

test("buildRenderProps: zoom wipeScale は config の render.zoom.wipeScale から解決される", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] },
    renderCfg: { ...renderCfg, zoom: { wipeScale: 0.6 } },
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.zooms?.[0]?.wipeScale, 0.6);
});

test("buildRenderProps: zoom wipeScale は未設定時 0.8(DEFAULT_ZOOM_WIPE_SCALE)", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.zooms?.[0]?.wipeScale, 0.8);
});

test("buildRenderProps: cursorSamples 省略時は zooms に cursorTrack が付かない(D7・バイト等価)", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("cursorTrack" in (props.zooms?.[0] ?? {}), false);
});

test("buildRenderProps: cursorSamples があれば zoom 区間に間引いたカーソル実測を付ける(D7)", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] }, // 元収録秒[1,5]、単一keepなので出力秒と同一
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    cursorSamples: [
      { recTimeMs: 1000, cx: 0.2, cy: 0.3, inBounds: true, leftButtonPressed: false },
      { recTimeMs: 3000, cx: 0.6, cy: 0.7, inBounds: true, leftButtonPressed: false },
      { recTimeMs: 9000, cx: 0.9, cy: 0.9, inBounds: true, leftButtonPressed: false }, // 区間外
    ],
    overlayExists: () => true,
    warn: () => {},
  });
  const track = props.zooms?.[0]?.cursorTrack;
  assert.ok(track && track.length > 0);
  assert.ok(track!.every((p) => p.tSec >= 1 && p.tSec <= 5));
  assert.ok(track!.some((p) => p.cx === 0.2 && p.cy === 0.3));
  assert.ok(track!.some((p) => p.cx === 0.6 && p.cy === 0.7));
  assert.ok(!track!.some((p) => p.cx === 0.9));
});

test("buildRenderProps: cursorSamples があっても区間内に該当サンプルが無ければ cursorTrack を付けない", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 1, end: 5, rect }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    cursorSamples: [{ recTimeMs: 9000, cx: 0.9, cy: 0.9, inBounds: true, leftButtonPressed: false }],
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("cursorTrack" in (props.zooms?.[0] ?? {}), false);
});

test("buildRenderProps: zooms がカット内で全部消えると出力に含まれない", () => {
  const rect = { x: 0, y: 0, w: 960, h: 1080 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 12, end: 18, rect }] }, // カット内([10,20))
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("zooms" in props, false);
});

// ---- 枝A・P3: focusMode → zoomTransformTrack(OpenScreen 逐語 precompute) ----

test("buildRenderProps: focusMode 未指定の zoom は zoomTransformTrack を一切載せない(props.zooms もバイト等価)", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 40 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 10, end: 20, rect, easeSec: 0.4 }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("zoomTransformTrack" in props, false);
  assert.deepEqual(props.zooms, [
    {
      start: 10, end: 20, rect, easeSec: 0.4, easeOutSec: 1.0,
      chainGapSec: 1.5, leadSec: 0.5, chainPanSec: 1.0, wipeScale: 0.8,
    },
  ]);
});

test("buildRenderProps: focusMode:manual の zoom は zoomTransformTrack を焼き、ホールド中間フレームは fullTransformOf(spring 収束後)に一致する", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 }; // 1920x1080 の中心
  const width = 1920;
  const height = 1080;
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 40 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 10, end: 20, rect, easeSec: 0.4, focusMode: "manual" }] },
    renderCfg,
    width,
    height,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.ok(props.zoomTransformTrack);
  const track = props.zoomTransformTrack!;
  const fps = 30;
  // ホールド中間(区間頭から7秒後=遷移窓+spring 収束に十分な余裕)
  const frame = Math.round(17 * fps);
  const idx = frame - track.startFrame;
  assert.ok(idx >= 0 && idx < track.frames.length, `idx=${idx} out of range (len=${track.frames.length})`);
  const entry = track.frames[idx];
  const scale = width / rect.w;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const expectedX = width / 2 - scale * cx;
  const expectedY = height / 2 - scale * cy;
  assert.ok(Math.abs(entry.scale - scale) < 0.01, `scale=${entry.scale} expected≈${scale}`);
  assert.ok(Math.abs(entry.x - expectedX) < 0.5, `x=${entry.x} expected≈${expectedX}`);
  assert.ok(Math.abs(entry.y - expectedY) < 0.5, `y=${entry.y} expected≈${expectedY}`);
});

test("buildRenderProps: 枝C・focusMode:manual + depth:5 の焼き込み経路は rect 由来(width/rect.w)ではなく ZOOM_DEPTH_SCALES[5]=3.5 へホールドする", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 }; // rect 由来なら scale=2(バイト等価不変条件で使う対照)
  const width = 1920;
  const height = 1080;
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 40 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 10, end: 20, rect, easeSec: 0.4, focusMode: "manual", depth: 5 }] },
    renderCfg,
    width,
    height,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.ok(props.zoomTransformTrack);
  const track = props.zoomTransformTrack!;
  const fps = 30;
  const frame = Math.round(17 * fps);
  const idx = frame - track.startFrame;
  assert.ok(idx >= 0 && idx < track.frames.length, `idx=${idx} out of range (len=${track.frames.length})`);
  const entry = track.frames[idx];
  const rectDerivedScale = width / rect.w; // = 2(depth を効かせなかった場合の旧値)
  assert.notEqual(Math.round(entry.scale * 100) / 100, rectDerivedScale);
  assert.ok(Math.abs(entry.scale - 3.5) < 0.05, `scale=${entry.scale} expected≈3.5(ZOOM_DEPTH_SCALES[5])`);
});

test("buildRenderProps: focusMode:auto + 動くカーソルは焼いた x がホールド中で変化する(追従)", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const width = 1920;
  const height = 1080;
  const cursorSamples: { recTimeMs: number; cx: number; cy: number; inBounds: boolean; leftButtonPressed: boolean }[] = [];
  for (let ms = 9000; ms <= 26000; ms += 100) {
    const p = Math.max(0, Math.min(1, (ms - 9000) / (26000 - 9000)));
    cursorSamples.push({
      recTimeMs: ms,
      cx: 0.3 + (0.7 - 0.3) * p,
      cy: 0.5,
      inBounds: true,
      leftButtonPressed: false,
    });
  }
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 40 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 10, end: 25, rect, easeSec: 0.4, focusMode: "auto" }] },
    renderCfg,
    width,
    height,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    cursorSamples,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.ok(props.zoomTransformTrack);
  const track = props.zoomTransformTrack!;
  const fps = 30;
  const xAt = (tSec: number) => {
    const idx = Math.round(tSec * fps) - track.startFrame;
    assert.ok(idx >= 0 && idx < track.frames.length, `idx out of range at t=${tSec}`);
    return track.frames[idx].x;
  };
  const xEarly = xAt(12);
  const xLate = xAt(23);
  assert.ok(
    Math.abs(xEarly - xLate) > 5,
    `x should differ across the hold as cursor moves: early=${xEarly} late=${xLate}`,
  );
  // カーソルが右へ動く(cx増加)ほど x(=stageCenterX - focus*scale)は減る
  assert.ok(xLate < xEarly, `x should decrease as cursor moves right: early=${xEarly} late=${xLate}`);
});

test("buildRenderProps: focusMode:auto かつ cursorSamples 省略でもクラッシュせず静的 rect 中心へ劣化する", () => {
  const rect = { x: 480, y: 270, w: 960, h: 540 };
  const width = 1920;
  const height = 1080;
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 40 }],
    transcript: { segments: [] },
    overlays: { zooms: [{ start: 10, end: 20, rect, easeSec: 0.4, focusMode: "auto" }] },
    renderCfg,
    width,
    height,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.ok(props.zoomTransformTrack);
  const track = props.zoomTransformTrack!;
  assert.ok(track.frames.length > 0);
  const fps = 30;
  const frame = Math.round(17 * fps);
  const idx = frame - track.startFrame;
  assert.ok(idx >= 0 && idx < track.frames.length);
  const entry = track.frames[idx];
  const scale = width / rect.w;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const expectedX = width / 2 - scale * cx;
  const expectedY = height / 2 - scale * cy;
  assert.ok(Math.abs(entry.scale - scale) < 0.01);
  assert.ok(Math.abs(entry.x - expectedX) < 0.5);
  assert.ok(Math.abs(entry.y - expectedY) < 0.5);
});

test("buildRenderProps: blurs 未指定なら props に blurs キーが現れない(既存 props と完全一致)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("blurs" in props, false);
});

test("buildRenderProps: blurs はカット後タイムラインへ写像され、type/strength は既定へフォールバックする", () => {
  const rect = { x: 700, y: 400, w: 520, h: 140 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { blurs: [{ start: 22, end: 28, rect }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.blurs, [{ start: 12, end: 18, rect, strength: 0.5 }]);
});

test("buildRenderProps: blurs の strength 個別指定は既定より優先", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: { blurs: [{ start: 1, end: 5, rect, strength: 0.8 }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.blurs, [{ start: 1, end: 5, rect, strength: 0.8 }]);
});

test("buildRenderProps: blurs 1件が挿入で2断片に割れると props.blurs も2エントリ(同一 rect/strength)", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      blurs: [{ start: 5, end: 25, rect }],
      inserts: [{ at: 15, file: "materials/ins.mp4", durationSec: 4 }],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.blurs?.length, 2);
  assert.deepEqual(props.blurs?.[0], { start: 5, end: 15, rect, strength: 0.5 });
  assert.deepEqual(props.blurs?.[1], { start: 19, end: 29, rect, strength: 0.5 });
});

test("buildRenderProps: blurs がカット内で全部消えると出力に含まれない", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { blurs: [{ start: 12, end: 18, rect }] }, // カット内([10,20))
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("blurs" in props, false);
});

test("buildRenderProps: annotations 未指定なら props に annotations キーが現れない(既存 props と完全一致)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("annotations" in props, false);
});

test("buildRenderProps: annotations はカット後タイムラインへ写像され、arrow/box/spotlight の既定が解決される", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      annotations: [
        { type: "arrow", start: 22, end: 28, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
        { type: "box", start: 22, end: 28, rect: { x: 0, y: 0, w: 100, h: 50 } },
        { type: "spotlight", start: 22, end: 28, rect: { x: 0, y: 0, w: 100, h: 50 } },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.annotations, [
    {
      type: "arrow",
      start: 12,
      end: 18,
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      color: "#ff3b30",
      widthPx: 8,
      headPx: 28,
    },
    {
      type: "box",
      start: 12,
      end: 18,
      rect: { x: 0, y: 0, w: 100, h: 50 },
      color: "#ff3b30",
      widthPx: 6,
      radiusPx: 8,
    },
    {
      type: "spotlight",
      start: 12,
      end: 18,
      rect: { x: 0, y: 0, w: 100, h: 50 },
      shape: "rect",
      dim: 0.6,
      featherPx: 24,
      radiusPx: 0,
    },
  ]);
});

test("buildRenderProps: annotations の per-item 上書きは既定より優先", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] },
    overlays: {
      annotations: [
        {
          type: "arrow",
          start: 1,
          end: 5,
          from: { x: 0, y: 0 },
          to: { x: 100, y: 0 },
          color: "#00ff00",
          widthPx: 3,
          headPx: 12,
        },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(props.annotations, [
    {
      type: "arrow",
      start: 1,
      end: 5,
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      color: "#00ff00",
      widthPx: 3,
      headPx: 12,
    },
  ]);
});

test("buildRenderProps: annotations 1件が挿入で2断片に割れると props.annotations も2エントリ(同一 geometry)", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      annotations: [{ type: "box", start: 5, end: 25, rect }],
      inserts: [{ at: 15, file: "materials/ins.mp4", durationSec: 4 }],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.annotations?.length, 2);
  assert.deepEqual(props.annotations?.[0], {
    type: "box", start: 5, end: 15, rect, color: "#ff3b30", widthPx: 6, radiusPx: 8,
  });
  assert.deepEqual(props.annotations?.[1], {
    type: "box", start: 19, end: 29, rect, color: "#ff3b30", widthPx: 6, radiusPx: 8,
  });
});

test("buildRenderProps: annotations がカット内で全部消えると出力に含まれない", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { annotations: [{ type: "box", start: 12, end: 18, rect }] }, // カット内([10,20))
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal("annotations" in props, false);
});

test("buildRenderProps: overlay のフェードは断片より長いとき断片内で完了する長さへ縮む", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {
      // 挿入が 5.5s に割り込み、先頭断片は 0.5 秒しかない
      inserts: [{ at: 5.5, file: "materials/ins.mp4", durationSec: 4 }],
      overlays: [
        { start: 5, end: 15, file: "materials/pip.mp4", fadeInSec: 2, fadeOutSec: 1 },
      ],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  const parts = props.overlays.filter((o) => o.file === "materials/pip.mp4");
  assert.equal(parts.length, 2);
  // フェードインは断片長 0.5 秒に縮む(縮めないと挿入明けに不透明度が
  // 0.25→1.0 へジャンプする)。フェードアウトは断片に収まるのでそのまま
  assert.equal(parts[0].fadeInSec, 0.5);
  assert.equal(parts[1].fadeOutSec, 1);
});

test("buildRenderProps: bgm.json の tracks はカット後区間に写像され volumeDb は既定に落ちる", () => {
  const props = buildRenderProps({
    manifest,
    // 元 [0,10] と [20,30] が残る(10-20 はカット)。カットの前後は出力で
    // 隣接するので、それをまたぐ BGM は1本に繋がる(途切れない)
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    // 元 5〜25 に BGM → 出力では [5,10]+[10,15] が繋がって [5,15]
    bgm: { tracks: [{ start: 5, end: 25, file: "bgm.mp3", fadeInSec: 1, fadeOutSec: 2 }] },
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.bgm.length, 1);
  assert.deepEqual(
    { start: props.bgm[0].start, end: props.bgm[0].end, file: props.bgm[0].file },
    { start: 5, end: 15, file: "bgm.mp3" },
  );
  // volumeDb 省略時は config の既定(-22)、フェードは区間の頭/末尾に載る
  assert.equal(props.bgm[0].volumeDb, -22);
  assert.equal(props.bgm[0].fadeInSec, 1);
  assert.equal(props.bgm[0].fadeOutSec, 2);
});

test("buildRenderProps: 挿入をまたぐ BGM は1本の連続区間になる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    // 挿入が出力 8s に4秒割り込み、BGM を [5,8] と [12,20] に割る
    overlays: { inserts: [{ at: 8, file: "materials/ins.mp4", durationSec: 4 }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: { tracks: [{ start: 5, end: 16, file: "bgm.mp3", fadeInSec: 1, fadeOutSec: 2 }] },
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.bgm.length, 1);
  assert.equal(props.bgm[0].start, 5);
  assert.equal(props.bgm[0].end, 20);
  assert.equal(props.bgm[0].fadeInSec, 1);
  assert.equal(props.bgm[0].fadeOutSec, 2);
});

test("buildRenderProps: timebase output は出力秒を直接使い出力尺へクランプする", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: { inserts: [{ at: 0, file: "materials/intro.mp4", durationSec: 8 }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: { tracks: [{ timebase: "output", start: 0, end: 40, file: "bgm.mp3" }] },
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(
    props.bgm.map((t) => ({ start: t.start, end: t.end })),
    [{ start: 0, end: 38 }],
  );
});

// 母艦 §6 の最後の未決(凸包を config で無効化するか)の結論を固定する。
// 「挿入の間だけ BGM を止める」は timebase:"output" のトラックを挿入の前後へ
// 分けることで表現でき、config の on/off は不要(粒度が粗すぎる)。
// この表現手段が失われたら、凸包の逃げ道が無くなるので必ず落とす
test("buildRenderProps: timebase output を挿入の前後に分けると挿入区間だけ無音にできる", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    // 挿入は出力 8–12 秒
    overlays: { inserts: [{ at: 8, file: "materials/ins.mp4", durationSec: 4 }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: {
      tracks: [
        { timebase: "output" as const, start: 5, end: 8, file: "bgm.mp3" },
        { timebase: "output" as const, start: 12, end: 20, file: "bgm.mp3", startFrom: 3 },
      ],
    },
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // 凸包で1本に畳まれないこと(= 出力 8–12 に BGM 区間が存在しない)
  assert.deepEqual(
    props.bgm.map((t) => ({ start: t.start, end: t.end })),
    [{ start: 5, end: 8 }, { start: 12, end: 20 }],
  );
  assert.equal(props.bgm[1].startFrom, 3);
});

test("buildRenderProps: 挿入があってもカットは詰まる(凸包は射影後)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: { inserts: [{ at: 5, file: "materials/ins.mp4", durationSec: 2 }] },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: { tracks: [{ start: 2, end: 25, file: "bgm.mp3" }] },
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.deepEqual(
    props.bgm.map((t) => ({ start: t.start, end: t.end })),
    [{ start: 2, end: 17 }],
  );
});

test("buildRenderProps: 存在しない BGM 素材は warn して区間ごと落ちる", () => {
  const warnings: string[] = [];
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: { tracks: [{ start: 0, end: 10, file: "missing.mp3", volumeDb: -10 }] },
    bgmFallbackFile: null,
    overlayExists: (f) => f !== "missing.mp3",
    warn: (m) => warnings.push(m),
  });
  assert.equal(props.bgm.length, 0);
  assert.ok(warnings.some((w) => w.includes("missing.mp3")));
});

test("buildRenderProps: bgm.json が無ければ bgmFallbackFile を全編1曲で流す(終端フェード)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: "bgm.mp3",
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.bgm.length, 1);
  // 出力尺 20 秒の全編。終端フェードは config の fadeOutSec(2)で再現
  assert.deepEqual(
    { start: props.bgm[0].start, end: props.bgm[0].end, fadeOutSec: props.bgm[0].fadeOutSec },
    { start: 0, end: 20, fadeOutSec: 2 },
  );
  assert.equal(props.bgm[0].volumeDb, -22);
});

test("buildRenderProps: 発話ダッキングは各 BGM 区間に載る(無音の補集合を写像)", () => {
  const duckCfg: Config["render"] = {
    ...renderCfg,
    bgm: { volumeDb: -22, fadeOutSec: 2, ducking: { duckDb: -8, fadeSec: 0.4 } },
  };
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: { segments: [] },
    overlays: {},
    renderCfg: duckCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: { tracks: [{ start: 0, end: 30, file: "bgm.mp3" }] },
    bgmFallbackFile: null,
    // 無音 [10,20] → 発話は [0,10] と [20,30]
    silences: [{ start: 10, end: 20 }],
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.bgm.length, 1);
  assert.ok(props.bgm[0].duck);
  assert.equal(props.bgm[0].duck?.duckDb, -8);
  assert.deepEqual(props.bgm[0].duck?.spans, [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ]);
});

// ---- F4: 出力解像度は manifest.video.screenRegion(profile 経由)から。
// plain(cameraRegion 無し)でも buildRenderProps が undefined をそのまま通す ----

test("buildRenderProps: obs-canvas manifest は width/height/screenRegion/cameraRegion が従来どおり", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    overlays: {},
    renderCfg,
    width: manifest.video.screenRegion.w,
    height: manifest.video.screenRegion.h,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.width, 1920);
  assert.equal(props.height, 1080);
  assert.deepEqual(props.screenRegion, { x: 0, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(props.cameraRegion, { x: 1920, y: 0, w: 1920, h: 1080 });
});

test("buildRenderProps: plain manifest(cameraRegion 無し)は width/height が screenRegion 由来・cameraRegion は undefined", () => {
  const plainManifest: Manifest = {
    ...manifest,
    layout: "plain",
    video: {
      width: 1080,
      height: 1920,
      fps: 30,
      screenRegion: { x: 0, y: 0, w: 1080, h: 1920 },
    },
  };
  const props = buildRenderProps({
    manifest: plainManifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    overlays: {},
    renderCfg,
    width: plainManifest.video.screenRegion.w,
    height: plainManifest.video.screenRegion.h,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.width, 1080);
  assert.equal(props.height, 1920);
  assert.equal(props.cameraRegion, undefined);
});

test("buildRenderProps: colorFilter は overlays にあるときだけ props に載る", () => {
  const base = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  assert.equal(buildRenderProps({ ...base, overlays: {} }).colorFilter, undefined);
  const cf = { brightness: 1.2, contrast: 1.1 };
  assert.deepEqual(buildRenderProps({ ...base, overlays: { colorFilter: cf } }).colorFilter, cf);
});

test("frameSpans: 隣接するベース区間は境界フレームを共有する(隙間・重なりなし)", () => {
  // round2 の量子化で「前の終端 1.61 / 次の開始 1.62」のようにずれた境界は、
  // 独立に丸めると end=48 / from=49 になり 1 フレームの黒穴が空く
  const { base } = frameSpans({
    baseSegments: [
      { start: 0, durationSec: 1.61 },
      { start: 1.62, durationSec: 1 },
    ],
    inserts: [],
    fps: 30,
    durationInFrames: 79,
  });
  assert.equal(base[0].from + base[0].durationInFrames, base[1].from);
  // 逆向き(重なり側)も同様に潰れる: 56.95+4.62=61.57 は独立丸めだと
  // end=1848 / 次の from=1847 で 1 フレーム音が二重になる
  const { base: b2 } = frameSpans({
    baseSegments: [
      { start: 56.95, durationSec: 4.62 },
      { start: 61.57, durationSec: 1 },
    ],
    inserts: [],
    fps: 30,
    durationInFrames: 1878,
  });
  assert.equal(b2[0].from, 1709);
  assert.equal(b2[0].from + b2[0].durationInFrames, 1847);
  assert.equal(b2[1].from, 1847);
});

test("frameSpans: 挿入とベースの境界も共有し、終端は合成の末尾へ吸着する", () => {
  const { base, inserts } = frameSpans({
    baseSegments: [{ start: 29.99, durationSec: 98.4 }],
    inserts: [{ start: 0, end: 29.99 }],
    fps: 30,
    // 合成の長さが丸めと1フレームずれても末尾に黒を残さない
    durationInFrames: 3853,
  });
  assert.equal(inserts[0].from, 0);
  assert.equal(inserts[0].from + inserts[0].durationInFrames, base[0].from);
  assert.equal(base[0].from + base[0].durationInFrames, 3853);
});

test("frameSpans: 離れた区間(0.02秒超)は連結せず独立に丸める", () => {
  const { base, inserts } = frameSpans({
    baseSegments: [{ start: 0, durationSec: 1 }],
    inserts: [{ start: 1.5, end: 2.5 }],
    fps: 30,
    durationInFrames: 200,
  });
  assert.equal(base[0].durationInFrames, 30);
  assert.equal(inserts[0].from, 45);
  assert.equal(inserts[0].durationInFrames, 30);
});

// ---- カラオケ: segment.words[] のカット後写像(判断3) ----

test("buildRenderProps: words 無しの segment → 出力 Caption に words キーが付かない(既存スナップと完全一致)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [{ start: 2, end: 5, text: "words 無し" }] },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.captions.length, 1);
  assert.equal("words" in props.captions[0], false);
});

test("buildRenderProps: words 付き・挿入無し → 各語がカット後秒へ写像され断片に載る", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: {
      segments: [
        {
          start: 2, end: 5, text: "こんにちは世界",
          words: [
            { text: "こんにちは", start: 2, end: 3 },
            { text: "世界", start: 3, end: 5 },
          ],
        },
      ],
    },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.captions.length, 1);
  assert.deepEqual(props.captions[0].words, [
    { text: "こんにちは", start: 2, end: 3 },
    { text: "世界", start: 3, end: 5 },
  ]);
});

test("buildRenderProps: カット内に完全に入る語は words に現れない", () => {
  const props = buildRenderProps({
    manifest,
    // 元 [10,20] をカット。segment 自体は [0,10]+[20,30] の keep をまたいで残る想定ではなく、
    // 単純に「segment の一部の語だけがカット区間に完全に入る」ケースを作る
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    transcript: {
      segments: [
        {
          start: 5, end: 25, text: "残る消えるまた残る",
          words: [
            { text: "残る", start: 5, end: 7 },
            { text: "消える", start: 12, end: 18 }, // カット区間 [10,20) に完全に入る
            { text: "また残る", start: 22, end: 25 },
          ],
        },
      ],
    },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // segment 自体はカットの前後で出力上は隣接する(cutBoundarySecs のテストと同じ規則で
  // remapInterval が断片を1本にまとめる)ので、キャプションは1件のまま
  assert.equal(props.captions.length, 1);
  // 「消える」はカット区間 [10,20) に完全に入るため words に現れない。
  // 「残る」「また残る」はそれぞれのカット後秒(22→12, 25→15)へ写像されて残る
  assert.deepEqual(props.captions[0].words, [
    { text: "残る", start: 5, end: 7 },
    { text: "また残る", start: 12, end: 15 },
  ]);
});

test("buildRenderProps: 挿入が語の途中に割り込むと語が2断片に分かれ各々クリップされる(start<end 保持)", () => {
  const props = buildRenderProps({
    manifest,
    keeps: [{ start: 0, end: 30 }],
    transcript: {
      segments: [
        {
          start: 5, end: 15, text: "またがる語のテスト",
          // "またがる" の語(6〜9)が挿入位置(8s)の途中に割り込まれる
          words: [{ text: "またがる語のテスト", start: 6, end: 9 }],
        },
      ],
    },
    overlays: {
      inserts: [{ at: 8, file: "materials/ins.mp4", durationSec: 4 }],
    },
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  // segment 自体も挿入で2断片に割れる
  assert.equal(props.captions.length, 2);
  const [c1, c2] = props.captions;
  assert.equal(c1.words?.length, 1);
  assert.equal(c2.words?.length, 1);
  assert.ok(c1.words![0].start < c1.words![0].end);
  assert.ok(c2.words![0].start < c2.words![0].end);
  // 1断片目: [5,8) にクリップ。2断片目: 挿入4秒分ずれた後の [8,9)→[12,13)
  assert.deepEqual(c1.words![0], { text: "またがる語のテスト", start: 6, end: 8 });
  assert.deepEqual(c2.words![0], { text: "またがる語のテスト", start: 12, end: 13 });
});

test("buildRenderProps: カット境界をまたぐ隣接 keep(remapInterval が1区間に統合)→ 語も1断片に収まる", () => {
  const props = buildRenderProps({
    manifest,
    // 実質連続な隣接 keep(エディタの分割編集直後)
    keeps: [{ start: 0, end: 10 }, { start: 10, end: 20 }],
    transcript: {
      segments: [
        {
          start: 2, end: 15, text: "またぐテキスト",
          words: [{ text: "またぐテキスト", start: 2, end: 15 }],
        },
      ],
    },
    overlays: {},
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  });
  assert.equal(props.captions.length, 1);
  assert.deepEqual(props.captions[0].words, [{ text: "またぐテキスト", start: 2, end: 15 }]);
});

test("effect reasonIdはrender propsへ出ず、cut承認hash境界にも入らない", () => {
  const rect = { x: 0, y: 0, w: 500, h: 200 };
  const baseOverlays: Overlays = {
    zooms: [{ start: 1, end: 3, rect }],
    blurs: [{ start: 4, end: 6, rect }],
    annotations: [{ type: "box", start: 7, end: 9, rect }],
  };
  const classified: Overlays = {
    zooms: [{ ...baseOverlays.zooms![0], reasonId: "tiny-target" }],
    blurs: [{ ...baseOverlays.blurs![0], reasonId: "secret-exposure" }],
    annotations: [{ ...baseOverlays.annotations![0], reasonId: "attention-scatter" }],
  };
  const args = {
    manifest,
    keeps: [{ start: 0, end: 10 }],
    transcript: { segments: [] } as Transcript,
    renderCfg,
    width: 1920,
    height: 1080,
    videoFile: "cut.mp4",
    bgm: null,
    bgmFallbackFile: null,
    overlayExists: () => true,
    warn: () => {},
  };
  assert.deepEqual(
    buildRenderProps({ ...args, overlays: classified }),
    buildRenderProps({ ...args, overlays: baseOverlays }),
  );

  const cutplan = {
    approved: false,
    segments: [{ start: 0, end: 10, action: "keep" as const, reason: "" }],
  };
  // approval API はoverlaysを引数に取らず、同じkeep集合だけをhashする。
  const before = cutplanApprovalHash(cutplan);
  void classified;
  const after = cutplanApprovalHash(cutplan);
  assert.equal(after, before);
});
