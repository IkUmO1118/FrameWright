import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeWithJsonSchema } from "../lib/llm.ts";
import { mergeIntervals } from "../lib/timeline.ts";
import { carryIds, ensureIds, hasAnyId, ID_PREFIX, usedIdsOf } from "../lib/ids.ts";
import { readEditableDocs } from "./idStamp.ts";
import { extractJsonObject, parseCutsResponse, CUTS_RESPONSE_SCHEMA, cutsResponseSchema } from "../lib/cutsResponse.ts";
export { parseCutsResponse } from "../lib/cutsResponse.ts";
import { buildCutplan, toCutplanIdContext } from "../lib/buildCutplan.ts";
export { buildCutplan, fillSilenceGaps, DEFAULT_SILENCE_CUT_REASON } from "../lib/buildCutplan.ts";
export type { CutplanIdContext, CutplanFill } from "../lib/buildCutplan.ts";
import {
  planHarnessEnabled,
  planLoopEnabled,
  resolveCandidatesCfg,
  resolvePerceptionCfg,
  resolvePlanHarnessCfg,
  resolvePlanLoopCfg,
  resolvePlanLoopSecondaryObservationCfg,
  resolveReasonIdsCfg,
  resolveStyleProfileCfg,
} from "../lib/config.ts";
import { renderReasonIdsBlock, renderReasonIdsOutputBlock } from "../lib/reasonIdInjection.ts";
import { buildFirstPlan, writeFirstPlan } from "../lib/firstPlan.ts";
import { agenticCutTurn } from "../lib/ai/agenticCut.ts";
import type { AgenticCtx, AgenticTraceEntry, SplitOp, SplitTraceEntry } from "../lib/ai/agenticCut.ts";
import type { AiAdapter } from "../lib/ai/types.ts";
import { resolveEditMode, renderEditModeBlock } from "../lib/editMode.ts";
import { candidateText, collectWords, subdivideCandidates } from "../lib/candidates.ts";
import { applyCandidateSplits } from "../lib/candidateSplit.ts";
import type { CandidateSplitCfg } from "../lib/candidateSplit.ts";
import {
  deriveLoopAssertions,
  selectPlanLoopReviewTimes,
  shouldStop,
  summarizeObservation,
} from "../lib/planLoop.ts";
import type {
  LoopCut,
  ObservationProvider,
  ObservationInput,
  PlanLoopCfg,
  PlanSecondaryObservationCfg,
} from "../lib/planLoop.ts";
import {
  computeAudioFeatures,
  computeCursorFeatures,
  computeSegmentOcr,
  computeSystemSpeech,
  loadSystemTranscript,
  renderPerceptionBlock,
} from "../lib/perception.ts";
import { readCursorSidecar } from "./planEffects.ts";
import type { Config } from "../lib/config.ts";
import { captionTrack } from "../types.ts";
import { frames } from "./frames.ts";
import {
  MAX_SECONDARY_OUTPUT_TOKENS,
  reviewFrameId,
  VlmSecondaryObservationProvider,
  type SecondaryObservationProvider,
} from "../lib/vlmObservation.ts";
import type { DeterministicReviewObservation, ReviewCheck, SideObservation } from "../lib/reviewObservation.ts";
import type {
  AutoCuts,
  Chapters,
  CutPlan,
  Interval,
  Manifest,
  Meta,
  Overlays,
  PlanSegment,
  Transcript,
  TranscriptSegment,
  WordTiming,
} from "../types.ts";
import type { AssertionsDoc } from "../types.ts";
import { evaluateStructural } from "./assert.ts";
import { describeJson } from "./describe.ts";
import type { DescribeProjection } from "./describe.ts";
import { STYLE_PROBE_DIR } from "./styleProfile.ts";
import { renderStyleProfileBlock } from "../lib/styleInjection.ts";
import type { StyleProfile } from "../lib/styleProfile.ts";

/**
 * このプロジェクトで id が有効(§docs/plans/2026-07-07-stable-ids-design.md の
 * opt-in・sticky 原則)なら、cutplan.segments への carryIds 用の既存配列と、
 * project 全体で衝突しない used 集合を返す。無効なら undefined(=生成ステージは
 * 一切 id に触れず、出力は導入前とバイト等価)。
 */
function buildIdContext(
  dir: string,
): { used: Set<string>; existingCutplanSegments: PlanSegment[] } | undefined {
  const docs = readEditableDocs(dir);
  if (!hasAnyId(docs)) return undefined;
  return { used: usedIdsOf(docs), existingCutplanSegments: docs.cutplan?.segments ?? [] };
}

/** channel(dir の親)の style.probe/<name>.json を読む。不在・パース失敗は
 * warn して null(=空注入へ優雅劣化。前提エラーで plan を止めない=§5.3/§SD-T4)。
 * styleCheck.ts の profile 読込(channel = dirname(resolve(dir)))と同じ規約 */
function loadStyleProfileForPlan(
  dir: string,
  name: string,
  warn: (msg: string) => void,
): StyleProfile | null {
  const channel = dirname(resolve(dir));
  const path = join(channel, STYLE_PROBE_DIR, `${name}.json`);
  if (!existsSync(path)) {
    warn(
      `style profile が見つかりません: ${path}(先に \`style-profile --from ${dir}\`)。スタイル注入はスキップします`,
    );
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StyleProfile;
  } catch (e) {
    warn(`style profile を解析できません: ${path}(${(e as Error).message})。スタイル注入はスキップします`);
    return null;
  }
}

/** 残す候補区間 + 重なる文字起こしテキストに番号を振ったもの(LLM 入力用)。
 */
export interface NumberedSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** 区間ごとに重なる文字起こしをまとめ、1始まりの番号を振る */
export function numberSegments(
  segments: Interval[],
  transcript: Transcript,
): NumberedSegment[] {
  return segments.map((k, i) => {
    const texts = transcript.segments
      .filter((s) => s.start < k.end && s.end > k.start)
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0);
    return { id: i + 1, start: k.start, end: k.end, text: texts.join(" ") };
  });
}

/** candidates.enabled 時専用: 細分化済み候補に、実際に残る語だけの
 * テキスト(C8)で番号を振る。words が無い候補は numberSegments と同じ
 * overlap 全文にフォールバックする(§src/lib/candidates.ts candidateText) */
