import type { ReactElement } from "react";
import { Code2 } from "lucide-react";

/**
 * 只读源码查看器：单文件 + 单行高亮 + 行号。
 * 对应 prototype `design-prototype.html` 中的 `.source-view`（含 tab + 行高亮）。
 *
 * v0.2+ 扩展：
 * - 多 tab：每个 tab 一个 SourceView 实例；当前 v0.1 只在 CoursePage 嵌一个
 * - 元信息条（只读 / 已定位第 N 行）由上层补
 */

export interface SourcePayload {
  path: string;
  line: number;
  content: string;
}

export function SourceView({ source }: { source: SourcePayload | null }): ReactElement {
  if (!source) return <div className="source-view empty-source">选择带源码锚点的课程节点以查看只读源码。</div>;
  const lines = source.content.split("\n").slice(0, 500);
  return (
    <div className="source-view">
      <div className="source-title"><Code2 size={15} />{source.path}</div>
      <pre>
        {lines.map((line, index) => (
          <code className={index + 1 === source.line ? "source-line highlighted" : "source-line"} key={index}>
            <span>{String(index + 1).padStart(4, " ")}</span>{line || " "}{"\n"}
          </code>
        ))}
      </pre>
    </div>
  );
}