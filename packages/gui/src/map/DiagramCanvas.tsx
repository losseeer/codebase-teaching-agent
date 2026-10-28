import { DiagramBody, DiagramNode } from "@codebase-tutor/domain";
import type { Diagram } from "@codebase-tutor/domain";

import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
import type { DiagramPosition, DiagramWarning, SaveState } from "../api/client";
import { Icon } from "../ui/icons";
import { InlineName, PopMenu, type MenuItem } from "../ui/PopMenu";
import {
  DEFAULT_VIEW, EDGE_ORIGINS, ORIGIN_SHORT, ZOOM_MAX, ZOOM_MIN,
  edgePoints, fitView, groupRects, notePreview, relativeTime, safeFileName, subLineOf, versionTime, worldSizeOf, zoomAt,
  type NodeBoxes, type Size, type View
} from "./diagramView";

/**
  agent 画图工作区的画布那一列。三件事决定它的形状：
  - 结构不在这里改：界面上没有「加节点 / 删连线」那颗按钮，结构改动只有对话里 agent 的 `set_diagram` 单写入口，
    画布只接受两件事——拖动位置、改名；所以这一列一次付费请求都不发（图库、图本体、几何写入、恢复版本全是本地读写，摸不到模型）。
  - 视野是状态，不是每次渲染重算的：只在「打开另一张图 / 内容变空 / 点 ⤢ / 恢复某个版本」这几种情况下 fit，其余时刻不动。
    工作区常驻挂载、藏着时宽度为 0，所以视野按图 id 存一份 `viewCache`：切回来还是用户离开时那格。
  - 边的端点靠量出来的盒子：节点定宽 132，高度随标签换行、角色小字、便签正文变；
    盒子由 `ResizeObserver`（图元挂上时补量一次）提供，是边与包围盒的锚点来源，箭头永远指着节点正中。
*/

interface DragState {
  kind: "pan" | "node";
  pointerId: number;
  sx: number;
  sy: number;
  /** pan：起手时的视野；node：起手时节点的坐标。 */
  ox: number;
  oy: number;
  moved: boolean;
  id?: string;
  /** 拖动中的落点（世界坐标），只有 node 且有位移时才有。 */
  dx?: number;
  dy?: number;
}

/** 一次拖完的交付：位置交给外层落盘，整份 body 交回给状态（省一次重取，也免得结构被过期副本盖掉）。 */
export interface DragCommit {
  positions: DiagramPosition[];
  body: DiagramBody;
}

const QUICK_PROMPTS = ["画一张架构分层图", "画登录流程", "把模块依赖画出来"] as const;

