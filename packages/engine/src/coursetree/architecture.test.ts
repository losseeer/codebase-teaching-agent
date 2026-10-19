import { realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TutorDatabase } from "../store/database.js";
import type { CourseTree, RepositoryAnalysis, RepositoryIndex, RepositoryOverlays } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { architectureInputOf, generateArchitectureCached, peekCachedArchitecture, aggregateModuleEdges } from "./architecture.js";

/**
  分层产物这层的测试全围着一条线打转：模型只许动判断题。
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
      // 没传就不带这个节点：产物缺这个节点是「还没采」，与「采了但没有」是两条不同的读数
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
  it("没配模型：不画伪装成分层的节点，source=unavailable 并说清缺什么", async () => {
    const plan = await generateArchitectureCached({ ...base, analysis: analysisOf() });
    expect(plan.source).toBe("unavailable");
    expect(plan.unavailableReason).toBe("no_model");
    expect(plan.reason).toContain("未配置模型");
    // 一个节点层都不画：以前这里回落成 tier 三档（主链路/基础设施/外围），读者会拿结构角色当职责分层讲
    expect(plan.layers).toEqual([]);
    expect(plan.edges).toEqual([]);
    // 事实那几个节点照给：节点清单是算出来的，没模型也照样读得到
    expect(plan.blocks?.map((block) => block.id)).toEqual(["module:src/api", "module:src/core", "module:src/db"]);
    expect(plan.overriddenUnits).toEqual([]);
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
    expect(plan.source).toBe("unavailable");
    expect(plan.unavailableReason).toBe("rejected");
    expect(plan.reason).toContain("不存在的模块");
    expect(plan.layers, "不采信就没有层：画一个节点假的比空着更糟").toEqual([]);

    const missing = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api"] }] }));
    const second = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: missing.provider });
    expect(second.source).toBe("unavailable");
    expect(second.reason).toContain("没被归层");
  });

  it("调用失败也回落，且不落缓存：下次还要再问", async () => {
    const provider: LlmProvider = { name: "stub", modelVersion: "stub-1", complete: async () => { throw new Error("402 余额不足"); } };
    const plan = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider });
    expect(plan.source).toBe("unavailable");
    expect(plan.unavailableReason).toBe("call_failed");
    expect(plan.reason).toContain("402");
  });

  it("同一份输入第二次不发请求；模型输出的用量照样记入审计", async () => {
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

  it("人工覆盖层生效：挪节点与改层名都落在读侧，且边按新归属重算", async () => {
    const { provider } = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api", "module:src/core"] }, { name: "数据", duty: "d", modules: ["module:src/db"] }] }));
    const moved = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider, overrides: { moduleLayer: { "module:src/core": "数据" }, layerRenames: { 接入: "入口层" } } });
    expect(moved.layers.find((layer) => layer.name === "入口层")?.moduleIds).toEqual(["module:src/api"]);
    // 挪进来的那个节点按节点原有顺序排，不是追加到末尾：顺序只影响读图，不做任何「谁在上谁在下」的宣称
    expect(moved.layers.find((layer) => layer.name === "数据")?.moduleIds).toEqual(["module:src/core", "module:src/db"]);
    expect(moved.overriddenUnits, "标记只落在被点名挪走的那个节点：收留它的「数据」层里其余节点没被动过").toEqual(["module:src/core"]);
    expect(moved.layers.find((layer) => layer.name === "入口层")?.overridden, "改名落在层上").toBe(true);
    expect(moved.layers.find((layer) => layer.name === "数据")?.overridden, "被挪进东西不等于这层被改过").toBeUndefined();
    // 模型原本把 api+core 放同一层；core 被人工挪到「数据」后 api→core 就成了跨层箭头（新冒出来的一条），
    // 而 core→db 变成同层内部关系，该消失。箭头跟着归属走，这条就是「拖动不花钱」的根据。
    expect(moved.edges).toEqual([{ fromLayer: "layer-1", toLayer: "layer-2", weight: 1, samplePaths: ["src/api.ts → src/core.ts"] }]);
  });

  it("外部栏只收词典认出来的；没采过这个节点的旧产物要在 reason 里说明", async () => {
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
      // ① 挪节点 + 改层名之后：读侧命中的还是那份原判，一发都不许多发
      //   （这条形状本来不是这样：覆盖层进键 ⇒ 拖一次翻一次键，而读侧无缓存就自发调用 = 每次拖动一笔没人确认的钱）
      const moved = await generateArchitectureCached({ ...input, overrides });
      expect(complete, "人工修正是覆盖，不是新证据：不许因此重问").toHaveBeenCalledTimes(1);
      expect(moved.source).toBe("llm");
      expect(moved.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([["入口层", ["module:src/api"]], ["数据", ["module:src/core", "module:src/db"]]]);
      // ② 落盘的必须是未叠修正的原判：把修正烤进缓存，下一次读会再叠第二遍，改名那类修正当场就对不上号了
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
      expect(complete, "打开画布是读取动作，不能顺带产生一笔无人确认的调用").not.toHaveBeenCalled();
      expect(peeked.source).toBe("unavailable");
      expect(peeked.unavailableReason).toBe("not_judged");
      expect(peeked.usage, "没发请求就不该有用量记入审计").toBeUndefined();
      expect(peeked.reason).toContain("还没判过层");
      expect(peeked.layers).toEqual([]);
      // 点了「重新生成分层」之后，同一份原判进缓存，读侧立刻恢复成模型判的那几层
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

  it("输入构造收成一处：存的课程树没带 tier 也要实时计算，读侧与写侧算的是同一个键", async () => {
    /**
      输入少叠一次 `annotateModuleTiers` 就会让每个模块的 tier 都成 periphery、两侧算出不同的键，
      peek 读不到判好的那份、校验层名只认得「外围」。这里按「存的树不带 tier」这个真实形状验读侧与写侧同键。
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
      expect(modules.find((node) => node.id === "module:src/api")?.tier, "含对外服务入口 ⇒ core：这个节点由构造函数补上，不靠存的树带").toBe("core");
      expect(architectureInputOf(args).overrides, "没有架构覆盖层就不给空对象：空对象也是一种「有人改过」的读数").toBeUndefined();
      const peek = peekCachedArchitecture({ ...architectureInputOf(args), provider });
      expect(peek.layers, "写侧 peek 读得到判好的那几层").toEqual(["接入", "数据"]);
      expect(complete, "peek 绝不发请求：为校验层名重判一发是把「挪一下模块」变成一笔钱").toHaveBeenCalledTimes(1);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aggregateModuleEdges", () => {
  it("重判后层名对不上：修正不落地，但必须说出来（不静默丢弃）", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-arch-lost-")));
    const database = new TutorDatabase(dir);
    try {
      const first = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api"] }, { name: "数据", duty: "d", modules: ["module:src/core", "module:src/db"] }] }));
      await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: first.provider, database });
      // 用户把 core 挪进「数据」——这一次是生效的
      const overrides = { moduleLayer: { "module:src/core": "数据" }, layerRenames: { 接入: "入口层" } };
      const hit = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: first.provider, database, overrides });
      expect(hit.lostOverrides, "层名还在，修正就该落地").toBeUndefined();
      expect(hit.layers.find((layer) => layer.name === "入口层")?.moduleIds).toEqual(["module:src/api"]);
      // 显式重问：模型换了叫法（不再有「数据」也不再有「接入」），两条修正同时落空
      const second = providerReturning(JSON.stringify({ layers: [{ name: "接口", duty: "d", modules: ["module:src/api", "module:src/core"] }, { name: "存储", duty: "d", modules: ["module:src/db"] }] }));
      await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: second.provider, database, force: true });
      const lost = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: second.provider, database, overrides });
      expect((lost.lostOverrides ?? []).map((loss) => loss.kind).sort()).toEqual(["move_module", "rename_layer"]);
      expect(lost.lostOverrides?.find((loss) => loss.kind === "move_module")).toMatchObject({ module: "module:src/core", layer: "数据" });
      expect(lost.lostOverrides?.find((loss) => loss.kind === "rename_layer")).toMatchObject({ from: "接入" });
      expect(lost.layers.map((layer) => [layer.name, layer.moduleIds]), "落不了地就不动它：宁可留在模型判的层里，也不凭空造一层")
        .toEqual([["接口", ["module:src/api", "module:src/core"]], ["存储", ["module:src/db"]]]);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("撤掉落空的修正之后横幅要跟着消失：读时实时计算的读数不许住在缓存行里", async () => {
    /* 落空读数必须每次覆写：重判那一刻修正还挂着，缓存行会把 `lostOverrides` 一起烤进去；
       读侧只在「这次也算出落空」时才覆写，撤干净之后旧值就从 `...stored.value` 漏出来继续点亮横幅。 */
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-arch-unlost-")));
    const database = new TutorDatabase(dir);
    try {
      const first = providerReturning(JSON.stringify({ layers: [{ name: "接入", duty: "d", modules: ["module:src/api"] }, { name: "数据", duty: "d", modules: ["module:src/core", "module:src/db"] }] }));
      await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: first.provider, database });
      const overrides = { moduleLayer: { "module:src/core": "业务编排" } };
      const second = providerReturning(JSON.stringify({ layers: [{ name: "接口", duty: "d", modules: ["module:src/api", "module:src/core"] }, { name: "存储", duty: "d", modules: ["module:src/db"] }] }));
      // 重判发生在修正还挂着的时候：这一发会把落空读数写进缓存行
      await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: second.provider, database, force: true, overrides });
      const stale = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: second.provider, database, overrides });
      expect(stale.lostOverrides?.map((loss) => loss.module), "修正对不上层名时如实报落空").toEqual(["module:src/core"]);
      const cleared = await generateArchitectureCached({ ...base, analysis: analysisOf(), provider: second.provider, database });
      expect(cleared.lostOverrides, "修正已经撤掉：横幅不能再被缓存行点亮").toBeUndefined();
      expect(cleared.overriddenUnits, "动过的节点也一样，撤干净就一个节点不亮").toEqual([]);
      expect(second.complete, "这两次都只读缓存：清横幅不该再花一发").toHaveBeenCalledTimes(1);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("共享文件挂在多个模块下时，每条文件级边按每个模块对各算一次：宁可重复也不丢往来", () => {
    const filesByModule = new Map([["m1", ["a.ts", "shared.ts"]], ["m2", ["b.ts", "shared.ts"]]]);
    const { pairs, totalEdges } = aggregateModuleEdges(filesByModule, { "a.ts": ["b.ts"], "b.ts": [] });
    expect(totalEdges).toBe(1);
    expect(pairs.get("m1>m2")?.weight).toBe(1);
  });
});

