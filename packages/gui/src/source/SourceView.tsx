import { useMemo, type ReactElement } from "react";
import { Code2 } from "lucide-react";
import { detectLanguage, highlightLines } from "./highlight";

/**
 * 只读源码查看器：语法高亮 + 行号 + 单行定位高亮。
 * 对应 prototype `design-prototype.html` 中的 `.code` / `.code-line`（含 token 配色）。
 *
 * 高亮由 `highlight.ts` 的逐行 tokenizer 完成（零依赖）；语言按文件扩展名判定，
 * 识别不了则整行纯文本。渲染上限 500 行。
 */

export interface SourcePayload {
  path: string;
  line: number;
  content: string;
}

const MAX_RENDER_LINES = 500;

export function SourceView({ source }: { source: SourcePayload | null }): ReactElement {
  // tokenize 只随文件内容/路径变化：避免父组件每次渲染重扫 500 行
  const view = useMemo(() => {
    if (!source) return null;
    const lines = source.content.split("\n").slice(0, MAX_RENDER_LINES);
    return { lines, tokens: highlightLines(lines, detectLanguage(source.path)) };
  }, [source]);

  if (!source || !view) return <div className="source-view empty-source">选择带源码锚点的课程节点以查看只读源码。</div>;

  return (
    <div className="source-view">
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