export function numberSegmentsWords(
  segments: Interval[],
  transcript: Transcript,
): NumberedSegment[] {
  const words = collectWords(transcript);
  return segments.map((k, i) => {
    const text =
      candidateText(k, words) ??
      transcript.segments
        .filter((s) => s.start < k.end && s.end > k.start)
        .map((s) => s.text.trim())
        .filter((t) => t.length > 0)
        .join(" ");
    return { id: i + 1, start: k.start, end: k.end, text };
  });
}

/** plan のオプション */
export interface PlanOptions {
  /** true のとき cutplan.json / plan.raw.txt だけを書く(章・タイトル・
   * 概要欄・章テロップには一切触らない)。run の内訳を直交なコマンドに
   * 分解する用途(transcribe=テロップ / detect+plan --cuts-only=カット /
   * remeta=章・メタ) */
  cutsOnly?: boolean;
  withVlm?: boolean;
}

export type CompleteFn = (prompt: string, cfg: Config) => Promise<string>;

export interface PlanDeps {
  complete?: CompleteFn;
  observe?: ObservationProvider;
  secondaryProvider?: SecondaryObservationProvider;
  /** テスト専用の注入点: plan.harness.agentic 経路で使う AI アダプタを差し替える
   * (fake アダプタでループを実際の network なしに駆動する)。省略時は
   * cfg から通常どおり解決する(本番経路は常に省略) */
  agenticAdapterOverride?: AiAdapter;
}

export class StructuralObservationProvider implements ObservationProvider {
  private readonly loopCfg: PlanLoopCfg;

  constructor(loopCfg: PlanLoopCfg) {
    this.loopCfg = loopCfg;
  }

  async observe(dir: string, cfg: Config): Promise<ObservationInput> {
    const proj = describeJson(dir, cfg);
    const diskAssertions = readAssertionsIfAny(dir);
    const spec = deriveLoopAssertions(this.loopCfg, diskAssertions);
    return { proj, outcomes: evaluateStructural(proj, spec), warnings: [] };
  }
}

export class VisualSecondaryPlanObservationProvider implements ObservationProvider {
  private readonly structural: ObservationProvider;
  private readonly secondaryCfg: PlanSecondaryObservationCfg;
  private readonly secondaryProvider: SecondaryObservationProvider;
  private callCount = 0;
  private previousProjection: DescribeProjection | null = null;

  constructor(
    loopCfg: PlanLoopCfg,
    secondaryCfg: PlanSecondaryObservationCfg,
    secondaryProvider: SecondaryObservationProvider = new VlmSecondaryObservationProvider(),
  ) {
    this.structural = new StructuralObservationProvider(loopCfg);
    this.secondaryCfg = secondaryCfg;
    this.secondaryProvider = secondaryProvider;
  }

  async observe(dir: string, cfg: Config): Promise<ObservationInput> {
    const primary = await this.structural.observe(dir, cfg);
    const warnings = [...primary.warnings];
    if (!this.secondaryCfg.enabled) {
      this.previousProjection = primary.proj;
      return { ...primary, warnings };
    }
    if (this.callCount >= this.secondaryCfg.maxCalls) {
      warnings.push("secondary observation は call budget 上限のためスキップしました");
      this.previousProjection = primary.proj;
      return { ...primary, warnings };
    }
    const times = selectPlanLoopReviewTimes({
      projection: primary.proj,
      previousProjection: this.previousProjection,
      limit: this.secondaryCfg.maxImages,
    });
    this.previousProjection = primary.proj;
    if (times.length === 0) {
      return { ...primary, warnings };
    }
    try {
      const shots = await frames(dir, { mode: "times", times, axis: "source" }, cfg);
      this.callCount += 1;
      const secondary = await this.secondaryProvider.observe({
        frames: shots.slice(0, this.secondaryCfg.maxImages).map((shot) => ({
          frameId: reviewFrameId({
            side: "after",
            sourceSec: shot.requested,
            outSec: shot.outSec,
            reason: shot.note ?? "plan-loop",
          }),
          side: "after",
          file: shot.file,
          mediaType: "image/png",
          sourceSec: shot.requested,
          outputSec: shot.outSec,
          reason: shot.note ?? "plan-loop",
        })),
        primary: deterministicObservationFromLoop(primary),
        task: {},
        budget: {
          maxImages: this.secondaryCfg.maxImages,
          maxOutputTokens: MAX_SECONDARY_OUTPUT_TOKENS,
        },
      }, cfg);
      return { ...primary, secondary, warnings };
    } catch (error) {
      warnings.push(`secondary observation に失敗しました: ${(error as Error).message}`);
      return { ...primary, warnings };
    }
  }
}

function deterministicObservationFromLoop(input: ObservationInput): DeterministicReviewObservation {
  const side: SideObservation = {
    durationSec: input.proj.summary.outDurationSec,
    keepCount: input.proj.summary.keepCount,
    cutCount: input.proj.cuts.length,
    captionCount: input.proj.summary.captionCount ?? 0,
    visibleCaptionTexts: [],
  };
  const checks: ReviewCheck[] = input.outcomes.map((outcome, index) => ({
    id: `assert-${index}`,
    status:
      outcome.status === "pass" || outcome.status === "skip"
        ? outcome.status
        : outcome.status === "fail"
          ? "warn"
          : "warn",
    message: outcome.message,
    source: "structure",
  }));
  return {
    before: side,
    after: side,
    delta: { durationSec: 0, keepCount: 0, cutCount: 0, captionCount: 0 },
    checks,
  };
}

/**
 * LLM で意味的なカット判断(言い直し・脱線)と章立て・タイトル案を作る。
 *
 * LLM に渡すのは detect が出した「残す候補区間」に番号を付けたリストで、
 * LLM は番号単位で cut/keep を判断する。タイムスタンプそのものを LLM に
 * 生成させると数値のでっち上げ(ハルシネーション)が起きるため、
 * 時刻は必ずこちらで管理し、LLM には選択だけをさせる。
 *
 * 出力の cutplan.json は人間が確認・編集して approved を true にするまで
 * render には進めない(見せ場の誤カットを防ぐ承認ゲート)。
 *
 * `opts.cutsOnly` を指定すると、カット判断だけを LLM に求め、
 * cutplan.json / plan.raw.txt だけを書く(chapters / meta / transcript の
 * 章テロップ / overlays の章トラック定義には触らない)。
 */
