import { describe, expect, it } from "vitest";
import type { RepositoryAnalysis } from "@codebase-tutor/shared";
import { callNeighborhood, callNeighborhoodSection } from "./neighbors.js";

const analysis = {
  repositoryId: "repo_test",
  generatedAt: new Date().toISOString(),
  graph: {
    imports: {},
    calls: [
      { callerPath: "src/a.ts", callerSymbol: "symbol:src/a.ts:alpha:3", calleePath: "src/b.ts", calleeSymbol: "symbol:src/b.ts:beta:1", line: 4 },
      { callerPath: "src/c.ts", calleePath: "src/a.ts", calleeSymbol: "symbol:src/a.ts:alpha:3", line: 9 }
    ],
    symbols: [
      { id: "symbol:src/a.ts:alpha:3", name: "alpha", kind: "function", path: "src/a.ts", line: 3, endLine: 6, parameters: [], language: "typescript" },
      { id: "symbol:src/b.ts:beta:1", name: "beta", kind: "function", path: "src/b.ts", line: 1, endLine: 4, parameters: [], language: "typescript" }
    ],
    entrypoints: [],
    semanticBackend: "static",
    lspStatus: []
  },
  implementations: [],
  quality: {},
  versionStamp: "v1"
} as unknown as RepositoryAnalysis;

describe("callNeighborhood", () => {
  it("把调用边的符号 id 翻译成 路径:符号名，并给出同文件符号位置", () => {
    const neighborhood = callNeighborhood(analysis, "src/a.ts");
    expect(neighborhood.callsOut).toEqual(["src/b.ts:beta"]);
    expect(neighborhood.callsIn).toEqual(["src/c.ts"]); // 无 callerSymbol 时回落到文件路径
    expect(neighborhood.localSymbols).toEqual([{ name: "alpha", kind: "function", line: 3, endLine: 6 }]);
  });

  it("渲染成段落；没有调用邻接时返回空串（调用方跳过该段）", () => {
    const section = callNeighborhoodSection(analysis, "src/a.ts");
    expect(section).toContain("调用关系（src/a.ts）");
    expect(section).toContain("它调用：src/b.ts:beta");
    expect(section).toContain("调用它的：src/c.ts");
    expect(section).toContain("同文件符号位置：alpha（function）:3-6");
    expect(callNeighborhoodSection(analysis, "src/z.ts")).toBe("");
  });
});
