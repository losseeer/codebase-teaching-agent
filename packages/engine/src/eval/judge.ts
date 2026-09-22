import type { JournalEvent } from "@codebase-tutor/shared";
import { policyFor, validateSettings } from "../policy/policy.js";

/**
  B 档第 3 刀：表达质量裁判的**纯逻辑层**（rubric 预登记 + 判分解析 + 证据核验）。
  真发 LLM 调用在 scripts/judge-turns.ts；这里一条都不发，保证判分口径可单测。

  口径纪律：
  - 证据必须**逐字**来自被评回复（压平空白后做子串匹配）。引用不存在 = 判分驳回、该维记 0 并单独计数——
    这是防裁判模型幻觉的第一道闸：分数可以是主观的，证据不许编。
  - 裁判只能看转录、看不到源码：「接地」维判的是**锚定具体性**（点名到文件/符号/行号），
    不是事实真伪——事实真伪归第 2 刀机检（同一引用落地口径），两刀不越界。
  - 教学法契合只对 teach 回合判（map_chat/practice_chat 不吃 policy 约束）。
*/

export type JudgeScene = "teach" | "map_chat" | "practice_chat";

export interface JudgeTurn {
  sessionId: string;
  at: string;
  scene: JudgeScene;
  question: string;
  answer: string;
  /** journal 侧 answer_truncated 留痕：被截断的回复「易读」按 1 封顶（机械执行，不只靠 rubric 自觉）。 */
  answerTruncated?: boolean;
  /** teach 专属：该回合生效时的策略约束（来自 style_shift 快照，经 policyFor 展开）。 */
  constraints: string[];
}

export interface JudgeAxis {
  key: string;
  /** 0-2 分定义的全文——同时是喂给裁判的判据文本，预登记后不随跑批改动。 */
  rubric: string;
}

export const BASE_AXES: JudgeAxis[] = [
  { key: "接续", rubric: "回复是否接住本轮问题与前情（同会话更早回合）：2=明确回应本轮问题且与前情连贯；1=回应了本轮但明显断裂、重复或答非所问的一部分；0=与前情或本轮问题脱节。" },
  { key: "接地", rubric: "回复的表述是否锚定到具体事物：2=点名到具体文件/符号/行号或本轮上下文里出现过的实体；1=一半泛泛一半有锚；0=全是可平移到任何仓库的泛化表述。注意：只判具体性，不判事实真伪（事实核对由机检负责）。" },
  { key: "易读", rubric: "学习者能否直接消化：2=结构清楚、句子通顺、长度与问题相称；1=能读懂但绕、冗长或结构混乱；0=难以读懂（乱码、半截话、堆术语不解释）。被截断的回复按 1 封顶。" },
];

export const TEACH_AXIS: JudgeAxis = { key: "教学法契合", rubric: "回复是否符合给出的教学策略约束（如苏格拉底式应先请学习者推理、留可核对的问题）：2=每条适用约束都有可见动作；1=部分符合；0=与约束相反或完全无视。" };

export function axesFor(scene: JudgeScene): JudgeAxis[] {
  return scene === "teach" ? [...BASE_AXES, TEACH_AXIS] : BASE_AXES;
}

export const JUDGE_SYSTEM = `你是教学内容的质检裁判。只按给定维度打分，每题给 0、1 或 2 的整数分，并为每个维度从「被评回复」原文里摘一段**连续逐字**的证据（不许改写、不许拼接；证据可以就是没给分的理由所在的原文）。只输出一个 JSON 对象，形如 {"维度名":{"score":2,"evidence":"原文摘录"}}，不要输出其他文字。`;

export function buildJudgePrompt(turn: JudgeTurn, prior: JudgeTurn[]): string {
  const lines: string[] = [];
  lines.push("【前情】同会话最近回合，仅供理解上下文，不参与评分：");
  if (!prior.length) lines.push("（无，这是该会话第一回合）");
  for (const item of prior) {
    lines.push(`- （${item.scene}）学员：${item.question}`);
    lines.push(`  助手：${item.answer}`);
  }
  lines.push("");
  lines.push(`【被评回合】（场景：${turn.scene}）`);
  lines.push(`学员：${turn.question}`);
  lines.push(`助手：${turn.answer}`);
  lines.push("");
  if (turn.scene === "teach") {
    lines.push("【教学策略约束】（该回合生成时生效的教学设置）：");
    for (const constraint of turn.constraints) lines.push(`- ${constraint}`);
    lines.push("");
  }
  lines.push("【维度与判据】");
  for (const axis of axesFor(turn.scene)) lines.push(`- ${axis.key}：${axis.rubric}`);
  return lines.join("\n");
}

