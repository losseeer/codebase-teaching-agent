import type { DiagramBody, DiagramEdge, DiagramEdgeOrigin, DiagramNode } from "@codebase-tutor/domain";

/** 画布几何与文案口径（纯函数），DiagramCanvas 与 DiagramPage 共用。 */

/** 节点定宽；高度靠量。 */
export const NODE_W = 132;
export const NODE_H = 48;
/** 世界层最小尺寸；内容更靠右/下时自动扩大。 */
export const WORLD_MIN_W = 2400;
export const WORLD_MIN_H = 1600;
export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 2.5;
const FIT_ZOOM_MAX = 1.2;
const FIT_PAD = 40;

export interface View {
  x: number;
  y: number;
  z: number;
}

export interface Size {
  w: number;
  h: number;
}

/** 节点盒子：世界坐标下的未缩放尺寸（与画布 scale 无关）。 */
export type NodeBoxes = Map<string, Size>;

export const DEFAULT_VIEW: View = { x: 40, y: 20, z: 1 };

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** 边级可信度三档的统一措辞（图例与抽屉共用）。 */
export const ORIGIN_SHORT: Record<DiagramEdgeOrigin, string> = {
  static: "依赖图可证明",
  code: "源码正文读过",
  inferred: "模型推断"
};

export const EDGE_ORIGINS = Object.keys(ORIGIN_SHORT) as DiagramEdgeOrigin[];

/** 坏串原样返回，不编一个时间。 */
export function relativeTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  return versionTime(iso);
}

export function versionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "diagram";
}

/** 节点盒子：量到就用量到的，量不到（首帧）用定宽 + 兜底高。 */
export function boxOf(boxes: NodeBoxes, id: string): Size {
  return boxes.get(id) ?? { w: NODE_W, h: NODE_H };
}

/** 一条边的走线：从源卡片边沿横平竖直走到目标卡片边沿（缺任一端不画），方向按主轴选顶/底或左/右边。 */
export function edgePoints(body: DiagramBody, edge: DiagramEdge, boxes: NodeBoxes, offset = 0): { x: number; y: number }[] | null {
  const from = body.nodes.find((node) => node.id === edge.from);
  const to = body.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return null;
  const a = boxOf(boxes, from.id);
  const b = boxOf(boxes, to.id);
  const ax = from.x + a.w / 2;
  const ay = from.y + a.h / 2;
  const bx = to.x + b.w / 2;
  const by = to.y + b.h / 2;
  // offset 是同一对节点之间第 k 条边的通道偏移：两端一起平移，线仍落在卡片边上，只是并排走。
  if (Math.abs(by - ay) >= Math.abs(bx - ax)) {
    const startY = by >= ay ? from.y + a.h : from.y;
    const endY = by >= ay ? to.y : to.y + b.h;
    const midY = startY + (endY - startY) / 2;
    return [{ x: ax + offset, y: startY }, { x: ax + offset, y: midY }, { x: bx + offset, y: midY }, { x: bx + offset, y: endY }];
  }
  // 同一水平带走两卡片下方的通道，避免直线横穿中间卡片。
  if (Math.abs(by - ay) < Math.max(a.h, b.h)) {
    const laneY = Math.max(from.y + a.h, to.y + b.h) + 14 + offset;
    return [
      { x: ax, y: from.y + a.h },
      { x: ax, y: laneY },
      { x: bx, y: laneY },
      { x: bx, y: to.y + b.h }
    ];
  }
  const startX = bx >= ax ? from.x + a.w : from.x;
  const endX = bx >= ax ? to.x : to.x + b.w;
  const midX = startX + (endX - startX) / 2;
  return [{ x: startX, y: ay + offset }, { x: midX, y: ay + offset }, { x: midX, y: by + offset }, { x: endX, y: by + offset }];
}

/** 同一条通道上相邻两条边之间的距离（px）。卡片宽 132，两侧各排三条仍落在卡片边上。 */
export const EDGE_LANE_GAP = 10;

/** 同一水平带的边按通道基准 y 分组错开，避免叠成一根线；跨行的边各归各组。 */
export function sameBandLanes(body: DiagramBody, boxes: NodeBoxes): Map<string, number> {
  const counters = new Map<number, number>();
  const lanes = new Map<string, number>();
  for (const edge of body.edges) {
    const from = body.nodes.find((node) => node.id === edge.from);
    const to = body.nodes.find((node) => node.id === edge.to);
    if (!from || !to) continue;
    const a = boxOf(boxes, from.id);
    const b = boxOf(boxes, to.id);
    const sameBand = Math.abs((to.y + b.h / 2) - (from.y + a.h / 2)) < Math.max(a.h, b.h);
    if (!sameBand) continue;
    const key = Math.round(Math.max(from.y + a.h, to.y + b.h));
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    lanes.set(edge.id, index * EDGE_LANE_GAP);
  }
  return lanes;
}