export async function plan(
  dir: string,
  cfg: Config,
  opts: PlanOptions = {},
  deps: PlanDeps = {},
): Promise<CutPlan> {
  const transcript = readStageJson<Transcript>(
    join(dir, "transcript.json"),
    "transcribe",
  );
  const auto = readStageJson<AutoCuts>(join(dir, "cuts.auto.json"), "detect");

  // 残す候補区間ごとに、重なる文字起こしテキストをまとめて番号を振る。
  // candidates.enabled 時は語境界で細分化した格子+語ベーステキストに
  // 差し替える(C1/C7/C8。§docs/plans/2026-07-11-c1-word-candidate-grid-design.md)
  const cc = resolveCandidatesCfg(cfg);
  const numbered = cc.enabled
    ? numberSegmentsWords(subdivideCandidates(auto.keepSegments, transcript, cc), transcript)
    : numberSegments(auto.keepSegments, transcript);
  if (numbered.length === 0) {
    throw new Error("残す候補区間が0件です(detect の結果を確認してください)");
  }

  // id が有効なプロジェクトでのみ既存 id を運ぶ(§buildIdContext)。
  // 上書き前(cutplan.json 等を読むだけ)に一度だけ判定する
  const idCtx = buildIdContext(dir);

  const templateFile = opts.cutsOnly ? "plan-cuts.md" : "plan.md";
  const pc = resolvePerceptionCfg(cfg);
  const audio = pc.audio ? computeAudioFeatures(numbered, auto.silences) : null;
  // ocr/cursor 経路のみ manifest.json を読む(audio だけなら manifest は不要)。
  // stills は映像ストリームを持たないため ffmpeg の静止画抽出を試みない。
  let manifestForPerception: Manifest | null = null;
  let ocr: Awaited<ReturnType<typeof computeSegmentOcr>> | null = null;
  if (pc.ocr) {
    manifestForPerception ??= readStageJson<Manifest>(join(dir, "manifest.json"), "ingest");
    if (manifestForPerception.layout === "stills") {
      console.warn(
        '警告: 映像なしプロジェクト(layout:"stills")のため plan.perception.ocr はスキップします',
      );
    } else {
      ocr = await computeSegmentOcr(
        dir,
        manifestForPerception,
        numbered,
        { ocrMaxSegments: pc.ocrMaxSegments, ocrMaxLines: pc.ocrMaxLines, languages: cfg.ocr?.languages },
        (msg) => console.warn(`警告: ${msg}`),
      );
    }
  }
  // システム音声の発話(transcript.system.json)を各区間へ帰属(§D7)。
  // systemSpeech オフ or ファイル不在なら null=従来出力とバイト等価
  const sysT = pc.systemSpeech ? loadSystemTranscript(dir) : null;
  const system = sysT ? computeSystemSpeech(numbered, sysT.segments) : null;
  // カーソル操作(video-perception-P3)。cursor オフなら fs を一切触らず
  // null=従来出力とバイト等価(§2.5)。サイドカー不在は異常ではないので
  // 警告は出さないが、cursor:true なのに不在のときだけ情報ログを1行出す(§2.6)。
  // remeta には配線しない(§2.5。docs/decisions.md 参照)
  let cursor: ReturnType<typeof computeCursorFeatures> | null = null;
  if (pc.cursor) {
    manifestForPerception ??= readStageJson<Manifest>(join(dir, "manifest.json"), "ingest");
    const sidecar = readCursorSidecar(dir, manifestForPerception);
    if (sidecar) {
      cursor = computeCursorFeatures(numbered, sidecar.samples, pc.cursorOptions);
    } else {
      console.log(
        "plan.perception.cursor は有効ですが cursor サイドカー(<recording base>.cursor.json)が見つからないため注入をスキップします",
      );
    }
  }
  const perception = renderPerceptionBlock(audio, system, ocr, cursor);
  const completeFn = deps.complete ?? completeStructuredPlan;

  // SD-T4(既定 off): enabled のときだけ channel の style profile を読み、
  // compact policy を prompt へ添える(§2.6.2)。off なら loadStyleProfileForPlan
  // 自体を呼ばず(fs を触らず)renderStyleProfileBlock(null, false) → ""=バイト等価
  const spc = resolveStyleProfileCfg(cfg);
  const styleProf = spc.enabled
    ? loadStyleProfileForPlan(dir, spc.profile, (m) => console.warn(`警告: ${m}`))
    : null;
  const styleProfileBlock = renderStyleProfileBlock(styleProf, spc.enabled);

  // plan.reasonIds(既定 off。§4.2/穴A): カット判断を行う3経路全部
  // (本編 plan・単発 plan --cuts-only・ループ iter0/critique)に配線する。
  // off なら両ブロックとも "" =バイト等価
  const rc = resolveReasonIdsCfg(cfg, (m) => console.warn(`警告: ${m}`));
  const reasonIdsBlock = renderReasonIdsBlock(rc.enabled, rc.pattern);
  const reasonIdsOutputBlock = renderReasonIdsOutputBlock(rc.enabled);

  if (opts.cutsOnly) {
    // H1/H2(plan.harness。既定 off): agentic 有効時だけ per-iteration complete()
    // を tool+検証ループ(agenticCutTurn)へ差し替える。off の間はこの分岐に
    // 一切入らず、既存の単発/push ループ経路とバイト等価(§SD4design 1-1)
    const harnessOn = planHarnessEnabled(cfg);
    if (cfg.plan?.harness?.agentic && !harnessOn) {
      console.warn(
        "警告: plan.harness.agentic が有効ですが、AI アダプタが tool-use(completeAgentic) に対応していません。従来の単発/pushループ経路にフォールバックします",
      );
    }
    if (planLoopEnabled(cfg) || harnessOn) {
      return runCutsLoop({
        dir,
        cfg,
        numbered,
        durationSec: auto.originalDurationSec,
        perception,
        styleProfile: styleProfileBlock,
        reasonIdsBlock,
        reasonIdsOutputBlock,
        idCtx,
        harness: harnessOn,
        agenticAdapterOverride: deps.agenticAdapterOverride,
        words: collectWords(transcript),
        complete: deps.complete ?? completeStructuredCuts,
        observe:
          deps.observe ??
          (opts.withVlm
            ? new VisualSecondaryPlanObservationProvider(
                resolvePlanLoopCfg(cfg),
                resolvePlanLoopSecondaryObservationCfg(cfg),
                deps.secondaryProvider,
              )
            : undefined),
      });
    }
    return generateCutsOnce(
      dir,
      cfg,
      numbered,
      auto.originalDurationSec,
      perception,
      deps.complete ?? completeStructuredCuts,
      idCtx,
      styleProfileBlock,
      reasonIdsBlock,
      reasonIdsOutputBlock,
    );
  }

  const prompt = renderPrompt(
    dir,
    templateFile,
    numbered,
    auto.originalDurationSec,
    perception,
    buildEditModeCfg(cfg),
    styleProfileBlock,
    reasonIdsBlock,
    reasonIdsOutputBlock,
  );
  const raw = await completeFn(prompt, cfg);
  // LLM の生応答は必ず残す(パース失敗時の調査と、判断過程の記録のため)
  writeFileSync(join(dir, "plan.raw.txt"), raw);

  const parsed = parseResponse(raw);
  // config が false のときは keeps を渡さない(§4.4・I3 と同じ明示ゲート。
  // generateCutsOnce と対称)
  const keeps = rc.enabled ? parsed.keeps : undefined;
  const cutplan = buildCutplan(
    numbered,
    parsed.cuts,
    idCtx && { existingSegments: idCtx.existingCutplanSegments, used: idCtx.used },
    { duration: auto.originalDurationSec, reason: cfg.detect?.silenceCutReason },
    keeps,
  );
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(cutplan, null, 2));
  writeFirstPlan(
    dir,
    buildFirstPlan({
      source: "plan",
      reasonIdsEnabled: rc.enabled,
      pattern: rc.pattern,
      numbered,
      cuts: parsed.cuts,
      keeps,
    }),
  );

  writeChaptersAndMeta(dir, transcript, numbered, parsed, cfg, idCtx && { used: idCtx.used });

  return cutplan;
}

