import { basename, dirname } from "node:path";
import type { Exercise, RepositoryAnalysis, SourceAnchor } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { flagTruncatedReply } from "../llm/provider.js";
import { callNeighborhoodSection } from "../depgraph/neighbors.js";
import { exerciseQaSystemPrompt, overviewSystemPrompt } from "../harness/prompts.js";
import { sliceExcerpt } from "../source/excerpt.js";
import type { FileReadRecord } from "../source/read-file.js";
import type { CodeSearchRecord, SearchCorpus } from "../source/search-code.js";
import type { CrossRepoContext, ExternalToolContext, FactsToolContext, SetDiagramToolContext, SkillsToolContext, TurnCheckpointChannel, TurnStopReason } from "../source/tool-loop.js";
import { completeWithReadTool, type ReadToolProgress } from "../source/tool-loop.js";
import type { McpCallAudit } from "../external/clients.js";
import { CONTEXT_SHARE, contextShare, contextShareLines } from "../llm/context-window.js";
import { type ConversationBlock, renderConversation } from "../llm/conversation.js";
import { recordEgress, type EgressCollector } from "../security/dataflow.js";

/**
  作用域对话（宏观设计 map / 练习评估 practice）：单轮 LLM 开放讨论——不是教学状态机（无阶段/提示阶梯），
  判分权不涉及。上下文全部来自静态分析事实（依赖图、画布上送的文件清单、练习题面 + 源码摘录）；
  练习的标准答案/锚点不进入上下文（防泄题：模型不该知道判分答案），也不提供 read_file 工具。
  map 额外注入项目结构全景与依赖/调用邻接——全局视野对全局问题必要，且路径/边清单成本远低于源码全文；
  更深的代码由模型经 read_file 按需拉取，server 传入 search 语料时才另开放 search_code（只回位置与职责，不占读文件额度）。
  系统提示词统一由 harness/prompts.ts 构建（与代码教学共用 styleBrief 口径与作用域边界），本文件不自带副本；
  style 由 server 路由从请求里取用户当前风格档位后传入（默认 50 = 普通档）。
  上下文必须承认自己看到的是多大一片：作用域清单与已分析集交集为空时不注入作用域段，只在全景里作答。
  */

// 摘录窗口：符号边界不可用时回落到锚点前 12 行 / 后 35 行（合计 48 行）
const EXCERPT_BEFORE_LINES = 12;
const EXCERPT_AFTER_LINES = 35;
/*
  上下文预算全部按窗口份额派生（唯一真源在 `llm/context-window.ts`）：窗口是唯一手填的数，
  这里只声明「哪一类内容占多少」。地板刻意不给——窗口配多小就按多小办事，省略由各处如实说明。
*/
const symbolLineCap = () => contextShareLines(CONTEXT_SHARE.symbolLines, 12);
const excerptBlockCap = () => contextShare(CONTEXT_SHARE.excerptBlock);
const excerptTotalCap = () => contextShare(CONTEXT_SHARE.anchorExcerpts);
const mapContextCap = () => contextShare(CONTEXT_SHARE.mapContext);
const practiceContextCap = () => contextShare(CONTEXT_SHARE.practiceContext);
/** 全景里一个目录最多列多少个文件名：超出只报总数，目录本身不丢。 */
const panoramaPerDirectoryCap = () => Math.max(1, Math.floor(contextShareLines(CONTEXT_SHARE.panorama, 60) / 4));

/** 工具循环两头都设上限：控制推理模型的逐轮 reasoning 成本与延迟。 */
const MAP_MAX_TOOL_ROUNDS = 3;
const MAP_MAX_TOOL_CALLS = 4;

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

