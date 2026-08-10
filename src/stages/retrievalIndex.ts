import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  tokenizeRetrievalText,
  type RetrievalDocument,
  type RetrievalDocumentKind,
  type RetrievalIndex,
} from "../lib/retrieval.ts";
import { SCREEN_DIR_NAME, SCREEN_INDEX_FILE_NAME } from "../lib/screenIndex.ts";

/** screen.probe/index.json への相対パス。screenIndex.ts の定数から組み立てる
 *  (src/stages/screen.ts は import しない=ffmpeg/Apple Vision を引き込まない。
 *  video-perception-P2 §2.1) */
const SCREEN_INDEX_RELATIVE_PATH = `${SCREEN_DIR_NAME}/${SCREEN_INDEX_FILE_NAME}`;

const INPUTS = [
  "meta.json",
  "chapters.json",
  "transcript.json",
  "materials.probe/index.json",
  SCREEN_INDEX_RELATIVE_PATH,
] as const;

export function retrievalIndexPath(recordingsDir: string): string {
  return join(recordingsDir, ".framewright", "retrieval-v1.json");
}

export function buildRetrievalIndex(recordingsDir: string): RetrievalIndex {
  const old = readExisting(retrievalIndexPath(recordingsDir));
  const warnings: string[] = [];
  const recordings: RetrievalIndex["recordings"] = [];
  const documents: RetrievalDocument[] = [];
  for (const entry of readdirSync(recordingsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(recordingsDir, entry.name);
    if (!existsSync(join(dir, "manifest.json"))) continue;
    try {
      const fingerprint = recordingFingerprint(dir);
      const mtimeMs = Math.max(...["manifest.json", ...INPUTS]
        .map((file) => join(dir, file))
        .filter(existsSync)
        .map((file) => statSync(file).mtimeMs));
      recordings.push({ name: entry.name, fingerprint, mtimeMs });
      const oldRecording = old?.recordings.find((item) => item.name === entry.name);
      if (old && oldRecording?.fingerprint === fingerprint) {
        documents.push(...old.documents.filter((doc) => doc.recordingDir === entry.name));
      } else {
        documents.push(...documentsForRecording(dir, entry.name, fingerprint, warnings));
      }
    } catch (error) {
      warnings.push(`${entry.name}: ${(error as Error).message}`);
    }
  }
  const index: RetrievalIndex = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    root: basename(recordingsDir),
    recordings: recordings.sort((a, b) => a.name.localeCompare(b.name)),
    documents: documents.sort((a, b) => a.id.localeCompare(b.id)),
    warnings,
  };
  const path = retrievalIndexPath(recordingsDir);
  mkdirSync(join(recordingsDir, ".framewright"), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  renameSync(tmp, path);
  return index;
}

function documentsForRecording(
  dir: string,
  recording: string,
  fingerprint: string,
  warnings: string[],
): RetrievalDocument[] {
  const out: RetrievalDocument[] = [];
  add(out, recording, "recording", recording, recording, undefined, undefined, fingerprint);
  readJson(dir, "meta.json", warnings, (value) => {
    add(out, recording, "meta", String(value.title ?? recording), JSON.stringify(value), "meta.json", undefined, fingerprint);
  });
  readJson(dir, "chapters.json", warnings, (value) => {
    for (const [index, chapter] of arrayAt(value, "chapters").entries()) {
      add(out, recording, "chapter", String(chapter.title ?? `chapter ${index + 1}`),
        String(chapter.summary ?? chapter.description ?? chapter.title ?? ""), "chapters.json",
        numericRange(chapter), fingerprint, String(index));
    }
  });
  readJson(dir, "transcript.json", warnings, (value) => {
    for (const [index, caption] of arrayAt(value, "segments").entries()) {
      add(out, recording, "caption", String(caption.text ?? ""), String(caption.text ?? ""),
        "transcript.json", numericRange(caption), fingerprint, String(index));
    }
  });
  readJson(dir, "materials.probe/index.json", warnings, (value) => {
    const candidates = Array.isArray(value) ? value : arrayAt(value, "materials");
    for (const [index, material] of candidates.entries()) {
      const file = safeRelativePath(material.file ?? material.path);
      if ((material.file ?? material.path) !== undefined && file === undefined) {
        warnings.push(`${recording}/materials.probe/index.json: invalid material path at index ${index}`);
      }
      const title = file || `material ${index + 1}`;
      add(out, recording, "material", title, JSON.stringify(material), file || undefined, undefined, fingerprint, String(index));
      const ocr = textFrom(material.ocr);
      if (ocr) add(out, recording, "material-ocr", title, ocr, file || undefined, undefined, fingerprint, `${index}:ocr`);
      const transcript = textFrom(material.transcript);
      if (transcript) add(out, recording, "material-transcript", title, transcript, file || undefined, undefined, fingerprint, `${index}:transcript`);
    }
  });
  readJson(dir, SCREEN_INDEX_RELATIVE_PATH, warnings, (value) => {
    for (const [index, segment] of arrayAt(value, "segments").entries()) {
      const repSec = segment.representativeSourceSec;
      if (typeof repSec !== "number" || !Number.isFinite(repSec)) {
        warnings.push(`${recording}/${SCREEN_INDEX_RELATIVE_PATH}: segment ${index} に representativeSourceSec がありません`);
        continue;
      }
      const id = typeof segment.id === "string" ? segment.id : String(index);
      const ocrLines = screenOcrLines(segment);
      const summaryText = screenSummaryText(segment);
      // video-perception-P2 §2.3.1: summary → OCR 先頭行 → "画面 <id>" の優先順
      const title = summaryText || ocrLines[0] || `画面 ${id}`;
      add(out, recording, "screen", title, ocrLines.join(" "), SCREEN_INDEX_RELATIVE_PATH,
        screenSourceRange(segment), fingerprint, String(repSec));
    }
  });
  return out;
}

/** segment.ocr.lines(先頭 indexLines 件・正規化前の生テキスト)。ocr が null なら [] */
function screenOcrLines(segment: Record<string, unknown>): string[] {
  const ocr = segment.ocr;
  if (!ocr || typeof ocr !== "object") return [];
  const lines = (ocr as Record<string, unknown>).lines;
  return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === "string") : [];
}

