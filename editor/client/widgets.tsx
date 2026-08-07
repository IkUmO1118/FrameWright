import { useEffect, useRef, useState } from "react";
// DOM の FocusEvent / MouseEvent を隠さないよう別名で入れる
// (このファイルは document.addEventListener で DOM 側の型も使う)
import type { FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
// ConfigPatch はサーバー側モジュールの型だが import type なのでバンドルには入らない
import type { ConfigPatch } from "../../src/lib/configEdit.ts";
import type {
  AiFrameRequest,
  AiFrameResponse,
  AiProposeRequest,
  AiProposeResponse,
  AiRefineRequest,
  AiRefineResponse,
  AiReviewRequest,
  AiReviewResponse,
  AnalyzeResponse,
  AiDoctorResult,
  ConfigSaveResult,
  DraftData,
  HyperframeAuthorResponse,
  HyperframeRenderResponse,
  HyperframesData,
  MediaFactsData,
  PeaksData,
  ProjectData,
  ProjectsResponse,
  ReadyProjectData,
  ProxyResponse,
  SaveRequest,
  SaveResponse,
  ScriptData,
  UploadResult,
} from "./apiTypes.ts";
import { projectPath } from "./route.ts";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function getProject(): Promise<ProjectData> {
  return (await request("/api/project", undefined)) as ProjectData;
}

export async function getProjects(): Promise<ProjectsResponse> {
  return (await request("/api/projects", undefined)) as ProjectsResponse;
}

export async function createProject(
  name: string,
  canvas: string,
  baseLayout = "auto",
  layout = "plain",
  root?: string,
): Promise<{ dir: string; name: string; canvas: string; layout?: string; baseLayout?: string; root: string }> {
  return (await request("/api/projects", { name, canvas, baseLayout, layout, root })) as
    { dir: string; name: string; canvas: string; layout?: string; baseLayout?: string; root: string };
}

export async function postDerive(name: string, canvas: string, ranges: Array<{ start: number; end: number }>, baseLayout = "auto"): Promise<{ dir: string; name: string }> {
  return (await request("/api/derive", { name, canvas, baseLayout, ranges })) as { dir: string; name: string };
}

export async function postBaseMedia(file: string, canvas: string, baseLayout = "auto"): Promise<ReadyProjectData> {
  return (await request("/api/base-media", { file, canvas, baseLayout })) as ReadyProjectData;
}

export async function uploadBaseMedia(file: File, canvas: string, baseLayout = "auto"): Promise<ReadyProjectData> {
  const res = await fetch(
    projectPath(`/api/upload?as=base&name=${encodeURIComponent(file.name)}&canvas=${encodeURIComponent(canvas)}&baseLayout=${encodeURIComponent(baseLayout)}`),
    { method: "POST", body: file },
  );
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : res.statusText;
    throw new Error(msg);
  }
  return data as ReadyProjectData;
}

/** スクリプトタブの元データ(元収録の全文文字起こし)。タブを初めて開いた
 * ときだけ取得する(whisper-out.json 由来で数百KBになりうるため) */
export async function getScript(): Promise<ScriptData> {
  return (await request("/api/script", undefined)) as ScriptData;
}

/** 動画素材ごとの codec 由来のブラウザ表示可否(非表示のものだけの疎な map)。
 * fetch 失敗時は呼び出し側で {} 扱いにする(警告なしへ degrade。§design 8.2) */
export async function getMediaFacts(): Promise<MediaFactsData> {
  return (await request("/api/media-facts", undefined)) as MediaFactsData;
}

/** HTML source と render 済み MP4 を突き合わせた HF カード一覧。 */
export async function getHyperframes(): Promise<HyperframesData> {
  return (await request("/api/hyperframes", undefined)) as HyperframesData;
}

/** HF source を既存 stage で render する。force は渡せず cache hit を再利用する。 */
export async function postHyperframeRender(name: string): Promise<HyperframeRenderResponse> {
  return (await request("/api/hyperframe/render", { name })) as HyperframeRenderResponse;
}

function fileBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  });
}

/** brief と任意の画像から新規カードを author → render する。既存名は上書きしない。 */
export async function postHyperframeAuthor(
  name: string,
  brief: string,
  files: readonly File[],
): Promise<HyperframeAuthorResponse> {
  const assets = await Promise.all(files.map(async (file) => ({
    name: file.name,
    data: await fileBase64(file),
  })));
  return (await request("/api/hyperframe/author", {
    name,
    brief,
    ...(assets.length > 0 ? { assets } : {}),
  })) as HyperframeAuthorResponse;
}

