import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactElement } from "react";

/** 对话消息的 Markdown 渲染（GFM），文本节点自动转义。 */
export function Markdown({ content }: { content: string }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
