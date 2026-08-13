// 常駐フレームサーバ(frames-serve <dir>)。
//
// frames() は1回の CLI 呼び出しの中で headless Chrome を起動しているが、
// AI の編集ループ(JSON 編集 → frames --t … → 確認 → …)は
// 毎回別プロセスの CLI 起動なので、そのコールドコストをまたいで再利用できない。
// このデーモンは `frames <dir> --t …` が portfile(frames/.serve.json)を
// 見つけたら POST /frames でここへ委譲する常駐窓口になる。
//
// config・編集 JSON・props は毎リクエスト読み直す(framesEngine が単発と同じ経路で
// 行う)。したがってデーモン経由でも単発でも出る絵は同一(設計 §課題2 論点2-B)。
//
// editor/server.ts の localhost サーバ骨格(node:http・127.0.0.1・Host/Origin
// 検査・requestTimeout=0)を流用。1 デーモン = 1 収録。

import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { loadConfig } from "../lib/config.ts";
import { framesEngine } from "./frames.ts";
import type { FrameRequest } from "./frames.ts";

/** frames/ 内、常駐サーバの待受情報を書くファイル(中間生成物。frames/*.png
 * の全消しループ(.png/.ocr.json のみ対象)には含まれない) */
export const SERVE_PORT_FILE = ".serve.json";

/** frames.serve.port(config.yaml)未指定時の既定ポート。editor(4310)と別 */
export const DEFAULT_SERVE_PORT = 4311;

/** frames/.serve.json の中身 */
export interface ServePortFile {
  port: number;
  pid: number;
}

/** POST /frames の body(FrameRequest を JSON 化したもの+撮影オプション) */
interface ServeRequestBody {
  mode?: unknown;
  times?: unknown;
  axis?: unknown;
  stepSec?: unknown;
  maxShots?: unknown;
  ocr?: unknown;
  fullRes?: unknown;
}

/** パース済みの撮影リクエスト(framesEngine にそのまま渡せる形) */
export interface ParsedFramesRequest {
  req: FrameRequest;
  opts: { ocr?: boolean; fullRes?: boolean };
}

/**
 * POST /frames の body(JSON.parse 済みの unknown)を FrameRequest+opts に
 * 変換・検査する純関数(unit test 対象)。frames CLI の --t/--captions/--every
 * と同じ組み立てルールを HTTP body 向けに素直に写したもの。不正な body は
 * 分かりやすいメッセージで例外を投げる(handle 側が 400 で返す)
 */
export function parseFramesServeBody(body: unknown): ParsedFramesRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("body が JSON オブジェクトではありません");
  }
  const b = body as ServeRequestBody;
  let req: FrameRequest;
  if (b.mode === "captions") {
    req = { mode: "captions" };
  } else if (b.mode === "every") {
    if (typeof b.stepSec !== "number" || !(b.stepSec > 0)) {
      throw new Error(
        `every モードには正の数値 stepSec が必要です: ${JSON.stringify(b.stepSec)}`,
      );
    }
    req = { mode: "every", stepSec: b.stepSec };
  } else if (b.mode === "times") {
    if (!Array.isArray(b.times) || b.times.some((t) => typeof t !== "number")) {
      throw new Error("times モードには数値配列 times が必要です");
    }
    if (b.axis !== undefined && b.axis !== "source" && b.axis !== "output") {
      throw new Error(`axis が不正です: ${JSON.stringify(b.axis)}(source/output のいずれか)`);
    }
    req = { mode: "times", times: b.times as number[], axis: b.axis === "output" ? "output" : "source" };
  } else if (b.mode === "scenes") {
    // video-perception-P0。FrameRequest に mode を足したらここも足さないと、
    // frames-serve 起動中だけ frames --scenes が 400 で落ちる(委譲は
    // フォールバックしない。framesClient.ts:78)
    if (typeof b.maxShots !== "number" || !(b.maxShots > 0)) {
      throw new Error(
        `scenes モードには正の数値 maxShots が必要です: ${JSON.stringify(b.maxShots)}`,
      );
    }
    req = { mode: "scenes", maxShots: b.maxShots };
  } else {
    throw new Error(
      `mode が不正です: ${JSON.stringify(b.mode)}(times/captions/every/scenes のいずれか)`,
    );
  }
  const opts = {
    ocr: b.ocr === true,
    fullRes: b.fullRes === true,
  };
  return { req, opts };
}

/** DNS rebinding・CSRF 対策(editor/server.ts と同じ正規表現・同じ判断) */
const LOCAL_HOST = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 常駐フレームサーバを起動する(Ctrl+C まで終了しない)。
 * - POST /frames: body を FrameRequest+opts にパースし、loadConfig()(毎回)
 *   → framesEngine(dir, req, cfg, opts...) → { shots } を返す
 * - GET /ping: 生存確認(B3 の frames CLI 検出用)
 */
export async function startFramesServe(
  dir: string,
  explicitConfigPath: string | undefined,
  port: number,
): Promise<void> {
  console.log("frames-serve 起動準備中(headless Chrome を暖機。数十秒かかることがあります)...");

  async function handleFrames(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: ParsedFramesRequest;
    try {
      parsed = parseFramesServeBody(body);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const cfg = loadConfig(explicitConfigPath);
    const shots = await framesEngine(
      dir, parsed.req, cfg,
      parsed.opts.ocr, parsed.opts.fullRes,
    );
    sendJson(res, 200, { shots });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: Error) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error(err);
      sendJson(res, 500, { error: err.message });
    });
  });
  // frames のレンダーは proxy 生成・複数枚撮影で数十秒かかることがあるので、
  // Node 既定の requestTimeout(5分)で切れないよう無効化(editor と同じ判断)
  server.requestTimeout = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!LOCAL_HOST.test(req.headers.host ?? "")) {
      sendJson(res, 403, { error: `forbidden host: ${req.headers.host ?? "(none)"}` });
      return;
    }
    if (
      req.method !== "GET" &&
      req.headers.origin !== undefined &&
      !LOCAL_HOST.test(req.headers.origin)
    ) {
      sendJson(res, 403, { error: `forbidden origin: ${req.headers.origin}` });
      return;
    }
    if (req.method === "GET" && url.pathname === "/ping") {
      sendJson(res, 200, { ok: true, pid: process.pid });
      return;
    }
    if (req.method === "POST" && url.pathname === "/frames") {
      await handleFrames(req, res);
      return;
    }
    sendJson(res, 404, { error: `not found: ${url.pathname}` });
  }

  await new Promise<void>((ok, ng) => {
    server.once("error", ng);
    server.listen(port, "127.0.0.1", ok);
  });

  const framesDir = join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  const portFilePath = join(framesDir, SERVE_PORT_FILE);
  const portFile: ServePortFile = { port, pid: process.pid };
  writeFileSync(portFilePath, JSON.stringify(portFile, null, 2));

  console.log(`frames-serve 起動: 127.0.0.1:${port}(対象: ${dir})`);
  console.log("frames <dir> --t ... 等がこのデーモンを自動検出して使います。終了は Ctrl+C");

  // 終了時の portfile 削除。signal 経路では明示的に消してから exit し、
  // それ以外の経路は exit イベントで同期的に回収する。
  const cleanupPortFile = () => {
    if (existsSync(portFilePath)) rmSync(portFilePath, { force: true });
  };
  process.on("exit", cleanupPortFile);
  process.on("SIGINT", () => {
    cleanupPortFile();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanupPortFile();
    process.exit(0);
  });
}
