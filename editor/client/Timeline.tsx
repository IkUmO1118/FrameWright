import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import { capNum, ovNum } from "../../src/types.ts";
import type { LayerId } from "../../src/types.ts";
import type {
  AudioTrackId,
  Clip,
  CutMark,
  DragMode,
  Selection,
  TrackDef,
  TrackId,
} from "./model.ts";
import { DIFF_ROW_H, DIFF_TRACK_PREFIX, MATERIAL_MIME, PRESET_MIME, trackHeightFor } from "./model.ts";
import type { DiffTrackDef } from "./model.ts";
import type { Hunk } from "../../src/lib/docDiff.ts";
import {
  sheetCellFor,
  thumbIndexForSourceSec,
  tileSourceSec,
  visibleTileRange,
} from "../../src/lib/thumbstrip.ts";
import type { ThumbstripLevel } from "../../src/lib/thumbstrip.ts";
import { reviewEventStatus } from "../../src/lib/reviewEvents.ts";
import { playhead, usePlayheadSelector } from "./playhead.ts";
import { projectPath } from "./route.ts";
import {
  AUDIO_EXT_RE,
  DuplicateIcon,
  EyeIcon,
  MagnetIcon,
  SplitIcon,
  TrashIcon,
  UndoIcon,
  VolumeIcon,
  fmtTime,
} from "./widgets.tsx";
import type { Peaks } from "./widgets.tsx";

/** 再生ヘッドの縦線(ルーラーのつまみ・トラック上の線)。再生中の毎フレーム
 * 更新をこの1要素に閉じ込める(Timeline 全体は再レンダーしない) */
const PlayheadMark = ({ className, pps }: { className: string; pps: number }) => {
  const left = usePlayheadSelector((t) => t * pps);
  return <div className={className} style={{ left }} />;
};

/** 分割ボタン。活性が再生ヘッド位置で変わるため、ボタン単体で購読する */
const SplitButton = ({
  getDisabled,
  onSplit,
}: {
  getDisabled: (outT: number) => boolean;
  onSplit: () => void;
}) => {
  const disabled = usePlayheadSelector(getDisabled);
  return (
    <button
      className="tlTool"
      aria-label="分割"
      title="再生ヘッド位置でクリップを分割 (⌘K)。割っただけでは映像は変わらず、端をトリムして詰める・片側を削除して使う"
      disabled={disabled}
      onClick={onSplit}
    >
      <SplitIcon size={14} />
    </button>
  );
};

/** 波形 canvas のデバイスピクセル幅の上限。超えるぶんは CSS で引き伸ばす
 * (高ズームの巨大クリップで canvas メモリが膨れないように。時間軸の比率は
 * 一様な引き伸ばしなので位置はずれない) */
const WAVE_MAX_W = 8192;

/**
 * クリップに重ねる音声の波形。ピーク列の時刻軸(マイク = 元収録の秒、
 * 素材・BGM = ファイル自身の秒)から [srcStart, srcStart+durSec) を
 * 切り出して中央線対称に描く。トリムで端がカット領域へ伸びてもそこの
 * 音が見える。loop はファイル末尾で先頭へ戻る(BGM のループ合成と同じ)。
 * memo: ドラッグ中はクリップ配列が毎回作り直されるので、動かしていない
 * クリップの再描画を props 比較で抑える
 */
const Waveform = memo(
  ({
    peaks,
    srcStart,
    durSec,
    pxWidth,
    pxHeight,
    loop = false,
  }: {
    peaks: Peaks;
    /** クリップ先頭に対応する音声内の秒 */
    srcStart: number;
    /** クリップの長さ(秒) */
    durSec: number;
    /** クリップの表示幅(CSS px) */
    pxWidth: number;
    /** クリップの表示高さ(CSS px)。トラックの高さに追従する */
    pxHeight: number;
    loop?: boolean;
  }) => {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
      const cv = ref.current;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.min(Math.round(pxWidth * dpr), WAVE_MAX_W));
      const h = Math.max(1, Math.round(pxHeight * dpr));
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(170, 205, 255, 0.5)";
      const mid = h / 2;
      const { rate, data } = peaks;
      if (data.length === 0) return;
      const binsPerPx = (durSec * rate) / w;
      const base = srcStart * rate;
      for (let x = 0; x < w; x++) {
        // この列が覆うピークの最大値(1px 未満のときは最寄りの1本)
        const b0 = Math.floor(base + x * binsPerPx);
        const b1 = Math.max(b0 + 1, Math.ceil(base + (x + 1) * binsPerPx));
        let v = 0;
        for (let b = Math.max(0, b0); b < b1; b++) {
          const i = loop ? b % data.length : b;
          if (i >= data.length) break;
          if (data[i] > v) v = data[i];
        }
        if (v === 0) continue;
        // 小さい音も見えるように緩い圧縮をかける(見た目だけ。^0.7)
        const amp = Math.max(dpr * 0.5, Math.pow(v / 255, 0.7) * (mid - dpr));
        ctx.fillRect(x, mid - amp, 1, amp * 2);
      }
    }, [peaks, srcStart, durSec, pxWidth, pxHeight, loop]);
    return <canvas ref={ref} className="tlWave" />;
  },
);

const Filmstrip = memo(({
  level,
  srcStart,
  speed,
  pps,
  clipOutStart,
  clipW,
  pxHeight,
  winStart,
  winEnd,
}: {
  level: ThumbstripLevel;
  srcStart: number;
  speed: number;
  pps: number;
  /** クリップの開始(出力秒)。可視窓との交差計算に使う */
  clipOutStart: number;
  /** クリップの表示幅(CSS px) */
  clipW: number;
  pxHeight: number;
  winStart: number;
  winEnd: number;
}) => {
  const dispH = pxHeight;
  const dispW = Math.max(1, Math.round(dispH * level.tileWidth / level.tileHeight));
  const range = visibleTileRange({ clipOutStart, clipW, pps, dispW, winStart, winEnd });
  if (!range) return null;
  const tiles = [];
  for (let k = range.k0; k < range.k1; k++) {
    const left = k * dispW;
    const width = Math.max(0, Math.min(dispW, clipW - left));
    if (width <= 0) continue;
    const srcSec = tileSourceSec({ k, dispW, pps, srcStart, speed });
    const idx = thumbIndexForSourceSec(srcSec, level);
    if (idx === null) continue;
    const cell = sheetCellFor(idx, level);
    if (!cell) continue;
    const sheet = level.sheets[cell.sheetIndex];
    if (!sheet) continue;
    tiles.push(
      <div
        key={`${k}-${idx}`}
        className="tlFilmTile"
        style={{
          left,
          width,
          height: dispH,
          backgroundImage: `url(${projectPath(`/media/${sheet.file}`)})`,
          backgroundSize: `${level.columns * dispW}px ${level.rows * dispH}px`,
          backgroundPosition: `${-cell.col * dispW}px ${-cell.row * dispH}px`,
        }}
      />,
    );
  }
  if (tiles.length === 0) return null;
  return <div className="tlFilm">{tiles}</div>;
});

/** 水平仮想化のチャンク幅(px)。スクロールがチャンク境界を跨いだときだけ
 * 再レンダーし、可視域±1チャンクに重なるクリップ・目盛り・カット印だけを
 * DOM に置く(長尺収録では全クリップの常時 DOM 化が最大の負荷になる) */
const VIRT_CHUNK = 512;

/** ズームの絶対上限(px/秒)。ズーム上限は「フィット比×64」との大きい方に
 * するので、長尺でもこの密度までは必ず拡大できる(相対上限だけだと2時間の
 * 収録で最大 十数px/秒 になり、テロップ単位の編集が物理的にできない) */
const MAX_PPS = 240;

/** トラック高さの範囲と localStorage キー(最小 = 型別既定。
 * 型別既定より低くは潰せず、広げる方向だけ) */
const ROW_H_MAX = 96;
const TRACK_GAP = 6;
const ROW_H_STORE = "framewright.editor.trackHeights";
/** ドロップ吸着 ON/OFF の保存キー(既定 ON) */
const SNAP_STORE = "framewright.editor.snapEnabled";

/** F2: 現在カットされている区間の提案を示す細い印の幅(px) */
const DIFF_CUT_MARK_W = 3;

