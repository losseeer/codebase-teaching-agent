import { describe, expect, it, vi } from "vitest";
import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { addUsage, buildFlowDigest, buildRelatedPairs, clearRepositoryFlowCache, generateRepositoryFlow, generateRepositoryFlowCached, parseFlow, resolveFlowEntry, type FlowDigestSummary } from "./flow.js";
import { buildFlowEvidence, staticFlow } from "./evidence.js";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TutorDatabase } from "../store/database.js";

/**
  流程视图的服务端：LLM 生成 + 严格校验 + 缓存 + 降级。
  这里不测模型本身，只测「模型给什么都不能突破的约束」——路径必须真实、序号与回环重排一致、
  失败必须回落并显式说明原因。
  */

const ENTRY = { path: "main.py", line: 1, label: "package main" };

/** 大多数用例只关心结构与角色，不关心 L1 摘要，用空表。 */
const NO_SUMMARIES = new Map<string, FlowDigestSummary>();

function indexOf(paths: { path: string; lines: number }[]): RepositoryIndex {
  return {
    repositoryId: "repo",
    repositoryPath: "/repo",
    scannedAt: "2026-09-16T00:00:00.000Z",
    totalFiles: paths.length,
    totalLines: paths.reduce((sum, file) => sum + file.lines, 0),
    files: paths.map((file) => ({ path: file.path, extension: ".py", bytes: file.lines * 20, lines: file.lines })),
    fileTree: [],
    hotspots: []
  };
}

function analysisOf(): RepositoryAnalysis {
  return {
    repositoryId: "repo",
    generatedAt: "2026-09-16T00:00:00.000Z",
    graph: {
      imports: { "main.py": ["graph/builder.py"], "graph/builder.py": ["graph/nodes.py"] },
      calls: [{ callerPath: "main.py", callerSymbol: "s1", calleePath: "graph/builder.py", calleeSymbol: "s2", line: 12 }],
      symbols: [
        { id: "s1", name: "main", kind: "function", path: "main.py", line: 8, endLine: 30, parameters: [], language: "python" },
        { id: "s2", name: "build_graph", kind: "function", path: "graph/builder.py", line: 51, endLine: 102, parameters: [], language: "python" },
        { id: "s3", name: "evaluate", kind: "function", path: "graph/nodes.py", line: 40, endLine: 88, parameters: [], language: "python" }
      ],
      entrypoints: [ENTRY],
      semanticBackend: "static",
      lspStatus: []
    },
    implementations: [],
    quality: { generatedAt: "2026-09-16T00:00:00.000Z", micro: [], macro: [] },
    versionStamp: "v1"
  };
}

const INDEX = indexOf([
  { path: "main.py", lines: 40 },
  { path: "graph/builder.py", lines: 120 },
  { path: "graph/nodes.py", lines: 200 }
]);

const context = {
  entry: ENTRY,
  availablePaths: new Set(INDEX.files.map((file) => file.path)),
  linesOf: new Map(INDEX.files.map((file) => [file.path, file.lines])),
  areRelated: buildRelatedPairs(analysisOf())
};

function providerOf(reply: string | (() => Promise<never>), onCall?: (input: LlmCompletionInput) => void): LlmProvider {
  return {
    name: "stub",
    modelVersion: "stub-1",
    complete: async (input) => {
      onCall?.(input);
      if (typeof reply !== "string") return reply();
      return { text: reply, usage: { inputTokens: 1000, outputTokens: 500 } };
    }
  };
}

const reply = JSON.stringify({
  title: "一次对话请求的处理流程",
  summary: "从 CLI 进入，构建图后执行节点，评估不通过则回环改进。",
  stages: [
    { title: "接收请求", detail: "解析命令行参数并读取配置。", kind: "entry", files: [{ path: "main.py", line: 12, note: "CLI 入口" }] },
    // evaluate 在 graph/nodes.py 里，用命中行的行号
    { title: "构建执行图", detail: "注册节点与边，编译成可执行图。", kind: "stage", files: [{ path: "graph/builder.py", line: 51, note: "add_node 注册" }] },
    { title: "执行并评估", detail: "跑到 evaluate 节点，按分数决定去向。", kind: "decision", files: [{ path: "graph/nodes.py", line: 40 }], branches: ["通过 → 输出", "不通过 → 回环改进"] },
    { title: "回环改进", detail: "重新规划后回到执行环节。", kind: "loop", files: [{ path: "graph/nodes.py", line: 40 }], loopsTo: 3 },
    { title: "产出报告", detail: "写出结果文件。", kind: "exit", files: [{ path: "main.py", line: 38 }] }
  ],
  caveats: "evaluate 的具体判分逻辑未在证据里体现。"
});

