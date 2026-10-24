import { id } from "../ids.js";
import type { Exercise, FadedState, RepositoryAnalysis, RepositoryIndex, TeachingProgress, TutorMessage, TutorSession } from "@codebase-tutor/shared";
import { policyFor } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmProvider, LlmUsage } from "../llm/provider.js";
import { flagTruncatedReply } from "../llm/provider.js";
import { CONTEXT_SHARE, contextShare } from "../llm/context-window.js";
import { type ConversationBlock, renderConversation } from "../llm/conversation.js";
import { callNeighborhoodSection } from "../depgraph/neighbors.js";
import type { FileReadRecord } from "../source/read-file.js";
import type { CodeSearchRecord, SearchCorpus } from "../source/search-code.js";
import type { CrossRepoContext, ExternalToolContext, FactsToolContext, ReadToolProgress, SetDiagramToolContext, SkillsToolContext, TurnCheckpointChannel, TurnStopReason } from "../source/tool-loop.js";
import { completeWithReadTool, completeWithSkillTool } from "../source/tool-loop.js";
import { recordEgress, type EgressCollector } from "../security/egress-log.js";
import type { ScopeRef } from "../source/scope-ref.js";
import type { McpCallAudit } from "../integrations/clients.js";
import { assembleContext } from "./context-teaching.js";
import { graphNeighborhood, joinList, mapContextCap, scopeSection, structurePanorama } from "./context-canvas.js";
import { excerptForAnchor, excerptsWithinBudget } from "./context-excerpt.js";
import { exerciseQaSystemPrompt, overviewSystemPrompt, teachingSystemPrompt } from "./prompts.js";

/**
  回合装配与开火的单入口：三个作用域（代码教学 / 宏观设计 map / 练习答疑 practice）各自的入口先装配上下文，
  再全部交给 `runTurn`——这里是工具循环（`source/tool-loop.ts`）之外唯一发射 provider 的地方。

  作用域对话（宏观设计 map / 练习评估 practice）：单轮 LLM 开放讨论——不是教学状态机（无阶段/提示阶梯），
  判分权不涉及。上下文全部来自静态分析事实（依赖图、画布上送的文件清单、练习题面 + 源码摘录）；
  练习的标准答案/锚点不进入上下文（防泄题：模型不该知道判分答案），也不提供 read_file 工具。
  map 额外注入项目结构全景与依赖/调用邻接——全局视野对全局问题必要，且路径/边清单成本远低于源码全文；
  更深的代码由模型经 read_file 按需拉取，server 传入 search 语料时才另开放 search_code（只回位置与职责，不占读文件额度）。
  系统提示词统一由 `turn/prompts.ts` 构建（与代码教学共用 styleBrief 口径与作用域边界），本文件不自带副本；
  style 由 server 路由从请求里取用户当前风格档位后传入（默认 50 = 普通档）。
  上下文必须承认自己看到的是多大一片：作用域清单与已分析集交集为空时不注入作用域段，只在全景里作答。
  */

/**
  问答回合的过程事件：一个回合里模型实际做的事（读代码 / 检索 / 组织回复）。
  server 把它经本请求的 SSE 响应流发为 `progress` 事件，GUI 显示成 Agent 侧栏里的过程提示行。
  形状已上收 `shared`（`TeachingProgress`）：过程帧的种类是引擎与界面的共同契约，不由两边各抄一遍字面量。
  */
export type { TeachingProgress };

/** 问答回合的工具循环预算：比宏观设计更紧——这一域要的是「看一眼那一行」，不是通读实现。 */
const TEACHING_MAX_TOOL_ROUNDS = 2;
const TEACHING_MAX_TOOL_CALLS = 3;

/** 工具循环两头都设上限：控制推理模型的逐轮 reasoning 成本与延迟。 */
const MAP_MAX_TOOL_ROUNDS = 3;
const MAP_MAX_TOOL_CALLS = 4;

const practiceContextCap = () => contextShare(CONTEXT_SHARE.practiceContext);

/** 同一线程里此前几轮的问答原文，由引擎按 threadId 从库里取；追问的指代（「这一点展开讲」）要靠它解析。 */
export interface ScopedChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
  历史窗口不再在这里定：整段线程交给 `llm/conversation.ts` 按窗口占用决定折不折。
  占位与找回的口径三作用域共用一份，代码问答那边改一个比例，这边跟着变。
*/
function conversationBlock(history: ScopedChatTurn[] | undefined, query: string, usedCharacters: number): ConversationBlock {
  return renderConversation({ turns: history ?? [], query, usedCharacters });
}

