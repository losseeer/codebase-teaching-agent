import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SymbolInfo } from "@codebase-tutor/domain";

import { classifyFileRoles, type FileStructure } from "@codebase-tutor/analysis";
import { TutorDatabase } from "../adapter/outbound/persistence/database.js";
import type { SummaryStore } from "../application/port/summary-store.js";
import { readJournal } from "../adapter/outbound/persistence/journal.js";
import { LocalSummaryProvider, SUMMARY_BATCH_SIZE, type SummaryProvider } from "./summary-provider.js";
import {
  buildFileSlices,
  extractHeaderComment,
  MAX_HEADER_COMMENT_CHARS,
  MAX_SLICE_ENTRIES,
  type FileSlice
} from "@codebase-tutor/analysis";
import { summarizeFiles, summaryCacheKey } from "./summarizer.js";
import { makeSymbol } from "../test-utils.js";

/** main.py → svc.py（调用 run）→ util.py；business.py 只依赖 util.py。 */
const STRUCTURE: FileStructure = {
  files: [{ path: "main.py", lines: 10 }, { path: "svc.py", lines: 20 }, { path: "util.py", lines: 6 }, { path: "business.py", lines: 4 }],
  symbols: [
    makeSymbol("main.py", "main", { line: 1, endLine: 3, language: "python" }),
    makeSymbol("svc.py", "run", { line: 1, endLine: 9, parameters: ["x"], language: "python" }),
    makeSymbol("svc.py", "Helper", { line: 12, endLine: 18, kind: "class", language: "python" })
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
  it("摘要流水线换个存储也跑得通：内存 Map 假件能吃下首次计算与命中两条分支", async () => {
    const rows = new Map<string, string>();
    const store: SummaryStore = {
      get<T extends { path: string; summary: string }>(cacheKey: string): T | undefined {
        return rows.has(cacheKey) ? JSON.parse(rows.get(cacheKey)!) as T : undefined;
      },
      put(cacheKey: string, value: { path: string; summary: string }): void { rows.set(cacheKey, JSON.stringify(value)); },
      latest() { return [...rows.values()].map((row) => JSON.parse(row) as { path: string; summary: string }); }
    };
    const provider = new LocalSummaryProvider();
    const first = await summarizeFiles({ structure: STRUCTURE, store, repositoryPath: mkdtempSync(join(tmpdir(), "summarize-port-")), provider });
    expect(first.summaries).toHaveLength(STRUCTURE.files.length);
    expect(rows.size, "落库走的是这个口").toBeGreaterThanOrEqual(STRUCTURE.files.length);
    const second = await summarizeFiles({ structure: STRUCTURE, store, repositoryPath: "unused", provider });
    expect(second.estimate.cachedFiles, "命中判据也来自同一个口").toBe(STRUCTURE.files.length);
  });

  it("逐批回报进度：批次之间在动，全命中的那轮也立刻报满", async () => {
    const database = tempDatabase();
    const totalFiles = SUMMARY_BATCH_SIZE + 2;
    const many: FileStructure = {
      files: Array.from({ length: totalFiles }, (_, index) => ({ path: `f${index}.py`, lines: 10 })),
      symbols: Array.from({ length: totalFiles }, (_, index) => makeSymbol(`f${index}.py`, `fn${index}`, { line: 1, endLine: 3, language: "python" })),
      calls: [],
      imports: {},
      entrypoints: []
    };
    const provider = new LocalSummaryProvider();
    const seen: [number, number][] = [];
    await summarizeFiles({ structure: many, store: database.summaries, repositoryPath: database.repositoryPath, provider, onProgress: (done, total) => { seen.push([done, total]); } });
    expect(seen.map(([done]) => done)).toEqual([0, SUMMARY_BATCH_SIZE, totalFiles]);
    expect(new Set(seen.map(([, total]) => total)).size, "一次运行里总数不能变").toBe(1);

    const again: number[] = [];
    await summarizeFiles({ structure: many, store: database.summaries, repositoryPath: database.repositoryPath, provider, onProgress: (done) => { again.push(done); } });
    expect(again, "全命中时一条也不发模型，但仍要报一次，否则进度停在起点就是假卡住").toEqual([totalFiles]);
  });

  it("产出摘要 + 结构角色 + 覆盖率，并落库；重复调用全命中缓存", async () => {
    const database = tempDatabase();
    const provider = new LocalSummaryProvider();
    const first = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(first.summaries.map((summary) => summary.path)).toEqual(["business.py", "main.py", "svc.py", "util.py"]);
    const main = first.summaries.find((summary) => summary.path === "main.py")!;
    expect(main.role).toBe("core");
    expect(main.roleSource).toBe("structure");
    expect(main.coverage).toEqual({ checked: 1, mentioned: 1, low: false, rule: "anchor-v2" });
    expect(main.cached).toBe(false);
    expect(main.summary).toBe("main.py：执行主干；定义 main");

    const second = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(second.estimate).toMatchObject({ cachedFiles: 4, summarizedFiles: 0 });
    expect(second.summaries.every((summary) => summary.cached)).toBe(true);
    expect(second.summaries.find((summary) => summary.path === "main.py")).toEqual({ ...main, cached: true });
  });

  it("模型给的角色覆盖结构结论，并把来源标成 provider；摘要不提符号则判低覆盖", async () => {
    const database = tempDatabase();
    const provider: SummaryProvider = {
      sendsCodeToEndpoint: true,
      name: "stub",
      modelVersion: "stub-1",
      summarizeMany: async (slices) => slices.map((slice) => ({ summary: `${slice.path} 负责一些事情。`, role: "infra" as const }))
    };
    const { summaries } = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    const main = summaries.find((summary) => summary.path === "main.py")!;
    expect(main.role).toBe("infra");
    expect(main.roleSource).toBe("provider");
    expect(main.coverage).toEqual({ checked: 1, mentioned: 0, low: true, rule: "anchor-v2" });
  });

  it("输入的切片变了（依赖或符号变）缓存即失效，不必再单独追踪文件内容", async () => {
    const database = tempDatabase();
    const provider = new LocalSummaryProvider();
    await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    const changed: FileStructure = { ...STRUCTURE, imports: { ...STRUCTURE.imports, "main.py": ["svc.py", "business.py"] } };
    const after = await summarizeFiles({ structure: changed, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    // 切片变化影响 main.py 与 business.py 两条
    expect(after.estimate.summarizedFiles).toBe(2);
    expect(after.estimate.cachedFiles).toBe(2);
  });

  it("估算口径是切片字符数，不是整份正文", async () => {
    const database = tempDatabase();
    const { estimate } = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider: new LocalSummaryProvider() });
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedInputTokens).toBeLessThan(200);
  });

  it("没有符号的文件也能给出切片（空条目、角色仍按结构判）", async () => {
    const database = tempDatabase();
    const structure: FileStructure = { ...STRUCTURE, files: [{ path: "empty.py", lines: 1 }], symbols: [], calls: [], imports: {}, entrypoints: [] };
    const { summaries } = await summarizeFiles({ structure, store: database.summaries, repositoryPath: database.repositoryPath, provider: new LocalSummaryProvider() });
    expect(summaries[0]).toMatchObject({ path: "empty.py", role: "tool", coverage: { checked: 0, mentioned: 0, low: false } });
  });

  it("批量调用：按批次切片，模型漏掉的条目用确定性档补齐并计入 fallbackFiles", async () => {
    const database = tempDatabase();
    const batches: number[] = [];
    const provider: SummaryProvider = {
      sendsCodeToEndpoint: true,
      name: "stub",
      modelVersion: "stub-1",
      summarizeMany: async (slices) => {
        batches.push(slices.length);
        return slices.map((slice, index) => index === 0 ? { summary: `${slice.path} 负责入口。`, role: "core" as const } : undefined);
      }
    };
    const { summaries, estimate } = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(batches).toEqual([4]);
    expect(estimate).toMatchObject({ summarizedFiles: 4, fallbackFiles: 3, provider: "stub" });
    // business.py 按路径序排在首位
    expect(summaries[0].roleSource).toBe("provider");
    expect(summaries.slice(1).every((summary) => summary.roleSource === "structure")).toBe(true);
    expect(summaries.every((summary) => summary.summary.length > 0)).toBe(true);
  });

  it("整批抛错不掀掉导入：这一批逐条走确定性补齐，并计入 fallbackFiles", async () => {
    const database = tempDatabase();
    const provider: SummaryProvider = {
      sendsCodeToEndpoint: true,
      name: "stub",
      modelVersion: "stub-throw",
      summarizeMany: async () => { throw new Error("端点 429"); }
    };
    const { summaries, estimate } = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(estimate).toMatchObject({ summarizedFiles: 4, fallbackFiles: 4 });
    expect(summaries.every((summary) => summary.summary.length > 0)).toBe(true);
  });

  it("兜底文本不写模型档的缓存键：下次同输入仍会重试模型，不拿结构文本伪装成 LLM 摘要", async () => {
    const database = tempDatabase();
    const partial: SummaryProvider = {
      sendsCodeToEndpoint: true,
      name: "stub",
      modelVersion: "stub-1",
      summarizeMany: async (slices) => slices.map((slice, index) => index === 0 ? { summary: `${slice.path} 负责入口。` } : undefined)
    };
    await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider: partial });
    const calls: number[] = [];
    const second: SummaryProvider = {
      sendsCodeToEndpoint: true,
      name: "stub",
      modelVersion: "stub-1",
      summarizeMany: async (slices) => { calls.push(slices.length); return slices.map((slice) => ({ summary: `${slice.path} 模型重写。` })); }
    };
    const again = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider: second });
    expect(again.estimate.fallbackFiles).toBe(0);
    // 上次未拿到模型结果的三条这次重新发送
    expect(calls).toEqual([3]);
    expect(again.summaries.map((item) => item.summary)).toContain("svc.py 模型重写。");
  });

  it("超过批次上限时分多次调用", async () => {
    const database = tempDatabase();
    const batches: number[] = [];
    const provider: SummaryProvider = {
      sendsCodeToEndpoint: true,
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
    await summarizeFiles({ structure, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(batches).toEqual([8, 2]);
  });
});

/** 单文件结构夹具：符号按给定名字的声明序生成。 */
function singleFileStructure(names: string[]): FileStructure {
  return {
    files: [{ path: "src/billing.ts", lines: 10 }],
    symbols: names.map((name, index) => ({
      id: `symbol:src/billing.ts:${name}:${index + 1}`,
      name,
      kind: "function" as const,
      path: "src/billing.ts",
      line: index + 1,
      endLine: index + 2,
      parameters: [],
      language: "typescript"
    })),
    calls: [],
    imports: {},
    entrypoints: []
  };
}

describe("覆盖率判据（anchor-v2：特征词锚定 + any-of）", () => {
  async function coverageFor(names: string[], summary: string) {
    const database = tempDatabase();
    const provider: SummaryProvider = { sendsCodeToEndpoint: true, name: "stub", modelVersion: "stub-1", summarizeMany: async () => [{ summary }] };
    const { summaries } = await summarizeFiles({ structure: singleFileStructure(names), store: database.summaries, repositoryPath: database.repositoryPath, provider });
    return summaries[0].coverage;
  }

  it("中文行为描述里出现英文特征词即算锚上——整名对不上不该算成假低覆盖", async () => {
    expect(await coverageFor(["RedisTemplate"], "负责 redis 连接池维护与断线重连。"))
      .toEqual({ checked: 1, mentioned: 1, low: false, rule: "anchor-v2" });
  });

  it("结构词不算锚：摘要通篇只说「service」，等于没提任何符号", async () => {
    expect(await coverageFor(["UserService"], "通用的 Service 层封装。"))
      .toEqual({ checked: 1, mentioned: 0, low: true, rule: "anchor-v2" });
  });

  it("前 3 条里锚上任一条就不算低（any-of 取代过半）", async () => {
    expect(await coverageFor(["PaymentGateway", "notifyConfig", "index"], "负责 payment 通道的对账与金额核算，不涉及通知发送与配置下发。"))
      .toEqual({ checked: 3, mentioned: 1, low: false, rule: "anchor-v2" });
  });

  it("路径不参与比对：含糊摘要不能靠路径里的符号名算命中", async () => {
    expect(await coverageFor(["billing"], "src/billing.ts：负责一些事情。"))
      .toEqual({ checked: 1, mentioned: 0, low: true, rule: "anchor-v2" });
  });

  it("命中旧判据写的存量行：就地重算并回写，不重新调用任何摘要档", async () => {
    const database = tempDatabase();
    const provider = new LocalSummaryProvider();
    const slice = buildFileSlices(STRUCTURE, classifyFileRoles(STRUCTURE)).get("svc.py")!;
    // coverage 不带 rule 字段的存量记录
    const legacyRow = {
      path: "svc.py",
      summary: "svc.py：支撑逻辑；定义 run、Helper 等 2 个符号",
      role: "support",
      roleSource: "structure",
      coverage: { checked: 2, mentioned: 0, low: true }
    };
    database.summaries.put(summaryCacheKey(slice, provider.modelVersion, false), legacyRow);
    const { summaries, estimate } = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    const svc = summaries.find((summary) => summary.path === "svc.py")!;
    // 本地生成的摘要以符号名开头
    expect(svc.coverage).toEqual({ checked: 2, mentioned: 2, low: false, rule: "anchor-v2" });
    expect(svc.cached).toBe(true);
    expect(estimate).toMatchObject({ cachedFiles: 1, summarizedFiles: 3 });
    expect(database.summaries.get<{ path: string; summary: string; coverage?: { rule?: string } }>(summaryCacheKey(slice, provider.modelVersion, false))?.coverage?.rule).toBe("anchor-v2");
    const second = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(second.estimate).toMatchObject({ cachedFiles: 4, summarizedFiles: 0 });
  });
});

describe("extractHeaderComment（「摘要参考注释」开时取文件首段正经注释）", () => {
  it("Java：跳过 license 块注释，取类 Javadoc，并剔除 @author/@version 标签行", () => {
    const text = [
      "/*",
      " * Copyright 2020 example.com. All rights reserved.",
      " */",
      "package com.example;",
      "/**",
      " * 库存扣减服务：处理秒杀场景下的并发扣减与回滚。",
      " * @author tom",
      " * @version 1.0",
      " */",
      "public class StockService {}"
    ].join("\n");
    expect(extractHeaderComment("StockService.java", text)).toBe("库存扣减服务：处理秒杀场景下的并发扣减与回滚。");
  });

  it("纯标签块（@author/@since）没有概念，整段跳过后无可取 ⇒ undefined", () => {
    expect(extractHeaderComment("A.java", "/**\n * @author tom\n * @since 1.0\n */\npublic class A {}")).toBeUndefined();
  });

  it("Python：模块 docstring 优先；`=` 后的三引号是字符串赋值，不算 docstring", () => {
    expect(extractHeaderComment("nodes.py", '"""意图理解节点：解析用户查询，抽取结构化意图。"""\nimport x')).toBe("意图理解节点：解析用户查询，抽取结构化意图。");
    expect(extractHeaderComment("b.py", 'TEXT = """这段三引号是赋值内容不该被当成注释摘录"""\n# 真正的模块自述在这一组注释里\ny = 1')).toBe("真正的模块自述在这一组注释里");
  });

  it("连续整行注释合并成一段；清洗后不足 8 字的碎语不算自述", () => {
    expect(extractHeaderComment("X.java", "// 分布式锁：看门狗自动续期\n// 解决误删他人锁的问题\nclass X {}")).toBe("分布式锁：看门狗自动续期 解决误删他人锁的问题");
    expect(extractHeaderComment("Y.java", "// 短\nclass Y {}")).toBeUndefined();
  });

  it("合格首段折叠空白并截断到预算字符数", () => {
    const long = "概".repeat(MAX_HEADER_COMMENT_CHARS + 40);
    expect(extractHeaderComment("Z.java", `/** ${long.slice(0, 60)}\n\n${long.slice(60)} */\nclass Z {}`)).toHaveLength(MAX_HEADER_COMMENT_CHARS);
  });

  it("无任何注释的文件 ⇒ undefined", () => {
    expect(extractHeaderComment("plain.py", "def main():\n    return 1\n")).toBeUndefined();
  });
});

describe("「摘要参考注释」开关：双档键分流与读盘附着", () => {
  /** 落一个真实 main.py：其余文件不在盘上。 */
  function tempRepoWithSource(): TutorDatabase {
    const dir = mkdtempSync(join(tmpdir(), "summarize-h-"));
    writeFileSync(join(dir, "main.py"), '# 入口装配：加载配置并启动服务\n\nimport svc\n\ndef main():\n    svc.run(1)\n');
    return new TutorDatabase(dir);
  }

  it("同一切片的开/关档键必然不同；关档键与改造前的构造逐字节同构（存量行不失效）", () => {
    const slice = buildFileSlices(STRUCTURE, classifyFileRoles(STRUCTURE)).get("main.py")!;
    expect(summaryCacheKey(slice, "m-1", true)).not.toBe(summaryCacheKey(slice, "m-1", false));
  });

  it("开档读盘附着 headerComment 进切片；盘上没有的文件静默跳过", async () => {
    const database = tempRepoWithSource();
    const captured: FileSlice[] = [];
    const spy: SummaryProvider = {
      sendsCodeToEndpoint: true,
      name: "stub",
      modelVersion: "stub-1",
      summarizeMany: async (slices) => {
        captured.push(...slices);
        return slices.map(() => ({ summary: "main 负责入口。" }));
      }
    };
    await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider: spy, withHeaderComments: true });
    const main = captured.find((slice) => slice.path === "main.py")!;
    expect(main.headerComment).toBe("入口装配：加载配置并启动服务");
    expect(captured.find((slice) => slice.path === "svc.py")!.headerComment).toBeUndefined();
  });

  it("两档各占各的键空间：互不污染，切回原档仍全量命中", async () => {
    const database = tempRepoWithSource();
    const provider = new LocalSummaryProvider();
    const off = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(off.estimate).toMatchObject({ cachedFiles: 0, summarizedFiles: 4 });
    const on = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider, withHeaderComments: true });
    expect(on.estimate).toMatchObject({ cachedFiles: 0, summarizedFiles: 4 });
    const onAgain = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider, withHeaderComments: true });
    expect(onAgain.estimate).toMatchObject({ cachedFiles: 4, summarizedFiles: 0 });
    const offAgain = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(offAgain.estimate).toMatchObject({ cachedFiles: 4, summarizedFiles: 0 });
  });
});