/** AI 生成素材(カード)を丸ごと削除する(render 済み MP4 と、再生成に使う
 * source html・添付素材の両方)。undo できないので、呼ぶ側で確認を挟むこと */
export async function deleteHyperframe(name: string): Promise<void> {
  await request(`/api/hyperframe?name=${encodeURIComponent(name)}`, undefined, "DELETE");
}

/** タイムラインに描く音声の波形ピーク。時刻軸はマイク = 元収録の秒、
 * 素材・BGM = そのファイル自身の秒 */
export interface Peaks {
  rate: number;
  data: Uint8Array;
}

/** file 省略 = マイク音声。指定時は収録フォルダ内の素材・BGM のピーク。
 * 音声が無いファイルは data が空で返る(呼び出し側は波形を描かない) */
export async function getPeaks(file?: string): Promise<Peaks> {
  const path = file ? `/api/peaks?file=${encodeURIComponent(file)}` : "/api/peaks";
  const res = (await request(path, undefined)) as PeaksData;
  const bin = atob(res.peaks);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { rate: res.rate, data };
}

export async function postSave(body: SaveRequest): Promise<SaveResponse> {
  return (await request("/api/save", body)) as SaveResponse;
}

export async function postAiPropose(body: AiProposeRequest): Promise<AiProposeResponse> {
  return (await request("/api/ai/propose", body)) as AiProposeResponse;
}

export async function postAiFrames(body: AiFrameRequest): Promise<AiFrameResponse> {
  return (await request("/api/ai/frames", body)) as AiFrameResponse;
}

export async function postAiReview(body: AiReviewRequest): Promise<AiReviewResponse> {
  return (await request("/api/ai/review", body)) as AiReviewResponse;
}

export async function postAiRefine(body: AiRefineRequest): Promise<AiRefineResponse> {
  return (await request("/api/ai/refine", body)) as AiRefineResponse;
}

export async function postAiDoctor(body: { route?: "text" | "structured" | "vision" }): Promise<AiDoctorResult[]> {
  return (await request("/api/ai/doctor", body)) as AiDoctorResult[];
}
/** 未保存編集の自動退避(.editor-draft.json)。クラッシュへの保険で、
 * 正のデータには触らない。保存が成功したら deleteDraft で消す */
export async function postDraft(body: DraftData): Promise<void> {
  await request("/api/draft", body);
}

export async function deleteDraft(): Promise<void> {
  await request("/api/draft", undefined, "DELETE");
}

/** proxy.*(元収録の軽量プロキシ)の生成。収録ごとに1回でよい */
export async function postProxy(): Promise<ProxyResponse> {
  return (await request("/api/proxy", {})) as ProxyResponse;
}

/** 開いた瞬間の自動解析(transcribe → detect)。plan は走らない。 */
export async function postAnalyze(): Promise<AnalyzeResponse> {
  return (await request("/api/analyze", {})) as AnalyzeResponse;
}

/** 設定画面の保存。config.yaml の該当キーを書き換え(コメント保持)、
 * サーバー内の設定にも即反映される。戻り値は解決済みの新しい設定 */
export async function postConfig(patch: ConfigPatch): Promise<ConfigSaveResult> {
  return (await request("/api/config", patch)) as ConfigSaveResult;
}

/** カット確認用プレビュー(preview.mp4)の生成。完了までに時間がかかる。
 * 入力はディスクの JSON を読むので、呼ぶ前に保存しておくこと */
export async function postPreview(): Promise<{ path: string }> {
  return (await request("/api/preview", {})) as { path: string };
}

/** 最終レンダー(final.mp4)。approved: true が必要で、数分かかることがある。
 * 入力はディスクの JSON を読むので、呼ぶ前に保存しておくこと */
export async function postRender(): Promise<{ path: string }> {
  return (await request("/api/render", {})) as { path: string };
}

/** 出力先(final.mp4 / preview.mp4 等)を Finder で開き直す。完了トーストの
 * 「開く」から呼ぶ。path は render/preview が返した収録フォルダ内のパス */
export async function postReveal(path: string): Promise<void> {
  await request(`/api/reveal?file=${encodeURIComponent(path)}`, {});
}

