import type { RubricCriterion } from "@codebase-tutor/shared";

/**
  LLM 出题守门（propose + verify 中的 verify 端）：全部确定性检查，任一不过即否决整道题。
  ① 契约检查——字段齐全、长度受控；
  ② 事实检查——锚点必须落在出题时提供的候选摘录集合内（防幻觉，拦「该拒不拒、硬编无关题」）；
  ③ 泄漏检查——题面不得包含参考答案片段。
  守门与判分锚点同源：rubric 的 answerKey/criteria 存引擎缓存，题面只有通过守门才落库。
  */

export interface GuardCandidate {
  path: string;
  excerpt: string;
  lineCount: number;
  /** 摘录的起始行号（符号定位窗口不从第 1 行开始时使用；缺省 1）。锚点必须落在 [startLine, lineCount] 内。 */
  startLine?: number;
}

export interface LlmExerciseProposal {
  title: string;
  prompt: string;
  answerKey: string;
  criteria: RubricCriterion[];
  anchors: { path: string; line: number; endLine?: number; label?: string }[];
  targetTitle: string;
}

export interface GuardIssue {
  check: "contract" | "fact" | "leak";
  message: string;
}

const MAX_TITLE = 40;
const MAX_PROMPT = 600;
const MAX_ANSWER_KEY = 2_000;
const MAX_CRITERIA = 6;
const MAX_ANCHORS = 4;

export function guardLlmProposal(proposal: LlmExerciseProposal, candidates: GuardCandidate[]): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));

  if (!proposal.title?.trim()) issues.push({ check: "contract", message: "题面标题为空" });
  else if (proposal.title.length > MAX_TITLE) issues.push({ check: "contract", message: `题面标题超长（>${MAX_TITLE} 字）` });
  if (!proposal.prompt?.trim()) issues.push({ check: "contract", message: "题面描述为空" });
  else if (proposal.prompt.length > MAX_PROMPT) issues.push({ check: "contract", message: `题面描述超长（>${MAX_PROMPT} 字）` });
  if (!proposal.answerKey?.trim()) issues.push({ check: "contract", message: "参考答案为空" });
  else if (proposal.answerKey.length > MAX_ANSWER_KEY) issues.push({ check: "contract", message: "参考答案超长" });

  const criteria = Array.isArray(proposal.criteria) ? proposal.criteria : [];
  if (!criteria.length) issues.push({ check: "contract", message: "评分细则为空" });
  if (criteria.length > MAX_CRITERIA) issues.push({ check: "contract", message: `评分细维度过多（>${MAX_CRITERIA}）` });
  for (const criterion of criteria) {
    if (!criterion?.dimension?.trim() || !criterion?.description?.trim()) {
      issues.push({ check: "contract", message: "评分细则存在空维度或空描述" });
      break;
    }
  }

  const anchors = Array.isArray(proposal.anchors) ? proposal.anchors : [];
  if (!anchors.length) issues.push({ check: "fact", message: "题面缺少源码锚点" });
  for (const anchor of anchors) {
    const candidate = byPath.get(anchor.path);
    if (!candidate) {
      issues.push({ check: "fact", message: `锚点 ${anchor.path} 不在出题候选摘录中` });
      continue;
    }
    const startLine = candidate.startLine ?? 1;
    if (!Number.isInteger(anchor.line) || anchor.line < startLine || anchor.line > candidate.lineCount) {
      issues.push({ check: "fact", message: `锚点 ${anchor.path}:${anchor.line} 行号超出候选摘录范围（${startLine}-${candidate.lineCount}）` });
      continue;
    }
    if (anchor.endLine !== undefined && (anchor.endLine < anchor.line || anchor.endLine > candidate.lineCount)) {
      issues.push({ check: "fact", message: `锚点 ${anchor.path} 结束行 ${anchor.endLine} 无效` });
    }
  }

  const normalizedPrompt = normalize(proposal.prompt ?? "");
  const normalizedKey = normalize(proposal.answerKey ?? "");
  if (normalizedPrompt && normalizedKey.length >= 8 && normalizedPrompt.includes(normalizedKey.slice(0, Math.min(24, normalizedKey.length)))) {
    issues.push({ check: "leak", message: "题面包含参考答案片段，存在答案泄漏" });
  }
  return issues;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
