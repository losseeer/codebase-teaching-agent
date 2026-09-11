import { useEffect, useState, type ReactElement } from "react";
import { BookOpen, ChevronRight, Code2 } from "lucide-react";
import type { CourseNode, CourseNodeDetail, RepositoryOverview } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import { EmptyState, Loading, MicroDetail, replaceCourseNode } from "./helpers";
import { SourceView } from "../source/SourceView";

/**
 * 课程地图工作区：左侧课程树 + 中部课程节点详情 + 右侧 Git 热点。
 * - 节点点击：触发 `/api/.../analysis/node` 拉 ImplementationUnit / DecisionUnit
 * - 锚点点击：触发 `/api/.../source` 拉只读源码（SourceView）
 * - 课程树懒加载：`CourseNodePage` 接口，按 offset 分页加载子节点
 *
 * 对应 prototype `design-prototype.html` 中的「课程地图」视图 + 流程节点图。
 * 当前 GUI 用树形列表呈现课程节点；流程图（六节点）是 v0.2+ 计划。
 */

function TreeNode({ node, selected, expanded, loadingNodeId, onSelect, onToggle, onLoadMore, depth = 0 }: { node: CourseNode; selected?: string; expanded: Set<string>; loadingNodeId: string | null; onSelect: (node: CourseNode) => void; onToggle: (node: CourseNode) => void; onLoadMore: (node: CourseNode) => void; depth?: number }): ReactElement {
  const childCount = node.childCount ?? node.children.length;
  const hasChildren = childCount > 0;
  const isExpanded = expanded.has(node.id);
  const hasMore = node.children.length < childCount;
  return (
    <div className="tree-node">
      <div className="tree-row" style={{ paddingLeft: `${4 + depth * 14}px` }}>
        {hasChildren ? (
          <button className={isExpanded ? "tree-toggle expanded" : "tree-toggle"} aria-label={`${isExpanded ? "收起" : "展开"} ${node.title}`} title={`${isExpanded ? "收起" : "展开"} ${node.title}`} onClick={() => onToggle(node)}><ChevronRight size={15} /></button>
        ) : <span className="tree-spacer" />}
        <button className={node.id === selected ? "tree-button active" : "tree-button"} onClick={() => onSelect(node)}>{node.title}</button>
      </div>
      {isExpanded && node.children.map((child) => <TreeNode key={child.id} node={child} selected={selected} expanded={expanded} loadingNodeId={loadingNodeId} onSelect={onSelect} onToggle={onToggle} onLoadMore={onLoadMore} depth={depth + 1} />)}
      {isExpanded && hasMore ? <button className="tree-more" onClick={() => onLoadMore(node)} disabled={loadingNodeId === node.id}>{loadingNodeId === node.id ? "加载中" : `加载更多（剩余 ${childCount - node.children.length} 项）`}</button> : null}
    </div>
  );
}

export function CoursePage({ workspace }: { workspace: Workspace }): ReactElement {
  const [overview, setOverview] = useState<RepositoryOverview | null>(null);
  const [selected, setSelected] = useState<CourseNode | null>(null);
  const [detail, setDetail] = useState<CourseNodeDetail | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["overview"]));
  const [loadingNodeId, setLoadingNodeId] = useState<string | null>(null);
  const [source, setSource] = useState<{ path: string; line: number; content: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setError(""); setOverview(null); setDetail(null); setExpanded(new Set(["overview"]));
    api.getOverview(workspace.repositoryId).then((next) => {
      if (!current) return;
      setOverview(next); setSelected(next.root);
    }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "无法加载课程"); });
    return () => { current = false; };
  }, [workspace.repositoryId]);
  useEffect(() => {
    const anchor = selected?.anchors[0];
    if (!anchor) { setSource(null); return; }
    let current = true;
    api.getSource(workspace.repositoryId, anchor.path, anchor.line).then((next) => { if (current) setSource(next); }).catch(() => { if (current) setSource(null); });
    return () => { current = false; };
  }, [selected?.id, selected?.anchors[0]?.path, selected?.anchors[0]?.line, workspace.repositoryId]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let current = true;
    api.getCourseNodeDetail(workspace.repositoryId, selected.id).then((next) => { if (current) setDetail(next); }).catch(() => { if (current) setDetail(null); });
    return () => { current = false; };
  }, [selected?.id, workspace.repositoryId]);
  const loadChildren = async (node: CourseNode, append: boolean): Promise<void> => {
    if (!overview) return;
    setLoadingNodeId(node.id);
    try {
      const page = await api.getCourseNodes(workspace.repositoryId, node.id, append ? node.children.length : 0);
      setOverview((current) => current ? { ...current, root: replaceCourseNode(current.root, node.id, (target) => ({ ...target, childCount: page.total, children: append ? [...target.children, ...page.items] : page.items })) } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法加载课程节点");
    } finally {
      setLoadingNodeId(null);
    }
  };
  const toggleNode = (node: CourseNode): void => {
    const isExpanded = expanded.has(node.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (isExpanded) next.delete(node.id); else next.add(node.id);
      return next;
    });
    if (!isExpanded && node.children.length === 0 && (node.childCount ?? 0) > 0) void loadChildren(node, false);
  };
  if (error) return <EmptyState title="课程暂不可用" detail={error} />;
  if (!overview) return <Loading />;
  return (
    <section className="course-page">
      <header className="course-header">
        <div>
          <p className="eyebrow">宏观课程树</p>
          <h1>{overview.root.title}</h1>
          <p>{overview.root.summary}</p>
        </div>
        <div className="course-meta"><span>{overview.totalFiles} 文件</span><span>{overview.hotspots.length} 热点</span></div>
      </header>
      <div className="course-workspace">
        <aside className="course-tree" aria-label="课程树">
          <TreeNode node={overview.root} selected={selected?.id} expanded={expanded} loadingNodeId={loadingNodeId} onSelect={setSelected} onToggle={toggleNode} onLoadMore={(node) => void loadChildren(node, true)} />
        </aside>
        <article className="lesson-detail">
          <div className="lesson-heading">
            <div>
              <span className="kind-badge">{selected?.kind === "workflow" ? "工作流" : selected?.kind === "module" ? "模块" : "概览"}</span>
              <h2>{selected?.title}</h2>
            </div>
            <BookOpen size={20} />
          </div>
          <p className="lesson-summary">{selected?.summary}</p>
          <MicroDetail detail={detail} />
          {selected?.anchors.length ? (
            <div className="anchors">
              <span>源码锚点</span>
              {selected.anchors.map((anchor) => (
                <button key={`${anchor.path}:${anchor.line}`} className="anchor" onClick={() => setSelected({ ...selected, anchors: [anchor] })}><Code2 size={14} />{anchor.path}:{anchor.line}</button>
              ))}
            </div>
          ) : null}
          <SourceView source={source} />
        </article>
        <aside className="hotspots">
          <h2>维护热点</h2>
          {overview.hotspots.length ? overview.hotspots.slice(0, 8).map((hotspot) => <div className="hotspot" key={hotspot.path}><code>{hotspot.path}</code><span>{hotspot.changes}</span></div>) : <p>该仓库没有可读取的 Git 历史。</p>}
        </aside>
      </div>
    </section>
  );
}