describe("parseFlow（模型输出的硬校验）", () => {
  it("接受合法输出，序号按数组位置重排、回环指向重排后的序号", () => {
    const flow = parseFlow(reply, context);
    expect(flow?.stages.map((stage) => [stage.order, stage.kind])).toEqual([
      [1, "entry"], [2, "stage"], [3, "decision"], [4, "loop"], [5, "exit"]
    ]);
    expect(flow?.stages[3].loopsTo).toBe(3);
    expect(flow?.stages[2].branches).toHaveLength(2);
    expect(flow?.caveats).toContain("evaluate 的具体判分逻辑");
  });

  it("丢弃路径不存在的文件；某环节的文件全被丢弃时整个环节一并丢弃，并写进 caveats", () => {
    const text = JSON.stringify({
      title: "t", summary: "s",
      stages: [
        { title: "入口", detail: "d", kind: "entry", files: [{ path: "main.py", line: 1 }] },
        { title: "编造的环节", detail: "d", kind: "stage", files: [{ path: "graph/not-exist.py", line: 3 }] },
        { title: "构建", detail: "d", kind: "stage", files: [{ path: "graph/builder.py", line: 10 }] },
        { title: "执行", detail: "d", kind: "stage", files: [{ path: "graph/nodes.py", line: 10 }] },
        { title: "产出", detail: "d", kind: "exit", files: [{ path: "main.py", line: 38 }, { path: "nope.py", line: 1 }] }
      ]
    });
    const flow = parseFlow(text, context);
    expect(flow?.stages.map((stage) => stage.title)).toEqual(["入口", "构建", "执行", "产出"]);
    expect(flow?.stages[3].files.map((file) => file.path)).toEqual(["main.py"]);
    expect(flow?.caveats).toContain("1 个环节因未给出存在的文件路径被丢弃");
    // 被丢弃的那个环节里的编造路径也要计数：读者据此知道模型确实编过路径
    expect(flow?.caveats).toContain("2 个文件路径不在仓库中");
  });

  it("校验后环节不足 3 个就判定失败（返回 null，由调用方回落静态链）", () => {
    const text = JSON.stringify({
      title: "t", summary: "s",
      stages: [
        { title: "入口", detail: "d", kind: "entry", files: [{ path: "main.py", line: 1 }] },
        { title: "编造", detail: "d", kind: "stage", files: [{ path: "x.py", line: 1 }] }
      ]
    });
    expect(parseFlow(text, context)).toBeNull();
  });

  it("行号越界被改到文件范围内，并在 caveats 里如实交代；标题与说明超长被截断", () => {
    const text = JSON.stringify({
      title: "很长的标题".repeat(20), summary: "s",
      stages: [
        { title: "入口环节名超过十四个字的时候应当被截断", detail: "d".repeat(200), kind: "entry", files: [{ path: "main.py", line: 99999 }] },
        { title: "二", detail: "d", kind: "stage", files: [{ path: "graph/builder.py", line: 0 }] },
        { title: "三", detail: "d", kind: "stage", files: [{ path: "graph/nodes.py", line: 5 }] }
      ]
    });
    const flow = parseFlow(text, context);
    expect(flow?.stages[0].files[0].line).toBe(40);
    expect(flow?.stages[1].files[0].line).toBe(1);
    // 只有越界的两个被记账：第三处 line=5 是合法行号，不该被算进去；缺行号也不算
    expect(flow?.caveats).toContain("有 2 个文件的行号超出该文件行数");
    expect([...(flow?.stages[0].title ?? "")].length).toBeLessThanOrEqual(14);
    expect([...(flow?.stages[0].detail ?? "")].length).toBeLessThanOrEqual(60);
    expect([...(flow?.title ?? "")].length).toBeLessThanOrEqual(18);
  });

  it("回环只能指向更靠前的环节，指向自己或未来环节一律丢弃", () => {
    const text = JSON.stringify({
      title: "t", summary: "s",
      stages: [
        { title: "一", detail: "d", kind: "entry", files: [{ path: "main.py", line: 1 }], loopsTo: 1 },
        { title: "二", detail: "d", kind: "stage", files: [{ path: "graph/builder.py", line: 1 }], loopsTo: 3 },
        { title: "三", detail: "d", kind: "stage", files: [{ path: "graph/nodes.py", line: 1 }] }
      ]
    });
    const flow = parseFlow(text, context);
    expect(flow?.stages[0].loopsTo).toBeUndefined();
    expect(flow?.stages[1].loopsTo).toBeUndefined();
  });

  it("只有第 1 个环节是 entry；模型标了多个 entry 时其余降级为 stage", () => {
    const text = JSON.stringify({
      title: "t", summary: "s",
      stages: [
        { title: "一", detail: "d", kind: "stage", files: [{ path: "main.py", line: 1 }] },
        { title: "二", detail: "d", kind: "entry", files: [{ path: "graph/builder.py", line: 1 }] },
        { title: "三", detail: "d", kind: "entry", files: [{ path: "graph/nodes.py", line: 1 }] }
      ]
    });
    const flow = parseFlow(text, context);
    expect(flow?.stages.map((stage) => stage.kind)).toEqual(["entry", "stage", "stage"]);
  });

  it("非 JSON / 缺 stages 的输出返回 null，不抛异常", () => {
    expect(parseFlow("这不是 JSON", context)).toBeNull();
    expect(parseFlow("{\"title\":\"t\"}", context)).toBeNull();
    expect(parseFlow("```json\n{\"stages\":[{\"title\":\"一\",\"files\":[{\"path\":\"main.py\"}]},{\"title\":\"二\",\"files\":[{\"path\":\"graph/builder.py\"}]},{\"title\":\"三\",\"files\":[{\"path\":\"graph/nodes.py\"}]}]}\n```", context)?.stages).toHaveLength(3);
  });
});

