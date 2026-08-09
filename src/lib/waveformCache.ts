import { createHash } from "node:crypto";

/** フォーマットを変えたら +1 */
export const WAVEFORM_GENERATION = 1;

/** 1 entry のキャッシュキー。1 バイトでも違えば作り直す */
export interface WaveformEntryKey {
  generation: number;
  /** 収録フォルダからの相対パス。マイク音声は "" */
  source: string;
  mtimeMs: number;
  size: number;
  /** PEAK_RATE。変わったら無効化する */
  rate: number;
}

export interface WaveformEntry {
  key: WaveformEntryKey;
  /** 波形の元になった音声の秒数 */
  durationSec: number;
  /** bin 数。0 = 音声なし */
  bins: number;
  /** timeline.probe/waveform/<content-key>.bin。bins===0 のときは省略 */
  file?: string;
}

export interface WaveformIndex {
  generation: number;
  /** キーは entry の source(相対パス。マイクは "") */
  entries: Record<string, WaveformEntry>;
}

/** entry key → bin のファイル名(拡張子込み)。sha256 の先頭 16 桁 */
export function waveformBinName(key: WaveformEntryKey): string {
  const hash = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16);
  return `${hash}.bin`;
}

/** index の entry が今の key と一致するか(readCached と同じ流儀の完全一致) */
export function isWaveformEntryFresh(entry: WaveformEntry | undefined, key: WaveformEntryKey): boolean {
  return !!entry && JSON.stringify(entry.key) === JSON.stringify(key);
}

/** index が参照している bin ファイル名の集合(GC 用) */
export function referencedBinNames(index: WaveformIndex): Set<string> {
  const names = new Set<string>();
  for (const entry of Object.values(index.entries)) {
    if (entry.bins <= 0 || !entry.file) continue;
    const name = entry.file.split("/").pop();
    if (name) names.add(name);
  }
  return names;
}
