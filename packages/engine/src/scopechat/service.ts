import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CourseNode, Exercise, RepositoryAnalysis, SourceAnchor } from "@codebase-tutor/shared";
import type { LlmMessage, LlmProvider, LlmToolCall, LlmUsage } from "../llm/provider.js";
import { isWithin } from "../lib.js";
import { READ_FILE_TOOL, executeReadFile } from "./tools.js";

/**
  作用域对话（宏观设计 map / 练习评估 practice）：
  单轮 LLM 开放讨论——不是教学状态机（无阶段/提示阶梯），判分权不涉及。
  上下文全部来自静态分析事实（依赖图、课程节点、练习题面 + 源码摘录）；
  练习的标准答案/锚点**不进入**上下文（防泄题：模型不该知道判分答案）。
  宏观设计作用域额外注入项目结构全景（全量路径清单 + 二度依赖邻居）——
  全局视野对全局问题必要，且路径/边清单成本远低于源码全文；源码仍只给锚点摘录。
  */

const MAX_EXCERPT_LINES = 48;
/** 锚点摘录总预算：摘录是「定位用的上下文」，不是全文阅读——更深的代码由模型经 read_file 按需拉取。
    实测 3 锚点 × 80 行 ≈ 11k 字符，是 map_chat 单次输入的最大组成部分。 */
const EXCERPTS_TOTAL_CHARS = 8_000;
const PRACTICE_CONTEXT_CHARS = 12_000;
const MAP_CONTEXT_CHARS = 20_000;
const MAX_PANORAMA_ENTRIES = 20;

/** mapChat 工具循环预算：最多 3 轮读文件、每次对话累计 4 个文件——控制推理模型的逐轮 reasoning 成本与延迟。 */
const MAP_MAX_TOOL_ROUNDS = 3;
const MAP_MAX_TOOL_CALLS = 4;

export interface FileReadRecord {
  path: string;
  lines?: number;
  truncated: boolean;
  denied: boolean;
  error?: string;
}

/** mapChat 过程事件：供 SSE 端点透传给 GUI 显示「回复生成中 / 正在读取 xx」。 */
export type MapChatProgress =
  | { type: "thinking"; round: number }
  | { type: "reading"; path: string };

export interface ScopedChatResult {
  reply: string;
  provider: string;
  usage?: LlmUsage;
  /** mapChat 专用：本次对话的 read_file 调用审计（供 server 逐条记 journal）。 */
  fileReads?: FileReadRecord[];
}

/** 按锚点取带行号的源码摘录（锚点行前后展开，受 MAX_EXCERPT_LINES 与总预算约束）。路径越界或读不到时返回空串。 */
function excerptForAnchor(repoPath: string, anchor: SourceAnchor): string {
  try {
    const absolute = join(repoPath, anchor.path);
    if (!isWithin(repoPath, absolute)) return "";
    const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    const start = Math.max(0, (anchor.line ?? 1) - 12);
    const end = Math.min(lines.length, start + MAX_EXCERPT_LINES);
    const numbered = lines.slice(start, end).map((line, index) => `${start + index + 1}| ${line}`).join("\n");
    return `文件 ${anchor.path}（第 ${start + 1}-${end} 行）：\n${numbered}`;
  } catch {
    return "";
  }
}

