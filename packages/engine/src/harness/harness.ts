import type { FadedState, RepositoryAnalysis, RepositoryIndex, TeachingProgress, TutorMessage, TutorSession, TutorSettings } from "@codebase-tutor/shared";
import { id } from "../identity.js";
import type { LlmCompletion, LlmProvider, LlmUsage } from "../llm/provider.js";
import { flagTruncatedReply } from "../llm/provider.js";
import { defaultTutorSettings, policyFor, validateSettings } from "../tutor-settings/tutor-settings.js";
import type { FileReadRecord } from "../source/read-file.js";
import type { CodeSearchRecord, SearchCorpus } from "../source/search-code.js";
import type { CrossRepoContext, ExternalToolContext, SkillsToolContext, TurnCheckpointChannel, TurnStopReason } from "../source/tool-loop.js";
import { completeWithReadTool, type ReadToolProgress } from "../source/tool-loop.js";
import { recordEgress, type EgressCollector } from "../security/dataflow.js";
import type { TeachingScope } from "../source/scope.js";
import type { McpCallAudit } from "../external/clients.js";
import { assembleContext } from "./context.js";
import { teachingSystemPrompt } from "./prompts.js";

/** 问答回合的工具循环预算：比宏观设计更紧——这一域要的是「看一眼那一行」，不是通读实现。 */
const TEACHING_MAX_TOOL_ROUNDS = 2;
const TEACHING_MAX_TOOL_CALLS = 3;

/** 代码问答回合的产出：一轮就是「装配上下文 → 工具循环 → 模型回答一次」。 */
export interface TutorReply {
  session: TutorSession;
  assistant: TutorMessage;
  provider: string;
  usage?: LlmUsage;
  /** 本轮 read_file 调用审计（供 server 逐条记 journal file_read）。 */
  fileReads?: FileReadRecord[];
  /** 本轮 search_code 调用审计（供 server 逐条记 journal code_search）。 */
  codeSearches?: CodeSearchRecord[];
  /** 工具循环实际轮数（无仓库路径的单轮调用为 0）。 */
  toolRounds?: number;
  /** 本轮打过的外部工具（供 server 逐条记 journal mcp_call，失败也在里面）。 */
  mcpCalls?: McpCallAudit[];
  /** 本轮取过的技能正文（供 server 记 journal skill_read）。 */
  skillReads?: { skill: string; chars: number; found: boolean }[];
  /** 本轮对话历史的折叠读数（供 server 记 journal loop_round）。 */
  conversation: { foldedMessages: number; recalledMessages: number };
  /** 本回合从第几轮的检查点接上来续跑；没续跑就没这个字段。 */
  resumedFromRound?: number;
  /** 回合被预算闸掐断过。 */
  stoppedBy?: TurnStopReason;
}

/**
  问答回合的过程事件：一个回合里模型实际做的事（读代码 / 检索 / 组织回复）。
  server 把它经本请求的 SSE 响应流发为 `progress` 事件，GUI 显示成 Agent 侧栏里的过程提示行。
  形状已上收 `shared`（`TeachingProgress`）：过程帧的种类是引擎与界面的共同契约，不由两边各抄一遍字面量。
  */
export type { TeachingProgress };

export interface RespondOptions {
  /** 索引：提供时目录作用域可以列出目录内文件。 */
  index?: RepositoryIndex;
  /** 依赖图：提供时上下文注入调用邻接（谁调用它 / 它调用谁 / 同文件符号位置）。 */
  analysis?: RepositoryAnalysis;
  /** search_code 语料（server 侧用 index+analysis+L1 摘要构建）：提供时开放检索工具。 */
  search?: SearchCorpus;
  /** 跨仓上下文（地址簿里还有别的仓时由 server 装配）：给 read_file/search_code 的 repo 参数与 cross_repo_link。 */
  cross?: CrossRepoContext;
  /** 过程事件回调（可选；用于把「正在读 xx 文件」推给 GUI）。 */
  onProgress?: (progress: TeachingProgress) => void;
  /** 外部中止信号（用户点「停止生成」或 SSE 客户端断开）：贯穿工具循环。 */
  signal?: AbortSignal;
  /** 每轮开火前的预算闸门（应用层给）：到线就只再做一次收尾调用。 */
  budgetGuard?: () => string | undefined;
  /** 回合检查点通道：没线程就给空操作通道。 */
  checkpoint?: TurnCheckpointChannel;
  /** 技能清单与取正文通道：不给就没有 read_skill。 */
  skills?: SkillsToolContext;
  /** 外部 MCP 工具面：不给就没有任何 `mcp__` 前缀的工具。 */
  external?: ExternalToolContext;
}