const cutplanIdCtx = toCutplanIdContext;

async function generateCutsOnce(
  dir: string,
  cfg: Config,
  numbered: NumberedSegment[],
  durationSec: number,
  perception: string,
  completeFn: CompleteFn,
  idCtx?: { used: Set<string>; existingCutplanSegments: PlanSegment[] },
  styleProfile: string = "",
  reasonIds: string = "",
  reasonIdsOutput: string = "",
): Promise<CutPlan> {
  const prompt = renderPrompt(
    dir,
    "plan-cuts.md",
    numbered,
    durationSec,
    perception,
    buildEditModeCfg(cfg),
    styleProfile,
    reasonIds,
    reasonIdsOutput,
  );
  const raw = await completeFn(prompt, cfg);
  // LLM の生応答は必ず残す(パース失敗時の調査と、判断過程の記録のため)
  writeFileSync(join(dir, "plan.raw.txt"), raw);
  const parsed = parseCutsResponse(raw);
  const rc = resolveReasonIdsCfg(cfg);
  // config が false のときは keeps を渡さない(§4.4・I3。プロンプトが依頼して
  // いない環境で LLM が誤って keeps を返しても無視する明示的なゲート)
  const keeps = rc.enabled ? parsed.keeps : undefined;
  const cutplan = buildCutplan(
    numbered,
    parsed.cuts,
    cutplanIdCtx(idCtx),
    { duration: durationSec, reason: cfg.detect?.silenceCutReason },
    keeps,
  );
  writeFileSync(join(dir, "cutplan.json"), JSON.stringify(cutplan, null, 2));
  writeFirstPlan(
    dir,
    buildFirstPlan({
      source: "plan --cuts-only",
      reasonIdsEnabled: rc.enabled,
      pattern: rc.pattern,
      numbered,
      cuts: parsed.cuts,
      keeps,
    }),
  );
  return cutplan;
}

interface RunCutsLoopArgs {
  dir: string;
  cfg: Config;
  numbered: NumberedSegment[];
  durationSec: number;
  perception: string;
  /** SD-T4 compact style policy block(§2.5.5)。iter===0(generate)の
   * renderPrompt にだけ渡す(critique 反復には渡さない。§2.6.3・§1.5 defer) */
  styleProfile: string;
  /** plan.reasonIds(§穴A・P3-3)。styleProfile と違い iter0 の生成プロンプトと
   * critique の再調整プロンプトの両方に渡す(分類語彙は反復全体で一貫させたい
   * ため。styleProfile の「generate だけ」制限とは意図的に異なる)。off なら
   * 両方とも "" =バイト等価 */
  reasonIdsBlock: string;
  reasonIdsOutputBlock: string;
  idCtx?: { used: Set<string>; existingCutplanSegments: PlanSegment[] };
  complete: CompleteFn;
  observe?: ObservationProvider;
  /** true のとき per-iteration の complete() を agenticCutTurn(tool+検証
   * ループ)へ差し替える(H1/H2)。false(既定)は従来どおり args.complete を
   * 呼ぶだけで、生成プロンプト・cutplan は導入前とバイト等価(§SD4design 1-1) */
  harness?: boolean;
  /** テスト専用。agenticCutTurn へそのまま渡す(§PlanDeps.agenticAdapterOverride) */
  agenticAdapterOverride?: AiAdapter;
  /** transcript 全体の語タイムスタンプ(collectWords 済み)。H6(applySplit)の
   * list_words/split_candidate と、ターン確定時の applyCandidateSplits で使う。
   * applySplit off のときは常に空配列で渡されるため実質未使用 */
  words: WordTiming[];
}

interface PlanLoopLogEntry {
  iter: number;
  kind: "generate" | "critique";
  raw: string;
  cuts: LoopCut[];
  observation: string;
  stop: string | null;
  secondaryObservation?: {
    kind: "vlm";
    confidence: "low" | "medium" | "high";
    itemCount: number;
    inputDigest: string;
    profile: string;
    model: string;
  };
  secondaryWarnings?: string[];
  /** agentic ループ(plan.harness.agentic)の tool 往復トレース(中間生成物)。
   * harness off のときは常に undefined(キー自体を書かない=バイト等価) */
  agenticTrace?: AgenticTraceEntry[];
  /** agentic がフォールバックした理由(あれば)。null/undefined=完走 */
  agenticDegraded?: string;
  /** H6(plan.harness.applySplit)の split_candidate 試行ログ(中間生成物・
   * ダイジェストのみ)。applySplit off、またはこの反復で split_candidate が
   * 一度も呼ばれなければ undefined(キーを書かない=バイト等価) */
  splitOps?: SplitTraceEntry[];
}

