import type { CourseNode, RepositoryAnalysis, TeachingPolicy, TutorMessage } from "@codebase-tutor/shared";
import { callNeighborhoodSection } from "../depgraph/neighbors.js";
import { sliceExcerpt } from "../source/excerpt.js";

const EXCERPT_BEFORE = 7;
const EXCERPT_AFTER = 10;
const MAX_EXCERPTS = 3;
/** 符号边界可信上限（行）：超过即只取符号开头（花括号计数得到的 endLine 可能虚高） */
const MAX_SYMBOL_LINES = 80;
/** 单块摘录字符上限；真实上限在分配时按剩余预算再收紧 */
const MAX_EXCERPT_BLOCK_CHARS = 2_000;
const TRANSCRIPT_WINDOW = 8;
const TRANSCRIPT_LINE_CHARS = 160;
/** 窗口外的抽取式压缩（零 LLM 成本）：更早轮次只保留学习者提问——问题承载话题锚点，导师长答出窗即弃 */
const EARLIER_QUESTIONS = 8;
const DEFAULT_MAXIMUM_CHARACTERS = 9_000;
/** 预算分配留白：避免拼接后正好越界触发尾部截断 */
const BUDGET_MARGIN = 200;

/**
 * 有界教学上下文：节点事实 + 调用邻接 + 锚点附近的真实源码摘录 + 含学习者发言的近期对话 + 更早轮次的问题脉络（抽取式）。
 *
 * 两点与「锚点可靠性」直接相关：
 * 1. 源码摘录走 source/excerpt.ts 的规则——符号边界优先、窗口兜底（不再是无条件 ±N 行）；
 * 2. 摘录预算自适应：先保住节点事实与最近对话（它们是截断的牺牲品且不可再生），剩余预算按锚点均分。
 * repositoryPath 提供时才读取源码；读不到的锚点跳过，被省略或被截断的部分在文本里明示。
 */
export interface TeachingContextInput {
  node: CourseNode;
  policy: TeachingPolicy;
  history: TutorMessage[];
  repositoryPath?: string;
  /** 依赖图：提供时注入「调用关系」（跨文件调用方/被调方 + 同文件符号位置）——只给路径清单，不给源码 */
  analysis?: RepositoryAnalysis;
  maximumCharacters?: number;
}

export function assembleContext(input: TeachingContextInput): string {
  const maximumCharacters = input.maximumCharacters ?? DEFAULT_MAXIMUM_CHARACTERS;
  const { node, policy } = input;
  const transcript = input.history.slice(-TRANSCRIPT_WINDOW).map((message) => {
    const role = message.role === "user" ? "学习者" : "导师";
    return `${role}: ${message.content.replaceAll(/\s+/g, " ").slice(0, TRANSCRIPT_LINE_CHARS)}`;
  }).join("\n");
  // 更早轮次的提问脉络与最近对话同属「不可再生」信息，进受保护尾部（摘录预算让位于它们）
  const earlier = input.history.slice(0, Math.max(0, input.history.length - TRANSCRIPT_WINDOW))
    .filter((message) => message.role === "user" && message.content.trim())
    .slice(-EARLIER_QUESTIONS)
    .map((message) => `- ${message.content.replaceAll(/\s+/g, " ").trim().slice(0, TRANSCRIPT_LINE_CHARS)}`)
    .join("\n");
  const head = [
    `课程节点: ${node.title}`,
    `源码锚点: ${node.anchors.map((anchor) => `${anchor.path}:${anchor.line}`).join(", ") || "无"}`,
    `摘要: ${node.summary}`,
    `风格约束: ${policy.constraints.join("；")}`,
    input.analysis ? callNeighborhoodSection(input.analysis, node.anchors[0]?.path ?? "") : ""
  ].filter(Boolean);
  const tail = [
    earlier ? [`此前问题脉络（更早轮次的学习者提问，按时间序）:\n${earlier}`] : [],
    transcript ? [`最近对话（按时间序，含学习者发言）:\n${transcript}`] : []
  ].flat();
  const excerptBudget = Math.max(0, maximumCharacters - [...head, ...tail].join("\n\n").length - BUDGET_MARGIN);
  const excerpts = input.repositoryPath ? sourceExcerpts(input.repositoryPath, node, excerptBudget) : "";
  const joined = [...head, excerpts, ...tail].filter(Boolean).join("\n\n");
  return joined.length > maximumCharacters
    ? `${joined.slice(0, maximumCharacters)}\n…（上下文超出 ${maximumCharacters} 字符上限已截断）`
    : joined;
}

function sourceExcerpts(repositoryPath: string, node: CourseNode, budget: number): string {
  const anchors = node.anchors.slice(0, MAX_EXCERPTS);
  if (!anchors.length) return "";
  if (budget < BUDGET_MARGIN) {
    const where = anchors.map((anchor) => `${anchor.path}:${anchor.line}`).join("、");
    return `源码摘录：超出上下文预算已省略（${where}），需要时用 read_file 查看。`;
  }
  const perBlock = Math.min(MAX_EXCERPT_BLOCK_CHARS, Math.floor(budget / anchors.length));
  const blocks: string[] = [];
  for (const anchor of anchors) {
    const slice = sliceExcerpt(repositoryPath, anchor, { before: EXCERPT_BEFORE, after: EXCERPT_AFTER, maxSymbolLines: MAX_SYMBOL_LINES, maxChars: perBlock });
    if (!slice) continue;
    const numbered = slice.lines.map((item) => `${item.line}: ${item.text}`).join("\n");
    const note = slice.truncated ? `\n…（摘录已截断，符号到第 ${slice.symbolEnd ?? slice.to} 行；需要其余部分用 read_file 查看）` : "";
    blocks.push(`--- ${slice.path}:${slice.from}-${slice.to} ---\n${numbered}${note}`);
  }
  return blocks.length ? `源码摘录（锚点附近的真实代码）:\n${blocks.join("\n")}` : "";
}
