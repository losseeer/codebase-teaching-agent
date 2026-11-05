/**
  未布局的图自动排一次版。

  `draw` 允许节点不带 x/y（`clampCoord` 收成 0），agent 常常整张图都不给坐标，
  结果 21 个节点全叠在 (0,0)、7 个分组框也叠在一点——画布看起来就是"一团卡片"。
  这里只在**明显没排过版**时动手：分组按声明顺序自上而下，组内按声明的先后从左到右、
  每行最多 4 个。已经有坐标的图（用户拖过、或 agent 自己给了位置）一律不动。
*/
import type { DiagramBody, DiagramGroup, DiagramNode } from "@codebase-tutor/domain";

/** 画布节点是定宽 132、按文字量到 48–100 高；这里给格子留余量，避免标题两行时压住下一行。 */
const CELL_W = 264;
const CELL_H = 112;
const COL_GAP = 32;
const ROW_GAP = 32;
const GROUP_TITLE = 32;
const GROUP_PAD = 28;
const GROUP_GAP = 28;
const MAX_COLS = 5;
const ORIGIN = 80;

/** 坐标高度重复（不同坐标不超过节点数的三分之一）就认为没排过版。 */
export function needsLayout(body: DiagramBody): boolean {
  if (body.nodes.length < 2) return false;
  const distinct = new Set(body.nodes.map((node) => `${node.x},${node.y}`));
  return distinct.size <= Math.max(1, Math.floor(body.nodes.length / 3));
}

const cellOf = (index: number, originX: number, originY: number): { x: number; y: number } => ({
  x: originX + Math.floor(index % MAX_COLS) * (CELL_W + COL_GAP),
  y: originY + Math.floor(index / MAX_COLS) * (CELL_H + ROW_GAP)
});

/** 按分组分行排开；没有 group 或指向已删分组的节点排在最后一块空白处。 */
export function layoutDiagram(body: DiagramBody): DiagramBody {
  const placed = new Map<string, { x: number; y: number }>();
  const groups: DiagramGroup[] = [];
  let cursorY = ORIGIN;

  for (const group of body.groups) {
    const members = body.nodes.filter((node) => node.group === group.id);
    const cols = Math.min(MAX_COLS, Math.max(1, members.length));
    const rows = Math.max(1, Math.ceil(members.length / MAX_COLS));
    const w = cols * CELL_W + (cols - 1) * COL_GAP + GROUP_PAD * 2;
    const h = GROUP_TITLE + rows * CELL_H + (rows - 1) * ROW_GAP + GROUP_PAD;
    groups.push({ ...group, x: ORIGIN, y: cursorY, w, h });
    members.forEach((node, index) => {
      placed.set(node.id, cellOf(index, ORIGIN + GROUP_PAD, cursorY + GROUP_TITLE));
    });
    cursorY += h + GROUP_GAP;
  }

  const known = new Set(body.groups.map((group) => group.id));
  const orphans = body.nodes.filter((node) => !node.group || !known.has(node.group));
  const orphanBase = body.groups.length ? cursorY + GROUP_TITLE : ORIGIN;
  orphans.forEach((node, index) => {
    placed.set(node.id, cellOf(index, ORIGIN, orphanBase));
  });

  return { ...body, groups, nodes: body.nodes.map((node) => ({ ...node, ...(placed.get(node.id) ?? {}) })) };
}

/** 落盘前的统一入口：需要排版才排，返回是否真的动过。 */
export function layoutIfUnplaced(body: DiagramBody): { body: DiagramBody; applied: boolean } {
  if (!needsLayout(body)) return { body, applied: false };
  return { body: layoutDiagram(body), applied: true };
}