async function runCutsLoop(args: RunCutsLoopArgs): Promise<CutPlan> {
  const baseLoopCfg = resolvePlanLoopCfg(args.cfg);
  // harness on だが loop 未設定(maxIterations<2)のときは、agentic の
  // 検証往復が最低1回の再調整を持てるよう maxIterations を 2 へ昇格させる
  // (§SD4design D「harness on だが loop 未設定のとき」)。harness off なら
  // baseLoopCfg のまま(バイト等価)
  const loopCfg: PlanLoopCfg = args.harness
    ? { ...baseLoopCfg, maxIterations: Math.max(2, baseLoopCfg.maxIterations) }
    : baseLoopCfg;
  const observer = args.observe ?? new StructuralObservationProvider(loopCfg);
  const harnessCfg = resolvePlanHarnessCfg(args.cfg);
  // H6(applySplit)の minCandidateSec は既存 candidates.minCandidateSec を再利用
  // (新しい設定キーは足さない・§SD5design §3 の change table どおり)
  const splitCfg: CandidateSplitCfg = { minCandidateSec: resolveCandidatesCfg(args.cfg).minCandidateSec };
  const iterations: PlanLoopLogEntry[] = [];
  let prevCuts: LoopCut[] | null = null;
  let prevObservation = "";
  let raw = "";
  let lastCutplan: CutPlan | null = null;
  // 確定済み分割(SplitOp[])はターンを跨いで蓄積する(§SD5design §2.4「ターンを
  // 跨ぐ」)。harness off のときは常に空のまま=applyCandidateSplits は恒等(§1-1)
  let splits: SplitOp[] = [];

  for (let iter = 0; iter < loopCfg.maxIterations; iter++) {
    const kind = iter === 0 ? "generate" : "critique";
    const editModeCfg = buildEditModeCfg(args.cfg);
    const prompt = iter === 0
      ? renderPrompt(
          args.dir,
          "plan-cuts.md",
          args.numbered,
          args.durationSec,
          args.perception,
          editModeCfg,
          args.styleProfile,
          args.reasonIdsBlock,
          args.reasonIdsOutputBlock,
        )
      : renderCritiquePrompt(
          args.dir,
          args.numbered,
          args.durationSec,
          args.perception,
          prevObservation,
          prevCuts ?? [],
          editModeCfg,
          args.reasonIdsBlock,
          args.reasonIdsOutputBlock,
        );

    let cuts: LoopCut[];
    let agenticTrace: AgenticTraceEntry[] | undefined;
    let agenticDegraded: string | undefined;
    let splitOpsThisIter: SplitTraceEntry[] | undefined;
    if (args.harness) {
      const ctx: AgenticCtx = {
        dir: args.dir,
        cfg: args.cfg,
        numbered: args.numbered,
        durationSec: args.durationSec,
        idCtx: args.idCtx,
        budget: { maxToolCalls: harnessCfg.maxToolCalls, used: 0 },
        warn: (msg) => console.warn(`警告: ${msg}`),
        trace: [],
        toolsEnabled: harnessCfg.tools,
        applySplit: harnessCfg.applySplit,
        maxSplits: harnessCfg.maxSplits,
        splits,
        splitTrace: [],
        words: args.words,
      };
      const result = await agenticCutTurn({
        firstPrompt: prompt,
        ctx,
        adapterOverride: args.agenticAdapterOverride,
      });
      raw = result.raw;
      cuts = result.cuts;
      agenticTrace = result.trace;
      agenticDegraded = result.degraded ?? undefined;
      splits = result.splits;
      splitOpsThisIter = result.splitTrace;
    } else {
      raw = await args.complete(prompt, args.cfg);
      cuts = parseCutsResponse(raw).cuts;
    }
    // §2.4「ターン確定時の最終 cutplan も同じ式」: splits が空(applySplit off)
    // なら applyCandidateSplits は base をそのまま返す恒等関数(§1-1 バイト等価の要)
    const base = buildCutplan(args.numbered, cuts, cutplanIdCtx(args.idCtx), {
      duration: args.durationSec,
      reason: args.cfg.detect?.silenceCutReason,
    });
    lastCutplan = applyCandidateSplits(base, splits, args.words, splitCfg, args.idCtx && { used: args.idCtx.used });
    writeFileSync(join(args.dir, "cutplan.json"), JSON.stringify(lastCutplan, null, 2));

    // plan.first.json は iter0(generate)の parse 直後のみ書く(§5.2)。
    // harness/非harness どちらでも raw は生応答テキストなので、keeps だけ
    // 追加で拾うために同じ raw をもう一度パースする(副作用なし・純関数)
    if (iter === 0) {
      const rc0 = resolveReasonIdsCfg(args.cfg);
      writeFirstPlan(
        args.dir,
        buildFirstPlan({
          source: "plan --cuts-only",
          reasonIdsEnabled: rc0.enabled,
          pattern: rc0.pattern,
          numbered: args.numbered,
          cuts,
          keeps: parseCutsResponse(raw).keeps,
        }),
      );
    }

    const observed = await observer.observe(args.dir, args.cfg);
    const obs: ObservationInput = {
      ...observed,
      warnings: observed.warnings ?? [],
    };
    const observation = summarizeObservation(obs.proj, obs.outcomes, cuts, loopCfg, obs.secondary);
    const decision = shouldStop({
      iteration: iter,
      maxIterations: loopCfg.maxIterations,
      loopCfg,
      outcomes: obs.outcomes,
      prevCuts,
      cuts,
    });
    iterations.push({
      iter,
      kind,
      raw,
      cuts,
      observation,
      stop: decision.reason,
      ...(agenticTrace ? { agenticTrace } : {}),
      ...(agenticDegraded ? { agenticDegraded } : {}),
      ...(splitOpsThisIter && splitOpsThisIter.length > 0 ? { splitOps: splitOpsThisIter } : {}),
      ...(obs.secondary
        ? {
            secondaryObservation: {
              kind: "vlm",
              confidence: obs.secondary.confidence,
              itemCount: obs.secondary.items.length,
              inputDigest: obs.secondary.provenance.inputDigest,
              profile: obs.secondary.provenance.profile,
              model: obs.secondary.provenance.model,
            },
          }
        : {}),
      ...(obs.warnings.length > 0 ? { secondaryWarnings: obs.warnings } : {}),
    });
    prevCuts = cuts;
    prevObservation = observation;
    if (decision.stop) break;
  }

  if (lastCutplan === null) {
    throw new Error("plan.loop.maxIterations が不正です(maxIterations >= 2 が必要です)");
  }
  writeFileSync(join(args.dir, "plan.raw.txt"), raw);
  writeFileSync(
    join(args.dir, "plan.loop.json"),
    JSON.stringify({ schemaVersion: 1, iterations }, null, 2),
  );
  return lastCutplan;
}

