import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { Code2 } from "lucide-react";
import { detectLanguage, highlightLines } from "./highlight";

/**
 * 只读源码查看器：语法高亮 + 行号 + 单行定位高亮 + 把目标行滚进可视区。
 * 对应 prototype `design-prototype.html` 中的 `.code` / `.code-line`（含 token 配色）。
 *
 * 高亮由 `highlight.ts` 的逐行 tokenizer 完成（零依赖）；语言按文件扩展名判定，
 * 识别不了则整行纯文本。渲染上限 500 行 —— 超过上限的锚点行**不会被渲染**，
 * 所以调用方必须先问 `isLineRendered()` 再决定文案能不能说「已定位」（见 TutorPage）。
 */

export interface SourcePayload {
  path: string;
  line: number;
  content: string;
}

export const MAX_RENDER_LINES = 500;

/** 锚点行是否真的会被渲染出来。超出上限的行渲染不出来，也就无从定位。 */
export function isLineRendered(line: number): boolean {
  return Number.isFinite(line) && line >= 1 && line <= MAX_RENDER_LINES;
}

/** 元素自己是不是滚动容器（有纵向滚动条且内容确实溢出）。 */
function isScrollable(element: HTMLElement): boolean {
  return /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1;
}

/**
  找这个面板的滚动容器。两个使用场景不是同一层：代码教学里 `.source-view` 自己 flex:1 带 overflow:auto；
  练习评估里它外层 `.practice-code`（max-height:40%）才是滚动容器，内层没有高度约束、不产生滚动条。
  */
function findScroller(container: HTMLElement): HTMLElement | null {
  if (isScrollable(container)) return container;
  for (let node = container.parentElement; node; node = node.parentElement) if (isScrollable(node)) return node;
  return null;
}

export function SourceView({ source }: { source: SourcePayload | null }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  // tokenize 只随文件内容/路径变化：避免父组件每次渲染重扫 500 行
  const view = useMemo(() => {
    if (!source) return null;
    const lines = source.content.split("\n").slice(0, MAX_RENDER_LINES);
    return { lines, tokens: highlightLines(lines, detectLanguage(source.path)) };
  }, [source]);

  // 把高亮行滚进可视区。不能换成 scrollIntoView：`.tutor-page` 自己也是 overflow-y:auto 的滚动容器，
  // scrollIntoView 会连带把整页滚一下（block:"nearest" 也拦不住祖先）。也不能用 offsetTop：
  // `.source-view` 没设 position，offsetParent 不是它，偏移量会算错 —— 所以一律用 rect 差值。
  // ⚠️ 只在面板已有布局时有效：三工作区共挂载（`hidden` 切换），隐藏时容器尺寸为 0、找不到滚动容器，
  //    这一帧会静默跳过。今天不会落空 —— 改 `source` 的唯一入口（TutorPage 的推荐入口 / 源码 tabs 与
  //    PracticePage 的生成练习）都在各自可见的面板里。若以后新增「在别的面板里改 source」的入口，
  //    这里需要改成「等可见后补一次」（ResizeObserver）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scroller = findScroller(container);
    if (!scroller) return;
    const target = container.querySelector<HTMLElement>(".source-line.highlighted");
    // 锚点行超出渲染上限时没有可定位的节点：回到文件开头，别停在上一个文件的滚动位置
    if (!target) { scroller.scrollTop = 0; return; }
    const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += delta - scroller.clientHeight / 3;
  }, [source?.path, source?.line]);

  if (!source || !view) return <div className="source-view empty-source">选择带源码锚点的课程节点以查看只读源码。</div>;

  return (
    <div className="source-view" ref={containerRef}>
      <div className="source-title"><Code2 size={15} />{source.path}</div>
      <pre>
        {view.tokens.map((tokens, index) => (
          <code className={index + 1 === source.line ? "source-line highlighted" : "source-line"} key={index}>
            <span className="line-number">{String(index + 1).padStart(4, " ")}</span>
            {view.lines[index]
              ? tokens.map((token, tokenIndex) => (token.kind === "plain"
                ? token.text
                : <span className={token.kind} key={tokenIndex}>{token.text}</span>))
              : " "}
            {"\n"}
          </code>
        ))}
      </pre>
    </div>
  );
}
