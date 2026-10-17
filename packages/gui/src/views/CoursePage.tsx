import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type { CourseNode, CourseNodeDetail, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import type { ScopedChatApi } from "../agent/useScopedChat";
import { EmptyState, flatten, Loading } from "./helpers";
import { RepoTree } from "./RepoTree";
import { MobileSwitcher, PageTopbar, useMobilePanes } from "./WorkspaceChrome";
import { subscribeServerEvents } from "../api/client";
import { ColumnResizer } from "../ui/ColumnResizer";
import { ArchOverview, ARCH_REGEN_CONFIRM, ARCH_REGEN_PRICE_NOTE, archRegenToast, NO_ARCH_STATUS, type ArchStatus } from "../map/ArchOverview";
import { FLOW_KIND_LABEL, FlowMap, type FlowSelection, type FlowStatus } from "../map/FlowMap";
import { Icon } from "../ui/icons";
import { emit } from "../journal";
import { showToast } from "../modules/toast";

/**
  宏观设计工作区（两栏，prototype `.page-map` = `.map-side` + `.map-main`）：
  - 左 「项目目录」：真实目录层级树（v0.5.4 起与原始目录结构一致，顶层目录保留语义标签；
    早期版本按顶层目录平铺文件，用户反馈看不到子目录后改为 RepoTree）
  - 右 「地图画布」：`.map-viewbar` 切两个视图（`.view-toggle`）——
    「架构视图」= **分层全景**（`ArchOverview`）：一条系统边界 + 层序号导轨 + 只读方块，边不上画布；
    「流程视图」由 **LLM 生成**（`FlowMap`）：环节 = 一次执行经过的步骤，关联文件只在该环节的「节点详情」里展示，
    画布上不出现路径。课程树不上图（层级交给左侧目录与教学页），点击模块合成 CourseNode 走抽屉与地图线程。
  - 花钱动作与流程「重新生成」同位：架构的「判一次分层」长在 viewbar 上，取数与产物却住在 `ArchOverview`，
    所以确认、调用、回告都在这边（一次实现，不可用卡片那颗按钮也走它），完了 bump `archNonce` 让子组件重取。
  - 节点详情是画布右侧的 `.drawer`（展开时 `.map-stage:has(.drawer)` 给画布让出宽度），不再是独立第三栏；源码抽屉已移除（v0.5.3）。
    抽屉在架构视图里显示节点，在流程视图里显示环节、它的出边依据与关联文件。
  - 选中节点 / 文件只更新会话绑定与线程（v0.8.1 起不再往线程插「已切换到 / 已选中」分隔线）

  对应 prototype `docs/ui-prototype/js/pages.js` 的 mapPage / archCanvas / flowCanvas / flowDrawer。
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

/**
  出边依据的正文写法。`inferred` 那句是模型自述「我凭什么这么连」——动辄七八十字、夹一串文件名清单，
  读者要的不是它的措辞，而是这条去向**没有行级依据**，所以正文只说这一档意味着什么，原话整段留在悬停里。
  static / code 的依据是行级事实（路径:行号），照原样给，只按长度截一下。
  */
function edgePlain(edge: { origin: "static" | "code" | "inferred"; evidence: string }): string {
  if (edge.origin === "inferred") return "没有行级依据：模型按编排推的";
  const head = edge.evidence.split(/[；;]/)[0].trim();
  return head.length > 46 ? `${head.slice(0, 46)}…` : head;
}

/** 锚点只露文件名：抽屉只有 `--drawer-w` 宽，整条路径读不完，全路径进 title。 */
function fileTail(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

/** 时间戳只露到分钟（完整 ISO 串留在 title）——「产物是哪天生成的」要能一眼对上。 */
function stamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const NO_FLOW_STATUS: FlowStatus = { source: null, generatedAt: "", title: "", summary: "", loading: false };

export function CoursePage({ workspace, chat: t, visible }: { workspace: Workspace; chat: ScopedChatApi; visible: boolean }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const [index, setIndex] = useState<RepositoryIndex | null>(null);
  const [analysis, setAnalysis] = useState<RepositoryAnalysis | null>(null);
  const [detail, setDetail] = useState<CourseNodeDetail | null>(null);
  /** 节点详情抽屉是否展开。架构视图里由节点点击 / 按钮打开，流程视图里由环节点击打开。 */
  const [drawer, setDrawer] = useState(false);
  /** 流程视图里选中的环节：关联文件只在详情里展示，画布上不出现路径。 */
  const [flowSelection, setFlowSelection] = useState<FlowSelection | null>(null);
  /** 架构视图那个合成模块的文件清单：抽屉里「绑定到对话」要按同一份清单再绑一次（见 useScopedChat 的 scopePaths） */
  const [moduleScopePaths, setModuleScopePaths] = useState<string[]>([]);
  /** 流程取数状态由 `FlowMap` 回告：来源徽标与「重新生成」长在 `.map-viewbar` 上，取数却住在那里 */
  const [flowStatus, setFlowStatus] = useState<FlowStatus>(NO_FLOW_STATUS);
  /** 架构视图的取数状态由 `ArchOverview` 回告：工具栏那枚徽标要说清「这几层是模型判的还是静态兜底」。 */
  const [archStatus, setArchStatus] = useState<ArchStatus>(NO_ARCH_STATUS);
  /** 人工修正落盘后要重取产物：这里只出一个自增号，取数住在子组件里。 */
  const [archNonce, setArchNonce] = useState(0);
  /** 「判一次分层」在途：确认框之后的这段时间也要让按钮和徽标说真话（子组件的 loading 只覆盖它自己取数那段）。 */
  const [archRegening, setArchRegening] = useState(false);
  /** Agent 在对话里改了分层（`set_architecture`）时引擎会广播一帧；这边只认自己这个仓。 */
  useEffect(() => {
    const controller = new AbortController();
    subscribeServerEvents((event) => {
      if (event.type !== "architecture_updated") return;
      if (event.payload.repositoryId !== repositoryId) return;
      setArchNonce((value) => value + 1);
    }, controller.signal);
    return () => controller.abort();
  }, [repositoryId]);
  /** 判一次分层是花钱动作：确认、调用、回告只留这一处（viewbar 那颗与画布「分层不可用」卡片上的那颗走同一条）。 */
  const regenerateArch = (): void => {
    if (!window.confirm(ARCH_REGEN_CONFIRM)) return;
    setArchRegening(true);
    api.regenerateArchitecture(repositoryId)
      .then((plan) => showToast(archRegenToast(plan)))
      .catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "判分层没成功"))
      .finally(() => { setArchRegening(false); setArchNonce((value) => value + 1); });
  };
  const [regenNonce, setRegenNonce] = useState(0);
  const [error, setError] = useState("");
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();
  const [mapView, setMapView] = useState<"architecture" | "flow">("architecture");
  const navigate = useNavigate();

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
  /** 引擎在图里标的入口文件（HTTP 路由 / 框架启动）：抽屉里那份文件清单排序的第一档。 */
  const entryPaths = useMemo(() => new Set((analysis?.graph.entrypoints ?? []).map((anchor) => anchor.path)), [analysis]);
  const hotOf = useMemo(() => {
    const map = new Map<string, number>();
    index?.hotspots.forEach((spot) => map.set(spot.path, spot.changes));
    return map;
  }, [index]);
  /**
    节点的可见文件（本节点锚点 + 子孙锚点，按 path 去重、留第一次出现的锚点行号），
    按「是入口 → 变更最多 → 行数最大」排。这一格取代了原先的两格：`下级节点（15）` 把同一文件里的
    函数铺成 15 个平行条目，`源码锚点` 又按锚点重复列同一个文件——读者要的只是「这个模块先看哪几个文件」。
    */
  const coreFiles = useMemo(() => {
    if (!selected) return [];
    const rows = new Map<string, { path: string; line: number; label: string; hot: number }>();
    for (const node of flatten(selected)) for (const anchor of node.anchors) {
      if (rows.has(anchor.path)) continue;
      rows.set(anchor.path, { path: anchor.path, line: anchor.line, label: anchor.label ?? "", hot: hotOf.get(anchor.path) ?? 0 });
    }
    return [...rows.values()].sort((left, right) =>
      Number(entryPaths.has(right.path)) - Number(entryPaths.has(left.path))
      || right.hot - left.hot
      || (lineOf.get(right.path) ?? 0) - (lineOf.get(left.path) ?? 0));
  }, [selected, entryPaths, hotOf, lineOf]);

  const course = t.course;
  const pickNode = (node: CourseNode, scopePaths: string[] = []): void => {
    t.setMapNode(node, scopePaths);
    t.setMapBinding({ kind: "module", title: node.title });
    setModuleScopePaths(scopePaths);
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

  const repositoryName = (index?.repositoryPath ?? workspace.repositoryPath).split("/").filter(Boolean).pop() ?? repositoryId;
  const crumbContext = mapView === "flow"
    ? (flowSelection ? `第 ${flowSelection.stage.order} 环节 · ${flowSelection.stage.title}` : "未选中环节")
    : (selected?.title ?? "未选中模块");
  const topbar = (
    <PageTopbar
      crumb={<><b>{repositoryName}</b><span className="faint">/</span><span>宏观设计</span><span className="faint">·</span><span className="muted">{crumbContext}</span></>}
      showRailToggle
    />
  );

  if (error) return <>{topbar}<EmptyState title="课程暂不可用" detail={error} /></>;
  if (!course || !index || !analysis) return <>{topbar}<Loading /></>;

  /** 环节 → 对话作用域：课程树里有该流程入口对应的 workflow 节点就挂它；
      没有就解绑（请求退回全局视野）——留着上一个模块的节点会让 agent 答的不是用户选中的东西。
      环节本身（说明/关联文件/分叉回环）作为 focus 一并上送：课程树节点只到入口粒度，不带它就答不了「这个环节具体做什么」 */
  const workflowOf = (flow: FlowSelection["flow"]): CourseNode | null =>
    flatten(course.root).find((item) => item.id === `workflow:${flow.entry.path}`) ?? null;
  const bindStage = (selection: FlowSelection | null): void => {
    if (!selection) { t.setMapNode(null); return; }
    t.setMapBinding({ kind: "flow", title: selection.stage.title });
    t.setMapNode(workflowOf(selection.flow), [], selection.stage);
  };
  /** 抽屉里跳代码教学：只认真实课程树节点（架构图现在画的就是树里的模块），查不到就只换工作区。 */
  const gotoTeach = (node: CourseNode | null): void => {
    const real = node ? flatten(course.root).find((item) => item.id === node.id) : undefined;
    if (real) t.setSelected(real);
    navigate("/app?workspace=teaching");
  };

  const implementation = detail?.implementation;
  const outgoingEdges = flowSelection ? flowSelection.flow.edges.filter((edge) => edge.from === flowSelection.stage.order) : [];

  const drawerBody = mapView === "flow"
    ? (flowSelection ? (
      <>
        <div className="kv">
          <span className="kv-k">环节说明</span>
          <span className="kv-v">{flowSelection.stage.detail}</span>
        </div>
        {flowSelection.stage.branches.length ? (
          <div className="kv">
            <span className="kv-k">{`去向与判断依据（${flowSelection.stage.branches.length}）`}</span>
            <div className="row-wrap">{flowSelection.stage.branches.map((branch) => <span key={branch} className="branch-chip">{branch}</span>)}</div>
          </div>
        ) : null}
        {/* 出边 + 依据：`flow.edges` 才是拓扑真源，origin 三档说的是「这条去向有多可核对」 */}
        <div className="kv">
          <span className="kv-k">{`出边（${outgoingEdges.length}）`}</span>
          {outgoingEdges.length ? (
            outgoingEdges.map((edge) => (
              <div className="col" key={`${edge.from}->${edge.to}`}>
                <span className="row">
                  <span
                    className={`flow-origin origin-${edge.origin}`}
                    title={edge.origin === "static" ? "依赖图能证明这条去向" : edge.origin === "code" ? "在源码正文里读到的编排（回调、路由、注入）" : "模型按编排常识推断，没有可核对的行级依据"}
                  >{edge.origin}</span>
                  <span className="fs-11 faint">{`→ 第 ${edge.to} 环节`}</span>
                </span>
                <span className={`kv-v${edge.origin === "inferred" ? "" : " mono"}`} title={edge.evidence}>{edgePlain(edge)}</span>
              </div>
            ))
          ) : <span className="kv-v muted">没有记出的去向边</span>}
        </div>
        <div className="kv">
          <span className="kv-k">{`关联文件（${flowSelection.stage.files.length}）`}</span>
          <div className="col">
            {flowSelection.stage.files.map((file) => (
              <button key={`${file.path}:${file.line}`} type="button" className="anchor-chip" title={`${file.path}:${file.line}${file.note ? ` · ${file.note}` : ""}`} onClick={() => openFile(file.path, "flow")}>
                <Icon name="file" size={12} />
                <span>{`${fileTail(file.path)}:${file.line}`}</span>
                {file.note ? <em className="fs-11 faint">{file.note}</em> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="kv">
          <span className="kv-k">所属流程</span>
          <span className="kv-v" title={`${flowSelection.flow.summary}（生成时间 ${flowSelection.flow.generatedAt}）`}>{flowSelection.flow.title}</span>
        </div>
        <div className="row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => gotoTeach(workflowOf(flowSelection.flow))}><Icon name="book" size={13} />去代码教学</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => bindStage(flowSelection)}><Icon name="zap" size={13} />绑定到对话</button>
        </div>
        {/* 「已知边界」不在这里重复一遍：同一条 caveats 已经写在流程画布下方（抽屉压在画布旁边，两处并排就是同屏两遍） */}
      </>
    ) : (
      <div className="empty">
        <span className="empty-icon"><Icon name="info" size={18} /></span>
        <p>点流程里的任一环节</p>
      </div>
    ))
    : (
      <>
        <div className="kv">
          <span className="kv-k">摘要</span>
          <span className="kv-v">{selected?.summary ?? "点画布上的模块，或左侧目录里的文件"}</span>
        </div>
        {coreFiles.length ? (
          <div className="kv">
            <span className="kv-k">{`核心相关文件（${coreFiles.length}）`}</span>
            <div className="col">
              {coreFiles.slice(0, 6).map((file) => (
                <button key={file.path} type="button" className="tier-node" title={`${file.path}:${file.line}${file.label ? ` · ${file.label}` : ""}`} onClick={() => openFile(file.path, "anchor")}>
                  <Icon name="file" size={13} />
                  <span className="tier-name mono">{`${fileTail(file.path)}:${file.line}`}</span>
                  <span className="tier-count">{`${entryPaths.has(file.path) ? "入口 · " : ""}${(lineOf.get(file.path) ?? 0).toLocaleString()} 行${file.hot ? ` · ${file.hot} 次变更` : ""}`}</span>
                </button>
              ))}
              {coreFiles.length > 6 ? (
                <span className="fs-11 faint mono" title={coreFiles.slice(6).map((file) => file.path).join("\n")}>{`另有 ${coreFiles.length - 6} 个文件`}</span>
              ) : null}
            </div>
          </div>
        ) : null}
        {implementation ? (
          <>
            <div className="kv"><span className="kv-k">输入</span><span className="kv-v">{implementation.inputs.join("、")}</span></div>
            <div className="kv"><span className="kv-k">输出</span><span className="kv-v">{implementation.output}</span></div>
            <div className="kv"><span className="kv-k">不变量</span><span className="kv-v">{implementation.invariants.join("；")}</span></div>
            <div className="kv"><span className="kv-k">边界与陷阱</span><span className="kv-v">{[...implementation.boundaries, ...implementation.traps].join("；") || "尚未检测到显式边界。"}</span></div>
          </>
        ) : null}
        <div className="row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => gotoTeach(selected ?? null)}><Icon name="book" size={13} />去代码教学</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!selected} onClick={() => { if (selected) pickNode(selected, moduleScopePaths); }}><Icon name="zap" size={13} />绑定到对话</button>
        </div>
      </>
    );

  return (
    <>
      {topbar}
      <MobileSwitcher labels={["项目目录", "地图画布"]} active={paneActive} onSelect={setPaneActive} />
      <div className="page page-map">
        {/* 与教学页同一条列表栏宽度：拖一次，三个工作区的左栏一起跟 */}
        <ColumnResizer field="filePaneWidth" label="列表栏" growOn="right" />
        <aside className={`map-side ${paneClass(0)}`}>
          <div>
            <div className="row between">
              <span className="section-title">项目目录</span>
              <span className="fs-11 faint">{index.totalFiles}</span>
            </div>
            <RepoTree
              nodes={index.fileTree}
              onOpenFile={openFile}
              activePath={t.mapFile}
              lineOf={lineOf}
              badge={(node, depth) => (depth === 0 ? groupLabel(node.name) : undefined)}
            />
          </div>
        </aside>

        <div className={`map-main ${paneClass(1)}`}>
          <div className="map-viewbar">
            <div className="view-toggle" role="tablist" aria-label="地图视图">
              <button type="button" role="tab" aria-selected={mapView === "architecture"} className={mapView === "architecture" ? "active" : ""} onClick={() => { setMapView("architecture"); setDrawer(false); }}>架构视图</button>
              <button type="button" role="tab" aria-selected={mapView === "flow"} className={mapView === "flow" ? "active" : ""} onClick={() => { setMapView("flow"); setDrawer(false); }}>流程视图</button>
            </div>
            {mapView === "flow" ? (
              <>
                <span
                  className={`badge ${flowStatus.source === "llm" ? "badge-info" : flowStatus.source === "static" ? "badge-warn" : "badge-neutral"}`}
                  title={`${flowStatus.source === "static"
                    ? "LLM 未配置、预算触顶或调用失败时退回静态调用链——它不冒充模型结论"
                    : "环节与边由 LLM 依据静态证据生成；边级校验只降不升，声称 static 而对不上依赖图的降为 inferred"}${flowStatus.generatedAt ? ` · 生成时间 ${flowStatus.generatedAt}` : ""}`}
                >
                  {`${flowStatus.loading ? "生成中" : flowStatus.source === "llm" ? "LLM 生成" : flowStatus.source === "static" ? "静态降级" : "未生成"}${flowStatus.generatedAt ? ` · ${stamp(flowStatus.generatedAt)}` : ""}`}
                </span>
                {flowStatus.title ? <span className="fs-11 muted" title={flowStatus.summary}>{flowStatus.title}</span> : null}
              </>
            ) : (
              <>
                <span
                  className={`badge ${archStatus.source === "llm" ? "badge-info" : archStatus.source === "unavailable" ? "badge-warn" : "badge-neutral"}`}
                  title={`层名与归层由模型判（要改在对话里让 agent 动）；方块怎么压、边界外那一栏由词典认出，模型参与不了。${archStatus.reason ?? ""}`}
                >{`${archStatus.loading ? "分层中" : archStatus.source === "llm" ? "LLM 分层" : archStatus.source === "unavailable" ? "分层不可用" : "未取到"}${archStatus.source === "llm" ? ` · ${archStatus.layers} 层` : ""}`}</span>
                <span className="fs-11 faint mono" title={`依赖分析生成时间（ISO）：${analysis.generatedAt}${archStatus.generatedAt ? ` · 分层产物生成于 ${archStatus.generatedAt}` : ""}`}>{`分析于 ${stamp(analysis.generatedAt)}`}</span>
              </>
            )}
            <div className="grow" />
            {mapView === "flow" ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={flowStatus.loading}
                title="重发这一趟取数：引擎侧若仍命中缓存，回来的还是同一条流程"
                onClick={() => setRegenNonce((value) => value + 1)}
              ><Icon name="rotate" size={13} />重新生成</button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={archStatus.loading}
                title={`重问一次模型怎么分层：${ARCH_REGEN_PRICE_NOTE}。边界外那一栏不变——它从来不是模型算的。`}
                onClick={regenerateArch}
              ><span className={archRegening ? "spin" : undefined} style={{ display: "inline-flex" }}><Icon name="rotate" size={13} /></span>{archRegening ? "分层中…" : "判一次分层"}</button>
            )}
            {/* 详情入口放在工具栏行内：原先浮在画布右上角，会压住流程视图首行的入口卡片 */}
            {drawer ? null : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDrawer(true)}>
                <Icon name="panelRight" size={13} />{mapView === "flow" ? "环节详情" : "节点详情"}
              </button>
            )}
          </div>
          {/* 抽屉与画布同处一层：抽屉绝对定位只盖画布，不盖上面那条视图切换栏 */}
          <div className="map-stage">
          <div className="map-canvas-wrap">
            <div className="map-canvas">
              {mapView === "architecture"
                ? <ArchOverview repositoryId={repositoryId} course={course} visible={visible} selectedId={selected?.id} reloadNonce={archNonce + t.dataVersion} regenerating={archRegening} onRegenerate={regenerateArch} onSelect={pickNode} onStatus={setArchStatus} />
                : (
                  <FlowMap
                    repositoryId={repositoryId}
                    analysis={analysis}
                    index={index}
                    visible={visible}
                    selectedStageOrder={flowSelection?.stage.order}
                    regenNonce={regenNonce}
                    onStatus={setFlowStatus}
                    onSelectStage={(selection) => {
                      setFlowSelection(selection);
                      setDrawer(selection !== null);
                      bindStage(selection);
                      if (selection) {
                        emit(repositoryId, "flow_node_selected", { node_id: `flow-stage-${selection.stage.order}`, title: selection.stage.title.slice(0, 120), view: "flow" });
                      }
                    }}
                  />
                )}
            </div>
          </div>
          {drawer ? (
            <aside className="drawer" aria-label="节点详情">
              <div className="drawer-head">
                <h3>{mapView === "flow" ? (flowSelection ? `第 ${flowSelection.stage.order} 环节 · ${flowSelection.stage.title}` : "环节详情") : (selected?.title ?? "节点详情")}</h3>
                <span className="badge badge-neutral">{mapView === "flow" ? (flowSelection ? FLOW_KIND_LABEL[flowSelection.stage.kind] : "未选中") : kindLabel(selected?.kind)}</span>
                <button type="button" className="icon-btn" aria-label="关闭详情" title="关闭详情" onClick={() => setDrawer(false)}><Icon name="x" size={14} /></button>
              </div>
              <div className="drawer-body">{drawerBody}</div>
            </aside>
          ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
