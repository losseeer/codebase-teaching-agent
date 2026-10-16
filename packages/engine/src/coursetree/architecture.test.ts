import { realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TutorDatabase } from "../store/database.js";
import type { CourseTree, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { generateArchitectureCached, aggregateModuleEdges } from "./architecture.js";

/**
  分层产物这层的测试全围着一条线打转：**模型只许动判断题**。
  所以每个用例都同时断言两件事——层怎么分（可以是模型说的），以及箭头/外部栏的数（只能是算出来的，模型说什么都不算）。
*/
const INDEX = {
  repositoryId: "repo", repositoryPath: "/repo", scannedAt: "2026-10-16T00:00:00.000Z", totalFiles: 3, totalLines: 90,
  files: [{ path: "src/api.ts", extension: ".ts", bytes: 30, lines: 30 }, { path: "src/core.ts", extension: ".ts", bytes: 30, lines: 30 }, { path: "src/db.ts", extension: ".ts", bytes: 30, lines: 30 }],
  fileTree: [], hotspots: [{ path: "src/api.ts", changes: 7 }]
} as unknown as RepositoryIndex;

function courseOf(): CourseTree {
  return {
    repositoryId: "repo", modelVersion: "fixture", generatedAt: "2026-10-16T00:00:00.000Z",
    root: {
      id: "root", title: "r", summary: "s", kind: "overview", anchors: [],
      children: [{
        id: "modules", title: "模块地图", kind: "overview", summary: "s", anchors: [],
        children: [
          { id: "module:src/api", title: "接口层", summary: "HTTP 入口", kind: "module", tier: "core", anchors: [{ path: "src/api.ts", line: 1, label: "入口" }], children: [] },
          { id: "module:src/core", title: "编排", summary: "主流程", kind: "module", tier: "core", anchors: [{ path: "src/core.ts", line: 1, label: "实现" }], children: [] },
          { id: "module:src/db", title: "存储", summary: "落库", kind: "module", tier: "facility", anchors: [{ path: "src/db.ts", line: 1, label: "实现" }], children: [] }
        ]
      }]
    }
  } as unknown as CourseTree;
}

function analysisOf(externals?: Record<string, string[]>): RepositoryAnalysis {
  return {
    repositoryId: "repo", generatedAt: "2026-10-16T00:00:00.000Z", versionStamp: "content:fixture",
    graph: {
      imports: { "src/api.ts": ["src/core.ts"], "src/core.ts": ["src/db.ts"], "src/db.ts": [] },
      calls: [], symbols: [], entrypoints: [{ path: "src/api.ts", line: 1, label: "HTTP 路由 (Express)：/x" }],
      semanticBackend: "static", lspStatus: [],
      // 没传就**不带这一格**：旧产物缺这格是「还没采」，与「采了但没有」是两条不同的读数
      ...(externals ? { externals } : {})
    },
    implementations: [], quality: { generatedAt: "2026-10-16T00:00:00.000Z", micro: [], macro: [] }
  } as unknown as RepositoryAnalysis;
}

function providerReturning(text: string): { provider: LlmProvider; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (_input: LlmCompletionInput): Promise<LlmCompletion> => ({ text, usage: { inputTokens: 900, outputTokens: 120 }, finishReason: "stop" }));
  return { provider: { name: "stub", modelVersion: "stub-1", complete }, complete };
}

const base = { repositoryId: "repo", repositoryPath: "/repo", course: courseOf(), index: INDEX };