export function DiagramCanvas({ diagram, warnings, saveState, saveError, loading, error, fitNonce, versionsSignal, onQuickPrompt, onRename, onRestore, onNodeMove, onSelect, drawer }: {
  diagram: Diagram | null;
  warnings: DiagramWarning[];
  saveState: SaveState;
  saveError: string;
  loading: boolean;
  error: string;
  /** 变化一次就重新适应内容（恢复版本之后要用它：那张图的 id 没变，走不到「换图就 fit」那条路）。 */
  fitNonce: number;
  /** 变化一次就把版本菜单弹开（图库里点另一张图的「版本历史」：先取图、取完再弹，菜单才不会是上一张的）。 */
  versionsSignal: number;
  onQuickPrompt?: (text: string) => void;
  onRename: (name: string) => void;
  onRestore: (index: number) => void;
  onNodeMove: (commit: DragCommit) => void;
  onSelect: (node: DiagramNode | null) => void;
  drawer: ReactNode;
}): ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null);
  const versionsAnchor = useRef<HTMLButtonElement>(null);
  const exportAnchor = useRef<HTMLButtonElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [versionsShown, setVersionsShown] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const diagramId = diagram?.id ?? null;
  const body = diagram?.body ?? null;
  const bodyRef = useRef<DiagramBody | null>(body);
  bodyRef.current = body;
  /** 空图（一个节点都没有）：视野就是默认值，没什么可 fit 的。 */
  const blank = !body || !body.nodes.length;

  const viewCache = useRef(new Map<string, View>()).current;
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const viewRef = useRef<View>(view);
  const applyView = useCallback((next: View): void => {
    viewRef.current = next;
    setView(next);
    if (diagramId) viewCache.set(diagramId, next);
  }, [diagramId, viewCache]);

  const boxesRef = useRef<NodeBoxes>(new Map());
  const [measured, setMeasured] = useState<NodeBoxes>(boxesRef.current);
  /** 这张图里还没量到盒子的那些 id：欠着的时候不能宣布 fit 完成，否则 fit 之后来一次 resize，视野自己跳。 */
  const pendingBoxes = useRef<Set<string>>(new Set());

  const measureNow = useCallback((element: HTMLElement): void => {
    const id = element.dataset.nodeId;
    if (!id) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    if (!width || !height) return;
    const previous = boxesRef.current.get(id);
    if (previous && previous.w === width && previous.h === height) return;
    boxesRef.current = new Map(boxesRef.current).set(id, { w: width, h: height });
    pendingBoxes.current.delete(id);
    setMeasured(boxesRef.current);
  }, []);

  const observer = useMemo(() => (typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    for (const entry of entries) measureNow(entry.target as HTMLElement);
  })), [measureNow]);

  // 组件都卸载了，就不该再有测量回调打进来：观察者在离场时一律断开。
  useEffect(() => () => { observer?.disconnect(); }, [observer]);

  /** 在 transform 的 scale 里面，offsetWidth 量的仍是世界坐标那份未缩放尺寸——正是边与包围盒要的那份。 */
  const attachNode = useCallback((element: HTMLDivElement | null): void => {
    if (!element) return;
    measureNow(element);
    observer?.observe(element);
  }, [measureNow, observer]);

  /* ---------- fit：一次请求，多处落地（上屏、resize、量完盒子都可能是它落地的那一刻） ---------- */
  const pendingFit = useRef(false);
  const runFit = useCallback((): void => {
    if (!pendingFit.current) return;
    const element = viewportRef.current;
    const current = bodyRef.current;
    if (!element || !current || !current.nodes.length) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (!width || !height) return; // 工作区正藏着（宽度 0）：等 ResizeObserver 那一趟再来
    if (current.nodes.some((node) => pendingBoxes.current.has(node.id))) return; // 还有节点没量到
    const next = fitView(current, boxesRef.current, { w: width, h: height });
    pendingFit.current = false;
    viewRef.current = next;
    setView(next);
    if (diagramId) viewCache.set(diagramId, next);
  }, [diagramId, viewCache]);

  const requestFit = useCallback((): void => {
    pendingFit.current = true;
    window.requestAnimationFrame(runFit);
  }, [runFit]);

  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string[]>([]);

  const staleReasons = useMemo(() => {
    const map = new Map<string, string>();
    for (const warning of warnings) map.set(warning.node, warning.reason);
    return map;
  }, [warnings]);

  /** 换图 / 图变空：视野回缓存或默认值，并补一次 fit。同一张图的重渲染不走这条路。 */
  useEffect(() => {
    setSelectedId(null);
    onSelect(null);
    setRenaming(false);
    drag.current = null;
    setDragging(null);
    boxesRef.current = new Map();
    setMeasured(boxesRef.current);
    pendingBoxes.current = new Set((bodyRef.current?.nodes ?? []).map((node) => node.id));
    const cached = diagramId ? viewCache.get(diagramId) : undefined;
    if (cached) {
      pendingFit.current = false;
      viewRef.current = cached;
      setView(cached);
    } else {
      viewRef.current = DEFAULT_VIEW;
      setView(DEFAULT_VIEW);
      pendingFit.current = true;
      window.requestAnimationFrame(runFit);
    }
    // 输入是 diagramId / blank 这两个真信号；bodyRef 与那几个回调每次渲染都换引用，列进依赖会变成自指循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramId, blank]);

  /** 视口从 0 变到有宽度（工作区刚显示）、或尺寸被抽屉挤过：欠着的那次 fit 在这里落地。 */
  const visibleSize = useRef<Size>({ w: 0, h: 0 });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const report = (): void => {
      const next = { w: element.clientWidth, h: element.clientHeight };
      const before = visibleSize.current;
      visibleSize.current = next;
      if (!pendingFit.current) return;
      if (before.w === 0 && next.w === 0) return;
      runFit();
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [runFit]);

  /** 盒子量到了就补一次 fit（首帧量不到，fit 才有这一趟收尾）。 */
  useLayoutEffect(() => { runFit(); }, [measured, runFit]);

  /* ---------- agent 动过结构：新出现的节点闪一下 ---------- */
  const structure = diagram ? `${diagram.body.nodes.length}/${diagram.body.edges.length}/${diagram.body.groups.length}` : "";
  const previousStructure = useRef<{ key: string; ids: string[] } | null>(null);
  useEffect(() => {
    if (!diagram) { previousStructure.current = null; return; }
    const ids = diagram.body.nodes.map((node) => node.id);
    const previous = previousStructure.current;
    previousStructure.current = { key: structure, ids };
    if (!previous || previous.key === structure) return;
    const known = new Set(previous.ids);
    const arrived = ids.filter((id) => !known.has(id));
    if (!arrived.length) return;
    setFlash(arrived);
    const timer = window.setTimeout(() => setFlash([]), 2400);
    return () => window.clearTimeout(timer);
    // structure 是 node/edge/group 三个计数拼出来的，它就是这件事的输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram?.id, structure]);

  /** 恢复版本之后外层会 bump 一次：那张图的 id 没变，走不到「换图就 fit」那条路，视野得自己跟上。 */
  const seenFitNonce = useRef(0);
  useEffect(() => {
    if (fitNonce === seenFitNonce.current) return;
    seenFitNonce.current = fitNonce;
    if (fitNonce > 0) requestFit();
  }, [fitNonce, requestFit]);

  /** 图库里点另一张图的「版本历史」：外层先把那张图取回来，再 bump 这一格，菜单弹的才是这张图的版本。 */
  const seenVersionsSignal = useRef(0);
  useEffect(() => {
    if (versionsSignal === seenVersionsSignal.current) return;
    seenVersionsSignal.current = versionsSignal;
    if (versionsSignal > 0) setVersionsShown(true);
  }, [versionsSignal]);

  const zoomBy = (factor: number): void => applyView(zoomAt(viewRef.current, centerAnchor(viewportRef.current), factor));

  /** 滚轮必须走原生监听：React 的 onWheel 是 passive 注册的，preventDefault 拦不住页面滚动。 */
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      applyView(zoomAt(viewRef.current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.pow(1.0015, -event.deltaY)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [applyView]);

  /* ---------- 平移与拖动（几何自由） ---------- */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const nodeElement = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const base = { pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, moved: false };
    const node = nodeElement?.dataset.nodeId ? bodyRef.current?.nodes.find((item) => item.id === nodeElement.dataset.nodeId) : undefined;
    if (node) {
      drag.current = { ...base, kind: "node", ox: node.x, oy: node.y, id: node.id };
    } else {
      drag.current = { ...base, kind: "pan", ox: viewRef.current.x, oy: viewRef.current.y };
    }
    setDragging(drag.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    let active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.sx;
    const dy = event.clientY - active.sy;
    if (!active.moved && Math.abs(dx) + Math.abs(dy) > 3) active = { ...active, moved: true };
    if (active.kind === "pan") {
      const next = { ...viewRef.current, x: active.ox + dx, y: active.oy + dy };
      drag.current = active;
      applyView(next);
      setDragging(active);
      return;
    }
    const z = viewRef.current.z || 1;
    const moved: DragState = { ...active, dx: Math.max(0, active.ox + dx / z), dy: Math.max(0, active.oy + dy / z) };
    drag.current = moved;
    setDragging(moved);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    drag.current = null;
    setDragging(null);
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.kind === "node" && active.id) {
      if (!active.moved || active.dx === undefined || active.dy === undefined) {
        const node = bodyRef.current?.nodes.find((item) => item.id === active.id);
        if (node) {
          setSelectedId(node.id);
          onSelect(node);
        }
        return;
      }
      const current = bodyRef.current;
      if (!current) return;
      const position = { id: active.id, x: Math.round(active.dx), y: Math.round(active.dy) };
      onNodeMove({
        positions: [position],
        body: { ...current, nodes: current.nodes.map((node) => (node.id === position.id ? { ...node, x: position.x, y: position.y } : node)) }
      });
      return;
    }
    if (!active.moved && active.kind === "pan") {
      setSelectedId(null);
      onSelect(null);
    }
  };

  /* ---------- 导出：只有 JSON ---------- */
  const exportJson = (): void => {
    if (!diagram) return;
    const blob = new Blob([JSON.stringify(diagram.body, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(diagram.name)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const versionItems: MenuItem[] = (diagram?.versions ?? []).map((version, index) => ({
    label: <><b className="mono">{versionTime(version.at)}</b>{` · ${version.note}`}</>,
    title: `恢复到 ${versionTime(version.at)} 这一版（恢复本身也存一版，历史不截断）`,
    onSelect: () => onRestore(index)
  }));

  if (!diagram) {
    return (
      <div className="map-main">
        <div className="dg-toolbar">
          <span className="dg-name static">{loading ? "图库读取中…" : "未打开图"}</span>
          {error ? <span className="badge badge-danger" title={error}>图库没读到</span> : null}
        </div>
        <div className="dg-viewport" role="presentation">
          <EmptyCanvas onQuickPrompt={onQuickPrompt} disabled={loading} />
        </div>
      </div>
    );
  }

  const renderedBody = withDragOffsets(body, dragging);
  const world = renderedBody ? worldSizeOf(renderedBody, measured) : { w: 2400, h: 1600 };

  return (
    <div className="map-main">
      <div className="dg-toolbar">
        {renaming ? (
          <InlineName value={diagram.name} ariaLabel="重命名这张图" onCommit={onRename} onClose={() => setRenaming(false)} />
        ) : (
          <button type="button" className="dg-name" title="点击重命名" onClick={() => setRenaming(true)}>{diagram.name}</button>
        )}
        <span
          className={`badge ${diagram.source === "agent" ? "badge-info" : "badge-neutral"}`}
          title={warnings.length ? `${warnings.length} 个节点的引用已失效` : undefined}
        >{`${diagram.source === "agent" ? "agent 生成" : "我创建"} · ${relativeTime(diagram.updatedAt)}`}</span>
        <SavePill state={saveState} error={saveError} />
        <span className="spacer" />
        <button
          ref={versionsAnchor}
          type="button"
          className="btn btn-ghost btn-sm"
          title="每次结构改动存一版"
          aria-haspopup="menu"
          aria-expanded={versionsShown}
          onClick={() => setVersionsShown((value) => !value)}
        ><Icon name="rotate" size={13} />{`版本历史${diagram.versions.length ? `（${diagram.versions.length}）` : ""}`}</button>
        <div className="dg-zoom" role="group" aria-label="画布缩放">
          <button type="button" className="icon-btn" title="缩小" aria-label="缩小" onClick={() => zoomBy(1 / 1.2)}>－</button>
          <span className="z-val" title={`缩放范围 ${Math.round(ZOOM_MIN * 100)}% 到 ${Math.round(ZOOM_MAX * 100)}%；滚轮以光标为锚`}>{`${Math.round(view.z * 100)}%`}</span>
          <button type="button" className="icon-btn" title="放大" aria-label="放大" onClick={() => zoomBy(1.2)}>＋</button>
          <button type="button" className="icon-btn" title="适应内容" aria-label="适应内容" onClick={requestFit}>⤢</button>
        </div>
        <button
          ref={exportAnchor}
          type="button"
          className="btn btn-ghost btn-sm"
          title="导出这张图的图元数据"
          aria-haspopup="menu"
          aria-expanded={exportOpen}
          onClick={() => setExportOpen((value) => !value)}
        >导出 ▾</button>
        {exportOpen ? <PopMenu anchor={exportAnchor.current} items={exportItems(exportJson)} onClose={() => setExportOpen(false)} ariaLabel="导出格式" /> : null}
        {versionsShown ? <PopMenu anchor={versionsAnchor.current} items={versionItems.length ? versionItems : [noVersionsItem]} onClose={() => setVersionsShown(false)} ariaLabel="版本历史" /> : null}
      </div>

      <div className="map-stage">
        <div
          ref={viewportRef}
          className={`dg-viewport${dragging ? (dragging.kind === "pan" ? " panning" : " node-dragging") : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="dg-world" style={{ width: world.w, height: world.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            <svg className="dg-edges" width={world.w} height={world.h} viewBox={`0 0 ${world.w} ${world.h}`} aria-hidden="true">
              <defs>
                {EDGE_ORIGINS.map((origin) => (
                  <marker key={origin} id={`dg-arrow-${origin}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path className={`edge-${origin}`} d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                ))}
              </defs>
              {renderedBody?.edges.map((edge) => {
                const points = edgePoints(renderedBody, edge, measured);
                if (!points) return null;
                return (
                  <g key={edge.id}>
                    <title>{`${ORIGIN_SHORT[edge.origin]}${edge.downgraded ? " · 依据偏弱" : ""}`}</title>
                    <path className={`dg-edge edge-${edge.origin}`} d={points.map((point, at) => `${at === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")} markerEnd={`url(#dg-arrow-${edge.origin})`} />
                  </g>
                );
              })}
            </svg>

            {renderedBody ? groupRects(renderedBody, measured).map((group) => (
              <div key={group.id} className="dg-group" style={{ left: group.x, top: group.y, width: group.w, height: group.h }} title={`分组框「${group.label}」：框住的是节点，不是关系`}>
                <span className="dg-group-label">{group.label}</span>
              </div>
            )) : null}

            {renderedBody?.nodes.map((node) => {
              const stale = staleReasons.get(node.id);
              const classes = ["dg-node", node.kind];
              if (selectedId === node.id) classes.push("selected");
              if (flash.includes(node.id)) classes.push("flash");
              if (stale) classes.push("stale");
              const sub = subLineOf(node);
              return (
                <div
                  key={node.id}
                  ref={attachNode}
                  data-node-id={node.id}
                  className={classes.join(" ")}
                  style={{ left: node.x, top: node.y }}
                  title={stale ?? `${node.label}${sub ? ` · ${sub}` : ""}｜点一下看说明与关联文件`}
                >
                  <div className="dg-label">{node.label}</div>
                  {sub ? <div className="dg-sub">{sub}</div> : null}
                  {node.kind === "note" && node.text ? <div className="dg-note-text">{notePreview(node.text)}</div> : null}
                  {stale ? <div className="dg-stale-mark">引用失效</div> : null}
                </div>
              );
            })}
          </div>

          <div className="dg-overlay">
            {warnings.length ? (
              <p className="dg-warn" title={warnings.map((warning) => `${diagram.body.nodes.find((node) => node.id === warning.node)?.label ?? warning.node}：${warning.reason}`).join("\n")}>
                <Icon name="alert" size={12} />
                <span>{`${warnings.length} 个节点的引用查不到了`}</span>
                <span className="faint">标灰的节点可在对话里让它改指</span>
              </p>
            ) : null}
            <div className="dg-legend" title="边色表示这条关系的依据强弱">
              {EDGE_ORIGINS.map((origin) => (
                <span key={origin}><i className={`dot dot-${origin}`} aria-hidden />{ORIGIN_SHORT[origin]}</span>
              ))}
            </div>
          </div>
        </div>
        {drawer}
      </div>
    </div>
  );
}

const noVersionsItem: MenuItem = { label: "还没有版本", title: "这张图还没有结构改动", disabled: true, onSelect: () => undefined };

const exportItems = (onExport: () => void): MenuItem[] => [
  { label: "JSON（图元数据）", title: "导出 body：节点、边、分组框与坐标。画布上的位置就是这里的一份。", onSelect: onExport }
];

/** ＋/－ 那颗按钮的锚点：画布正中（滚轮那条路用的是光标位置）。 */
function centerAnchor(element: HTMLDivElement | null): { x: number; y: number } {
  if (!element) return { x: 0, y: 0 };
  return { x: element.clientWidth / 2, y: element.clientHeight / 2 };
}

/** 拖动中的那点位移只活在画布本地：边跟着走，松手才交给外层落盘（省下每帧一次父子通信）。 */
function withDragOffsets(body: DiagramBody | null, dragging: DragState | null): DiagramBody | null {
  if (!body) return null;
  if (!dragging || dragging.kind !== "node" || !dragging.id || dragging.dx === undefined || dragging.dy === undefined) return body;
  const { id, dx, dy } = dragging;
  return { ...body, nodes: body.nodes.map((node) => (node.id === id ? { ...node, x: dx, y: dy } : node)) };
}

/** 保存状态那一格：`synced` 与 `saved` 都表示「画布 = 盘上那份」，所以共用一个 ✓（完整口径与 failed 必须显形见 api/client.ts 的 `SaveState`）。 */
const SAVE_LABEL: Record<SaveState, string> = {
  synced: "✓ 已保存",
  queued: "位置待存",
  saving: "保存中…",
  saved: "✓ 已保存",
  failed: "保存失败"
};

const SAVE_NOTE: Record<SaveState, string> = {
  synced: "位置已保存，不影响图的版本",
  queued: "稍后自动保存位置",
  saving: "正在保存位置",
  saved: "位置已保存",
  failed: "位置没保存上"
};

function SavePill({ state, error }: { state: SaveState; error: string }): ReactElement {
  const busy = state === "saving" || state === "queued";
  return (
    <span
      className={`dg-save${busy ? " busy" : ""}${state === "failed" ? " failed" : ""}`}
      title={state === "failed" && error ? `${SAVE_NOTE.failed}：${error}` : SAVE_NOTE[state]}
      role="status"
    >{SAVE_LABEL[state]}</span>
  );
}

/** 空画布的冷启动：说清这是谁在画、你能做什么；三颗快捷指令只是把话递进对话栏，发送那一下归用户。 */
function EmptyCanvas({ onQuickPrompt, disabled }: { onQuickPrompt?: (text: string) => void; disabled: boolean }): ReactElement {
  return (
    <div className="dg-empty">
      <h2>一张空画布</h2>
      <p>
        <span>描述你想要的图，由 agent 来画。</span>
      </p>
      <div className="dg-quick">
        {QUICK_PROMPTS.map((text) => (
          <button
            key={text}
            type="button"
            className="chip-quick"
            disabled={disabled || !onQuickPrompt}
            title={onQuickPrompt ? "填入对话栏，发送后生效" : "对话栏暂不可用"}
            onClick={() => onQuickPrompt?.(text)}
          >{text}</button>
        ))}
      </div>
    </div>
  );
}
