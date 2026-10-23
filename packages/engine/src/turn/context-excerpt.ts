import type { SourceAnchor } from "@codebase-tutor/shared";
import { CONTEXT_SHARE, contextShare, contextShareLines } from "../llm/context-window.js";
import { sliceExcerpt } from "../source/excerpt.js";
import type { EgressCollector } from "../security/egress-log.js";

/** 带行号源码摘录的装配段：map 与 practice 两个作用域共用（规则见 source/excerpt.ts）。 */

// 摘录窗口：符号边界不可用时回落到锚点前 12 行 / 后 35 行（合计 48 行）
const EXCERPT_BEFORE_LINES = 12;
const EXCERPT_AFTER_LINES = 35;
/*
  上下文预算全部按窗口份额派生（唯一真源在 `llm/context-window.ts`）：窗口是唯一手填的数，
  这里只声明「哪一类内容占多少」。地板刻意不给——窗口配多小就按多小办事，省略由各处如实说明。
*/
const symbolLineCap = () => contextShareLines(CONTEXT_SHARE.symbolLines, 12);
const excerptBlockCap = () => contextShare(CONTEXT_SHARE.excerptBlock);
const excerptTotalCap = () => contextShare(CONTEXT_SHARE.anchorExcerpts);

/** 按锚点取带行号的源码摘录：符号边界优先、窗口兜底（规则见 source/excerpt.ts）。路径越界或读不到返回空串。 */
function excerptForAnchor(repoPath: string, anchor: SourceAnchor, readHint: boolean, egress?: EgressCollector): string {
  const slice = sliceExcerpt(
    repoPath,
    { path: anchor.path, line: anchor.line, endLine: anchor.endLine },
    { before: EXCERPT_BEFORE_LINES, after: EXCERPT_AFTER_LINES, maxSymbolLines: symbolLineCap(), maxChars: excerptBlockCap() }
  );
  if (!slice) return "";
  const numbered = slice.lines.map((item) => `${item.line}| ${item.text}`).join("\n");
  // 这段就是马上要进请求的源码原文：登记给出网清单（见 security/egress-log.ts）
  egress?.push({ kind: "anchor-excerpt", path: slice.path, from: slice.from, to: slice.to, text: numbered, masked: slice.masked, truncated: slice.truncated || undefined });
  const total = slice.to < slice.totalLines || slice.truncated ? `，共 ${slice.totalLines} 行` : "";
  const symbol = slice.mode === "symbol" && slice.symbolEnd !== undefined && slice.symbolEnd !== slice.to ? `，符号结束于第 ${slice.symbolEnd} 行` : "";
  const tail = slice.truncated ? `\n…（摘录已截断${readHint ? "，其余部分可用 read_file 查看" : ""}）` : "";
  return `文件 ${slice.path}（第 ${slice.from}-${slice.to} 行${total}${symbol}）：\n${numbered}${tail}`;
}

/** 逐个拼接摘录直到总预算用尽；预算内放不下后续锚点时明示省略（不静默丢信息）。 */
function excerptsWithinBudget(repoPath: string, anchors: SourceAnchor[], readHint: boolean, egress?: EgressCollector): string[] {
  const blocks: string[] = [];
  let used = 0;
  for (const anchor of anchors) {
    const block = excerptForAnchor(repoPath, anchor, readHint, egress);
    if (!block) continue;
    if (used + block.length > excerptTotalCap()) {
      const suggest = readHint ? "，需要时可用 read_file 查看" : "";
      blocks.push(`（${anchor.path} 等其余锚点的摘录超出上下文预算已省略${suggest}。）`);
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return blocks;
}

export { excerptForAnchor, excerptsWithinBudget };