/**
 * 章立て・タイトル案・概要欄だけを作り直す(cutplan.json は触らない)。
 *
 * plan と違い、カット判断はすでに終わっている前提で、**現在の cutplan の
 * keep 区間**(=完成動画の中身)を LLM に見せて章・タイトル・概要欄だけを
 * 生成する。「カットは手編集済みだがタイトル案だけ作り直したい」ケース用。
 * cutplan.json は読むだけで書き換えないので、カットの手編集は保たれる。
 */
export async function remeta(dir: string, cfg: Config): Promise<Meta> {
  const transcript = readStageJson<Transcript>(
    join(dir, "transcript.json"),
    "transcribe",
  );
  const cutplan = readStageJson<CutPlan>(join(dir, "cutplan.json"), "plan");
  const manifest = readStageJson<{ durationSec: number }>(
    join(dir, "manifest.json"),
    "ingest",
  );

  // 完成動画の中身 = cutplan の keep 区間(割れている keep は繋いで扱う)
  const keeps = mergeIntervals(cutplan.segments.filter((s) => s.action === "keep"));
  const numbered = numberSegments(keeps, transcript);
  if (numbered.length === 0) {
    throw new Error("keep 区間が0件です(cutplan.json を確認してください)");
  }

  // id が有効なプロジェクトでのみ既存 id を運ぶ(§buildIdContext)。remeta は
  // cutplan.segments を書かないため existingCutplanSegments は使わない
  const idCtx = buildIdContext(dir);

  // remeta は現状 cuts.auto.json を読んでいない。pc.audio が真のときだけ読み、
  // 無ければ(旧収録・detect 未実行等)audio=null に劣化する(バイト等価)
  const pc = resolvePerceptionCfg(cfg);
  const autoPath = join(dir, "cuts.auto.json");
  const audio =
    pc.audio && existsSync(autoPath)
      ? computeAudioFeatures(
          numbered,
          (JSON.parse(readFileSync(autoPath, "utf8")) as AutoCuts).silences,
        )
      : null;
  const sysT = pc.systemSpeech ? loadSystemTranscript(dir) : null;
  const system = sysT ? computeSystemSpeech(numbered, sysT.segments) : null;
  const perception = renderPerceptionBlock(audio, system, null);

  const prompt = renderPrompt(dir, "meta.md", numbered, manifest.durationSec, perception);
  const raw = await completeStructuredPlan(prompt, cfg);
  writeFileSync(join(dir, "plan.raw.txt"), raw);

  const parsed = parseResponse(raw);
  return writeChaptersAndMeta(dir, transcript, numbered, parsed, cfg, idCtx && { used: idCtx.used });
}

/** writeChaptersAndMeta / writeChapterTelops の id 引き継ぎ用コンテキスト。
 * 省略時(undefined)は id に一切触れない */
export interface ChaptersIdContext {
  used: Set<string>;
}

/**
 * LLM 応答の章の配列を組み立てる純関数(fs 非依存)。idCtx があれば、
 * title 一致(trim 後)で旧 chapters.chapters の id を運び(carryIds)、
 * 残りを採番する(ensureIds)。
 */
export function buildChapterEntries(
  parsedChapters: { startId: number; title: string }[],
  numbered: NumberedSegment[],
  existingChapters: Chapters["chapters"],
  idCtx?: ChaptersIdContext,
): Chapters["chapters"] {
  let entries: Chapters["chapters"] = parsedChapters
    .map((c) => {
      const seg = numbered.find((n) => n.id === c.startId);
      if (!seg) {
        console.warn(
          `警告: 章「${c.title}」の開始区間 id=${c.startId} が存在しません(無視します)`,
        );
        return null;
      }
      return { start: seg.start, title: c.title };
    })
    .filter((c): c is Chapters["chapters"][number] => c !== null);

  if (idCtx) {
    entries = carryIds(existingChapters, entries, (c) => c.title.trim());
    entries = ensureIds(entries, ID_PREFIX.chapter, idCtx.used);
  }
  return entries;
}

/**
 * LLM 応答の章・タイトル・概要欄を chapters.json / meta.json と「章」トラックの
 * テロップ(transcript.json)へ書き出す。plan と remeta で共有する。
 */