describe("generateRepositoryFlow（含降级）", () => {
  it("调用成功时返回 source=llm，并把 scene 标成 map.flow", async () => {
    const calls: LlmCompletionInput[] = [];
    const result = await generateRepositoryFlow({ repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), entry: ENTRY, provider: providerOf(reply, (input) => calls.push(input)), summaries: NO_SUMMARIES });
    expect(result.source).toBe("llm");
    expect(result.flow.stages).toHaveLength(5);
    expect(calls[0].scene).toBe("map.flow");
    expect(calls[0].system).toContain("回调");
  });

  it("模型输出不可解析时回落静态调用链并带上原因", async () => {
    const result = await generateRepositoryFlow({ repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), entry: ENTRY, provider: providerOf("抱歉，我无法完成。"), summaries: NO_SUMMARIES });
    expect(result.source).toBe("static");
    expect(result.reason).toContain("无法解析");
    expect(result.flow.caveats).toContain("回调注册");
  });

  it("调用抛异常时回落静态调用链，异常信息进 reason", async () => {
    const result = await generateRepositoryFlow({
      repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), entry: ENTRY,
      provider: providerOf(async () => { throw new Error("429 too many requests"); }),
      summaries: NO_SUMMARIES
    });
    expect(result.source).toBe("static");
    expect(result.reason).toContain("429");
  });

  it("缓存：同一仓库 + 同一入口的第二次请求不再调用模型；不同入口各自算一次", async () => {
    clearRepositoryFlowCache();
    const complete = vi.fn(async () => ({ text: reply, usage: { inputTokens: 1, outputTokens: 1 } }));
    const provider: LlmProvider = { name: "stub", modelVersion: "stub-1", complete };
    const base = { repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), provider, summaries: NO_SUMMARIES, repositoryId: "repo" };
    await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    expect(complete).toHaveBeenCalledTimes(1);
    await generateRepositoryFlowCached({ ...base, entry: { path: "graph/nodes.py", line: 1, label: "CLI command" } });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("缓存粒度按「本层实际输入」：全仓 versionStamp 翻转不重算，进到 digest 的变化才重算", async () => {
    clearRepositoryFlowCache();
    const complete = vi.fn(async () => ({ text: reply, usage: { inputTokens: 1, outputTokens: 1 } }));
    const provider: LlmProvider = { name: "stub", modelVersion: "stub-1", complete };
    const base = { repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), provider, summaries: NO_SUMMARIES, repositoryId: "repo" };
    await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    expect(complete).toHaveBeenCalledTimes(1);
    // versionStamp 是「全仓内容一把哈希」，它在 digest 里根本不出现：改任何一个文件都会翻它。
    // 键按实际输入算，就不会因为一处无关改动把这条流程重烧一遍——结构没变，模型的问题也没变。
    await generateRepositoryFlowCached({ ...base, analysis: { ...analysisOf(), versionStamp: "v2" }, entry: ENTRY });
    expect(complete).toHaveBeenCalledTimes(1);
    // 换模型必须重算：同一个问题在不同模型上不是同一个答案
    await generateRepositoryFlowCached({ ...base, entry: ENTRY, provider: { ...provider, modelVersion: "stub-2" } });
    expect(complete).toHaveBeenCalledTimes(2);
    // 补上一条已确认的 L1 摘要 → 清单里多了 summary 字段 → 输入确实变了，重算
    await generateRepositoryFlowCached({ ...base, entry: ENTRY, summaries: new Map([["graph/builder.py", { summary: "建图。" }]]) });
    expect(complete).toHaveBeenCalledTimes(3);
    // 摘要覆盖不足时正文被隐去，但 withheldSummaries 计数会进 digest——「有几份职责未确认」本身是告诉模型的信息
    await generateRepositoryFlowCached({ ...base, entry: ENTRY, summaries: new Map([["graph/builder.py", { summary: "建图。", coverageLow: true }]]) });
    expect(complete).toHaveBeenCalledTimes(4);
  });

  it("持久层让重启不重烧：清空内存缓存后同键仍命中 SQLite；降级结果不落盘", async () => {
    clearRepositoryFlowCache();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-flow-persist-")));
    const database = new TutorDatabase(dir);
    try {
      let attempts = 0;
      const provider: LlmProvider = {
        name: "stub", modelVersion: "stub-1",
        complete: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("first fails");
          return { text: reply, usage: { inputTokens: 1, outputTokens: 1 } };
        }
      };
      const base = { repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), provider, summaries: NO_SUMMARIES, repositoryId: "repo", entry: ENTRY, database };
      // 第 1 次：调用失败回落静态——静态结果不入任何一层缓存
      expect((await generateRepositoryFlowCached(base)).source).toBe("static");
      // 模拟 engine 重启：内存层被清空，SQLite 还在；降级没落盘，所以会重试并这次成功
      clearRepositoryFlowCache();
      const second = await generateRepositoryFlowCached(base);
      expect(second.source).toBe("llm");
      expect(attempts).toBe(2);
      expect(second.usage).toBeDefined(); // 这次是真调用，带 usage 记账
      // 成功的结果同时落在内存与持久层；此后每次重启都命中持久层，不再烧钱
      clearRepositoryFlowCache();
      const third = await generateRepositoryFlowCached(base);
      expect(third.source).toBe("llm");
      expect(third.usage).toBeUndefined(); // 命中不带 usage，上层不会重复记账
      expect(attempts).toBe(2);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缓存按仓库隔离：内容逐字相同的两个仓库各自算一次，不共用条目", async () => {
    clearRepositoryFlowCache();
    const complete = vi.fn(async () => ({ text: reply, usage: { inputTokens: 1, outputTokens: 1 } }));
    const provider: LlmProvider = { name: "stub", modelVersion: "stub-1", complete };
    const shared = { repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), provider, summaries: NO_SUMMARIES, entry: ENTRY };
    await generateRepositoryFlowCached({ ...shared, repositoryId: "repo_a" });
    await generateRepositoryFlowCached({ ...shared, repositoryId: "repo_a" });
    expect(complete).toHaveBeenCalledTimes(1);
    // 这条保证的是：卸载 / 换仓时不清缓存也安全——旧仓的结果不可能被新仓读到。
    await generateRepositoryFlowCached({ ...shared, repositoryId: "repo_b" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("缓存不固化失败：降级结果不入缓存，下次请求仍会重试", async () => {
    clearRepositoryFlowCache();
    let attempt = 0;
    const provider: LlmProvider = {
      name: "stub", modelVersion: "stub-1",
      complete: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network down");
        return { text: reply, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };
    const base = { repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), provider, repositoryId: "repo", summaries: NO_SUMMARIES };
    const first = await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    const second = await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    expect(first.source).toBe("static");
    expect(second.source).toBe("llm");
    expect(attempt).toBe(2);
  });

  it("缓存续期：TTL 是「闲置时长」而不是「生成后的固定时长」", async () => {
    clearRepositoryFlowCache();
    const complete = vi.fn(async () => ({ text: reply, usage: { inputTokens: 1, outputTokens: 1 } }));
    const provider: LlmProvider = { name: "stub", modelVersion: "stub-1", complete };
    const base = { repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), provider, repositoryId: "repo", summaries: NO_SUMMARIES };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
      await generateRepositoryFlowCached({ ...base, entry: ENTRY });
      expect(complete).toHaveBeenCalledTimes(1);
      // 每 9 分钟访问一次、连续三次：距首次生成已过 18 分钟（超过 TTL），但每次命中都续期 → 始终不重算
      for (const minutes of [9, 9, 9]) {
        vi.setSystemTime(Date.now() + minutes * 60_000);
        const result = await generateRepositoryFlowCached({ ...base, entry: ENTRY });
        expect(result.source).toBe("llm");
      }
      expect(complete).toHaveBeenCalledTimes(1);
      // 闲置超过 TTL 才重新生成
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await generateRepositoryFlowCached({ ...base, entry: ENTRY });
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      clearRepositoryFlowCache();
    }
  });
});

