import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Code2, Eye, X } from "lucide-react";
import type { CourseNode, CourseNodeDetail, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import type { TeachingSessionApi } from "../agent/useTeachingSession";
import { EmptyState, Loading, MicroDetail } from "./helpers";
import { RepoTree } from "./RepoTree";
import { ContextLine, MobileSwitcher, useMobilePanes } from "./WorkspaceChrome";
import { DepMap } from "../map/DepMap";
import { FLOW_KIND_LABEL, FlowMap, type FlowSelection } from "../map/FlowMap";
import { emit } from "../journal";
import { showToast } from "../modules/toast";

/**
  宏观设计工作区（两栏，源自 prototype `.map-workspace`）：
  - 左 「项目目录」：真实目录层级树（v0.5.4 起与原始目录结构一致，顶层目录保留语义标签；
    早期版本按顶层目录平铺文件，用户反馈看不到子目录后改为 RepoTree）
  - 右 「地图画布」：v0.9 起分两个视图（`map-viewbar` 切换）——
    「架构视图」由**文件**驱动 = 模块依赖图（`DepMap`）：节点 = 目录聚合模块，边 = import 依赖，入口模块在最左列；
    「流程视图」由 **LLM 生成**（`FlowMap`）：环节 = 一次执行经过的步骤，关联文件只在该环节的「节点详情」里展示，
    画布上不出现路径。课程树不上图（层级交给左侧目录与教学页），点击模块合成 CourseNode 走抽屉与地图线程。
  - 节点详情作为画布内的抽屉（触发后才覆盖画布右侧），不再是独立第三栏；源码抽屉已移除（v0.5.3）。
    抽屉在架构视图里显示节点，在流程视图里显示环节及其关联文件。展开时给流程让位（`.map-canvas.detail-open`）。
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
  /** 节点详情抽屉是否展开。架构视图里由节点点击 / 按钮打开，流程视图里由环节点击打开。 */
  const [drawer, setDrawer] = useState(false);
  /** 流程视图里选中的环节：关联文件只在详情里展示，画布上不出现路径。 */
  const [flowSelection, setFlowSelection] = useState<FlowSelection | null>(null);
  const [error, setError] = useState("");
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();
  const [mapView, setMapView] = useState<"architecture" | "flow">("architecture");

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
    t.setMapBinding({ kind: "module", title: node.title });
    setDrawer(true);
    emit(repositoryId, "flow_node_selected", { node_id: node.id, title: node.title.slice(0, 120), view: mapView });
  };
  // 源码抽屉已按需求移除（v0.5.3）：点文件只同步到 Agent 绑定（绑定区展示），
  // 源码阅读在「代码教学」工作区的实时源码面板完成。
  const openFile = (path: string, source: "tree" | "anchor" | "flow" = "tree"): void => {
    t.setMapFile(path);
    // 绑定行只认三种情形：目录选文件 / 架构模块(+其关联文件) / 流程环节(+其关联文件)
    if (source === "tree") t.setMapBinding({ kind: "file", path });
    else if (source === "flow") t.setMapBinding({ kind: "flow", title: flowSelection?.stage.title, path });
    else t.setMapBinding({ kind: "module", title: t.mapNode?.title, path });
    showToast(`已选中 · ${path}`);
    emit(repositoryId, "file_anchored", { path, source });
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
      <ContextLine strong="宏观设计" detail={`选中「${selected?.title ?? "—"}」`} />
      <MobileSwitcher labels={["项目目录", "地图画布"]} active={paneActive} onSelect={setPaneActive} />
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

        <section className={`pane map-canvas ${paneClass(1)}${drawer ? " detail-open" : ""}`}>
          <div className="map-viewbar">
            <div className="view-switch" role="tablist" aria-label="地图视图">
              <button type="button" role="tab" aria-selected={mapView === "architecture"} className={mapView === "architecture" ? "active" : ""} onClick={() => setMapView("architecture")}>架构视图</button>
              <button type="button" role="tab" aria-selected={mapView === "flow"} className={mapView === "flow" ? "active" : ""} onClick={() => setMapView("flow")}>流程视图</button>
            </div>
            <span className="map-viewbar-note">
              {mapView === "architecture" ? "模块依赖图 · 从左到右按依赖方向分层" : "LLM 按入口生成执行流程 · 每个环节关联的文件见节点详情"}
            </span>
          </div>
          {mapView === "architecture"
            ? <DepMap index={index} analysis={analysis} selectedId={selected?.id} onSelect={pickNode} />
            : (
              <FlowMap
                repositoryId={repositoryId}
                analysis={analysis}
                index={index}
                selectedStageOrder={flowSelection?.stage.order}
                onSelectStage={(selection) => {
                  setFlowSelection(selection);
                  setDrawer(selection !== null);
                  if (selection) t.setMapBinding({ kind: "flow", title: selection.stage.title });
                  if (selection) emit(repositoryId, "flow_node_selected", { node_id: `flow-stage-${selection.stage.order}`, title: selection.stage.title.slice(0, 120), view: "flow" });
                }}
              />
            )}
          {drawer ? (
            <aside className="map-detail" aria-label="节点详情">
              <div className="map-detail-head">
                <span>{mapView === "flow" ? "环节详情" : "节点详情"}</span>
                <button className="map-detail-toggle" aria-label="关闭详情" title="关闭详情" onClick={() => setDrawer(false)}>
                  <X size={13} />
                </button>
              </div>
              {mapView === "flow" ? (
                <div className="detail">
                  {flowSelection ? (
                    <>
                      <h3>{flowSelection.stage.title}</h3>
                      <span className="kind-badge">{`第 ${flowSelection.stage.order} 环节 · ${FLOW_KIND_LABEL[flowSelection.stage.kind]}`}</span>
                      <p>{flowSelection.stage.detail}</p>
                      {flowSelection.stage.loopsTo !== undefined ? (
                        <p className="detail-note">{`这是一个回环：流程回到第 ${flowSelection.stage.loopsTo} 环节继续。`}</p>
                      ) : null}
                      {flowSelection.stage.branches.length ? (
                        <div className="detail-section">
                          <h4>去向与判断依据</h4>
                          <div className="flow-files">
                            {flowSelection.stage.branches.map((branch) => <span key={branch} className="flow-branch">{branch}</span>)}
                          </div>
                        </div>
                      ) : null}
                      <div className="detail-section">
                        <h4>{`关联文件（${flowSelection.stage.files.length}）`}</h4>
                        <div className="flow-files">
                          {flowSelection.stage.files.map((file) => (
                            <button key={file.path} type="button" className="flow-file" onClick={() => openFile(file.path, "flow")}>
                              <span className="flow-file-where"><Code2 size={12} />{`${file.path}:${file.line}`}</span>
                              {file.note ? <small>{file.note}</small> : null}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="detail-note">{`所属流程：${flowSelection.flow.title}`}</p>
                      {flowSelection.flow.caveats ? <p className="detail-note">{`已知边界：${flowSelection.flow.caveats}`}</p> : null}
                    </>
                  ) : (
                    <p className="detail-note">点流程里的任一环节，这里显示它关联的文件。</p>
                  )}
                </div>
              ) : (
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
                          <button key={`${anchor.path}:${anchor.line}`} className="anchor" onClick={() => openFile(anchor.path, "anchor")}>
                            <Code2 size={13} />{anchor.path}:{anchor.line}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </aside>
          ) : (
            <button className="map-detail-open" onClick={() => setDrawer(true)}><Eye size={13} />{mapView === "flow" ? "环节详情" : "节点详情"}</button>
          )}
        </section>
      </div>
    </section>
  );
}
