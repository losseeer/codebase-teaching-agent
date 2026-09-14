import type { ReactElement } from "react";
import type { CourseNode } from "@codebase-tutor/shared";
import { kindLabel } from "../views/CoursePage";

/**
  代码地图的「运行路径」画布（对齐 prototype `.map-canvas` / `.map-inner` / `.flow-node`）。
  - 真实课程树按深度分层：列 = 深度，行 = 同层 DFS 出现顺序；各列垂直居中
  - 节点是绝对定位的 `.flow-node`（`node-kind` + 标题 + 摘要），连线是直角 SVG path
  - 画布自身滚动（`overflow: auto`），页面不产生滚动条 —— 见开发计划 §1.5

  prototype 的六个节点坐标是手工摆的静态数据；这里用同一套视觉语言承载真实仓库的任意节点数。
  */

const NODE_W = 170;
const ROOT_W = 188;
const NODE_MIN_H = 104;
const ROW_STRIDE = 158;
const COL_GAP = 52;
const PAD_X = 36;
const PAD_Y = 34;
const MAX_NODES = 12;
const MIN_W = 710;
const MIN_H = 623;

interface Placed {
  node: CourseNode;
  depth: number;
  index: number;
  x: number;
  y: number;
  width: number;
}

function countAll(node: CourseNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countAll(child), 0);
}

function columnWidth(depth: number): number {
  return depth === 0 ? ROOT_W : NODE_W;
}

function columnX(depth: number): number {
  let x = PAD_X;
  for (let level = 0; level < depth; level += 1) x += columnWidth(level) + COL_GAP;
  return x;
}

function columnHeight(count: number): number {
  return count > 0 ? count * ROW_STRIDE - (ROW_STRIDE - NODE_MIN_H) : 0;
}

export function FlowMap({ root, selectedId, onSelect }: { root: CourseNode; selectedId?: string; onSelect: (node: CourseNode) => void }): ReactElement {
  const columns: CourseNode[][] = [];
  const parents = new Map<CourseNode, CourseNode>();
  let shown = 0;
  const place = (node: CourseNode, depth: number): void => {
    if (shown >= MAX_NODES) return;
    (columns[depth] ??= []).push(node);
    shown += 1;
    node.children.forEach((child) => { parents.set(child, node); place(child, depth + 1); });
  };
  place(root, 0);
  const hidden = countAll(root) - shown;

  const maxHeight = Math.max(...columns.map((column) => columnHeight(column.length)));
  const placed: Placed[] = [];
  columns.forEach((column, depth) => {
    // 各列顶对齐（entry 节点固定在左上角），保证「从入口到反馈」的阅读方向稳定
    column.forEach((node, index) => {
      placed.push({ node, depth, index, x: columnX(depth), y: PAD_Y + index * ROW_STRIDE, width: columnWidth(depth) });
    });
  });

  const positions = new Map<CourseNode, Placed>();
  placed.forEach((item) => positions.set(item.node, item));
  const edges: string[] = [];
  placed.forEach((child) => {
    const parent = parents.get(child.node);
    const from = parent ? positions.get(parent) : undefined;
    if (!from) return;
    const startX = from.x + from.width;
    const endX = child.x;
    const startY = from.y + 46;
    const endY = child.y + 46;
    const midX = startX + (endX - startX) / 2;
    edges.push(`M ${startX} ${startY} H ${midX} V ${endY} H ${endX}`);
  });

  const lastDepth = Math.max(columns.length - 1, 0);
  const canvasW = Math.max(MIN_W, columnX(lastDepth) + columnWidth(lastDepth) + PAD_X);
  const canvasH = Math.max(MIN_H, PAD_Y + maxHeight + 92);

  return (
    <div className="map-scroll">
      <div className="map-inner" style={{ width: canvasW, minHeight: canvasH }}>
        <p className="map-title">运行路径 · 从入口到反馈</p>
        <svg className="flow-lines" width={canvasW} height={canvasH} aria-hidden>
          {edges.map((path) => <path key={path} d={path} />)}
        </svg>
        {placed.map((item) => (
          <button
            key={item.node.id}
            type="button"
            className={`flow-node${selectedId === item.node.id ? " selected" : ""}${item.depth === 0 ? " root" : ""}`}
            style={{ left: item.x, top: item.y, width: item.width, minHeight: NODE_MIN_H }}
            title={`${item.node.title} · ${item.node.kind}`}
            onClick={() => onSelect(item.node)}
          >
            <span className="node-kind">{item.depth === 0 ? "repository" : `${String(item.index + 1).padStart(2, "0")} · ${kindLabel(item.node.kind)}`}</span>
            <strong>{item.node.title}</strong>
            <small>{item.node.summary}</small>
          </button>
        ))}
        <div className="flow-legend">
          <span><i className="green" />主路径</span>
          <span><i />后续步骤</span>
          {hidden > 0 ? <span className="legend-note">还有 {hidden} 个节点未展开 · 在项目目录或教学会话中查看</span> : null}
        </div>
      </div>
    </div>
  );
}
