import { checkTurnInvariants, type InvariantId, type TeachTurn } from "../../src/application/runtime/turn-invariants.js";

/**
  离线评测的确定性判分器，不发起 LLM 调用。
  检索按 gold 路径算 hit@k 与 recall@k；教学法不变量逐条机检。
*/

export interface SearchCase {
  id: string;
  query: string;
  /** 正确答案文件；空数组表示负例。 */
  goldPaths: string[];
  /** 留出例：query 与 gold 只按代码事实写，不参照摘要措辞。 */
  holdout?: boolean;
}

export interface CaseArmResult {
  id: string;
  top: string[];
  hit: boolean;
  recall: number;
}

export interface ArmResult {
  perCase: CaseArmResult[];
  hitRate: { numerator: number; denominator: number };
  meanRecall: number;
  /** 负例的误命中结果。 */
  negatives: { id: string; wrongHits: string[] }[];
}

/** 对每个 case 跑一次离线检索，算 hit@k 与 recall@k。 */
export function scoreSearchArm(cases: SearchCase[], search: (query: string) => string[]): ArmResult {
  const perCase: CaseArmResult[] = [];
  const negatives: { id: string; wrongHits: string[] }[] = [];
  let numerator = 0;
  let denominator = 0;
  let recallSum = 0;
  for (const item of cases) {
    const top = search(item.query);
    if (!item.goldPaths.length) {
      negatives.push({ id: item.id, wrongHits: top });
      continue;
    }
    const gold = new Set(item.goldPaths);
    const found = top.filter((path) => gold.has(path));
    perCase.push({ id: item.id, top, hit: found.length > 0, recall: found.length / item.goldPaths.length });
    numerator += found.length > 0 ? 1 : 0;
    denominator += 1;
    recallSum += found.length / item.goldPaths.length;
  }
  return {
    perCase,
    hitRate: { numerator, denominator },
    meanRecall: perCase.length ? recallSum / perCase.length : 0,
    negatives
  };
}

// ---------- 教学法不变量机检 ----------

/** 不变量的定义表：id、展示文案与设计出处。 */
const INVARIANTS: { id: InvariantId; label: string; source: string }[] = [
  { id: "reference-grounding", label: "回复零编造（每个 文件[:行号] 引用都能落地）", source: "锚点可靠性纪律（与静态锚点判据同一口径）" },
  { id: "anchor-binding", label: "非小白档回复点名至少一个标识符/路径", source: "tutor-settings.ts「将问题绑定到当前源码锚点」" }
];

export interface InvariantCheck {
  id: InvariantId;
  label: string;
  /** 适用的回合数。 */
  applicable: number;
  pass: number;
  misses: { at: string; sessionId: string; excerpt: string }[];
  /** 该条不变量的设计出处。 */
  source: string;
}

export interface TeachInvariantScore {
  turns: number;
  skippedTruncated: number;
  checks: InvariantCheck[];
}

/** 逐回合统计每条不变量的适用数与通过数。 */
export function scoreTeachInvariants(turns: TeachTurn[], files: Map<string, number>): TeachInvariantScore {
  const checks = new Map<string, InvariantCheck>(INVARIANTS.map((item) => [item.id, { ...item, applicable: 0, pass: 0, misses: [] }]));
  let skippedTruncated = 0;

  for (const turn of turns) {
    if (turn.answerTruncated) skippedTruncated += 1;
    const verdict = checkTurnInvariants(turn, files);
    for (const id of verdict.applicable) {
      const check = checks.get(id)!;
      check.applicable += 1;
      if (verdict.failed.includes(id)) check.misses.push({ at: turn.at, sessionId: turn.sessionId, excerpt: verdict.evidence[id] ?? "" });
      else check.pass += 1;
    }
  }
  return { turns: turns.length, skippedTruncated, checks: [...checks.values()] };
}
