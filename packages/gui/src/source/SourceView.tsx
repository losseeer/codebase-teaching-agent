import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { detectLanguage, highlightLines } from "./highlight";

/**
  只读源码岛：语法高亮 + 行号 + 锚点行高亮（`.anchored` 就是 Agent 的绑定行）+ 把目标行滚进可视区。
  传入 `onLineClick` 时点任意一行即可换锚点。高亮由 `highlight.ts` 的逐行 tokenizer 完成（零依赖），
  语言按扩展名判定，识别不了则整行纯文本。
  渲染上限 `MAX_RENDER_LINES`：超出的锚点行不会被渲染，调用方须先问 `isLineRendered()`
  再决定文案能不能说「已定位」。
 */

export interface SourcePayload {
  path: string;
  line: number;
  content: string;
}

export const MAX_RENDER_LINES = 500;

/** 锚点行是否真的会被渲染出来（超出渲染上限的行无从定位）。 */
export function isLineRendered(line: number): boolean {
  return Number.isFinite(line) && line >= 1 && line <= MAX_RENDER_LINES;
}

/** 元素自己是不是滚动容器（有纵向滚动条且内容确实溢出）。 */
function isScrollable(element: HTMLElement): boolean {
  return /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1;
}

/**
  找这个面板的滚动容器：代码教学里是面板自身，练习评估里是外层容器。
 */
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

  // 把锚点行滚进可视区：一律用 rect 差值——scrollIntoView 会连带滚动整页，offsetTop 会算到别的父级上。
  // 只在面板已有布局时有效：三个工作区常驻挂载、靠 hidden 切换，隐藏时容器尺寸为 0，这一帧静默跳过。
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
