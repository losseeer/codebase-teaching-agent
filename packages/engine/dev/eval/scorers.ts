import { checkTurnInvariants, type InvariantId, type TeachTurn } from "../../src/application/turn-invariants.js";

/**
  离线评测的确定性判分器——不发起任何 LLM 调用，判「产出的形态与可定位性」：
  1. 引用落地：产物文本里每个 `文件[:行号]` 都必须在仓内真实存在、行号不越界；
  2. 边证据可核对：code 边的 evidence 必须引到这条边端点自己的文件（与 deepen 的驳回闸同一口径），
     static 边至少引到一个能落地的文件；
  3. 检索 gold 命中：`executeSearchCode` 离线重放，摘要上/不上两臂算 hit@k 与 recall@k，
     负例（仓内没有的东西）期望零命中。

  数据源缺失报「未执行」，不拿空数组伪装成满分。
*/

export interface SearchCase {
  id: string;
  query: string;
  /** 该查询的正确答案文件；负例为空数组（期望零命中）。 */
  goldPaths: string[];
  /** 留出例（true）：建集时不参照任何一代摘要措辞，只按代码事实写 query 与 gold；
      报告与调优例分列，若只有调优例涨、留出例不涨，即口径过拟合的信号。 */
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
  /** 负例：上了错误结果才算错——单独统计误命中率。 */
  negatives: { id: string; wrongHits: string[] }[];
}

/** 一臂评测：对每个 case 跑一次离线检索，算 hit@k / recall@k；负例算误命中。 */
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

// ---------- 教学法不变量机检（数据源 = journal 的 turn_text + style_shift） ----------

/** 不变量的定义表：离线报告与运行期提示共用同一份措辞与出处，改一处就两边一起变。 */
const INVARIANTS: { id: InvariantId; label: string; source: string }[] = [
  { id: "reference-grounding", label: "回复零编造（每个 文件[:行号] 引用都能落地）", source: "锚点可靠性纪律（与静态锚点判据同一口径）" },
  { id: "anchor-binding", label: "非小白档回复点名至少一个标识符/路径", source: "tutor-settings.ts「将问题绑定到当前源码锚点」" }
];

export interface InvariantCheck {
  id: InvariantId;
  label: string;
  /** 适用回合数（不适用 ≠ 通过，分母如实缩）。 */
  applicable: number;
  pass: number;
  misses: { at: string; sessionId: string; excerpt: string }[];
  /** 该条不变量的设计出处，报告里可核对。 */
  source: string;
}

export interface TeachInvariantScore {
  turns: number;
  skippedTruncated: number;
  checks: InvariantCheck[];
}

/**
  只判设计上写了保证、且文本层可核对的两条不变量（出处见 INVARIANTS 表）；
  「先要求说明推理再给结论」「不自造词」这类需要语义理解的留给质检裁判。
  逐条判定在 `checkTurnInvariants`——运行期复检也走它，这里只按条目聚合。
  */
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