/** 同一对节点的多条边（含反向）按无向对分组、按 id 排序后居中错开；单边不偏移。 */
export function edgeOffsets(body: DiagramBody): Map<string, number> {
  const groups = new Map<string, DiagramEdge[]>();
  for (const edge of body.edges) {
    const key = [edge.from, edge.to].sort().join("\u0000");
    const list = groups.get(key);
    if (list) list.push(edge);
    else groups.set(key, [edge]);
  }
  const offsets = new Map<string, number>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((left, right) => left.id.localeCompare(right.id));
    sorted.forEach((edge, index) => offsets.set(edge.id, (index - (sorted.length - 1) / 2) * EDGE_LANE_GAP));
  }
  return offsets;
}

/** 分组框宣称「框住的是节点」，那它就得真包住：这是卡片与框之间留的呼吸位。 */
const GROUP_PAD = 12;

/** 分组框只放大到装下成员（按 `group` 归属或已落在框内），绝不缩小，用户拖大的框不被推翻。 */
export function groupRects(body: DiagramBody, boxes: NodeBoxes): { id: string; label: string; x: number; y: number; w: number; h: number }[] {
  return body.groups.map((group) => {
    let minX = group.x;
    let minY = group.y;
    let maxX = group.x + group.w;
    let maxY = group.y + group.h;
    for (const node of body.nodes) {
      const inside = node.group === group.id || (node.x >= group.x && node.y >= group.y && node.x < group.x + group.w && node.y < group.y + group.h);
      if (!inside) continue;
      const size = boxOf(boxes, node.id);
      minX = Math.min(minX, node.x - GROUP_PAD);
      minY = Math.min(minY, node.y - GROUP_PAD);
      maxX = Math.max(maxX, node.x + size.w + GROUP_PAD);
      maxY = Math.max(maxY, node.y + size.h + GROUP_PAD);
    }
    return { id: group.id, label: group.label, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  });
}

/** 内容包围盒（含分组框），空图返回 null；节点按量到的尺寸算右下角。 */
export function boundsOf(body: DiagramBody, boxes: NodeBoxes): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!body.nodes.length && !body.groups.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const group of body.groups) {
    minX = Math.min(minX, group.x);
    minY = Math.min(minY, group.y);
    maxX = Math.max(maxX, group.x + group.w);
    maxY = Math.max(maxY, group.y + group.h);
  }
  for (const node of body.nodes) {
    const box = boxOf(boxes, node.id);
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + box.w);
    maxY = Math.max(maxY, node.y + box.h);
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/** 世界层尺寸：铺满最小值，再按内容往右、往下长，网格与边坐标系才不会把远处的节点裁掉。 */
export function worldSizeOf(body: DiagramBody, boxes: NodeBoxes): { w: number; h: number } {
  const bounds = boundsOf(body, boxes);
  if (!bounds) return { w: WORLD_MIN_W, h: WORLD_MIN_H };
  const pad = 240;
  return {
    w: Math.max(WORLD_MIN_W, Math.ceil(bounds.maxX) + pad),
    h: Math.max(WORLD_MIN_H, Math.ceil(bounds.maxY) + pad)
  };
}

/** 把内容居中放进视口；缩放夹在 [ZOOM_MIN, FIT_ZOOM_MAX]，小图不撑满、大图能看全。 */
export function fitView(body: DiagramBody, boxes: NodeBoxes, viewport: Size): View {
  const bounds = boundsOf(body, boxes);
  if (!bounds || viewport.w <= 0 || viewport.h <= 0) return DEFAULT_VIEW;
  const width = bounds.maxX - bounds.minX + FIT_PAD * 2;
  const height = bounds.maxY - bounds.minY + FIT_PAD * 2;
  const z = clamp(Math.min(viewport.w / width, viewport.h / height), ZOOM_MIN, FIT_ZOOM_MAX);
  return { z, x: (viewport.w - width * z) / 2 - (bounds.minX - FIT_PAD) * z, y: (viewport.h - height * z) / 2 - (bounds.minY - FIT_PAD) * z };
}

/** 以视口内某点为锚缩放（滚轮与 ＋/－ 共用）：那一点下方的世界坐标在缩放前后不动。 */
export function zoomAt(view: View, anchor: { x: number; y: number }, factor: number): View {
  const z = clamp(view.z * factor, ZOOM_MIN, ZOOM_MAX);
  if (z === view.z) return view;
  return { z, x: anchor.x - (anchor.x - view.x) * (z / view.z), y: anchor.y - (anchor.y - view.y) * (z / view.z) };
}

/** 便签正文在画布上露多少字：超出交给抽屉。 */
export const NOTE_TEXT_PREVIEW = 42;

export function notePreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > NOTE_TEXT_PREVIEW ? `${oneLine.slice(0, NOTE_TEXT_PREVIEW)}…` : oneLine;
}

/** 节点 sub 缺失时的显示口径：便签回落到「便签」，模块节点不补字。 */
export function subLineOf(node: DiagramNode): string {
  if (node.kind === "note") return node.sub ?? "便签";
  return node.sub ?? "";
}
