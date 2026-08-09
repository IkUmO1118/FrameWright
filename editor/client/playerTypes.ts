// 旧 Player の型のローカル宣言。Player 実体は既に使っておらず
// `EnginePreview`（自前エンジン）が本番。依存を切るためにここへ写した。
export type EventTypes = "frameupdate" | "play" | "pause";

export type PlayerEvent<T extends EventTypes> = T extends "frameupdate"
  ? { detail: { frame: number } }
  : { detail: undefined };

export type CallbackListener<T extends EventTypes> = (event: PlayerEvent<T>) => void;

export interface PlayerRef {
  seekTo(frame: number): void;
  seekToAsync(frame: number): Promise<void>;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  getCurrentFrame(): number;
  setVolume(volume: number): void;
  addEventListener<T extends EventTypes>(type: T, listener: CallbackListener<T>): void;
  removeEventListener<T extends EventTypes>(type: T, listener: CallbackListener<T>): void;
}
