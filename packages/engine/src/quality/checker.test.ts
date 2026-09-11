import { describe, expect, it } from "vitest";
import { verifyAnalysis } from "./checker.js";

describe("quality checker", () => {
  it("marks verification as skipped after a timeout signal", () => {
    const report = verifyAnalysis("/not-read", [], { id: "root", title: "root", summary: "summary", kind: "overview", anchors: [], children: [] }, { forceTimeout: true });
    expect(report.skippedBecause).toContain("超时");
    expect(report.micro).toHaveLength(0);
  });

  it("samples approximately twenty percent of macro nodes deterministically", () => {
    const root = { id: "root", title: "root", summary: "summary", kind: "overview" as const, anchors: [], children: Array.from({ length: 9 }, (_, index) => ({ id: `node-${index}`, title: "node", summary: "summary", kind: "module" as const, anchors: [], children: [] })) };
    const report = verifyAnalysis("/not-read", [], root);
    expect(report.macro).toHaveLength(2);
  });
});