function writeChaptersAndMeta(
  dir: string,
  transcript: Transcript,
  numbered: NumberedSegment[],
  parsed: PlanResponse,
  cfg: Config,
  idCtx?: ChaptersIdContext,
): Meta {
  if (cfg.plan?.chapters) {
    const chaptersPath = join(dir, "chapters.json");
    const existingChapters: Chapters["chapters"] = existsSync(chaptersPath)
      ? ((JSON.parse(readFileSync(chaptersPath, "utf8")) as Chapters).chapters ?? [])
      : [];
    const chapters: Chapters = {
      chapters: buildChapterEntries(parsed.chapters, numbered, existingChapters, idCtx),
    };
    writeFileSync(chaptersPath, JSON.stringify(chapters, null, 2));
    writeChapterTelops(dir, transcript, chapters, cfg, idCtx);
  }

  const meta: Meta = { titles: parsed.titles, description: parsed.description };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * 章タイトルを通常テロップとして transcript.json に書く。章は描画上も編集上も
 * ただのテロップで、chapters.json は YouTube チャプター用のメタデータとして
 * だけ残る。テロップは「章」という名前の専用テロップトラックに置き、
 * トラックの標準位置を左上(旧・章カードの位置)にする(overlays.json)。
 * plan を再実行したときは、このトラックのテロップだけを作り直す
 * (他のトラックのテロップ手編集は保たれる)。
 */
/**
 * 章トラックのテロップ配列を組み立てる純関数(fs 非依存)。idCtx があれば、
 * title 一致(trim 後)で旧「章」トラックのテロップの id を運び(carryIds)、
 * 残りを採番する(ensureIds)。
 */
export function buildChapterTelopEntries(
  chapters: Chapters,
  track: number,
  chapterCardSec: number,
  existingTelops: TranscriptSegment[],
  idCtx?: ChaptersIdContext,
): TranscriptSegment[] {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let telops: TranscriptSegment[] = chapters.chapters.map((c) => ({
    start: c.start,
    end: round2(c.start + chapterCardSec),
    text: c.title,
    track,
  }));
  if (idCtx) {
    telops = carryIds(existingTelops, telops, (s) => s.text.trim());
    telops = ensureIds(telops, ID_PREFIX.caption, idCtx.used);
  }
  return telops;
}

function writeChapterTelops(
  dir: string,
  transcript: Transcript,
  chapters: Chapters,
  cfg: Config,
  idCtx?: ChaptersIdContext,
): void {
  const overlaysPath = join(dir, "overlays.json");
  const overlays: Overlays = existsSync(overlaysPath)
    ? (JSON.parse(readFileSync(overlaysPath, "utf8")) as Overlays)
    : {};
  const tracks = overlays.captionTracks ?? [];
  let def = tracks.find((t) => t.name === "章");
  if (!def) {
    const track =
      Math.max(
        1,
        ...transcript.segments.map(captionTrack),
        ...tracks.map((t) => t.track),
      ) + 1;
    def = {
      track,
      name: "章",
      x: cfg.render.wipeMarginPx,
      y: cfg.render.wipeMarginPx,
      anchor: "topLeft",
    };
    overlays.captionTracks = [...tracks, def];
    writeFileSync(overlaysPath, JSON.stringify(overlays, null, 2));
  }
  const track = def.track;
  const existingTelops = transcript.segments.filter((s) => captionTrack(s) === track);
  const telops = buildChapterTelopEntries(
    chapters,
    track,
    cfg.render.chapterCardSec,
    existingTelops,
    idCtx,
  );
  const segments = [
    ...transcript.segments.filter((s) => captionTrack(s) !== track),
    ...telops,
  ].sort((a, b) => a.start - b.start);
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({ ...transcript, segments }, null, 2),
  );
}

/** LLM 応答の期待スキーマ(prompts/plan.md の出力形式と対応) */
interface PlanResponse {
  cuts: { id: number; reason: string; reasonId?: string }[];
  /** 切る誘惑があったが残した区間だけを LLM に列挙させたもの(§5・§穴A P3-3)。
   * plan.reasonIds.enabled: true のときだけプロンプトが依頼する。省略時 undefined
   * (キー自体が無い応答からは undefined のまま=バイト等価・sticky) */
  keeps?: { id: number; reason: string; reasonId: string }[];
  chapters: { startId: number; title: string }[];
  titles: string[];
  description: string;
}

/**
 * channel(このシリーズ全体)/ recording(この収録だけ)の rules 本文を受け、
 * プロンプトへ注入する1ブロックを返す純関数(ディスク非依存・テスト対象)。
 *
 * 両方 null/空 → "" を返す(= renderPrompt の出力を rules 不在時と完全一致
 * させるための不変条件の核。呼び出し側はこの値をそのまま {{rules}} に
 * replaceAll するだけでよい)。
 *
 * あるものだけを見出し付きで連結し、返り値には先頭 `\n`・末尾 `\n` を必ず
 * 付ける(テンプレ側の `{{rules}}` は前後を改行で挟まれた1行として置かれる
 * ため)。両方あるときだけ「チャンネル共通」「この収録だけ」の2小見出しに
 * 分け、収録固有が優先される旨を注記する。
 */
export function renderRulesBlock(
  channel: string | null,
  recording: string | null,
): string {
  const c = channel?.trim() || null;
  const r = recording?.trim() || null;
  if (!c && !r) return "";

  const parts: string[] = ["## チャンネル方針(このシリーズの恒久的な編集ルール)"];
  if (c && r) {
    parts.push(`### 全収録共通のルール\n\n${c}`);
    parts.push(`### この収録だけのルール\n\n${r}`);
    parts.push("※ 収録固有の指示が共通ルールと矛盾する場合は収録固有を優先");
  } else if (c) {
    parts.push(c);
  } else {
    parts.push(`### この収録だけのルール\n\n${r}`);
  }
  return `\n${parts.join("\n\n")}\n`;
}

/** channel(=収録フォルダの親)と収録固有の rules.md を読んで連結する
 * (非純粋な薄いラッパ。純関数本体は renderRulesBlock)。
 * planMaterials.ts の renderMaterialsPrompt が rules 注入で再利用する */
export function readRules(dir: string): string {
  const channelPath = join(dirname(dir), "rules.md");
  const recordingPath = join(dir, "rules.md");
  const channel = existsSync(channelPath) ? readFileSync(channelPath, "utf8").trim() : null;
  const recording = existsSync(recordingPath)
    ? readFileSync(recordingPath, "utf8").trim()
    : null;
  return renderRulesBlock(channel || null, recording || null);
}

export interface EditModeCfg {
  configMode?: unknown;
  targetOutDurationSec: number | null;
}

/** cfg から実際の editModeCfg を組み立てる(cut 判断を行う経路だけが使う)。
 *  目標尺は plan.loop 設定(反復オフでも単発 plan に surface する)から読む。 */
function buildEditModeCfg(cfg: Config): EditModeCfg {
  return {
    configMode: cfg.plan?.editMode,
    targetOutDurationSec: resolvePlanLoopCfg(cfg).targetOutDurationSec,
  };
}

/** 既定はバイト等価(safe/目標なし)。renderPrompt を editModeCfg 無しで呼ぶ
 *  既存箇所・テストがそのままバイト等価になる(§X4設計書1-1)。 */
const DEFAULT_EDIT_MODE_CFG: EditModeCfg = { configMode: "safe", targetOutDurationSec: null };

