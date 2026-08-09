import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.ts";
import { splitLongCaptions } from "../lib/captionSplit.ts";
import { carryIds, ensureIds, hasAnyId, ID_PREFIX, usedIdsOf } from "../lib/ids.ts";
import { readEditableDocs } from "./idStamp.ts";
import type { Config } from "../lib/config.ts";
import type { Manifest, SystemTranscript, Transcript, TranscriptSegment, WordTiming } from "../types.ts";

/** whisper.cpp の -ojf(output-json-full)の token 1件。-oj でも -ojf でも
 * segment(offsets/text)は同一(実測で確認済み)。tokens[] は -ojf のときだけ付く */
export interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  /** 確信度(0..1)。無いケースは未確認だが防御的に省略可扱いにする */
  p?: number;
  /** DTW トークンアライメント(whisper -dtw)の音響固定タイムスタンプ。
   * 単位はセンチ秒(10ms)・無効は -1(DTW 無効時は全トークン -1)。
   * offsets(注意ベース)と違い文中でも実音声に合う(±数十ms) */
  t_dtw?: number;
}

/** whisper.cpp の JSON 出力(-oj / -ojf)の必要部分 */
interface WhisperJson {
  transcription: Array<{
    offsets: { from: number; to: number };
    text: string;
    /** -ojf のときだけ付く(-oj には無い) */
    tokens?: WhisperToken[];
  }>;
}

/** 角括弧で囲まれた whisper の特殊トークン([_BEG_] / [_TT_441] 等) */
const isSpecialToken = (text: string): boolean => /^\[.*\]$/.test(text);

/**
 * whisper -ojf の1 segment ぶんの tokens[] から words[](WordTiming[])を組み立てる。
 * 特殊トークン([_BEG_] 等)・trim 後空文字・ゼロ幅を除外し、text を trim して
 * 返す。時系列順は tokens[] の順のまま(whisper は昇順で出す)。tokens が
 * 無ければ空配列。
 *
 * 時刻は DTW(t_dtw。whisper -dtw で音響に固定された点。単位センチ秒)が
 * あればそれを優先する: t_dtw は「その語を言い終えた瞬間」に相当する点なので、
 * 語の区間は [直前の有効な点(無ければその語の offsets 開始), 自分の点]。
 * 実測(§docs 2026-07-18): 注意ベースの offsets は文中で±数百ms〜秒単位で
 * ずれ、ポーズに語を等幅で塗り広げるが、DTW 点は keep/cut 境界との照合で
 * 1484語中の逸脱が1語まで落ちる。t_dtw が無効(-1)のトークンは語として
 * 出さない(偽の時刻で出すより欠けの方が害が小さい)。DTW 無効の実行
 * (t_dtw が全て -1 / 無い)では従来の offsets 経路と完全に同じ
 */
export function buildWords(tokens: WhisperToken[] | undefined): WordTiming[] {
  if (!tokens) return [];
  const hasDtw = tokens.some((t) => typeof t.t_dtw === "number" && t.t_dtw >= 0);
  const words: WordTiming[] = [];
  let prevPoint: number | null = null;
  for (const tok of tokens) {
    const text = tok.text.trim();
    if (text.length === 0) continue;
    if (isSpecialToken(text)) continue;
    let start: number;
    let end: number;
    if (hasDtw) {
      if (!(typeof tok.t_dtw === "number" && tok.t_dtw >= 0)) continue;
      const point = tok.t_dtw / 100;
      start = prevPoint ?? tok.offsets.from / 1000;
      // 同一点に複数トークンが乗る(速い発話)ことがあるので、ゼロ幅は
      // 10ms に丸めて文字を落とさない(点の逆行にも同じ防御)
      if (start > point) start = Math.max(0, point - 0.01);
      end = Math.max(point, start + 0.01);
      prevPoint = Math.max(point, prevPoint ?? 0);
    } else {
      start = tok.offsets.from / 1000;
      end = tok.offsets.to / 1000;
    }
    if (!(start < end)) continue;
    const word: WordTiming = { text, start, end };
    if (typeof tok.p === "number") word.confidence = tok.p;
    words.push(word);
  }
  return words;
}

/**
 * id 引き継ぎの純関数(fs 非依存)。id が有効なプロジェクトでのみ、既存
 * transcript.segments から (start,end,text) 完全一致で id を運び(carryIds)、
 * 残りを採番する(ensureIds)。一致しない再分割(再文字起こしで内容が
 * 変わった場合)は新 id になる。idCtx 省略時は id に一切触れず、返り値は
 * segments と同一(=導入前とバイト等価)
 */
export function applyTranscriptIds(
  segments: TranscriptSegment[],
  idCtx?: { existingSegments: TranscriptSegment[]; used: Set<string> },
): TranscriptSegment[] {
  if (!idCtx) return segments;
  const carried = carryIds(
    idCtx.existingSegments,
    segments,
    (s) => `${s.start}:${s.end}:${s.text}`,
  );
  return ensureIds(carried, ID_PREFIX.caption, idCtx.used);
}

/**
 * manifest のマイク音声を whisper.cpp で文字起こしし、
 * transcript.json と transcript.srt を生成する。
 */
export interface TranscribeOptions {
  /** transcript.json を書き込む直前に呼ばれる。throw すると transcript.json /
   * transcript.system.json を書かずに中断する。 */
  beforeWrite?: () => void;
  /** true なら generatedBy: "transcribe"(未採用)を付けて書く。エディタの
   * 自動解析だけが渡す。CLI の transcribe / run は従来どおり採用済み扱い。 */
  markUnadopted?: boolean;
}

