import type { AssertionCheck, CourseNode, ImplementationUnit, QualityReport } from "@codebase-tutor/shared";
import { flattenCourseTree } from "../coursetree/projection.js";
import { readFileLines, symbolBodyLines } from "../source/files.js";

/** 校验时每个文件只读一次：几百个符号常挤在同几十个大文件里，一人一次 `readFileSync` 是纯浪费。 */
type LineCache = Map<string, string[] | undefined>;

function linesOf(cache: LineCache, repositoryPath: string, relativePath: string): string[] | undefined {
  if (!cache.has(relativePath)) cache.set(relativePath, readFileLines(repositoryPath, relativePath));
  return cache.get(relativePath);
}

/**
  锚点首行有没有把这个符号**作为完整词**写出来。
  以前测的是「名字出现在定义区间里的任意位置」——那是个近乎必然成立的条件（递归调用、注释里提一句都算），
  于是 `verified` 这个词盖在了一个什么都没证明的判据上。首行 + 词边界才真的能回答「索引记的这一行是不是它的定义行」：
  文件被挪动过、行号漂了，这里就会掉下来。
  */
function declaresAtAnchor(headLine: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(headLine);
}

export interface VerifyOptions {
  /**
    墙钟预算（ms）。**真的是个截止时刻**：到点就停在下一条之前，已经跑出来的部分照常返回去，
    并在 `skippedBecause` 里说清还剩多少没跑。
    以前这个参数只有「`< 1`」这一种取值会被读到，调用方以为自己拿到了 2.5 秒预算，实际什么约束都没有。
    */
  timeoutMs?: number;
  /** 测试用：直接模拟「预算归零」那条分支。 */
  forceTimeout?: boolean;
}

export function verifyAnalysis(repositoryPath: string, implementations: ImplementationUnit[], root: CourseNode, options: VerifyOptions = {}): QualityReport {
  const startedAt = Date.now();
  const deadline = options.forceTimeout ? startedAt : options.timeoutMs === undefined ? undefined : startedAt + Math.max(0, options.timeoutMs);
  const outOfTime = (): boolean => deadline !== undefined && Date.now() >= deadline;
  const cache: LineCache = new Map();

  if (outOfTime()) {
    return { generatedAt: new Date().toISOString(), micro: [], macro: [], skippedBecause: "校验超时，已跳过并保留待确认标记" };
  }

  const micro: AssertionCheck[] = [];
  for (const unit of implementations) {
    if (outOfTime()) break;
    micro.push(verifyUnit(repositoryPath, unit, cache));
  }
  const macroCandidates = flattenCourseTree(root).filter((node) => node.kind !== "implementation");
  const sampleSize = Math.max(1, Math.ceil(macroCandidates.length * 0.2));
  const macroSample = [...macroCandidates].sort((left, right) => left.id.localeCompare(right.id)).slice(0, sampleSize);
  const macro: AssertionCheck[] = [];
  for (const node of macroSample) {
    if (outOfTime()) break;
    macro.push(verifyNode(repositoryPath, node, cache));
  }

  const skippedMicro = implementations.length - micro.length;
  const skippedMacro = macroSample.length - macro.length;
  return {
    generatedAt: new Date().toISOString(),
    micro,
    macro,
    ...(skippedMicro || skippedMacro ? { skippedBecause: `校验预算 ${String(options.timeoutMs)}ms 用尽：微观跑了 ${String(micro.length)}/${String(implementations.length)} 条、宏观抽样跑了 ${String(macro.length)}/${String(macroSample.length)} 条，未跑的部分没有校验结论` } : {})
  };
}

function verifyUnit(repositoryPath: string, unit: ImplementationUnit, cache: LineCache): AssertionCheck {
  const { symbol } = unit;
  const anchors = [{ path: symbol.path, line: symbol.line, endLine: symbol.endLine, label: "实现定义" }];
  /**
    读不到就按「待确认」交出去，不抛：`verifyAnalysis` 跑在导入的中途，一个索引之后被删/权限不对的文件
    不该掀掉整次导入（与 `verifyNode` 的抽样兜底、扫描层 §37.3 同一条口径）。
    */
  const lines = linesOf(cache, repositoryPath, symbol.path);
  if (!lines) {
    return { statement: `${symbol.name} 的微观解释可回溯到其定义区间。`, status: "needs_review", reason: "定义所在文件读不出来。", anchors };
  }
  const body = symbolBodyLines(lines, symbol);
  const declared = body.length > 0 && declaresAtAnchor(body[0] ?? "", symbol.name);
  return {
    statement: `${symbol.name} 的微观解释可回溯到其定义区间。`,
    status: declared ? "verified" : "needs_review",
    reason: declared ? `锚点首行（${symbol.path}:${String(symbol.line)}）按词边界出现该符号名。` : `锚点首行没有按词边界出现符号名「${symbol.name}」——行号可能已漂，或索引与磁盘不一致。`,
    anchors
  };
}

function verifyNode(repositoryPath: string, node: CourseNode, cache: LineCache): AssertionCheck {
  const anchor = node.anchors[0];
  if (!anchor) return { statement: node.summary, status: "skipped", reason: "节点没有源码锚点。", anchors: [] };
  const lines = linesOf(cache, repositoryPath, anchor.path);
  if (!lines) return { statement: node.summary, status: "needs_review", reason: "抽样锚点不可读取。", anchors: [anchor] };
  const line = lines[anchor.line - 1] ?? "";
  return { statement: node.summary, status: line.trim() ? "verified" : "needs_review", reason: line.trim() ? "抽样锚点可读取。" : "抽样锚点为空。", anchors: [anchor] };
}