/** mapChat 过程事件：供 SSE 端点透传给 GUI 显示「回复生成中 / 正在读取 xx」。 */
export type MapChatProgress = ReadToolProgress;

export interface ScopedChatResult {
  reply: string;
  provider: string;
  usage?: LlmUsage;
  /** mapChat 专用：本次对话的 read_file 调用审计（供 server 逐条记 journal）。 */
  fileReads?: FileReadRecord[];
  /** mapChat 专用：本次对话的 search_code 调用审计（供 server 逐条记 journal code_search）。 */
  codeSearches?: CodeSearchRecord[];
  /** mapChat 专用：工具循环实际轮数（供 server 记 journal loop_round）。 */
  toolRounds: number;
  /** 本回合从第几轮的检查点接上来续跑的；没续跑就没这个字段。 */
  resumedFromRound?: number;
  /** 回合被预算闸掐断过（不是模型答完，也不是用户停止）。 */
  stoppedBy?: TurnStopReason;
  /** mapChat 专用：本回合打过的外部工具（供 server 逐条记 journal mcp_call，失败也在里面）。 */
  mcpCalls?: McpCallAudit[];
  /** mapChat 专用：本回合取过的技能正文（供 server 记 journal skill_read）。 */
  skillReads?: { skill: string; chars: number; found: boolean }[];
  /** 本轮对话历史的折叠读数：折了几条、又从折叠段找回几条（供 journal 回答「这条回复是在看过多少历史的前提下写的」）。 */
  conversation: { foldedMessages: number; recalledMessages: number };
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（上下文过长已截断）` : text;
}

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
  /** 外部中止信号（只有用户点「停止生成」会置位）：贯穿工具循环。 */
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

export interface RunTurnInput {
  /** 作用域：map 与 teaching（有仓库路径时）走工具循环；practice 与没有仓库路径的 teaching 单轮调用。 */
  scope: "teaching" | "map" | "practice";
  provider: LlmProvider;
  /** 装配好的系统提示词与本轮用户消息：文本由各作用域入口现拼，本函数不再加工。 */
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  /** LLM 工作日志的场景标签（teaching.turn / map.chat / practice.chat），透传给每一轮调用。 */
  scene: string;
  /** 已分析仓库根：read_file 只能在此范围内读取；省略即不走工具循环。 */
  repositoryPath?: string;
  /** 工具循环的轮数与读文件上限：只在走循环时有意义。 */
  maxRounds?: number;
  maxCalls?: number;
  search?: SearchCorpus;
  cross?: CrossRepoContext;
  diagram?: SetDiagramToolContext;
  facts?: FactsToolContext;
  skills?: SkillsToolContext;
  external?: ExternalToolContext;
  checkpoint?: TurnCheckpointChannel;
  budgetGuard?: () => string | undefined;
  signal?: AbortSignal;
  /** 工具循环的原始过程事件：map 直接透传给 SSE，teaching 在外面包一层措辞再给 GUI。 */
  onProgress?: (progress: ReadToolProgress) => void;
}

export interface RunTurnResult {
  completion: LlmCompletion;
  usage?: LlmUsage;
  /** 工具循环实际轮数（单轮调用为 0）。 */
  rounds: number;
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  mcpCalls: McpCallAudit[];
  skillReads: { skill: string; chars: number; found: boolean }[];
  resumedFromRound?: number;
  stoppedBy?: TurnStopReason;
}

/**
  回合的唯一开火处：有仓库路径且该作用域用工具时走 read_file/search_code 工具循环
  （上下文只给锚点摘录与调用邻接，深度由模型按需拉取）；没有仓库路径时退回单轮调用——工具读不到任何文件，不如不给。
  `usage` 取工具循环的累计值而不是最后一趟的，否则多轮回合的 token 会被少记。 */
export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  if (input.scope !== "practice" && input.repositoryPath) {
    const result = await completeWithReadTool({
      provider: input.provider,
      repoPath: input.repositoryPath,
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      maxRounds: input.maxRounds as number,
      maxCalls: input.maxCalls as number,
      scene: input.scene,
      ...(input.search ? { search: input.search } : {}),
      ...(input.cross ? { cross: input.cross } : {}),
      ...(input.diagram ? { diagram: input.diagram } : {}),
      ...(input.facts ? { facts: input.facts } : {}),
      ...(input.skills ? { skills: input.skills } : {}),
      ...(input.external ? { external: input.external } : {}),
      ...(input.budgetGuard ? { budgetGuard: input.budgetGuard } : {}),
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
      ...(result.stoppedBy === undefined ? {} : { stoppedBy: result.stoppedBy })
    };
  }
  // 练习答疑没有文件面，但装了技能就该能取正文：只给 `read_skill`（和外部工具），两轮封顶。
  // 没装技能时这条不成立，行为与单轮调用逐字一致——「默认关 = 不加」在这里同样生效。
  if (input.scope === "practice" && (input.skills || input.external)) {
    const result = await completeWithSkillTool({
      provider: input.provider,
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      scene: input.scene,
      ...(input.skills ? { skills: input.skills } : {}),
      ...(input.external ? { external: input.external } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    return {
      completion: result.completion,
      ...(result.usage ? { usage: result.usage } : {}),
      rounds: result.rounds,
      fileReads: result.fileReads,
      codeSearches: result.codeSearches,
      mcpCalls: result.mcpCalls,
      skillReads: result.skillReads
    };
  }
  input.onProgress?.({ type: "thinking", round: 1 });
  const completion = await input.provider.complete({ system: input.system, user: input.user, maxTokens: input.maxTokens, temperature: input.temperature, scene: input.scene, ...(input.signal ? { signal: input.signal } : {}) });
  return { completion, ...(completion.usage ? { usage: completion.usage } : {}), rounds: 0, fileReads: [], codeSearches: [], mcpCalls: [], skillReads: [] };
}

/**
  一轮代码问答：provider 必填——没有模型可调用时这条路由直接拒（见 server.ts 的 422 分支），
  不回一段本地启发式文案。「看起来答完了、其实没走模型」是最难查的事故形状。
*/
export async function respondWithProvider(session: TutorSession, scope: ScopeRef, learnerContent: string, provider: LlmProvider, faded?: FadedState, repositoryPath?: string, options: RespondOptions = {}): Promise<TutorReply> {
  const policy = policyFor(session.settings);
  /**
    上下文里放了哪几段仓内源码——由 `assembleContext` 顺带登记，发一次记一次：
    计入审计点贴在发送前、不放在装配里（理由见 `turn/context-teaching.ts` 的 egress 注释）。
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
  const outcome = await runTurn({
    scope: "teaching",
    provider,
    system,
    user,
    maxTokens: 700,
    temperature: 0.2,
    maxRounds: TEACHING_MAX_TOOL_ROUNDS,
    maxCalls: TEACHING_MAX_TOOL_CALLS,
    scene: "teaching.turn",
    ...(repositoryPath ? { repositoryPath } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.cross ? { cross: options.cross } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.external ? { external: options.external } : {}),
    ...(options.budgetGuard ? { budgetGuard: options.budgetGuard } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: (progress: ReadToolProgress): void => { options.onProgress?.(progress.type === "reading" ? { stage: "reading", path: progress.path } : progress.type === "searching" ? { stage: "searching", query: progress.query } : { stage: "thinking", round: progress.round }); } } : {})
  });
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
    toolRounds: outcome.rounds
  };
}

/**
  map 作用域的一轮对话。
  写工具（`set_diagram` 改画布上的结构）只给这一个作用域：
  教学与练习两张脸面对的是代码与题目，画布不在它们面前，给了就是让模型去改用户此刻看不见的东西。
  每个写工具都配一份现状文本进上下文（`inventory`）——有副作用的工具必须先看得见现在是什么，
  否则它只能猜 id（与 `set_diagram` 的画布现场同源）。
*/
export async function mapChat(input: { repoPath: string; analysis: RepositoryAnalysis; scopePaths?: string[]; path?: string; content: string; history?: ScopedChatTurn[]; provider: LlmProvider; style: number; search?: SearchCorpus; cross?: CrossRepoContext; threadId?: string; onProgress?: (progress: MapChatProgress) => void; signal?: AbortSignal; /** 画布上那张图的结构改动（另一个写工具，同样只给 map）：`inventory` 是那份「画布现场」，给了工具就必须给现状。 */ diagram?: SetDiagramToolContext; /** 静态产物的只读门：画结构类回答的证据源。不给就没有 query_facts。 */ facts?: FactsToolContext; /** 技能清单与取正文通道：不给就没有 read_skill 这个工具。 */ skills?: SkillsToolContext; /** 外部 MCP 工具面：不给就没有任何 mcp__ 前缀的工具。 */ external?: ExternalToolContext; /** 回合检查点通道：不给就是纯内存回合（单次提问、没线程）。 */ checkpoint?: TurnCheckpointChannel; /** 每轮开火前的预算闸门（见工具循环）。 */ budgetGuard?: () => string | undefined }): Promise<ScopedChatResult> {
  const { analysis, path, provider } = input;
  const sections: string[] = [];
  /** 本回合放进上下文的源码原文，发出前落进出网清单（见 security/egress-log.ts） */
  const egress: EgressCollector = [];
  const panorama = structurePanorama(analysis);
  if (panorama) sections.push(panorama);
  // 画布上送的文件清单（选中模块时）：只作为作用域提示，未知路径由交集丢弃
  const scope = input.scopePaths?.length ? scopeSection(analysis, input.search, input.scopePaths) : "";
  if (scope) sections.push(scope);
  // 画布现场（有哪几张图、正打开那张的图元 id）：`set_diagram` 必须先把现状给它，
  // 否则「把这条边删掉」这句话在它手上没有答案——只能猜一个 id。
  if (input.diagram?.inventory) sections.push(input.diagram.inventory);
  // 产物在册情况一句话（哪几类、各多少文件）：没有这句，模型会以为「没提过的东西就不存在」而不去查
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
  // 技能清单贴在上下文尾部而不是系统提示词里：系统提示词是前缀缓存的固定段，
  // 每装/卸一份技能就改它等于把每仓的缓存全翻一遍（清单本来就在回合级现算）。
  const skillsBrief = input.skills ? `\n\n${input.skills.brief}` : "";
  const system = overviewSystemPrompt({ style: input.style, searchAvailable: Boolean(input.search) });
  // 折叠判据看的是「本轮已经占掉多少」：系统提示词 + 代码上下文 + 技能清单，对话历史是最后进来的一半
  const conversation = conversationBlock(input.history, input.content, system.length + context.length + skillsBrief.length);
  const userMessage = `代码上下文：\n${context}${skillsBrief}\n\n${conversation.text}学习者的问题：${input.content}`;

  recordEgress({ repositoryPath: input.repoPath, scene: "map.chat", sessionId: input.threadId, sources: egress, sent: userMessage });
  const result = await runTurn({
    scope: "map",
    provider,
    system,
    user: userMessage,
    maxTokens: 1_000,
    temperature: 0.3,
    maxRounds: MAP_MAX_TOOL_ROUNDS,
    maxCalls: MAP_MAX_TOOL_CALLS,
    scene: "map.chat",
    repositoryPath: input.repoPath,
    ...(input.search ? { search: input.search } : {}),
    ...(input.cross ? { cross: input.cross } : {}),
    ...(input.diagram ? { diagram: input.diagram } : {}),
    ...(input.facts ? { facts: input.facts } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.external ? { external: input.external } : {}),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    ...(input.budgetGuard ? { budgetGuard: input.budgetGuard } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  // token 达到预算上限被中止时明示边界（不静默半截句）
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
    conversation: { foldedMessages: conversation.foldedMessages, recalledMessages: conversation.recalledMessages }
  };
}

export async function practiceChat(input: { repoPath: string; exercise: Exercise; content: string; history?: ScopedChatTurn[]; provider: LlmProvider; style: number; threadId?: string; signal?: AbortSignal; skills?: SkillsToolContext }): Promise<ScopedChatResult> {
  const exercise = input.exercise;
  const sections: string[] = [`题型：${exercise.kind}\n题目：${exercise.title}\n${exercise.prompt}`];
  const egress: EgressCollector = [];
  if (exercise.options?.length) {
    sections.push(`选项：\n${exercise.options.map((option) => `- ${option.id}. ${option.label}${option.detail ? `（${option.detail}）` : ""}`).join("\n")}`);
  }
  excerptsWithinBudget(input.repoPath, exercise.anchors.slice(0, 3), false, egress).forEach((block) => sections.push(block));
  const context = clip(sections.filter(Boolean).join("\n\n"), practiceContextCap());
  const system = `${exerciseQaSystemPrompt({ style: input.style })}${input.skills ? `\n\n${input.skills.brief}` : ""}`;
  const conversation = conversationBlock(input.history, input.content, system.length + context.length);
  const user = `练习上下文：\n${context}\n\n${conversation.text}学习者的追问：${input.content}`;
  recordEgress({ repositoryPath: input.repoPath, scene: "practice.chat", sessionId: input.threadId, sources: egress, sent: user });
  const result = await runTurn({ scope: "practice", provider: input.provider, system, user, maxTokens: 700, temperature: 0.3, scene: "practice.chat", ...(input.skills ? { skills: input.skills } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  return {
    reply: flagTruncatedReply(result.completion.text, result.completion.finishReason === "length"),
    provider: input.provider.name,
    usage: result.usage,
    toolRounds: result.rounds,
    ...(result.skillReads.length ? { skillReads: result.skillReads } : {}),
    conversation: { foldedMessages: conversation.foldedMessages, recalledMessages: conversation.recalledMessages }
  };
}
