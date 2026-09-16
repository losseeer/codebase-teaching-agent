import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Code2, Eye, X } from "lucide-react";
import type { CourseNode, CourseNodeDetail, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import type { TeachingSessionApi } from "../agent/useTeachingSession";
import { EmptyState, Loading, MicroDetail } from "./helpers";
import { RepoTree } from "./RepoTree";
import { ContextLine, MobileSwitcher, useMobilePanes } from "./WorkspaceChrome";
import { DepMap } from "../map/DepMap";
import { showToast } from "../modules/toast";

/**
  代码地图工作区（两栏，源自 prototype `.map-workspace`）：
  - 左 「项目目录」：真实目录层级树（v0.5.4 起与原始目录结构一致，顶层目录保留语义标签；
    早期版本按顶层目录平铺文件，用户反馈看不到子目录后改为 RepoTree）
  - 右 「运行路径」画布：v0.6 起为模块依赖图（`DepMap`）——节点 = 目录聚合模块，
    边 = import 依赖，入口模块在最左列；课程树不再上图（层级交给左侧目录与教学页），
    点击模块合成 CourseNode 走抽屉与地图线程。v0.5.4 曾为课程树总览层（总览化的中间态）。
  - 节点详情作为画布内的抽屉（触发后才覆盖画布右侧），不再是独立第三栏；源码抽屉已移除（v0.5.3）
  - 选中节点 / 文件只更新会话绑定与线程（v0.8.1 起不再往线程插「已切换到 / 已选中」分隔线）

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

export function CoursePage({ workspace, session: t }: { workspace: Workspace; session: TeachingSessionApi }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const [index, setIndex] = useState<RepositoryIndex | null>(null);
  const [analysis, setAnalysis] = useState<RepositoryAnalysis | null>(null);
  const [detail, setDetail] = useState<CourseNodeDetail | null>(null);
  const [drawer, setDrawer] = useState<"node" | null>(null);
  const [error, setError] = useState("");
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();

  useEffect(() => {
    let current = true;
    setError("");
    setAnalysis(null);
    api.getIndex(repositoryId).then((next) => { if (current) setIndex(next); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "无法加载仓库索引"); });
    api.getAnalysis(repositoryId).then((next) => { if (current) setAnalysis(next); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "无法加载依赖分析"); });
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

  const course = t.course;
  const pickNode = (node: CourseNode): void => {
    t.setMapNode(node);
    setDrawer("node");
  };
  // 源码抽屉已按需求移除（v0.5.3）：点文件只同步到 Agent 绑定（绑定区展示），
  // 源码阅读在「代码教学」工作区的实时源码面板完成。
  const openFile = (path: string): void => {
    t.setMapFile(path);
    showToast(`已选中 · ${path}`);
  };

  if (error) return <EmptyState title="课程暂不可用" detail={error} />;
  if (!course || !index || !analysis) return <Loading />;

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
            <RepoTree
              nodes={index.fileTree}
              onOpenFile={openFile}
              activePath={t.mapFile}
              lineOf={lineOf}
              badge={(node, depth) => (depth === 0 ? groupLabel(node.name) : undefined)}
            />
          </div>
        </aside>

        <section className={`pane map-canvas ${paneClass(1)}`}>
          <DepMap index={index} analysis={analysis} selectedId={selected?.id} onSelect={pickNode} />
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
                {selected?.children.length ? (
                  <div className="detail-section">
                    <h4>下级节点（{selected.children.length}）</h4>
                    <div className="node-children">
                      {selected.children.map((child) => (
                        <button
                          key={child.id}
                          type="button"
                          className="node-child"
                          onClick={() => t.setMapNode(child)}
                        >
                          <strong>{child.title}</strong>
                          <em>{kindLabel(child.kind)}{child.children.length ? ` · ${child.children.length} 项` : ""}</em>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
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