/**
 * 画面下部のマルチトラックタイムライン。横軸はカット後の秒、上=前面。
 * ここは「見た目とポインタ操作」だけを持ち、ドキュメントの変換・更新は
 * すべて App 側のコールバックに委ねる(ドラッグ量はカット後の秒で通知)。
 * トラックのラベルを上下にドラッグすると重なり順を並べ替えられる。
 */
export const Timeline = ({
  height,
  duration,
  clips,
  cutMarks,
  peaks,
  thumbstrip,
  tracks,
  selection,
  multiCaption,
  onToggleCaptionSel,
  onSeek,
  onScrubMove,
  onScrubEnd,
  onSelect,
  onSelectTrackHeader,
  onDragStart,
  onDragMove,
  onDragEnd,
  onCreate,
  onReorderTrack,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSplit,
  getSplitDisabled,
  onDelete,
  deleteDisabled,
  onDuplicate,
  dupDisabled,
  onRemoveTrack,
  onRenameTrack,
  onSelectCaptionTrack,
  onDropFile,
  onDropMaterial,
  onDropFileNewTrack,
  onDropMaterialNewTrack,
  newOverlayTrackId,
  dragMaterial,
  presetDragTrack,
  onDropPreset,
  onDropPresetNewTrack,
  trackMuted,
  onToggleTrackMute,
  hiddenLayers,
  onToggleTrackHide,
  defaultDurationSec,
  diffTracks,
  onDiffSetHunk,
  onDiffPreview,
  onDiffInspect,
  diffStills,
  aiClipMarks,
  aiWorkflowHunks,
  aiResolution,
}: {
  height: number;
  duration: number;
  clips: Clip[];
  /** 映像トラックの継ぎ目に出す「カットされた区間」の印(クリックで選択
   * → Inspector で復元)。位置はカット後秒なので幅は持たない */
  cutMarks: CutMark[];
  /** 音声の波形ピーク(キー "" = マイク、他 = 素材・BGM の相対パス)。
   * null = 音声なし/取得失敗(そのクリップは波形なし) */
  peaks: Record<string, Peaks | null>;
  /** 映像トラックへ描くフィルムストリップ。取得不能なら null。 */
  thumbstrip: ThumbstripLevel | null;
  /** 表示順(上=前面)。App が layerOrder から組み立てる */
  tracks: TrackDef[];
  selection: Selection;
  /** 複数選択中のテロップ(transcript.segments の添字。2件以上のときだけ) */
  multiCaption: number[];
  /** テロップクリップの⌘クリック(選択への追加/解除) */
  onToggleCaptionSel: (index: number) => void;
  onSeek: (outT: number) => void;
  /** ルーラーのスクラブ開始/移動。onSeek より先に呼ばれる */
  onScrubMove?: (outT: number) => void;
  /** ルーラーのスクラブ終了。最終時刻を渡す */
  onScrubEnd?: (outT: number) => void;
  onSelect: (sel: Selection) => void;
  onSelectTrackHeader?: (track: TrackId) => void;
  /** clip: 掴んだクリップ(カットで割れたスパンはフラグメントの位置を持つ) */
  onDragStart: (sel: NonNullable<Selection>, mode: DragMode, clip: Clip) => void;
  /** overTrack: move ドラッグ中にポインタが乗っているトラック
   * (素材の V1/V2 レイヤー移動に使う) */
  onDragMove: (deltaOutSec: number, overTrack: TrackId) => void;
  onDragEnd: () => void;
  onCreate: (track: TrackId, outStart: number, outEnd: number) => void;
  /** ラベルのドラッグ先(tracks の添字)。並べ替え可能な範囲へは App が丸める */
  onReorderTrack: (id: TrackId, toIndex: number) => void;
  /** 編集履歴の有無(undo/redo ボタンの活性)。実体は App 側が持つ */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** 再生ヘッド位置でクリップを分割(⌘K)。getSplitDisabled = 分割できる
   * 位置にないか(ボタンが再生ヘッドを購読して都度評価する) */
  onSplit: () => void;
  getSplitDisabled: (outT: number) => boolean;
  /** 選択中のクリップを削除(映像クリップはカット記録へ倒す)。
   * deleteDisabled = 選択なし */
  onDelete: () => void;
  deleteDisabled: boolean;
  /** 選択中のクリップを直後へ複製(⌘D)。dupDisabled = 選択なし/複製非対応 kind */
  onDuplicate: () => void;
  dupDisabled: boolean;
  /** 空の素材/テロップトラックを削除する(番号は詰め直される) */
  onRemoveTrack: (id: TrackId) => void;
  /** テロップトラックの名前を変更(空文字で自動ラベルに戻す)。
   * track = テロップトラック番号(TrackDef.renamableCaption) */
  onRenameTrack: (track: number, name: string) => void;
  /** テロップトラックのラベルを選択(インスペクタでそのトラックの標準デザインを
   * 編集する)。クリップ選択と排他 */
  onSelectCaptionTrack: (track: number) => void;
  /** 素材トラックへのファイルドロップ(outT = ドロップ位置のカット後秒) */
  onDropFile: (track: TrackId, outT: number, file: File) => void;
  /** 素材パネルのカードのドロップ(file = プロジェクト相対パス) */
  onDropMaterial: (track: TrackId, outT: number, file: string) => void;
  /** ルーラー(時間軸)帯へのドロップ = 新しいトラックを作ってそこへ置く。
   * 行 id を渡さないのは、トラックの決定(音声のみ = BGM / それ以外 =
   * 新しい素材トラック)が App 側の責務だから */
  onDropFileNewTrack: (outT: number, file: File) => void;
  onDropMaterialNewTrack: (outT: number, file: string) => void;
  /** ルーラーへ落としたときに作られる素材トラックの id(実際の採番は App が
   * 持つ。ここでは drop ゴーストの宛先表示にだけ使う) */
  newOverlayTrackId: TrackId;
  /** 素材パネルからドラッグ中の素材(ドロップゴーストの幅・ラベルに使う)。
   * null = ドラッグしていない/OS のファイルドラッグ(尺は不明なので既定幅) */
  dragMaterial: { file: string; durationSec: number | null } | null;
  /** ステッカー/エフェクト タブからドラッグ中のプリセットの対象トラック
   * (App の visibleTracks がこのトラックを一時的に可視化する)。
   * null = プリセットをドラッグしていない */
  presetDragTrack: TrackId | null;
  /** プリセットのドロップ(presetId = presets.ts の EditorPreset.id)。
   * 行の決定は dropTrackAt(素材の音声/映像ヒューリスティック)を使わず
   * presetDragTrack をそのまま使う(getData は drop イベントでしか読めない
   * ため、行の決定に使えない) */
  onDropPreset: (outT: number, presetId: string) => void;
  onDropPresetNewTrack: (outT: number, presetId: string) => void;
  /** 音声トラック(映像・BGM)のプレビューミュート状態 */
  trackMuted: Record<AudioTrackId, boolean>;
  onToggleTrackMute: (id: AudioTrackId) => void;
  /** 一時非表示中のレイヤー(ラベルの目トグル。プレビューのみ) */
  hiddenLayers: LayerId[];
  onToggleTrackHide: (id: LayerId) => void;
  /** 画像・尺不明素材の既定の尺(秒)。config の editor.defaultImageDurationSec */
  defaultDurationSec: number;
  diffTracks?: DiffTrackDef[];
  onDiffSetHunk?: (hunks: Hunk[], side: "theirs" | "mine") => void;
  onDiffPreview?: (event: import("../../src/lib/reviewEvents.ts").ReviewEvent) => void;
  /** diff クリップを開いた=「比較を見に行った」という意思表示。 */
  onDiffInspect?: () => void;
  diffStills?: { eventId: string; beforeFile: string; afterFile: string }[];
  /** F7: AI提案の影響を受ける本体クリップ。キーは `${kind}:${index}` */
  aiClipMarks?: Map<string, "remove" | "modify">;
  aiWorkflowHunks?: Hunk[];
  /** F2: hunk ごとの承認状態。diff クリップの色(承認済み/却下)に使う */
  aiResolution?: Map<Hunk, "theirs" | "mine">;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 左のラベル列(縦スクロールを tlScroll と同期させる) */
  const labelsRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const [zoom, setZoom] = useState(1);
  /** 水平スクロール位置のチャンク番号(floor(scrollLeft / VIRT_CHUNK))。
   * ピクセル単位で state に載せると毎スクロールイベントで全体が再レンダー
   * されるので、チャンク境界を跨いだときだけ更新する */
  const [scrollChunk, setScrollChunk] = useState(0);
  const [ghost, setGhost] = useState<{ track: TrackId; a: number; b: number } | null>(null);
  const ghostRef = useRef<typeof ghost>(null);
  const [dragLabel, setDragLabel] = useState<TrackId | null>(null);
  /** クリップの移動・トリム中に吸着した境界の位置(カット後秒)。表示線用 */
  const [snapMark, setSnapMark] = useState<number | null>(null);
  /** トラック名の編集中(テロップトラックのラベルをダブルクリック) */
  const [renaming, setRenaming] = useState<{ id: TrackId; value: string } | null>(null);
  /** ドロップ時の吸着(クリップ境界・再生ヘッド・0/末尾)の ON/OFF */
  const [snapOn, setSnapOn] = useState(
    () => localStorage.getItem(SNAP_STORE) !== "false",
  );
  useEffect(() => {
    localStorage.setItem(SNAP_STORE, String(snapOn));
  }, [snapOn]);
  /** トラックごとの高さ(px)。ラベル下端のドラッグで変更、次回起動時も引き継ぐ */
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(ROW_H_STORE) ?? "");
      if (saved && typeof saved === "object") {
        return Object.fromEntries(
          Object.entries(saved as Record<string, unknown>).filter(
            ([, v]) => typeof v === "number" && Number.isFinite(v),
          ),
        ) as Record<string, number>;
      }
    } catch {
      // 保存なし・壊れた JSON は既定の高さから
    }
    return {};
  });
  useEffect(() => {
    localStorage.setItem(ROW_H_STORE, JSON.stringify(trackHeights));
  }, [trackHeights]);

  const [hoverThumb, setHoverThumb] = useState<{
    eventId: string;
    x: number;
    y: number;
    still: { beforeFile: string; afterFile: string };
  } | null>(null);
  const [popoverEvent, setPopoverEvent] = useState<{
    event: import("../../src/lib/reviewEvents.ts").ReviewEvent;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!popoverEvent) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".tlDiffPopover") && !target.closest(".tlDiffClip")) {
        setPopoverEvent(null);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [popoverEvent]);

  /** トラックの表示高さ(px)。既定は型別、ユーザーは上へだけ広げられる */
  const rowH = (id: TrackId): number => {
    // F3: diff レーンは開閉しないので常に固定高
    if (typeof id === "string" && id.startsWith(DIFF_TRACK_PREFIX)) return DIFF_ROW_H;
    const base = trackHeightFor(id);
    return Math.min(ROW_H_MAX, Math.max(base, trackHeights[id] ?? base));
  };

  const allTracks = useMemo(() => {
    if (!diffTracks || diffTracks.length === 0) return tracks;

    const result: (TrackDef | DiffTrackDef)[] = [];
    const diffMap = new Map<string, DiffTrackDef>();
    for (const dt of diffTracks) {
      diffMap.set(dt.sourceTrack.id, dt);
    }

    for (const track of tracks) {
      const diff = diffMap.get(track.id);
      if (diff) result.push(diff);
      result.push(track);
    }

    return result;
  }, [tracks, diffTracks]);

  /** F3: diff レーンとペアになっている本体トラックの id(セット表示用) */
  const pairedTrackIds = useMemo(
    () => new Set((diffTracks ?? []).map((dt) => dt.sourceTrack.id)),
    [diffTracks],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitPps = viewW > 0 && duration > 0 ? viewW / duration : 50;
  const pps = fitPps * zoom;
  const totalW = Math.max(viewW, Math.ceil(duration * pps));
  /** ズーム上限。フィット比の64倍か、絶対密度 MAX_PPS に達する倍率の
   * 大きい方(短尺では従来と同じ、長尺ではテロップ編集に足る密度まで) */
  const maxZoom = Math.max(64, MAX_PPS / fitPps);

  /** ズーム後もアンカー位置(カーソル/ビュー中央)の時刻が動かないよう、
   * 再レンダー後に合わせるスクロール位置。t = カット後秒, px = ビュー左端からの距離 */
  const pendingAnchor = useRef<{ t: number; px: number } | null>(null);

  /* ---- 仮想化の可視窓(カット後の秒) ----
   * ズーム直後はスクロール補正(下の layout effect)より先に1回描画される
   * ので、アンカーから補正後の位置を予測して窓を出す(予測しないと補正前の
   * 窓で一瞬空白が見える)。窓はチャンク境界に量子化されているので、
   * スクロール中の再レンダーはチャンクを跨ぐときだけ */
  const anchor = pendingAnchor.current;
  const winLeftPx = Math.min(
    Math.max(0, anchor ? anchor.t * pps - anchor.px : scrollChunk * VIRT_CHUNK),
    Math.max(0, totalW - viewW),
  );
  const winStart = Math.max(0, winLeftPx - VIRT_CHUNK) / pps;
  const winEnd = (winLeftPx + viewW + 2 * VIRT_CHUNK) / pps;

  /** factor 倍にズーム(0 で全体表示にリセット)。anchorClientX を渡すと
   * その画面座標、省略時はビュー中央を基準に拡縮する */
  const applyZoom = (factor: number, anchorClientX?: number) => {
    const next = factor === 0 ? 1 : Math.min(maxZoom, Math.max(1, zoom * factor));
    if (next === zoom) return;
    const el = scrollRef.current;
    if (el && next > 1) {
      const px =
        anchorClientX !== undefined
          ? anchorClientX - el.getBoundingClientRect().left
          : el.clientWidth / 2;
      pendingAnchor.current = { t: (el.scrollLeft + px) / pps, px };
    }
    setZoom(next);
  };
  const applyZoomRef = useRef(applyZoom);
  applyZoomRef.current = applyZoom;

  /** ズームを絶対値へ(スライダー用)。ビュー中央を基準に拡縮する */
  const setZoomTo = (next: number) => {
    next = Math.min(maxZoom, Math.max(1, next));
    if (next === zoom) return;
    const el = scrollRef.current;
    if (el && next > 1) {
      const px = el.clientWidth / 2;
      pendingAnchor.current = { t: (el.scrollLeft + px) / pps, px };
    }
    setZoom(next);
  };

  // 描画前に合わせる(useEffect だと補正前のスクロール位置で一瞬描画される)
  useLayoutEffect(() => {
    const a = pendingAnchor.current;
    if (!a) return;
    pendingAnchor.current = null;
    if (scrollRef.current) scrollRef.current.scrollLeft = a.t * fitPps * zoom - a.px;
  }, [zoom, fitPps]);

  // ⌘/Ctrl+スクロール(Mac のピンチ含む)でカーソル位置を基準にズーム。
  // preventDefault が必要なので React ではなく passive: false で直接張る
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      applyZoomRef.current(Math.exp(-e.deltaY * 0.01), e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const posToT = (clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    return Math.min(Math.max(x / pps, 0), duration);
  };

  /** ルーラーの高さ(px)。CSS の .tlRuler / .tlRulerSpacer と一致させる */
  const RULER_H = 22;
  /** ルーラー(時間軸)帯 = 新規トラック作成の的の高さ(px)。+6 は
   * 「時間軸らへん」に落とせるための遊び(先頭トラック行の上端からもらう) */
  const NEW_TRACK_ZONE_H = RULER_H + 6;
  /** ポインタがルーラー帯の中か。.tlRuler は position: sticky で常に
   * .tlScroll の上端に貼り付くので、判定はコンテンツ座標(trackIndexAt /
   * trackAt)ではなくビューポート座標(scrollTop を足さない)で行う */
  const inNewTrackZone = (clientY: number): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    const y = clientY - el.getBoundingClientRect().top;
    return y >= 0 && y < NEW_TRACK_ZONE_H;
  };

  /** コンテンツ座標の縦位置 → トラック添字(高さと gap は可変なので累積で探す) */
  const trackIndexOfY = (y: number): number => {
    let acc = 0;
    for (let i = 0; i < tracks.length; i++) {
      const h = rowH(tracks[i].id);
      if (y < acc + h + TRACK_GAP) return i;
      acc += h + TRACK_GAP;
    }
    return tracks.length - 1;
  };
  /** ポインタ位置 → トラック行側(tlScroll)のトラック添字 */
  const trackIndexAt = (clientY: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    return trackIndexOfY(clientY - el.getBoundingClientRect().top + el.scrollTop - RULER_H);
  };
  /** ポインタ直下のトラック行。ドロップ可否の厳密判定用なので上下へ丸めない */
  const trackAt = (clientY: number): TrackDef | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop - RULER_H;
    if (y < 0) return null;
    let acc = 0;
    for (const t of tracks) {
      const h = rowH(t.id);
      if (y >= acc && y < acc + h) return t;
      acc += h + TRACK_GAP;
    }
    return null;
  };
  /** ポインタ位置 → ラベル列(tlLabelScroll)のトラック添字 */
  const labelIndexAt = (clientY: number): number => {
    const el = labelsRef.current;
    if (!el) return 0;
    return trackIndexOfY(clientY - el.getBoundingClientRect().top + el.scrollTop);
  };

  /** window にリスナーを張るドラッグの共通処理。コンテキストメニュー等で
   * pointerup が届かないことがあるので pointercancel でも必ず後始末する。
   * pointermove はディスプレイ更新より速く届く(トラックパッドで 90〜120Hz)
   * ので rAF で1フレーム1回に間引く(move は絶対座標から計算する前提。
   * ドラッグ中のドキュメント更新・再レンダーが画面の更新回数を超えない) */
  const beginDrag = (
    e: ReactPointerEvent,
    move: (ev: PointerEvent) => void,
    up?: () => void,
  ) => {
    e.preventDefault();
    let raf = 0;
    let last: PointerEvent | null = null;
    const onMove = (ev: PointerEvent) => {
      last = ev;
      if (raf === 0) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (last) move(last);
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf !== 0) cancelAnimationFrame(raf);
      if (last) move(last); // 間引きで未適用の最後の移動を確定してから終了
      up?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onRulerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return; // 右クリックでスクラブが固着しないように
    let lastT = posToT(e.clientX);
    onScrubMove?.(lastT);
    onSeek(lastT);
    beginDrag(
      e,
      (ev) => {
        lastT = posToT(ev.clientX);
        onScrubMove?.(lastT);
        onSeek(lastT);
      },
      () => onScrubEnd?.(lastT),
    );
  };

  const onClipDown = (e: ReactPointerEvent, clip: Clip, mode: DragMode) => {
    e.stopPropagation();
    if (e.button !== 0) return; // 主ボタン以外はドラッグを始めない
    if (!clip.editable) return;
    // テロップの⌘クリックは複数選択への追加/解除(ドラッグは始めない)
    if (clip.kind === "caption" && (e.metaKey || e.ctrlKey)) {
      onToggleCaptionSel(clip.index);
      return;
    }
    onSelect({ kind: clip.kind, index: clip.index });
    onDragStart({ kind: clip.kind, index: clip.index }, mode, clip);
    const x0 = e.clientX;
    const y0 = e.clientY;
    // デッドゾーン: 数px 動くまではドラッグ扱いにしない(選択クリック時の
    // トラックパッドの震えで区間が 0.01 秒ずれて未保存になるのを防ぐ)
    let started = false;
    beginDrag(
      e,
      (ev) => {
        if (
          !started &&
          Math.abs(ev.clientX - x0) < 4 &&
          Math.abs(ev.clientY - y0) < 6
        ) {
          return;
        }
        started = true;
        const raw = (ev.clientX - x0) / pps;
        // 吸着(マグネット): トグル(snapOn)が既定で、ドラッグ中に ⌘/Ctrl を
        // 押すと一時反転する(OFF のとき押しながらで境界へ吸着 / ON のとき
        // 押しながらで自由移動)。境界=他クリップの端・再生ヘッド・0/末尾
        const doSnap = snapOn !== (ev.metaKey || ev.ctrlKey);
        const { delta, line } = doSnap
          ? snapClipDelta(clip, mode, raw)
          : { delta: raw, line: null };
        setSnapMark(line);
        // 縦方向はポインタ下のトラックへの移動として通知
        // (素材の V1/V2 = z-index の入れ替え)
        onDragMove(delta, tracks[trackIndexAt(ev.clientY)].id);
      },
      () => {
        setSnapMark(null);
        onDragEnd();
      },
    );
  };

  /** トラックのラベルを上下にドラッグして重なり順を並べ替える */
  const onLabelDown = (e: ReactPointerEvent, idx: number) => {
    if (e.button !== 0) return;
    const t = tracks[idx];
    if (!t || !t.reorderable) return;   // F3: idx が -1 でも落ちないように
    let cur = idx;
    setDragLabel(t.id);
    beginDrag(
      e,
      (ev) => {
        const target = labelIndexAt(ev.clientY);
        if (target !== cur) {
          onReorderTrack(t.id, target);
          cur = target;
        }
      },
      () => setDragLabel(null),
    );
  };

  /** ラベル下端のドラッグでトラックの高さを変更(ダブルクリックで既定に戻す) */
  const onResizeDown = (e: ReactPointerEvent, id: TrackId) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 並べ替えドラッグを始めない
    const y0 = e.clientY;
    const h0 = rowH(id);
    const base = trackHeightFor(id);
    beginDrag(e, (ev) => {
      const h = Math.min(ROW_H_MAX, Math.max(base, h0 + (ev.clientY - y0)));
      setTrackHeights((m) => (m[id] === h ? m : { ...m, [id]: h }));
    });
  };

  const onTrackDown = (e: ReactPointerEvent, track: TrackDef) => {
    if (e.button !== 0) return;
    if (!track.createKind) {
      onSelect(null);
      return;
    }
    // 空き領域のドラッグで新しい区間を作る
    const t0 = posToT(e.clientX);
    const set = (g: typeof ghost) => {
      ghostRef.current = g;
      setGhost(g);
    };
    set({ track: track.id, a: t0, b: t0 });
    beginDrag(
      e,
      (ev) => set(ghostRef.current && { ...ghostRef.current, b: posToT(ev.clientX) }),
      () => {
        const g = ghostRef.current;
        set(null);
        if (!g) return;
        const [s, en] = [Math.min(g.a, g.b), Math.max(g.a, g.b)];
        if ((en - s) * pps > 4) onCreate(g.track, s, en);
        else onSelect(null); // ただのクリックは選択解除
      },
    );
  };

  // ルーラーの目盛り間隔: ラベル付き主目盛りが 70px 以上になる切りのいい秒数。
  // 補助目盛り(ラベル無し)は主目盛りをさらに分割し、詰まりすぎない間隔に収める
  const step = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 70) ?? 120;
  const minorDivisor = [10, 5, 4, 2, 1].find((n) => (step / n) * pps >= 10) ?? 1;
  const minorStep = step / minorDivisor;
  // 可視窓の中だけ置く(長尺+高ズームでは全体で数万本になる)
  const ticks: { t: number; major: boolean }[] = [];
  const tickEnd = Math.min(duration, winEnd);
  for (let k = Math.max(0, Math.floor(winStart / minorStep)); k * minorStep <= tickEnd; k++) {
    ticks.push({ t: k * minorStep, major: k % minorDivisor === 0 });
  }

  const isSel = (c: Clip) =>
    (selection !== null && selection.kind === c.kind && selection.index === c.index) ||
    (c.kind === "caption" && multiCaption.includes(c.index));

  /* ---- 水平仮想化: トラック別の区間索引 ----
   * クリップを outStart 順に並べ、前方からの outEnd の最大値(maxEnd)を
   * 添える。可視窓 [winStart, winEnd) に重なるクリップは
   *   lo = maxEnd > winStart となる最初(それ以前は全て窓より左で終わる)
   *   hi = outStart >= winEnd となる最初(それ以降は全て窓より右で始まる)
   * の二分探索2回 O(log n + k) で取り出せる(区間 stabbing の定石)。
   * key はトラック内の同一クリップ(kind+index)の断片通し番号。窓が動いても
   * 同じ断片に同じ key が付くので、スクロールで DOM が作り直されない */
  const byTrack = useMemo(() => {
    const grouped = new Map<TrackId, Clip[]>();
    for (const c of clips) {
      const arr = grouped.get(c.track);
      if (arr) arr.push(c);
      else grouped.set(c.track, [c]);
    }
    const index = new Map<
      TrackId,
      { list: Clip[]; keys: string[]; maxEnd: number[] }
    >();
    for (const [id, list] of grouped) {
      // sort は安定なので、同時刻に始まるクリップの重なり順(clips の
      // 並び = 描画順)は保たれる
      list.sort((a, b) => a.outStart - b.outStart);
      const occ = new Map<string, number>();
      const keys: string[] = [];
      const maxEnd: number[] = [];
      let mx = -Infinity;
      for (const c of list) {
        const base = `${c.kind}-${c.index}`;
        const n = occ.get(base) ?? 0;
        occ.set(base, n + 1);
        keys.push(`${base}-${n}`);
        if (c.outEnd > mx) mx = c.outEnd;
        maxEnd.push(mx);
      }
      index.set(id, { list, keys, maxEnd });
    }
    return index;
  }, [clips]);

  /** 可視窓に重なるトラック内クリップの添字範囲 [from, to)。
   * from〜to には maxEnd の性質上「窓より左で終わる」ものが混ざりうるので、
   * 呼び出し側で outEnd > winStart だけ確認する */
  const visibleRange = (g: { list: Clip[]; maxEnd: number[] }): [number, number] => {
    const n = g.list.length;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (g.maxEnd[mid] > winStart) hi = mid;
      else lo = mid + 1;
    }
    const from = lo;
    hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (g.list[mid].outStart >= winEnd) hi = mid;
      else lo = mid + 1;
    }
    return [from, lo];
  };

  const ovTrackCount = tracks.filter((t) => ovNum(t.id) !== null).length;
  const capTrackCount = tracks.filter((t) => capNum(t.id) !== null).length;
  /** 空の素材/テロップトラック(その種類が2本以上あるとき)はラベルの × で削除できる */
  const isRemovable = (t: TrackDef) => {
    const count =
      ovNum(t.id) !== null ? ovTrackCount : capNum(t.id) !== null ? capTrackCount : 0;
    return count > 1 && !clips.some((c) => c.track === t.id);
  };

  /* ---- 素材パネル・OS ファイルのドロップ(Premiere 風) ----
   * トラック行に正確に乗せなくても、タイムライン上ならどこでも最寄りの
   * 置けるトラック(素材 V* / 映像)にクリップ形のゴーストを出し、
   * ドロップはゴーストの位置(スナップ済み)に落とす。 */

  /** ドロップ先のゴースト。t = 左端(カット後秒)、snapLine = 吸着した境界 */
  const [drop, setDrop] = useState<{
    track: TrackId;
    t: number;
    snapLine: number | null;
    /** true = ルーラー帯へのホバー。track は「落としたら作られるトラック」の
     * 表示用 id で、既存の行ハイライトには一切使わない */
    newTrack?: boolean;
  } | null>(null);
  /** ドラッグ中のファイルが音声のみか。true = BGM トラックだけがドロップ先、
   *  false = 素材・映像トラックだけ(BGM 不可)、null = 種別不明で従来どおり。
   *  置けないトラックにホバーの反応を出さないため、種別に合わせて絞り込む */
  const [dropAudio, setDropAudio] = useState<boolean | null>(null);

  // ドラッグがキャンセルされた・パネル側で終わったときの消し忘れ防止
  useEffect(() => {
    if (!dragMaterial && !presetDragTrack) {
      setDrop(null);
      setDropAudio(null);
    }
  }, [dragMaterial, presetDragTrack]);

  /** ゴーストの幅に使う尺(秒)。画像・不明は配置時の既定と同じ */
  const dragDurSec = dragMaterial?.durationSec ?? defaultDurationSec;
  const dragName = dragMaterial
    ? dragMaterial.file.replace(/^materials\//, "")
    : "ファイル";
  /** ルーラー帯へ落としたときに作られるトラック。プリセットはその常在
   * トラック、音声のみは BGM、それ以外は新しい素材トラック */
  const newTrackId = (audio: boolean | null): TrackId =>
    presetDragTrack ?? (audio === true ? "bgm" : newOverlayTrackId);

  /** ドラッグ中のファイルが音声のみか。素材パネルは file 名で、OS ファイルは
   *  dragover 中でも読める MIME 種別(item.type)で判定する。拡張子だけで
   *  MIME 不明などで判定できないときは null(従来どおり全トラック許可) */
  const dragIsAudioOnly = (e: ReactDragEvent): boolean | null => {
    if (dragMaterial) return AUDIO_EXT_RE.test(dragMaterial.file);
    const items = e.dataTransfer.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "file") continue;
      if (it.type.startsWith("audio/")) return true;
      if (it.type.startsWith("image/") || it.type.startsWith("video/")) return false;
    }
    return null;
  };

  /** そのトラックが今ドラッグ中のファイルのドロップ先になれるか。
   *  音声のみ = BGM だけ、画像・動画 = 素材/映像だけ(BGM 不可)、種別不明 =
   *  従来どおり素材/映像/BGM すべて。置けないトラックにはホバーの反応
   *  (ドロップゴースト・ハイライト)を出さない */
  const isDropTrack = (t: TrackDef, audio: boolean | null): boolean => {
    if (audio === true) return t.id === "bgm";
    if (audio === false) return ovNum(t.id) !== null || t.id === "cut";
    return ovNum(t.id) !== null || t.id === "cut" || t.id === "bgm";
  };
  /** ポインタに一番近い置けるトラック(行の添字距離で上下に探す)。
   *  音声素材だけは、BGM 行へ直接ドラッグしたとき以外は反応させない */
  const dropTrackAt = (clientY: number, audio: boolean | null): TrackDef | null => {
    if (audio === true) {
      const t = trackAt(clientY);
      return t?.id === "bgm" ? t : null;
    }
    const idx = trackIndexAt(clientY);
    for (let d = 0; d < tracks.length; d++) {
      for (const i of [idx - d, idx + d]) {
        const t = tracks[i];
        if (t && isDropTrack(t, audio)) return t;
      }
    }
    return null;
  };

  /** ゴーストの左右端をクリップ境界・再生ヘッド・0/末尾に吸着する。
   * snapOn が false のときは素通し(細かい位置を狙うとき用のトグル) */
  const SNAP_PX = 8;
  const snapDropT = (t: number): { t: number; snapLine: number | null } => {
    if (!snapOn) return { t, snapLine: null };
    const cands = [0, playhead.get(), duration];
    for (const c of clips) cands.push(c.outStart, c.outEnd);
    let best: { t: number; line: number; px: number } | null = null;
    for (const c of cands) {
      // [左端を c に合わせる, 右端を c に合わせる] の2通りを試す
      for (const start of [c, c - dragDurSec]) {
        if (start < 0) continue;
        const px = Math.abs(start - t) * pps;
        if (px < SNAP_PX && (!best || px < best.px)) best = { t: start, line: c, px };
      }
    }
    return best ? { t: best.t, snapLine: best.line } : { t, snapLine: null };
  };

  /** クリップの移動・左右トリム中に、動いている端を他クリップの境界・再生
   *  ヘッド・0/末尾へ吸着する。掴んだクリップ(カットで割れた同一クリップの
   *  断片も)自身の端は候補から外す。返り値は調整後のデルタ(カット後秒)と
   *  吸着した境界の位置(表示線用。なければ null)。 */
  const snapClipDelta = (
    clip: Clip,
    mode: DragMode,
    rawDelta: number,
  ): { delta: number; line: number | null } => {
    const cands = [0, duration, playhead.get()];
    for (const c of clips) {
      if (c.kind === clip.kind && c.index === clip.index) continue; // 自分自身
      cands.push(c.outStart, c.outEnd);
    }
    // 動く端: 移動は両端、トリムは掴んだ側の1端だけを候補に合わせる
    const edges =
      mode === "move"
        ? [clip.outStart + rawDelta, clip.outEnd + rawDelta]
        : mode === "trim-start"
          ? [clip.outStart + rawDelta]
          : [clip.outEnd + rawDelta];
    let best: { adjust: number; line: number; px: number } | null = null;
    for (const edge of edges) {
      for (const cand of cands) {
        const px = Math.abs(edge - cand) * pps;
        if (px < SNAP_PX && (!best || px < best.px)) {
          best = { adjust: cand - edge, line: cand, px };
        }
      }
    }
    return best
      ? { delta: rawDelta + best.adjust, line: best.line }
      : { delta: rawDelta, line: null };
  };

  /** ドラッグ中に端へ近づいたら自動スクロール(dragover はホバー中も届く) */
  const dragAutoScroll = (x: number, y: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const EDGE = 36;
    const STEP = 14;
    if (x < r.left + EDGE) el.scrollLeft -= STEP;
    else if (x > r.right - EDGE) el.scrollLeft += STEP;
    if (y < r.top + RULER_H + EDGE) el.scrollTop -= STEP;
    else if (y > r.bottom - EDGE) el.scrollTop += STEP;
  };

  const onDragOverTimeline = (e: ReactDragEvent) => {
    const types = e.dataTransfer.types;
    const isPreset = types.includes(PRESET_MIME);
    if (!types.includes("Files") && !types.includes(MATERIAL_MIME) && !isPreset) return;
    e.preventDefault();
    dragAutoScroll(e.clientX, e.clientY);
    // ルーラー(時間軸)帯 = 新規トラック作成の的。行を狙わなくてよい
    if (inNewTrackZone(e.clientY)) {
      const audio = isPreset ? null : dragIsAudioOnly(e);
      setDropAudio((cur) => (cur === audio ? cur : audio));
      // プリセットは行が確定していないと落とせない(従来と同じ扱い)
      if (isPreset && !presetDragTrack) {
        e.dataTransfer.dropEffect = "none";
        setDrop(null);
        return;
      }
      e.dataTransfer.dropEffect = "copy";
      const { t, snapLine } = snapDropT(posToT(e.clientX));
      const track = newTrackId(audio);
      setDrop((cur) =>
        cur && cur.newTrack && cur.track === track && cur.t === t && cur.snapLine === snapLine
          ? cur
          : { track, t, snapLine, newTrack: true },
      );
      return;
    }
    // プリセットは音声/映像ヒューリスティック(dropTrackAt)を使わず、
    // ドラッグ開始時に App が確定させた presetDragTrack をそのまま行として使う
    // (getData は drop イベントでしか読めないので dragover では判定できない)
    if (isPreset) {
      setDropAudio((cur) => (cur === null ? cur : null));
      if (!presetDragTrack) {
        e.dataTransfer.dropEffect = "none";
        setDrop(null);
        return;
      }
      e.dataTransfer.dropEffect = "copy";
      const { t, snapLine } = snapDropT(posToT(e.clientX));
      setDrop((cur) =>
        cur && cur.track === presetDragTrack && cur.t === t && cur.snapLine === snapLine
          ? cur
          : { track: presetDragTrack, t, snapLine },
      );
      return;
    }
    const audio = dragIsAudioOnly(e);
    setDropAudio((cur) => (cur === audio ? cur : audio));
    const track = dropTrackAt(e.clientY, audio);
    if (!track) {
      e.dataTransfer.dropEffect = "none";
      setDrop(null);
      return;
    }
    e.dataTransfer.dropEffect = "copy";
    const { t, snapLine } = snapDropT(posToT(e.clientX));
    setDrop((cur) =>
      cur && cur.track === track.id && cur.t === t && cur.snapLine === snapLine
        ? cur
        : { track: track.id, t, snapLine },
    );
  };
  const onDragLeaveTimeline = (e: ReactDragEvent) => {
    // 子要素間の移動では消さない(relatedTarget = null はウィンドウ外)
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDrop(null);
      setDropAudio(null);
    }
  };
  const onDropTimeline = (e: ReactDragEvent) => {
    e.preventDefault();
    // プリセットは MATERIAL_MIME の判定より前に見る(§8.2 手順5)
    const presetId = e.dataTransfer.getData(PRESET_MIME);
    if (presetId) {
      const t = drop?.t ?? posToT(e.clientX);
      const toNewTrack = drop?.newTrack === true || inNewTrackZone(e.clientY);
      setDrop(null);
      setDropAudio(null);
      if (toNewTrack) onDropPresetNewTrack(t, presetId);
      else onDropPreset(t, presetId);
      return;
    }
    // ゴーストの位置に落とす(dragover を経ていない場合はその場で計算)。
    // 新規トラック判定は drop state だけに頼らず**ドロップ時の座標でも**見る
    // (dragover を1度も経ていない/state が消えていても取りこぼさない)
    const newTrack = drop?.newTrack === true || inNewTrackZone(e.clientY);
    const track = drop?.track ?? dropTrackAt(e.clientY, dragIsAudioOnly(e))?.id;
    const t = drop?.t ?? posToT(e.clientX);
    setDrop(null);
    setDropAudio(null);
    const path = e.dataTransfer.getData(MATERIAL_MIME);
    // ルーラー帯 = 新規トラック。どのトラックを作るかは App が決めるので
    // 行 id は渡さない
    if (newTrack) {
      if (path) onDropMaterialNewTrack(t, path);
      else {
        const nf = e.dataTransfer.files?.[0];
        if (nf) onDropFileNewTrack(t, nf);
      }
      return;
    }
    if (track === undefined) return;
    if (path) {
      onDropMaterial(track, t, path);
      return;
    }
    const f = e.dataTransfer.files?.[0];
    if (f) onDropFile(track, t, f);
  };

  return (
    <div className="timeline ocTimeline" style={{ height }}>
      <div className="tlToolbar">
        <button
          className="tlTool"
          aria-label="元に戻す"
          title="元に戻す (⌘Z)"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <UndoIcon dir="undo" size={14} />
        </button>
        <button
          className="tlTool"
          aria-label="やり直す"
          title="やり直す (⇧⌘Z)"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <UndoIcon dir="redo" size={14} />
        </button>
        <SplitButton getDisabled={getSplitDisabled} onSplit={onSplit} />
        <button
          className="tlTool"
          aria-label="複製"
          title="選択中のクリップを直後へ複製 (⌘D)"
          disabled={dupDisabled}
          onClick={onDuplicate}
        >
          <DuplicateIcon size={14} />
        </button>
        <button
          className="tlTool"
          aria-label="削除"
          title="選択中のクリップを削除 (Delete)。映像クリップは削除ではなくカット記録へ倒す(継ぎ目の印から戻せる)"
          disabled={deleteDisabled}
          onClick={onDelete}
        >
          <TrashIcon size={14} />
        </button>
        <span className="spacer" />
        <button
          className={`tlSnap${snapOn ? " active" : ""}`}
          aria-label={snapOn ? "吸着 ON" : "吸着 OFF"}
          aria-pressed={snapOn}
          title="吸着(ドロップ・クリップの移動・左右トリムで、クリップ境界・再生ヘッド・0/末尾に吸い付く)。ドラッグ中に ⌘/Ctrl を押すと一時反転(OFF でも吸着 / ON でも自由移動)。細かい位置を狙うときは OFF に"
          onClick={() => setSnapOn((v) => !v)}
        >
          <MagnetIcon size={15} />
        </button>
        <span className="tlDivider" />
        <span className="tlZoom">
          <button
            className="zoomBtn"
            aria-label="縮小"
            title="縮小(⌘+スクロールでも可)"
            disabled={zoom <= 1}
            onClick={() => applyZoom(1 / 1.5)}
          >
            <svg viewBox="0 0 12 12" aria-hidden>
              <line x1="3" y1="6" x2="9" y2="6" />
            </svg>
          </button>
          <input
            type="range"
            className="zoomSlider"
            min={0}
            // 上限は log2(maxZoom)。長尺では 6(=64倍)を超えて伸びる
            max={Math.log2(maxZoom)}
            step={0.02}
            value={Math.log2(zoom)}
            title={`ズーム ${Math.round(zoom * 100)}%(ダブルクリックで全体表示)`}
            style={{
              // 左端から現在のズーム位置までをアクセント色で塗る(音量スライダーと同じ流儀)
              background: `linear-gradient(to right, hsl(var(--oc-primary)) ${(Math.log2(zoom) / Math.log2(maxZoom)) * 100}%, hsl(var(--oc-border)) ${(Math.log2(zoom) / Math.log2(maxZoom)) * 100}%)`,
            }}
            onChange={(e) => setZoomTo(2 ** Number(e.target.value))}
            onDoubleClick={() => applyZoom(0)}
          />
          <button
            className="zoomBtn"
            aria-label="拡大"
            title="拡大(⌘+スクロールでも可)"
            disabled={zoom >= maxZoom}
            onClick={() => applyZoom(1.5)}
          >
            <svg viewBox="0 0 12 12" aria-hidden>
              <line x1="6" y1="3" x2="6" y2="9" />
              <line x1="3" y1="6" x2="9" y2="6" />
            </svg>
          </button>
        </span>
      </div>
      <div className="tlBody">
        <div className="tlLabels">
          <div className="tlRulerSpacer" />
          <div
            className="tlLabelScroll"
            ref={labelsRef}
            // ラベル列上のホイールでもトラック側を縦スクロール(scroll イベント経由で同期が戻る)
            onWheel={(e) => {
              if (scrollRef.current) scrollRef.current.scrollTop += e.deltaY;
            }}
          >
            {allTracks.map((item, i) => {
              if ("sourceTrack" in item) {
                const diffDef = item as unknown as DiffTrackDef;
                return (
                  <div
                    key={diffDef.track.id}
                    className="tlLabelDiff setTop"
                    style={{ height: DIFF_ROW_H }}
                    title={diffDef.track.hint}
                  >
                    <span className="tlDiffBadge">{diffDef.eventCount}</span>
                    <span className="tlDiffLabelText">AI提案</span>
                  </div>
                );
              }
              const t = item as TrackDef;
              const audio = t.audio;
              const layerHidden = t.layer !== undefined && hiddenLayers.includes(t.layer);
              const trackSelected =
                (t.renamableCaption !== undefined &&
                  selection?.kind === "captionTrack" &&
                  selection.index === t.renamableCaption) ||
                (t.id === "wipe" && selection?.kind === "wipe");
              return (
                <div
                  className={`tlLabel${t.reorderable ? " reorderable" : ""}${dragLabel === t.id ? " dragging" : ""}${drop && !drop.newTrack && drop.track === t.id ? " dropActive" : ""}${trackSelected ? " sel" : ""}${pairedTrackIds.has(t.id) ? " setBottom" : ""}`}
                  key={t.id}
                  style={{ height: rowH(t.id) }}
                  title={t.hint}
                  onPointerDown={(e) => {
                    // テロップトラックのラベルはクリックで選択(インスペクタが
                    // そのトラックの標準デザインに切り替わる)。並べ替えドラッグは
                    // そのまま継続できるよう onLabelDown も従来どおり呼ぶ
                    if (e.button === 0 && t.renamableCaption !== undefined) {
                      onSelectCaptionTrack(t.renamableCaption);
                    } else if (e.button === 0 && t.id === "wipe") {
                      onSelectTrackHeader?.(t.id);
                    }
                    // F3: i は diff レーンを含む allTracks の添字。
                    // onLabelDown は tracks[idx] を引くので id で引き直す
                    onLabelDown(e, tracks.findIndex((x) => x.id === t.id));
                  }}
                  onDoubleClick={() =>
                    t.renamableCaption !== undefined &&
                    setRenaming({ id: t.id, value: t.label })
                  }
                >
                  {renaming?.id === t.id && t.renamableCaption !== undefined ? (
                    <input
                      className="tlRename"
                      autoFocus
                      value={renaming.value}
                      placeholder="トラック名(空で自動)"
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ id: t.id, value: e.target.value })}
                      onBlur={() => {
                        onRenameTrack(t.renamableCaption as number, renaming.value);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    t.label
                  )}
                  {t.layer !== undefined && (
                    <button
                      className={`trackEye${layerHidden ? " off" : ""}`}
                      title={
                        layerHidden
                          ? "非表示中(クリックで再表示。プレビューのみ)"
                          : "このトラックを一時非表示(プレビューのみ。書き出しには影響しない)"
                      }
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onToggleTrackHide(t.layer as LayerId)}
                    >
                      <EyeIcon open={!layerHidden} size={13} />
                    </button>
                  )}
                  {audio && (
                    <button
                      className={`trackMute${trackMuted[audio] ? " muted" : ""}`}
                      title={
                        trackMuted[audio]
                          ? "ミュート中(クリックで解除。プレビューのみ)"
                          : "このトラックをミュート(プレビューのみ。書き出しには影響しない)"
                      }
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onToggleTrackMute(audio)}
                    >
                      <VolumeIcon level={trackMuted[audio] ? "mute" : "high"} size={13} />
                    </button>
                  )}
                  {isRemovable(t) && (
                    <button
                      className="trackDel"
                      title="このトラックを削除(空のときだけ表示)"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onRemoveTrack(t.id)}
                    >
                      ×
                    </button>
                  )}
                  {t.reorderable && <span className="grip">⠿</span>}
                  <div
                    className="tlResize"
                    title="ドラッグでトラックの高さを変更(ダブルクリックで既定に戻す)"
                    onPointerDown={(e) => onResizeDown(e, t.id)}
                    onDoubleClick={() =>
                      setTrackHeights((m) => {
                        const { [t.id]: _drop, ...rest } = m;
                        return rest;
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div
          className="tlScroll"
          ref={scrollRef}
          onScroll={(e) => {
            if (labelsRef.current) labelsRef.current.scrollTop = e.currentTarget.scrollTop;
            // 仮想化の窓はチャンク境界を跨いだときだけ動かす
            const c = Math.floor(e.currentTarget.scrollLeft / VIRT_CHUNK);
            setScrollChunk((prev) => (prev === c ? prev : c));
          }}
          onDragOver={onDragOverTimeline}
          onDragLeave={onDragLeaveTimeline}
          onDrop={onDropTimeline}
        >
          <div className="tlContent" style={{ width: totalW }}>
            <div
              className={`tlRuler${drop?.newTrack ? " dropNewTrack" : ""}`}
              onPointerDown={onRulerDown}
            >
              {ticks.map(({ t, major }) => (
                <div
                  className={`tlTick${major ? "" : " tlTickMinor"}`}
                  key={t}
                  style={{ left: t * pps }}
                >
                  {major && <span className="tlTickLabel">{fmtTime(t)}</span>}
                </div>
              ))}
              <PlayheadMark className="tlPlayheadCap" pps={pps} />
            </div>
            {allTracks.map((item) => {
              if ("sourceTrack" in item) {
                const diffDef = item as unknown as DiffTrackDef;
                return (
                  <div key={diffDef.track.id} className="tlRow diffTrack setTop" style={{ height: DIFF_ROW_H }}>
                    {diffDef.clips.map(({ event, outStart, outEnd, inCut }) => {
                      // F2: outStart/outEnd はカット後秒。既存クリップと同じ
                      // 絶対配置(winLeftPx を引かない)にする
                      const left = outStart * pps;
                      const width = inCut
                        ? DIFF_CUT_MARK_W
                        : Math.max(12, (outEnd - outStart) * pps);

                      if (outEnd < winStart || outStart > winEnd) return null;

                      const kindClass =
                        event.kind === "cut" ? "change" :
                        event.hunkLabels.some((l) => l.includes("add")) ? "add" :
                        event.hunkLabels.some((l) => l.includes("remove")) ? "remove" :
                        "change";

                      const status = reviewEventStatus({
                        event,
                        hunks: aiWorkflowHunks ?? [],
                        resolution: aiResolution ?? new Map(),
                      });
                      const statusClass =
                        status === "use" ? "accepted" :
                        status === "skip" ? "rejected" :
                        "pending";

                      return (
                        <div
                          key={event.id}
                          className={`tlDiffClip ${kindClass} ${statusClass}${inCut ? " inCut" : ""}`}
                          style={{
                            position: "absolute",
                            left,
                            width,
                            top: 4,
                            height: DIFF_ROW_H - 8,
                          }}
                          title={
                            inCut
                              ? `${event.title}\n${event.subtitle}\n(現在カットされている区間の提案)`
                              : `${event.title}\n${event.subtitle}`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            onDiffInspect?.();
                            setPopoverEvent({ event, x: e.clientX, y: e.clientY });
                          }}
                          onPointerEnter={(e) => {
                            const still = diffStills?.find((s) => s.eventId === event.id);
                            if (!still) return;
                            setHoverThumb({ eventId: event.id, x: e.clientX, y: e.clientY, still });
                          }}
                          onPointerLeave={() => setHoverThumb(null)}
                        >
                          <span className="tlDiffClipLabel">{event.title}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              }
              const track = item as TrackDef;
              return (
                <div
                  className={`tlTrack${track.id === "wipe" ? " wipeTrack" : ""}${
                    track.layer !== undefined && hiddenLayers.includes(track.layer)
                      ? " layerHidden"
                      : ""
                  }${
                    drop === null || drop.newTrack
                      ? ""
                      : drop.track === track.id
                        ? " dropActive"
                        : isDropTrack(track, dropAudio)
                          ? " dropOk"
                          : ""
                  }${
                    presetDragTrack === track.id && !byTrack.get(track.id) ? " ocTrackDropLane" : ""
                  }${pairedTrackIds.has(track.id) ? " setBottom" : ""}`}
                  key={track.id}
                  style={{ height: rowH(track.id) }}
                  onPointerDown={(e) => onTrackDown(e, track)}
                  title={track.hint}
                >
                  {(() => {
                    // 可視窓に重なるクリップだけを DOM に置く(水平仮想化)
                    const g = byTrack.get(track.id);
                    if (!g) return null;
                    const [from, to] = visibleRange(g);
                    const nodes = [];
                    for (let i = from; i < to; i++) {
                      const clip = g.list[i];
                      if (clip.outEnd <= winStart) continue; // 窓より左で終わる
                      nodes.push(
                        <div
                          key={g.keys[i]}
                          className={`tlClip ${clip.kind}${clip.mediaKind ? ` ${clip.mediaKind}` : ""}${isSel(clip) ? " sel" : ""}${clip.static ? " static" : ""}${
                            aiClipMarks?.get(`${clip.kind}:${clip.index}`)
                              ? ` aiMark ${aiClipMarks.get(`${clip.kind}:${clip.index}`)}`
                              : ""
                          }`}
                          style={{
                            left: clip.outStart * pps,
                            width: Math.max(6, (clip.outEnd - clip.outStart) * pps),
                          }}
                          title={clip.label}
                          onPointerDown={(e) => onClipDown(e, clip, "move")}
                        >
                          {clip.film && thumbstrip && (
                            <Filmstrip
                              level={thumbstrip}
                              srcStart={clip.film.srcStart}
                              speed={clip.film.speed}
                              pps={pps}
                              clipOutStart={clip.outStart}
                              clipW={Math.max(6, (clip.outEnd - clip.outStart) * pps)}
                              pxHeight={rowH(track.id) - 6}
                              winStart={winStart}
                              winEnd={winEnd}
                            />
                          )}
                          {clip.wave && peaks[clip.wave.src] && (
                            <Waveform
                              peaks={peaks[clip.wave.src] as Peaks}
                              srcStart={clip.wave.startSec}
                              durSec={clip.outEnd - clip.outStart}
                              pxWidth={Math.max(6, (clip.outEnd - clip.outStart) * pps)}
                              pxHeight={rowH(track.id) - 6}
                              loop={clip.wave.loop}
                            />
                          )}
                          {clip.editable && !clip.noTrimStart && (
                            <div
                              className="tlEdge l"
                              onPointerDown={(e) => onClipDown(e, clip, "trim-start")}
                            />
                          )}
                          {clip.kind === "insert" && clip.mediaKind && (
                            <span className="tlInsertKind" aria-hidden="true">
                              {clip.mediaKind === "image" ? "静" : "▶"}
                            </span>
                          )}
                          <span className="tlClipLabel">{clip.label}</span>
                          {clip.editable && !clip.noTrimEnd && (
                            <div
                              className="tlEdge r"
                              onPointerDown={(e) => onClipDown(e, clip, "trim-end")}
                            />
                          )}
                        </div>,
                      );
                    }
                    return nodes;
                  })()}
                  {/* 継ぎ目の「カットされた区間」の印。クリップと違い幅を持たない
                      (横軸はカット後の秒で、切られた時間はこの軸上に存在しない) */}
                  {track.id === "cut" &&
                    cutMarks
                      // 印も可視窓の中だけ(stack の横ずらしぶんだけ左へ余裕を持つ)
                      .filter((m) => m.out >= winStart - 24 / pps && m.out <= winEnd)
                      .map((m) => (
                      <div
                        key={`cutmark-${m.index}`}
                        className={`tlCutMark${
                          selection?.kind === "cut" && selection.index === m.index
                            ? " sel"
                            : ""
                        }`}
                        style={{ left: m.out * pps + m.stack * 10 }}
                        title={
                          `カットされた区間 ${m.durSec.toFixed(1)}秒` +
                          `${m.reason ? `: ${m.reason}` : ""}` +
                          "(クリックで選択 → プロパティから戻せる)"
                        }
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          if (e.button !== 0) return;
                          onSelect({ kind: "cut", index: m.index });
                        }}
                      />
                    ))}
                  {ghost && ghost.track === track.id && (
                    <div
                      className="tlGhost"
                      style={{
                        left: Math.min(ghost.a, ghost.b) * pps,
                        width: Math.abs(ghost.b - ghost.a) * pps,
                      }}
                    />
                  )}
                  {drop && !drop.newTrack && drop.track === track.id && (
                    <div
                      className={`tlDropGhost${track.id === "cut" ? " insert" : ""}`}
                      style={{
                        left: drop.t * pps,
                        width: Math.max(6, dragDurSec * pps),
                      }}
                    >
                      <span className="tlClipLabel">
                        {track.id === "cut" ? `インサート: ${dragName}` : dragName}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            {drop && drop.snapLine !== null && (
              <div className="tlSnapLine" style={{ left: drop.snapLine * pps }} />
            )}
            {snapMark !== null && (
              <div className="tlSnapLine" style={{ left: snapMark * pps }} />
            )}
            <PlayheadMark className="tlPlayhead" pps={pps} />
          </div>
        </div>
        {/* ホバーサムネイル */}
        {hoverThumb && (
          <div
            className="tlDiffHoverThumb"
            style={{
              position: "fixed",
              left: Math.min(hoverThumb.x + 12, window.innerWidth - 320),
              top: Math.min(hoverThumb.y - 160, window.innerHeight - 200),
              zIndex: 40,
            }}
          >
            <div className="tlDiffHoverThumbLabel">変更前 / 変更後</div>
            <div className="tlDiffHoverThumbPair">
              <img
                src={projectPath(`/media/${encodeURIComponent(hoverThumb.still.beforeFile).replace(/%2F/g, "/")}`)}
                alt="変更前"
                className="tlDiffHoverThumbImg"
              />
              <img
                src={projectPath(`/media/${encodeURIComponent(hoverThumb.still.afterFile).replace(/%2F/g, "/")}`)}
                alt="変更後"
                className="tlDiffHoverThumbImg"
              />
            </div>
          </div>
        )}
        {/* クリックポップオーバー */}
        {popoverEvent && (
          <div
            className="tlDiffPopover"
            style={{
              position: "fixed",
              left: Math.max(8, Math.min(popoverEvent.x, window.innerWidth - 268)),
              top: Math.max(8, Math.min(popoverEvent.y + 8, window.innerHeight - 156)),
              zIndex: 30,
            }}
          >
            <div className="tlDiffPopoverTitle">{popoverEvent.event.title}</div>
            <div className="tlDiffPopoverMeta">
              {popoverEvent.event.timeRange
                ? `${popoverEvent.event.timeRange.startSec.toFixed(1)}s \u2192 ${popoverEvent.event.timeRange.endSec.toFixed(1)}s`
                : popoverEvent.event.subtitle}
            </div>
            <div className="tlDiffPopoverActions">
              <button
                className="preview"
                onClick={() => {
                  onDiffPreview?.(popoverEvent.event);
                  setPopoverEvent(null);
                }}
              >
                プレビュー
              </button>
              <button
                className="accept"
                onClick={() => {
                  const hunks = popoverEvent.event.hunkIndexes
                    .map((i) => aiWorkflowHunks?.[i])
                    .filter((h): h is Hunk => Boolean(h));
                  onDiffSetHunk?.(hunks, "theirs");
                  setPopoverEvent(null);
                }}
              >
                 承認して反映
              </button>
              <button
                className="reject"
                onClick={() => {
                  const hunks = popoverEvent.event.hunkIndexes
                    .map((i) => aiWorkflowHunks?.[i])
                    .filter((h): h is Hunk => Boolean(h));
                  onDiffSetHunk?.(hunks, "mine");
                  setPopoverEvent(null);
                }}
              >
                却下
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