export interface AxisVerdict {
  score: number;
  evidence: string;
  /** 驳回原因（证据不逐字 / 分数非法 / 维度缺失）；undefined = 判分成立。 */
  rejected?: string;
}

export interface TurnVerdict {
  turn: JudgeTurn;
  priorCount: number;
  axes: Record<string, AxisVerdict>;
  parseFailed: boolean;
}

const squash = (text: string): string => text.replace(/\s+/g, "");

/** 解析裁判回包并核验证据：任何维度缺证据/证据非逐字/分数越界，都驳回并记 0。 */
export function parseJudgeResponse(text: string, turn: JudgeTurn): TurnVerdict {
  const verdict: TurnVerdict = { turn, priorCount: 0, axes: {}, parseFailed: true };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let parsed: unknown;
  if (start === -1 || end <= start) {
    verdict.axes = Object.fromEntries(axesFor(turn.scene).map((axis) => [axis.key, { score: 0, evidence: "", rejected: "回包里没有 JSON" } satisfies AxisVerdict]));
    return verdict;
  }
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    verdict.axes = Object.fromEntries(axesFor(turn.scene).map((axis) => [axis.key, { score: 0, evidence: "", rejected: "JSON 解析失败" } satisfies AxisVerdict]));
    return verdict;
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const answer = squash(turn.answer);
  for (const axis of axesFor(turn.scene)) {
    const item = record[axis.key] as { score?: unknown; evidence?: unknown } | undefined;
    if (!item || typeof item !== "object") {
      verdict.axes[axis.key] = { score: 0, evidence: "", rejected: "维度缺失" };
      continue;
    }
    const raw = typeof item.evidence === "string" ? item.evidence.trim() : "";
    if (!raw) {
      verdict.axes[axis.key] = { score: 0, evidence: "", rejected: "未给证据" };
      continue;
    }
    if (!answer.includes(squash(raw))) {
      verdict.axes[axis.key] = { score: 0, evidence: raw, rejected: "证据不是被评回复的逐字摘录" };
      continue;
    }
    if (typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 2) {
      verdict.axes[axis.key] = { score: 0, evidence: raw, rejected: "分数不在 0-2" };
      continue;
    }
    const score = Math.round(item.score);
    verdict.axes[axis.key] = { score: axis.key === "易读" && turn.answerTruncated ? Math.min(score, 1) : score, evidence: raw };
  }
  verdict.parseFailed = false;
  return verdict;
}

const SCENES = new Set<JudgeScene>(["teach", "map_chat", "practice_chat"]);

/** 从 journal 事件流组装待判回合（全场景）：同会话按时间排序，teach 回合附 style_shift 快照展开的策略约束。 */
export function assembleJudgeTurns(events: JournalEvent[]): { turns: JudgeTurn[]; truncatedAnswers: number } {
  const styleShifts = new Map<string, JournalEvent[]>();
  const turns: JudgeTurn[] = [];
  let truncatedAnswers = 0;
  for (const event of events) {
    if (event.type === "style_shift") {
      const list = styleShifts.get(event.sessionId ?? "") ?? [];
      list.push(event);
      styleShifts.set(event.sessionId ?? "", list);
    }
    if (event.type !== "turn_text") continue;
    const scene = event.payload.scene as JudgeScene | undefined;
    const question = typeof event.payload.question === "string" ? event.payload.question : "";
    const answer = typeof event.payload.answer === "string" ? event.payload.answer : "";
    if (!scene || !SCENES.has(scene) || !question || !answer) continue;
    if (event.payload.answer_truncated === true) truncatedAnswers += 1;
    // map_chat/practice_chat 无会话概念、落盘不带 sessionId：按场景各自成桶，避免前情跨场景串话
    const sessionKey = event.sessionId || `scene:${scene}`;
    let constraints: string[] = [];
    if (scene === "teach") {
      const shifts = styleShifts.get(event.sessionId ?? "") ?? [];
      const source = [...shifts].reverse().find((shift) => shift.at <= event.at) ?? shifts[0];
      const settings = validateSettings({
        style: source?.payload.style,
        pedagogy: source?.payload.pedagogy,
        depth: source?.payload.depth
      } as never);
      constraints = policyFor(settings).constraints;
    }
    turns.push({ sessionId: sessionKey, at: event.at, scene, question, answer, answerTruncated: event.payload.answer_truncated === true, constraints });
  }
  return { turns: turns.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)), truncatedAnswers };
}

/** 该回合的同会话前情（时间上更早的最近 2 轮，跨场景都算）。 */
export function priorTurns(turns: JudgeTurn[], turn: JudgeTurn): JudgeTurn[] {
  return turns.filter((item) => item.sessionId === turn.sessionId && item.at < turn.at).slice(-2);
}
