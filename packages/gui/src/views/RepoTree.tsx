import { useState, type ReactElement } from "react";
import type { FileTreeNode } from "@codebase-tutor/shared";

/**
  仓库文件树（prototype `.repo-tree`）：按真实目录层级渲染。
  - 目录可折叠，**首层目录默认展开**（与原始目录结构保持一致）；每目录最多展示 8 项 + 「显示其余 N 项」
  - `lineOf`：可选的「文件路径 → 行数」表，提供时在文件行右侧显示 `NL`（宏观设计的项目目录用）
  - `badge`：可选的目录徽标（宏观设计用它给顶层目录标注语义分组）
  - `activePath`：高亮当前选中的文件

  原为 TutorPage 内部组件（v0.3），v0.5.4 提取共享：宏观设计「项目目录」改用真实目录树后两处复用。
  */
export function RepoTree({ nodes, onOpenFile, activePath, lineOf, badge }: {
  nodes: FileTreeNode[];
  onOpenFile: (path: string) => void;
  activePath?: string;
  lineOf?: Map<string, number>;
  badge?: (node: FileTreeNode, depth: number) => string | undefined;
}): ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    nodes.forEach((node) => { if (node.kind === "directory") initial.add(node.path); });
    return initial;
  });
  const [fullyShown, setFullyShown] = useState<Set<string>>(() => new Set());
  if (!nodes.length) return <p className="entry-empty">仓库文件树加载中，或该仓库暂无文件索引。</p>;
  const LIMIT = 8;
  const render = (items: FileTreeNode[], depth: number): ReactElement[] => {
    const rows: ReactElement[] = [];
    items.forEach((node) => {
      if (node.kind === "directory") {
        const open = expanded.has(node.path);
        const label = badge?.(node, depth);
        rows.push(
          <button key={node.path} className={`rt-dir ${open ? "open" : ""}`} style={{ paddingLeft: `${8 + depth * 12}px` }} onClick={() => setExpanded((prev) => { const next = new Set(prev); if (open) next.delete(node.path); else next.add(node.path); return next; })}>
            {open ? "⌄" : "›"} {node.name}{label ? <em className="rt-badge">{label}</em> : null}<span>{node.children?.length ?? 0} 项</span>
          </button>,
        );
        if (open && node.children) {
          const shown = fullyShown.has(node.path) ? node.children : node.children.slice(0, LIMIT);
          rows.push(...render(shown, depth + 1));
          if (!fullyShown.has(node.path) && node.children.length > LIMIT) {
            rows.push(
              <button key={`${node.path}:more`} className="rt-more" style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }} onClick={() => setFullyShown((prev) => new Set(prev).add(node.path))}>
                显示其余 {node.children.length - LIMIT} 项
              </button>,
            );
          }
        }
      } else {
        const lines = lineOf?.get(node.path) ?? 0;
        rows.push(
          <button key={node.path} className={`rt-file ${activePath === node.path ? "selected" : ""}`} style={{ paddingLeft: `${8 + depth * 12}px` }} onClick={() => onOpenFile(node.path)}>
            ◇ <code>{node.name}</code>{lineOf ? <em className="rt-lines">{lines ? `${lines}L` : "—"}</em> : null}
          </button>,
        );
      }
    });
    return rows;
  };
  return <div className="repo-tree">{render(nodes, 0)}</div>;
}
