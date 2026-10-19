import { describe, expect, it } from "vitest";
import type { CourseNode, CourseTree, RepositoryAnalysis } from "@codebase-tutor/shared";
import { moduleBlocks } from "./blockmap.js";

const node = (id: string, title: string, path: string, tier: CourseNode["tier"]): CourseNode => ({
  id, title, kind: "module", summary: "", tier, anchors: [{ path, line: 1, label: path }], children: []
});

const course = {
  repositoryId: "repo", modelVersion: "fixture", generatedAt: "2026-10-19T00:00:00.000Z",
  root: {
    id: "root", title: "r", summary: "s", kind: "overview", anchors: [],
    children: [{
      id: "modules", title: "模块地图", kind: "overview", summary: "s", anchors: [],
      children: [
        node("module:src/http/api", "入口", "src/http/api.ts", "core"),
        node("module:a/x/one", "一", "a/x/one.ts", "core"),
        node("module:a/x/two", "二", "a/x/two.ts", "facility"),
        node("module:a/x/three", "三", "a/x/three.ts", "core"),
        node("module:a/y/tool", "工具", "a/y/tool.ts", "periphery"),
        node("module:z/ghost", "孤岛", "z/ghost.ts", "periphery")
      ]
    }]
  }
} as unknown as CourseTree;

const analysis = {
  repositoryId: "repo", generatedAt: "2026-10-19T00:00:00.000Z", versionStamp: "v",
  graph: {
    imports: {
      "src/http/api.ts": ["a/x/one.ts"],
      "a/x/one.ts": ["a/x/two.ts"],
      "a/x/two.ts": ["a/x/three.ts"],
      "a/x/three.ts": ["a/y/tool.ts"],
      "a/y/tool.ts": []
    },
    calls: [], dispatch: [], symbols: [],
    entrypoints: [{ path: "src/http/api.ts", line: 1, label: "HTTP 路由" }],
    semanticBackend: "static", lspStatus: []
  },
  implementations: []
} as unknown as RepositoryAnalysis;

describe("moduleBlocks", () => {
  it("孤立节点不画、同父同角色的小模块合成一块，角色与档位仍按结构算", () => {
    const { blocks, sideModules } = moduleBlocks(course, analysis);
    expect(sideModules, "没人引用、入口也走不到：这个节点整个不画，但读数留着").toBe(1);
    expect(blocks.map((block) => block.id)).toEqual(["module:src/http/api", "arch:a/x:core", "module:a/y/tool"]);
    const merged = blocks.find((block) => block.id === "arch:a/x:core")!;
    expect(merged.title).toBe("一、二、三");
    expect(merged.members).toEqual(["module:a/x/one", "module:a/x/two", "module:a/x/three"]);
    expect(merged.role).toBe("core");
    expect(merged.tier, "成员里二只是设施，整块取最高的 core").toBe("core");
  });
});
