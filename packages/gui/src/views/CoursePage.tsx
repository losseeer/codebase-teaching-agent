import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Code2, Eye, X } from "lucide-react";
import type { CourseNode, CourseNodeDetail, FileTreeNode, RepositoryIndex } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import type { TeachingSessionApi } from "../agent/useTeachingSession";
import { EmptyState, Loading, MicroDetail } from "./helpers";
import { ContextLine, MobileSwitcher, useMobilePanes } from "./WorkspaceChrome";
import { FlowMap } from "../map/FlowMap";
import { showToast } from "../modules/toast";

/**
  代码地图工作区（对齐 prototype `.map-workspace`，两栏）：
  - 左 「项目目录」：真实 `fileTree` 按顶层目录分组（目录给语义标签 + 文件行数 + 「显示其余 N 个文件」）
  - 右 「运行路径」画布（`FlowMap`）：课程树分层流程图，画布内部滚动，页面无滚动条
  - 节点详情作为画布内的抽屉（触发后才覆盖画布右侧），不再是独立第三栏；源码抽屉已移除（v0.5.3）
  - 选中节点 → map 线程「已切换到 · 标题」；选中文件 → 「已选中 · path」

  对应 prototype `design-prototype.html` L63-67 / L304-307（map-workspace + map-canvas + flow-node）。
  */

const GROUP_LABELS: { pattern: RegExp; label: string }[] = [
  { pattern: /^(src|lib|app|apps|packages|core|internal|server|client|service|services)$/i, label: "核心代码" },
  { pattern: /^(tests?|spec|specs|__tests__|e2e)$/i, label: "行为证据" },
  { pattern: /^(docs?|documentation|wiki|examples?)$/i, label: "项目说明" },
  { pattern: /^(public|assets?|static|images?|fonts?)$/i, label: "静态资源" },
  { pattern: /^(scripts?|tools?|bin|build|config|configs)$/i, label: "脚本与配置" },
];

function groupLabel(name: string): string {
  return GROUP_LABELS.find((entry) => entry.pattern.test(name))?.label ?? "其他文件";
}

/** CourseNode.kind 的中文展示（不再直显 workflow 等英文 kind）。 */
export function kindLabel(kind: CourseNode["kind"] | undefined): string {
  if (kind === "workflow") return "执行路径";
  if (kind === "module") return "模块";
  if (kind === "implementation") return "实现";
  return "概览";
}

interface TreeGroup {
  id: string;
  name: string;
  label: string;
  files: { path: string; name: string; lines: number }[];
}

