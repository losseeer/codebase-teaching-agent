import type { CourseNode, FadedState, RepositoryAnalysis, TutorMessage, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { id } from "../lib.js";
import type { LlmCompletion, LlmProvider, LlmUsage } from "../llm/provider.js";
import { flagTruncatedReply } from "../llm/provider.js";
import { addUsage } from "../llm/usage.js";
import { defaultTutorSettings, policyFor, styleBand, validateSettings } from "../policy/policy.js";
import type { FileReadRecord } from "../source/read-file.js";
import type { CodeSearchRecord, SearchCorpus } from "../source/search-code.js";
import { completeWithReadTool, type ReadToolProgress } from "../source/tool-loop.js";
import { classifyIntent } from "../teaching/intent.js";
import { proposeAction, isActionAllowed } from "../teaching/action.js";
import { initialTeachingState, transition, transitionFromAction, transitionFromIntent } from "../teaching/state-machine.js";
import type { TeachingState, Transition, TutorAction } from "../teaching/state-machine.js";
import { assembleContext } from "./context.js";
import { teachingSystemPrompt } from "./prompts.js";

/** 教学回合的工具循环预算：比宏观设计更紧——教学要的是「看一眼那一行」，不是通读实现。 */
const TEACHING_MAX_TOOL_ROUNDS = 2;
const TEACHING_MAX_TOOL_CALLS = 3;

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
  /** 本轮 read_file 调用审计（供 server 逐条记 journal file_read）。 */
  fileReads?: FileReadRecord[];
  /** 本轮 search_code 调用审计（供 server 逐条记 journal code_search）。 */
  codeSearches?: CodeSearchRecord[];
}

/**
  教学回合的过程事件：一个回合里模型实际做的事（判断动作 / 读代码 / 组织回复）。
  server 把它经 ws 广播为 `session.progress`，GUI 显示成 Agent 侧栏里的过程提示行——
  回合可能持续数秒，只显示一句「回复中」等于把这段时间藏起来。
  `stage` 字段名与 map-chat 的 SSE 过程事件保持一致（GUI 两侧同一套取值）。
  */
export type TeachingProgress =
  | { stage: "deciding" }
  | { stage: "thinking"; round: number }
  | { stage: "reading"; path: string };

export interface RespondOptions {
  /** 轻量档意图分类器（workflow 模式使用；loop 模式下动作提议取代意图分类）。 */
  classifier?: LlmProvider;
  /** 受限 agent loop：模型从固定动作菜单提议动作，状态机守门校验。 */
  actionLoop?: boolean;
  /** 依赖图：提供时上下文注入调用邻接（谁调用它 / 它调用谁 / 同文件符号位置）。 */
  analysis?: RepositoryAnalysis;
  /** search_code 语料（server 侧用 index+analysis+L1 摘要构建）：提供时教学回合开放检索工具。 */
  search?: SearchCorpus;
  /** 过程事件回调（可选；用于把「正在判断动作 / 正在读 xx 文件」推给 GUI）。 */
  onProgress?: (progress: TeachingProgress) => void;
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
  const context = assembleContext({
    node,
    policy,
    history: session.messages,
    ...(repositoryPath ? { repositoryPath } : {}),
    ...(options.analysis ? { analysis: options.analysis } : {})
  });

  let next: Transition;
  let intentSource: "llm" | "regex" | undefined;
  let proposedAction: TutorAction | undefined;
  let actionSource: TutorReply["actionSource"];
  let decisionUsage: LlmUsage | undefined;

  // 动作判断阶段（模型提议动作 / 轻量档意图分类）也要有过程提示：这一段没有读文件事件，否则界面会静默
  if (options.actionLoop || options.classifier) options.onProgress?.({ stage: "deciding" });

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

