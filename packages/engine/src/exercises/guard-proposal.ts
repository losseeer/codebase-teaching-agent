import type { RubricCriterion } from "@codebase-tutor/domain";

/**
  LLM 出题守门（确定性一端）：任一不过即否决整道题。
  三类检查：契约（字段齐全与长度上限）、事实（锚点落在候选摘录内）、泄漏（题面含参考答案片段）。
  标题字数不检查。
*/

export interface GuardCandidate {
  path: string;
  excerpt: string;
  lineCount: number;
  /** 摘录的起始行，默认 1；锚点行号要落在 [startLine, lineCount] 内。 */
  startLine?: number;
  /** 摘录实际给到的最后一行（文件真实行号）。 */
  endLine?: number;
  /** 摘录里隐去的疑似密钥处数。 */
  masked?: number;
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

/** 题面、参考答案的字数上限与评分维度条数上限。 */
const MAX_PROMPT = 4_000;
const MAX_ANSWER_KEY = 2_000;
const MAX_CRITERIA = 6;

export function guardLlmProposal(proposal: LlmExerciseProposal, candidates: GuardCandidate[]): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));

  if (!proposal.title?.trim()) issues.push({ check: "contract", message: "题面标题为空" });
  if (!proposal.prompt?.trim()) issues.push({ check: "contract", message: "题面描述为空" });
  else if (proposal.prompt.length > MAX_PROMPT) issues.push({ check: "contract", message: `题面描述长得不像题面（>${MAX_PROMPT} 字），像把源码整份抄进来了` });
  if (!proposal.answerKey?.trim()) issues.push({ check: "contract", message: "参考答案为空" });
  else if (proposal.answerKey.length > MAX_ANSWER_KEY) issues.push({ check: "contract", message: "参考答案超长" });

  const criteria = Array.isArray(proposal.criteria) ? proposal.criteria : [];
  if (!criteria.length) issues.push({ check: "contract", message: "评分细则为空" });
  if (criteria.length > MAX_CRITERIA) issues.push({ check: "contract", message: `评分维度太多（>${MAX_CRITERIA}）` });
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