describe("buildFlowDigest（喂给模型的证据）", () => {
  it("带上入口文件的真实内容、文件清单按「入口优先 + 被依赖多优先」排序", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    mkdirSync(join(dir, "graph"), { recursive: true });
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    const digest = buildFlowDigest(dir, INDEX, analysisOf(), ENTRY, NO_SUMMARIES);
    expect(digest.entry.path).toBe("main.py");
    expect(digest.entryExcerpt).toContain("def main()");
    expect(digest.files[0].path).toBe("main.py");
    expect(digest.files[0].symbols).toContain("main");
    // 排序键：入口优先 → 被依赖数多优先 → 行数多优先（被依赖数相同时按体量，让主干文件靠前）
    expect(digest.files.map((file) => file.path)).toEqual(["main.py", "graph/nodes.py", "graph/builder.py"]);
    expect(digest.callChain[0]).toContain("main.py");
  });

  it("符号按调用图排序后再截断：入口直接调到的 > 被调用多的 > 声明顺序", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    // big.py 声明了 10 个函数：只有 fn10 被入口调用，fn9 被两处、fn8 被一处调用 —— 三者都必须活下来
    const symbols = Array.from({ length: 10 }, (_, index) => ({
      id: `s${index + 1}`,
      name: `fn${index + 1}`,
      kind: "function" as const,
      path: "big.py",
      line: (index + 1) * 10,
      endLine: (index + 1) * 10 + 5,
      parameters: [],
      language: "python" as const
    }));
    const base = analysisOf();
    const analysis: RepositoryAnalysis = {
      ...base,
      graph: {
        ...base.graph,
        symbols: [...base.graph.symbols, ...symbols],
        calls: [
          { callerPath: "main.py", callerSymbol: "s1", calleePath: "big.py", calleeSymbol: "s10", line: 5 },
          { callerPath: "other.py", calleePath: "big.py", calleeSymbol: "s9", line: 3 },
          { callerPath: "second.py", calleePath: "big.py", calleeSymbol: "s9", line: 7 },
          { callerPath: "other.py", calleePath: "big.py", calleeSymbol: "s8", line: 9 }
        ]
      }
    };
    const index: RepositoryIndex = { ...INDEX, files: [...INDEX.files, { path: "big.py", extension: ".py", bytes: 100, lines: 120 }] };
    const digest = buildFlowDigest(dir, index, analysis, ENTRY, NO_SUMMARIES);
    const big = digest.files.find((file) => file.path === "big.py");
    // 上限 8：fn10（入口调到）→ fn9（入度 2）→ fn8（入度 1）→ 其余按声明序，末尾的 fn9/fn10 不再被丢掉
    expect(big?.symbols).toEqual(["fn10", "fn9", "fn8", "fn1", "fn2", "fn3", "fn4", "fn5"]);
  });

  it("目录骨架列出全部被索引文件，目录行带该目录下的文件数", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    const index: RepositoryIndex = {
      ...INDEX,
      fileTree: [
        { name: "main.py", path: "main.py", kind: "file" },
        {
          name: "graph",
          path: "graph",
          kind: "directory",
          children: [
            { name: "builder.py", path: "graph/builder.py", kind: "file" },
            { name: "nodes.py", path: "graph/nodes.py", kind: "file" }
          ]
        }
      ]
    };
    const digest = buildFlowDigest(dir, index, analysisOf(), ENTRY, NO_SUMMARIES);
    expect(digest.directoryTree).toEqual(["main.py", "graph/ (2)", "  builder.py", "  nodes.py"]);
    expect(digest.directoryTreeTruncated).toBe(false);
    // 目录树独立于 files 详表：files 只收「参与执行」的候选，树是全量骨架
    expect(digest.files.length).toBeLessThanOrEqual(3);
  });

  it("目录骨架超行数上限即截断并标记", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    const many = Array.from({ length: 201 }, (_, index) => ({ name: `f${index}.py`, path: `f${index}.py`, kind: "file" as const }));
    const digest = buildFlowDigest(dir, { ...INDEX, fileTree: many }, analysisOf(), ENTRY, NO_SUMMARIES);
    expect(digest.directoryTree).toHaveLength(200);
    expect(digest.directoryTreeTruncated).toBe(true);
  });

  it("热点过滤掉不在索引里的路径，并截断到上限", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    const hotFiles = Array.from({ length: 20 }, (_, index) => ({ path: `hot${index}.py`, extension: ".py", bytes: 10, lines: 5 }));
    const index: RepositoryIndex = {
      ...INDEX,
      files: [...INDEX.files, ...hotFiles],
      hotspots: [
        { path: "main.py", changes: 40 },
        { path: "docker-compose.yml", changes: 88 }, // gitHotspots 不看扩展名，这类路径不在索引里
        ...hotFiles.map((file, index) => ({ path: file.path, changes: index + 1 }))
      ]
    };
    const digest = buildFlowDigest(dir, index, analysisOf(), ENTRY, NO_SUMMARIES);
    expect(digest.hotspots[0]).toEqual({ path: "main.py", changes: 40 });
    expect(digest.hotspots).toHaveLength(15);
    expect(digest.hotspots.map((hotspot) => hotspot.path)).not.toContain("docker-compose.yml");
  });

  it("每个文件带上结构角色：入口与入口直接依赖是主干，只有反向依赖的是支撑", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    const digest = buildFlowDigest(dir, INDEX, analysisOf(), ENTRY, NO_SUMMARIES);
    expect(digest.files.map((file) => `${file.path}:${file.role}`)).toEqual([
      "main.py:core", // 入口
      "graph/nodes.py:support", // 只被别人依赖，且不在入口的直接依赖里
      "graph/builder.py:core" // 被入口直接调用
    ]);
  });
});

