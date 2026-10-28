import { join } from "node:path";
import { isWithin, readFileLines } from "@codebase-tutor/platform";
import { secretMasker } from "@codebase-tutor/domain";

/**
  锚点取码：把锚点解析成一段可嵌入 prompt 的源码窗口。
  符号边界可信时按符号行区间取，否则回落固定窗口；跨度与字符超上限时截断并标记。
  这里是仓内源码原文进请求前的最后一道密钥筛；读不到或越界返回 undefined。
  */

export interface ExcerptAnchor {
  path: string;
  line: number;
  endLine?: number;
}

export interface ExcerptOptions {
  /** 窗口模式：锚点行之前取多少行。 */
  before: number;
  /** 窗口模式：锚点行之后取多少行。 */
  after: number;
  /** 符号边界可信上限（行）。 */
  maxSymbolLines: number;
  /** 单块字符上限。 */
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
  /** 符号模式下的真实符号末尾行。 */
  symbolEnd?: number;
  /** 本窗口里被隐去的疑似密钥处数；没命中就没有这个字段。 */
  masked?: number;
}

export function sliceExcerpt(repositoryPath: string, anchor: ExcerptAnchor, options: ExcerptOptions): ExcerptSlice | undefined {
  const relative = anchor.path.replaceAll("\\", "/");
  const absolute = join(repositoryPath, relative);
  if (!isWithin(repositoryPath, absolute)) return undefined;
  // 读行口径与 read_file 同源。
  const all = readFileLines(repositoryPath, relative);
  if (!all) return undefined;
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
  const masker = secretMasker();
  for (let current = from; current <= to; current += 1) {
    const raw = all[current - 1] ?? "";
    if (lines.length && used + raw.length + 1 > options.maxChars) {
      truncated = true;
      break;
    }
    lines.push({ line: current, text: masker.take(raw) });
    used += raw.length + 1;
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
    ...(masker.masked ? { masked: masker.masked } : {}),
    ...(symbolEnd !== undefined ? { symbolEnd } : {})
  };
}