/** L1 的密钥隐去：只筛发出的切片与存回的摘要，缓存键不动。 */
describe("L1 的密钥隐去", () => {
  it("切片发出去前被隐去、摘要回存前也被隐去，且缓存键不受影响", async () => {
    const database = tempDatabase();
    writeFileSync(join(database.repositoryPath, "main.py"), `# 启动脚本，凭据是 sk-abcdefghijklmnop1234\nprint("hi")\n`, "utf8");
    const seen: string[] = [];
    const provider: SummaryProvider = {
      sendsCodeToEndpoint: true,
      name: "stub",
      modelVersion: "stub-secret-1",
      summarizeMany: async (slices) => {
        seen.push(JSON.stringify(slices));
        // 假件把密钥原样写进摘要
        return slices.map((slice) => ({ summary: `${slice.path} 用了 sk-abcdefghijklmnop1234 这个凭据。` }));
      }
    };
    const first = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider, withHeaderComments: true });
    const sent = seen.join("");
    expect(sent).toContain("[疑似密钥，已隐去]");
    expect(sent).not.toContain("sk-abcdefghijklmnop");
    const stored = first.summaries.find((summary) => summary.path === "main.py")!;
    expect(stored.summary).not.toContain("sk-abcdefghijklmnop");
    const second = await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider, withHeaderComments: true });
    expect(second.estimate.cachedFiles).toBe(4);
    // 隐去只发生在发出的副本上
    expect(readFileSync(join(database.repositoryPath, "main.py"), "utf8")).toContain("sk-abcdefghijklmnop1234");
  });
});