/** segment.summary?.text(P4 が埋める。P1 のみでは常に summary: null なので undefined) */
function screenSummaryText(segment: Record<string, unknown>): string | undefined {
  const summary = segment.summary;
  if (!summary || typeof summary !== "object") return undefined;
  const text = (summary as Record<string, unknown>).text;
  return typeof text === "string" && text ? text : undefined;
}

function screenSourceRange(segment: Record<string, unknown>): { startSec: number; endSec: number } | undefined {
  const start = segment.sourceSec;
  const end = segment.endSourceSec;
  return typeof start === "number" && typeof end === "number" ? { startSec: start, endSec: end } : undefined;
}

function add(
  out: RetrievalDocument[],
  recordingDir: string,
  kind: RetrievalDocumentKind,
  title: string,
  text: string,
  file: string | undefined,
  sourceRange: { startSec: number; endSec: number } | undefined,
  fingerprint: string,
  suffix = "",
): void {
  const id = createHash("sha256").update(`${recordingDir}\0${kind}\0${file ?? ""}\0${suffix}`).digest("hex").slice(0, 20);
  out.push({
    id,
    recordingDir,
    kind,
    title,
    text,
    ...(file ? { file } : {}),
    ...(sourceRange ? { sourceRange } : {}),
    fingerprint,
    tokens: tokenizeRetrievalText(`${title}\n${file ?? ""}\n${text}`),
  });
}

function recordingFingerprint(dir: string): string {
  const hash = createHash("sha256");
  for (const name of ["manifest.json", ...INPUTS]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const stat = statSync(file);
    hash.update(`${name}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

function readExisting(path: string): RetrievalIndex | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as RetrievalIndex;
    return value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

function readJson(
  dir: string,
  name: string,
  warnings: string[],
  consume: (value: Record<string, unknown>) => void,
): void {
  const file = join(dir, name);
  if (!existsSync(file)) return;
  try {
    consume(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  } catch (error) {
    warnings.push(`${basename(dir)}/${name}: ${(error as Error).message}`);
  }
}

function arrayAt(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const array = value[key];
  return Array.isArray(array) ? array.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

function numericRange(value: Record<string, unknown>): { startSec: number; endSec: number } | undefined {
  const start = value.startSec ?? value.start;
  const end = value.endSec ?? value.end;
  return typeof start === "number" && typeof end === "number" ? { startSec: start, endSec: end } : undefined;
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(textFrom).filter(Boolean).join(" ");
  }
  return "";
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const file = value.trim().replace(/\\/g, "/");
  if (!file || file.startsWith("/") || file.split("/").some((part) => part === "..")) return undefined;
  return file;
}