/**
  压缩流水线：没用的模块直接删除，能合的就合，剩下的才折叠。
  夹具刻意做成「三个同父小模块 + 一个入口 + 一个被四处引用的底座 + 一个没人理的造数脚本」：
  前三个节点该合成一块，最后一个节点该整个消失，而这一切都发生在问模型之前。
*/
function deepCourse(): CourseTree {
  const leaf = (id: string, title: string, paths: string[], tier: "core" | "facility" | "periphery") => ({
    id, title, summary: `${title}的职责`, kind: "module", tier, anchors: paths.map((path) => ({ path, line: 1, label: "实现" })), children: []
  });
  return {
    repositoryId: "repo", modelVersion: "fixture", generatedAt: "2026-10-16T00:00:00.000Z",
    root: {
      id: "root", title: "r", summary: "s", kind: "overview", anchors: [],
      children: [{
        id: "modules", title: "模块地图", kind: "overview", summary: "s", anchors: [],
        children: [
          leaf("module:src/http/api", "接口", ["src/http/api.ts"], "core"),
          leaf("module:a/x/one", "一", ["src/a/x/one.ts"], "core"),
          leaf("module:a/x/two", "二", ["src/a/x/two.ts"], "core"),
          leaf("module:a/x/three", "三", ["src/a/x/three.ts"], "facility"),
          leaf("module:a/y/tool", "工具", ["src/a/y/tool.ts", "src/a/y/util.ts"], "facility"),
          leaf("module:z/ghost", "造数脚本", ["src/z/ghost.ts"], "periphery")
        ]
      }]
    }
  } as unknown as CourseTree;
}