/** 按锚点取带行号的源码摘录：符号边界优先、窗口兜底（规则见 source/excerpt.ts）。路径越界或读不到返回空串。 */
function excerptForAnchor(repoPath: string, anchor: SourceAnchor, readHint: boolean, egress?: EgressCollector): string {
  const slice = sliceExcerpt(
    repoPath,
    { path: anchor.path, line: anchor.line, endLine: anchor.endLine },
    { before: EXCERPT_BEFORE_LINES, after: EXCERPT_AFTER_LINES, maxSymbolLines: symbolLineCap(), maxChars: excerptBlockCap() }
  );
  if (!slice) return "";
  const numbered = slice.lines.map((item) => `${item.line}| ${item.text}`).join("\n");
  // 这段就是马上要进请求的源码原文：登记给出网清单（见 security/dataflow.ts）
  egress?.push({ kind: "anchor-excerpt", path: slice.path, from: slice.from, to: slice.to, text: numbered, masked: slice.masked, truncated: slice.truncated || undefined });
  const total = slice.to < slice.totalLines || slice.truncated ? `，共 ${slice.totalLines} 行` : "";
  const symbol = slice.mode === "symbol" && slice.symbolEnd !== undefined && slice.symbolEnd !== slice.to ? `，符号结束于第 ${slice.symbolEnd} 行` : "";
  const tail = slice.truncated ? `\n…（摘录已截断${readHint ? "，其余部分可用 read_file 查看" : ""}）` : "";
  return `文件 ${slice.path}（第 ${slice.from}-${slice.to} 行${total}${symbol}）：\n${numbered}${tail}`;
}

