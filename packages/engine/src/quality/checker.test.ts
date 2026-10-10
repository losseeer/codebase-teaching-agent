import { describe, expect, it } from "vitest";
import type { ImplementationUnit } from "@codebase-tutor/shared";
import { verifyAnalysis } from "./checker.js";
import { makeSymbol } from "../test-utils.js";

function unit(path: string, name: string): ImplementationUnit {
  const symbol = makeSymbol(path, name, { line: 1, endLine: 3, language: "typescript" });
  return { id: `implementation:${symbol.id}`, symbol, summary: `${name} 的实现细节。`, inputs: [], output: "无", invariants: [], boundaries: [], traps: [], verification: [] };
}

describe("quality checker", () => {
  it("marks verification as skipped after a timeout signal", () => {
    const report = verifyAnalysis("/not-read", [], { id: "root", title: "root", summary: "summary", kind: "overview", anchors: [], children: [] }, { forceTimeout: true });
    expect(report.skippedBecause).toContain("超时");
    expect(report.micro).toHaveLength(0);
  });

  it("文件读不出来时给「待确认」而不是抛：校验跑在导入中途", () => {
    const report = verifyAnalysis("/definitely-not-read-here", [unit("src/gone.ts", "vanished")], { id: "root", title: "root", summary: "summary", kind: "overview", anchors: [], children: [] });
    expect(report.micro[0]).toMatchObject({ status: "needs_review", reason: "定义所在文件读不出来。" });
  });

  it("samples approximately twenty percent of macro nodes deterministically", () => {
    const root = { id: "root", title: "root", summary: "summary", kind: "overview" as const, anchors: [], children: Array.from({ length: 9 }, (_, index) => ({ id: `node-${index}`, title: "node", summary: "summary", kind: "module" as const, anchors: [], children: [] })) };
    const report = verifyAnalysis("/not-read", [], root);
    expect(report.macro).toHaveLength(2);
  });
});
