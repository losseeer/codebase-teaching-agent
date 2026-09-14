import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CourseNode, TeachingPolicy, TutorMessage } from "@codebase-tutor/shared";

const EXCERPT_BEFORE = 7;
const EXCERPT_AFTER = 10;
const MAX_EXCERPTS = 3;
const TRANSCRIPT_WINDOW = 8;
const TRANSCRIPT_LINE_CHARS = 160;

/**
 * 有界教学上下文：节点事实 + 锚点附近的真实源码摘录 + 含学习者发言的近期对话。
 * repositoryPath 提供时才读取源码；读不到的锚点静默跳过（锚点来自静态分析，路径可信）。
 */
export function assembleContext(node: CourseNode, policy: TeachingPolicy, history: TutorMessage[], repositoryPath?: string, maximumCharacters = 9000): string {
  const transcript = history.slice(-TRANSCRIPT_WINDOW).map((message) => {
    const role = message.role === "user" ? "学习者" : "导师";
    return `${role}: ${message.content.replaceAll(/\s+/g, " ").slice(0, TRANSCRIPT_LINE_CHARS)}`;
  }).join("\n");
  const sections = [
    `课程节点: ${node.title}`,
    `源码锚点: ${node.anchors.map((anchor) => `${anchor.path}:${anchor.line}`).join(", ") || "无"}`,
    `摘要: ${node.summary}`,
    `风格约束: ${policy.constraints.join("；")}`,
    repositoryPath ? sourceExcerpts(repositoryPath, node) : "",
    transcript ? `最近对话（按时间序，含学习者发言）:\n${transcript}` : ""
  ].filter(Boolean);
  return sections.join("\n\n").slice(0, maximumCharacters);
}

function sourceExcerpts(repositoryPath: string, node: CourseNode): string {
  const blocks: string[] = [];
  for (const anchor of node.anchors.slice(0, MAX_EXCERPTS)) {
    const excerpt = readExcerpt(repositoryPath, anchor.path, anchor.line);
    if (excerpt) blocks.push(`--- ${anchor.path}:${excerpt.from}-${excerpt.to} ---\n${excerpt.text}`);
  }
  return blocks.length ? `源码摘录（锚点附近真实代码）:\n${blocks.join("\n")}` : "";
}

function readExcerpt(repositoryPath: string, relativePath: string, line: number): { from: number; to: number; text: string } | undefined {
  try {
    const lines = readFileSync(join(repositoryPath, relativePath), "utf8").split(/\r?\n/);
    if (line > lines.length) return undefined;
    const from = Math.max(1, line - EXCERPT_BEFORE);
    const to = Math.min(lines.length, line + EXCERPT_AFTER);
    return { from, to, text: lines.slice(from - 1, to).map((content, index) => `${from + index}: ${content}`).join("\n") };
  } catch {
    return undefined;
  }
}
