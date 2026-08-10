// video-perception-P4 §3.1(T1〜T14)。`screen --summarize` の後段検証
// (R1〜R3)・maxSegments 選定・引き継ぎ・優雅な劣化を固定する。
//
// T2・T5・T10・T12 は「実装者が発明しやすい箇所」を狙って設計書に置かれている
// (§docs/plans/2026-08-10-video-perception-p4-vlm-segment-summary-design.md §3.1)。
// 素朴な実装だと T2 は text.length で誤破棄、T5 は /\d/ 単独で誤破棄、
// T10 は capability エラーでも全区間リトライ、T12 は毎回全区間へ VLM を呼び直す。
//
// VLM(completeAi)は実際には呼ばない。screen() の deps.completeAi へ注入し、
// 呼び出し回数・引数を数える(P1 の runOcr 注入と同じ手法。§3.2)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screen } from "../src/stages/screen.ts";
import type { ScreenDeps, ScreenIndex } from "../src/stages/screen.ts";
import type { Config } from "../src/lib/config.ts";
import type { OcrResult } from "../src/lib/ocr.ts";
import type { AiRequest, AiResponse } from "../src/lib/ai/types.ts";
import { AiProviderError } from "../src/lib/ai/http.ts";
import {
  buildInheritedSummaryMap,
  buildScreenSummaryPrompt,
  checkSummaryText,
  parseScreenSummaryResponse,
  selectSummarizeTargets,
} from "../src/lib/screenSummary.ts";

// ---- 純関数(§2.3.4 R1〜R3・§2.7 選定)---------------------------------

test("T1: 41コードポイントの出力は切り詰められず破棄される(R1)", () => {
  const text = "あ".repeat(41);
  assert.equal([...text].length, 41);
  const result = checkSummaryText(text);
  assert.deepEqual(result, { ok: false, rule: "R1" });
});

test("T2: サロゲートペアを含む40コードポイントの文字列は通る(R1。text.lengthでは誤破棄する)", () => {
  // 😀(U+1F600)はサロゲートペア=UTF-16コード単位2つ・コードポイント1つ。
  // 合計コードポイント数は 1 + 39 = 40 だが、text.length は 2 + 39 = 41 になる
  const text = `\u{1F600}${"あ".repeat(39)}`;
  assert.equal([...text].length, 40, "コードポイント数は40");
  assert.equal(text.length, 41, "text.length は41(サロゲートペアを2文字と数えるため)");
  const result = checkSummaryText(text);
  assert.deepEqual(result, { ok: true });
});

test("T3: 「30秒後にビルドが完了」はR2で破棄される", () => {
  assert.deepEqual(checkSummaryText("30秒後にビルドが完了"), { ok: false, rule: "R2" });
});

test("T4: 「1834フレーム一致を確認」はR2で破棄される(「フレーム」は単位)", () => {
  assert.deepEqual(checkSummaryText("1834フレーム一致を確認"), { ok: false, rule: "R2" });
});

test("T5: 「gate:pixel が 1834 件通過」は通る(単位を伴わない数値は正当)", () => {
  assert.deepEqual(checkSummaryText("gate:pixel が 1834 件通過"), { ok: true });
});

test("T6: 「この後テストを実行する」はR3で破棄される", () => {
  assert.deepEqual(checkSummaryText("この後テストを実行する"), { ok: false, rule: "R3" });
});

test("T8: maxSegmentsを超えるとlenSec降順で選ばれ、切った件数が報告される", () => {
  const segs = [
    { id: "a", lenSec: 5 },
    { id: "b", lenSec: 40 },
    { id: "c", lenSec: 10 },
    { id: "d", lenSec: 40 },
    { id: "e", lenSec: 2 },
  ];
  const { selected, droppedCount } = selectSummarizeTargets(segs, 3);
  assert.equal(droppedCount, 2);
  // 長さ降順(同点は元の並び順)で b,d,c が選ばれ、選定後は元の並び順に戻る
  assert.deepEqual(selected.map((s) => s.id), ["b", "c", "d"]);
});

