import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import type { CourseNode, Diagram, DiagramNode, DiagramSummary, RepositoryIndex } from "@codebase-tutor/shared";
import { api, subscribeServerEvents, type DiagramPosition, type DiagramWarning, type SaveState, type Workspace } from "../api/client";
import type { ScopedChatApi } from "../agent/useScopedChat";
import { Loading, flatten } from "./helpers";
import { RepoTree } from "./RepoTree";
import { MobileSwitcher, PageTopbar, useMobilePanes } from "./WorkspaceChrome";
import { ColumnResizer } from "../ui/ColumnResizer";
import { DiagramCanvas, type DragCommit } from "../map/DiagramCanvas";
import { GalleryPane } from "../map/GalleryPane";
import { NodeDrawer, type DrawerEdge, type DrawerFile, type NodeResolution } from "../map/NodeDrawer";
import { emit } from "../journal";
import { showToast, toastFailure } from "../modules/toast";

// 宏观设计 = agent 画图工作区，两栏：左栏是图库（搜索 / 新建 / 一张图一行 + ⋯ 菜单）与项目目录
// （沿用 `RepoTree` 与栏宽拖拽）两个 tab，右栏是画布那一列（`DiagramCanvas`）。
// 这一页的请求全是免费读（列图库 / 读一张图 / 改名 / 删 / 几何 PUT / 恢复版本），一次都不碰模型。
// 两条写路径分家：界面只写几何，结构改动只有对话里的 agent 一条路（`set_diagram`），不给加删节点的按钮。

/** 按仓记「正打开哪张图 + 左栏停在哪个 tab」。 */
const MAP_MEMORY_KEY = "codebase-tutor.map-memory";
type RailTab = "gallery" | "tree";
interface MapMemory { openId: string | null; railTab: RailTab }
const EMPTY_MEMORY: MapMemory = { openId: null, railTab: "gallery" };

type MapMemoryMap = Record<string, MapMemory>;

function readMapMemory(repositoryId: string): MapMemory {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(MAP_MEMORY_KEY);
  } catch {
    return EMPTY_MEMORY; // 存储不可用：本次会话照常工作，只是不记得上次开到哪张
  }
  if (!raw) return EMPTY_MEMORY;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_MEMORY; // 坏数据按「没记过」处理
  }
  const entry = (parsed as MapMemoryMap | null)?.[repositoryId];
  if (!entry || typeof entry !== "object") return EMPTY_MEMORY;
  const openId = typeof entry.openId === "string" ? entry.openId : null;
  const railTab: RailTab = entry.railTab === "tree" ? "tree" : "gallery";
  return { openId, railTab };
}

function writeMapMemory(repositoryId: string, memory: MapMemory): void {
  try {
    const raw = localStorage.getItem(MAP_MEMORY_KEY);
    let map: MapMemoryMap = {};
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") map = parsed as MapMemoryMap;
    }
    map[repositoryId] = memory;
    localStorage.setItem(MAP_MEMORY_KEY, JSON.stringify(map));
  } catch {
    /* 写失败不打断用户：下次进来重新选 */
  }
}

/** 几何写入的去抖窗口：连续拖动合并成一趟 PUT。 */
const GEOMETRY_DEBOUNCE_MS = 300;

/** 便签与 `arch:` 前缀（架构方块）不指向课程树，不参与引用核对。 */
function isBlockRef(ref: string): boolean {
  return ref.startsWith("arch:");
}

