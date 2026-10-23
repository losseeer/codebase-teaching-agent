import { useState, type ReactElement } from "react";
import type { FileTreeNode } from "@codebase-tutor/shared/wire";
import { Icon } from "../ui/icons";

/**
  仓库文件树：按真实目录层级渲染，首层目录默认展开。
  - `lineOf`：可选的「文件路径 → 行数」表，提供时在文件行右侧显示行数
  - `badge`：可选的目录徽标，用于给顶层目录标注语义分组
  - `activePath`：高亮当前选中的文件
 */
export function RepoTree({ nodes, onOpenFile, onOpenDir, activePath, activeDir, lineOf, badge }: {
  nodes: FileTreeNode[];
  onOpenFile: (path: string) => void;
  onOpenDir?: (path: string) => void;
  activePath?: string;
  activeDir?: string;
  lineOf?: Map<string, number>;
  badge?: (node: FileTreeNode, depth: number) => string | undefined;
}): ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    nodes.forEach((node) => { if (node.kind === "directory") initial.add(node.path); });
    return initial;
  });
  const [fullyShown, setFullyShown] = useState<Set<string>>(() => new Set());
  if (!nodes.length) return <p className="entry-empty">文件树加载中，或这个仓没有文件索引。</p>;
  const LIMIT = 8;
  const render = (items: FileTreeNode[], depth: number): ReactElement[] => {
    const rows: ReactElement[] = [];
    items.forEach((node) => {
      if (node.kind === "directory") {
        const open = expanded.has(node.path);
        const label = badge?.(node, depth);
        rows.push(
          <button key={node.path} type="button" className={`tree-row ${activeDir === node.path ? "active" : ""}`} style={{ paddingLeft: `${4 + depth * 12}px` }} onClick={() => { onOpenDir?.(node.path); setExpanded((prev) => { const next = new Set(prev); if (open) next.delete(node.path); else next.add(node.path); return next; }); }} aria-expanded={open} title={onOpenDir ? `选中目录 ${node.path}（再点一次展开/收起）` : node.path}>
            <Icon name="folder" size={13} />
            <span className="tree-name">{node.name}</span>
            {label ? <span className="ext-badge">{label}</span> : <span className="ext-badge">{node.children?.length ?? 0} 项</span>}
          </button>,
        );
        if (open && node.children) {
          const shown = fullyShown.has(node.path) ? node.children : node.children.slice(0, LIMIT);
          rows.push(...render(shown, depth + 1));
          if (!fullyShown.has(node.path) && node.children.length > LIMIT) {
            rows.push(
              <button key={`${node.path}:more`} type="button" className="tree-row more" style={{ paddingLeft: `${4 + (depth + 1) * 12}px` }} onClick={() => setFullyShown((prev) => new Set(prev).add(node.path))}>
                显示其余 {node.children.length - LIMIT} 项
              </button>,
            );
          }
        }
      } else {
        const lines = lineOf?.get(node.path) ?? 0;
        rows.push(
          <button key={node.path} type="button" className={`tree-row ${activePath === node.path ? "active" : ""}`} style={{ paddingLeft: `${4 + depth * 12}px` }} onClick={() => onOpenFile(node.path)} title={node.path}>
            <Icon name="file" size={13} />
            <span className="tree-name">{node.name}</span>
            {lineOf ? <span className="ext-badge">{lines ? `${lines}L` : "—"}</span> : null}
          </button>,
        );
      }
    });
    return rows;
  };
  return <div className="tree">{render(nodes, 0)}</div>;
}
