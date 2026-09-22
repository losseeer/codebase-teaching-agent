import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryAnalysis, RepositoryFlow, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { deepenInferredEdges, parseDeepenReply } from "./deepen.js";

/**
  按需深入：主调用之后对「推断边」做一次有界的代码核实。
  这里守的是三条边界——只读被问到的窗口、条数与文件数有上限、核实失败不损失流程。
*/

const FILES: Record<string, string> = {
  "main.py": ["def main():", "    build_graph()", "", "if __name__ == \"__main__\":", "    main()"].join("\n"),
  "graph/builder.py": ["import os", "", "def build_graph():", "    register_all()", "    return 1", "", "def other():", "    pass"].join("\n"),
  "graph/nodes.py": ["def evaluate(state):", "    return state", "", "def register_all():", "    pass"].join("\n"),
  "utils/cache.py": ["def cache_get(key):", "    return None"].join("\n"),
  "utils/holder.py": ["def save_user(user):", "    pass"].join("\n"),
  "utils/trace.py": ["def clear_trace():", "    pass"].join("\n"),
  "web/app.py": ["app = create_app()", "", "def serve():", "    main()"].join("\n"),
  "graph/state.py": ["class State:", "    pass"].join("\n"),
  "graph/hooks.py": ["def on_register(fn):", "    return fn"].join("\n")
};

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "deepen-"));
  mkdirSync(join(dir, "graph"), { recursive: true });
  mkdirSync(join(dir, "utils"), { recursive: true });
  mkdirSync(join(dir, "web"), { recursive: true });
  for (const [path, content] of Object.entries(FILES)) writeFileSync(join(dir, path), `${content}\n`);
  return dir;
}

const INDEX: RepositoryIndex = {
  repositoryId: "repo",
  repositoryPath: "/repo",
  scannedAt: "2026-09-18T00:00:00.000Z",
  totalFiles: 3,
  totalLines: 18,
  files: Object.entries(FILES).map(([path, content]) => ({ path, extension: ".py", bytes: content.length, lines: content.split("\n").length })),
  fileTree: [],
  hotspots: []
};

const ANALYSIS: RepositoryAnalysis = {
  repositoryId: "repo",
  generatedAt: "2026-09-18T00:00:00.000Z",
  graph: {
    imports: { "main.py": ["graph/builder.py"], "graph/builder.py": ["graph/nodes.py"] },
    calls: [],
    symbols: [
      { id: "symbol:main.py:main:1", name: "main", kind: "function", path: "main.py", line: 1, endLine: 2, parameters: [], language: "python" },
      { id: "symbol:graph/builder.py:build_graph:3", name: "build_graph", kind: "function", path: "graph/builder.py", line: 3, endLine: 5, parameters: [], language: "python" },
      { id: "symbol:graph/nodes.py:register_all:4", name: "register_all", kind: "function", path: "graph/nodes.py", line: 4, endLine: 5, parameters: [], language: "python" }
    ],
    entrypoints: [{ path: "main.py", line: 1, label: "入口" }],
    semanticBackend: "static",
    lspStatus: []
  },
  implementations: [],
  quality: { generatedAt: "2026-09-18T00:00:00.000Z", micro: [], macro: [] },
  versionStamp: "v1"
};

function flowOf(edges: RepositoryFlow["edges"]): RepositoryFlow {
  return {
    entry: { path: "main.py", line: 1, label: "入口" },
    title: "一次请求的处理流程",
    summary: "从入口到注册节点。",
    stages: [
      { order: 1, kind: "entry", title: "入口", detail: "解析参数。", files: [{ path: "main.py", line: 1 }], branches: [] },
      { order: 2, kind: "stage", title: "建图", detail: "构建执行图。", files: [{ path: "graph/builder.py", line: 3 }], branches: [] },
      { order: 3, kind: "stage", title: "注册节点", detail: "注册节点。", files: [{ path: "graph/nodes.py", line: 4 }], branches: [] }
    ],
    edges,
    generatedAt: "2026-09-18T00:00:00.000Z"
  };
}

function providerOf(reply: string | (() => Promise<never>), onCall?: (input: LlmCompletionInput) => void): LlmProvider {
  return {
    name: "stub",
    modelVersion: "stub-1",
    complete: async (input) => {
      onCall?.(input);
      if (typeof reply !== "string") return reply();
      return { text: reply, usage: { inputTokens: 800, outputTokens: 60, promptCacheHitTokens: 500 } };
    }
  };
}

const INFERRED = { from: 2, to: 3, origin: "inferred" as const, evidence: "builder 大概注册了 nodes" };

