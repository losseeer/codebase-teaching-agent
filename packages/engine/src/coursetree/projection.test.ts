import { describe, expect, it } from "vitest";
import type { CourseTree, RepositoryIndex } from "@codebase-tutor/shared";
import { courseChildren, courseOverview } from "./projection.js";

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
});
