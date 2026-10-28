import type { SourceAnchor } from "@codebase-tutor/domain";

import { CONTEXT_SHARE, contextShare, contextShareLines } from "../adapter/outbound/llm/context-window.js";
import { sliceExcerpt } from "../source/excerpt.js";
import type { EgressCollector } from "../adapter/outbound/security/egress-log.js";

/** 带行号源码摘录的装配段；切片规则见 `source/excerpt.ts`。 */

// 符号边界不可用时，按锚点前后取窗口
const EXCERPT_BEFORE_LINES = 12;
const EXCERPT_AFTER_LINES = 35;
/** 预算按窗口份额派生，份额定义在 `llm/context-window.ts`；不设地板。 */
const symbolLineCap = () => contextShareLines(CONTEXT_SHARE.symbolLines, 12);
const excerptBlockCap = () => contextShare(CONTEXT_SHARE.excerptBlock);
const excerptTotalCap = () => contextShare(CONTEXT_SHARE.anchorExcerpts);

/** 按锚点取带行号的源码摘录：符号边界优先，取不到时按窗口。路径越界或读不到返回空串。 */
function excerptForAnchor(repoPath: string, anchor: SourceAnchor, readHint: boolean, egress?: EgressCollector): string {
  const slice = sliceExcerpt(
    repoPath,
    { path: anchor.path, line: anchor.line, endLine: anchor.endLine },
    { before: EXCERPT_BEFORE_LINES, after: EXCERPT_AFTER_LINES, maxSymbolLines: symbolLineCap(), maxChars: excerptBlockCap() }
  );
  if (!slice) return "";
  const numbered = slice.lines.map((item) => `${item.line}| ${item.text}`).join("\n");
  // 登记进出境清单（见 `security/egress-log.ts`）
  egress?.push({ kind: "anchor-excerpt", path: slice.path, from: slice.from, to: slice.to, text: numbered, masked: slice.masked, truncated: slice.truncated || undefined });
  const total = slice.to < slice.totalLines || slice.truncated ? `，共 ${slice.totalLines} 行` : "";
  const symbol = slice.mode === "symbol" && slice.symbolEnd !== undefined && slice.symbolEnd !== slice.to ? `，符号结束于第 ${slice.symbolEnd} 行` : "";
  const tail = slice.truncated ? `\n…（摘录已截断${readHint ? "，其余部分可用 read_file 查看" : ""}）` : "";
  return `文件 ${slice.path}（第 ${slice.from}-${slice.to} 行${total}${symbol}）：\n${numbered}${tail}`;
}

/** 逐个拼接摘录直到总预算用尽；放不下的余下锚点明示省略。 */
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
