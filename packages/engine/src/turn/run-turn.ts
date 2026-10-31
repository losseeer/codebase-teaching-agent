import { id } from "@codebase-tutor/platform";
import type { TeachingProgress } from "@codebase-tutor/contract";
import type { Exercise, FadedState, RepositoryAnalysis, RepositoryIndex, TutorMessage, TutorSession } from "@codebase-tutor/domain";
import { policyFor } from "@codebase-tutor/domain";

import type { LlmCompletion, LlmProvider, LlmUsage } from "../application/port/llm-provider.js";
import { flagTruncatedReply } from "../application/port/llm-provider.js";
import { CONTEXT_SHARE, contextShare } from "../adapter/outbound/llm/context-window.js";
import { type ConversationBlock, renderConversation } from "../adapter/outbound/llm/conversation.js";
import { callNeighborhoodSection } from "@codebase-tutor/analysis";
import type { FileReadRecord } from "../source/read-file.js";
import type { CodeSearchRecord, SearchCorpus } from "../source/search-code.js";
import type { AskClaimAudit, AskFacet, AskResume, AskUserAudit } from "../source/ask-user.js";
import type { CrossRepoContext, ExternalToolContext, FactsToolContext, ReadToolProgress, SetDiagramToolContext, SkillsToolContext, TurnCheckpointChannel, TurnInterrupt, TurnStopReason } from "../source/tool-loop.js";
import { completeWithReadTool } from "../source/tool-loop.js";
import { recordEgress, type EgressCollector } from "../adapter/outbound/security/egress-log.js";
import type { ScopeRef } from "../source/scope-ref.js";
import type { McpCallAudit } from "@codebase-tutor/domain";
import { assembleContext } from "./context-teaching.js";
import { graphNeighborhood, joinList, mapContextCap, scopeSection, structurePanorama } from "./context-canvas.js";
import { excerptForAnchor, excerptsWithinBudget } from "./context-excerpt.js";
import { exerciseQaSystemPrompt, overviewSystemPrompt, teachingSystemPrompt } from "./prompts.js";

/**
  teaching / map / practice 三个作用域的统一发射入口。
  练习的标准答案与锚点不进上下文，practice 也不给 read_file。
  作用域清单与已分析集交集为空时不注入作用域段。
  */

/** 问答回合的过程事件。 */
export type { TeachingProgress };

const practiceContextCap = () => contextShare(CONTEXT_SHARE.practiceContext);

/** 同一线程里此前几轮的问答原文。 */
export interface ScopedChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** 按窗口占用装配历史对话段。 */
function conversationBlock(history: ScopedChatTurn[] | undefined, query: string, usedCharacters: number): ConversationBlock {
  return renderConversation({ turns: history ?? [], query, usedCharacters });
}

/** mapChat 过程事件。 */
export type MapChatProgress = ReadToolProgress;

/** 把工具循环的过程帧转成回合进度载荷。 */
function progressToStage(progress: ReadToolProgress): TeachingProgress {
  switch (progress.type) {
    case "thinking": return { stage: "thinking" };
    case "reading": return { stage: "reading", path: progress.path };
    case "searching": return { stage: "searching", query: progress.query };
    case "loading_skill": return { stage: "loading_skill", skill: progress.skill };
    case "editing_diagram": return { stage: "editing_diagram" };
    case "querying_facts": return { stage: "querying_facts" };
    case "calling_external": return { stage: "calling_external" };
  }
}

