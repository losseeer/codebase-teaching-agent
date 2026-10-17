import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ImplementationUnit } from "@codebase-tutor/shared";
import { verifyAnalysis } from "./checker.js";
import { makeSymbol } from "../test-utils.js";

function unit(path: string, name: string, at: { line?: number; endLine?: number } = {}): ImplementationUnit {
  const symbol = makeSymbol(path, name, { line: at.line ?? 1, endLine: at.endLine ?? (at.line ?? 1) + 2, language: "typescript" });
  return { id: `implementation:${symbol.id}`, symbol, summary: `${name} 的实现细节。`, inputs: [], output: "无", invariants: [], boundaries: [], traps: [], verification: [] };
}


function root() {
  return { id: "root", title: "root", summary: "summary", kind: "overview" as const, anchors: [], children: [] };
}


/** 校验要读真文件才知道「锚点首行有没有写出这个名字」，所以这组用一份真实临时仓。 */
const repo = mkdtempSync(join(tmpdir(), "tutor-checker-"));
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src", "ok.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n", "utf8");
// 索引记的锚点行（第 3 行）已经不是声明行了——名字仍在文件里、也仍在「区间」里，只有首行判据能抓到这种漂移
writeFileSync(join(repo, "src", "drift.ts"), "export function wrapped(): number {\n  return wrapped();\n}\n\n// 下面是别的东西\n", "utf8");
// 首行有 `adder` 但没有独立的 `add`：词子串不算声明
writeFileSync(join(repo, "src", "near.ts"), "function adder(a: number): number {\n  return a;\n}\n", "utf8");

afterAll(() => {
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  rmSync(repo, { recursive: true, force: true });
});

describe("锚点判据（#170：以前「名字出现在区间里」就被标成 verified）", () => {
  it("名字确实写在锚点首行 ⇒ verified，且 reason 说清算的是什么", () => {
    const report = verifyAnalysis(repo, [unit("src/ok.ts", "add")], root());
    expect(report.micro[0]).toMatchObject({ status: "verified" });
    expect(report.micro[0]?.reason).toContain("词边界");
  });

  it("名字只出现在体内（首行没有）⇒ 待确认：这正是行号漂移的形态，旧判据会放它过", () => {
    const report = verifyAnalysis(repo, [unit("src/drift.ts", "wrapped", { line: 3, endLine: 5 })], root());
    expect(report.micro[0]?.status).toBe("needs_review");
    expect(report.micro[0]?.reason, "reason 要说出「锚点首行」而不是含糊的「区间内」").toContain("锚点首行");
  });

  it("首行只有词的子串（adder vs add）⇒ 不算声明：词边界是这条判据的全部意义", () => {
    const report = verifyAnalysis(repo, [unit("src/near.ts", "add")], root());
    expect(report.micro[0]?.status).toBe("needs_review");
  });
});

describe("校验预算（#170：timeoutMs 以前只是装饰，只有 <1 会被读到）", () => {
  it("timeoutMs=0 现在真的生效：一条都不跑，返回「跳过」", () => {
    const report = verifyAnalysis(repo, [unit("src/ok.ts", "add")], root(), { timeoutMs: 0 });
    expect(report.micro).toHaveLength(0);
    expect(report.macro).toHaveLength(0);
    expect(report.skippedBecause).toContain("超时");
  });

  it("预算宽裕时不产生 skippedBecause（没跳过就不该有这条读数）", () => {
    const report = verifyAnalysis(repo, [unit("src/ok.ts", "add")], root(), { timeoutMs: 5_000 });
    expect(report.micro[0]?.status).toBe("verified");
    expect(report.skippedBecause).toBeUndefined();
  });
});

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