describe("按需深入", () => {
  it("核实回复解析：只认合法的 verdict 与非空依据", () => {
    const parsed = parseDeepenReply(JSON.stringify([
      { from: 2, to: 3, verdict: "code", evidence: "graph/builder.py:4 调用 register_all()" },
      { from: 2, to: 4, verdict: "乱写的", evidence: "x" },
      { from: 2, to: 5, verdict: "inferred", evidence: "  " }
    ]));
    expect(parsed.size).toBe(1);
    expect(parsed.get("2:3")).toEqual({ verdict: "code", evidence: "graph/builder.py:4 调用 register_all()" });
    expect(parseDeepenReply("模型没按格式给。").size).toBe(0);
  });

  it("只读被问到的窗口，起点由符号表给出，不读无关文件", async () => {
    const dir = workspace();
    let seen: LlmCompletionInput | undefined;
    const result = await deepenInferredEdges({
      repositoryPath: dir,
      analysis: ANALYSIS,
      index: INDEX,
      flow: flowOf([{ from: 1, to: 2, origin: "static", evidence: "main.py:2 → graph/builder.py:3" }, INFERRED]),
      provider: providerOf(JSON.stringify([{ from: 2, to: 3, verdict: "code", evidence: "graph/builder.py:4 调用 register_all()" }]), (input) => { seen = input; })
    });
    const payload = JSON.parse(seen!.user ?? "{}") as { edges: unknown[]; code: { path: string; from: number; content: string }[] };
    // 只问推断边（静态边不问），只读它两端的文件；builder.py 的符号在第 3 行 ⇒ 窗口从第 1 行起
    expect(payload.edges).toHaveLength(1);
    expect(payload.code.map((item) => item.path).sort()).toEqual(["graph/builder.py", "graph/nodes.py"]);
    expect(payload.code.find((item) => item.path === "graph/builder.py")?.from).toBe(1);
    expect(seen!.scene).toBe("map.flow.deep");
    expect(seen!.temperature).toBe(0);
    // main.py 与这条边无关，没被读
    expect(payload.code.some((item) => item.path === "main.py")).toBe(false);
    expect(result).toMatchObject({ examined: 1, confirmed: 1, stillInferred: 0 });
    const edge = result.flow.edges.find((item) => item.from === 2 && item.to === 3);
    expect(edge?.origin).toBe("code");
    expect(edge?.evidence).toContain("graph/builder.py:4");
    expect(result.flow.caveats).toContain("按需深入");
  });

  it("引用对不上（引了不属于这条边的文件）就驳回，边保持推断", async () => {
    const dir = workspace();
    const result = await deepenInferredEdges({
      repositoryPath: dir,
      analysis: ANALYSIS,
      index: INDEX,
      flow: flowOf([INFERRED]),
      provider: providerOf(JSON.stringify([{ from: 2, to: 3, verdict: "code", evidence: "core/redis.py:7 里有注册" }]))
    });
    const edge = result.flow.edges[0];
    expect(edge.origin).toBe("inferred");
    expect(edge.evidence).toBe("builder 大概注册了 nodes"); // 驳回时连依据都不换
    expect(result.flow.caveats).toContain("1 条因引用的文件不属于该边被驳回");
    expect(result).toMatchObject({ confirmed: 0, stillInferred: 1 });
  });

  it("裸文件名/后缀引用也算数——真仓 19 条 code 判定曾被整路径匹配驳回 18 条", async () => {
    const dir = workspace();
    const result = await deepenInferredEdges({
      repositoryPath: dir,
      analysis: ANALYSIS,
      index: INDEX,
      flow: flowOf([INFERRED]),
      provider: providerOf(JSON.stringify([{ from: 2, to: 3, verdict: "code", evidence: "nodes.py:4 的注册被 builder 触发" }]))
    });
    expect(result.flow.edges[0].origin).toBe("code");
    expect(result).toMatchObject({ confirmed: 1, stillInferred: 0 });
  });

  it("相似文件名不能冒充：引 IShopServiceImpl 式的近似名照样驳回（后缀匹配必须整段相等）", async () => {
    const dir = workspace();
    const result = await deepenInferredEdges({
      repositoryPath: dir,
      analysis: ANALYSIS,
      index: INDEX,
      flow: flowOf([INFERRED]),
      provider: providerOf(JSON.stringify([{ from: 2, to: 3, verdict: "code", evidence: "graph/xnodes.py:4 有注册" }]))
    });
    expect(result.flow.edges[0].origin).toBe("inferred");
    expect(result).toMatchObject({ confirmed: 0 });
  });

  it("模型认了「仍不确定」时换掉依据、保留推断标记", async () => {
    const dir = workspace();
    const result = await deepenInferredEdges({
      repositoryPath: dir,
      analysis: ANALYSIS,
      index: INDEX,
      flow: flowOf([INFERRED]),
      provider: providerOf(JSON.stringify([{ from: 2, to: 3, verdict: "inferred", evidence: "片段里只看到 register_all 的定义，没有注册调用" }]))
    });
    expect(result.flow.edges[0]).toMatchObject({ origin: "inferred", evidence: "片段里只看到 register_all 的定义，没有注册调用" });
    expect(result).toMatchObject({ confirmed: 0, stillInferred: 1 });
  });

  it("没有推断边就一条调用都不发生（这一步按需触发，不是固定开销）", async () => {
    const dir = workspace();
    const complete = vi.fn(async () => ({ text: "[]" }));
    const result = await deepenInferredEdges({
      repositoryPath: dir,
      analysis: ANALYSIS,
      index: INDEX,
      flow: flowOf([{ from: 1, to: 2, origin: "static", evidence: "main.py:2 → graph/builder.py:3" }]),
      provider: { name: "stub", modelVersion: "stub-1", complete }
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ examined: 0, confirmed: 0, stillInferred: 0 });
    expect(result.flow.caveats).toBeUndefined();
  });

  it("调用失败时保留原流程，只把情况写进 caveats（不因核实失败丢掉主结果）", async () => {
    const dir = workspace();
    const result = await deepenInferredEdges({
      repositoryPath: dir,
      analysis: ANALYSIS,
      index: INDEX,
      flow: flowOf([INFERRED]),
      provider: providerOf(async () => { throw new Error("network down"); })
    });
    expect(result.flow.edges[0].origin).toBe("inferred");
    expect(result.flow.caveats).toContain("按需深入调用失败");
    expect(result.flow.caveats).toContain("network down");
    expect(result.usage).toBeUndefined();
  });

  it("端点全不在阅读窗口内的推断边不白问，并如实计入 caveats", async () => {
    const dir = workspace();
    let seen: LlmCompletionInput | undefined;
    // 三条推断边共 8 个端点文件，窗口上限 5：builder.py 被两条边需要（权重 2），其余按流程出现序进窗口；
    // 4→5 这条边的两端（holder/trace）谁都没被别的边需要且排最后，必然落在窗口外 → 不送核实。
    const result = await deepenInferredEdges({
      repositoryPath: dir,
      analysis: ANALYSIS,
      index: INDEX,
      flow: {
        entry: { path: "main.py", line: 1, label: "入口" },
        title: "窗口外的边",
        summary: "覆盖裁剪。",
        stages: [
          { order: 1, kind: "entry", title: "入口", detail: "d", files: [{ path: "main.py", line: 1 }, { path: "web/app.py", line: 1 }], branches: [] },
          { order: 2, kind: "stage", title: "s2", detail: "d", files: [{ path: "graph/builder.py", line: 3 }, { path: "graph/state.py", line: 1 }], branches: [] },
          { order: 3, kind: "stage", title: "s3", detail: "d", files: [{ path: "graph/nodes.py", line: 4 }, { path: "graph/hooks.py", line: 1 }], branches: [] },
          { order: 4, kind: "stage", title: "s4", detail: "d", files: [{ path: "utils/holder.py", line: 1 }], branches: [] },
          { order: 5, kind: "stage", title: "s5", detail: "d", files: [{ path: "utils/trace.py", line: 1 }], branches: [] }
        ],
        edges: [
          { from: 1, to: 2, origin: "inferred", evidence: "e12" },
          { from: 2, to: 3, origin: "inferred", evidence: "e23" },
          { from: 4, to: 5, origin: "inferred", evidence: "e45" }
        ],
        generatedAt: "2026-09-22T00:00:00.000Z"
      },
      provider: providerOf("[]", (input) => { seen = input; })
    });
    // 1→2、2→3 有端点落窗口内被问；4→5 两端权重最低落窗口外 → 跳过
    const payload = JSON.parse(seen!.user ?? "{}") as { edges: { from: number; to: number }[]; code: { path: string }[] };
    expect(payload.code.map((item) => item.path).sort()).toEqual(["graph/builder.py", "graph/nodes.py", "graph/state.py", "main.py", "web/app.py"]);
    expect(payload.edges.map((edge) => `${edge.from}:${edge.to}`)).toEqual(["1:2", "2:3"]);
    expect(result.flow.caveats).toContain("1 条因端点文件不在本次阅读窗口内未送核实");
    // 4→5 保持原样、依据不被空回复改写
    const skippedEdge = result.flow.edges.find((edge) => edge.from === 4 && edge.to === 5);
    expect(skippedEdge).toMatchObject({ origin: "inferred", evidence: "e45" });
  });
});