export function CoursePage({ workspace, session: t }: { workspace: Workspace; session: TeachingSessionApi }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const [index, setIndex] = useState<RepositoryIndex | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [detail, setDetail] = useState<CourseNodeDetail | null>(null);
  const [drawer, setDrawer] = useState<"node" | null>(null);
  const [error, setError] = useState("");
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();

  useEffect(() => {
    let current = true;
    setError("");
    api.getIndex(repositoryId).then((next) => { if (current) setIndex(next); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "无法加载仓库索引"); });
    return () => { current = false; };
  }, [repositoryId, t.dataVersion]);

  const selected = t.mapNode;
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let current = true;
    api.getCourseNodeDetail(repositoryId, selected.id).then((next) => { if (current) setDetail(next); })
      .catch(() => { if (current) setDetail(null); });
    return () => { current = false; };
  }, [selected?.id, repositoryId]);

  const lineOf = useMemo(() => {
    const map = new Map<string, number>();
    index?.files.forEach((file) => map.set(file.path, file.lines));
    return map;
  }, [index]);

  const groups = useMemo<TreeGroup[]>(() => {
    if (!index) return [];
    const collect = (node: FileTreeNode, base: string, out: { path: string; name: string; lines: number }[]): void => {
      if (node.kind === "directory") node.children?.forEach((child) => collect(child, base, out));
      else out.push({ path: node.path, name: base ? `${base}/${node.name}` : node.name, lines: lineOf.get(node.path) ?? 0 });
    };
    const built: TreeGroup[] = [];
    const rootFiles: TreeGroup = { id: "__root__", name: "", label: "入口与说明", files: [] };
    index.fileTree.forEach((entry) => {
      if (entry.kind === "file") {
        rootFiles.files.push({ path: entry.path, name: entry.name, lines: lineOf.get(entry.path) ?? 0 });
        return;
      }
      const files: { path: string; name: string; lines: number }[] = [];
      entry.children?.forEach((child) => collect(child, "", files));
      built.push({ id: entry.path, name: entry.name, label: groupLabel(entry.name), files });
    });
    built.sort((left, right) => right.files.length - left.files.length);
    return rootFiles.files.length ? [...built, rootFiles] : built;
  }, [index, lineOf]);

  const course = t.course;
  const pickNode = (node: CourseNode): void => {
    t.setMapNode(node);
    t.pushDivider("map", `已切换到 · ${node.title}`);
    setDrawer("node");
  };
  // 源码抽屉已按需求移除（v0.5.3）：点文件只记录「已选中 · path」并同步到 Agent 绑定，
  // 源码阅读在「代码教学」工作区的实时源码面板完成。
  const openFile = (path: string): void => {
    t.setMapFile(path);
    t.pushDivider("map", `已选中 · ${path}`);
    showToast(`已选中 · ${path}`);
  };

  if (error) return <EmptyState title="课程暂不可用" detail={error} />;
  if (!course || !index) return <Loading />;

  return (
    <section className="page course-page">
      <header className="course-header-compact">
        <p className="eyebrow">宏观课程树</p>
        <h1>{course.root.title}</h1>
        <div className="course-meta"><span>{index.totalFiles} 文件</span><span>{index.hotspots.length} 热点</span></div>
      </header>
      <ContextLine strong="宏观设计讨论" detail={`选中「${selected?.title ?? "—"}」`} />
      <MobileSwitcher labels={["项目目录", "运行路径"]} active={paneActive} onSelect={setPaneActive} />
      <div className="workspace map-workspace">
        <aside className={`pane ${paneClass(0)}`}>
          <div className="pane-header"><h2>项目目录</h2><span>{index.totalFiles} files</span></div>
          <div className="tree">
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.id);
              const open = expandedGroups.has(group.id);
              const visible = collapsed ? [] : open ? group.files : group.files.slice(0, 6);
              return (
                <div className="tree-group" key={group.id}>
                  <button
                    type="button"
                    className={`tree-label${collapsed ? " collapsed" : ""}`}
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsedGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                      return next;
                    })}
                  >
                    <i className="tree-caret" aria-hidden /> <b>{group.name || "根目录"}</b> <span>{group.label}</span>
                    <em className="tree-count">{group.files.length}</em>
                  </button>
                  {visible.map((file) => (
                    <button key={file.path} className={`tree-file${t.mapFile === file.path ? " selected" : ""}`} title={file.path} onClick={() => openFile(file.path)}>
                      ◇ <code>{file.name}</code><em>{file.lines ? `${file.lines}L` : "—"}</em>
                    </button>
                  ))}
                  {!collapsed && !open && group.files.length > visible.length ? (
                    <button className="tree-file tree-more" onClick={() => setExpandedGroups((prev) => new Set(prev).add(group.id))}>
                      … <code>显示其余 {group.files.length - visible.length} 个文件</code><em />
                    </button>
                  ) : null}
                </div>
              );
            })}
            {!groups.length ? <p className="entry-empty">该仓库没有可展示的文件。</p> : null}
          </div>
        </aside>

        <section className={`pane map-canvas ${paneClass(1)}`}>
          <FlowMap root={course.root} selectedId={selected?.id} onSelect={pickNode} />
          {drawer ? (
            <aside className="map-detail" aria-label="节点详情">
              <div className="map-detail-head">
                <span>节点详情</span>
                <button className="map-detail-toggle" aria-label="关闭详情" title="关闭详情" onClick={() => setDrawer(null)}>
                  <X size={13} />
                </button>
              </div>
              <div className="detail">
                <h3>{selected?.title ?? "未选择节点"}</h3>
                <span className="kind-badge">{kindLabel(selected?.kind)}</span>
                <p>{selected?.summary}</p>
                <MicroDetail detail={detail} />
                {selected?.anchors.length ? (
                  <div className="detail-section">
                    <h4>源码锚点</h4>
                    <div className="anchors">
                      {selected.anchors.map((anchor) => (
                        <button key={`${anchor.path}:${anchor.line}`} className="anchor" onClick={() => openFile(anchor.path)}>
                          <Code2 size={13} />{anchor.path}:{anchor.line}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </aside>
          ) : (
            <button className="map-detail-open" onClick={() => setDrawer("node")}><Eye size={13} />节点详情</button>
          )}
        </section>
      </div>
    </section>
  );
}
