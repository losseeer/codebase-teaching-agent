import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isWithin } from "../lib.js";

/**
  锚点取码：把「锚点」解析成一段可嵌入 prompt 的源码窗口。

  为什么不直接用「锚点 ±N 行」的位置窗口：锚点只标明位置，代码版式不规整时，
  锚点上下若干行常常与锚点本身无关，而真正相关的代码可能离锚点很远。规则：

  1. 符号边界优先——锚点带可信 endLine（> line 且跨度不超过 maxSymbolLines）时，只取符号自身的行区间；
  2. 窗口兜底——endLine 缺失或非法（endLine 由花括号计数得到，字符串/注释里的花括号会干扰）时回落固定窗口；
  3. 超长符号——跨度超过 maxSymbolLines 时取符号开头到上限（比对称窗口更贴近符号本身）并标记截断；
  4. 单块字符上限——无论哪种模式都截断到 maxChars，防止一个超大符号吃掉整个上下文预算。

  截断与省略由调用方在文本里明示（不静默丢信息）；路径越界或读不到返回 undefined，由调用方决定如何提示。
  */

export interface ExcerptAnchor {
  path: string;
  line: number;
  endLine?: number;
}

export interface ExcerptOptions {
  /** 窗口模式：锚点行之前取多少行 */
  before: number;
  /** 窗口模式：锚点行之后取多少行 */
  after: number;
  /** 符号边界可信上限（行） */
  maxSymbolLines: number;
  /** 单块字符上限 */
  maxChars: number;
}

export interface ExcerptSlice {
  path: string;
  /** 起始行（1 起，含） */
  from: number;
  /** 实际结束行（含） */
  to: number;
  totalLines: number;
  /** 行号 → 原文 */
  lines: { line: number; text: string }[];
  /** 因符号/窗口行数或字符上限被截断 */
  truncated: boolean;
  mode: "symbol" | "window";
  /** 符号模式下的真实符号末尾行（调用方可据此提示「符号共 N 行」） */
  symbolEnd?: number;
}

export function sliceExcerpt(repositoryPath: string, anchor: ExcerptAnchor, options: ExcerptOptions): ExcerptSlice | undefined {
  const relative = anchor.path.replaceAll("\\", "/");
  const absolute = join(repositoryPath, relative);
  if (!isWithin(repositoryPath, absolute)) return undefined;
  let all: string[];
  try {
    all = readFileSync(absolute, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
  const totalLines = all.length;
  const line = Math.min(Math.max(1, Math.floor(anchor.line) || 1), totalLines);
  const declared = typeof anchor.endLine === "number" && Number.isInteger(anchor.endLine) && anchor.endLine > line ? anchor.endLine : undefined;
  const symbolEnd = declared === undefined ? undefined : Math.min(declared, totalLines);
  const symbolSpan = symbolEnd === undefined ? undefined : symbolEnd - line + 1;

  let from: number;
  let to: number;
  let mode: ExcerptSlice["mode"];
  let truncated = false;
  if (symbolEnd !== undefined) {
    const withinLimit = symbolSpan! <= options.maxSymbolLines;
    mode = "symbol";
    from = line;
    to = withinLimit ? symbolEnd : Math.min(totalLines, line + options.maxSymbolLines - 1);
    truncated = !withinLimit;
  } else {
    mode = "window";
    from = Math.max(1, line - options.before);
    to = Math.min(totalLines, line + options.after);
  }

  const lines: { line: number; text: string }[] = [];
  let used = 0;
  for (let current = from; current <= to; current += 1) {
    const text = all[current - 1] ?? "";
    if (lines.length && used + text.length + 1 > options.maxChars) {
      truncated = true;
      break;
    }
    lines.push({ line: current, text });
    used += text.length + 1;
  }
  const last = lines.length ? lines[lines.length - 1].line : from;
  return {
    path: relative,
    from,
    to: last,
    totalLines,
    lines,
    truncated: truncated || last < to,
    mode,
    ...(symbolEnd !== undefined ? { symbolEnd } : {})
  };
}
