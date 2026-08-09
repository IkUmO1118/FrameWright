// video-perception-P0: シーン駆動サンプリング(frames --scenes)。
// §docs/plans/2026-08-10-video-perception-p0-scene-sampling-design.md
//
// av.probe/motion.json(要 av <dir> の事前実行)の motion[]/frozen[] から、
// 「画面が変化した瞬間」+「静止区間の代表」+「端点」の時刻リストを決定論で
// 選ぶ純関数。frames.ts にも av.ts にも依存しない(motion.json の型と閾値
// だけを引数に取る)。P1 が同じ関数を別の maxShots で呼ぶ想定。
//
// 前提(§2.2.0。誤解すると全体が破綻する):
//   1. motion[] は av.everySec ごとの等間隔バケット。任意時刻の sceneScore は
//      存在しない(motion[] の要素だけが実在する)。
//   2. motion[].sourceSec は必ず keep の内側にある(カット区間の秒は含まれない)。
//   3. motion.json は range(出力秒。av --range で部分測定できる)を持つ。
// → 本関数が返す時刻は motion[] の要素 ∪ frozen[] 由来の点に限る。
//   グリッドの外を自分で作らない。

/** motion.json のうち本関数が使う部分だけ(av.ts の MotionReport の部分型) */
export interface SceneSamplingInput {
  range: { startSec: number; endSec: number };
  motion: { outSec: number; sourceSec: number; sceneScore: number }[];
  frozen: {
    outSec: number;
    endOutSec: number;
    sourceSec: number;
    endSourceSec: number;
    lenSec: number;
  }[];
}

export interface SceneSamplingCfg {
  /** 変化点とみなす sceneScore の下限 */
  sceneThreshold: number;
  /** 変化点をこの間隔未満で連続採用しない */
  minGapSec: number;
  /** 返す時刻の上限 */
  maxShots: number;
  /** 静止区間にこの秒ごとに1枚(§2.2.2 手順4の式) */
  frozenShotEverySec: number;
  /** 1つの静止区間から取る最大枚数 */
  frozenMaxShotsPerSpan: number;
}

/** config.yaml frames.scenes 省略時の既定値(設計書 §2.4 の値そのまま) */
export const DEFAULT_SCENE_SAMPLING_CFG: SceneSamplingCfg = {
  sceneThreshold: 0.25,
  minGapSec: 6.0,
  maxShots: 60,
  frozenShotEverySec: 60,
  frozenMaxShotsPerSpan: 3,
};

export type SceneTimeReason = "edge" | "scene" | "frozen";

export interface SceneTime {
  /** 出力(カット後)秒。小数第2位へ round2 */
  outSec: number;
  /** 元収録秒。小数第2位へ round2 */
  sourceSec: number;
  /** §2.2.3 の規則で決めた値 */
  sceneScore: number;
  reason: SceneTimeReason;
}

export interface SelectSceneTimesResult {
  times: SceneTime[];
  dropped: { scene: number; frozen: number };
}

/** avParse.ts:180 と同一式。avParse の round2 は export されていないので
 * ここへローカル定義する(母艦の規約どおり再実装ではなく同じ式を使う) */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface RawPoint {
  outSec: number;
  sourceSec: number;
  sceneScore: number;
  reason: SceneTimeReason;
}

/**
 * motion[]/frozen[] から「画面変化+静止区間代表+端点」の時刻リストを選ぶ。
 * 手順は設計書 §2.2.2 の 1〜8 のとおり(順序を変えない)。
 */