/** 三条环节的最小合法回复：main.py → graph/builder.py → graph/nodes.py（与 fixture 的依赖一致）。 */
function replyWithEdges(edges: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "一次对话请求的处理流程",
    summary: "从 CLI 进入，构建图后执行节点。",
    stages: [
      { title: "接收请求", detail: "解析参数。", kind: "entry", files: [{ path: "main.py", line: 12 }] },
      { title: "构建执行图", detail: "注册节点。", kind: "stage", files: [{ path: "graph/builder.py", line: 51 }] },
      { title: "执行并评估", detail: "跑到 evaluate。", kind: "decision", files: [{ path: "graph/nodes.py", line: 40 }] }
    ],
    edges,
    ...extra
  });
}

describe("边级校验（L0 监督 L2）", () => {
  it("声称来自代码的边要由依赖图证明，证不了就降级为推断（不删边）", () => {
    const flow = parseFlow(replyWithEdges([
      { from: 1, to: 2, origin: "static", evidence: "main.py:12 → graph/builder.py:51" }, // 真有 import 与调用
      { from: 1, to: 3, origin: "static", evidence: "main.py:12 → graph/nodes.py:40" }, // 图上没有直接关系
      { from: 2, to: 3, origin: "inferred", evidence: "builder 注册 nodes 的回调" } // 推断边原样保留
    ]), context);
    expect(flow?.edges).toEqual([
      { from: 1, to: 2, origin: "static", evidence: "main.py:12 → graph/builder.py:51" },
      { from: 1, to: 3, origin: "inferred", evidence: "main.py:12 → graph/nodes.py:40" },
      { from: 2, to: 3, origin: "inferred", evidence: "builder 注册 nodes 的回调" }
    ]);
    expect(flow?.caveats).toContain("1 条边声称来自代码但与依赖图对不上，已改标为推断");
  });

  it("端点不合法、缺依据、自环或 origin 非法都丢边并计数；重复边静默去重", () => {
    const flow = parseFlow(replyWithEdges([
      { from: 1, to: 2, origin: "static", evidence: "ok" },
      { from: 1, to: 2, origin: "static", evidence: "重复的一条" },
      { from: 1, to: 1, origin: "static", evidence: "自环" },
      { from: 2, to: 3, origin: "static" },
      { from: 0, to: 2, origin: "static", evidence: "端点越界" },
      { from: 1, to: 2, origin: "听说", evidence: "origin 非法" }
    ]), context);
    expect(flow?.edges).toHaveLength(1);
    expect(flow?.caveats).toContain("4 条边因端点或依据不合格被丢弃");
  });

  it("指向被丢弃环节的边一并丢弃（环节序号会整体前移，边必须跟着换算）", () => {
    const reply = JSON.stringify({
      title: "t",
      summary: "s",
      stages: [
        { title: "接收请求", detail: "…", kind: "entry", files: [{ path: "main.py", line: 12 }] },
        { title: "编造的环节", detail: "…", kind: "stage", files: [{ path: "不存在的文件.py", line: 1 }] },
        { title: "构建执行图", detail: "…", kind: "stage", files: [{ path: "graph/builder.py", line: 51 }] },
        { title: "执行并评估", detail: "…", kind: "decision", files: [{ path: "graph/nodes.py", line: 40 }] }
      ],
      // 原序号 2 的环节被丢弃后，原 3 → 新 2、原 4 → 新 3；指向原 2 的边无处可去
      edges: [
        { from: 2, to: 3, origin: "static", evidence: "指向被丢掉的环节" },
        { from: 3, to: 4, origin: "static", evidence: "graph/builder.py:51 → graph/nodes.py:40" }
      ]
    });
    const flow = parseFlow(reply, context);
    expect(flow?.stages.map((stage) => stage.order)).toEqual([1, 2, 3]);
    expect(flow?.edges).toEqual([{ from: 2, to: 3, origin: "static", evidence: "graph/builder.py:51 → graph/nodes.py:40" }]);
    expect(flow?.caveats).toContain("1 条边因端点或依据不合格被丢弃");
  });

  it("未覆盖清单：模型给的保留并截断，没给就在 caveats 里点名（不假装已覆盖）", () => {
    const withList = parseFlow(replyWithEdges([], { uncovered: ["没看懂的插件注册", "   ", ...Array.from({ length: 8 }, (_, index) => `项${index}`)] }), context);
    expect(withList?.uncovered?.[0]).toBe("没看懂的插件注册");
    expect(withList?.uncovered).toHaveLength(6);
    expect(withList?.caveats ?? "").not.toContain("没有给出未覆盖清单");

    const without = parseFlow(replyWithEdges([]), context);
    expect(without?.uncovered).toBeUndefined();
    expect(without?.edges).toEqual([]); // 没给边就是空数组，字段本身始终存在
    expect(without?.caveats).toContain("模型没有给出未覆盖清单");
  });

  it("降级视图也带边：静态调用链的相邻环节就是一条 static 边", () => {
    const flow = staticFlow(buildFlowEvidence(analysisOf(), ENTRY), "未配置 LLM");
    expect(flow.edges.length).toBeGreaterThan(0);
    expect(flow.edges.every((edge) => edge.origin === "static")).toBe(true);
    expect(flow.edges.every((edge) => edge.evidence.includes("→"))).toBe(true);
    expect(flow.uncovered?.length).toBeGreaterThan(0);
  });

  it("主调用声称「在源码里读到」会被改标为推断——这一步并没有读过那些文件", () => {
    const flow = parseFlow(replyWithEdges([{ from: 1, to: 2, origin: "code", evidence: "main.py:12 里写着" }]), context);
    expect(flow?.edges[0]).toMatchObject({ origin: "inferred", evidence: "main.py:12 里写着" });
    expect(flow?.caveats).toContain("声称「在源码里读到」，但本次并没有读过那些文件");
  });

  it("用量相加保留全部四个字段（只搬 in/out 会把缓存命中吞成「未命中」）", () => {
    expect(addUsage(
      { inputTokens: 1, outputTokens: 2, promptCacheHitTokens: 3, promptCacheMissTokens: 4 },
      { inputTokens: 10, outputTokens: 20, promptCacheHitTokens: 30, promptCacheMissTokens: 40 }
    )).toEqual({ inputTokens: 11, outputTokens: 22, promptCacheHitTokens: 33, promptCacheMissTokens: 44 });
    // 两边都没上报该字段时不要凭空造 0
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(addUsage(undefined, { inputTokens: 1, outputTokens: 2 })).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, undefined)).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it("有推断边时会做一次按需深入：两次调用的用量都记在结果里，边升级为 code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-deepen-"));
    mkdirSync(join(dir, "graph"), { recursive: true });
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    writeFileSync(join(dir, "graph/builder.py"), "def build_graph():\n    pass\n");
    writeFileSync(join(dir, "graph/nodes.py"), "def evaluate():\n    pass\n");
    const replies = [
      replyWithEdges([{ from: 2, to: 3, origin: "inferred", evidence: "builder 大概注册了节点" }]),
      JSON.stringify([{ from: 2, to: 3, verdict: "code", evidence: "graph/builder.py:1 里注册 evaluate" }])
    ];
    const calls: LlmCompletionInput[] = [];
    const provider: LlmProvider = {
      name: "stub",
      modelVersion: "stub-1",
      complete: async (input) => {
        const text = replies[Math.min(calls.length, replies.length - 1)];
        calls.push(input);
        return { text, usage: { inputTokens: 100, outputTokens: 10, promptCacheHitTokens: 40, promptCacheMissTokens: 60 } };
      }
    };
    clearRepositoryFlowCache();
    const result = await generateRepositoryFlow({ repositoryPath: dir, index: INDEX, analysis: analysisOf(), entry: ENTRY, provider, summaries: NO_SUMMARIES });
    expect(calls.map((call) => call.scene)).toEqual(["map.flow", "map.flow.deep"]);
    expect(result.flow.edges[0]).toMatchObject({ origin: "code" });
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20, promptCacheHitTokens: 80, promptCacheMissTokens: 120 });
  });
});