/** 逐个拼接摘录直到总预算用尽；预算内放不下后续锚点时明示省略（不静默丢信息）。 */
function excerptsWithinBudget(repoPath: string, anchors: SourceAnchor[], readHint: boolean, egress?: EgressCollector): string[] {
  const blocks: string[] = [];
  let used = 0;
  for (const anchor of anchors) {
    const block = excerptForAnchor(repoPath, anchor, readHint, egress);
    if (!block) continue;
    if (used + block.length > excerptTotalCap()) {
      const suggest = readHint ? "，需要时可用 read_file 查看" : "";
      blocks.push(`（${anchor.path} 等其余锚点的摘录超出上下文预算已省略${suggest}。）`);
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return blocks;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（上下文过长已截断）` : text;
}

/** 全量路径清单：按目录分组（目录 → 文件名列表），根目录文件单列。来自依赖图已分析文件集。 */
function structurePanorama(analysis: RepositoryAnalysis): string {
  const paths = Object.keys(analysis.graph.imports).sort();
  if (!paths.length) return "";
  const directories = new Map<string, string[]>();
  for (const path of paths) {
    const directory = dirname(path);
    const key = directory === "." ? "" : directory;
    directories.set(key, [...(directories.get(key) ?? []), basename(path)]);
  }
  const lines = [...directories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([directory, names]) => {
    const perDirectory = panoramaPerDirectoryCap();
    const shown = names.length > perDirectory ? `${names.slice(0, perDirectory).join("、")}…等 ${names.length} 个` : names.join("、");
    return directory ? `- ${directory}/（${names.length}）：${shown}` : `- （根目录）：${shown}`;
  });
  return `项目结构全景（${paths.length} 个已分析文件，按目录分组）：\n${lines.join("\n")}`;
}

/** 架构图作用域段最多逐个列出的文件数：大仓模块可上百文件，超出部分明示总数而非全量灌进上下文。 */
const MAX_SCOPE_LISTED = 60;

/** 已分析文件全集：与目录全景同源（imports 的空数组键也算「被分析过」）。 */
function analyzedPathSet(analysis: RepositoryAnalysis): Set<string> {
  const paths = new Set(Object.keys(analysis.graph.imports));
  for (const symbol of analysis.graph.symbols) paths.add(symbol.path);
  return paths;
}

/**
  画布选中模块的作用域段。文件清单由 GUI 随请求上送；
  这里与已分析集求交后列「路径（行数）：L1 职责」。
  与 search_code 同源同口径（复用其语料的 lines/summary 字段），交集为空返回空串（= 没解析到作用域）。
*/
function scopeSection(analysis: RepositoryAnalysis, search: SearchCorpus | undefined, scopePaths: string[]): string {
  const analyzed = analyzedPathSet(analysis);
  const files = [...new Set(scopePaths)].filter((candidate) => analyzed.has(candidate)).sort();
  if (!files.length) return "";
  const corpusOf = search ? new Map(search.entries.map((entry) => [entry.path, entry])) : undefined;
  const lines = files.slice(0, MAX_SCOPE_LISTED).map((file) => {
    const entry = corpusOf?.get(file);
    const meta = entry?.lines === undefined ? "" : `（${entry.lines} 行）`;
    return `- ${file}${meta}${entry?.summary ? `：${entry.summary}` : ""}`;
  });
  const tail = files.length > MAX_SCOPE_LISTED ? `\n…其余 ${files.length - MAX_SCOPE_LISTED} 个文件未列出，需要时可用 search_code 定位。` : "";
  return `当前作用域：学习者在架构图选中的模块，含 ${files.length} 个已分析文件：\n${lines.join("\n")}${tail}`;
}

/** 依赖图中某文件的邻域：一度（直接 import / 被 import）+ 二度（import 的 import / 被被 import），去重排序。 */
function graphNeighborhood(analysis: RepositoryAnalysis, path?: string): {
  importsOut: string[];
  importedBy: string[];
  outTwo: string[];
  inTwo: string[];
} {
  if (!path) return { importsOut: [], importedBy: [], outTwo: [], inTwo: [] };
  const imports = analysis.graph.imports;
  const importsOut = imports[path] ?? [];
  const importedBy = Object.entries(imports)
    .filter(([source]) => source !== path)
    .filter(([, targets]) => targets.includes(path))
    .map(([source]) => source)
    .sort();
  const outTwo = [...new Set(importsOut.flatMap((target) => imports[target] ?? []))]
    .filter((candidate) => candidate !== path && !importsOut.includes(candidate))
    .sort();
  const inTwo = Object.entries(imports)
    .filter(([source, targets]) => source !== path && !importedBy.includes(source) && targets.some((target) => importedBy.includes(target)))
    .map(([source]) => source)
    .sort();
  return { importsOut, importedBy, outTwo, inTwo };
}

function joinList(items: string[]): string {
  return items.join("、") || "（无）";
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
  /** 本回合放进上下文的源码原文，发出前落进出网清单（见 security/dataflow.ts） */
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
  const result = await completeWithReadTool({
    provider,
    repoPath: input.repoPath,
    system,
    user: userMessage,
    maxTokens: 1_000,
    temperature: 0.3,
    maxRounds: MAP_MAX_TOOL_ROUNDS,
    maxCalls: MAP_MAX_TOOL_CALLS,
    scene: "map.chat",
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

export async function practiceChat(input: { repoPath: string; exercise: Exercise; content: string; history?: ScopedChatTurn[]; provider: LlmProvider; style: number; threadId?: string; signal?: AbortSignal }): Promise<ScopedChatResult> {
  const exercise = input.exercise;
  const sections: string[] = [`题型：${exercise.kind}\n题目：${exercise.title}\n${exercise.prompt}`];
  const egress: EgressCollector = [];
  if (exercise.options?.length) {
    sections.push(`选项：\n${exercise.options.map((option) => `- ${option.id}. ${option.label}${option.detail ? `（${option.detail}）` : ""}`).join("\n")}`);
  }
  excerptsWithinBudget(input.repoPath, exercise.anchors.slice(0, 3), false, egress).forEach((block) => sections.push(block));
  const context = clip(sections.filter(Boolean).join("\n\n"), practiceContextCap());
  const system = exerciseQaSystemPrompt({ style: input.style });
  const conversation = conversationBlock(input.history, input.content, system.length + context.length);
  const user = `练习上下文：\n${context}\n\n${conversation.text}学习者的追问：${input.content}`;
  recordEgress({ repositoryPath: input.repoPath, scene: "practice.chat", sessionId: input.threadId, sources: egress, sent: user });
  const completion = await input.provider.complete({
    system,
    user,
    maxTokens: 700,
    temperature: 0.3,
    scene: "practice.chat",
    ...(input.signal ? { signal: input.signal } : {})
  });
  return {
    reply: flagTruncatedReply(completion.text, completion.finishReason === "length"),
    provider: input.provider.name,
    usage: completion.usage,
    toolRounds: 0,
    conversation: { foldedMessages: conversation.foldedMessages, recalledMessages: conversation.recalledMessages }
  };
}
