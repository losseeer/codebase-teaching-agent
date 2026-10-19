import { describe, expect, it } from "vitest";
import type { DiagramBody, DiagramEdge, DiagramNode } from "@codebase-tutor/shared/wire";
import {
  DEFAULT_VIEW,
  EDGE_ORIGINS,
  NODE_H,
  NODE_W,
  ORIGIN_SHORT,
  WORLD_MIN_H,
  WORLD_MIN_W,
  ZOOM_MAX,
  ZOOM_MIN,
  boundsOf,
  boxOf,
  edgePoints,
  fitView,
  notePreview,
  relativeTime,
  safeFileName,
  subLineOf,
  versionTime,
  worldSizeOf,
  zoomAt,
  type NodeBoxes
} from "./diagramView";

/**
  画布几何与读数口径都是纯函数。
  拖动与渲染的时序要真浏览器才能验，这里锁的是判据本身。
 */

const node = (id: string, x: number, y: number, kind: DiagramNode["kind"] = "module", sub?: string): DiagramNode => ({ id, kind, label: id, x, y, ...(sub === undefined ? {} : { sub }), ref: kind === "module" ? id : undefined });
const body = (nodes: DiagramNode[], edges: DiagramEdge[] = [], groups: DiagramBody["groups"] = []): DiagramBody => ({ nodes, edges, groups });
const edge = (from: string, to: string): DiagramEdge => ({ id: `${from}->${to}`, from, to, origin: "static" });
const boxes = (entries: [string, { w: number; h: number }][]): NodeBoxes => new Map(entries);

describe("节点盒子的兜底", () => {
  it("量不到（首帧）用定宽与兜底高，量到了就用量到的", () => {
    expect(boxOf(new Map(), "a")).toEqual({ w: NODE_W, h: NODE_H });
    expect(boxOf(boxes([["a", { w: 300, h: 90 }]]), "a")).toEqual({ w: 300, h: 90 });
  });

  it("边画在两端节点的中心；长标签的节点按量到的高度算中心", () => {
    const diagram = body([node("a", 0, 0), node("b", 400, 200)]);
    expect(edgePoints(diagram, edge("a", "b"), boxes([["a", { w: 200, h: 100 }], ["b", { w: 100, h: 50 }]]))).toEqual({ x1: 100, y1: 50, x2: 450, y2: 225 });
  });

  it("端点缺一律不画：agent 刚删掉那个节点时不画到空气里", () => {
    const diagram = body([node("a", 0, 0)]);
    expect(edgePoints(diagram, edge("a", "gone"), new Map())).toBeNull();
    expect(edgePoints(diagram, edge("gone", "a"), new Map())).toBeNull();
  });
});

describe("包围盒与世界层", () => {
  it("空图没有包围盒，也没有世界层（调用方因此能退回默认视野）", () => {
    expect(boundsOf(body([]), new Map())).toBeNull();
    expect(worldSizeOf(body([]), new Map())).toEqual({ w: WORLD_MIN_W, h: WORLD_MIN_H });
  });

  it("分组框算进包围盒——它没有节点，但它是内容", () => {
    const diagram = body([], [], [{ id: "g", label: "服务", x: 10, y: 20, w: 500, h: 300 }]);
    expect(boundsOf(diagram, new Map())).toEqual({ minX: 10, minY: 20, maxX: 510, maxY: 320 });
  });

  it("节点往右下拖多远，世界层就长多大（左侧不扩：世界坐标没有负的那一侧）", () => {
    const size = worldSizeOf(body([node("a", 5000, 3000)]), boxes([["a", { w: NODE_W, h: NODE_H }]]));
    expect(size.w).toBeGreaterThanOrEqual(5000 + NODE_W);
    expect(size.h).toBeGreaterThanOrEqual(3000 + NODE_H);
    expect(worldSizeOf(body([node("a", -800, -900)]), new Map())).toEqual({ w: WORLD_MIN_W, h: WORLD_MIN_H });
  });
});

