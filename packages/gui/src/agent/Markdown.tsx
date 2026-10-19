import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactElement } from "react";

/**
  对话消息的 Markdown 渲染（GFM：表格 / 任务列表 / 删除线 / 自动链接）。
  react-markdown 以 React 元素输出，文本节点自动转义；样式见 global.css 的 `.message .md`。
  */
export function Markdown({ content }: { content: string }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
