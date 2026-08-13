export type RetrievalDocumentKind =
  | "recording"
  | "caption"
  | "meta"
  | "chapter"
  | "material"
  | "material-ocr"
  | "material-transcript"
  | "screen";

export interface RetrievalDocument {
  id: string;
  recordingDir: string;
  kind: RetrievalDocumentKind;
  title: string;
  text: string;
  file?: string;
  sourceRange?: { startSec: number; endSec: number };
  fingerprint: string;
  tokens: string[];
}

export interface RetrievalRecording {
  name: string;
  fingerprint: string;
  mtimeMs: number;
}

export interface RetrievalIndex {
  schemaVersion: 1;
  builtAt: string;
  root: string;
  recordings: RetrievalRecording[];
  documents: RetrievalDocument[];
  warnings: string[];
}

export interface RetrievalQuery {
  query: string;
  kind?: "recording" | "material" | "caption" | "screen";
  scope?: "current" | "other" | "all";
  currentRecording?: string;
  limit?: number;
}

export interface RetrievalResult {
  recording: string;
  kind: RetrievalDocumentKind;
  title: string;
  relativePath?: string;
  sourceRange?: { startSec: number; endSec: number };
  snippet: string;
  score: number;
}

export function tokenizeRetrievalText(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  for (const run of normalized.match(/[a-z0-9]+|[^\x00-\x7f\s\p{P}\p{S}]+/gu) ?? []) {
    if (/^[a-z0-9]+$/.test(run)) {
      tokens.push(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1) tokens.push(chars[0]);
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= chars.length; i++) tokens.push(chars.slice(i, i + size).join(""));
    }
  }
  return tokens;
}

export function scoreDocument(queryTokens: string[], doc: RetrievalDocument): number {
  if (queryTokens.length === 0) return 0;
  const title = new Set(tokenizeRetrievalText(doc.title));
  const file = new Set(tokenizeRetrievalText(doc.file ?? ""));
  const bodyCounts = counts(doc.tokens);
  let score = 0;
  for (const token of queryTokens) {
    if (title.has(token)) score += 4;
    if (file.has(token)) score += 3;
    score += Math.min(bodyCounts.get(token) ?? 0, 3) * 2;
  }
  return score;
}

export function searchIndex(index: RetrievalIndex, query: RetrievalQuery): RetrievalResult[] {
  const queryTokens = tokenizeRetrievalText(query.query);
  const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
  const kindMatches = (kind: RetrievalDocumentKind): boolean => {
    if (!query.kind) return true;
    if (query.kind === "material") return kind.startsWith("material");
    return kind === query.kind;
  };
  return index.documents
    .filter((doc) => kindMatches(doc.kind))
    .filter((doc) => {
      if (!query.currentRecording || !query.scope || query.scope === "all") return true;
      return query.scope === "current"
        ? doc.recordingDir === query.currentRecording
        : doc.recordingDir !== query.currentRecording;
    })
    .map((doc) => ({ doc, score: scoreDocument(queryTokens, doc) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) =>
      b.score - a.score
      || recordingMtime(index, b.doc.recordingDir) - recordingMtime(index, a.doc.recordingDir)
      || a.doc.id.localeCompare(b.doc.id))
    .slice(0, limit)
    .map(({ doc, score }) => ({
      recording: doc.recordingDir,
      kind: doc.kind,
      title: doc.title,
      ...(doc.file ? { relativePath: doc.file } : {}),
      ...(doc.sourceRange ? { sourceRange: doc.sourceRange } : {}),
      snippet: snippet(doc.text, query.query),
      score,
    }));
}

function counts(tokens: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1);
  return out;
}

function recordingMtime(index: RetrievalIndex, name: string): number {
  return index.recordings.find((item) => item.name === name)?.mtimeMs ?? 0;
}

function snippet(text: string, query: string): string {
  const normalized = text.normalize("NFKC");
  const needle = query.normalize("NFKC").trim();
  const at = needle ? normalized.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  const start = Math.max(0, at < 0 ? 0 : at - 60);
  return normalized.slice(start, start + 180).replace(/\s+/g, " ").trim();
}