/** 素材ファイル(materials/)を収録フォルダから削除する。ファイルの削除は
 * JSON の編集と違って undo(⌘Z)できないので、呼ぶ側で確認を挟むこと */
export async function deleteMaterial(file: string): Promise<void> {
  await request(`/api/material?file=${encodeURIComponent(file)}`, undefined, "DELETE");
}

/** 素材ファイルを収録フォルダの materials/ へアップロードする */
export async function uploadMaterial(f: File): Promise<UploadResult> {
  const res = await fetch(projectPath(`/api/upload?name=${encodeURIComponent(f.name)}`), {
    method: "POST",
    body: f,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : res.statusText;
    throw new Error(msg);
  }
  return data as UploadResult;
}

async function request(
  path: string,
  body: unknown,
  method?: "DELETE",
): Promise<unknown> {
  const res = await fetch(projectPath(path), body === undefined && method === undefined
    ? undefined
    : {
        method: method ?? "POST",
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : res.statusText;
    const code =
      data && typeof data === "object" && "code" in data && typeof (data as { code: unknown }).code === "string"
        ? (data as { code: string }).code
        : undefined;
    throw new ApiError(msg, res.status, code);
  }
  return data;
}

/** 動画素材の拡張子(尺の取得・サムネイル表示の分岐に使う) */
export const VIDEO_EXT_RE = /\.(mp4|mov|webm)$/i;

/** 音声のみの拡張子(BGM 専用。素材・映像トラックには置けない) */
export const AUDIO_EXT_RE = /\.(mp3|m4a|wav|aac|ogg|flac)$/i;

/** 既存素材の尺(秒)をブラウザのメタデータ読み込みで調べる。
 * 画像・取得失敗は null(呼び出し側で既定の 4 秒などにする) */
export function probeMaterialDuration(file: string): Promise<number | null> {
  if (!VIDEO_EXT_RE.test(file)) return Promise.resolve(null);
  return probeMaterialMeta(file).then((m) => m.durationSec);
}

/** 素材のメタ情報。ブラウザのメタデータ読み込みで調べる(実尺は動画のみ) */
export interface MaterialMeta {
  durationSec: number | null;
  width: number | null;
  height: number | null;
}

// セッション中に素材ファイルは変わらない前提でモジュール内にキャッシュする
const materialMetaCache = new Map<string, MaterialMeta | Promise<MaterialMeta>>();

/** 素材の実尺・解像度を調べる(結果はキャッシュ)。取得失敗は null 埋め */
export function probeMaterialMeta(file: string): Promise<MaterialMeta> {
  const hit = materialMetaCache.get(file);
  if (hit) return Promise.resolve(hit);
  const none: MaterialMeta = { durationSec: null, width: null, height: null };
  const p: Promise<MaterialMeta> = VIDEO_EXT_RE.test(file)
    ? new Promise((resolve) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () =>
          resolve({
            durationSec: Number.isFinite(v.duration) ? v.duration : null,
            width: v.videoWidth || null,
            height: v.videoHeight || null,
          });
        v.onerror = () => resolve(none);
        v.src = `media/${file}`;
      })
    : new Promise((resolve) => {
        const img = new Image();
        img.onload = () =>
          resolve({
            durationSec: null,
            width: img.naturalWidth || null,
            height: img.naturalHeight || null,
          });
        img.onerror = () => resolve(none);
        img.src = `media/${file}`;
      });
  materialMetaCache.set(file, p);
  void p.then((m) => materialMetaCache.set(file, m));
  return p;
}

/** 素材メタ情報の React フック。取得が済むまでは null(描画側は省略表示) */
export function useMaterialMeta(file: string | null): MaterialMeta | null {
  const resolved = (f: string | null): MaterialMeta | null => {
    const hit = f ? materialMetaCache.get(f) : null;
    return hit && !(hit instanceof Promise) ? hit : null;
  };
  const [meta, setMeta] = useState<MaterialMeta | null>(() => resolved(file));
  useEffect(() => {
    let alive = true;
    setMeta(resolved(file));
    if (file) {
      void probeMaterialMeta(file).then((m) => {
        if (alive) setMeta(m);
      });
    }
    return () => {
      alive = false;
    };
  }, [file]);
  return meta;
}

/** CSS カラーを hex(#rrggbb)+不透明度(0〜1)に分解する。
 * 対応: #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()。それ以外は白扱い
 * (座布団の色+透明度スライダーが GUI で編集できるようにするため) */
export function splitColor(c: string): { hex: string; alpha: number } {
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1].split("");
    return { hex: `#${r}${r}${g}${g}${b}${b}`.toLowerCase(), alpha: 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) {
    return { hex: `#${m[1].toLowerCase()}`, alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) {
    const to2 = (v: string) =>
      Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, "0");
    return {
      hex: `#${to2(m[1])}${to2(m[2])}${to2(m[3])}`,
      alpha: m[4] !== undefined ? Math.max(0, Math.min(1, Number(m[4]))) : 1,
    };
  }
  return { hex: "#ffffff", alpha: 1 };
}