/** 逐个拼接摘录直到总预算用尽；预算内放不下后续锚点时明示省略（不静默丢信息）。 */
function excerptsWithinBudget(repoPath: string, anchors: SourceAnchor[]): string[] {
  const blocks: string[] = [];
  let used = 0;
  for (const anchor of anchors) {
    const block = excerptForAnchor(repoPath, anchor);
    if (!block) continue;
    if (used + block.length > EXCERPTS_TOTAL_CHARS) {
      blocks.push(`（${anchor.path} 等其余锚点的摘录超出上下文预算已省略，需要时可用 read_file 查看。）`);
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
    const shown = names.length > MAX_PANORAMA_ENTRIES ? `${names.slice(0, MAX_PANORAMA_ENTRIES).join("、")}…等 ${names.length} 个` : names.join("、");
    return directory ? `- ${directory}/（${names.length}）：${shown}` : `- （根目录）：${shown}`;
  });
  return `项目结构全景（${paths.length} 个已分析文件，按目录分组）：\n${lines.join("\n")}`;
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

const MAP_SYSTEM_PROMPT = `你是嵌入在代码学习工具里的宏观设计讨论伙伴。学习者正在浏览项目的代码地图，会围绕项目结构、模块边界、依赖关系提问。

规则：
- 「项目结构全景」是已分析文件的完整清单，「依赖关系」含一度与二度邻接——全局性问题优先依据这些回答。
- 只基于「代码上下文」与 read_file 工具取回的内容讨论：文件路径、import 关系、源码、节点摘要。
- 需要查看某个文件的实现细节时调用 read_file（给出仓库内相对路径，可用 offset/limit 取指定行窗口）；不要凭空推测未读过的代码。
- 严格区分事实与推断：来自上下文的标明出处（文件路径:行号），推断要明说「这是推断」。
- 上下文没有的信息（运行时行为、历史决策、外部系统）直接说不确定，不要编造。
- 用简洁段落回答；可以提出 1 个值得学习者进一步验证的问题。`;

function addUsage(total: LlmUsage | undefined, addition?: LlmUsage): LlmUsage | undefined {
  if (!addition) return total;
  if (!total) return { inputTokens: addition.inputTokens, outputTokens: addition.outputTokens };
  return { inputTokens: total.inputTokens + addition.inputTokens, outputTokens: total.outputTokens + addition.outputTokens };
}

function readPathHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { path?: unknown };
    return typeof parsed.path === "string" ? parsed.path : "";
  } catch {
    return "";
  }
}

/** micro_compact（借鉴 Claude Code s06 的分级压缩）：发给下一轮前，只保留最近一轮的 tool 结果原文，
    更早轮次的 tool 内容替换为短占位符（模型忘了可再次调用 read_file 重取——结果可再生，不值得逐轮重付）；
    早期 assistant 的 reasoningContent 一并丢弃（后续轮不需要重放思考，推理 token 是账单大头）。
    最近一轮 assistant 的 reasoningContent 保留——部分协议要求 tool 调用轮回传 reasoning_content。 */
function compactToolHistory(messages: LlmMessage[], placeholderChars = 240): void {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && messages[index].toolCalls?.length) {
      lastAssistant = index;
      break;
    }
  }
  if (lastAssistant <= 0) return;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (index < lastAssistant && message.role === "assistant") message.reasoningContent = undefined;
    if (index < lastAssistant && message.role === "tool" && message.content.length > placeholderChars) {
      message.content = `${message.content.slice(0, placeholderChars)}\n…（早期读取结果已省略以控制上下文，需要完整内容可再次调用 read_file。）`;
    }
  }
}