describe("generateArchitectureCached", () => {
  it("没配模型：静态三层、source=static、reason 说清是谁算的，不发请求", async () => {
    const plan = await generateArchitectureCached({ ...base, analysis: analysisOf() });
    expect(plan.source).toBe("static");
    expect(plan.reason).toContain("未配置模型");
    expect(plan.layers.map((layer) => layer.name)).toEqual(["主干", "设施"]);
    expect(plan.layers.find((layer) => layer.name === "主干")?.moduleIds).toEqual(["module:src/api", "module:src/core"]);
  });

  it("模型分的层生效，但箭头仍由 import 算：模型给的 edges 一律不被采信", async () => {
    const { provider, complete } = providerReturning(JSON.stringify({
      layers: [
        { name: "接入", duty: "把请求收进来", modules: ["module:src/api"] },
        { name: "核心", duty: "业务编排", modules: ["module:src/core"] },
        { name: "数据", duty: "读写落库", modules: ["module:src/db"] }
      ],
      edges: [{ fromLayer: "接入", toLayer: "数据", weight: 99 }],
      files: ["src/ghost.ts"]
    }));
    const plan = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider });
    expect(plan.source).toBe("llm");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(plan.layers.map((layer) => layer.name)).toEqual(["接入", "核心", "数据"]);
    // 真实的只有 import 链上那两条，权重各 1；模型那条 99 权重的箭头一个字都不许进图
    expect(plan.edges).toEqual([
      { fromLayer: "layer-1", toLayer: "layer-2", weight: 1, samplePaths: ["src/api.ts → src/core.ts"] },
      { fromLayer: "layer-2", toLayer: "layer-3", weight: 1, samplePaths: ["src/core.ts → src/db.ts"] }
    ]);
    expect(JSON.stringify(plan.edges)).not.toContain("99");
    expect(JSON.stringify(plan)).not.toContain("ghost");
    // 事实字段出现过 ⇒ 这份不落盘（同一次重问才收敛），但层归属仍可用
    expect(plan.reason).toContain("已丢弃");
    // 顶层摆的 edges/files 也被数进「丢过事实字段」：模型试图发明箭头这件事必须留下读数
    expect(plan.source).toBe("llm");
  });

  it("模型造模块 / 漏归模块：整份作废，回落静态三层并说清是哪条不合格", async () => {
    const invented = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api", "module:src/ghost"] }, { name: "其余", duty: "d", modules: ["module:src/core", "module:src/db"] }] }));
    const plan = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: invented.provider });
    expect(plan.source).toBe("static");
    expect(plan.reason).toContain("不存在的模块");

    const missing = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api"] }] }));
    const second = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: missing.provider });
    expect(second.source).toBe("static");
    expect(second.reason).toContain("没被归层");
  });

  it("调用失败也回落，且不落缓存：下次还要再问", async () => {
    const provider: LlmProvider = { name: "stub", modelVersion: "stub-1", complete: async () => { throw new Error("402 余额不足"); } };
    const plan = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider });
    expect(plan.source).toBe("static");
    expect(plan.reason).toContain("402");
  });

  it("同一份输入第二次不发请求；模型输出的用量照样入账", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-arch-cache-")));
    const database = new TutorDatabase(dir);
    try {
      const { provider, complete } = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api", "module:src/core"] }, { name: "数据", duty: "d", modules: ["module:src/db"] }] }));
      const input = { ...base, analysis: analysisOf(), provider, database };
      const first = await generateArchitectureCached(input);
      expect(first.usage).toMatchObject({ inputTokens: 900, outputTokens: 120 });
      const second = await generateArchitectureCached(input);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(second.usage, "命中缓存不报用量：同一笔钱不被计两次").toBeUndefined();
      expect(second.layers).toEqual(first.layers);
      // force 是显式重问：必须真发第二发
      await generateArchitectureCached({ ...input, force: true });
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("人工覆盖层生效：拖动换层与改层名都落在读侧，且边按新归属重算", async () => {
    const { provider } = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api", "module:src/core"] }, { name: "数据", duty: "d", modules: ["module:src/db"] }] }));
    const moved = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider, overrides: { moduleLayer: { "module:src/core": "数据" }, layerRenames: { 接入: "入口层" } } });
    expect(moved.layers.find((layer) => layer.name === "入口层")?.moduleIds).toEqual(["module:src/api"]);
    expect(moved.layers.find((layer) => layer.name === "数据")?.moduleIds).toEqual(["module:src/db", "module:src/core"]);
    expect(moved.overriddenLayers).toContain("layer-1");
    // 模型原本把 api+core 放同一层；core 被人工挪到「数据」后 api→core 就成了跨层箭头（新冒出来的一条），
    // 而 core→db 变成同层内部关系，该消失。箭头跟着归属走，这条就是「拖动不花钱」的根据。
    expect(moved.edges).toEqual([{ fromLayer: "layer-1", toLayer: "layer-2", weight: 1, samplePaths: ["src/api.ts → src/core.ts"] }]);
  });

  it("外部栏只收词典认出来的；没采过这一格的旧产物要在 reason 里说明", async () => {
    const { provider } = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api"] }, { name: "核心", duty: "d", modules: ["module:src/core"] }, { name: "数据", duty: "d", modules: ["module:src/db"] }] }));
    const plan = await generateArchitectureCached({ ...base, analysis: analysisOf({ "src/db.ts": ["org.springframework.data.redis", "java.util.List"], "src/api.ts": ["some_obscure_lib"] }), provider });
    expect(plan.externals.map((row) => row.display)).toEqual(["Redis（spring-data-redis）"]);
    expect(plan.externals[0].usedBy).toBe(1);
    // 标准库与未识别都不画进图，但要能报出数：界面得说「还有 N 类没画」
    expect(plan.collapsedExternals).toBe(2);
    const legacy = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider });
    expect(legacy.externals).toEqual([]);
    expect(legacy.source).toBe("llm");
  });

  it("覆盖层进缓存键：同一次判层，改档之后必须重问（人的意见要影响下一次的判断）", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-arch-key-")));
    const database = new TutorDatabase(dir);
    try {
      const { provider, complete } = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api", "module:src/core", "module:src/db"] }] }));
      await generateArchitectureCached({ ...base, analysis: analysisOf(), provider, database });
      await generateArchitectureCached({ ...base, analysis: analysisOf(), provider, database, overrides: { moduleLayer: { "module:src/db": "接入" } } });
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aggregateModuleEdges", () => {
  it("共享文件挂在多个模块下时，每条文件级边按每个模块对各算一次：宁可重复也不丢往来", () => {
    const filesByModule = new Map([["m1", ["a.ts", "shared.ts"]], ["m2", ["b.ts", "shared.ts"]]]);
    const { pairs, totalEdges } = aggregateModuleEdges(filesByModule, { "a.ts": ["b.ts"], "b.ts": [] });
    expect(totalEdges).toBe(1);
    expect(pairs.get("m1>m2")?.weight).toBe(1);
  });
});
