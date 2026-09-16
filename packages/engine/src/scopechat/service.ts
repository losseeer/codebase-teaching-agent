import { basename, dirname } from "node:path";
import type { CourseNode, Exercise, RepositoryAnalysis, SourceAnchor } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { callNeighborhoodSection } from "../depgraph/neighbors.js";
import { exerciseQaSystemPrompt, overviewSystemPrompt } from "../harness/prompts.js";
import { sliceExcerpt } from "../source/excerpt.js";
import type { FileReadRecord } from "../source/read-file.js";
import { completeWithReadTool, type ReadToolProgress } from "../source/tool-loop.js";

/**
  作用域对话（宏观设计 map / 练习评估 practice）：
  单轮 LLM 开放讨论——不是教学状态机（无阶段/提示阶梯），判分权不涉及。
  上下文全部来自静态分析事实（依赖图、课程节点、练习题面 + 源码摘录）；
  练习的标准答案/锚点**不进入**上下文（防泄题：模型不该知道判分答案），也不提供 read_file 工具。
  宏观设计作用域额外注入项目结构全景（全量路径清单 + 二度依赖邻居 + 调用邻接）——
  全局视野对全局问题必要，且路径/边清单成本远低于源码全文；源码按锚点摘录，需要时由模型经 read_file 按需拉取。
  两个作用域的系统提示词统一由 harness/prompts.ts 构建（与代码教学共用 styleBrief 口径与作用域边界），
  本文件不再自带副本；style 由 server 路由从请求里取用户当前滑块档位后传入（缺省 50 = 中性）。
  */

// 摘录窗口：符号边界不可用时回落到锚点前 12 行 / 后 35 行（合计 48 行）
const EXCERPT_BEFORE_LINES = 12;
const EXCERPT_AFTER_LINES = 35;
/** 符号边界可信上限（行）：超过即只取符号开头，避免超大函数吃掉整个预算 */
const MAX_SYMBOL_LINES = 120;
/** 单块摘录字符上限 */
const MAX_EXCERPT_BLOCK_CHARS = 3_200;
/** 锚点摘录总预算：摘录是「定位用的上下文」，不是全文阅读——更深的代码由模型经 read_file 按需拉取。 */
const EXCERPTS_TOTAL_CHARS = 8_000;
const PRACTICE_CONTEXT_CHARS = 12_000;
const MAP_CONTEXT_CHARS = 20_000;
const MAX_PANORAMA_ENTRIES = 20;

/** mapChat 工具循环预算：最多 3 轮读文件、每次对话累计 4 个文件——控制推理模型的逐轮 reasoning 成本与延迟。 */
const MAP_MAX_TOOL_ROUNDS = 3;
const MAP_MAX_TOOL_CALLS = 4;

/** mapChat 过程事件（对外契约名保持不变）：供 SSE 端点透传给 GUI 显示「回复生成中 / 正在读取 xx」。 */
export type MapChatProgress = ReadToolProgress;

export interface ScopedChatResult {
  reply: string;
  provider: string;
  usage?: LlmUsage;
  /** mapChat 专用：本次对话的 read_file 调用审计（供 server 逐条记 journal）。 */
  fileReads?: FileReadRecord[];
}

/** 按锚点取带行号的源码摘录：符号边界优先、窗口兜底（规则见 source/excerpt.ts）。路径越界或读不到返回空串。 */
function excerptForAnchor(repoPath: string, anchor: SourceAnchor, readHint: boolean): string {
  const slice = sliceExcerpt(
    repoPath,
    { path: anchor.path, line: anchor.line, endLine: anchor.endLine },
    { before: EXCERPT_BEFORE_LINES, after: EXCERPT_AFTER_LINES, maxSymbolLines: MAX_SYMBOL_LINES, maxChars: MAX_EXCERPT_BLOCK_CHARS }
  );
  if (!slice) return "";
  const numbered = slice.lines.map((item) => `${item.line}| ${item.text}`).join("\n");
  const total = slice.to < slice.totalLines || slice.truncated ? `，共 ${slice.totalLines} 行` : "";
  const symbol = slice.mode === "symbol" && slice.symbolEnd !== undefined && slice.symbolEnd !== slice.to ? `，符号结束于第 ${slice.symbolEnd} 行` : "";
  const tail = slice.truncated ? `\n…（摘录已截断${readHint ? "，其余部分可用 read_file 查看" : ""}）` : "";
  return `文件 ${slice.path}（第 ${slice.from}-${slice.to} 行${total}${symbol}）：\n${numbered}${tail}`;
}

