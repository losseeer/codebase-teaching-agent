import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SymbolInfo } from "@codebase-tutor/shared";
import { classifyFileRoles, type FileStructure } from "../depgraph/roles.js";
import { TutorDatabase } from "../store/database.js";
import { LocalSummaryProvider, type SummaryProvider } from "./provider.js";
import { buildFileSlices, MAX_SLICE_ENTRIES } from "./slice.js";
import { summarizeFiles } from "./summarizer.js";

/** main.py → svc.py（调用 run）→ util.py；另外 business.py 只依赖 util.py，不挨着入口。 */
const STRUCTURE: FileStructure = {
  files: [{ path: "main.py", lines: 10 }, { path: "svc.py", lines: 20 }, { path: "util.py", lines: 6 }, { path: "business.py", lines: 4 }],
  symbols: [
    { id: "symbol:main.py:main:1", name: "main", kind: "function", path: "main.py", line: 1, endLine: 3, parameters: [], language: "python" },
    { id: "symbol:svc.py:run:1", name: "run", kind: "function", path: "svc.py", line: 1, endLine: 9, parameters: ["x"], language: "python" },
    { id: "symbol:svc.py:Helper:12", name: "Helper", kind: "class", path: "svc.py", line: 12, endLine: 18, parameters: [], language: "python" }
  ],
  calls: [{ callerPath: "main.py", callerSymbol: "symbol:main.py:main:1", calleePath: "svc.py", calleeSymbol: "symbol:svc.py:run:1", line: 2 }],
  imports: { "main.py": ["svc.py"], "svc.py": ["util.py"], "business.py": ["util.py"] },
  entrypoints: [{ path: "main.py", line: 1, label: "入口" }]
};

function tempDatabase(): TutorDatabase {
  return new TutorDatabase(mkdtempSync(join(tmpdir(), "summarize-")));
}

describe("文件切片（L1 的输入）", () => {
  it("带排序后的符号条目、依赖方向与结构角色", () => {
    const slices = buildFileSlices(STRUCTURE, classifyFileRoles(STRUCTURE));
    expect(slices.get("main.py")).toEqual({
      path: "main.py",
      lines: 10,
      role: "core",
      entries: [{ name: "main", kind: "function", line: 1, signature: "main()" }],
      omittedSymbols: 0,
      dependsOn: ["svc.py"],
      dependedOnBy: []
    });
    // 依赖方向是双向的，且类只给名字不给参数
    expect(slices.get("svc.py")?.dependedOnBy).toEqual(["main.py"]);
    expect(slices.get("svc.py")?.dependsOn).toEqual(["util.py"]);
    expect(slices.get("svc.py")?.entries.map((entry) => entry.signature)).toEqual(["run(x)", "Helper"]);
  });

  it("超出条目预算时截断，并把被裁掉的符号数写出来", () => {
    const symbols: SymbolInfo[] = Array.from({ length: MAX_SLICE_ENTRIES + 3 }, (_, index) => ({
      id: `symbol:big.py:fn${index}:${index + 1}`,
      name: `fn${index}`,
      kind: "function",
      path: "big.py",
      line: index + 1,
      endLine: index + 2,
      parameters: [],
      language: "python"
    }));
    const structure: FileStructure = { ...STRUCTURE, files: [{ path: "big.py", lines: 40 }], symbols, calls: [], imports: {}, entrypoints: [] };
    const slice = buildFileSlices(structure, classifyFileRoles(structure)).get("big.py");
    expect(slice?.entries).toHaveLength(MAX_SLICE_ENTRIES);
    expect(slice?.omittedSymbols).toBe(3);
  });
});