export function createSession(repositoryId: string, scopeRef: string, settings: Partial<TutorSettings> = defaultTutorSettings): TutorSession {
  const normalized = validateSettings(settings);
  return { id: id(), repositoryId, scopeRef, style: normalized.style, settings: normalized, messages: [], createdAt: new Date().toISOString() };
}

/**
  一轮代码问答：provider 必填——没有模型可调用时这条路由直接拒（见 server.ts 的 422 分支），
  不回一段本地启发式文案。「看起来答完了、其实没走模型」是最难查的事故形状。
*/
export async function respondWithProvider(session: TutorSession, scope: TeachingScope, learnerContent: string, provider: LlmProvider, faded?: FadedState, repositoryPath?: string, options: RespondOptions = {}): Promise<TutorReply> {
  const policy = policyFor(session.settings);
  /**
    上下文里放了哪几段仓内源码——由 `assembleContext` 顺带登记，发一次记一次：
    计入审计点贴在发送前、不放在装配里（理由见 `harness/context.ts` 的 egress 注释）。
    */
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
  // 清单贴在上下文尾部而非系统提示词里：系统提示词是前缀缓存的固定段，装卸一份技能就改它等于把每仓缓存全翻一遍。
  const skillsBrief = options.skills ? `\n\n${options.skills.brief}` : "";
  const user = `学习者本轮输入：${learnerContent}\n\n可审计代码上下文：\n${context}${skillsBrief}`;
  if (repositoryPath) recordEgress({ repositoryPath, scene: "teaching.turn", sessionId: session.id, sources: egress, sent: user });
  const outcome = await completeWording({ provider, system, user, ...(repositoryPath ? { repositoryPath } : {}), ...(options.skills ? { skills: options.skills } : {}), ...(options.external ? { external: options.external } : {}), ...(options.search ? { search: options.search } : {}), ...(options.cross ? { cross: options.cross } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.budgetGuard ? { budgetGuard: options.budgetGuard } : {}), ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}) });
  const content = flagTruncatedReply(outcome.completion.text.slice(0, 1_500), outcome.completion.finishReason === "length" || outcome.completion.text.length > 1_500);
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
    toolRounds: outcome.toolRounds
  };
}

/** 措辞调用：有仓库路径时走 read_file/search_code 工具循环（上下文只给锚点摘录与调用邻接，深度由模型按需拉取）；
    没有仓库路径时退回单轮调用——工具读不到任何文件，不如不给。
    `usage` 取工具循环的累计值而不是最后一趟的，否则多轮回合的 token 会被少记。 */
async function completeWording(input: { provider: LlmProvider; system: string; user: string; repositoryPath?: string; search?: SearchCorpus; cross?: CrossRepoContext; skills?: SkillsToolContext; external?: ExternalToolContext; onProgress?: (progress: TeachingProgress) => void; signal?: AbortSignal; budgetGuard?: () => string | undefined; checkpoint?: TurnCheckpointChannel }): Promise<{ completion: LlmCompletion; usage?: LlmUsage; toolRounds: number; fileReads: FileReadRecord[]; codeSearches: CodeSearchRecord[]; mcpCalls: McpCallAudit[]; skillReads: { skill: string; chars: number; found: boolean }[]; resumedFromRound?: number; stoppedBy?: TurnStopReason }> {
  const forwardProgress = (progress: ReadToolProgress): void => {
    input.onProgress?.(progress.type === "reading" ? { stage: "reading", path: progress.path } : progress.type === "searching" ? { stage: "searching", query: progress.query } : { stage: "thinking", round: progress.round });
  };
  if (!input.repositoryPath) {
    input.onProgress?.({ stage: "thinking", round: 1 });
    const completion = await input.provider.complete({ system: input.system, user: input.user, maxTokens: 700, temperature: 0.2, scene: "teaching.turn", ...(input.signal ? { signal: input.signal } : {}) });
    return { completion, ...(completion.usage ? { usage: completion.usage } : {}), toolRounds: 0, fileReads: [], codeSearches: [], mcpCalls: [], skillReads: [] };
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
    ...(input.cross ? { cross: input.cross } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.external ? { external: input.external } : {}),
    ...(input.budgetGuard ? { budgetGuard: input.budgetGuard } : {}),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    ...(input.onProgress ? { onProgress: forwardProgress } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  return {
    completion: result.completion,
    ...(result.usage ? { usage: result.usage } : {}),
    toolRounds: result.rounds,
    fileReads: result.fileReads,
    codeSearches: result.codeSearches,
    mcpCalls: result.mcpCalls,
    skillReads: result.skillReads,
    ...(result.resumedFromRound === undefined ? {} : { resumedFromRound: result.resumedFromRound }),
    ...(result.stoppedBy === undefined ? {} : { stoppedBy: result.stoppedBy })
  };
}
