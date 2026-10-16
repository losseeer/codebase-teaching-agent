import { realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TutorDatabase } from "../store/database.js";
import type { CourseTree, RepositoryAnalysis, RepositoryIndex, RepositoryOverlays } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { architectureInputOf, generateArchitectureCached, peekCachedArchitecture, aggregateModuleEdges } from "./architecture.js";

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

  it("人工修正不进键也不花钱：拖动后仍读同一份原判，修正只在真判时进请求", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-arch-key-")));
    const database = new TutorDatabase(dir);
    try {
      const { provider, complete } = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api", "module:src/core"] }, { name: "数据", duty: "d", modules: ["module:src/db"] }] }));
      const input = { ...base, analysis: analysisOf(), provider, database };
      await generateArchitectureCached(input);
      expect(complete).toHaveBeenCalledTimes(1);
      const overrides = { moduleLayer: { "module:src/core": "数据" }, layerRenames: { 接入: "入口层" } };
      // ① 拖动换层 + 改层名之后：读侧命中的还是那份原判，一發都不许多发
      //   （这条形状本来不是这样：覆盖层进键 ⇒ 拖一次翻一次键，而读侧无缓存就自发调用 = 每次拖动一笔没人确认的钱）
      const moved = await generateArchitectureCached({ ...input, overrides });
      expect(complete, "人工修正是覆盖，不是新证据：不许因此重问").toHaveBeenCalledTimes(1);
      expect(moved.source).toBe("llm");
      expect(moved.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([["入口层", ["module:src/api"]], ["数据", ["module:src/db", "module:src/core"]]]);
      // ② 落盘的必须是**未叠修正的原判**：把修正烤进缓存，下一次读会再叠第二遍，改名那类修正当场就对不上号了
      const bare = await generateArchitectureCached(input);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(bare.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([["接入", ["module:src/api", "module:src/core"]], ["数据", ["module:src/db"]]]);
      // ③ 显式重问时用户的意见在请求里：下一次判断要看得见
      await generateArchitectureCached({ ...input, overrides, force: true });
      expect(complete).toHaveBeenCalledTimes(2);
      const sent = JSON.stringify(complete.mock.calls[1]?.[0] ?? {});
      expect(sent).toContain("userOverrides");
      expect(sent).toContain("接口层");
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("读侧（allowCall: false）没有缓存行也不发请求：给静态三层并说清那一发怎么花", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-arch-peek-")));
    const database = new TutorDatabase(dir);
    try {
      const { provider, complete } = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api", "module:src/core", "module:src/db"] }] }));
      const peeked = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider, database, allowCall: false });
      expect(complete, "打开画布是读取动作，不能顺手产生一笔无人确认的调用").not.toHaveBeenCalled();
      expect(peeked.source).toBe("static");
      expect(peeked.usage, "没发请求就不该有用量入账").toBeUndefined();
      expect(peeked.reason).toContain("还没判过层");
      expect(peeked.layers.map((layer) => layer.name)).toEqual(["主干", "设施"]);
      // 点了「重新分层」之后，同一份原判进缓存，读侧立刻恢复成模型判的那几层
      await generateArchitectureCached({ ...base, analysis: analysisOf(), provider, database });
      expect(complete).toHaveBeenCalledTimes(1);
      const after = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider, database, allowCall: false });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(after.source).toBe("llm");
      expect(after.layers.map((layer) => layer.name)).toEqual(["接入"]);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("输入构造收成一处：存的课程树没带 tier 也要现算，读侧与写侧算的是同一个键", async () => {
    /**
      这条是 2026-10-16 浏览器实测留下的回归位。`/overlays/apply` 以前自己拼了一遍输入、少叠 `annotateModuleTiers`，
      于是 payload 里每个模块的 tier 都成 periphery ⇒ 算出的键和读侧不是同一个 ⇒ peek 读不到判好的那份 ⇒
      校验层名时只认得「外围」，真仓上每一次拖动都被自己的校验拒成 422。
      现在四个入口共用 `architectureInputOf`，就按「存的树不带 tier」这个真实形状验两边同键。
      */
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-arch-input-")));
    const database = new TutorDatabase(dir);
    try {
      const raw = courseOf();
      raw.root.children.find((node) => node.id === "modules")!.children.forEach((node) => { delete node.tier; });
      const args = { repositoryId: "repo", repositoryPath: "/repo", course: raw, analysis: analysisOf(), index: INDEX, database, overlays: {} as RepositoryOverlays };
      const { provider, complete } = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api", "module:src/core"] }, { name: "数据", duty: "d", modules: ["module:src/db"] }] }));
      const generated = await generateArchitectureCached({ ...architectureInputOf(args), provider });
      expect(generated.source).toBe("llm");
      expect(complete).toHaveBeenCalledTimes(1);
      const modules = architectureInputOf(args).course.root.children.find((node) => node.id === "modules")!.children;
      expect(modules.find((node) => node.id === "module:src/api")?.tier, "含对外服务入口 ⇒ core：这一格由构造函数补上，不靠存的树带").toBe("core");
      expect(architectureInputOf(args).overrides, "没有架构覆盖层就不给空对象：空对象也是一种「有人改过」的读数").toBeUndefined();
      const peek = peekCachedArchitecture({ ...architectureInputOf(args), provider });
      expect(peek.layers, "写侧 peek 读得到判好的那几层，不是静态的「外围」").toEqual(["接入", "数据"]);
      expect(complete, "peek 绝不发请求：为校验层名烧一发重判是把「挪一下模块」变成一笔钱").toHaveBeenCalledTimes(1);
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
