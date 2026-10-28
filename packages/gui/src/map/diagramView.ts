import type { DiagramBody, DiagramEdge, DiagramEdgeOrigin, DiagramNode } from "@codebase-tutor/domain";

/**
  画布的几何与文案口径（纯函数，无 JSX）：`DiagramCanvas` 与 `DiagramPage` 共用。
  「节点高度靠量」「视野由调用方持有」两条判据见 `DiagramCanvas` 的头注释。
*/

/** 节点定宽；高度不写死（靠量，见上）。 */
export const NODE_W = 132;
/** 量不到盒子时的兜底高度。 */
export const NODE_H = 48;
/** 世界层最小尺寸：网格与边的坐标系铺到这里，节点再往右下拖就自动扩（`.dg-world` 的 inline 尺寸）。 */
export const WORLD_MIN_W = 2400;
export const WORLD_MIN_H = 1600;
export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 2.5;
/** 适应内容时最多放这么大：一张只有三个节点的图不该被撑满整屏。 */
const FIT_ZOOM_MAX = 1.2;
/** 适应内容时四周留白。 */
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

/** 量出来的节点盒子（世界坐标里的未缩放尺寸，与 transform 的 scale 无关）。 */
export type NodeBoxes = Map<string, Size>;

export const DEFAULT_VIEW: View = { x: 40, y: 20, z: 1 };

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
  边级可信度三档的说法。`ORIGIN_SHORT` 图例与抽屉都用，措辞只在这里定一次。
*/
export const ORIGIN_SHORT: Record<DiagramEdgeOrigin, string> = {
  static: "依赖图可证明",
  code: "源码正文读过",
  inferred: "模型推断"
};

export const EDGE_ORIGINS = Object.keys(ORIGIN_SHORT) as DiagramEdgeOrigin[];

/** ISO 串 → 「刚刚 / N 分钟前 / N 小时前 / N 天前 / 03-04 15:02」。坏串原样显示，不编一个时间。 */
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

/** 版本条目用绝对时间（恢复到哪一版要能核对，相对时间办不到）。 */
export function versionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 下载文件名里不能出现这些字符，图名却是用户自己起的。 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "diagram";
}

/** 节点盒子：量到就用量到的，量不到（首帧）用定宽 + 兜底高。 */
export function boxOf(boxes: NodeBoxes, id: string): Size {
  return boxes.get(id) ?? { w: NODE_W, h: NODE_H };
}

/**
  一条边的走线：从源卡片的那一面出发，横平竖直地走到目标卡片的那一面（缺任一端就不画）。
  为什么不画中心到中心的直线：直线会压在两端卡片身上，还会横穿路上任何一张卡片与分组框——
  用户看到的就成「一团斜线盖着几个框」，读不出依赖关系。方向按主轴选：竖着走接顶/底边，横着走接左/右边。
*/
export function edgePoints(body: DiagramBody, edge: DiagramEdge, boxes: NodeBoxes): { x: number; y: number }[] | null {
  const from = body.nodes.find((node) => node.id === edge.from);
  const to = body.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return null;
  const a = boxOf(boxes, from.id);
  const b = boxOf(boxes, to.id);
  const ax = from.x + a.w / 2;
  const ay = from.y + a.h / 2;
  const bx = to.x + b.w / 2;
  const by = to.y + b.h / 2;
  if (Math.abs(by - ay) >= Math.abs(bx - ax)) {
    const startY = by >= ay ? from.y + a.h : from.y;
    const endY = by >= ay ? to.y : to.y + b.h;
    const midY = startY + (endY - startY) / 2;
    return [{ x: ax, y: startY }, { x: ax, y: midY }, { x: bx, y: midY }, { x: bx, y: endY }];
  }
  const startX = bx >= ax ? from.x + a.w : from.x;
  const endX = bx >= ax ? to.x : to.x + b.w;
  const midX = startX + (endX - startX) / 2;
  return [{ x: startX, y: ay }, { x: midX, y: ay }, { x: midX, y: by }, { x: endX, y: by }];
}

/** 分组框宣称「框住的是节点」，那它就得真包住：这是卡片与框之间留的呼吸位。 */
const GROUP_PAD = 12;

/**
  分组框实际画多大：模型给的 `w`/`h` 是它自己估的（常见 80），而卡片高度是按文字量出来的（带 sub 或便签会到 90 以上），
  照原值画就出现「卡片压出框外」。这里只**放大**到真能装下成员（按 `group` 归属，或几何上已经落在框里的），
  绝不缩小——用户手动拖大的框不被推翻。
*/
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

/**
  内容包围盒（含分组框）。空图返回 null，由调用方退回默认视野。
  节点按量到的尺寸算右下角。
*/
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
  const pad = 400;
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
