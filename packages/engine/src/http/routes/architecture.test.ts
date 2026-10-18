import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteFixture, MAIN_FILE, type RouteFixture } from "./route-test-kit.js";

/**
  分析视图那组：分层产物（读侧 allowCall:false，regenerate 才花钱）、人工覆盖层的三条写路径、流程视图的只读出口、推荐入口的文档过滤。
  共用判据是「缓存存原判、覆盖层不进键、读侧永不发请求」。
 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("架构视图：分层产物与人工覆盖层", () => {
  it("读侧一发不发，只有 regenerate 花钱；模型给的箭头一个字都不进产物", async () => {
    type Plan = { layers: { name: string; moduleIds: string[] }[]; edges: unknown[]; externals: unknown[]; source: string; unavailableReason?: string; reason?: string; externalsNote?: string; usage?: unknown; blocks?: { id: string }[]; sideModules?: number };
    // ① 打开画布（GET）：这个仓还没判过层，路由必须只给静态三层，一次请求都不发
    const coldCalls = fx.sentTools.length;
    const cold = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/architecture` })).json() as Plan;
    expect(fx.sentTools.length, "读侧不许自己发一发：否则「打开画布」这个动作就静默产生一笔没人确认的钱").toBe(coldCalls);
    expect(cold.source).toBe("unavailable");
    expect(cold.unavailableReason).toBe("not_judged");
    expect(cold.layers, "没判过就一个节点都不画：以前这里塞的是按结构角色分的三层").toEqual([]);
    expect(cold.reason).toContain("还没判过层");
    expect(cold.usage).toBeUndefined();

    // ② 显式重问：这一发才是付费路径
    fx.scripted = [JSON.stringify({ layers: [
      { name: "接入", duty: "把请求收进来", modules: ["module:src"] },
      { name: "存储", duty: "落库", modules: [] }
    ], edges: [{ from: "接入", to: "存储", weight: 12 }] })];
    const regen = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/architecture/regenerate` });
    expect(regen.statusCode).toBe(200);
    expect(fx.sentTools.length, "付费那一下要真发出去").toBe(coldCalls + 1);
    const plan = regen.json() as Plan;
    expect(plan.layers.map((layer) => [layer.name, layer.moduleIds]), "模块为空的层不占一栏").toEqual([["接入", ["module:src"]]]);
    expect(plan.edges, "fixture 的图里没有跨模块 import 边，就该一条箭头都没有").toEqual([]);
    expect(JSON.stringify(plan.edges), "模型给的 12 权重箭头一个字都不许进产物").not.toContain("12");
    expect(plan.reason, "模型试图发明箭头这件事要留下读数").toContain("已丢弃");
    expect(plan.source).toBe("llm");
    expect(plan.externals).toEqual([]);
    expect(`${plan.externalsNote ?? ""}${plan.reason ?? ""}`, "旧产物没采过外部包名 ⇒ 那一栏为空必须给原因").toContain("还没采外部");

    // ③ 发明过边的那一份不落盘（payload 与产出不同构），所以下一次读还是静态——不发第二发
    const afterBad = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/architecture` })).json() as Plan;
    expect(fx.sentTools.length, "读侧仍然一发不发").toBe(coldCalls + 1);
    expect(afterBad.source).toBe("unavailable");

    // ④ 干净的一份判层落盘后，读侧命中缓存：同一笔钱不被计两次
    //    清单只有 `module:src` 一个节点：另一个模块（docs/design.md）没人引用、入口也走不到，压缩那处改动已经把它删了
    fx.scripted = [JSON.stringify({ layers: [{ name: "接入", duty: "把请求收进来", modules: ["module:src"] }] })];
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/architecture/regenerate` });
    expect(fx.sentTools.length).toBe(coldCalls + 2);
    const hit = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/architecture` })).json() as Plan;
    expect(fx.sentTools.length, "命中缓存不许再发").toBe(coldCalls + 2);
    expect(hit.source).toBe("llm");
    expect(hit.usage, "命中缓存不报用量").toBeUndefined();
    expect(hit.layers.map((layer) => layer.name)).toEqual(["接入"]);
    expect(hit.blocks?.map((block) => block.id), "节点清单是读的时候实时计算的，命中原判也照样带上").toEqual(["module:src"]);
    expect(hit.sideModules, "藏掉几个节点要有读数，不然界面与产物两头都问不出「这是全部还是筛过的」").toBe(1);
    expect(JSON.stringify(hit.blocks), "孤立节点不该连累付费载荷").not.toContain("module:docs");

    // ⑤ 被藏的那个节点也能靠一次修正回到图上（agent 说「这个文档不算孤立节点」的那条出口）
    const applied = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays/apply`, payload: { intent: { kind: "move_module", module: "module:docs", layer: "接入" }, via: "agent" } });
    expect(applied.statusCode, "把模块挪进现有层要写成功（失败原因看 response）").toBe(200);
    const rejected = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays/apply`, payload: { intent: { kind: "move_module", module: "module:src", layer: "图上没有的这一层" }, via: "agent" } });
    expect(rejected.statusCode).toBe(422);
    const body = rejected.json() as { text: string; error?: string };
    expect(body.error, "拒写理由要同时进 `error`：GUI 的 fetch 封装只认这个字段，不然用户只看到一句通用的「没送达」").toBe(body.text);
    const dragged = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/architecture` })).json() as Plan;
    expect(fx.sentTools.length, "挪一下不是重判的理由：为此翻缓存键就等于每次修正 ¥0.02 ¥0.02").toBe(coldCalls + 2);
    expect(dragged.source).toBe("llm");
    expect(dragged.layers.map((layer) => [layer.name, layer.moduleIds]), "原判只有一个节点，挪进来的那个节点跟着它").toEqual([["接入", ["module:src", "module:docs"]]]);
    // 撤掉修正：那个节点重新被藏起来，读侧回到原判，同样不发请求
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays/apply`, payload: { intent: { kind: "reset", module: "module:docs" }, via: "agent" } });
    const restored = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/architecture` })).json() as Plan;
    expect(fx.sentTools.length).toBe(coldCalls + 2);
    expect(restored.layers.map((layer) => [layer.name, layer.moduleIds])).toEqual([["接入", ["module:src"]]]);
    expect(restored.blocks?.map((block) => block.id), "节点清单是算出来的，判没判都在").toEqual(["module:src"]);

    // ⑥ 重判换了层名：落不了地的修正必须说出来（以前是一条无声的 continue）
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays/apply`, payload: { intent: { kind: "rename_layer", from: "接入", to: "入口层" }, via: "agent" } });
    fx.scripted = [JSON.stringify({ layers: [{ name: "接口与契约", duty: "对外与形状", modules: ["module:src"] }] })];
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/architecture/regenerate` });
    const stale = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/architecture` })).json() as Plan & { lostOverrides?: { kind: string; module?: string; layer?: string; from?: string }[] };
    expect(fx.sentTools.length, "失效读数是读的时候实时计算的，不该为它多发一发").toBe(coldCalls + 3);
    expect(stale.lostOverrides, "「接入」这个旧层名重判后没了 ⇒ 那次改名落空，要如实报").toEqual([{ kind: "rename_layer", from: "接入" }]);
    expect(stale.layers.map((layer) => layer.name), "落空就不动模块：只留模型判的那一层").toEqual(["接口与契约"]);
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays/apply`, payload: { intent: { kind: "reset", layerRename: "接入" }, via: "agent" } });
  });

  it("覆盖层写进去后 /course 看得见，撤掉之后回到引擎原判的那一档", async () => {
    const patched = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays`, payload: { modules: { tier: { "module:src": "core" } }, architecture: { moduleLayer: { "module:docs": "接入" } } } });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { overlays: { modules?: { tier?: Record<string, string> }; architecture?: { moduleLayer?: Record<string, string> } }; counts: { modules: number; layers: number } };
    expect(body.overlays.modules?.tier?.["module:src"]).toBe("core");
    expect(body.overlays.architecture?.moduleLayer?.["module:docs"]).toBe("接入");
    expect(body.counts).toEqual({ modules: 1, layers: 1 });

    const course = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/course` })).json() as { root: { children: { id: string; children: { id: string; tier?: string; tierGiven?: string; tierOverridden?: boolean }[] }[] } };
    const src = course.root.children.find((node) => node.id === "modules")!.children.find((node) => node.id === "module:src")!;
    expect(src.tier, "人工改的档要出现在这条出口上").toBe("core");

    const removed = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays`, payload: { remove: { modules: { tier: ["module:src"] }, architecture: { moduleLayer: ["module:docs"] } } } });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { counts: unknown }).counts).toEqual({ modules: 0, layers: 0 });
    const read = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/overlays` })).json() as { overlays: { modules?: { tier?: Record<string, string> } } };
    expect(read.overlays.modules?.tier ?? {}, "撤档要真删掉那条记录，不能留个空值").not.toHaveProperty("module:src");
  });
});

/**
  「推荐入口」这条路由以前只有 entry-suggest 的单测兜着（判据住在那一层）。这次补路由级用例是因为
  改的是**什么有资格当入口**：只有打一次路由才看得见送出去的候选载荷里真没有文档，而不只是本地算对了。
  零 token：假 provider 照样指向 127.0.0.1:9，被 stub 的 fetch 接住。
*/

