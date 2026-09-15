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

  it("仓内 fixture/demo 目录不作为执行路径入口", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [
        { path: "src/main.ts", extension: ".ts", bytes: 30, lines: 2 },
        { path: "test-fixtures/frozen-demo-repo/src/main.js", extension: ".js", bytes: 30, lines: 2 }
      ],
      summaries: [{ path: "src/main.ts", summary: "应用入口。", cached: false }],
      graph: {
        imports: new Map([["src/main.ts", ["test-fixtures/frozen-demo-repo/src/main.js"]]]),
        calls: [],
        symbols: [],
        semanticBackend: "static",
        lspStatus: [],
        entrypoints: [
          { path: "src/main.ts", line: 1, label: "script: dev" },
          { path: "test-fixtures/frozen-demo-repo/src/main.js", line: 1, label: "script: start" }
        ]
      }
    });
    const workflowPaths = tree.root.children[0].children.map((node) => node.anchors[0]?.path);
    expect(workflowPaths).toEqual(["src/main.ts"]); // fixture 入口被过滤，真实入口保留
    // fixture 文件仍作为依赖子节点出现（它是被 import 的对象，只是不当入口讲）
    expect(tree.root.children[0].children[0].children.some((child) => child.title.includes("frozen-demo-repo"))).toBe(true);
  });
});
