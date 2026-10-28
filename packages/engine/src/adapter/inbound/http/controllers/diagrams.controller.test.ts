import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Diagram, DiagramBody, DiagramSummary } from "@codebase-tutor/domain";

import { createRouteFixture, OK_REPLY, type RouteFixture } from "../controller-test-kit.js";
import { TutorDatabase } from "../../../outbound/persistence/database.js";
import { buildDiagram, diagramId } from "@codebase-tutor/domain";
import { applyStructure } from "../../../outbound/persistence/diagrams.js";

/** 画图工作区：图库的建/改名/删/恢复、几何只写位置、结构归 agent 的 `set_diagram`。这组用例钉「界面发不出结构改动」。 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("画图工作区：图库、几何只存位置、结构归 agent", () => {
  const base = () => `/api/repositories/${fx.repositoryId}/diagrams`;
  type Single = { diagram: Diagram; warnings?: { node: string; reason: string }[] };

  const nodeOf = (id: string, ref: string, label: string): { id: string; kind: "module"; label: string; ref: string; x: number; y: number } => ({ id, kind: "module", label, ref, x: 40, y: 60 });
  const fixtureBody = (): DiagramBody => ({
    groups: [{ id: "g-1", label: "仓内写的", x: 20, y: 20, w: 400, h: 300 }],
    nodes: [nodeOf("n-src", "file:src/main.ts", "注册实现"), nodeOf("n-doc", "dir:src", "源码目录")],
    edges: [{ id: "e-1", from: "n-src", to: "n-doc", origin: "inferred" }]
  });

  /** 从存储层种一张图（带第一版）：结构与名字由 fixture 定。 */
  let seeded = 0;
  function seed(name: string, body: DiagramBody = fixtureBody()): Diagram {
    const database = new TutorDatabase(fx.repoDir);
    try {
      // id 由调用方发：这里按种图次序编号
      const draft = buildDiagram(fx.repositoryId, { id: diagramId(`route-fixture-${(seeded += 1)}`), name, source: "agent", body });
      return applyStructure(database, draft, draft.body, "fixture 初版");
    } finally {
      database.close();
    }
  }

  const read = async (diagramId: string): Promise<Single> => (await fx.app.inject({ method: "GET", url: `${base()}/${diagramId}` })).json() as Single;

  it("建一张空白图：source=me、没有版本可回，列表只给摘要不给结构", async () => {
    const created = await fx.app.inject({ method: "POST", url: base(), payload: { name: "我的草稿" } });
    expect(created.statusCode).toBe(200);
    const blank = (created.json() as Single).diagram;
    expect(blank.source, "用户自己点「+」建的，徽标就得是「我建的」而不是 agent 画的").toBe("me");
    expect(blank.body).toEqual({ groups: [], nodes: [], edges: [] });
    expect(blank.versions, "还没有结构可回，第一版都不存").toEqual([]);
    expect(fx.lastEvent("diagram_created").payload).toMatchObject({ diagram: blank.id, name: "我的草稿", source: "me", nodes: 0, edges: 0, via: "user" });

    const listed = (await fx.app.inject({ method: "GET", url: base() })).json() as { diagrams: (DiagramSummary & { body?: unknown })[] };
    expect(listed.diagrams.map((item) => item.id)).toContain(blank.id);
    for (const item of listed.diagrams) {
      expect(item, "左栏只要摘要：把整张图的结构拖进列表就是每次切仓都传一遍产物").not.toHaveProperty("body");
      expect(item).toMatchObject({ nodes: expect.any(Number), edges: expect.any(Number), versions: expect.any(Number) });
    }
  });

  it("同名图建不出来（加序号），改名撞车则直接拒：图库靠名字认图", async () => {
    seed("系统分层总览");
    const second = (await fx.app.inject({ method: "POST", url: base(), payload: { name: "系统分层总览" } })).json() as Single;
    expect(second.diagram.name, "两张同名会让「改那张登录流程」这句话没有答案，所以不允许它发生").toBe("系统分层总览（2）");

    const doomed = seed("换个名试试");
    const taken = await fx.app.inject({ method: "PATCH", url: `${base()}/${doomed.id}`, payload: { name: "系统分层总览" } });
    expect(taken.statusCode).toBe(400);
    expect((taken.json() as { reason?: string }).reason).toBe("name_taken");
    expect((await read(doomed.id)).diagram.name, "被拒之后名字没动").toBe("换个名试试");
  });

  it("改名不存版本；一个字都没改时 400 说清是哪一种", async () => {
    const seeded = seed("待改名");
    const renamed = await fx.app.inject({ method: "PATCH", url: `${base()}/${seeded.id}`, payload: { name: "  改过的名字  " } });
    expect(renamed.statusCode).toBe(200);
    const after = (renamed.json() as Single).diagram;
    expect(after.name, "空白收口在写侧，界面不必自己 trim").toBe("改过的名字");
    expect(after.versions, "改名不动结构：把它记进版本历史会把「回到那一版」这件事弄脏").toHaveLength(1);
    expect(fx.lastEvent("diagram_renamed").payload).toMatchObject({ diagram: seeded.id, from: "待改名", to: "改过的名字" });

    const unchanged = await fx.app.inject({ method: "PATCH", url: `${base()}/${seeded.id}`, payload: { name: "改过的名字" } });
    expect(unchanged.statusCode).toBe(400);
    expect((unchanged.json() as { reason?: string }).reason).toBe("name_unchanged");
    const empty = await fx.app.inject({ method: "PATCH", url: `${base()}/${seeded.id}`, payload: { name: "   " } });
    expect((empty.json() as { reason?: string }).reason, "「没改动」与「名字空了」是两种处置，界面得能分开说").toBe("name_empty");
  });

  it("拖动位置：只改坐标，一版不存、一行审计不写；图上没有的 id 被跳过而不是被造出来", async () => {
    const seeded = seed("拖一下");
    const editedBefore = fx.eventsOf("diagram_edited").length;
    const createdBefore = fx.eventsOf("diagram_created").length;
    const response = await fx.app.inject({ method: "PUT", url: `${base()}/${seeded.id}/geometry`, payload: { positions: [{ id: "n-src", x: 320.6, y: 115.4 }, { id: "图上根本没有的节点", x: 1, y: 1 }] } });
    expect(response.statusCode).toBe(200);
    const moved = (response.json() as Single).diagram;
    expect(moved.body.nodes.find((item) => item.id === "n-src")).toMatchObject({ x: 321, y: 115, label: "注册实现" });
    expect(moved.body.nodes).toHaveLength(2);
    expect(moved.versions, "位置不承载对错：几百次拖动不该攒出几百版历史").toHaveLength(seeded.versions.length);
    expect(moved.body.edges, "结构一格都不许动").toEqual(seeded.body.edges);
    expect(fx.eventsOf("diagram_edited")).toHaveLength(editedBefore);
    expect(fx.eventsOf("diagram_created")).toHaveLength(createdBefore);
  });

  it("恢复历史版本也是往前追加一版；下标越界 400，行也确实删得掉", async () => {
    const seeded = seed("要看历史");
    const restored = await fx.app.inject({ method: "POST", url: `${base()}/${seeded.id}/restore`, payload: { index: 0 } });
    expect(restored.statusCode).toBe(200);
    const after = (restored.json() as Single).diagram;
    expect(after.versions, "恢复本身也存一版，历史只追加不改写").toHaveLength(2);
    expect(after.versions[1]!.note).toContain("恢复到");
    expect(after.body, "恢复到的就是那一版的结构").toEqual(seeded.body);
    expect(fx.lastEvent("diagram_restored").payload).toMatchObject({ diagram: seeded.id, to: 0 });

    const outOfRange = await fx.app.inject({ method: "POST", url: `${base()}/${seeded.id}/restore`, payload: { index: 9 } });
    expect(outOfRange.statusCode).toBe(400);
    expect((outOfRange.json() as { reason?: string }).reason).toBe("version_missing");
    const notANumber = await fx.app.inject({ method: "POST", url: `${base()}/${seeded.id}/restore`, payload: { index: "0" } });
    expect(notANumber.statusCode, "字符串下标不收：JSON 里 index 写成品类就得拒，不能自己猜成数字").toBe(400);

    const doomed = seed("要删的那张");
    const removed = await fx.app.inject({ method: "DELETE", url: `${base()}/${doomed.id}` });
    expect(removed.json()).toMatchObject({ deleted: true, diagramId: doomed.id });
    expect(fx.lastEvent("diagram_deleted").payload, "版本历史一起没了，所以这行要留得下名字与版数").toMatchObject({ diagram: doomed.id, name: "要删的那张", versions: 1 });
    const missing = await fx.app.inject({ method: "GET", url: `${base()}/${doomed.id}` });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { reason?: string }).reason).toBe("diagram_not_found");
    const listed = (await fx.app.inject({ method: "GET", url: base() })).json() as { diagrams: DiagramSummary[] };
    expect(listed.diagrams.map((item) => item.id)).not.toContain(doomed.id);
    const database = new TutorDatabase(fx.repoDir);
    try {
      expect(database.diagrams.byId(fx.repositoryId, doomed.id), "只删行：别留一张读不出来的半个图").toBeUndefined();
    } finally {
      database.close();
    }
    expect((await fx.app.inject({ method: "DELETE", url: `${base()}/${doomed.id}` })).statusCode, "删第二次的 404 与「图本来就没有」同一口径，不装作又删成功一次").toBe(404);
  });

  it("读侧报出断掉的引用；界面这条路对结构一个字段都写不进去", async () => {
    const stale = seed("引用过期的那张", { groups: [], nodes: [{ id: "n-gone", kind: "module", label: "已经不在索引里的模块", ref: "file:src/被删掉的那个.ts", x: 10, y: 10 }], edges: [] });
    const warning = await read(stale.id);
    expect(warning.warnings).toEqual([{ node: "n-gone", reason: expect.stringContaining("核不上") }]);

    const seeded = seed("结构不归界面");
    const attempted = await fx.app.inject({ method: "PATCH", url: `${base()}/${seeded.id}`, payload: { name: "还是只有名字能改", edit: { action: "add_node", node: nodeOf("n-extra", "file:src/main.ts", "界面偷偷加的节点") } } });
    expect(attempted.statusCode, "改名这一支照样成功：它不动结构").toBe(200);
    const after = await read(seeded.id);
    expect(after.diagram.name).toBe("还是只有名字能改");
    expect(after.diagram.body.nodes.map((item) => item.id), "PATCH 只改名：这一组路由里没有任何一条能表达「加个节点」，body 里的 edit 一格都不看").toEqual(["n-src", "n-doc"]);
    expect(after.diagram.body.edges).toHaveLength(1);
    const geometry = await fx.app.inject({ method: "PUT", url: `${base()}/${seeded.id}/geometry`, payload: { positions: "不合法" } });
    expect(geometry.statusCode, "positions 不是数组就拒：宁可让界面重发一次，也不把半个坐标写进图").toBe(400);
  });

  it("agent 连一条声称 static 的边：引擎核不到就降档，落盘、回执、审计三处说的是同一件事", async () => {
    const seeded = seed("边要说清依据", { groups: [], nodes: [nodeOf("n-src", "file:src/main.ts", "注册实现"), nodeOf("n-doc", "dir:src", "源码目录")], edges: [] });
    const threadId = await fx.newThread("map", "改图线程");
    const before = fx.sentTools.length;
    fx.scripted = [
      `@@tool set_diagram ${JSON.stringify({ diagram: seeded.id, edit: { action: "add_edge", edge: { id: "e-ghost", from: "n-src", to: "n-doc", origin: "static", label: "读文档" } } })}`,
      OK_REPLY
    ];
    const turn = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: "把实现到说明那条依赖画上", threadId, diagramId: seeded.id } });
    expect(turn.statusCode).toBe(200);

    expect(fx.sentTools[before]?.names).toContain("set_diagram");
    expect(fx.sentTools[before]?.raw, "有副作用的工具必须先看见现状：有哪几张图、正打开那张的图元 id").toContain("画布现场");
    expect(fx.sentTools[before]?.raw, "用户那句「这条边」指的是他眼前那张，不是最近更新那张").toContain("画布上正打开的这张");
    expect(fx.sentTools[before + 1]?.raw ?? "", "回喂给模型的是实际落盘后的状态：这条边被降了档").toContain("降档");

    const edge = (await read(seeded.id)).diagram.body.edges.find((item) => item.id === "e-ghost");
    expect(edge?.origin, "fixture 的图里这一对模块之间没有 import、没有调用：static 这个说法核不到").toBe("inferred");
    expect(edge?.downgraded ?? "", "为什么不算这一格要留下，界面在悬停里读它，不替模型圆").toContain("模型报的是 static");
    expect(fx.lastEvent("diagram_edited").payload).toMatchObject({ diagram: seeded.id, action: "add_edge", downgraded: 1, via: "agent" });
    expect(fx.sentTools.length, "这一轮只发了对话本身那两趟：改图一格模型都不发").toBe(before + 2);
  });
});
describe("LLM 工作日志的账面一致性", () => {
  it("每次 provider 调用追加一行，threadId 与本文件用过的线程全等，失败只允许是中止", async () => {
    await fx.verifyLlmLog({ expectAborted: false, scenes: undefined });
  });
});
