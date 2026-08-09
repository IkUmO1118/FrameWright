import { useSyncExternalStore } from "react";

/**
 * 再生ヘッド位置(カット後の秒)のミニストア。
 *
 * Remotion Player の frameupdate は再生中 fps 回/秒(30回/秒)届く。これを
 * App の useState に入れると UI 全体(タイムラインの全クリップ・インスペクタ・
 * パネル)が毎フレーム再レンダーされ、メインスレッドが詰まる。Player は
 * rAF 基準の時計と <video> の currentTime のずれをシークで補正するため、
 * この詰まりはそのまま「補正シークの連発 → 音の途切れ・映像の停止」になる
 * (UI の重さが再生品質に直結する構造)。
 *
 * そこで再生ヘッドは React の state に載せず、時刻を表示する少数の末端
 * コンポーネント(時刻表示・シークバー・再生ヘッド線・ボタンの活性)だけが
 * usePlayheadSelector で購読する。編集操作(分割など)は playhead.get() で
 * その時点の値を読む。
 */

let current = 0;
const listeners = new Set<() => void>();

export const playhead = {
  /** 現在の再生ヘッド(カット後の秒)。イベントハンドラから読む用 */
  get: (): number => current,
  /** Player の frameupdate ハンドラ(App)と、ルーラーのスクラブ
   * (editor-perf P2。正確なフレームを待たずマーカーだけ先行させる)が呼ぶ */
  set: (outT: number): void => {
    if (outT === current) return;
    current = outT;
    for (const l of listeners) l();
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/**
 * 再生ヘッドから派生する値を購読する。selector の結果が変わったフレーム
 * だけ再レンダーされる(Object.is 比較)ので、返り値はプリミティブに
 * すること(毎回新しいオブジェクトを返すと毎フレーム再レンダーに戻り、
 * このストアを設けた意味がなくなる)。
 */
export function usePlayheadSelector<T>(selector: (outT: number) => T): T {
  return useSyncExternalStore(playhead.subscribe, () => selector(current));
}