/** beforeWrite フックが transcript.json の上書きを拒んだことを表す。 */
export class TranscribeAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscribeAbortedError";
  }
}

export async function transcribe(
  dir: string,
  cfg: Config,
  opts: TranscribeOptions = {},
): Promise<Transcript> {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Manifest;

  if (!existsSync(cfg.whisper.model)) {
    throw new Error(
      `whisper モデルが見つかりません: ${cfg.whisper.model}\n` +
        `README のセットアップ手順に従ってダウンロードしてください。`,
    );
  }

  const outBase = join(dir, "whisper-out");
  await run(cfg.whisper.bin, [
    "-m", cfg.whisper.model,
    "-l", cfg.whisper.language,
    "-f", join(dir, manifest.audio.micWav),
    cfg.whisper.wordTimestamps ? "-ojf" : "-oj", // JSON 出力(-ojf は tokens[] 付き上位互換)
    // DTW トークンアライメント(config.whisper.dtw)。flash attention とは
    // 排他(whisper.cpp が注意行列を実体化しないため)なので -nfa も併せて
    // 渡す(付けないと "not supported with flash_attn - disabling" で
    // 黙って無効化され、t_dtw が全て -1 になる。実測で確認済み)
    ...(cfg.whisper.dtw ? ["-dtw", cfg.whisper.dtw, "-nfa"] : []),
    "-osrt",        // 字幕(srt)も同時に出力
    "-of", outBase, // 出力ファイルのベース名
  ]);

  const whisperJson = JSON.parse(
    readFileSync(`${outBase}.json`, "utf8"),
  ) as WhisperJson;

  const segments: TranscriptSegment[] = whisperJson.transcription
    .map((t) => ({
      start: t.offsets.from / 1000,
      end: t.offsets.to / 1000,
      text: t.text.trim(),
    }))
    .filter((s) => s.text.length > 0);

  // words[] の付加は segment を組み立てた後の別ステップ(既存の text/start/end
  // 算出ロジックには一切手を触れない)。segments と同じ filter 条件(trim 後
  // 非空)で whisperJson.transcription 側を絞れば、同じ順序・同じ件数で対応する
  if (cfg.whisper.wordTimestamps) {
    const kept = whisperJson.transcription.filter((t) => t.text.trim().length > 0);
    for (let i = 0; i < segments.length; i++) {
      const words = buildWords(kept[i]?.tokens);
      if (words.length > 0) segments[i].words = words;
    }
  }

  // テロップ粒度の割り直し(§captionSplit)。config.yaml の whisper.captionSplit
  // が無ければ何もせず segments をそのまま返す(=導入前とバイト等価)。id 採番の
  // 前に行うので、分割後の断片はこの後の id 引き継ぎ/採番の対象になる
  const shaped = cfg.whisper.captionSplit
    ? splitLongCaptions(segments, cfg.whisper.captionSplit)
    : segments;

  // id が有効なプロジェクトでのみ、上書き前(=まだ古い内容)の transcript.json
  // から (start,end,text) 一致で id を運ぶ(§applyTranscriptIds)
  const docs = readEditableDocs(dir);
  const finalSegments = hasAnyId(docs)
    ? applyTranscriptIds(shaped, {
        existingSegments: docs.transcript?.segments ?? [],
        used: usedIdsOf(docs),
      })
    : shaped;

  const transcript: Transcript = {
    ...(opts.markUnadopted ? { generatedBy: "transcribe" as const } : {}),
    language: cfg.whisper.language,
    model: cfg.whisper.model,
    segments: finalSegments,
  };
  opts.beforeWrite?.();
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify(transcript, null, 2),
  );

  // システム音声(デモ音・再生動画・TTS)の第2回 whisper(知覚専用)。
  // ingest が system.wav を抽出したときだけ(= whisper.systemAudio 有効 かつ
  // systemStream あり)。micWav 側(上のロジック)には一切触れない完全に独立の
  // ブロック。描画しないので -osrt は出さず、words も不要なので常に -oj で回す
  // (micWav 側の wordTimestamps 設定に引きずられない)。id 引き継ぎもしない
  // (transcript.system.json は @id の対象外)。未抽出時はこのブロックを丸ごと
  // 飛ばすので transcript.system.json は作られない=導入前とバイト等価
  if (manifest.audio.systemWav) {
    const sysBase = join(dir, "whisper-system-out");
    await run(cfg.whisper.bin, [
      "-m", cfg.whisper.model,
      "-l", cfg.whisper.language,
      "-f", join(dir, manifest.audio.systemWav),
      "-oj",
      "-of", sysBase,
    ]);
    const sysJson = JSON.parse(
      readFileSync(`${sysBase}.json`, "utf8"),
    ) as WhisperJson;
    const sysSegments = sysJson.transcription
      .map((t) => ({
        start: t.offsets.from / 1000,
        end: t.offsets.to / 1000,
        text: t.text.trim(),
      }))
      .filter((s) => s.text.length > 0);
    const systemTranscript: SystemTranscript = {
      language: cfg.whisper.language,
      model: cfg.whisper.model,
      speaker: "system",
      segments: sysSegments,
    };
    writeFileSync(
      join(dir, "transcript.system.json"),
      JSON.stringify(systemTranscript, null, 2),
    );
  }

  return transcript;
}
