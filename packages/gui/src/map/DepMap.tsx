import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { CAPABILITY_CELL_LABEL, CAPABILITY_LEVEL_LABEL, type CapabilityLevel, type CourseNode, type FileEntry, type RepositoryAnalysis, type RepositoryIndex, type RepositoryLanguageRow } from "@codebase-tutor/shared";
import { Icon } from "../ui/icons";

/**
 * 宏观设计 v0.6：架构视图 = 模块依赖图（与 `FlowMap` 的流程视图并列）。
 *
 * 为什么改：旧地图把课程树（一棵层级树）画成图——层级用列表呈现更高效，
 * 图的存在价值在「边」承载列表给不了的关系信息。本组件画真正的依赖关系：
 * - 节点 = 目录前缀聚合的模块（聚合深度自适应：从浅往深钻到「最大分组占比」达标为止，见 chooseAggregation；
 *   超过 MAX_GROUPS 按行数并入「其他」）
 * - 边 = 跨模块 import 引用（analysis.graph.imports 文件级聚合为模块级，粗细 = 引用次数）
 * - 布局 = 按依赖深度分层，入口模块（含 entrypoint 的模块）在最左列；
 *   节点/连线用 prototype 的 `.arch-node` / `.arch-svg`（贝塞尔曲线 + 箭头）
 * - 点击模块 → 合成 CourseNode（anchors = 模块内最大的文件），走既有的节点详情抽屉与地图线程
 *
 * 课程树本身不变：engine 侧 workflows/modules/micro 仍驱动教学、练习与推荐入口，
 * 只是地图画布不再渲染它。
 */

const NODE_W = 168;
const NODE_MIN_H = 76;
const ROW_STRIDE = 112;
const COL_GAP = 52;
const PAD_X = 36;
const PAD_Y = 44;
const MIN_W = 710;
const MIN_H = 420;
const MAX_GROUPS = 20;
/** 结构塌陷判据：最大分组的文件占比。一个方块吞下过半仓库，说明这层深度太粗、边都成了自环。 */
const MAX_LARGEST_SHARE = 0.5;
/** 聚合下钻的最大目录层数：Maven 布局（src/main/java/com/x）要到第 6 层才露出模块边界。 */
const MAX_AGGREGATION_DEPTH = 8;
/** Git 变更次数达到该值的模块标记为热点。 */
const HOTSPOT_CHANGES = 5;

interface ModuleNode {
  key: string;
  files: FileEntry[];
  lines: number;
  isEntry: boolean;
  changes: number;
  inDegree: number;
  outDegree: number;
}

interface ModuleEdge {
  from: string;
  to: string;
  weight: number;
}

