import {
  conceptsOfTheme, kwLandings, matchPoint, type BodyOf, type ExamPointDef, type Landing, type LandingContext, type PointIndex
} from "./exam-points.js";

/**
  出题前的主题落点判定（方案 v8 第 3 章）。
  三级回退：启用条目命中 -> 概念 kw 直检 -> 零落点拒绝。
  灰区命中只记诊断，既不能救一个主题，也不能进推荐清单。
*/
export interface PointTiers {
  /** 抽检判为启用的条目 id；省略表示全部启用。 */
  enabled?: string[];
  grey?: string[];
  disabled?: string[];
}

export interface ExamPlan {
  /** 1=技能条目命中，2=概念直检（主题未命中词表）。 */
  sourceLevel: 1 | 2;
  concepts: string[];
  /** 命中的技能条目 id；消费侧 pointMatch 用。 */
  pointIds: string[];
  /** 按结构信号降序取前 20 的落点。 */
  landings: Landing[];
  /** 排序后没进前 20 的数量，给模型/抽检看。 */
  remaining: number;
  /** 段 1 的推荐考点清单（第 1 级 5-10 条，第 2 级 8 条）。 */
  listedPoints: ExamPointDef[];
  /** 灰区命中（只诊断）。 */
  greyHits: string[];
}

export interface Rejection {
  stage: "no_theme_hits";
  reason: string;
  suggestions: string[];
}

export type JudgeResult = { ok: true; plan: ExamPlan } | { ok: false; rejection: Rejection };

/** 抽检结论落成的档位文件；空数组表示全部启用。 */
export function loadPointTiers(bodyOf: BodyOf): PointTiers {
  const raw = bodyOf("exercise-code-concepts", "point-tiers.json");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as PointTiers;
    return {
      ...(Array.isArray(parsed.enabled) ? { enabled: parsed.enabled } : {}),
      ...(Array.isArray(parsed.grey) ? { grey: parsed.grey } : {}),
      ...(Array.isArray(parsed.disabled) ? { disabled: parsed.disabled } : {})
    };
  } catch {
    return {};
  }
}

export interface JudgeInput {
  theme: string;
  index: PointIndex;
  ctx: LandingContext;
  tiers?: PointTiers;
}

function tierOf(pointId: string, tiers: PointTiers | undefined): "enabled" | "grey" | "disabled" {
  if (tiers?.disabled?.includes(pointId)) return "disabled";
  if (tiers?.grey?.includes(pointId)) return "grey";
  return "enabled";
}

/** 按结构信号降序取前 20，同名同路径的重复落点已由 matchPoint 去过重。 */
function ranked(landings: Landing[]): { top: Landing[]; remaining: number } {
  const sorted = [...landings].sort((left, right) => right.signal - left.signal || left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0));
  return { top: sorted.slice(0, 20), remaining: Math.max(0, sorted.length - 20) };
}

/** 全仓按落点数取前 N 条条目，用于第 2 级的参考清单。 */
function topPointsByLandings(points: ExamPointDef[], ctx: LandingContext, limit: number): ExamPointDef[] {
  return points
    .map((point) => ({ point, count: matchPoint(point, ctx).length }))
    .sort((left, right) => right.count - left.count || left.point.id.localeCompare(right.point.id))
    .slice(0, limit)
    .map((entry) => entry.point);
}

/** 给模型看的落点概要：推荐清单 + 剩余命中提示 + 第 2 级免责。所有出题路径共用这一份。 */
export function examPlanBrief(plan: ExamPlan): string {
  const lines = plan.listedPoints.map((point) => `- ${point.id}（${point.concepts.join("、")}）：${point.probes}`);
  const head = plan.sourceLevel === 1
    ? "本主题命中的可考点（优先从这些形状里挑缺陷）："
    : "本主题未命中技能词表（走概念直检）。以下仅为参考，不代表本仓一定有对应实现：";
  const remaining = plan.remaining ? `另有 ${plan.remaining} 处同类命中按结构信号排在后面，需要时可继续检索。` : "";
  return [head, ...lines, remaining].filter(Boolean).join("\n");
}

export function judgeThemeLandings(input: JudgeInput): JudgeResult {
  const { theme, index, ctx, tiers } = input;
  const concepts = conceptsOfTheme(theme, index.concepts);

  // 第 1 级：概念命中的技能条目里，只跑启用档；灰区另记诊断。
  const matched = [...new Map((concepts.flatMap((concept) => index.byConcept.get(concept) ?? [])).map((point) => [point.id, point])).values()];
  const enabled = matched.filter((point) => tierOf(point.id, tiers) === "enabled");
  const grey = matched.filter((point) => tierOf(point.id, tiers) === "grey");
  const greyHits = grey.flatMap((point) => matchPoint(point, ctx).map((landing) => landing.pointId));

  const enabledLandings = enabled.flatMap((point) => matchPoint(point, ctx));
  if (enabledLandings.length) {
    const { top, remaining } = ranked(enabledLandings);
    const byId = new Map(index.points.map((point) => [point.id, point]));
    const hitIds = [...new Set(enabledLandings.map((landing) => landing.pointId))];
    const listed = [...hitIds, ...enabled.map((point) => point.id)]
      .filter((id, position, all) => all.indexOf(id) === position)
      .map((id) => byId.get(id))
      .filter((point): point is ExamPointDef => Boolean(point))
      .slice(0, 10);
    return {
      ok: true,
      plan: {
        sourceLevel: 1,
        concepts,
        pointIds: hitIds,
        landings: top,
        remaining,
        listedPoints: listed.length >= 5 ? listed : listed.concat(enabled.filter((point) => !hitIds.includes(point.id))).slice(0, 10),
        greyHits
      }
    };
  }

  // 第 2 级：主题未命中词表（或只命中灰区），用概念同义词直接 sym:/text: 检索。
  const kw = concepts.flatMap((concept) => kwLandings(concept, index.concepts, ctx));
  if (kw.length) {
    const { top, remaining } = ranked(kw);
    return {
      ok: true,
      plan: {
        sourceLevel: 2,
        concepts,
        pointIds: [],
        landings: top,
        remaining,
        listedPoints: topPointsByLandings(index.points.filter((point) => tierOf(point.id, tiers) === "enabled"), ctx, 8),
        greyHits
      }
    };
  }

  // 第 3 级：拒绝。灰区命中不参与「有落点」的肯定证据。
  const suggestions = [...new Set(index.points
    .filter((point) => tierOf(point.id, tiers) === "enabled")
    .flatMap((point) => point.concepts))]
    .slice(0, 6);
  return {
    ok: false,
    rejection: {
      stage: "no_theme_hits",
      reason: `主题「${theme}」在技能词表与仓库符号/原文里都没有落点（启用条目命中 0，概念直检命中 0）。`,
      suggestions
    }
  };
}
