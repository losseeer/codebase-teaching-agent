/** 未布局图的自动排版：只在坐标高度重复时动手。 */
import { describe, expect, it } from "vitest";
import type { DiagramBody, DiagramGroup, DiagramNode } from "@codebase-tutor/domain";

import { layoutDiagram, layoutIfUnplaced, needsLayout } from "./auto-layout.js";

const node = (id: string, group?: string): DiagramNode => ({ id, kind: "note", label: id, x: 0, y: 0, ...(group ? { group } : {}) });
const group = (id: string): DiagramGroup => ({ id, label: id, x: 0, y: 0, w: 40, h: 40 });
const body = (nodes: DiagramNode[], groups: DiagramGroup[]): DiagramBody => ({ nodes, groups, edges: [] });

describe("needsLayout", () => {
  it("整张图坐标都相同：判为未布局", () => {
    expect(needsLayout(body([node("a", "g1"), node("b", "g1"), node("c", "g2")], [group("g1"), group("g2")]))).toBe(true);
  });

  it("坐标已经分散：不动", () => {
    const placed = [{ ...node("a"), x: 100, y: 100 }, { ...node("b"), x: 320, y: 100 }, { ...node("c"), x: 540, y: 220 }];
    expect(needsLayout(body(placed, []))).toBe(false);
    expect(layoutIfUnplaced(body(placed, [])).applied).toBe(false);
  });

  it("单节点不值得排版", () => {
    expect(needsLayout(body([node("a")], []))).toBe(false);
  });
});

describe("layoutDiagram", () => {
  const groups = Array.from({ length: 7 }, (_, i) => group(`g${i}`));
  const nodes = groups.flatMap((g) => Array.from({ length: 3 }, (_, j) => node(`${g.id}-n${j}`, g.id)));
  const out = layoutDiagram(body(nodes, groups));

  it("节点坐标互不重复", () => {
    expect(new Set(out.nodes.map((item) => `${item.x},${item.y}`)).size).toBe(nodes.length);
  });

  it("分组框互不重叠", () => {
    for (let i = 0; i < out.groups.length; i += 1) {
      for (let j = i + 1; j < out.groups.length; j += 1) {
        const a = out.groups[i]!;
        const b = out.groups[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.label} 与 ${b.label} 重叠`).toBe(false);
      }
    }
  });

  it("节点落在自己那组的框里", () => {
    for (const item of out.nodes) {
      const owner = out.groups.find((g) => g.id === item.group)!;
      expect(item.x).toBeGreaterThanOrEqual(owner.x);
      expect(item.y).toBeGreaterThanOrEqual(owner.y);
      expect(item.x).toBeLessThanOrEqual(owner.x + owner.w);
      expect(item.y).toBeLessThanOrEqual(owner.y + owner.h);
    }
  });

  it("没有分组的节点排在最后，不压在组框上", () => {
    const mixed = layoutDiagram(body([node("a", "g1"), node("b")], [group("g1")]));
    const orphan = mixed.nodes.find((item) => item.id === "b")!;
    const owner = mixed.groups[0]!;
    expect(orphan.y).toBeGreaterThanOrEqual(owner.y + owner.h);
  });
});