test("selectSummarizeTargets: 上限以下ならそのまま(droppedCount 0)", () => {
  const segs = [{ id: "a", lenSec: 5 }, { id: "b", lenSec: 1 }];
  const { selected, droppedCount } = selectSummarizeTargets(segs, 10);
  assert.equal(droppedCount, 0);
  assert.deepEqual(selected.map((s) => s.id), ["a", "b"]);
});

test("buildScreenSummaryPrompt: OCR行が無ければ参考段落を省く", () => {
  const prompt = buildScreenSummaryPrompt([]);
  assert.ok(!prompt.includes("参考"));
  assert.ok(prompt.includes("40文字以内"));
});

test("buildScreenSummaryPrompt: OCR行があれば参考段落に改行区切りで載せる", () => {
  const prompt = buildScreenSummaryPrompt(["$ npm run gate:pixel", "PASS"]);
  assert.ok(prompt.includes("参考(この画面の OCR 結果の先頭数行):"));
  assert.ok(prompt.includes("$ npm run gate:pixel\nPASS"));
});

test("parseScreenSummaryResponse: 正しいJSONを検査してtext/confidenceを返す", () => {
  const parsed = parseScreenSummaryResponse(JSON.stringify({ summary: "エディタで編集中", confidence: "high" }));
  assert.deepEqual(parsed, { text: "エディタで編集中", confidence: "high" });
});

test("parseScreenSummaryResponse: confidence が不正なら例外", () => {
  assert.throws(() => parseScreenSummaryResponse(JSON.stringify({ summary: "x", confidence: "certain" })));
});

test("buildInheritedSummaryMap: summaryが無い区間は入らない", () => {
  const map = buildInheritedSummaryMap([
    { representativeSourceSec: 10, summary: null },
    {
      representativeSourceSec: 20,
      summary: { text: "x", confidence: "high", provenance: { profile: "p", adapter: "anthropic", model: "m", observedAt: "t" } },
    },
  ]);
  assert.equal(map.size, 1);
  assert.ok(map.has(20));
  assert.ok(!map.has(10));
});

// ---- I/O 層(screen() への --summarize 統合)----------------------------

function writeMotion(dir: string, secs: number[], keepsHash = "hash-A"): void {
  const motion = {
    schemaVersion: 2,
    capturedAt: "2026-08-10T00:00:00.000Z",
    key: { axisGeneration: 2, keepsHash, base: { file: "proxy.mp4", mtimeMs: 1, size: 2 } },
    range: { startSec: 0, endSec: secs[secs.length - 1] },
    base: "proxy",
    strip: { file: "motion.strip.png", cols: 5, rows: 1, tiles: [] },
    motion: secs.map((s, i) => ({
      outSec: s,
      sourceSec: s,
      sceneScore: i === 0 || i === secs.length - 1 ? 0.01 : 0.9,
    })),
    frozen: [],
  };
  mkdirSync(join(dir, "av.probe"), { recursive: true });
  writeFileSync(join(dir, "av.probe", "motion.json"), JSON.stringify(motion, null, 2));
}

function makeFixture(secs: number[]): string {
  const dir = mkdtempSync(join(tmpdir(), "framewright-screen-summary-"));
  writeFileSync(join(dir, "raw.mkv"), "fake-source-bytes");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      source: "raw.mkv",
      canvas: "landscape",
      video: { screenRegion: { x: 0, y: 0, w: 1920, h: 1080 } },
    }),
  );
  writeMotion(dir, secs);
  return dir;
}

/** vision route が設定された(= legacy-ai / anthropic)cfg。既定 maxSegments
 * は十分大きく取り、テストごとに個別上書きする */
function makeCfg(over: Record<string, unknown> = {}): Config {
  return {
    ai: { provider: "anthropic", model: "test-model" },
    av: { everySec: 1 },
    screen: { minGapSec: 6, minSegmentSec: 2, maxSamples: 120, ...over },
  } as unknown as Config;
}