/** L1 出网清单：按文件登记实际发出的切片。 */
describe("L1 出网清单", () => {
  const modelProvider = (): SummaryProvider => ({
    sendsCodeToEndpoint: true,
    name: "stub",
    modelVersion: "stub-1",
    summarizeMany: async (slices) => slices.map((slice) => ({ summary: `${slice.path} 负责一些事情。` }))
  });
  const rowsOf = (repositoryPath: string) => readJournal(repositoryPath).filter((event) => event.type === "code_egress");

  it("真发出去的那批逐文件一条：指针与指纹齐全，切片的符号名不进审计线", async () => {
    const database = tempDatabase();
    await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider: modelProvider() });

    const rows = rowsOf(database.repositoryPath);
    expect(rows.map((row) => row.payload.path)).toEqual(["business.py", "main.py", "svc.py", "util.py"]);
    expect(rows[1]?.payload).toMatchObject({ scene: "map.summary", kind: "l1-slice", lines: "1-10" });
    expect(String(rows[0]?.payload.hash)).toMatch(/^[0-9a-f]{12}$/);
    expect(Number(rows[0]?.payload.chars)).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("main()");
  });

  it("缓存命中不再计入审计；确定性档（不发请求）一条都不记", async () => {
    const database = tempDatabase();
    const provider = modelProvider();
    await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(rowsOf(database.repositoryPath)).toHaveLength(4);
    await summarizeFiles({ structure: STRUCTURE, store: database.summaries, repositoryPath: database.repositoryPath, provider });
    expect(rowsOf(database.repositoryPath), "四个文件全命中缓存，没有新的出网").toHaveLength(4);

    const local = tempDatabase();
    await summarizeFiles({ structure: STRUCTURE, store: local.summaries, repositoryPath: local.repositoryPath, provider: new LocalSummaryProvider() });
    expect(rowsOf(local.repositoryPath)).toEqual([]);
  });
});