describe("L1 摘要表进流程证据", () => {
  it("已确认的摘要随文件一起给出；覆盖不足的摘要被隐去并在 withheldSummaries 里计数", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    const summaries = new Map<string, FlowDigestSummary>([
      ["main.py", { summary: "CLI 入口，解析参数后构建执行图。" }],
      ["graph/nodes.py", { summary: "节点实现。", coverageLow: true }], // 覆盖不足 ⇒ 不可信
      ["graph/builder.py", { summary: "把节点注册成可执行图。" }]
    ]);
    const digest = buildFlowDigest(dir, INDEX, analysisOf(), ENTRY, summaries);
    const byPath = new Map(digest.files.map((file) => [file.path, file]));
    expect(byPath.get("main.py")?.summary).toBe("CLI 入口，解析参数后构建执行图。");
    expect(byPath.get("graph/builder.py")?.summary).toBe("把节点注册成可执行图。");
    // 覆盖不足的摘要不出现，但要在计数里如实说明，不能假装「这个文件没摘要」
    expect(byPath.get("graph/nodes.py")?.summary).toBeUndefined();
    expect(digest.withheldSummaries).toBe(1);
  });

  it("没有摘要表时字段整体缺席、计数为 0（不是空字符串这种假值）", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    const digest = buildFlowDigest(dir, INDEX, analysisOf(), ENTRY, NO_SUMMARIES);
    expect(digest.files.every((file) => !("summary" in file))).toBe(true);
    expect(digest.withheldSummaries).toBe(0);
  });
});

describe("resolveFlowEntry（人工指定入口兜底）", () => {
  const files = INDEX.files;
  const detected = [{ path: "main.py", line: 1, label: "script: dev" }];

  it("推断入口命中时原样返回（保留 label）", () => {
    expect(resolveFlowEntry("main.py", detected, files)).toEqual(detected[0]);
  });

  it("列表外的已索引文件视为人工指定入口", () => {
    expect(resolveFlowEntry("graph/nodes.py", detected, files)).toEqual({ path: "graph/nodes.py", line: 1, label: "手动指定" });
  });

  it("不在索引里的路径返回 undefined（调用方 404，不猜）", () => {
    expect(resolveFlowEntry("nope.py", detected, files)).toBeUndefined();
  });

  it("不带参数回落第一个推断入口；没有推断入口则 undefined", () => {
    expect(resolveFlowEntry("", detected, files)).toEqual(detected[0]);
    expect(resolveFlowEntry("  ", [], files)).toBeUndefined();
  });
});