/** vision route が未設定の cfg。text/structured だけ routed 設定し、vision
 * route を意図的に省く(.env の実鍵の有無に左右されないよう、defaultRuntime
 * の環境変数探索を経由しない routed 形で明示的に「未設定」を作る) */
function makeUnconfiguredCfg(): Config {
  return {
    ai: {
      profiles: { main: { adapter: "anthropic", model: "test-model" } },
      routes: { text: "main", structured: "main" },
    },
    av: { everySec: 1 },
    screen: { minGapSec: 6, minSegmentSec: 2, maxSamples: 120 },
  } as unknown as Config;
}

function makeOcrStillDeps(): Pick<ScreenDeps, "runOcr" | "buildScreenStill"> {
  return {
    buildScreenStill: async (_dir, _manifest, sourceSec, outPath) => {
      mkdirSync(join(outPath, ".."), { recursive: true });
      writeFileSync(outPath, `png-${sourceSec}`);
      return outPath;
    },
    runOcr: async (imagePath): Promise<OcrResult | null> => {
      const body = readFileSync(imagePath, "utf8");
      return {
        text: body,
        lines: [{ text: body, confidence: 0.9, box: { x: 0, y: 0, w: 10, h: 10 } }],
        image: { w: 1920, h: 1080 },
      };
    },
  };
}

function fakeResponse(summary: string, confidence: "low" | "medium" | "high" = "high"): AiResponse {
  return {
    text: JSON.stringify({ summary, confidence }),
    profile: "test-vision",
    adapter: "anthropic",
    model: "test-model",
  };
}