export interface ScopedChatResult {
  reply: string;
  provider: string;
  usage?: LlmUsage;
  /** read_file 调用审计。 */
  fileReads?: FileReadRecord[];
  /** search_code 调用审计。 */
  codeSearches?: CodeSearchRecord[];
  /** 工具循环实际轮数。 */
  toolRounds: number;
  /** 本回合从第几轮检查点续跑。 */
  resumedFromRound?: number;
  /** 回合提前停止的原因。 */
  stoppedBy?: TurnStopReason;
  /** 本回合的外部工具调用记录，含失败。 */
  mcpCalls?: McpCallAudit[];
  /** 本回合取过的技能正文。 */
  skillReads?: { skill: string; chars: number; found: boolean }[];
  /** 本回合向用户提出的问题。 */
  asked?: AskUserAudit;
  /** 最近一次提问被拒的原因。 */
  askRefused?: string;
  /** 本回合被中断时的结论，无成品。 */
  interrupted?: TurnInterrupt;
  /** 对上一回合提问的认领结局。 */
  askClaimed?: AskClaimAudit;
  /** 本回合历史折叠与找回的条数。 */
  conversation: { foldedMessages: number; recalledMessages: number };
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（上下文过长已截断）` : text;
}

/** 代码问答回合的产出。 */
export interface TutorReply {
  session: TutorSession;
  assistant: TutorMessage;
  provider: string;
  usage?: LlmUsage;
  /** read_file 调用审计。 */
  fileReads?: FileReadRecord[];
  /** search_code 调用审计。 */
  codeSearches?: CodeSearchRecord[];
  /** 工具循环实际轮数；单轮调用为 0。 */
  toolRounds?: number;
  /** 外部工具调用记录，含失败。 */
  mcpCalls?: McpCallAudit[];
  /** 取过的技能正文。 */
  skillReads?: { skill: string; chars: number; found: boolean }[];
  /** 历史折叠与找回的条数。 */
  conversation: { foldedMessages: number; recalledMessages: number };
  /** 从第几轮检查点续跑。 */
  resumedFromRound?: number;
  /** 回合提前停止的原因。 */
  stoppedBy?: TurnStopReason;
}

export interface RespondOptions {
  /** 索引：提供时目录作用域可列出目录内文件。 */
  index?: RepositoryIndex;
  /** 依赖图：提供时上下文注入调用邻接。 */
  analysis?: RepositoryAnalysis;
  /** search_code 语料：提供时开放检索工具。 */
  search?: SearchCorpus;
  /** 跨仓上下文：给 read_file/search_code 的 repo 参数与 cross_repo_link。 */
  cross?: CrossRepoContext;
  /** 过程事件回调。 */
  onProgress?: (progress: TeachingProgress) => void;
  /** 外部中止信号：贯穿工具循环。 */
  signal?: AbortSignal;
  /** 每轮工具调用前的预算闸门。 */
  budgetGuard?: () => string | undefined;
  /** 回合检查点通道。 */
  checkpoint?: TurnCheckpointChannel;
  /** 技能清单与正文取用通道。 */
  skills?: SkillsToolContext;
  /** 外部 MCP 工具面。 */
  external?: ExternalToolContext;
}

export interface RunTurnInput {
  /** 作用域只决定落库与埋点的口径，工具面一律同一条件：有仓就可取证。 */
  scope: "teaching" | "map" | "practice";
  provider: LlmProvider;
  /** 装配好的系统提示词与本轮用户消息，不再加工。 */
  system: string;
  user: string;
  /** 输出预算；省略即取 `DEFAULT_MAX_TOKENS`。 */
  maxTokens?: number;
  temperature: number;
  /** 场景标签，透传给每一轮调用。 */
  scene: string;
  /** 已分析仓库根：read_file 只在此范围内读取。 */
  repositoryPath?: string;
  search?: SearchCorpus;
  cross?: CrossRepoContext;
  diagram?: SetDiagramToolContext;
  facts?: FactsToolContext;
  skills?: SkillsToolContext;
  /** 提问通道；`resume` 表示本句是回答上一回合的提问。 */
  ask?: { facets: AskFacet[]; resume?: AskResume };
  external?: ExternalToolContext;
  checkpoint?: TurnCheckpointChannel;
  budgetGuard?: () => string | undefined;
  /** 到上限时中断回合并保留检查点。 */
  interruptAtLimit?: boolean;
  signal?: AbortSignal;
  /** 工具循环的原始过程事件。 */
  onProgress?: (progress: ReadToolProgress) => void;
}

export interface RunTurnResult {
  completion: LlmCompletion;
  usage?: LlmUsage;
  /** 工具循环实际轮数；单轮调用为 0。 */
  rounds: number;
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  mcpCalls: McpCallAudit[];
  skillReads: { skill: string; chars: number; found: boolean }[];
  resumedFromRound?: number;
  stoppedBy?: TurnStopReason;
  /** 本回合以向用户提问收尾。 */
  asked?: AskUserAudit;
  /** 最近一次提问被拒的原因。 */
  askRefused?: string;
  /** 本回合被中断时的结论，无成品。 */
  interrupted?: TurnInterrupt;
  /** 对上一回合提问的认领结局。 */
  askClaimed?: AskClaimAudit;
}

/** 回合的唯一发射处：按作用域与通道选工具循环或单轮调用。 */
export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  if (input.repositoryPath) {
    const result = await completeWithReadTool({
      provider: input.provider,
      repoPath: input.repositoryPath,
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      scene: input.scene,
      ...(input.search ? { search: input.search } : {}),
      ...(input.cross ? { cross: input.cross } : {}),
      ...(input.diagram ? { diagram: input.diagram } : {}),
      ...(input.facts ? { facts: input.facts } : {}),
      ...(input.skills ? { skills: input.skills } : {}),
      ...(input.ask ? { ask: input.ask } : {}),
      ...(input.external ? { external: input.external } : {}),
      ...(input.budgetGuard ? { budgetGuard: input.budgetGuard } : {}),
      ...(input.interruptAtLimit ? { interruptAtLimit: true } : {}),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    return {
      completion: result.completion,
      ...(result.usage ? { usage: result.usage } : {}),
      rounds: result.rounds,
      fileReads: result.fileReads,
      codeSearches: result.codeSearches,
      mcpCalls: result.mcpCalls,
      skillReads: result.skillReads,
      ...(result.resumedFromRound === undefined ? {} : { resumedFromRound: result.resumedFromRound }),
      ...(result.stoppedBy === undefined ? {} : { stoppedBy: result.stoppedBy }),
      ...(result.asked === undefined ? {} : { asked: result.asked }),
      ...(result.askRefused === undefined ? {} : { askRefused: result.askRefused }),
      ...(result.interrupted === undefined ? {} : { interrupted: result.interrupted }),
      ...(result.askClaimed === undefined ? {} : { askClaimed: result.askClaimed })
    };
  }
  input.onProgress?.({ type: "thinking" });
  const completion = await input.provider.complete({ system: input.system, user: input.user, maxTokens: input.maxTokens, temperature: input.temperature, scene: input.scene, ...(input.signal ? { signal: input.signal } : {}) });
  return { completion, ...(completion.usage ? { usage: completion.usage } : {}), rounds: 0, fileReads: [], codeSearches: [], mcpCalls: [], skillReads: [] };
}

/** 装配上下文并发一个代码问答回合。 */
export async function respondWithProvider(session: TutorSession, scope: ScopeRef, learnerContent: string, provider: LlmProvider, faded?: FadedState, repositoryPath?: string, options: RespondOptions = {}): Promise<TutorReply> {
  const policy = policyFor(session.settings);
  /** 上下文里放了哪几段仓内源码，由 `assembleContext` 登记。 */
  const egress: EgressCollector = [];
  const conversationAudit = { foldedMessages: 0, recalledMessages: 0 };
  const context = assembleContext({
    scope,
    policy,
    history: session.messages,
    query: learnerContent,
    conversationAudit,
    ...(repositoryPath ? { repositoryPath, egress } : {}),
    ...(options.index ? { index: options.index } : {}),
    ...(options.analysis ? { analysis: options.analysis } : {})
  });
  const readToolAvailable = Boolean(repositoryPath);
  const searchToolAvailable = readToolAvailable && Boolean(options.search);
  const system = teachingSystemPrompt({ policy, faded, readToolAvailable, searchToolAvailable });
  // 技能清单贴在上下文尾部，不进系统提示词
  const skillsBrief = options.skills ? `\n\n${options.skills.brief}` : "";
  const user = `学习者本轮输入：${learnerContent}\n\n可审计代码上下文：\n${context}${skillsBrief}`;
  if (repositoryPath) recordEgress({ repositoryPath, scene: "teaching.turn", sessionId: session.id, sources: egress, sent: user });
  const outcome = await runTurn({
    scope: "teaching",
    provider,
    system,
    user,
    temperature: 0.2,
    scene: "teaching.turn",
    ...(repositoryPath ? { repositoryPath } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.cross ? { cross: options.cross } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.external ? { external: options.external } : {}),
    ...(options.budgetGuard ? { budgetGuard: options.budgetGuard } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: (progress: ReadToolProgress): void => { options.onProgress?.(progressToStage(progress)); } } : {})
  });
  const content = flagTruncatedReply(outcome.completion.text, outcome.completion.finishReason === "length");
  const userMessage: TutorMessage = { id: id(), role: "user", content: learnerContent, createdAt: new Date().toISOString() };
  const assistant: TutorMessage = { id: id(), role: "assistant", content, createdAt: new Date().toISOString() };
  return {
    session: { ...session, messages: [...session.messages, userMessage, assistant] },
    assistant,
    provider: provider.name,
    conversation: conversationAudit,
    ...(outcome.resumedFromRound === undefined ? {} : { resumedFromRound: outcome.resumedFromRound }),
    ...(outcome.stoppedBy === undefined ? {} : { stoppedBy: outcome.stoppedBy }),
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.fileReads.length ? { fileReads: outcome.fileReads } : {}),
    ...(outcome.codeSearches.length ? { codeSearches: outcome.codeSearches } : {}),
    ...(outcome.mcpCalls.length ? { mcpCalls: outcome.mcpCalls } : {}),
    ...(outcome.skillReads.length ? { skillReads: outcome.skillReads } : {}),
    toolRounds: outcome.rounds
  };
}

/** map 作用域的一轮对话，带图结构写工具与现状快照。 */
export async function mapChat(input: { repoPath: string; analysis: RepositoryAnalysis; scopePaths?: string[]; path?: string; content: string; history?: ScopedChatTurn[]; provider: LlmProvider; search?: SearchCorpus; cross?: CrossRepoContext; threadId?: string; onProgress?: (progress: MapChatProgress) => void; signal?: AbortSignal; /** 图结构改动通道；给了工具就必须给 `inventory` 现状。 */ diagram?: SetDiagramToolContext; /** 静态产物的只读查询通道。 */ facts?: FactsToolContext; /** 技能清单与正文取用通道。 */ skills?: SkillsToolContext; /** 提问通道；`resume` 表示本句是回答上一回合的提问。 */ ask?: { facets: AskFacet[]; resume?: AskResume }; /** 外部 MCP 工具面。 */ external?: ExternalToolContext; /** 回合检查点通道。 */ checkpoint?: TurnCheckpointChannel; /** 每轮工具调用前的预算检查。 */ budgetGuard?: () => string | undefined }): Promise<ScopedChatResult> {
  const { analysis, path, provider } = input;
  const sections: string[] = [];
  /** 本回合放进上下文的源码原文。 */
  const egress: EgressCollector = [];
  const panorama = structurePanorama(analysis);
  if (panorama) sections.push(panorama);
  // 画布上送的文件清单只作作用域提示
  const scope = input.scopePaths?.length ? scopeSection(analysis, input.search, input.scopePaths) : "";
  if (scope) sections.push(scope);
  // 画布现场快照：set_diagram 需要图元 id
  if (input.diagram?.inventory) sections.push(input.diagram.inventory);
  // 静态产物在册情况
  if (input.facts?.inventory) sections.push(input.facts.inventory);
  const target = path;
  if (target) {
    const { importsOut, importedBy, outTwo, inTwo } = graphNeighborhood(analysis, target);
    if (importsOut.length || importedBy.length || outTwo.length || inTwo.length) {
      sections.push(`依赖关系（${target}，含二度邻接）：\n它 import：${joinList(importsOut)}\n被这些文件 import：${joinList(importedBy)}\n二度下游（它 import 的文件再 import）：${joinList(outTwo)}\n二度上游（import 它的文件再被 import）：${joinList(inTwo)}`);
    }
    const calls = callNeighborhoodSection(analysis, target);
    if (calls) sections.push(calls);
  }
  if (path) {
    const bound = excerptForAnchor(input.repoPath, { path, line: 1, label: "绑定文件" }, true, egress);
    if (bound) sections.push(bound);
  }
  const context = clip(sections.filter(Boolean).join("\n\n") || "（暂无可用的代码上下文）", mapContextCap());
  // 技能清单贴在上下文尾部，不进系统提示词
  const skillsBrief = input.skills ? `\n\n${input.skills.brief}` : "";
  const system = overviewSystemPrompt({ searchAvailable: Boolean(input.search) });
  // 历史折叠按本轮已占用的字符数：系统提示词 + 代码上下文 + 技能清单
  const conversation = conversationBlock(input.history, input.content, system.length + context.length + skillsBrief.length);
  const userMessage = `代码上下文：\n${context}${skillsBrief}\n\n${conversation.text}学习者的问题：${input.content}`;

  recordEgress({ repositoryPath: input.repoPath, scene: "map.chat", sessionId: input.threadId, sources: egress, sent: userMessage });
  const result = await runTurn({
    scope: "map",
    provider,
    system,
    user: userMessage,
    temperature: 0.3,
    scene: "map.chat",
    repositoryPath: input.repoPath,
    ...(input.search ? { search: input.search } : {}),
    ...(input.cross ? { cross: input.cross } : {}),
    ...(input.diagram ? { diagram: input.diagram } : {}),
    ...(input.facts ? { facts: input.facts } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.ask ? { ask: input.ask } : {}),
    ...(input.external ? { external: input.external } : {}),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    ...(input.budgetGuard ? { budgetGuard: input.budgetGuard } : {}),
    interruptAtLimit: true,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  const reply = flagTruncatedReply(result.completion.text, result.completion.finishReason === "length") || "（模型未返回内容，请重试。）";
  return {
    reply,
    provider: provider.name,
    usage: result.usage,
    toolRounds: result.rounds,
    ...(result.fileReads.length ? { fileReads: result.fileReads } : {}),
    ...(result.codeSearches.length ? { codeSearches: result.codeSearches } : {}),
    ...(result.mcpCalls.length ? { mcpCalls: result.mcpCalls } : {}),
    ...(result.skillReads.length ? { skillReads: result.skillReads } : {}),
    ...(result.resumedFromRound === undefined ? {} : { resumedFromRound: result.resumedFromRound }),
    ...(result.stoppedBy === undefined ? {} : { stoppedBy: result.stoppedBy }),
    ...(result.asked === undefined ? {} : { asked: result.asked }),
    ...(result.askRefused === undefined ? {} : { askRefused: result.askRefused }),
    ...(result.interrupted === undefined ? {} : { interrupted: result.interrupted }),
    ...(result.askClaimed === undefined ? {} : { askClaimed: result.askClaimed }),
    conversation: { foldedMessages: conversation.foldedMessages, recalledMessages: conversation.recalledMessages }
  };
}

export async function practiceChat(input: { repoPath: string; exercise: Exercise; content: string; history?: ScopedChatTurn[]; provider: LlmProvider; threadId?: string; signal?: AbortSignal; skills?: SkillsToolContext;   /** 过程事件回调。 */ onProgress?: (progress: MapChatProgress) => void }): Promise<ScopedChatResult> {
  const exercise = input.exercise;
  const sections: string[] = [`题型：${exercise.kind}\n题目：${exercise.title}\n${exercise.prompt}`];
  const egress: EgressCollector = [];
  if (exercise.options?.length) {
    sections.push(`选项：\n${exercise.options.map((option) => `- ${option.id}. ${option.label}${option.detail ? `（${option.detail}）` : ""}`).join("\n")}`);
  }
  excerptsWithinBudget(input.repoPath, exercise.anchors.slice(0, 3), false, egress).forEach((block) => sections.push(block));
  const context = clip(sections.filter(Boolean).join("\n\n"), practiceContextCap());
  const system = `${exerciseQaSystemPrompt()}${input.skills ? `\n\n${input.skills.brief}` : ""}`;
  const conversation = conversationBlock(input.history, input.content, system.length + context.length);
  const user = `练习上下文：\n${context}\n\n${conversation.text}学习者的追问：${input.content}`;
  recordEgress({ repositoryPath: input.repoPath, scene: "practice.chat", sessionId: input.threadId, sources: egress, sent: user });
  const result = await runTurn({ scope: "practice", provider: input.provider, system, user, temperature: 0.3, scene: "practice.chat", repositoryPath: input.repoPath, ...(input.skills ? { skills: input.skills } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  return {
    reply: flagTruncatedReply(result.completion.text, result.completion.finishReason === "length"),
    provider: input.provider.name,
    usage: result.usage,
    toolRounds: result.rounds,
    ...(result.skillReads.length ? { skillReads: result.skillReads } : {}),
    conversation: { foldedMessages: conversation.foldedMessages, recalledMessages: conversation.recalledMessages }
  };
}
