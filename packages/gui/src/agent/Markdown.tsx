import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactElement } from "react";

/**
  对话消息的 Markdown 渲染（GFM：表格 / 任务列表 / 删除线 / 自动链接）。
  react-markdown 以 React 元素输出，文本节点自动转义——取代此前的 escapeHtml + dangerouslySetInnerHTML 注入路径。
  气泡底色由 `.message p` 继承、`.message .md` 内元素样式见 global.css。
  */
export function Markdown({ content }: { content: string }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