test("T7: R2抵触の応答は破棄されsummary:nullになり、warningsにR2が積まれる", async () => {
  const dir = makeFixture([0, 20]);
  try {
    const calls: AiRequest[] = [];
    const deps: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async (req) => {
        calls.push(req);
        return fakeResponse("30秒後にビルドが完了");
      },
    };
    const index = await screen(dir, { summarize: true }, makeCfg(), deps);
    assert.equal(calls.length, 1);
    assert.equal(index.segments.length, 1);
    assert.equal(index.segments[0].summary, null);
    assert.ok(index.warnings.some((w) => w.includes("R2")), `warnings に R2 が無い: ${JSON.stringify(index.warnings)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T9: 1区間の呼び出し失敗は他の区間を巻き込まず続行する", async () => {
  const dir = makeFixture([0, 20, 40, 60]);
  try {
    let callIndex = 0;
    const deps: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => {
        callIndex++;
        if (callIndex === 2) throw new Error("network blip");
        return fakeResponse(`区間${callIndex}を編集中`);
      },
    };
    const index = await screen(dir, { summarize: true }, makeCfg(), deps);
    assert.equal(index.segments.length, 3, "3区間になるフィクスチャ前提");
    assert.equal(callIndex, 3, "3区間すべてで呼ばれた(失敗しても打ち切らない)");
    assert.notEqual(index.segments[0].summary, null, "1件目は成功");
    assert.equal(index.segments[1].summary, null, "2件目は失敗してnull");
    assert.notEqual(index.segments[2].summary, null, "3件目は成功(続行した証拠)");
    assert.ok(index.warnings.some((w) => w.includes("失敗しました")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T10: capabilityのAiProviderErrorは1区間目で打ち切り、2区間目以降を呼ばない", async () => {
  const dir = makeFixture([0, 20, 40, 60]);
  try {
    let callCount = 0;
    const deps: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => {
        callCount++;
        throw new AiProviderError({
          message: 'AI profile "test-vision" は structuredOutput=none です',
          code: "capability",
          profile: "test-vision",
          adapter: "anthropic",
        });
      },
    };
    const index = await screen(dir, { summarize: true }, makeCfg(), deps);
    assert.equal(index.segments.length, 3, "3区間になるフィクスチャ前提");
    assert.equal(callCount, 1, "1区間目で打ち切り、2区間目以降を呼ばない");
    for (const seg of index.segments) assert.equal(seg.summary, null);
    assert.ok(index.warnings.some((w) => w.includes("以降の区間の要約を打ち切ります")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T11: 成功した要約のprovenanceにprofile/adapter/model/observedAtが入る", async () => {
  const dir = makeFixture([0, 20]);
  try {
    const deps: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => fakeResponse("エディタでコードを編集中"),
    };
    const index = await screen(dir, { summarize: true }, makeCfg(), deps);
    const summary = index.segments[0].summary;
    assert.ok(summary);
    assert.equal(summary!.text, "エディタでコードを編集中");
    assert.equal(summary!.confidence, "high");
    assert.equal(summary!.provenance.profile, "test-vision");
    assert.equal(summary!.provenance.adapter, "anthropic");
    assert.equal(summary!.provenance.model, "test-model");
    assert.equal(typeof summary!.provenance.observedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(summary!.provenance.observedAt)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T12: representativeSourceSecが一致する旧区間のsummaryが引き継がれ、VLMが呼ばれない", async () => {
  const dir = makeFixture([0, 20]);
  try {
    const deps1: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => fakeResponse("エディタでコードを編集中"),
    };
    const first = await screen(dir, { summarize: true }, makeCfg(), deps1);
    assert.notEqual(first.segments[0].summary, null);

    let secondCallCount = 0;
    const deps2: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => {
        secondCallCount++;
        return fakeResponse("別の要約(呼ばれてはいけない)");
      },
    };
    const second = await screen(dir, { summarize: true }, makeCfg(), deps2);
    assert.equal(secondCallCount, 0, "representativeSourceSec が同じなら VLM を呼ばない");
    assert.deepEqual(second.segments[0].summary, first.segments[0].summary, "provenance ごと引き継ぐ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T13: --forceでは引き継がず全再生成する", async () => {
  const dir = makeFixture([0, 20]);
  try {
    const deps1: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => fakeResponse("エディタでコードを編集中"),
    };
    await screen(dir, { summarize: true }, makeCfg(), deps1);

    let secondCallCount = 0;
    const deps2: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => {
        secondCallCount++;
        return fakeResponse("再生成された要約");
      },
    };
    const second = await screen(dir, { summarize: true, force: true }, makeCfg(), deps2);
    assert.equal(secondCallCount, 1, "--force は引き継がず VLM を呼び直す");
    assert.equal(second.segments[0].summary!.text, "再生成された要約");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T14: --summarizeなしではsummaryがnullのまま・VLMが0回(バイト等価)", async () => {
  const dir = makeFixture([0, 20, 40, 60]);
  try {
    let callCount = 0;
    const deps: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => {
        callCount++;
        return fakeResponse("呼ばれてはいけない");
      },
    };
    const index = await screen(dir, {}, makeCfg(), deps);
    assert.equal(callCount, 0, "--summarize なしでは VLM を1回も呼ばない");
    for (const seg of index.segments) assert.equal(seg.summary, null);

    // 2回連続実行しても(既存P1の2層キャッシュどおり)結果は完全一致する
    const again = await screen(dir, {}, makeCfg(), deps);
    assert.equal(callCount, 0);
    assert.deepEqual(again, index, "screen.probe/index.json はバイト等価");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("優雅な劣化: vision route未設定ではVLMを1回も呼ばず決定論のまま終了する", async () => {
  const dir = makeFixture([0, 20]);
  try {
    let callCount = 0;
    const deps: ScreenDeps = {
      ...makeOcrStillDeps(),
      completeAi: async () => {
        callCount++;
        return fakeResponse("呼ばれてはいけない");
      },
    };
    const index: ScreenIndex = await screen(dir, { summarize: true }, makeUnconfiguredCfg(), deps);
    assert.equal(callCount, 0);
    assert.equal(index.segments[0].summary, null);
    assert.ok(index.warnings.some((w) => w.includes("ai.routes.vision")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
