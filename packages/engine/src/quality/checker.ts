import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssertionCheck, CourseNode, ImplementationUnit, QualityReport } from "@codebase-tutor/shared";

export function verifyAnalysis(repositoryPath: string, implementations: ImplementationUnit[], root: CourseNode, options: { timeoutMs?: number; forceTimeout?: boolean } = {}): QualityReport {
  if (options.forceTimeout || (options.timeoutMs !== undefined && options.timeoutMs < 1)) {
    return { generatedAt: new Date().toISOString(), micro: [], macro: [], skippedBecause: "校验超时，已跳过并保留待确认标记" };
  }
  const micro = implementations.map((unit) => verifyUnit(repositoryPath, unit));
  const macroCandidates = flatten(root).filter((node) => node.kind !== "implementation");
  const sampleSize = Math.max(1, Math.ceil(macroCandidates.length * 0.2));
  const macro = [...macroCandidates].sort((left, right) => left.id.localeCompare(right.id)).slice(0, sampleSize).map((node) => verifyNode(repositoryPath, node));
  return { generatedAt: new Date().toISOString(), micro, macro };
}

function verifyUnit(repositoryPath: string, unit: ImplementationUnit): AssertionCheck {
  const { symbol } = unit;
  const content = readFileSync(join(repositoryPath, symbol.path), "utf8").split("\n").slice(symbol.line - 1, symbol.endLine).join("\n");
  const matched = content.includes(symbol.name);
  return {
    statement: `${symbol.name} 的微观解释可回溯到其定义区间。`,
    status: matched ? "verified" : "needs_review",
    reason: matched ? "定义名称在锚点区间内存在。" : "锚点区间未找到定义名称。",
    anchors: [{ path: symbol.path, line: symbol.line, endLine: symbol.endLine, label: "实现定义" }]
  };
}

function verifyNode(repositoryPath: string, node: CourseNode): AssertionCheck {
  const anchor = node.anchors[0];
  if (!anchor) return { statement: node.summary, status: "skipped", reason: "节点没有源码锚点。", anchors: [] };
  try {
    const line = readFileSync(join(repositoryPath, anchor.path), "utf8").split("\n")[anchor.line - 1] ?? "";
    return { statement: node.summary, status: line.trim() ? "verified" : "needs_review", reason: line.trim() ? "抽样锚点可读取。" : "抽样锚点为空。", anchors: [anchor] };
  } catch {
    return { statement: node.summary, status: "needs_review", reason: "抽样锚点不可读取。", anchors: [anchor] };
  }
}

function flatten(root: CourseNode): CourseNode[] {
  return [root, ...root.children.flatMap(flatten)];
}