function deepAnalysis(): RepositoryAnalysis {
  return {
    repositoryId: "repo", generatedAt: "2026-10-16T00:00:00.000Z", versionStamp: "content:deep",
    graph: {
      imports: {
        "src/http/api.ts": ["src/a/x/one.ts", "src/a/y/tool.ts"],
        "src/a/x/one.ts": ["src/a/x/two.ts", "src/a/y/tool.ts"],
        "src/a/x/two.ts": ["src/a/x/three.ts", "src/a/y/tool.ts"],
        "src/a/x/three.ts": ["src/a/y/tool.ts"],
        "src/a/y/tool.ts": [],
        "src/z/ghost.ts": []
      },
      calls: [], symbols: [], entrypoints: [{ path: "src/http/api.ts", line: 1, label: "HTTP 路由 (Express)：/x" }],
      semanticBackend: "static", lspStatus: [], externals: {}
    },
    implementations: [], quality: { generatedAt: "2026-10-16T00:00:00.000Z", micro: [], macro: [] }
  } as unknown as RepositoryAnalysis;
}

const deepBase = { repositoryId: "repo", repositoryPath: "/repo", course: deepCourse(), index: INDEX, analysis: deepAnalysis() };
/** 模型要恰好把三个节点各归一层，否则整份作废——这本身就是「造模块/漏归」那条红线。 */
const THREE_LAYERS = JSON.stringify({ layers: [
  { name: "接入", duty: "把请求收进来", modules: ["module:src/http/api"] },
  { name: "核心", duty: "主链路", modules: ["arch:a/x:core"] },
  { name: "底座", duty: "被多处引用的工具", modules: ["module:a/y/tool"] }
] });

