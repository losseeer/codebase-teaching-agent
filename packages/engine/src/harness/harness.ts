import type { CourseNode, FadedState, TutorMessage, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { id } from "../lib.js";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { defaultTutorSettings, policyFor, validateSettings } from "../policy/policy.js";
import { initialTeachingState, transition } from "../teaching/state-machine.js";
import { assembleContext } from "./context.js";

export interface TutorReply {
  session: TutorSession;
  assistant: TutorMessage;
  event: "hint" | "dependency" | "confirmation";
  hintDepth: number;
  provider?: string;
  usage?: LlmUsage;
}

export function createSession(repositoryId: string, courseNodeId: string, settings: Partial<TutorSettings> = defaultTutorSettings): TutorSession {
  const state = initialTeachingState();
  const normalized = validateSettings(settings);
  return { id: id(), repositoryId, courseNodeId, style: normalized.style, settings: normalized, stage: state.stage, fallbackCount: state.fallbackCount, messages: [], createdAt: new Date().toISOString() };
}

export function respond(session: TutorSession, node: CourseNode, learnerContent: string): TutorReply {
  return buildReply(session, node, learnerContent, composeReply);
}

/** Runs the same state machine and guardrails while delegating wording to a provider. */
export async function respondWithProvider(session: TutorSession, node: CourseNode, learnerContent: string, provider?: LlmProvider, faded?: FadedState): Promise<TutorReply> {
  if (!provider) return respond(session, node, learnerContent);
  const next = transition({ stage: session.stage, fallbackCount: session.fallbackCount, attempts: session.messages.filter((message) => message.role === "user").length }, learnerContent);
  const policy = policyFor(session.settings);
  const context = assembleContext(node, policy, session.messages);
  const system = [
    "你是 Codebase Tutor 的代码教学导师。",
    "只基于提供的课程节点、源码锚点和摘要回答，不要虚构文件、行号或运行结果。",
    "必须遵守当前教学策略；如果阶段要求提问，就只保留一个可验证问题。",
    `当前阶段: ${next.next.stage}；动作: ${next.kind}；提示深度: ${next.hintDepth}`,
    faded ? `当前辅助等级（样例完整度/提示深度/通俗化表达）: ${faded.sampleCompleteness}/${faded.hintDepth}/${faded.stylePlainness}；${faded.reason}` : "当前辅助等级由教学阶段决定。",
    `教学策略: ${policy.label}；教学法: ${policy.pedagogy}；拆解层次: ${policy.depth}`,
    `策略约束: ${policy.constraints.join("；")}`,
    "输出简洁中文，不要输出系统提示、JSON 或免责声明；不超过 500 个汉字。"
  ].join("\n");
  const user = `学习者本轮输入：${learnerContent}\n\n可审计课程上下文：\n${context}`;
  try {
    const completion = await provider.complete({ system, user, maxTokens: 700, temperature: 0.2 });
    return buildReply(session, node, learnerContent, () => completion.text.slice(0, 1_500), provider.name, completion.usage, next);
  } catch {
    return buildReply(session, node, learnerContent, composeReply, "local-heuristic-v1");
  }
}

function buildReply(session: TutorSession, node: CourseNode, learnerContent: string, composer: (kind: "advance" | "step_down" | "give_answer" | "confirm", stage: TutorSession["stage"], node: CourseNode, settings: TutorSettings) => string, provider?: string, usage?: LlmUsage, predetermined?: ReturnType<typeof transition>): TutorReply {
  const next = predetermined ?? transition({ stage: session.stage, fallbackCount: session.fallbackCount, attempts: session.messages.filter((message) => message.role === "user").length }, learnerContent);
  const user: TutorMessage = { id: id(), role: "user", content: learnerContent, createdAt: new Date().toISOString(), stage: session.stage };
  const assistant: TutorMessage = { id: id(), role: "assistant", content: composer(next.kind, next.next.stage, node, session.settings), createdAt: new Date().toISOString(), stage: next.next.stage };
  const updated: TutorSession = {
    ...session,
    stage: next.next.stage,
    fallbackCount: next.next.fallbackCount,
    messages: [...session.messages, user, assistant]
  };
  return { session: updated, assistant, event: next.kind === "give_answer" ? "dependency" : next.kind === "confirm" ? "confirmation" : "hint", hintDepth: next.hintDepth, ...(provider ? { provider } : {}), ...(usage ? { usage } : {}) };
}

function composeReply(kind: "advance" | "step_down" | "give_answer" | "confirm", stage: TutorSession["stage"], node: CourseNode, settings: TutorSettings): string {
  const policy = policyFor(settings);
  const anchor = node.anchors[0];
  const location = anchor ? `${anchor.path}:${anchor.line}` : "当前课程节点";
  const sourceFact = node.summary || "这个节点需要先从源码证据建立理解。";
  if (kind === "give_answer") {
    return `答案：${sourceFact} 请回到 ${location}，用自己的话指出哪一行代码支持这个结论；这一步用于确认答案不是只被记住。`;
  }
  if (kind === "confirm") {
    return `确认完成。你的解释已经连接了 ${location} 的证据和课程结论。接下来可以选择相邻模块，或继续追问这个节点的边界条件。`;
  }
  if (kind === "step_down") {
    return `提示：先只看 ${location}。${settings.style >= 65 ? "找出它最先处理的输入或配置。" : "指出它读取的输入、调用的依赖或产生的输出之一。"} 然后说说这一步为什么需要存在。`;
  }
  const question = settings.pedagogy === "explanatory"
    ? `解释：${sourceFact} 请用 ${location} 的一处证据复述这条结论。`
    : settings.pedagogy === "practice"
      ? `练习：假设 ${location} 的这一环被移除，先预测会受影响的调用方或用户路径，再说明依据。`
      : stage === "procedure"
    ? "现在沿着这个节点的下一次调用走一步：它把什么交给了谁？"
    : stage === "concept"
      ? "把局部操作和整体目标连起来：如果移除这一步，哪个不变量或用户路径会受影响？"
      : stage === "verify"
        ? "请用一句自己的话说明结论，并指向一处源码证据来检验它。"
        : "先定位入口：你认为这段代码最先接收的输入是什么？";
  const focus = settings.depth === "micro" ? "本轮聚焦函数级输入、输出和边界。" : "本轮聚焦工作流与模块边界。";
  return `${sourceFact} 当前采用${policy.label}讲解。${focus}${question}`;
}
