import { describe, expect, it } from "vitest";
import type { CourseNode, ImplementationUnit } from "@codebase-tutor/shared";
import { buildCourseTree, groupImplementationsByModule } from "./build.js";

function unit(path: string, name: string): ImplementationUnit {
  const line = 3;
  return {
    id: `symbol:${path}:${name}:${line}`,
    symbol: { id: `symbol:${path}:${name}:${line}`, name, kind: "function", path, line, endLine: 8, parameters: [], language: "typescript" },
    summary: `${name} 的实现细节。`,
    inputs: [], output: "无", invariants: [], boundaries: [], traps: [], verification: []
  };
}

function microOf(tree: ReturnType<typeof buildCourseTree>): CourseNode {
  return tree.root.children.find((node) => node.id === "micro")!;
}

describe("course tree", () => {
  it("binds generated workflow lessons to source anchors", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [{ path: "src/main.ts", extension: ".ts", bytes: 30, lines: 2 }],
      summaries: [{ path: "src/main.ts", summary: "应用入口。", role: "core", roleSource: "structure", coverage: { checked: 0, mentioned: 0, low: false }, cached: false }],
      graph: { imports: new Map([["src/main.ts", []]]), calls: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [{ path: "src/main.ts", line: 1, label: "script: dev" }], parseBackend: "regex" }
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
      summaries: [{ path: "src/main.ts", summary: "应用入口。", role: "core", roleSource: "structure", coverage: { checked: 0, mentioned: 0, low: false }, cached: false }],
      graph: {
        imports: new Map([["src/main.ts", ["test-fixtures/frozen-demo-repo/src/main.js"]]]),
        calls: [],
        symbols: [],
        semanticBackend: "static",
        lspStatus: [],
        entrypoints: [
          { path: "src/main.ts", line: 1, label: "script: dev" },
          { path: "test-fixtures/frozen-demo-repo/src/main.js", line: 1, label: "script: start" }
        ],
        parseBackend: "regex"
      }
    });
    const workflowPaths = tree.root.children[0].children.map((node) => node.anchors[0]?.path);
    expect(workflowPaths).toEqual(["src/main.ts"]); // fixture 入口被过滤，真实入口保留
    // fixture 文件仍作为依赖子节点出现（它是被 import 的对象，只是不当入口讲）
    expect(tree.root.children[0].children[0].children.some((child) => child.title.includes("frozen-demo-repo"))).toBe(true);
  });

  it("没有入口的仓库（库/轮子）明示事实，不拿首个文件伪造假入口", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [{ path: "src/lib.ts", extension: ".ts", bytes: 30, lines: 2 }],
      summaries: [{ path: "src/lib.ts", summary: "工具函数。", role: "tool", roleSource: "structure", coverage: { checked: 0, mentioned: 0, low: false }, cached: false }],
      graph: { imports: new Map([["src/lib.ts", []]]), calls: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [], parseBackend: "regex" }
    });
    const workflows = tree.root.children[0];
    expect(workflows.children).toHaveLength(1);
    expect(workflows.children[0].id).toBe("workflow:no-entry");
    expect(workflows.children[0].anchors).toEqual([]); // 无锚点 → 不进推荐入口候选池
    expect(tree.root.summary).toContain("未检测到可执行入口");
  });

  it("微观节点按锚点目录归组回模块，重复执行是幂等的", () => {
    const tree = buildCourseTree({
      repositoryId: "repo_test",
      modelVersion: "fixture-v1",
      files: [
        { path: "src/main.ts", extension: ".ts", bytes: 30, lines: 10 },
        { path: "src/db/store.ts", extension: ".ts", bytes: 30, lines: 10 }
      ],
      summaries: [],
      graph: { imports: new Map(), calls: [], symbols: [], semanticBackend: "static", lspStatus: [], entrypoints: [{ path: "src/main.ts", line: 1, label: "script: dev" }], parseBackend: "regex" },
      implementations: [unit("src/main.ts", "boot"), unit("src/db/store.ts", "load"), unit("src/db/store.ts", "save")]
    });
    expect(microOf(tree).children).toHaveLength(3); // 归组前：三条平行清单
    const grouped = groupImplementationsByModule(tree);
    expect(microOf(grouped).children).toEqual([]);
    expect(microOf(grouped).summary).toContain("已按其所在目录归入");
    const modules = grouped.root.children.find((node) => node.id === "modules")!;
    const mainModule = modules.children.find((node) => node.id === "module:src")!;
    const dbModule = modules.children.find((node) => node.id === "module:src/db")!;
    expect(mainModule.children.map((node) => node.id)).toEqual(["symbol:src/main.ts:boot:3"]);
    expect(dbModule.children.map((node) => node.id)).toEqual(["symbol:src/db/store.ts:load:3", "symbol:src/db/store.ts:save:3"]);
    expect(groupImplementationsByModule(grouped)).toBe(grouped); // 幂等：对已归组的树原样返回
  });
});