/** 手动拖过的节点坐标（按模块 key 存），空对象 = 全走自动分层布局。 */
type ManualPositions = Record<string, { x: number; y: number}>;
const manualKey = (repositoryId: string): string => `codebase-tutor.depmap-layout.${repositoryId}`;
/** 读必须包 try/catch：这条键坏掉（手改过、别的版本写过别的形状）不该让整张图白屏。 */
function readManualPositions(repositoryId: string): ManualPositions {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(manualKey(repositoryId));
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ManualPositions = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const point = value as { x?: unknown; y?: unknown };
      if (typeof point?.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        out[key] = { x: point.x, y: point.y };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeManualPositions(repositoryId: string, positions: ManualPositions): void {
  try {
    localStorage.setItem(manualKey(repositoryId), JSON.stringify(positions));
  } catch {
    /* 存不下只是下次进来不记得你摆过的位子 */
  }
}

/** 起手移动超过这个像素才算拖，否则还是「点一下选模块」。 */
const DRAG_THRESHOLD = 4;
const NUDGE_PX = 8;

interface Placed {
  node: ModuleNode;
  index: number;
  x: number;
  y: number;
}

/** 把文件路径映射到模块 key：默认取前 depth 段目录；根目录散文件归 "."。 */
function makeKeyOf(depth: number): (path: string) => string {
  return (path: string): string => {
    const segments = path.split("/");
    return segments.length === 1 ? "." : segments.slice(0, Math.min(depth, segments.length - 1)).join("/");
  };
}

/** 最大分组的文件占比——聚合深度的停止下钻判据。 */
function largestFileShare(groups: Map<string, ModuleNode>): number {
  let total = 0;
  let largest = 0;
  for (const group of groups.values()) {
    total += group.files.length;
    largest = Math.max(largest, group.files.length);
  }
  return total ? largest / total : 0;
}

export function buildModuleGraph(index: RepositoryIndex, analysis: RepositoryAnalysis): { nodes: ModuleNode[]; edges: ModuleEdge[] } {
  const entryPaths = new Set(analysis.graph.entrypoints.map((entry) => entry.path));
  const build = (keyOf: (path: string) => string): Map<string, ModuleNode> => {
    const groups = new Map<string, ModuleNode>();
    const ensure = (key: string): ModuleNode => {
      let group = groups.get(key);
      if (!group) {
        group = { key, files: [], lines: 0, isEntry: false, changes: 0, inDegree: 0, outDegree: 0 };
        groups.set(key, group);
      }
      return group;
    };
    index.files.forEach((file) => {
      const group = ensure(keyOf(file.path));
      group.files.push(file);
      group.lines += file.lines;
      if (entryPaths.has(file.path)) group.isEntry = true;
    });
    index.hotspots.forEach((hotspot) => {
      ensure(keyOf(hotspot.path)).changes += hotspot.changes;
    });
    return groups;
  };

  // 自适应聚合深度：固定「前两层」会把 Maven 布局的 src/main/java/com/x 整个吞进一个方块
  // （实测 Spring 仓 116/213 文件同组、边全折成自环）。从浅往深钻，取「最大分组文件占比」首次达标的层；
  // 某层组数超上限先按行数收敛、余量并入「其他」再判——占比判定因此能穿过溢出层到达真正的模块边界。
  const project = (depth: number): { keyOf: (path: string) => string; groups: Map<string, ModuleNode> } => {
    const base = makeKeyOf(depth);
    const direct = build(base);
    if (direct.size <= MAX_GROUPS) return { keyOf: base, groups: direct };
    // 收敛溢出：含入口的模块必留（地图失去了入口标注就失去了锚点），其余按行数取前 N-1，余量并入「其他」
    const sorted = [...direct.values()].sort((a, b) => Number(b.isEntry) - Number(a.isEntry) || b.lines - a.lines);
    const keep = new Set(sorted.slice(0, MAX_GROUPS - 1).map((group) => group.key));
    const keyOfCollapsed = (path: string): string => (keep.has(base(path)) ? base(path) : "其他");
    return { keyOf: keyOfCollapsed, groups: build(keyOfCollapsed) };
  };
  let chosen = project(1);
  for (let depth = 2; depth <= MAX_AGGREGATION_DEPTH && largestFileShare(chosen.groups) > MAX_LARGEST_SHARE; depth += 1) {
    const deeper = project(depth);
    if (largestFileShare(deeper.groups) < largestFileShare(chosen.groups)) chosen = deeper; // 占比不降的层只带来碎片，不采纳
  }
  const { keyOf, groups } = chosen;

  const edgeMap = new Map<string, ModuleEdge>();
  for (const [from, targets] of Object.entries(analysis.graph.imports)) {
    const fromKey = keyOf(from);
    if (!groups.has(fromKey)) continue;
    for (const target of targets) {
      const toKey = keyOf(target);
      if (toKey === fromKey || !groups.has(toKey)) continue;
      const id = `${fromKey}->${toKey}`;
      const existing = edgeMap.get(id);
      if (existing) existing.weight += 1;
      else edgeMap.set(id, { from: fromKey, to: toKey, weight: 1 });
    }
  }
  const edges = [...edgeMap.values()];

  const outBy = new Map<string, Set<string>>();
  const inBy = new Map<string, Set<string>>();
  edges.forEach((edge) => {
    if (!outBy.has(edge.from)) outBy.set(edge.from, new Set());
    if (!inBy.has(edge.to)) inBy.set(edge.to, new Set());
    outBy.get(edge.from)!.add(edge.to);
    inBy.get(edge.to)!.add(edge.from);
  });
  const nodes = [...groups.values()].map((group) => ({
    ...group,
    outDegree: outBy.get(group.key)?.size ?? 0,
    inDegree: inBy.get(group.key)?.size ?? 0
  }));
  return { nodes, edges };
}

/** 破环：DFS 识别回边并从分层计算中剔除（回边仍会绘制，只是不参与定层，否则环会让层深发散）。 */
function acyclicEdges(nodes: ModuleNode[], edges: ModuleEdge[]): ModuleEdge[] {
  const byFrom = new Map<string, ModuleEdge[]>();
  edges.forEach((edge) => byFrom.set(edge.from, [...(byFrom.get(edge.from) ?? []), edge]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 · 1 在 DFS 栈上 · 2 完成
  const kept: ModuleEdge[] = [];
  const visit = (key: string): void => {
    state.set(key, 1);
    (byFrom.get(key) ?? []).forEach((edge) => {
      const stateOf = state.get(edge.to) ?? 0;
      if (stateOf === 1) return; // 回边
      if (stateOf === 0) visit(edge.to);
      kept.push(edge);
    });
    state.set(key, 2);
  };
  nodes.forEach((node) => {
    if ((state.get(node.key) ?? 0) === 0) visit(node.key);
  });
  return kept;
}

/** 依赖深度分层：layer(node) = 破环后最长依赖链长度（入口/无被依赖者在第 0 层）。 */
function assignLayers(nodes: ModuleNode[], allEdges: ModuleEdge[]): Map<string, number> {
  const edges = acyclicEdges(nodes, allEdges);
  const layer = new Map<string, number>(nodes.map((node) => [node.key, 0]));
  const predecessors = new Map<string, string[]>();
  edges.forEach((edge) => predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]));
  for (let round = 0; round < nodes.length; round += 1) {
    let changed = false;
    for (const node of nodes) {
      const next = (predecessors.get(node.key) ?? []).reduce((max, parent) => Math.max(max, (layer.get(parent) ?? 0) + 1), 0);
      if (next !== layer.get(node.key)) {
        layer.set(node.key, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

/** 合成 CourseNode：让模块节点复用既有的节点详情抽屉与地图线程绑定（anchors = 模块内最大的文件）。 */
function toCourseNode(node: ModuleNode): CourseNode {
  return {
    id: `depmap:${node.key}`,
    title: node.key === "." ? "根目录文件" : `${node.key}/`,
    kind: "module",
    summary: `共 ${node.files.length} 个文件、${node.lines} 行；对外依赖 ${node.outDegree} 个模块，被 ${node.inDegree} 个模块引用。${node.isEntry ? "包含执行入口。" : ""}${node.changes > 0 ? `Git 热点（约 ${node.changes} 次变更）。` : ""}`,
    anchors: [...node.files]
      .sort((left, right) => right.lines - left.lines)
      .slice(0, 4)
      .map((file) => ({ path: file.path, line: 1, label: "模块文件" })),
    children: []
  };
}

/** 「占多少」的白话写法：小于 1% 也不说 0%，免得看起来像「一个文件都没有」。 */
function percent(value: number): string {
  if (value <= 0) return "0%";
  return `${Math.max(1, Math.round(value * 100))}%`;
}

/**
  画布上的读数提示：仓内**主要语言**的「依赖边」这一档不是「可信」时，给一枚小徽标 + 悬停说明。

  为什么值得占一格图例：各语言的依赖解析强度本来就不均（Java 的整包导入、Go 的整包落点、
  C/C++ 的头文件名回退……），但过去这件事只写在引擎注释里——用户拿到图没法判断
  「这条边是编译器级的、还是按文件名猜的」。近似必须显式。

  数据只取引擎随分析响应下发的 `languageProfile`（共享能力表的自报口径）：
  界面**不自己判语言、也不自己判档**，缺这个字段（旧引擎）就整块不显示。
*/
function edgeCaveatOf(profile: RepositoryAnalysis["languageProfile"]): { label: string; detail: string } | undefined {
  if (!profile?.languages.length) return undefined;
  const edge = (row: RepositoryLanguageRow): CapabilityLevel => row.capabilities.cells.dependencyEdge;
  const inGraph = profile.languages.filter((row) => row.inDependencyGraph);
  const primary = inGraph[0] ?? profile.languages[0];
  // 一门口规则都没有的语言占大头：这时图上那些边与它无关，得直说
  if (!primary.inDependencyGraph) {
    return {
      label: `${primary.displayName}：未进依赖图`,
      detail: `本仓最多的文件是 ${primary.displayName}（${primary.files} 个，占 ${percent(primary.fileShare)}），但引擎没有这门语言的依赖解析规则——它既不出符号也不出边。图上剩下的边只覆盖 ${percent(profile.graphFileShare)} 的文件。`
    };
  }
  const level = edge(primary);
  if (level === "exact") return undefined;
  const others = inGraph
    .slice(1)
    .filter((row) => row.fileShare >= 0.05 && edge(row) !== "exact")
    .slice(0, 3)
    .map((row) => `${row.displayName}（${percent(row.fileShare)}）：${CAPABILITY_CELL_LABEL.dependencyEdge}=${CAPABILITY_LEVEL_LABEL[edge(row)]}`);
  const lines = [
    `${primary.displayName} 在本仓有 ${primary.files} 个文件，占 ${percent(primary.fileShare)}。`,
    `${CAPABILITY_CELL_LABEL.dependencyEdge}=${CAPABILITY_LEVEL_LABEL[level]}：${primary.capabilities.notes.dependencyEdge}`,
    ...(others.length ? [`同仓其他语言 —— ${others.join("；")}`] : []),
    ...(profile.parseBackend === "regex" ? [`提醒：本次分析的符号抽取没能用上语法树（${profile.parseBackendReason ?? "原因未记录"}），文件里有哪些函数也要按近似读。`] : [])
  ];
  return { label: `${primary.displayName}：${CAPABILITY_CELL_LABEL.dependencyEdge}=${CAPABILITY_LEVEL_LABEL[level]}`, detail: lines.join("\n") };
}

export function DepMap({ index, analysis, selectedId, onSelect }: {
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
  selectedId?: string;
  /** 合成节点 + 模块内文件清单：节点 id 在课程树里不存在，清单随对话请求上送给引擎解析作用域。 */
  onSelect: (node: CourseNode, scopePaths: string[]) => void;
}): ReactElement {
  const graph = useMemo(() => buildModuleGraph(index, analysis), [index, analysis]);
  /** 你手动摆过的位子（按仓库记）：没摆过的节点仍走自动分层布局。 */
  const [manual, setManual] = useState<ManualPositions>(() => readManualPositions(index.repositoryId));
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ key: string; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  /** 拖完浏览器还会补一个 click，而那时 dragRef 已经清空：单独留个旗子供 click 里判。 */
  const movedFlag = useRef(false);
  const panRef = useRef<{ scroller: HTMLElement; startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null);
  // 换仓要重读位子，否则会拿上一个仓的坐标摆这个仓的模块
  useEffect(() => { setManual(readManualPositions(index.repositoryId)); }, [index.repositoryId]);
  useEffect(() => { writeManualPositions(index.repositoryId, manual); }, [index.repositoryId, manual]);
  /** 主要语言的「依赖边」读数提示（不需要提示时 undefined，图例保持原样） */
  const caveat = useMemo(() => edgeCaveatOf(analysis.languageProfile), [analysis.languageProfile]);
  // 依赖图只画关系：无 import 关系且不含入口的模块（docs/.changeset 等非代码目录）不上图，
  // 数量在图例中明示；全部被过滤时回退全量，避免空画布。
  const { nodes, edges, hiddenModules } = useMemo(() => {
    const connected = graph.nodes.filter((node) => node.isEntry || node.inDegree + node.outDegree > 0);
    return connected.length
      ? { nodes: connected, edges: graph.edges, hiddenModules: graph.nodes.length - connected.length }
      : { nodes: graph.nodes, edges: graph.edges, hiddenModules: 0 };
  }, [graph]);

  const columns: ModuleNode[][] = [];
  const layers = assignLayers(nodes, edges);
  nodes.forEach((node) => {
    const layer = layers.get(node.key) ?? 0;
    (columns[layer] ??= []).push(node);
  });
  columns.forEach((column) => column.sort((left, right) => Number(right.isEntry) - Number(left.isEntry) || left.key.localeCompare(right.key)));

  const placed: Placed[] = [];
  const positions = new Map<string, Placed>();
  columns.forEach((column, layer) => column.forEach((node, rowIndex) => {
    const auto = { x: PAD_X + layer * (NODE_W + COL_GAP), y: PAD_Y + rowIndex * ROW_STRIDE };
    const at = manual[node.key] ?? auto;
    const item: Placed = { node, index: rowIndex, x: at.x, y: at.y };
    placed.push(item);
    positions.set(node.key, item);
  }));

  const paths = edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return null;
    const startX = from.x + NODE_W;
    const midX = startX + (to.x - startX) / 2;
    const startY = from.y + NODE_MIN_H / 2;
    const endY = to.y + NODE_MIN_H / 2;
    // 原型 `.arch-svg path` 是 1.5 粗：权重再加成，但下限就是 1.5，细过这条线在浅底上几乎看不见
    const width = 1.5 + Math.min(2, Math.floor(edge.weight / 6));
    // prototype `.arch-svg` 的连线是贝塞尔（控制点取两列正中）：同层并排时比正交折线少压节点
    return { key: `${edge.from}->${edge.to}`, d: `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${to.x} ${endY}`, width };
  }).filter((path): path is NonNullable<typeof path> => path !== null);

  const lastLayer = Math.max(columns.length - 1, 0);
  // 手动摆过之后内容可能超出自动布局的边界：画布尺寸跟着最远的节点走，才拖得出滚动条而不是把节点拖丢
  const bounds = placed.reduce((acc, item) => ({ x: Math.max(acc.x, item.x + NODE_W), y: Math.max(acc.y, item.y + NODE_MIN_H) }), { x: 0, y: 0 });
  const canvasW = Math.max(MIN_W, PAD_X + lastLayer * (NODE_W + COL_GAP) + NODE_W + PAD_X, bounds.x + PAD_X);
  const canvasH = Math.max(MIN_H, PAD_Y + Math.max(...columns.map((column) => column.length), 0) * ROW_STRIDE + 40, bounds.y + PAD_Y);
  const movedCount = Object.keys(manual).length;

  const nudge = (key: string, from: Placed, dx: number, dy: number): void => {
    setManual((curr) => ({ ...curr, [key]: { x: Math.max(0, from.x + dx), y: Math.max(0, from.y + dy) } }));
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, item: Placed): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    movedFlag.current = false;
    dragRef.current = { key: item.node.key, startX: event.clientX, startY: event.clientY, originX: item.x, originY: item.y, moved: false };
  };
  const onNodePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    movedFlag.current = true;
    setManual((curr) => ({ ...curr, [drag.key]: { x: Math.max(0, drag.originX + dx), y: Math.max(0, drag.originY + dy) } }));
  };
  const onNodePointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragRef.current) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };
  /** 拖完那一下浏览器仍会补一个 click：吞掉它，否则「拖动摆放」每次都顺手把模块选中并弹详情抽屉。 */
  const onNodeClick = (item: Placed): void => {
    if (dragRef.current?.moved || movedFlag.current) { movedFlag.current = false; return; }
    onSelect(toCourseNode(item.node), item.node.files.map((file) => file.path));
  };
  const onNodeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, item: Placed): void => {
    const step = event.shiftKey ? NUDGE_PX * 3 : NUDGE_PX;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    nudge(item.node.key, item, move[0], move[1]);
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // 只有按在空白处（画布本身或铺满的 SVG）才平移，按在节点上留给节点拖动
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && !target.classList.contains("arch-svg")) return;
    const scroller = canvasRef.current?.closest<HTMLElement>(".map-canvas-wrap");
    if (!scroller) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { scroller, startX: event.clientX, startY: event.clientY, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop };
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current;
    if (!pan) return;
    pan.scroller.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    pan.scroller.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  };
  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!panRef.current) return;
    panRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <>
      {/* 节点全是绝对定位、撑不开父级，所以画布尺寸由这一层 in-flow 的盒子交出去；
          它同时是 `.arch-svg` 的定位基准（CSS 让 SVG inset:0 铺满），坐标才与节点一一对上。 */}
      <div
        ref={canvasRef}
        className="arch-canvas"
        style={{ position: "relative", width: canvasW, minHeight: canvasH }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
      >
        <svg className="arch-svg" width={canvasW} height={canvasH} aria-hidden>
          <defs>
            <marker id="dep-arrow" markerUnits="userSpaceOnUse" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          {paths.map((path) => <path key={path.key} d={path.d} strokeWidth={path.width} markerEnd="url(#dep-arrow)" />)}
        </svg>
        {placed.map((item) => {
          const node = item.node;
          const id = `depmap:${node.key}`;
          return (
            <button
              key={id}
              type="button"
              className={`arch-node col${node.isEntry ? " entry-node" : ""}${selectedId === id ? " selected" : ""}${manual[node.key] ? " placed" : ""}`}
              style={{ left: item.x, top: item.y, width: NODE_W, minHeight: NODE_MIN_H }}
              title={`${node.key === "." ? "根目录文件" : node.key} · ${node.files.length} 个文件 · ${node.lines} 行 · 依赖 ${node.outDegree} 个模块 · 被 ${node.inDegree} 个模块依赖${node.isEntry ? " · 含执行入口" : ""}${node.changes > 0 ? ` · Git 热点约 ${node.changes} 次变更` : ""}\n点一下看详情 · 拖动摆放 · 方向键微调（Shift 加速）`}
              onPointerDown={(event) => onNodePointerDown(event, item)}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onKeyDown={(event) => onNodeKeyDown(event, item)}
              onClick={() => onNodeClick(item)}
            >
              <span className="n-role">{`${String(item.index + 1).padStart(2, "0")} · ${node.isEntry ? "入口模块" : "模块"}${node.changes >= HOTSPOT_CHANGES ? " · 热点" : ""}`}</span>
              <span className="n-name">{node.key === "." ? "根目录文件" : `${node.key}/`}</span>
              <span className="n-meta">
                <span>{`${node.files.length} 文件 · ${node.lines} 行`}</span>
                {node.changes > 0 ? <span className="hot-dot">{`● ${node.changes} 次变更`}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flow-legend">
        <span className="badge badge-neutral">入口模块</span>
        {/* 主语言的依赖边强度：徽标只在「不是可信档」时出现（见 edgeCaveatOf） */}
        {caveat ? <span className="badge badge-warn" title={caveat.detail}>{caveat.label}</span> : null}
        <span className="fs-11 faint" title={`边 = import 依赖，线粗 = 引用次数多。${hiddenModules ? `另有 ${hiddenModules} 个无依赖也非入口的模块没画进来，完整清单在左侧目录。` : ""}`}>
          {`箭头指向被依赖方${hiddenModules ? ` · 未画 ${hiddenModules} 个孤立模块` : ""}`}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!movedCount} onClick={() => setManual({})} title={movedCount ? "清掉手动位子，回到按依赖深度分层的自动布局" : "还没拖动过，无需重置"}>
          <Icon name="rotate" size={13} />回到自动布局
        </button>
        <span className="fs-11 faint">{movedCount ? `已摆 ${movedCount} 个` : ""}</span>
      </div>
    </>
  );
}