export function selectSceneTimes(
  input: SceneSamplingInput,
  cfg: SceneSamplingCfg,
): SelectSceneTimesResult {
  // motion[] は outSec 昇順で与えられる前提だが、念のためソートする
  // (§2.2.2 前文。T15 が固定する)
  const motion = [...input.motion].sort((a, b) => a.outSec - b.outSec);

  // 手順1: 端点。motion[] が空なら空配列で終わり(以降の手順は実行しない)
  if (motion.length === 0) {
    return { times: [], dropped: { scene: 0, frozen: 0 } };
  }
  const first = motion[0];
  const last = motion[motion.length - 1];
  const edgePoints: RawPoint[] = [
    { outSec: first.outSec, sourceSec: first.sourceSec, sceneScore: first.sceneScore, reason: "edge" },
    { outSec: last.outSec, sourceSec: last.sourceSec, sceneScore: last.sceneScore, reason: "edge" },
  ];

  // 手順2: 変化点候補(sceneScore >= sceneThreshold)
  const sceneCandidates = motion.filter((m) => m.sceneScore >= cfg.sceneThreshold);

  // 手順3: 近接の間引き。sceneScore 降順(同点は outSec 昇順)に走査し、
  // 既に採用した変化点との outSec 差が minGapSec 未満なら捨てる
  const sortedCandidates = [...sceneCandidates].sort((a, b) => {
    if (b.sceneScore !== a.sceneScore) return b.sceneScore - a.sceneScore;
    return a.outSec - b.outSec;
  });
  const acceptedScenes: RawPoint[] = [];
  for (const cand of sortedCandidates) {
    const tooClose = acceptedScenes.some(
      (p) => Math.abs(p.outSec - cand.outSec) < cfg.minGapSec,
    );
    if (tooClose) continue;
    acceptedScenes.push({
      outSec: cand.outSec,
      sourceSec: cand.sourceSec,
      sceneScore: cand.sceneScore,
      reason: "scene",
    });
  }

  // 手順4〜5: 静止区間の代表。枚数式(§2.2.2 手順4)+ グリッド外の解決(§2.2.3)
  const frozenPoints: RawPoint[] = [];
  for (const span of input.frozen) {
    const shots = Math.min(
      cfg.frozenMaxShotsPerSpan,
      Math.max(1, Math.floor(span.lenSec / cfg.frozenShotEverySec)),
    );
    for (let k = 1; k <= shots; k++) {
      const t = span.outSec + (span.lenSec * k) / (shots + 1);
      frozenPoints.push({
        outSec: t,
        sourceSec: resolveFrozenSourceSec(span, t),
        sceneScore: resolveNearestSceneScore(motion, t),
        reason: "frozen",
      });
    }
  }

  // 手順6: 重複除去。round2(outSec) をキーに、衝突時は edge > frozen > scene
  const priority: Record<SceneTimeReason, number> = { edge: 0, frozen: 1, scene: 2 };
  const byKey = new Map<number, RawPoint>();
  for (const p of [...edgePoints, ...frozenPoints, ...acceptedScenes]) {
    const key = round2(p.outSec);
    const existing = byKey.get(key);
    if (!existing || priority[p.reason] < priority[existing.reason]) {
      byKey.set(key, p);
    }
  }

  // 手順7: 上限の適用(§2.2.4)。dedup 後の集合を reason 別に分けて判定する
  const deduped = [...byKey.values()];
  const protectedPoints = deduped.filter((p) => p.reason === "edge" || p.reason === "frozen");
  const scenePoints = deduped.filter((p) => p.reason === "scene");
  const edgeOnly = deduped.filter((p) => p.reason === "edge");
  const frozenOnly = deduped.filter((p) => p.reason === "frozen");

  let kept: RawPoint[];
  let dropped = { scene: 0, frozen: 0 };

  if (cfg.maxShots < edgeOnly.length) {
    // maxShots < 2(edge は必ず2枚)。設定より不変条件を優先し edge だけ返す
    kept = edgeOnly;
    dropped = { scene: scenePoints.length, frozen: frozenOnly.length };
  } else if (protectedPoints.length + scenePoints.length <= cfg.maxShots) {
    kept = deduped;
  } else if (protectedPoints.length <= cfg.maxShots) {
    const sortedScenes = [...scenePoints].sort((a, b) => {
      if (b.sceneScore !== a.sceneScore) return b.sceneScore - a.sceneScore;
      return a.outSec - b.outSec;
    });
    const keepCount = cfg.maxShots - protectedPoints.length;
    const keptScenes = sortedScenes.slice(0, keepCount);
    dropped = { scene: sortedScenes.length - keptScenes.length, frozen: 0 };
    kept = [...protectedPoints, ...keptScenes];
  } else {
    // protectedPoints.length > maxShots: scenes は全件捨て、frozen を
    // lenSec 降順(同点は outSec 昇順)で maxShots - edge.length 件だけ残す
    const sortedFrozen = [...frozenOnly].sort((a, b) => {
      const lenA = frozenLenOf(input.frozen, a);
      const lenB = frozenLenOf(input.frozen, b);
      if (lenB !== lenA) return lenB - lenA;
      return a.outSec - b.outSec;
    });
    const keepCount = Math.max(0, cfg.maxShots - edgeOnly.length);
    const keptFrozen = sortedFrozen.slice(0, keepCount);
    dropped = {
      scene: scenePoints.length,
      frozen: sortedFrozen.length - keptFrozen.length,
    };
    kept = [...edgeOnly, ...keptFrozen];
  }

  // 手順8: outSec 昇順にソートして返す
  const times: SceneTime[] = kept
    .map((p) => ({
      outSec: round2(p.outSec),
      sourceSec: round2(p.sourceSec),
      sceneScore: p.sceneScore,
      reason: p.reason,
    }))
    .sort((a, b) => a.outSec - b.outSec);

  return { times, dropped };
}

/** frozen 区間内の点 t(出力秒)の元収録秒を線形内挿で求める(§2.2.3)。
 * lenSec === 0 は 0 除算を避けるため sourceSec をそのまま返す */
function resolveFrozenSourceSec(
  span: SceneSamplingInput["frozen"][number],
  t: number,
): number {
  if (span.lenSec === 0) return span.sourceSec;
  const ratio = (t - span.outSec) / span.lenSec;
  return span.sourceSec + (span.endSourceSec - span.sourceSec) * ratio;
}

/** motion[] のうち |outSec - t| が最小の要素の sceneScore を返す。
 * 同値なら outSec が小さいほうを採る(§2.2.3) */
function resolveNearestSceneScore(
  motion: SceneSamplingInput["motion"],
  t: number,
): number {
  let best = motion[0];
  let bestDist = Math.abs(best.outSec - t);
  for (const m of motion) {
    const dist = Math.abs(m.outSec - t);
    if (dist < bestDist || (dist === bestDist && m.outSec < best.outSec)) {
      best = m;
      bestDist = dist;
    }
  }
  return best.sceneScore;
}

/** dedup 後の frozen 点 1 件が、元のどの frozen 区間から来たかを引いて
 * lenSec を返す(上限適用の並び替えで区間の lenSec が要るため)。
 * 複数の frozen 区間が同じ点を生むことは無い(区間は重ならない前提)ので、
 * outSec が区間内([outSec, endOutSec])に収まる最初の区間を採る */
function frozenLenOf(
  frozenSpans: SceneSamplingInput["frozen"],
  point: RawPoint,
): number {
  for (const span of frozenSpans) {
    if (point.outSec >= span.outSec && point.outSec <= span.endOutSec) {
      return span.lenSec;
    }
  }
  return 0;
}
