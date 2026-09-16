import { describe, expect, it, vi } from "vitest";
import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { buildFlowDigest, clearRepositoryFlowCache, generateRepositoryFlow, generateRepositoryFlowCached, parseFlow } from "./flow.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
  流程视图的服务端：LLM 生成 + 严格校验 + 缓存 + 降级。
  这里不测模型本身，只测「模型给什么都不能突破的约束」——路径必须真实、序号与回环重排一致、
  失败必须回落并显式说明原因。
  */

const ENTRY = { path: "main.py", line: 1, label: "package main" };

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

const context = { entry: ENTRY, availablePaths: new Set(INDEX.files.map((file) => file.path)), linesOf: new Map(INDEX.files.map((file) => [file.path, file.lines])) };

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

  it("行号越界被夹到文件范围内，标题与说明超长被截断", () => {
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
    const result = await generateRepositoryFlow({ repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), entry: ENTRY, provider: providerOf(reply, (input) => calls.push(input)) });
    expect(result.source).toBe("llm");
    expect(result.flow.stages).toHaveLength(5);
    expect(calls[0].scene).toBe("map.flow");
    expect(calls[0].system).toContain("回调");
  });

  it("模型输出不可解析时回落静态调用链并带上原因", async () => {
    const result = await generateRepositoryFlow({ repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), entry: ENTRY, provider: providerOf("抱歉，我无法完成。") });
    expect(result.source).toBe("static");
    expect(result.reason).toContain("无法解析");
    expect(result.flow.caveats).toContain("回调注册");
  });

  it("调用抛异常时回落静态调用链，异常信息进 reason", async () => {
    const result = await generateRepositoryFlow({
      repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), entry: ENTRY,
      provider: providerOf(async () => { throw new Error("429 too many requests"); })
    });
    expect(result.source).toBe("static");
    expect(result.reason).toContain("429");
  });

  it("缓存：同一 cacheKey + 入口第二次请求不再调用模型；不同入口各自算一次", async () => {
    clearRepositoryFlowCache();
    const complete = vi.fn(async () => ({ text: reply, usage: { inputTokens: 1, outputTokens: 1 } }));
    const provider: LlmProvider = { name: "stub", modelVersion: "stub-1", complete };
    const base = { repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), provider, cacheKey: "repo:v1" };
    await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    expect(complete).toHaveBeenCalledTimes(1);
    await generateRepositoryFlowCached({ ...base, entry: { path: "graph/nodes.py", line: 1, label: "CLI command" } });
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
    const base = { repositoryPath: "/repo", index: INDEX, analysis: analysisOf(), provider, cacheKey: "repo:v2" };
    const first = await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    const second = await generateRepositoryFlowCached({ ...base, entry: ENTRY });
    expect(first.source).toBe("static");
    expect(second.source).toBe("llm");
    expect(attempt).toBe(2);
  });
});

describe("buildFlowDigest（喂给模型的证据）", () => {
  it("带上入口文件的真实内容、文件清单按「入口优先 + 被依赖多优先」排序", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-digest-"));
    mkdirSync(join(dir, "graph"), { recursive: true });
    writeFileSync(join(dir, "main.py"), "def main():\n    pass\n");
    const digest = buildFlowDigest(dir, INDEX, analysisOf(), ENTRY);
    expect(digest.entry.path).toBe("main.py");
    expect(digest.entryExcerpt).toContain("def main()");
    expect(digest.files[0].path).toBe("main.py");
    expect(digest.files[0].symbols).toContain("main");
    // 排序键：入口优先 → 被依赖数多优先 → 行数多优先（被依赖数相同时按体量，让主干文件靠前）
    expect(digest.files.map((file) => file.path)).toEqual(["main.py", "graph/nodes.py", "graph/builder.py"]);
    expect(digest.callChain[0]).toContain("main.py");
  });
});
