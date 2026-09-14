import type { CourseNode, FadedState, TutorMessage, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { id } from "../lib.js";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { defaultTutorSettings, policyFor, validateSettings } from "../policy/policy.js";
import { classifyIntent } from "../teaching/intent.js";
import { proposeAction, isActionAllowed } from "../teaching/action.js";
import { initialTeachingState, transition, transitionFromAction, transitionFromIntent } from "../teaching/state-machine.js";
import type { TeachingState, Transition, TutorAction } from "../teaching/state-machine.js";
import { assembleContext } from "./context.js";
import { teachingSystemPrompt } from "./prompts.js";

export interface TutorReply {
  session: TutorSession;
  assistant: TutorMessage;
  event: "hint" | "dependency" | "confirmation";
  hintDepth: number;
  provider?: string;
  usage?: LlmUsage;
  intentSource?: "llm" | "regex";
  /** 本轮最终执行的教学动作（与 buildReply 的 kind 一致）。 */
  action?: TutorAction;
  /** 受限 loop 中模型的原始提议（无论是否被守门放行）。 */
  proposedAction?: TutorAction;
  /** 动作来源：proposed=模型提议被放行；vetoed=提议被守门否决；deterministic=确定性路径。 */
  actionSource?: "proposed" | "vetoed" | "deterministic";
}

export interface RespondOptions {
  /** 轻量档意图分类器（workflow 模式使用；loop 模式下动作提议取代意图分类）。 */
  classifier?: LlmProvider;
  /** 受限 agent loop：模型从固定动作菜单提议动作，状态机守门校验。 */
  actionLoop?: boolean;
}

export function createSession(repositoryId: string, courseNodeId: string, settings: Partial<TutorSettings> = defaultTutorSettings): TutorSession {
  const state = initialTeachingState();
  const normalized = validateSettings(settings);
  return { id: id(), repositoryId, courseNodeId, style: normalized.style, settings: normalized, stage: state.stage, fallbackCount: state.fallbackCount, messages: [], createdAt: new Date().toISOString() };
}

export function respond(session: TutorSession, node: CourseNode, learnerContent: string): TutorReply {
  return buildReply(session, node, learnerContent, composeReply);
}

/** Runs the state machine as guardrails and delegates action selection (loop) or intent classification (workflow) and wording to providers. */
export async function respondWithProvider(session: TutorSession, node: CourseNode, learnerContent: string, provider?: LlmProvider, faded?: FadedState, repositoryPath?: string, options: RespondOptions = {}): Promise<TutorReply> {
  if (!provider) return respond(session, node, learnerContent);
  const state: TeachingState = { stage: session.stage, fallbackCount: session.fallbackCount, attempts: session.messages.filter((message) => message.role === "user").length };
  const policy = policyFor(session.settings);
  const context = assembleContext(node, policy, session.messages, repositoryPath);

  let next: Transition;
  let intentSource: "llm" | "regex" | undefined;
  let proposedAction: TutorAction | undefined;
  let actionSource: TutorReply["actionSource"];
  let decisionUsage: LlmUsage | undefined;

  if (options.actionLoop) {
    // 受限 agent loop：模型提议动作 → 守门校验 → 放行或否决。意图分类被动作提议取代。
    const proposal = await proposeAction(state, learnerContent, recentTranscript(session.messages), context, provider);
    proposedAction = proposal.action;
    decisionUsage = proposal.usage;
    if (proposedAction && isActionAllowed(state, proposedAction)) {
      actionSource = "proposed";
      next = transitionFromAction(state, proposedAction);
    } else {
      actionSource = proposedAction ? "vetoed" : "deterministic";
      next = transition(state, learnerContent);
    }
  } else if (options.classifier) {
    const classification = await classifyIntent(state, learnerContent, recentTranscript(session.messages), options.classifier);
    intentSource = classification.source;
    decisionUsage = classification.usage;
    next = transitionFromIntent(state, classification.intent);
  } else {
    next = transition(state, learnerContent);
  }

  const system = teachingSystemPrompt({ policy, stage: next.next.stage, kind: next.kind, hintDepth: next.hintDepth, faded });
  const user = `学习者本轮输入：${learnerContent}\n\n可审计课程上下文：\n${context}`;
  try {
    const completion = await provider.complete({ system, user, maxTokens: 700, temperature: 0.2 });
    return buildReply(session, node, learnerContent, () => completion.text.slice(0, 1_500), provider.name, sumUsage(decisionUsage, completion.usage), next, intentSource, { action: next.kind, ...(proposedAction ? { proposedAction } : {}), ...(actionSource ? { actionSource } : {}) });
  } catch {
    return buildReply(session, node, learnerContent, composeReply, "local-heuristic-v1", decisionUsage, undefined, intentSource, { action: next.kind, ...(proposedAction ? { proposedAction } : {}), ...(actionSource ? { actionSource } : {}) });
  }
}

function recentTranscript(messages: TutorMessage[]): string[] {
  return messages.slice(-4).map((message) => `${message.role === "user" ? "学习者" : "导师"}: ${message.content.slice(0, 120)}`);
}

function sumUsage(...usages: (LlmUsage | undefined)[]): LlmUsage | undefined {
  const present = usages.filter((usage): usage is LlmUsage => Boolean(usage));
  if (!present.length) return undefined;
  return {
    inputTokens: present.reduce((total, usage) => total + usage.inputTokens, 0),
    outputTokens: present.reduce((total, usage) => total + usage.outputTokens, 0)
  };
}

function buildReply(session: TutorSession, node: CourseNode, learnerContent: string, composer: (kind: "advance" | "step_down" | "give_answer" | "confirm", stage: TutorSession["stage"], node: CourseNode, settings: TutorSettings) => string, provider?: string, usage?: LlmUsage, predetermined?: Transition, intentSource?: "llm" | "regex", action?: Pick<TutorReply, "action" | "proposedAction" | "actionSource">): TutorReply {
  const next = predetermined ?? transition({ stage: session.stage, fallbackCount: session.fallbackCount, attempts: session.messages.filter((message) => message.role === "user").length }, learnerContent);
  const user: TutorMessage = { id: id(), role: "user", content: learnerContent, createdAt: new Date().toISOString(), stage: session.stage };
  const assistant: TutorMessage = { id: id(), role: "assistant", content: composer(next.kind, next.next.stage, node, session.settings), createdAt: new Date().toISOString(), stage: next.next.stage };
  const updated: TutorSession = {
    ...session,
    stage: next.next.stage,
    fallbackCount: next.next.fallbackCount,
    messages: [...session.messages, user, assistant]
  };
  return { session: updated, assistant, event: next.kind === "give_answer" ? "dependency" : next.kind === "confirm" ? "confirmation" : "hint", hintDepth: next.hintDepth, ...(provider ? { provider } : {}), ...(usage ? { usage } : {}), ...(intentSource ? { intentSource } : {}), ...(action ?? {}) };
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
  const focus = settings.depth === "micro" ? "本轮聚焦函数级输入、输出和边界。" : "本轮聚焦执行路径与模块边界。";
  return `${sourceFact} 当前采用${policy.label}讲解。${focus}${question}`;
}
