import { useMemo, type ReactElement } from "react";
import type { CourseNode, FileEntry, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";

/**
 * 宏观设计 v0.6：模块依赖图（替代旧 FlowMap 课程树流程图）。
 *
 * 为什么改：旧地图把课程树（一棵层级树）画成图——层级用列表呈现更高效，
 * 图的存在价值在「边」承载列表给不了的关系信息。本组件画真正的依赖关系：
 * - 节点 = 目录前缀聚合的模块（聚合深度自适应：从浅往深钻到「最大分组占比」达标为止，见 chooseAggregation；
 *   超过 MAX_GROUPS 按行数并入「其他」）
 * - 边 = 跨模块 import 引用（analysis.graph.imports 文件级聚合为模块级，粗细 = 引用次数）
 * - 布局 = 按依赖深度分层，入口模块（含 entrypoint 的模块）在最左列，复用 prototype
 *   flow-node / flow-lines 视觉语言与正交连线
 * - 点击模块 → 合成 CourseNode（anchors = 模块内最大的文件），走既有的节点详情抽屉与地图线程
 *
 * 课程树本身不变：engine 侧 workflows/modules/micro 仍驱动教学、练习与推荐入口，
 * 只是地图画布不再渲染它。
 */

const NODE_W = 196;
const NODE_MIN_H = 104;
const ROW_STRIDE = 158;
const COL_GAP = 52;
const PAD_X = 36;
const PAD_Y = 44;
const MIN_W = 710;
const MIN_H = 623;
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

export function DepMap({ index, analysis, selectedId, onSelect }: {
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
  selectedId?: string;
  /** 合成节点 + 模块内文件清单：节点 id 在课程树里不存在，清单随对话请求上送给引擎解析作用域。 */
  onSelect: (node: CourseNode, scopePaths: string[]) => void;
}): ReactElement {
  const graph = useMemo(() => buildModuleGraph(index, analysis), [index, analysis]);
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
    const item: Placed = { node, index: rowIndex, x: PAD_X + layer * (NODE_W + COL_GAP), y: PAD_Y + rowIndex * ROW_STRIDE };
    placed.push(item);
    positions.set(node.key, item);
  }));

  const paths = edges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return null;
    const startX = from.x + NODE_W;
    const midX = startX + (to.x - startX) / 2;
    const startY = from.y + 46;
    const endY = to.y + 46;
    const width = 1 + Math.min(2, Math.floor(edge.weight / 6));
    return { key: `${edge.from}->${edge.to}`, d: `M ${startX} ${startY} H ${midX} V ${endY} H ${to.x}`, width };
  }).filter((path): path is NonNullable<typeof path> => path !== null);

  const lastLayer = Math.max(columns.length - 1, 0);
  const canvasW = Math.max(MIN_W, PAD_X + lastLayer * (NODE_W + COL_GAP) + NODE_W + PAD_X);
  const canvasH = Math.max(MIN_H, PAD_Y + Math.max(...columns.map((column) => column.length), 0) * ROW_STRIDE + 92);

  return (
    <div className="map-scroll">
      <div className="map-inner" style={{ width: canvasW, minHeight: canvasH }}>
        <svg className="flow-lines" width={canvasW} height={canvasH} aria-hidden>
          {paths.map((path) => <path key={path.key} d={path.d} strokeWidth={path.width} />)}
        </svg>
        {placed.map((item) => {
          const node = item.node;
          const id = `depmap:${node.key}`;
          return (
            <button
              key={id}
              type="button"
              className={`flow-node${node.isEntry ? " entry" : ""}${selectedId === id ? " selected" : ""}`}
              style={{ left: item.x, top: item.y, width: NODE_W, minHeight: NODE_MIN_H }}
              title={`${node.key === "." ? "根目录文件" : node.key} · ${node.files.length} 个文件 · ${node.lines} 行 · 依赖 ${node.outDegree} 个模块 · 被 ${node.inDegree} 个模块依赖${node.isEntry ? " · 含执行入口" : ""}${node.changes > 0 ? ` · Git 热点约 ${node.changes} 次变更` : ""}`}
              onClick={() => onSelect(toCourseNode(node), node.files.map((file) => file.path))}
            >
              <span className="node-kind">
                {`${String(item.index + 1).padStart(2, "0")} · ${node.isEntry ? "入口模块" : "模块"}${node.changes >= HOTSPOT_CHANGES ? " · 热点" : ""}`}
              </span>
              <strong>{node.key === "." ? "根目录文件" : `${node.key}/`}</strong>
              <small>{`${node.files.length} 个文件 · ${node.lines} 行 · 依赖 ${node.outDegree} · 被依赖 ${node.inDegree}`}</small>
            </button>
          );
        })}
        <div className="flow-legend">
          <span><i className="green" />入口模块</span>
          <span><i />普通模块</span>
          <span className="legend-note">
            {`边 = import 依赖 · 越粗引用越多 · 点击模块在抽屉中看文件清单${hiddenModules ? ` · ${hiddenModules} 个无依赖且非入口的模块未显示（完整清单在左侧项目目录）` : ""}`}
          </span>
        </div>
      </div>
    </div>
  );
}