/** 逐个拼接摘录直到总预算用尽；预算内放不下后续锚点时明示省略（不静默丢信息）。 */
function excerptsWithinBudget(repoPath: string, anchors: SourceAnchor[], readHint: boolean): string[] {
  const blocks: string[] = [];
  let used = 0;
  for (const anchor of anchors) {
    const block = excerptForAnchor(repoPath, anchor, readHint);
    if (!block) continue;
    if (used + block.length > EXCERPTS_TOTAL_CHARS) {
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

export async function mapChat(input: { repoPath: string; analysis: RepositoryAnalysis; node?: CourseNode; path?: string; content: string; provider: LlmProvider; style: number; onProgress?: (progress: MapChatProgress) => void }): Promise<ScopedChatResult> {
  const { analysis, node, path, provider } = input;
  const sections: string[] = [];
  const panorama = structurePanorama(analysis);
  if (panorama) sections.push(panorama);
  if (node) {
    const children = node.children.map((child) => `- ${child.title}（${child.kind}）`).join("\n");
    sections.push(`当前节点：${node.title}（${node.kind}）\n摘要：${node.summary}${children ? `\n子节点：\n${children}` : ""}`);
    excerptsWithinBudget(input.repoPath, node.anchors.slice(0, 3), true).forEach((block) => sections.push(block));
  }
  const target = path ?? node?.anchors[0]?.path;
  if (target) {
    const { importsOut, importedBy, outTwo, inTwo } = graphNeighborhood(analysis, target);
    if (importsOut.length || importedBy.length || outTwo.length || inTwo.length) {
      sections.push(`依赖关系（${target}，含二度邻接）：\n它 import：${joinList(importsOut)}\n被这些文件 import：${joinList(importedBy)}\n二度下游（它 import 的文件再 import）：${joinList(outTwo)}\n二度上游（import 它的文件再被 import）：${joinList(inTwo)}`);
    }
    const calls = callNeighborhoodSection(analysis, target);
    if (calls) sections.push(calls);
  }
  if (path && (!node || !node.anchors.some((anchor) => anchor.path === path))) {
    const bound = excerptForAnchor(input.repoPath, { path, line: 1, label: "绑定文件" }, true);
    if (bound) sections.push(bound);
  }
  const context = clip(sections.filter(Boolean).join("\n\n") || "（暂无可用的代码上下文）", MAP_CONTEXT_CHARS);
  const userMessage = `代码上下文：\n${context}\n\n学习者的问题：${input.content}`;

  const result = await completeWithReadTool({
    provider,
    repoPath: input.repoPath,
    system: overviewSystemPrompt({ style: input.style }),
    user: userMessage,
    maxTokens: 700,
    temperature: 0.3,
    maxRounds: MAP_MAX_TOOL_ROUNDS,
    maxCalls: MAP_MAX_TOOL_CALLS,
    scene: "map.chat",
    ...(input.onProgress ? { onProgress: input.onProgress } : {})
  });
  const reply = result.completion.text || "（模型未返回内容，请重试。）";
  return { reply, provider: provider.name, usage: result.usage, ...(result.fileReads.length ? { fileReads: result.fileReads } : {}) };
}

export async function practiceChat(input: { repoPath: string; exercise: Exercise; content: string; provider: LlmProvider; style: number }): Promise<ScopedChatResult> {
  const exercise = input.exercise;
  const sections: string[] = [`题型：${exercise.kind}\n题目：${exercise.title}\n${exercise.prompt}`];
  if (exercise.options?.length) {
    sections.push(`选项：\n${exercise.options.map((option) => `- ${option.id}. ${option.label}${option.detail ? `（${option.detail}）` : ""}`).join("\n")}`);
  }
  excerptsWithinBudget(input.repoPath, exercise.anchors.slice(0, 3), false).forEach((block) => sections.push(block));
  const context = clip(sections.filter(Boolean).join("\n\n"), PRACTICE_CONTEXT_CHARS);
  const completion = await input.provider.complete({
    system: exerciseQaSystemPrompt({ style: input.style }),
    user: `练习上下文：\n${context}\n\n学习者的追问：${input.content}`,
    maxTokens: 700,
    temperature: 0.3,
    scene: "practice.chat"
  });
  return { reply: completion.text, provider: input.provider.name, usage: completion.usage };
}