/** hex+不透明度を CSS カラーへ(不透明なら hex のまま、半透明は rgba()) */
export function joinColor(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}

/** テロップの表示寸法(出力px)の近似。位置プリセットの計算に使う。
 * 幅は最長行の実測(canvas)、高さは行数 x 行送り 1.4(描画エンジンと同じ) */
let measureCtx: CanvasRenderingContext2D | null = null;
export function measureCaption(
  text: string,
  fontSizePx: number,
  fontFamily: string,
  fontWeight: number,
): { w: number; h: number } {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  const lines = (text.trim() || "テロップ").split("\n");
  let w = fontSizePx; // 計測不能時のフォールバック(1文字ぶん)
  if (measureCtx) {
    measureCtx.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`;
    w = 0;
    for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
  }
  return { w: Math.ceil(w), h: Math.ceil(lines.length * fontSizePx * 1.4) };
}

/** 2〜3択のセグメントコントロール(fit の contain/cover など)。
 * ドロップダウンと違い、選択肢の全体と現在値が一目で分かる */
export const Segmented = <T extends string,>({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) => (
  <div className={`seg${disabled ? " disabled" : ""}`}>
    {options.map((o) => (
      <button
        key={o.value}
        className={o.value === value ? "on" : ""}
        title={o.title}
        disabled={disabled}
        onClick={() => onChange(o.value)}
      >
        {o.label}
      </button>
    ))}
  </div>
);

/** %スライダー(音量・不透明度)。値の表示付き。ドラッグ中は連続で
 * onChange が届くので、呼び出し側は undo のまとめ(coalesce)を使うこと */
export const PctSlider = ({
  pct,
  max = 100,
  title,
  onChange,
}: {
  pct: number;
  max?: number;
  title?: string;
  onChange: (pct: number) => void;
}) => (
  <>
    <input
      type="range"
      className="pctSlider"
      min={0}
      max={max}
      step={5}
      value={pct}
      title={title}
      style={{
        background: `linear-gradient(to right, hsl(var(--oc-primary)) ${(pct / max) * 100}%, hsl(var(--oc-border)) ${(pct / max) * 100}%)`,
      }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
    <span className="mono dim pctVal">{pct}%</span>
  </>
);

/** スピーカーアイコン(線画 SVG)。mute は ×、low/high は波の数で音量を表す */
export const VolumeIcon = ({
  level,
  size = 14,
}: {
  level: "mute" | "low" | "high";
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    {level === "mute" ? (
      <>
        <line x1="16" y1="9" x2="22" y2="15" />
        <line x1="22" y1="9" x2="16" y2="15" />
      </>
    ) : (
      <>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        {level === "high" && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
      </>
    )}
  </svg>
);

/** 目アイコン(線画 SVG)。トラックの一時非表示トグル用。
 * open=false は斜線入り(非表示中)を表す */
export const EyeIcon = ({
  open,
  size = 14,
}: {
  open: boolean;
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.8" />
    {!open && <line x1="4.5" y1="3.5" x2="19.5" y2="20.5" />}
  </svg>
);

/** パネル開閉トグルのアイコン(VSCode のレイアウト切替と同じ意匠)。
 * 枠の中の該当部分(左/右/下)が塗られている = そのパネルが表示中 */
export const PanelIcon = ({
  side,
  on,
  size = 16,
}: {
  side: "left" | "right" | "bottom";
  on: boolean;
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    {side === "left" && <line x1="9.5" y1="4" x2="9.5" y2="20" />}
    {side === "right" && <line x1="14.5" y1="4" x2="14.5" y2="20" />}
    {side === "bottom" && <line x1="3" y1="14.5" x2="21" y2="14.5" />}
    {on && side === "left" && (
      <rect x="4.4" y="5.4" width="3.8" height="13.2" rx="1" fill="currentColor" stroke="none" />
    )}
    {on && side === "right" && (
      <rect x="15.8" y="5.4" width="3.8" height="13.2" rx="1" fill="currentColor" stroke="none" />
    )}
    {on && side === "bottom" && (
      <rect x="4.4" y="15.8" width="15.2" height="2.8" rx="1" fill="currentColor" stroke="none" />
    )}
  </svg>
);

/** トランスポートの送りアイコン(線画 SVG)。
 * シェブロン1枚 = 1フレーム、2枚 = 1秒(大きい送り)を表す */
export const StepIcon = ({
  dir,
  double = false,
  size = 16,
}: {
  dir: "back" | "fwd";
  double?: boolean;
  size?: number;
}) => {
  const flip = dir === "back" ? undefined : "scale(-1 1) translate(-24 0)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g transform={flip}>
        {double ? (
          <>
            <polyline points="11 17 6 12 11 7" />
            <polyline points="18 17 13 12 18 7" />
          </>
        ) : (
          <polyline points="14.5 17 9.5 12 14.5 7" />
        )}
      </g>
    </svg>
  );
};

/** 先頭/末尾へジャンプするアイコン(縦棒+シェブロンの線画 SVG) */
export const JumpIcon = ({
  dir,
  size = 16,
}: {
  dir: "back" | "fwd";
  size?: number;
}) => {
  const flip = dir === "back" ? undefined : "scale(-1 1) translate(-24 0)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g transform={flip}>
        <line x1="7" y1="7" x2="7" y2="17" />
        <polyline points="17.5 17 12.5 12 17.5 7" />
      </g>
    </svg>
  );
};

/** 元に戻す/やり直すアイコン(曲がり矢印の線画 SVG)。redo は左右反転 */
export const UndoIcon = ({
  dir,
  size = 16,
}: {
  dir: "undo" | "redo";
  size?: number;
}) => {
  const flip = dir === "undo" ? undefined : "scale(-1 1) translate(-24 0)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g transform={flip}>
        <polyline points="9 13.5 4 9 9 4.5" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H10" />
      </g>
    </svg>
  );
};

/** 分割(razor)アイコン(ハサミの線画 SVG)。再生ヘッド位置でのクリップ分割用 */
export const SplitIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="20" y1="4" x2="8.12" y2="15.88" />
    <line x1="14.47" y1="14.48" x2="20" y2="20" />
    <line x1="8.12" y1="8.12" x2="12" y2="12" />
  </svg>
);

/** 複製(コピー2枚重ね)アイコン(線画 SVG)。選択中クリップの複製(⌘D)用 */
export const DuplicateIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

/** 削除(ゴミ箱)アイコン(線画 SVG)。選択中クリップの削除用 */
export const TrashIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

/** 吸着(スナップ)アイコン = 馬蹄形マグネット(線画 SVG)。
 * 両脚の先に極のバンドを描いて「くっつく」意味を表す。ドロップ吸着トグル用 */
export const MagnetIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {/* 外側の U(左脚→上のアーチ→右脚) */}
    <path d="M4 20 V13 a8 8 0 0 1 16 0 V20" />
    {/* 内側の U */}
    <path d="M9 20 V13 a3 3 0 0 1 6 0 V20" />
    {/* 両極のバンド(脚先の帯) */}
    <path d="M4 15.5 H9 M15 15.5 H20" />
  </svg>
);

/** ループ再生アイコン(線画 SVG) */
export const LoopIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polyline points="16.5 3 20 6.5 16.5 10" />
    <path d="M4 12.5v-2a4 4 0 0 1 4-4h12" />
    <polyline points="7.5 21 4 17.5 7.5 14" />
    <path d="M20 11.5v2a4 4 0 0 1-4 4H4" />
  </svg>
);


/** パネル最大化アイコン(対角の矢印)。active のとき内向き(=元に戻す) */
export const MaximizeIcon = ({
  active,
  size = 16,
}: {
  active?: boolean;
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {active ? (
      <>
        <polyline points="4 14 10 14 10 20" />
        <polyline points="20 10 14 10 14 4" />
        <line x1="14" y1="10" x2="21" y2="3" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </>
    ) : (
      <>
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </>
    )}
  </svg>
);

/** フルスクリーンアイコン(四隅の枠)。active のとき内向き(=解除) */
export const FullscreenIcon = ({
  active,
  size = 16,
}: {
  active?: boolean;
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {active ? (
      <>
        <path d="M8 3v3a2 2 0 0 1-2 2H3" />
        <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
        <path d="M3 16h3a2 2 0 0 1 2 2v3" />
        <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
      </>
    ) : (
      <>
        <path d="M8 3H5a2 2 0 0 0-2 2v3" />
        <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
        <path d="M3 16v3a2 2 0 0 0 2 2h3" />
        <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
      </>
    )}
  </svg>
);

/** 再生/一時停止アイコン(塗りつぶし SVG)。playing のとき一時停止マーク */
export const PlayPauseIcon = ({
  playing,
  size = 16,
}: {
  playing: boolean;
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinejoin="round"
    aria-hidden
  >
    {playing ? (
      <>
        <rect x="6.5" y="5.5" width="3.5" height="13" rx="1" />
        <rect x="14" y="5.5" width="3.5" height="13" rx="1" />
      </>
    ) : (
      <polygon points="8.5 5.5 18.5 12 8.5 18.5" />
    )}
  </svg>
);

export { fmtTime, parseTimecode } from "./timecode.ts";

/**
 * 秒数の編集欄。入力中はローカルのテキストを保持し、blur / Enter で確定する
 * (小数の途中入力で親の state が壊れないようにするため)。
 * allowEmpty のときは空欄で undefined を返す(章の cardSec のような省略可の値用)
 */
export const NumInput = ({
  value,
  onCommit,
  allowEmpty = false,
  placeholder,
  title,
}: {
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
  allowEmpty?: boolean;
  placeholder?: string;
  title?: string;
}) => {
  const [text, setText] = useState<string | null>(null);
  // 外から value が変わったら(選択切替・ドラッグ)未確定のテキストは破棄する。
  // 残すと blur 時に古い入力が別のクリップへ commit されてしまう
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setText(null);
  }
  const shown = text ?? (value === undefined ? "" : String(value));
  const parsed = shown.trim() === "" ? (allowEmpty ? undefined : NaN) : Number(shown);
  const invalid = typeof parsed === "number" && !Number.isFinite(parsed);

  const commit = () => {
    if (!invalid && text !== null) onCommit(parsed);
    setText(null);
  };
  return (
    <input
      className={`num${invalid ? " invalid" : ""}`}
      type="text"
      inputMode="decimal"
      value={shown}
      placeholder={placeholder}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      {...selectAllOnFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setText(null);
      }}
    />
  );
};

/** 数値欄をクリックしたら中身を全選択する(打ち直しが1アクションで済む)。
 * onFocus の select() だけでは直後の mouseup がキャレットを置いて選択を
 * 解除してしまうので、フォーカスを取りに行くクリックの mouseup だけ潰す
 * (既にフォーカス済みなら潰さない=途中にキャレットを置く操作は殺さない) */
const selectAllOnFocus = {
  onFocus: (e: ReactFocusEvent<HTMLInputElement>) => e.currentTarget.select(),
  onMouseDown: (e: ReactMouseEvent<HTMLInputElement>) => {
    if (document.activeElement !== e.currentTarget) e.currentTarget.dataset.selectOnUp = "1";
  },
  onMouseUp: (e: ReactMouseEvent<HTMLInputElement>) => {
    if (e.currentTarget.dataset.selectOnUp) {
      e.preventDefault();
      delete e.currentTarget.dataset.selectOnUp;
    }
  },
};

/**
 * Figma 風の数値フィールド。1つの部品で3通りの入力ができる:
 * ①テキストで直接入力(Enter / blur で確定)②↑↓キーで増減(Shift で ×10)
 * ③右の ▾ でプリセット一覧を開いて選ぶ。unit を渡すと入力欄内に単位を添える。
 * NumInput と同じく allowEmpty のとき空欄は undefined(placeholder で自動値を示す)。
 * min を渡すと下限でクランプする(縁の太さの 0 など)。
 */
export const NumStepper = ({
  value,
  onCommit,
  allowEmpty = false,
  placeholder,
  title,
  presets,
  unit,
  step = 1,
  min,
}: {
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
  allowEmpty?: boolean;
  placeholder?: string;
  title?: string;
  /** ▾ で開くプリセット候補。省略時は ▾ を出さない(入力+↑↓のみ) */
  presets?: number[];
  /** 入力欄内に添える単位(例 "px") */
  unit?: string;
  /** ↑↓の刻み(既定 1)。Shift 併用で ×10 */
  step?: number;
  /** 下限(これ未満にはしない)。省略時は下限なし */
  min?: number;
}) => {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // プリセットは body 直下のポータルへ fixed 配置で出す(インスペクタの
  // overflow に切られず常に最前面に来る)。開いたときの座標を保持する
  const [menuPos, setMenuPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    minWidth: number;
  } | null>(null);
  const [lastValue, setLastValue] = useState(value);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // フィールドの位置から、下に開くか上に開くかを決めて座標を作る
  const openMenu = () => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rows = presets ? presets.length : 0;
    const estH = Math.min(240, rows * 26 + 8);
    const below = window.innerHeight - r.bottom;
    const flipUp = below < estH + 12 && r.top > below;
    setMenuPos({
      left: r.left,
      minWidth: r.width,
      ...(flipUp ? { bottom: window.innerHeight - r.top + 3 } : { top: r.bottom + 3 }),
    });
    setOpen(true);
  };
  if (lastValue !== value) {
    setLastValue(value);
    setText(null);
  }
  const shown = text ?? (value === undefined ? "" : String(value));
  const parsed = shown.trim() === "" ? (allowEmpty ? undefined : NaN) : Number(shown);
  const invalid = typeof parsed === "number" && !Number.isFinite(parsed);
  const clamp = (n: number) => (min !== undefined ? Math.max(min, n) : n);

  const commit = () => {
    if (!invalid && text !== null) onCommit(parsed);
    setText(null);
  };
  const commitNum = (n: number) => {
    setText(null);
    onCommit(clamp(n));
  };
  // ↑↓/▲▼での増減。未確定テキストがあればそれを、無ければ確定値を、
  // どちらも無ければ placeholder(自動値)を起点にする。
  // 未確定テキストを先に見るのが要点(「60」と打った直後の ↑ は 61 であって、
  // 確定値 52 の +1 ではない)
  const bump = (dir: number, mult: number) => {
    const typed = text !== null && !invalid && typeof parsed === "number" ? parsed : undefined;
    const base =
      typed ??
      value ??
      (placeholder !== undefined && placeholder.trim() !== "" && Number.isFinite(Number(placeholder))
        ? Number(placeholder)
        : 0);
    commitNum(base + dir * step * mult);
  };

  // 外側クリックで閉じる(ポータルのメニュー内クリックは閉じない)。
  // スクロール・リサイズは座標がずれるので閉じる
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // 外側のスクロールは座標がずれるので閉じるが、メニュー自身の
    // 内部スクロール(overflow-y)では閉じない(target がメニュー内なら無視)
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (t && menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <div className="numStepper" ref={wrapRef}>
      <input
        className={`num${invalid ? " invalid" : ""}`}
        type="text"
        inputMode="decimal"
        value={shown}
        placeholder={placeholder}
        title={title}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        {...selectAllOnFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") setText(null);
          else if (e.key === "ArrowUp") {
            e.preventDefault();
            bump(1, e.shiftKey ? 10 : 1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            bump(-1, e.shiftKey ? 10 : 1);
          }
        }}
      />
      {unit && <span className="numStepperUnit">{unit}</span>}
      {presets && presets.length > 0 && (
        <button
          type="button"
          className="numStepperChevron"
          title="プリセットから選ぶ"
          aria-label="プリセットから選ぶ"
          onClick={() => (open ? setOpen(false) : openMenu())}
        >
          ▾
        </button>
      )}
      {open &&
        menuPos &&
        presets &&
        presets.length > 0 &&
        createPortal(
          <div
            ref={menuRef}
            className="numStepperMenu"
            role="listbox"
            style={{
              left: menuPos.left,
              minWidth: menuPos.minWidth,
              ...(menuPos.top !== undefined ? { top: menuPos.top } : {}),
              ...(menuPos.bottom !== undefined ? { bottom: menuPos.bottom } : {}),
            }}
          >
            {presets.map((p) => (
              <button
                type="button"
                key={p}
                role="option"
                aria-selected={value === p}
                className={`numStepperOpt${value === p ? " active" : ""}`}
                // onMouseDown で確定(input の blur より先に走らせ、値を確実に反映)
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitNum(p);
                  setOpen(false);
                }}
              >
                <span className="numStepperCheck">{value === p ? "✓" : ""}</span>
                {p}
                {unit ?? ""}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
};
