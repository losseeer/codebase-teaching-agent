import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CourseNode, Exercise, RepositoryAnalysis, SourceAnchor } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { isWithin } from "../lib.js";

/**
  作用域对话（宏观设计 map / 练习评估 practice）：
  单轮 LLM 开放讨论——不是教学状态机（无阶段/提示阶梯），判分权不涉及。
  上下文全部来自静态分析事实（依赖图、课程节点、练习题面 + 源码摘录）；
  练习的标准答案/锚点**不进入**上下文（防泄题：模型不该知道判分答案）。
  */

const MAX_EXCERPT_LINES = 80;
const MAX_CONTEXT_CHARS = 12_000;

export interface ScopedChatResult {
  reply: string;
  provider: string;
  usage?: LlmUsage;
}

/** 按锚点取带行号的源码摘录（锚点行前后展开，上限 MAX_EXCERPT_LINES 行）。路径越界或读不到时返回空串。 */
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

function clip(text: string): string {
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n…（上下文过长已截断）` : text;
}

/** 依赖图中某文件的直接邻居：它 import 的文件 + import 它的文件（反向可达一层）。 */
function graphNeighbors(analysis: RepositoryAnalysis, path?: string): { importsOut: string[]; importedBy: string[] } {
  if (!path) return { importsOut: [], importedBy: [] };
  const importsOut = analysis.graph.imports[path] ?? [];
  const importedBy = Object.entries(analysis.graph.imports)
    .filter(([source]) => source !== path)
    .filter(([, targets]) => targets.includes(path))
    .map(([source]) => source);
  return { importsOut, importedBy };
}

const MAP_SYSTEM_PROMPT = `你是嵌入在代码学习工具里的宏观设计讨论伙伴。学习者正在浏览项目的代码地图，会围绕项目结构、模块边界、依赖关系提问。

规则：
- 只基于「代码上下文」里给出的事实讨论：文件路径、import 关系、源码摘录、节点摘要。
- 严格区分事实与推断：来自上下文的标明出处（文件路径:行号），推断要明说「这是推断」。
- 上下文没有的信息（运行时行为、历史决策、外部系统）直接说不确定，不要编造。
- 用简洁段落回答；可以提出 1 个值得学习者进一步验证的问题。`;

export async function mapChat(input: { repoPath: string; analysis: RepositoryAnalysis; node?: CourseNode; path?: string; content: string; provider: LlmProvider }): Promise<ScopedChatResult> {
  const { analysis, node, path, provider } = input;
  const sections: string[] = [];
  if (node) {
    const children = node.children.map((child) => `- ${child.title}（${child.kind}）`).join("\n");
    sections.push(`当前节点：${node.title}（${node.kind}）\n摘要：${node.summary}${children ? `\n子节点：\n${children}` : ""}`);
    for (const anchor of node.anchors.slice(0, 3)) sections.push(excerptForAnchor(input.repoPath, anchor));
  }
  const target = path ?? node?.anchors[0]?.path;
  if (target) {
    const { importsOut, importedBy } = graphNeighbors(analysis, target);
    if (importsOut.length || importedBy.length) {
      sections.push(`依赖关系（${target}）：\n它 import：${importsOut.join("、") || "（无）"}\n被这些文件 import：${importedBy.join("、") || "（无）"}`);
    }
  }
  if (path && (!node || !node.anchors.some((anchor) => anchor.path === path))) {
    sections.push(excerptForAnchor(input.repoPath, { path, line: 1, label: "绑定文件" }));
  }
  const context = clip(sections.filter(Boolean).join("\n\n") || "（暂无可用的代码上下文）");
  const completion = await provider.complete({
    system: MAP_SYSTEM_PROMPT,
    user: `代码上下文：\n${context}\n\n学习者的问题：${input.content}`,
    maxTokens: 700,
    temperature: 0.3
  });
  return { reply: completion.text, provider: provider.name, usage: completion.usage };
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
  for (const anchor of exercise.anchors.slice(0, 3)) sections.push(excerptForAnchor(input.repoPath, anchor));
  const context = clip(sections.filter(Boolean).join("\n\n"));
  const completion = await input.provider.complete({
    system: PRACTICE_SYSTEM_PROMPT,
    user: `练习上下文：\n${context}\n\n学习者的追问：${input.content}`,
    maxTokens: 700,
    temperature: 0.3
  });
  return { reply: completion.text, provider: input.provider.name, usage: completion.usage };
}
