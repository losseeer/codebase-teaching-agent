import type { RepositoryAnalysis, RepositoryIndex, TeachingPolicy, TutorMessage } from "@codebase-tutor/shared";
import { callNeighborhoodSection } from "../depgraph/neighbors.js";
import { sliceExcerpt } from "../source/excerpt.js";
import { scopeFiles, type TeachingScope } from "../source/scope.js";
import type { EgressCollector } from "../security/dataflow.js";

const EXCERPT_BEFORE = 7;
const EXCERPT_AFTER = 10;
const MAX_EXCERPTS = 3;
/** 符号边界可信上限（行）：超过即只取符号开头（花括号计数得到的 endLine 可能虚高） */
const MAX_SYMBOL_LINES = 80;
/** 单块摘录字符上限；真实上限在分配时按剩余预算再收紧 */
const MAX_EXCERPT_BLOCK_CHARS = 2_000;
const MAX_SCOPE_FILES = 60;
const TRANSCRIPT_WINDOW = 8;
const TRANSCRIPT_LINE_CHARS = 160;
/** 窗口外的抽取式压缩（零 LLM 成本）：更早轮次只保留学习者提问——问题承载话题锚点，导师长答出窗即弃 */
const EARLIER_QUESTIONS = 8;
const DEFAULT_MAXIMUM_CHARACTERS = 9_000;
/** 预算分配留白：避免拼接后正好越界触发尾部截断 */
const BUDGET_MARGIN = 200;

/**
 * 有界教学上下文：作用域（文件/目录）+ 调用邻接 + 文件开头的真实源码摘录 + 近期对话 + 更早问题脉络。
 * 作用域只决定“从哪儿开始看”，具体事实由依赖图与 static_fact 提供，不再依赖课程树。
 */
export interface TeachingContextInput {
  scope: TeachingScope;
  policy: TeachingPolicy;
  history: TutorMessage[];
  repositoryPath?: string;
  index?: RepositoryIndex;
  /** 依赖图：提供时注入「调用关系」（跨文件调用方/被调方 + 同文件符号位置）——只给路径清单，不给源码 */
  analysis?: RepositoryAnalysis;
  maximumCharacters?: number;
  /** 出网登记：本函数把哪几段源码放进上下文，就往后推几条；由真要发请求的调用方在发出前计入审计。 */
  egress?: EgressCollector;
}

export function assembleContext(input: TeachingContextInput): string {
  const maximumCharacters = input.maximumCharacters ?? DEFAULT_MAXIMUM_CHARACTERS;
  const { scope, policy } = input;
  const files = input.index ? scopeFiles(scope, input.index) : [];
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
  const listed = files.slice(0, MAX_SCOPE_FILES).map((file) => file.path);
  const head = [
    `当前作用域: ${scope.kind === "file" ? "文件" : "目录"} ${scope.path}`,
    scope.kind === "dir" ? `目录内已分析文件（${files.length}）：\n${listed.join("\n") || "（空）"}${files.length > MAX_SCOPE_FILES ? `\n…其余 ${files.length - MAX_SCOPE_FILES} 个未列出` : ""}` : "",
    `风格约束: ${policy.constraints.join("；")}`,
    input.analysis && files[0] ? callNeighborhoodSection(input.analysis, files[0].path) : ""
  ].filter(Boolean);
  const tail = [
    earlier ? [`此前问题脉络（更早轮次的学习者提问，按时间序）:\n${earlier}`] : [],
    transcript ? [`最近对话（按时间序，含学习者发言）:\n${transcript}`] : []
  ].flat();
  const excerptBudget = Math.max(0, maximumCharacters - [...head, ...tail].join("\n\n").length - BUDGET_MARGIN);
  const excerpts = input.repositoryPath ? sourceExcerpts(input.repositoryPath, files.map((file) => file.path), excerptBudget, input.egress) : "";
  const joined = [...head, excerpts, ...tail].filter(Boolean).join("\n\n");
  return joined.length > maximumCharacters
    ? `${joined.slice(0, maximumCharacters)}\n…（上下文超出 ${maximumCharacters} 字符上限已截断）`
    : joined;
}

function sourceExcerpts(repositoryPath: string, paths: string[], budget: number, egress?: EgressCollector): string {
  const selected = paths.slice(0, MAX_EXCERPTS);
  if (!selected.length) return "";
  if (budget < BUDGET_MARGIN) {
    return `源码摘录：超出上下文预算已省略（${selected.join("、")}），需要时用 read_file 查看。`;
  }
  const perBlock = Math.min(MAX_EXCERPT_BLOCK_CHARS, Math.floor(budget / selected.length));
  const blocks: string[] = [];
  for (const path of selected) {
    const slice = sliceExcerpt(repositoryPath, { path, line: 1 }, { before: EXCERPT_BEFORE, after: EXCERPT_AFTER, maxSymbolLines: MAX_SYMBOL_LINES, maxChars: perBlock });
    if (!slice) continue;
    const numbered = slice.lines.map((item) => `${item.line}: ${item.text}`).join("\n");
    const note = slice.truncated ? `\n…（摘录已截断，符号到第 ${slice.symbolEnd ?? slice.to} 行；需要其余部分用 read_file 查看）` : "";
    egress?.push({ kind: "anchor-excerpt", path: slice.path, from: slice.from, to: slice.to, text: numbered, masked: slice.masked, truncated: slice.truncated || undefined });
    blocks.push(`--- ${slice.path}:${slice.from}-${slice.to} ---\n${numbered}${note}`);
  }
  return blocks.length ? `源码摘录（文件开头的真实代码）:\n${blocks.join("\n")}` : "";
}