describe("视野：适应与锚点缩放", () => {
  it("没有视口尺寸时不动视野（首帧量不到容器，不该乱缩放）", () => {
    expect(fitView(body([node("a", 0, 0)]), new Map(), { w: 0, h: 0 })).toEqual(DEFAULT_VIEW);
    expect(fitView(body([]), new Map(), { w: 800, h: 600 })).toEqual(DEFAULT_VIEW);
  });

  it("三五个节点的小图不撑满整屏：适应缩放有上限", () => {
    const view = fitView(body([node("a", 0, 0), node("b", 200, 100)]), new Map(), { w: 1600, h: 1200 });
    expect(view.z).toBeLessThanOrEqual(1.2);
    expect(view.z).toBeGreaterThanOrEqual(ZOOM_MIN);
  });

  it("远处的内容能被缩到看得见：缩放夹在 [ZOOM_MIN, ZOOM_MAX] 内", () => {
    const view = fitView(body([node("a", 0, 0), node("b", 6000, 4000)]), new Map(), { w: 1000, h: 800 });
    expect(view.z).toBe(ZOOM_MIN);
  });

  it("以视口内那点为锚缩放：那点下面的世界坐标在缩放前后不动", () => {
    const view = { x: -120, y: -60, z: 1 };
    const anchor = { x: 300, y: 200 };
    const worldBefore = { x: (anchor.x - view.x) / view.z, y: (anchor.y - view.y) / view.z };
    const next = zoomAt(view, anchor, 1.5);
    expect(next.z).toBe(1.5);
    expect({ x: (anchor.x - next.x) / next.z, y: (anchor.y - next.y) / next.z }).toEqual(worldBefore);
  });

  it("已经夹到边界就原样交出同一个对象：不产生无意义的新视野", () => {
    const atMax = { x: 0, y: 0, z: ZOOM_MAX };
    expect(zoomAt(atMax, { x: 10, y: 10 }, 2)).toBe(atMax);
    const atMin = { x: 0, y: 0, z: ZOOM_MIN };
    expect(zoomAt(atMin, { x: 10, y: 10 }, 0.5)).toBe(atMin);
  });
});

describe("读数不许编", () => {
  it("坏时间串原样显示，不编一个时刻出来", () => {
    expect(relativeTime("刚刚还好好的")).toBe("刚刚还好好的");
    expect(versionTime("not-a-date")).toBe("not-a-date");
  });

  it("1 分钟内叫「刚刚」，之后按分/时/天递进，满 7 天换成绝对时间", () => {
    const at = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
    expect(relativeTime(at(20_000))).toBe("刚刚");
    expect(relativeTime(at(5 * 60_000))).toBe("5 分钟前");
    expect(relativeTime(at(3 * 3_600_000))).toBe("3 小时前");
    expect(relativeTime(at(2 * 86_400_000))).toBe("2 天前");
    expect(versionTime(at(30 * 86_400_000))).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(relativeTime(at(30 * 86_400_000))).toBe(versionTime(at(30 * 86_400_000)));
  });

  it("图名里全是不能当文件名的字符时退回 diagram，不交出一个空文件名", () => {
    expect(safeFileName("  ???  ")).toBe("diagram");
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j k')).toBe("a-b-c-d-e-f-g-h-i-j-k");
  });

  it("模块节点没有角色小字就什么都不补；便签才补「便签」", () => {
    expect(subLineOf(node("m", 0, 0, "module"))).toBe("");
    expect(subLineOf(node("m", 0, 0, "module", "核心"))).toBe("核心");
    expect(subLineOf({ id: "n", kind: "note", label: "n", x: 0, y: 0, text: "正文" })).toBe("便签");
  });

  it("便签正文只露一行里的这么多字，多余的交给抽屉", () => {
    const preview = notePreview("  第一行\n  第二行   尾   ");
    expect(preview).toBe("第一行 第二行 尾");
    const long = notePreview(`${"字".repeat(50)}`);
    expect(long.length).toBe(43);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("边级可信度的说法只有一份", () => {
  it("词表与三档枚举对齐：新增一档而这里没补措辞就红", () => {
    expect(EDGE_ORIGINS).toEqual(Object.keys(ORIGIN_SHORT));
    for (const origin of EDGE_ORIGINS) expect(ORIGIN_SHORT[origin].length).toBeGreaterThan(0);
  });
});