describe("架构图的节点压缩", () => {
  it("孤立节点模块不进图也不进载荷，同父同角色的小模块合成一个节点", async () => {
    const { provider, complete } = providerReturning(THREE_LAYERS);
    const plan = await generateArchitectureCached({ ...deepBase, provider });
    expect(plan.source).toBe("llm");
    expect(plan.sideModules, "没人引用、入口也走不到：这个节点整个不画，但读数留着").toBe(1);
    expect(plan.blocks?.map((block) => block.id), "六块原子模块压成三个节点").toEqual(["module:src/http/api", "arch:a/x:core", "module:a/y/tool"]);
    const merged = plan.blocks?.find((block) => block.id === "arch:a/x:core");
    expect(merged?.title).toBe("一、二、三");
    expect(merged?.members).toEqual(["module:a/x/one", "module:a/x/two", "module:a/x/three"]);
    expect(merged?.role, "id 带角色：同父不同角色的两组各自成块，不会撞名").toBe("core");
    const payload = JSON.parse((complete.mock.calls[0]?.[0] as { user: string }).user) as { modules: { id: string; parts: number; role: string }[] };
    expect(payload.modules.map((module) => module.id), "模型判的就是这三个节点，读者画的也是这三个节点").toEqual(["module:src/http/api", "arch:a/x:core", "module:a/y/tool"]);
    expect(payload.modules.find((module) => module.id === "arch:a/x:core")?.parts).toBe(3);
    expect(payload.modules.find((module) => module.id === "module:a/y/tool")?.role, "底座这个节点靠 fanIn/fanOut 认出来，模型看得见判据").toBe("shared");
    expect(JSON.stringify(payload), "孤立节点连进载荷都是白花 token").not.toContain("z/ghost");
  });

  it("组合节点带给模型的档位取成员里最高的那一档：一个设施成员不该把整块踩成外围", async () => {
    const { provider, complete } = providerReturning(THREE_LAYERS);
    const plan = await generateArchitectureCached({ ...deepBase, provider });
    expect(plan.source).toBe("llm");
    const payload = JSON.parse((complete.mock.calls[0]?.[0] as { user: string }).user) as { modules: { id: string; tier: string }[] };
    expect(payload.modules.find((module) => module.id === "arch:a/x:core")?.tier, "成员里 two 是 facility、one/three 是 core ⇒ 整块算 core").toBe("core");
    expect(plan.blocks?.length).toBe(3);
  });

  it("人工挪走组合节点里的一个成员：那块拆开，兄弟留在原层，谁都不被画两遍", async () => {
    const { provider } = providerReturning(THREE_LAYERS);
    const moved = await generateArchitectureCached({ ...deepBase, provider, overrides: { moduleLayer: { "module:a/x/two": "底座" } } });
    expect(moved.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([
      ["接入", ["module:src/http/api"]],
      ["核心", ["module:a/x/one", "module:a/x/three"]],
      ["底座", ["module:a/x/two", "module:a/y/tool"]]
    ]);
    const all = moved.layers.flatMap((layer) => layer.moduleIds);
    expect(new Set(all).size, "同一个节点不能同时出现在两层").toBe(all.length);
    expect(moved.lostOverrides, "成员 id 是合法修正：目标层在就该落地").toBeUndefined();
    expect(moved.overriddenUnits, "拆开后的标记只跟着被点名的成员走，兄弟和同层的 tool 都不该亮").toEqual(["module:a/x/two"]);
    // 读两次仍是同一份：拆块发生在读的时候实时计算，修正不进键、也不会越叠越歪
    const again = await generateArchitectureCached({ ...deepBase, provider, overrides: { moduleLayer: { "module:a/x/two": "底座" } } });
    expect(again.layers).toEqual(moved.layers);
  });

  it("整块挪层与「这个孤立节点不该藏」都走同一条通道", async () => {
    const { provider } = providerReturning(THREE_LAYERS);
    const moved = await generateArchitectureCached({ ...deepBase, provider, overrides: { moduleLayer: { "arch:a/x:core": "底座", "module:z/ghost": "接入" } } });
    expect(moved.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([
      ["接入", ["module:src/http/api", "module:z/ghost"]],
      // 成员全在同一层时它才继续是一个节点；「核心」空了就整层不占一栏
      ["底座", ["arch:a/x:core", "module:a/y/tool"]]
    ]);
    expect(moved.lostOverrides).toBeUndefined();
    expect(new Set(moved.overriddenUnits), "整个节点挪走标在块那个节点、点名的孤立节点标在它自己那个节点；同层没被动过的节点不亮").toEqual(new Set(["arch:a/x:core", "module:z/ghost"]));
  });

  it("整个节点挪走与只挪一个成员同时存在：块解散成单格，谁都不被画两遍", async () => {
    const { provider } = providerReturning(THREE_LAYERS);
    const moved = await generateArchitectureCached({ ...deepBase, provider, overrides: { moduleLayer: { "arch:a/x:core": "底座", "module:a/x/two": "接入" } } });
    const all = moved.layers.flatMap((layer) => layer.moduleIds);
    expect(new Set(all).size, "同一个节点出现在两层就是造假：拆开后宁可多几个单格").toBe(all.length);
    expect(all, "块里只要成员分了两层，这块就整体解散").not.toContain("arch:a/x:core");
    expect(moved.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([
      ["接入", ["module:src/http/api", "module:a/x/two"]],
      // 原判的「核心」被挪空 ⇒ 整层不占一栏；剩下的成员按原顺序落进各自的新层
      ["底座", ["module:a/x/one", "module:a/x/three", "module:a/y/tool"]]
    ]);
    expect(new Set(moved.overriddenUnits), "整块那次把三个成员都算成动过：标记跟着成员走，不跟着层走").toEqual(new Set(["module:a/x/one", "module:a/x/three", "module:a/x/two"]));
  });

  it("修正点名的 id 已经不在树上：不落地、也不造假节点，但要报进 lostOverrides", async () => {
    const { provider } = providerReturning(THREE_LAYERS);
    const moved = await generateArchitectureCached({ ...deepBase, provider, overrides: { moduleLayer: { "module:a/x/gone": "底座" } } });
    expect(moved.layers.flatMap((layer) => layer.moduleIds), "图上一个节点多加不出来").toEqual(["module:src/http/api", "arch:a/x:core", "module:a/y/tool"]);
    expect(moved.lostOverrides).toEqual([{ kind: "move_module", module: "module:a/x/gone", layer: "底座" }]);
  });
});