describe("文件摘要表（L1）", () => {
  it("产出摘要 + 结构角色 + 覆盖率，并落库；重复调用全命中缓存", async () => {
    const database = tempDatabase();
    const provider = new LocalSummaryProvider();
    const first = await summarizeFiles({ structure: STRUCTURE, database, provider });
    expect(first.summaries.map((summary) => summary.path)).toEqual(["business.py", "main.py", "svc.py", "util.py"]);
    const main = first.summaries.find((summary) => summary.path === "main.py")!;
    expect(main.role).toBe("core");
    expect(main.roleSource).toBe("structure");
    expect(main.coverage).toEqual({ checked: 1, mentioned: 1, low: false });
    expect(main.cached).toBe(false);
    // 兜底档的摘要格式：路径 + 结构角色 + 主要符号名（简短，因为它会进课程树再被润色）
    expect(main.summary).toBe("main.py：执行主干；定义 main");

    const second = await summarizeFiles({ structure: STRUCTURE, database, provider });
    expect(second.estimate).toMatchObject({ cachedFiles: 4, summarizedFiles: 0 });
    expect(second.summaries.every((summary) => summary.cached)).toBe(true);
    // 命中的记录与第一次算出来的完全一致，只有「本次是否命中缓存」这一位不同
    expect(second.summaries.find((summary) => summary.path === "main.py")).toEqual({ ...main, cached: true });
  });

  it("模型给的角色覆盖结构结论，并把来源标成 provider；摘要不提符号则判低覆盖", async () => {
    const database = tempDatabase();
    const provider: SummaryProvider = {
      name: "stub",
      modelVersion: "stub-1",
      summarizeMany: async (slices) => slices.map((slice) => ({ summary: `${slice.path} 负责一些事情。`, role: "infra" as const }))
    };
    const { summaries } = await summarizeFiles({ structure: STRUCTURE, database, provider });
    const main = summaries.find((summary) => summary.path === "main.py")!;
    expect(main.role).toBe("infra");
    expect(main.roleSource).toBe("provider");
    // 切片里最靠前的一条是 main，摘要没提它 → 低覆盖
    expect(main.coverage).toEqual({ checked: 1, mentioned: 0, low: true });
  });

  it("输入的切片变了（依赖或符号变）缓存即失效，不必再单独追踪文件内容", async () => {
    const database = tempDatabase();
    const provider = new LocalSummaryProvider();
    await summarizeFiles({ structure: STRUCTURE, database, provider });
    const changed: FileStructure = { ...STRUCTURE, imports: { ...STRUCTURE.imports, "main.py": ["svc.py", "business.py"] } };
    const after = await summarizeFiles({ structure: changed, database, provider });
    expect(after.estimate.summarizedFiles).toBe(2); // main.py 的切片变了；business.py 的 dependedOnBy 也变了
    expect(after.estimate.cachedFiles).toBe(2);
  });

  it("估算口径是切片字符数，不是整份正文", async () => {
    const database = tempDatabase();
    const { estimate } = await summarizeFiles({ structure: STRUCTURE, database, provider: new LocalSummaryProvider() });
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedInputTokens).toBeLessThan(200);
  });

  it("没有符号的文件也能给出切片（空条目、角色仍按结构判）", async () => {
    const database = tempDatabase();
    const structure: FileStructure = { ...STRUCTURE, files: [{ path: "empty.py", lines: 1 }], symbols: [], calls: [], imports: {}, entrypoints: [] };
    const { summaries } = await summarizeFiles({ structure, database, provider: new LocalSummaryProvider() });
    expect(summaries[0]).toMatchObject({ path: "empty.py", role: "tool", coverage: { checked: 0, mentioned: 0, low: false } });
  });

  it("批量调用：按批次切片，模型漏掉的条目用确定性档补齐并计入 fallbackFiles", async () => {
    const database = tempDatabase();
    const batches: number[] = [];
    const provider: SummaryProvider = {
      name: "stub",
      modelVersion: "stub-1",
      summarizeMany: async (slices) => {
        batches.push(slices.length);
        // 只回第一条，其余留空 —— 调用方应逐条补齐，而不是丢掉整批
        return slices.map((slice, index) => index === 0 ? { summary: `${slice.path} 负责入口。`, role: "core" as const } : undefined);
      }
    };
    const { summaries, estimate } = await summarizeFiles({ structure: STRUCTURE, database, provider });
    expect(batches).toEqual([4]); // 4 个文件一次调用（上限 8）
    expect(estimate).toMatchObject({ summarizedFiles: 4, fallbackFiles: 3, provider: "stub" });
    expect(summaries[0].roleSource).toBe("provider"); // business.py 排在路径序首位，拿到了模型结果
    expect(summaries.slice(1).every((summary) => summary.roleSource === "structure")).toBe(true);
    expect(summaries.every((summary) => summary.summary.length > 0)).toBe(true);
  });

  it("超过批次上限时分多次调用", async () => {
    const database = tempDatabase();
    const batches: number[] = [];
    const provider: SummaryProvider = {
      name: "stub",
      modelVersion: "stub-1",
      summarizeMany: async (slices) => {
        batches.push(slices.length);
        return slices.map(() => undefined);
      }
    };
    const structure: FileStructure = {
      files: Array.from({ length: 10 }, (_, index) => ({ path: `f${index}.py`, lines: 1 })),
      symbols: [], calls: [], imports: {}, entrypoints: []
    };
    await summarizeFiles({ structure, database, provider });
    expect(batches).toEqual([8, 2]);
  });
});
