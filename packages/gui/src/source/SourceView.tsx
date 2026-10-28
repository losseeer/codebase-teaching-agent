import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { detectLanguage, highlightLines } from "./highlight";

/**
  只读源码岛：语法高亮 + 行号 + 锚点行高亮并滚进可视区。
  超出 MAX_RENDER_LINES 的锚点行不渲染；定位文案先问 isLineRendered()。
 */

export interface SourcePayload {
  path: string;
  line: number;
  content: string;
}

export const MAX_RENDER_LINES = 500;

/** 锚点行是否会被渲染（超出上限则无从定位）。 */
export function isLineRendered(line: number): boolean {
  return Number.isFinite(line) && line >= 1 && line <= MAX_RENDER_LINES;
}

/** 元素自己是不是滚动容器（有纵向滚动条且内容确实溢出）。 */
function isScrollable(element: HTMLElement): boolean {
  return /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1;
}

/** 向上找滚动容器：面板自身或外层容器。 */
function findScroller(container: HTMLElement): HTMLElement | null {
  if (isScrollable(container)) return container;
  for (let node = container.parentElement; node; node = node.parentElement) if (isScrollable(node)) return node;
  return null;
}

export function SourceView({ source, emptyHint, onLineClick }: { source: SourcePayload | null; emptyHint?: string; onLineClick?: (line: number) => void }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  // tokenize 只随文件内容与路径变化：换锚点行不该重扫整篇
  const view = useMemo(() => {
    if (!source) return null;
    const lines = source.content.split("\n").slice(0, MAX_RENDER_LINES);
    return { lines, tokens: highlightLines(lines, detectLanguage(source.path)) };
  }, [source?.content, source?.path]);

  // 用 rect 差值滚动，不用 scrollIntoView（会连带滚整页）
  // 容器尺寸为 0 时静默跳过本帧
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scroller = findScroller(container);
    if (!scroller) return;
    const target = container.querySelector<HTMLElement>(".src-line.anchored");
    // 锚点行超出渲染上限时无节点可定位：回到文件开头
    if (!target) { scroller.scrollTop = 0; return; }
    const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += delta - scroller.clientHeight / 3;
  }, [source?.path, source?.line]);

  if (!source || !view) return <div className="source-view"><div className="empty">{emptyHint ?? "选择带源码锚点的节点以查看只读源码。"}</div></div>;

  return (
    <div className="source-view" ref={containerRef}>
      <pre>
        {view.tokens.map((tokens, index) => {
          const line = index + 1;
          return (
            <div className={`src-line${line === source.line ? " anchored" : ""}`} key={index} data-line={line} onClick={onLineClick ? () => onLineClick(line) : undefined}>
              <span className="line-number">{line}</span>
              <span className="ln-content">
                {view.lines[index]
                  ? tokens.map((token, tokenIndex) => (token.kind === "plain"
                    ? token.text
                    : <span className={token.kind} key={tokenIndex}>{token.text}</span>))
                  : " "}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