export function renderPrompt(
  dir: string,
  templateFile: string,
  numbered: NumberedSegment[],
  durationSec: number,
  perception: string = "",
  editModeCfg: EditModeCfg = DEFAULT_EDIT_MODE_CFG,
  styleProfile: string = "",
  reasonIds: string = "",
  reasonIdsOutput: string = "",
): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const template = readFileSync(join(repoRoot, "prompts", templateFile), "utf8");

  const segmentLines = numbered
    .map(
      (n) =>
        `#${n.id} [${n.start.toFixed(2)}-${n.end.toFixed(2)}] ${n.text || "(発言なし)"}`,
    )
    .join("\n");

  // 収録フォルダに brief.md(企画ブリーフのコピー)があれば見せ場リストとして渡す
  const briefPath = join(dir, "brief.md");
  const brief = existsSync(briefPath)
    ? readFileSync(briefPath, "utf8")
    : "(見せ場リストなし。カット判断基準に従って判断してください)";

  const rules = readRules(dir);

  const mode = resolveEditMode({
    configMode: editModeCfg.configMode,
    rules,
    brief,
    warn: (m) => console.error(`[plan] ${m}`),
  });
  const editModeBlock = renderEditModeBlock(mode, editModeCfg.targetOutDurationSec);

  // replaceAll + 関数形式: 文字列指定の replace は最初の1箇所しか置換されず、
  // また brief に "$&" 等が含まれると置換パターンとして解釈されてしまう
  return template
    .replaceAll("{{segments}}", () => segmentLines)
    .replaceAll("{{duration}}", () => durationSec.toFixed(0))
    .replaceAll("{{brief}}", () => brief)
    .replaceAll("{{rules}}", () => rules)
    .replaceAll("{{perception}}", () => perception)
    .replaceAll("{{styleProfile}}", () => styleProfile)
    .replaceAll("{{reasonIds}}", () => reasonIds)
    .replaceAll("{{reasonIdsOutput}}", () => reasonIdsOutput)
    .replaceAll("{{editMode}}", () => editModeBlock);
}

export function renderCritiquePrompt(
  dir: string,
  numbered: NumberedSegment[],
  durationSec: number,
  perception: string,
  observation: string,
  currentCuts: readonly LoopCut[],
  editModeCfg: EditModeCfg = DEFAULT_EDIT_MODE_CFG,
  reasonIds: string = "",
  reasonIdsOutput: string = "",
): string {
  return renderPrompt(
    dir,
    "plan-cuts-critique.md",
    numbered,
    durationSec,
    perception,
    editModeCfg,
    "",
    reasonIds,
    reasonIdsOutput,
  )
    .replaceAll("{{observation}}", () => observation)
    .replaceAll("{{currentCuts}}", () => renderCurrentCutsBlock(currentCuts));
}

function renderCurrentCutsBlock(currentCuts: readonly LoopCut[]): string {
  if (currentCuts.length === 0) return "なし";
  return currentCuts.map((c) => `#${c.id} ${c.reason}`).join("\n");
}

function parseResponse(raw: string): PlanResponse {
  const parsed = extractJsonObject(raw) as Partial<PlanResponse>;
  const result: PlanResponse = {
    cuts: parsed.cuts ?? [],
    chapters: parsed.chapters ?? [],
    titles: parsed.titles ?? [],
    description: parsed.description ?? "",
  };
  // keeps はキーが応答に存在するときだけ載せる(§4.4・I3 と同じ sticky。
  // 省略時 undefined のまま=導入前とバイト等価)
  if (parsed.keeps !== undefined) result.keeps = parsed.keeps;
  return result;
}

function readStageJson<T>(path: string, requiredStage: string): T {
  if (!existsSync(path)) {
    throw new Error(
      `${path} がありません。先に ${requiredStage} を実行してください`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readAssertionsIfAny(dir: string): AssertionsDoc | null {
  const p = join(dir, "assertions.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as AssertionsDoc;
}

export const PLAN_RESPONSE_SCHEMA = {
  name: "framewright_plan_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["cuts", "chapters", "titles", "description"],
    properties: {
      cuts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "reason"],
          properties: {
            id: { type: "integer" },
            reason: { type: "string" },
          },
        },
      },
      chapters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["startId", "title"],
          properties: {
            startId: { type: "integer" },
            title: { type: "string" },
          },
        },
      },
      titles: { type: "array", items: { type: "string" } },
      description: { type: "string" },
    },
  },
} as const;

/** plan.reasonIds.enabled: true のときだけ使う変種(§穴B・P3-1)。
 * cutsResponse.ts の CUTS_RESPONSE_SCHEMA_REASON_IDS と同型: cuts.items に
 * 任意の reasonId、トップに任意の keeps を足す。strict:false の理由・
 * 非対称の意図は cutsResponse.ts のコメントと同じ。 */
export const PLAN_RESPONSE_SCHEMA_REASON_IDS = {
  name: "framewright_plan_response_reason_ids",
  strict: false,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["cuts", "chapters", "titles", "description"],
    properties: {
      cuts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "reason"],
          properties: {
            id: { type: "integer" },
            reason: { type: "string" },
            reasonId: { type: "string" },
          },
        },
      },
      keeps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "reasonId", "reason"],
          properties: {
            id: { type: "integer" },
            reasonId: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
      chapters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["startId", "title"],
          properties: {
            startId: { type: "integer" },
            title: { type: "string" },
          },
        },
      },
      titles: { type: "array", items: { type: "string" } },
      description: { type: "string" },
    },
  },
} as const;

/** off(既定)は旧オブジェクトそのもの(参照同一性。I4) */
export function planResponseSchema(
  reasonIdsEnabled: boolean,
): typeof PLAN_RESPONSE_SCHEMA | typeof PLAN_RESPONSE_SCHEMA_REASON_IDS {
  return reasonIdsEnabled ? PLAN_RESPONSE_SCHEMA_REASON_IDS : PLAN_RESPONSE_SCHEMA;
}

async function completeStructuredPlan(prompt: string, cfg: Config): Promise<string> {
  return await completeWithJsonSchema(prompt, cfg, planResponseSchema(resolveReasonIdsCfg(cfg).enabled), "plan");
}

async function completeStructuredCuts(prompt: string, cfg: Config): Promise<string> {
  return await completeWithJsonSchema(prompt, cfg, cutsResponseSchema(resolveReasonIdsCfg(cfg).enabled), "plan");
}
