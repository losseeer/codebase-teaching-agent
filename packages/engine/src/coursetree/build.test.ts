import { describe, expect, it } from "vitest";
import { buildCourseTree } from "./build.js";

describe("course tree", () => {
  it("binds generated workflow lessons to source anchors", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [{ path: "src/main.ts", extension: ".ts", bytes: 30, lines: 2 }],
      summaries: [{ path: "src/main.ts", summary: "应用入口。", cached: false }],
      graph: { imports: new Map([["src/main.ts", []]]), calls: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [{ path: "src/main.ts", line: 1, label: "script: dev" }] }
    });
    const workflow = tree.root.children[0].children[0];
    expect(workflow.anchors).toEqual([{ path: "src/main.ts", line: 1, label: "script: dev" }]);
    expect(tree.root.summary).toContain("入口");
  });
});