export async function mapChat(input: { repoPath: string; analysis: RepositoryAnalysis; node?: CourseNode; path?: string; content: string; provider: LlmProvider; onProgress?: (progress: MapChatProgress) => void }): Promise<ScopedChatResult> {
  const { analysis, node, path, provider } = input;
  const sections: string[] = [];
  const panorama = structurePanorama(analysis);
  if (panorama) sections.push(panorama);
  if (node) {
    const children = node.children.map((child) => `- ${child.title}（${child.kind}）`).join("\n");
    sections.push(`当前节点：${node.title}（${node.kind}）\n摘要：${node.summary}${children ? `\n子节点：\n${children}` : ""}`);
    excerptsWithinBudget(input.repoPath, node.anchors.slice(0, 3)).forEach((block) => sections.push(block));
  }
  const target = path ?? node?.anchors[0]?.path;
  if (target) {
    const { importsOut, importedBy, outTwo, inTwo } = graphNeighborhood(analysis, target);
    if (importsOut.length || importedBy.length || outTwo.length || inTwo.length) {
      sections.push(`依赖关系（${target}，含二度邻接）：\n它 import：${joinList(importsOut)}\n被这些文件 import：${joinList(importedBy)}\n二度下游（它 import 的文件再 import）：${joinList(outTwo)}\n二度上游（import 它的文件再被 import）：${joinList(inTwo)}`);
    }
  }
  if (path && (!node || !node.anchors.some((anchor) => anchor.path === path))) {
    sections.push(excerptForAnchor(input.repoPath, { path, line: 1, label: "绑定文件" }));
  }
  const context = clip(sections.filter(Boolean).join("\n\n") || "（暂无可用的代码上下文）", MAP_CONTEXT_CHARS);
  const userMessage = `代码上下文：\n${context}\n\n学习者的问题：${input.content}`;

  /** 工具循环历史：messages[0] 恒为原始 user 消息（代码上下文 + 学习者的问题）。
      后续轮次必须完整携带——provider 提供 messages 时会忽略 user 字段，
      若首轮 user 不进 messages，工具调用后的轮次将同时丢失上下文与问题（模型只能靠读到的文件反推意图）。 */
  const onProgress = input.onProgress;
  const messages: LlmMessage[] = [{ role: "user", content: userMessage }];
  onProgress?.({ type: "thinking", round: 1 });
  let completion = await provider.complete({
    system: MAP_SYSTEM_PROMPT,
    user: userMessage,
    tools: [READ_FILE_TOOL],
    maxTokens: 700,
    temperature: 0.3
  });
  const fileReads: FileReadRecord[] = [];
  let usage: LlmUsage | undefined = addUsage(undefined, completion.usage);
  let rounds = 0;
  while (completion.toolCalls?.length) {
    if (rounds >= MAP_MAX_TOOL_ROUNDS || fileReads.length >= MAP_MAX_TOOL_CALLS) {
      // 轮数/次数预算用尽：对每个未应答的 tool_call 给出拒绝结果，再做一轮不带工具的收尾回答。
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: "已达到本次对话的读文件上限，请基于已有上下文直接回答。" });
      }
      onProgress?.({ type: "thinking", round: rounds + 2 });
      compactToolHistory(messages);
      completion = await provider.complete({ system: MAP_SYSTEM_PROMPT, messages, maxTokens: 700, temperature: 0.3 });
      usage = addUsage(usage, completion.usage);
      break;
    }
    rounds += 1;
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
    for (const call of completion.toolCalls) {
      if (call.name !== READ_FILE_TOOL.name) {
        messages.push({ role: "tool", toolCallId: call.id, content: `未知工具 ${call.name}；只支持 read_file。` });
        continue;
      }
      onProgress?.({ type: "reading", path: readPathHint(call.argumentsJson) });
      const outcome = executeReadFile(input.repoPath, call.argumentsJson);
      fileReads.push(outcome.audit);
      messages.push({ role: "tool", toolCallId: call.id, content: outcome.content });
    }
    onProgress?.({ type: "thinking", round: rounds + 1 });
    compactToolHistory(messages);
    completion = await provider.complete({ system: MAP_SYSTEM_PROMPT, messages, tools: [READ_FILE_TOOL], maxTokens: 700, temperature: 0.3 });
    usage = addUsage(usage, completion.usage);
  }
  const reply = completion.text || "（模型未返回内容，请重试。）";
  return { reply, provider: provider.name, usage, fileReads: fileReads.length ? fileReads : undefined };
}

const PRACTICE_SYSTEM_PROMPT = `你是嵌入在代码学习工具里的练习答疑助手。学习者正在做一道针对本仓库的练习（可能是预测输出、修改定位或影响分析，也可能是开放题），会就题目和涉及代码追问。

规则：
- 只基于「练习题目」和「源码摘录」回答，引用代码时给出 文件路径:行号。
- 优先讲清判断依据和推理路径，帮助学习者自己得出结论；如果学习者明确要求答案，先给出推理关键行，再给结论。
- 不要编造题目和源码里不存在的信息；判分标准没有提供给你，不要声称知道标准答案。
- 用简洁段落回答。`;

export async function practiceChat(input: { repoPath: string; exercise: Exercise; content: string; provider: LlmProvider }): Promise<ScopedChatResult> {
  const exercise = input.exercise;
  const sections: string[] = [`题型：${exercise.kind}\n题目：${exercise.title}\n${exercise.prompt}`];
  if (exercise.options?.length) {
    sections.push(`选项：\n${exercise.options.map((option) => `- ${option.id}. ${option.label}${option.detail ? `（${option.detail}）` : ""}`).join("\n")}`);
  }
  excerptsWithinBudget(input.repoPath, exercise.anchors.slice(0, 3)).forEach((block) => sections.push(block));
  const context = clip(sections.filter(Boolean).join("\n\n"), PRACTICE_CONTEXT_CHARS);
  const completion = await input.provider.complete({
    system: PRACTICE_SYSTEM_PROMPT,
    user: `练习上下文：\n${context}\n\n学习者的追问：${input.content}`,
    maxTokens: 700,
    temperature: 0.3
  });
  return { reply: completion.text, provider: input.provider.name, usage: completion.usage };
}
