import { describe, expect, it } from "vitest";
import type { CourseNode, CourseTree, RepositoryIndex } from "@codebase-tutor/shared";
import { annotateModuleTiers, courseChildren, courseOverview } from "./projection.js";

const tree: CourseTree = {
  repositoryId: "repo_test",
  modelVersion: "fixture-v1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  root: {
    id: "overview",
    title: "代码库全景",
    kind: "overview",
    summary: "overview",
    anchors: [],
    children: [{
      id: "modules",
      title: "模块地图",
      kind: "overview",
      summary: "modules",
      anchors: [],
      children: Array.from({ length: 35 }, (_, index) => ({ id: `module:${index}`, title: `模块 ${index}`, kind: "module" as const, summary: "module", anchors: [], children: [] }))
    }]
  }
};

const index: RepositoryIndex = {
  repositoryId: "repo_test",
  repositoryPath: "/repo",
  scannedAt: "2026-01-01T00:00:00.000Z",
  totalFiles: 5000,
  totalLines: 250000,
  files: [],
  fileTree: [],
  hotspots: [{ path: "src/main.ts", changes: 12 }]
};

describe("course projections", () => {
  it("keeps the overview shallow and pages descendants", () => {
    const overview = courseOverview(tree, index);
    expect(overview.root.children).toHaveLength(1);
    expect(overview.root.children[0]).toMatchObject({ id: "modules", childCount: 35, children: [] });

    const firstPage = courseChildren(tree, "modules", 0, 30)!;
    expect(firstPage).toMatchObject({ total: 35, offset: 0, nextOffset: 30 });
    expect(firstPage.items).toHaveLength(30);
    const secondPage = courseChildren(tree, "modules", firstPage.nextOffset!, 30)!;
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.nextOffset).toBeUndefined();
  });

  it("tiers modules by the structural roles of their visible files", () => {
    const node = (id: string, paths: string[], children: CourseNode[] = []): CourseNode => ({
      id, title: id, kind: "module", summary: "", anchors: paths.map((path) => ({ path, line: 1, label: path })), children
    });
    const branches: CourseTree = {
      ...tree,
      root: {
        ...tree.root,
        children: [
          { id: "workflows", title: "执行路径", kind: "overview", summary: "", anchors: [], children: [node("flow:1", ["src/App.java"])] },
          { id: "modules", title: "模块地图", kind: "overview", summary: "", anchors: [], children: [
            node("module:a", ["src/App.java"]),
            node("module:b", ["src/config/RedisConfig.java"]),
            node("module:c", ["src/service/OrderService.java"]),
            node("module:d", ["grafana/dashboards/board.json", "README.md"]),
            node("module:e", ["docs/design.md"], [node("module:e/impl", ["src/App.java"])]),
            node("module:f", [])
          ] }
        ]
      }
    };
    const roles = new Map([
      ["src/App.java", "core" as const],
      ["src/config/RedisConfig.java", "infra" as const],
      ["src/service/OrderService.java", "support" as const],
      ["grafana/dashboards/board.json", "tool" as const],
      ["README.md", "tool" as const],
      ["docs/design.md", "tool" as const]
    ]);
    const tiered = annotateModuleTiers(branches, roles);
    const modules = tiered.root.children.find((item) => item.id === "modules")!;
    expect(modules.children.map((item) => `${item.id}=${item.tier}`)).toEqual([
      "module:a=core",
      "module:b=facility",
      "module:c=facility",
      "module:d=periphery",
      // 子孙里有一个主干文件就抬成主干：模块挂在 docs 目录名下不代表它没有代码锚点
      "module:e=core",
      "module:f=periphery"
    ]);
    // 只动 modules 分支：流程节点不该被挂上 tier，也不该被复制成新对象
    expect(tiered.root.children[0]).toBe(branches.root.children[0]);
    const branchless: CourseTree = { ...tree, root: { ...tree.root, children: [branches.root.children[0]!] } };
    expect(annotateModuleTiers(branchless, roles)).toBe(branchless);
  });
});
