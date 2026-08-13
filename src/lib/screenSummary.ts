// video-perception-P4: `screen --summarize` の純関数(索引 §2.9)。
// §docs/plans/2026-08-10-video-perception-p4-vlm-segment-summary-design.md
//
// VLM の呼び出しそのもの(I/O)は src/stages/screen.ts が持つ。ここは:
//   - 後段検証 R1〜R3(§2.3.4。「この順に」適用する。プロンプトで禁じるだけ
//     では足りないので機械的に検査する)
//   - maxSegments 超過時の選定(§2.7。perception.ts の selectOcrTargets と
//     同じ「長い区間から」判断)
//   - プロンプト全文の組み立て(§2.3.2。これ以上足さない)
//   - 応答スキーマ(§2.3.3)
//   - 応答 JSON の型検査(§2.3.3 の必須フィールド)
//   - 区間の畳み直し後の summary 引き継ぎ判定(§2.4.1。representativeSourceSec
//     が一致する旧区間から引き継ぐ)
//
// 「等」「など」で正規表現を拡張しない(索引 §2.10)。

/** R1: 40文字以内(コードポイント数。text.length ではない)。 */
export const SCREEN_SUMMARY_MAX_CODEPOINTS = 40;

/** R2: 数値+単位。「等」で拡張しない(P4 §2.3.4 の正規表現をそのまま使う)。
 *  意図は「時刻・秒数を書かせない」であって「数字を禁じる」ではないので、
 *  単位を伴う数値だけを弾く(`/\d/` 単独では弾かない)。 */
const R2_NUMERIC_UNIT = /\d\s*(秒|分|時間|ms|s\b|フレーム|コマ|f\b)/u;

/** R3: 前後の場面への言及。「等」で拡張しない(P4 §2.3.4 の正規表現をそのまま使う)。 */
const R3_TEMPORAL_REFERENCE = /(この(後|前|直後|直前)|次の場面|先ほど|さきほど|以降|以前)/u;

export type SummaryRejectRule = "R1" | "R2" | "R3";

export type SummaryTextCheck = { ok: true } | { ok: false; rule: SummaryRejectRule };

/**
 * §2.3.4 の後段検証を「この順に」適用する。1つでも該当したら破棄。
 * R1 は `[...text].length`(コードポイント数)で測る。`text.length` だと
 * サロゲートペア(絵文字・一部の漢字)を2文字と誤って数え、正当な40字の
 * 要約を誤破棄する(設計書 T2 が狙う穴)。
 */
export function checkSummaryText(text: string): SummaryTextCheck {
  if ([...text].length > SCREEN_SUMMARY_MAX_CODEPOINTS) return { ok: false, rule: "R1" };
  if (R2_NUMERIC_UNIT.test(text)) return { ok: false, rule: "R2" };
  if (R3_TEMPORAL_REFERENCE.test(text)) return { ok: false, rule: "R3" };
  return { ok: true };
}

/**
 * `maxSegments` を超える場合は長い区間(`lenSec` 降順)を優先して選ぶ
 * (`selectOcrTargets`(`src/lib/perception.ts`)と同じ判断)。選んだ後は
 * 元の並び順に戻す(呼び出し側の処理順を安定させる。同点は元の添字が
 * 小さいほうを優先する決定論的タイブレーク)。
 */
export function selectSummarizeTargets<T extends { lenSec: number }>(
  segments: readonly T[],
  maxSegments: number,
): { selected: T[]; droppedCount: number } {
  if (segments.length <= maxSegments) return { selected: [...segments], droppedCount: 0 };
  const indexed = segments.map((seg, index) => ({ seg, index }));
  const kept = indexed
    .sort((a, b) => b.seg.lenSec - a.seg.lenSec || a.index - b.index)
    .slice(0, Math.max(0, maxSegments))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.seg);
  return { selected: kept, droppedCount: segments.length - kept.length };
}

const PROMPT_HEADER = [
  "この画面は何をしている場面かを、1行の日本語で答えてください。",
  "",
  "制約:",
  "- 40文字以内。",
  "- 座標・時刻・秒数・フレーム番号を書かないでください。",
  "- 「この後」「この前」など、前後の場面への言及をしないでください。",
  "- 画面から読み取れないことは推測しないでください。読み取れないときは confidence を low にしてください。",
].join("\n");

/**
 * §2.3.2 のプロンプト全文を組み立てる。OCR 行が無い(非対応環境・OCR 失敗)
 * ときは「参考」段落ごと省略する(設計書は空の参考段落の扱いを明記していない
 * ため、送るものが無い段落を送らないという保守的な選択。判断の記録は
 * 実装報告を参照)。
 */
export function buildScreenSummaryPrompt(ocrLines: readonly string[]): string {
  if (ocrLines.length === 0) return PROMPT_HEADER;
  return `${PROMPT_HEADER}\n\n参考(この画面の OCR 結果の先頭数行):\n${ocrLines.join("\n")}`;
}

export const SCREEN_SUMMARY_SCHEMA_NAME = "framewright_screen_segment_summary";

/** §2.3.3 の出力スキーマ(JsonSchemaTextFormat の中身)。 */
export function screenSummaryResponseSchema(): { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: false } {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: ["summary", "confidence"],
    additionalProperties: false,
  };
}

export interface ParsedScreenSummaryResponse {
  text: string;
  confidence: "low" | "medium" | "high";
}

/**
 * completeAi の応答テキスト(json-schema 出力なので JSON 文字列)を検査する。
 * 壊れていれば例外を投げる(呼び出し側が catch し、その区間だけ summary:
 * null + warnings に積んで続行する。§2.5 の「JSON パースに失敗」行)。
 */
export function parseScreenSummaryResponse(raw: string): ParsedScreenSummaryResponse {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("screen summary response must be an object");
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.summary !== "string") throw new Error("screen summary response.summary must be a string");
  if (rec.confidence !== "low" && rec.confidence !== "medium" && rec.confidence !== "high") {
    throw new Error("screen summary response.confidence must be low/medium/high");
  }
  return { text: rec.summary, confidence: rec.confidence };
}

export interface ScreenSummaryProvenance {
  profile: string;
  adapter: string;
  model: string;
  observedAt: string;
}

export interface ScreenSummary {
  text: string;
  confidence: "low" | "medium" | "high";
  provenance: ScreenSummaryProvenance;
}

/**
 * §2.4.1: 旧 `index.json` の区間から `representativeSourceSec → summary`
 * の Map を作る(summary が無い区間は入れない)。区間が畳み直されても
 * 代表の元収録秒が同じなら同じ場面なので、新区間はここから summary を
 * VLM を呼ばずに引き継げる。
 */
export function buildInheritedSummaryMap(
  oldSegments: readonly { representativeSourceSec: number; summary: ScreenSummary | null }[],
): Map<number, ScreenSummary> {
  const map = new Map<number, ScreenSummary>();
  for (const seg of oldSegments) {
    if (seg.summary) map.set(seg.representativeSourceSec, seg.summary);
  }
  return map;
}