  const readToolAvailable = Boolean(repositoryPath);
  const searchToolAvailable = readToolAvailable && Boolean(options.search);
  const system = teachingSystemPrompt({ policy, stage: next.next.stage, kind: next.kind, hintDepth: next.hintDepth, faded, readToolAvailable, searchToolAvailable });
  const user = `学习者本轮输入：${learnerContent}\n\n可审计课程上下文：\n${context}`;
  const actions: Pick<TutorReply, "action" | "proposedAction" | "actionSource"> = { action: next.kind, ...(proposedAction ? { proposedAction } : {}), ...(actionSource ? { actionSource } : {}) };
  try {
    const outcome = await completeWording({ provider, system, user, ...(repositoryPath ? { repositoryPath } : {}), ...(options.search ? { search: options.search } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) });
    const completion = outcome.completion;
    // 可见回复的截断兜底：token 触顶（finishReason=length）或被这里 1,500 字符硬切，都要留痕
    return buildReply(session, node, learnerContent, () => flagTruncatedReply(completion.text.slice(0, 1_500), completion.finishReason === "length" || completion.text.length > 1_500), provider.name, addUsage(decisionUsage, outcome.usage), next, intentSource, { ...actions, ...(outcome.fileReads.length ? { fileReads: outcome.fileReads } : {}), ...(outcome.codeSearches.length ? { codeSearches: outcome.codeSearches } : {}) });
  } catch {
    return buildReply(session, node, learnerContent, composeReply, "local-heuristic-v1", decisionUsage, undefined, intentSource, actions);
  }
}

/** 措辞调用：有仓库路径时走 read_file/search_code 工具循环（上下文只给锚点摘录与调用邻接，深度由模型按需拉取）；
    没有仓库路径时退回单轮调用——工具读不到任何文件，不如不给。 */
async function completeWording(input: { provider: LlmProvider; system: string; user: string; repositoryPath?: string; search?: SearchCorpus; onProgress?: (progress: TeachingProgress) => void }): Promise<{ completion: LlmCompletion; usage?: LlmUsage; fileReads: FileReadRecord[]; codeSearches: CodeSearchRecord[] }> {
  const forwardProgress = (progress: ReadToolProgress): void => {
    input.onProgress?.(progress.type === "reading" ? { stage: "reading", path: progress.path } : { stage: "thinking", round: progress.round });
  };
  if (!input.repositoryPath) {
    input.onProgress?.({ stage: "thinking", round: 1 });
    const completion = await input.provider.complete({ system: input.system, user: input.user, maxTokens: 700, temperature: 0.2, scene: "teaching.turn" });
    return { completion, ...(completion.usage ? { usage: completion.usage } : {}), fileReads: [], codeSearches: [] };
  }
  const result = await completeWithReadTool({
    provider: input.provider,
    repoPath: input.repositoryPath,
    system: input.system,
    user: input.user,
    maxTokens: 700,
    temperature: 0.2,
    maxRounds: TEACHING_MAX_TOOL_ROUNDS,
    maxCalls: TEACHING_MAX_TOOL_CALLS,
    scene: "teaching.turn",
    ...(input.search ? { search: input.search } : {}),
    ...(input.onProgress ? { onProgress: forwardProgress } : {})
  });
  return { completion: result.completion, ...(result.usage ? { usage: result.usage } : {}), fileReads: result.fileReads, codeSearches: result.codeSearches };
}

function recentTranscript(messages: TutorMessage[]): string[] {
  return messages.slice(-4).map((message) => `${message.role === "user" ? "学习者" : "导师"}: ${message.content.slice(0, 120)}`);
}

function buildReply(session: TutorSession, node: CourseNode, learnerContent: string, composer: (kind: "advance" | "step_down" | "give_answer" | "confirm", stage: TutorSession["stage"], node: CourseNode, settings: TutorSettings) => string, provider?: string, usage?: LlmUsage, predetermined?: Transition, intentSource?: "llm" | "regex", action?: Pick<TutorReply, "action" | "proposedAction" | "actionSource" | "fileReads">): TutorReply {
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
    // 档位判据走 styleBand（与 policyFor 同源），不在这里另写阈值
    return `提示：先只看 ${location}。${styleBand(settings.style) === "plain" ? "找出它最先处理的输入或配置。" : "指出它读取的输入、调用的依赖或产生的输出之一。"} 然后说说这一步为什么需要存在。`;
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