describe("流程视图的只读出口（MCP 的 repo_flow 打的是这一条）", () => {
  type FlowResponse = { flow: { entry: { path: string }; title: string }; source: string; reason?: string };

  it("readonly=1 冷缓存一发不发、回静态调用链并说明原因；不带它的默认路由才会发模型", async () => {
    const before = fx.sentTools.length;
    const cold = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/flow?readonly=1&entry=${encodeURIComponent(MAIN_FILE)}` })).json() as FlowResponse;
    expect(fx.sentTools.length, "只读读数一发都不许发：外部 agent 问一句流程不该产生账单").toBe(before);
    expect(cold.source).toBe("static");
    expect(cold.reason).toContain("只读请求");
    expect(cold.flow.entry.path).toBe(MAIN_FILE);

    // 对照：同一个入口走默认那条路由，冷缓存确实会发一趟（这一发钱是界面上的流程视图点的）
    fx.scripted = ["这不是流程 JSON，解析不过——但请求已经发出去了"];
    const open = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/flow?entry=${encodeURIComponent(MAIN_FILE)}` });
    expect(open.statusCode).toBe(200);
    expect(fx.sentTools.length, "默认路由该发模型；否则这条对照测试什么都没说明").toBeGreaterThan(before);
  });
});

describe("推荐入口：文档不进候选清单", () => {
  it("文档在课程树上、却不在出网载荷里；模型回推它的 id 也不会被路由复活", async () => {
    const tree = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/course` })).payload;
    expect(tree, "前提：fixture 里得有那个文档节点，否则下面的「不含」是空的通过").toContain("docs/design.md");

    const outboundBefore = fx.sentTools.length;
    fx.scripted = ['["design"]', '[{"id":"unit-doc","reason":"设计文档正是主题入口"},{"id":"unit-1","reason":"实现主干"}]'];
    const response = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/module-entries?module=${encodeURIComponent("设计文档")}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: { id: string; path: string }[]; source: string };
    // 模型按旧习惯先推文档：池子里没有这个 id，路由只返回代码那条，而不是替它把文档复活
    expect(body.entries.map((entry) => entry.id)).toEqual(["unit-1"]);
    expect(body.source).toBe("llm");

    const outbound = fx.sentTools.slice(outboundBefore).map((call) => call.raw).join("\n");
    expect(outbound, "文档连候选都不是：不该进过一次出网载荷").not.toContain("docs/design.md");
    expect(outbound).toContain(MAIN_FILE);
    // 翻译层的词表同样来自池子：文档路径切出来的 design/md 不该进 repoVocabulary
    expect(fx.sentTools.slice(outboundBefore)[0].raw).not.toContain('"md"');
  });
});

/**
  ==== 画图工作区（2026-10-18，取代「重绘这张图」那条两趟烧钱的流水线）====

  打到路由才验得清的三件事，各自对应一条会被踩的线：
  1. **几何与结构权限不同**：`PUT .../geometry` 一天几百次，它必须**一版都不存、一行审计都不写、一帧都不广播**，
     否则真信号被淹掉、界面还会被自己刚拖的东西抢鼠标；
  2. **界面对结构只读**：这一组路由里没有任何一条能加删节点或连线，写只经 `set_diagram`。
     这条不对称是设计，测试把它钉住——顺手「补一个结构编辑接口」就等于把校验与审计抄成第二份（§71 的同一课）；
  3. **边的可信度只降不升**：agent 嘴上说 `static`，引擎拿 import / 调用 / 类型派发三张表核，核不到就降，
     并把为什么写在 `downgraded` 上。这一条只能端到端看：它穿过工具回执、落盘、审计三处。

  零 token：种图走 `store/diagrams.ts`（那是唯一的读写口，路由写不了结构，测试也只能从这儿起步），
  模型侧仍然是 stub 掉的 `fetch`。
*/
describe("LLM 工作日志的账面一致性", () => {
  it("每次 provider 调用追加一行，threadId 与本文件用过的线程全等，失败只允许是中止", async () => {
    await fx.verifyLlmLog({ expectAborted: false, scenes: undefined });
  });
});