export function CoursePage({ workspace, chat: t, visible, onQuickPrompt }: { workspace: Workspace; chat: ScopedChatApi; visible: boolean; onQuickPrompt?: (text: string) => void }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const memory = useMemo(() => readMapMemory(repositoryId), [repositoryId]);
  const [railTab, setRailTab] = useState<RailTab>(memory.railTab);
  const [openId, setOpenId] = useState<string | null>(memory.openId);
  const [query, setQuery] = useState("");

  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [galleryNonce, setGalleryNonce] = useState(0);
  const [diagramNonce, setDiagramNonce] = useState(0);

  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [serverWarnings, setServerWarnings] = useState<DiagramWarning[]>([]);
  const [diagramLoading, setDiagramLoading] = useState(false);
  const [diagramError, setDiagramError] = useState("");
  const [selected, setSelected] = useState<DiagramNode | null>(null);

  const [saveState, setSaveState] = useState<SaveState>("synced");
  const [saveError, setSaveError] = useState("");
  const [fitNonce, setFitNonce] = useState(0);
  const [versionsSignal, setVersionsSignal] = useState(0);
  const versionsWantedFor = useRef<string | null>(null);

  const [index, setIndex] = useState<RepositoryIndex | null>(null);
  const [indexError, setIndexError] = useState("");

  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const onQuickPromptRef = useRef(onQuickPrompt);
  onQuickPromptRef.current = onQuickPrompt;
  const navigate = useNavigate();
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();

  useEffect(() => { writeMapMemory(repositoryId, { openId, railTab }); }, [repositoryId, openId, railTab]);

  /* ---------- 与对话栏之间的两格：正打开的图（送出去）与卡片点开的图（收进来） ---------- */
  // 这一页是 `openDiagram` 的唯一写入方：绑定行显示「当前图：X」，map-chat 也把它当作用域上送。
  // 对话栏卡片反过来通过 `pendingDiagramOpen` 投递一次「点开这张」，取完即清。
  useEffect(() => {
    if (!openId) { if (t.openDiagram) t.setOpenDiagram(null); return; }
    const summary = diagrams.find((item) => item.id === openId);
    const name = diagram?.id === openId ? diagram.name : summary?.name;
    if (!name) return; // 名字还没到位：等下一拍，不送假名字给模型
    if (t.openDiagram?.id === openId && t.openDiagram.name === name) return;
    t.setOpenDiagram({ id: openId, name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, diagram?.id, diagram?.name, diagrams]);

  useEffect(() => {
    const wanted = t.pendingDiagramOpen;
    if (!wanted) return;
    t.clearDiagramOpen();
    setSelected(null);
    setOpenId(wanted.id);
    setRailTab("gallery");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.pendingDiagramOpen]);

  /* ---------- 图库清单（免费读；只在页面可见时取） ---------- */
  useEffect(() => {
    if (!visible) return;
    let current = true;
    setListLoading(true);
    setListError("");
    api.listDiagrams(repositoryId)
      .then((result) => { if (current) setDiagrams(result.diagrams); })
      .catch((reason: unknown) => { if (current) setListError(reason instanceof Error ? reason.message : "图库读取失败"); })
      .finally(() => { if (current) setListLoading(false); });
    return () => { current = false; };
  }, [repositoryId, visible, galleryNonce, t.dataVersion]);

  const refreshGallery = useCallback((): void => { setGalleryNonce((value) => value + 1); }, []);

  /** 取图收尾：图与引用告警一起落地，顺带处理「版本历史」入口。 */
  const applyDiagram = useCallback((next: Diagram): void => {
    setDiagram(next);
    if (versionsWantedFor.current === next.id) {
      versionsWantedFor.current = null;
      setVersionsSignal((value) => value + 1);
    }
  }, []);

  /* ---------- 当前这张图（免费读） ---------- */
  useEffect(() => {
    if (!openId) { setDiagram(null); setServerWarnings([]); setSelected(null); setDiagramError(""); return; }
    if (!visible) return;
    let current = true;
    setDiagramLoading(true);
    setDiagramError("");
    api.getDiagram(repositoryId, openId)
      .then((result) => {
        if (!current) return;
        applyDiagram(result.diagram);
        setServerWarnings(result.warnings ?? []);
        setSaveState("synced");
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setDiagram(null);
        setDiagramError(reason instanceof Error ? reason.message : "这张图没读到");
      })
      .finally(() => { if (current) setDiagramLoading(false); });
    return () => { current = false; };
  }, [repositoryId, openId, visible, diagramNonce, t.dataVersion, applyDiagram]);

  /** 换仓：上一仓欠下的位置队列整条作废（那些节点 id 不属于本仓的图）。 */
  useEffect(() => {
    pendingPositions.current.clear();
    queueOwner.current = null;
    window.clearTimeout(geometryTimer.current);
    geometryInFlight.current = false;
    setSaveState("synced");
    setSaveError("");
  }, [repositoryId]);

  /* ---------- 引擎广播：agent 画完 / 改完 / 删了（几何拖动不广播） ---------- */
  useEffect(() => {
    const controller = new AbortController();
    subscribeServerEvents((event) => {
      if (event.type !== "diagram_updated") return;
      if (event.payload.repositoryId !== repositoryId) return;
      refreshGallery();
      const changedId = typeof event.payload.diagramId === "string" ? event.payload.diagramId : null;
      if (!changedId) return;
      if (changedId === openIdRef.current) setDiagramNonce((value) => value + 1);
    }, controller.signal);
    return () => controller.abort();
  }, [repositoryId, refreshGallery]);

  /* ---------- 项目目录（栏宽与教学页共用同一条拖拽） ---------- */
  useEffect(() => {
    if (!visible || railTab !== "tree" || index) return;
    let current = true;
    setIndexError("");
    api.getIndex(repositoryId)
      .then((next) => { if (current) setIndex(next); })
      .catch((reason: unknown) => { if (current) setIndexError(reason instanceof Error ? reason.message : "文件索引没读到"); });
    return () => { current = false; };
  }, [repositoryId, visible, railTab, index]);

  /* ---------- 几何落盘：去抖 + 在途合并，乐观更新本地那份 ---------- */
  const pendingPositions = useRef(new Map<string, DiagramPosition>());
  /** 这批位置属于哪张图：切图前先把上一张欠的那趟写给原图，不能顺着新的 openId 落错地方。 */
  const queueOwner = useRef<string | null>(null);
  const geometryTimer = useRef(0);
  const geometryInFlight = useRef(false);
  const diagramIdForGeometry = useRef<string | null>(openId);
  diagramIdForGeometry.current = openId;

  /** 用 ref 拆开去抖计时器与发送函数的互相引用。 */
  const sendNow = useRef<() => void>(() => undefined);
  const scheduleGeometry = useCallback((): void => {
    window.clearTimeout(geometryTimer.current);
    geometryTimer.current = window.setTimeout(() => sendNow.current(), GEOMETRY_DEBOUNCE_MS);
  }, []);

  const sendGeometry = useCallback(async (): Promise<void> => {
    const diagramId = queueOwner.current;
    const entries = [...pendingPositions.current.values()];
    if (!diagramId || !entries.length || geometryInFlight.current) return;
    pendingPositions.current.clear();
    queueOwner.current = null;
    geometryInFlight.current = true;
    setSaveState("saving");
    setSaveError("");
    try {
      const { diagram: written } = await api.saveDiagramGeometry(repositoryId, diagramId, entries);
      // 保存读数只说真发生过的写入：位置用本地那份（已是拖完的），名字/来源/时间取引擎回读
      setDiagram((current) => (current && current.id === written.id ? { ...current, name: written.name, source: written.source, updatedAt: written.updatedAt } : current));
      setDiagrams((current) => current.map((item) => (item.id === written.id ? { ...item, name: written.name, updatedAt: written.updatedAt } : item)));
      setSaveState("saved");
    } catch (reason: unknown) {
      setSaveState("failed");
      setSaveError(reason instanceof Error ? reason.message : "位置写入失败");
    } finally {
      geometryInFlight.current = false;
      if (pendingPositions.current.size) scheduleGeometry();
    }
  }, [repositoryId, scheduleGeometry]);
  sendNow.current = (): void => { void sendGeometry(); };

  /** 切图或删图前把上一张欠的位置送出去，不让拖动静默丢掉。 */
  const flushQueuedGeometry = useCallback((): void => {
    window.clearTimeout(geometryTimer.current);
    sendNow.current();
  }, []);

  /** 拖动结束：位置先落到本地那份，再排队一次 PUT；不重取整张图，也不产生版本。 */
  const handleNodeMove = useCallback((commit: DragCommit): void => {
    const diagramId = diagramIdForGeometry.current;
    if (!diagramId) return;
    if (queueOwner.current && queueOwner.current !== diagramId) flushQueuedGeometry();
    setDiagram((current) => (current ? { ...current, body: commit.body } : current));
    for (const position of commit.positions) pendingPositions.current.set(position.id, position);
    queueOwner.current = diagramId;
    setSaveState("queued");
    scheduleGeometry();
  }, [scheduleGeometry, flushQueuedGeometry]);

  useEffect(() => () => { window.clearTimeout(geometryTimer.current); }, []);

  /* ---------- 引用核对（引擎没给 warnings 时，按课程树自己核一遍：只比 id，不猜） ---------- */
  const nodesById = useMemo(() => {
    const map = new Map<string, CourseNode>();
    if (t.course) for (const node of flatten(t.course.root)) map.set(node.id, node);
    return map;
  }, [t.course]);

  const localStale = useMemo<DiagramWarning[]>(() => {
    if (!diagram || !t.course) return [];
    const out: DiagramWarning[] = [];
    for (const node of diagram.body.nodes) {
      if (node.kind !== "module" || !node.ref || isBlockRef(node.ref)) continue;
      if (!nodesById.has(node.ref)) out.push({ node: node.id, reason: `引用 ${node.ref} 已经不在现在的课程树里（改名、删模块或重分析过）` });
    }
    return out;
  }, [diagram, t.course, nodesById]);

  const warnings = serverWarnings.length ? serverWarnings : localStale;
  const staleReasonFor = useCallback((id: string): string | undefined => warnings.find((item) => item.node === id)?.reason, [warnings]);

  /* ---------- 抽屉的三份读数：说明落点、关联文件、出边 ---------- */
  const resolutionOf = useCallback((node: DiagramNode): NodeResolution => {
    const stale = staleReasonFor(node.id);
    if (stale) return { state: "stale", reason: stale };
    if (node.kind === "module") {
      if (!t.course) return { state: "pending" };
      if (!node.ref) return { state: "unknown" };
      if (isBlockRef(node.ref)) return { state: "block" };
      const courseNode = nodesById.get(node.ref);
      return courseNode ? { state: "ok", node: courseNode } : { state: "unknown" };
    }
    return { state: "unknown" };
  }, [staleReasonFor, t.course, nodesById]);

  /** 关联文件 = 课程树里那个节点（含子孙）的锚点，按 path 去重、保留最先出现的行号。 */
  const filesOf = useCallback((node: DiagramNode): DrawerFile[] => {
    if (node.kind !== "module") return [];
    const courseNode = node.ref ? nodesById.get(node.ref) : undefined;
    if (!courseNode) return [];
    const rows = new Map<string, DrawerFile>();
    for (const item of flatten(courseNode)) for (const anchor of item.anchors) {
      if (rows.has(anchor.path)) continue;
      rows.set(anchor.path, { path: anchor.path, line: anchor.line, ...(anchor.label ? { label: anchor.label } : {}) });
    }
    return [...rows.values()];
  }, [nodesById]);

  const outgoingOf = useCallback((node: DiagramNode): DrawerEdge[] => {
    if (!diagram) return [];
    const labelOf = new Map(diagram.body.nodes.map((item) => [item.id, item.label]));
    return diagram.body.edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => ({ edge, toLabel: labelOf.get(edge.to) ?? edge.to }));
  }, [diagram]);

  const openDiagram = useCallback((id: string): void => {
    setSelected(null);
    setOpenId(id);
  }, []);

  const createDiagram = useCallback((): void => {
    void (async () => {
      try {
        const { diagram: created } = await api.createDiagram(repositoryId);
        setDiagrams((current) => [createdSummary(created), ...current]);
        versionsWantedFor.current = null;
        setSelected(null);
        setOpenId(created.id);
        setRailTab("gallery");
        showToast(`已建空白图「${created.name}」`);
      } catch (reason: unknown) {
        toastFailure("新建没成功", reason);
      }
    })();
  }, [repositoryId]);

  const renameDiagram = useCallback((id: string, name: string): void => {
    void (async () => {
      try {
        const { diagram: renamed } = await api.renameDiagram(repositoryId, id, name);
        setDiagrams((current) => current.map((item) => (item.id === id ? { ...item, name: renamed.name, updatedAt: renamed.updatedAt } : item)));
        if (id === diagramIdForGeometry.current) setDiagram((current) => (current ? { ...current, name: renamed.name, updatedAt: renamed.updatedAt } : current));
      } catch (reason: unknown) {
        toastFailure("改名没落盘", reason);
        refreshGallery();
      }
    })();
  }, [repositoryId, refreshGallery]);

  const removeDiagram = useCallback((item: DiagramSummary): void => {
    if (!window.confirm(`删除「${item.name}」？版本历史一起删掉，不可恢复。`)) return;
    void (async () => {
      try {
        await api.deleteDiagram(repositoryId, item.id);
        setDiagrams((current) => current.filter((entry) => entry.id !== item.id));
        if (item.id === openIdRef.current) { setOpenId(null); setSelected(null); }
        showToast(`已删除「${item.name}」`);
      } catch (reason: unknown) {
        toastFailure("删除没成功", reason);
        refreshGallery();
      }
    })();
  }, [repositoryId, refreshGallery]);

  /** 图库里点「版本历史」：没打开的图先取，取完再让画布弹菜单。 */
  const openVersions = useCallback((item: DiagramSummary): void => {
    if (item.id === openIdRef.current) { setVersionsSignal((value) => value + 1); return; }
    versionsWantedFor.current = item.id;
    setOpenId(item.id);
  }, []);

  const restoreVersion = useCallback((index: number): void => {
    const diagramId = diagramIdForGeometry.current;
    if (!diagramId) return;
    void (async () => {
      try {
        const { diagram: restored } = await api.restoreDiagram(repositoryId, diagramId, index);
        applyDiagram(restored);
        setSelected(null);
        pendingPositions.current.clear();
        setSaveState("synced");
        setFitNonce((value) => value + 1);
        refreshGallery();
        showToast("已恢复到那一版");
      } catch (reason: unknown) {
        toastFailure("恢复没成功", reason);
      }
    })();
  }, [repositoryId, applyDiagram, refreshGallery]);

  const openFile = useCallback((path: string): void => {
    t.setMapFile(path);
    t.setMapBinding({ kind: "file", path });
    showToast(`已选中 · ${path}`);
    emit(repositoryId, "file_anchored", { path, source: "anchor" });
  }, [repositoryId, t]);

  /** 绑定这一格给对话：核得上课程树节点就带上它的文件清单，核不上就解绑退回全局视野。 */
  const bindNode = useCallback((node: DiagramNode): void => {
    const resolution = resolutionOf(node);
    if (resolution.state === "ok") {
      const files = filesOf(node);
      t.setMapNode(resolution.node, files.map((file) => file.path), null);
      t.setMapBinding({ kind: "module", title: node.label });
      showToast(`对话已绑到「${node.label}」`);
      return;
    }
    t.setMapNode(null);
    t.setMapBinding({ kind: "module", title: node.label });
    showToast(node.kind === "note" ? `对话已绑到便签「${node.label}」` : "引用没核到课程树");
  }, [resolutionOf, filesOf, t]);

  const gotoTeach = useCallback((node: DiagramNode): void => {
    const courseNode = node.ref ? nodesById.get(node.ref) : undefined;
    if (courseNode) t.setSelected(courseNode);
    navigate("/app?workspace=teaching");
  }, [nodesById, navigate, t]);

  const selectNode = useCallback((node: DiagramNode | null): void => {
    setSelected(node);
    if (node) emit(repositoryId, "flow_node_selected", { node_id: node.id, title: node.label.slice(0, 120), view: "canvas" });
  }, [repositoryId]);

  /** App 接了对话栏就用它，没接就填进本地输入框；两条路都不发请求，发送归用户。 */
  const quickPrompt = useCallback((text: string): void => {
    const handler = onQuickPromptRef.current;
    if (handler) { handler(text); return; }
    t.setContent(text);
    showToast("已填进对话栏");
  }, [t]);

  const drawer = selected && diagram ? (
    <NodeDrawer
      node={selected}
      outgoing={outgoingOf(selected)}
      files={filesOf(selected)}
      resolution={resolutionOf(selected)}
      onClose={() => setSelected(null)}
      onOpenFile={openFile}
      onGotoTeach={() => gotoTeach(selected)}
      onBind={() => bindNode(selected)}
    />
  ) : null;

  const repositoryName = (index?.repositoryPath ?? workspace.repositoryPath).split("/").filter(Boolean).pop() ?? repositoryId;
  const lineOf = useMemo(() => {
    const map = new Map<string, number>();
    index?.files.forEach((file) => map.set(file.path, file.lines));
    return map;
  }, [index]);

  const topbar = <PageTopbar crumb={<><b>{repositoryName}</b><span className="faint">/</span><span>宏观设计</span></>} showRailToggle />;

  return (
    <>
      {topbar}
      <MobileSwitcher labels={["图库 / 目录", "画布"]} active={paneActive} onSelect={setPaneActive} />
      <div className="page page-map">
        <ColumnResizer field="filePaneWidth" label="列表栏" growOn="right" />
        <aside className={`map-rail ${paneClass(0)}`}>
          <div className="rail-tabs" role="tablist" aria-label="左栏">
            <button type="button" role="tab" aria-selected={railTab === "gallery"} className={`rail-tab ${railTab === "gallery" ? "active" : ""}`} onClick={() => setRailTab("gallery")}>图库</button>
            <button type="button" role="tab" aria-selected={railTab === "tree"} className={`rail-tab ${railTab === "tree" ? "active" : ""}`} onClick={() => setRailTab("tree")}>项目目录</button>
          </div>
          {railTab === "gallery" ? (
            <GalleryPane
              diagrams={diagrams}
              openId={openId}
              loading={listLoading}
              error={listError}
              query={query}
              onQueryChange={setQuery}
              onOpen={openDiagram}
              onCreate={createDiagram}
              onRename={renameDiagram}
              onVersions={openVersions}
              onDelete={removeDiagram}
            />
          ) : (
            <div className="map-side-tree">
              {indexError ? <p className="gallery-error">{indexError}</p> : null}
              {index ? (
                <RepoTree
                  nodes={index.fileTree}
                  onOpenFile={openFile}
                  activePath={t.mapFile}
                  lineOf={lineOf}
                  badge={(node, depth) => (depth === 0 ? groupLabel(node.name) : undefined)}
                />
              ) : <Loading />}
            </div>
          )}
        </aside>

        <DiagramCanvas
          diagram={diagram}
          warnings={warnings}
          saveState={saveState}
          saveError={saveError}
          loading={listLoading}
          error={listError || diagramError}
          fitNonce={fitNonce}
          versionsSignal={versionsSignal}
          onQuickPrompt={quickPrompt}
          onRename={(name) => { if (diagram) renameDiagram(diagram.id, name); }}
          onRestore={restoreVersion}
          onNodeMove={handleNodeMove}
          onSelect={selectNode}
          drawer={drawer}
        />
      </div>
    </>
  );
}

/** 新建后先在本地插一条摘要，数字全部来自引擎刚返回的那张图。 */
function createdSummary(diagram: Diagram): DiagramSummary {
  return {
    id: diagram.id,
    name: diagram.name,
    source: diagram.source,
    updatedAt: diagram.updatedAt,
    nodes: diagram.body.nodes.length,
    edges: diagram.body.edges.length,
    versions: diagram.versions.length
  };
}

/** 顶层目录的语义标注：说明这批文件是干什么的，不是文件数。 */
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
