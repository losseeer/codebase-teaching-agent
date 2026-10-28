import { mkdirSync, readdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Diagram, DiagramBody, JournalEventType, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

import { TutorDatabase } from "../adapter/outbound/persistence/database.js";
import { buildDiagram, DIAGRAM_VERSION_LIMIT, diagramId } from "@codebase-tutor/domain";
import { applyStructure, diagramStoreFor, listDiagrams, readDiagram, restoreVersion } from "../adapter/outbound/persistence/diagrams.js";
import { applyDiagramEdit, diagramInventoryFor, diagramWarnings, parseDiagramEditArguments, type DiagramWriteContext } from "./set-diagram.js";

/**
  画布结构写入口的测试，每条对着一条会被踩的线。
  查无此人不落笔；边的可信度只降不升；删节点连带清边、删框连带清归属；版本历史只追加。
*/

const REPO = "repo_diagram_fixture";
const root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-set-diagram-")));

const index = {
  repositoryId: REPO, repositoryPath: root, scannedAt: "2026-10-18T00:00:00.000Z", totalFiles: 3, totalLines: 120,
  files: [
    { path: "src/api.ts", extension: ".ts", bytes: 1, lines: 40 },
    { path: "src/core.ts", extension: ".ts", bytes: 1, lines: 50 },
    { path: "src/db.ts", extension: ".ts", bytes: 1, lines: 30 }
  ],
  fileTree: [], hotspots: []
} as RepositoryIndex;

/** import 链只有一条：api → core → db。边上报的其它说法都得在这里撞墙。 */
const analysis = {
  repositoryId: REPO, generatedAt: "2026-10-18T00:00:00.000Z", versionStamp: "content:fixture",
  graph: {
    imports: { "src/api.ts": ["src/core.ts"], "src/core.ts": ["src/db.ts"], "src/db.ts": [] },
    calls: [],
    symbols: [{ id: "sym-1", name: "registerOrder", kind: "function", path: "src/api.ts", line: 1, endLine: 4, parameters: [], language: "typescript" }],
    entrypoints: [{ path: "src/api.ts", line: 1, label: "HTTP 路由" }],
    semanticBackend: "static", lspStatus: []
  },
  implementations: []
} as unknown as RepositoryAnalysis;

const moduleNode = (id: string, ref: string, label: string, x: number, y: number): DiagramBody["nodes"][number] => ({ id, kind: "module", label, ref, x, y });

/** 一个用例一套（库连接 + 审计与广播的假实现）：断言「一行都没写」时才需要干净的现场。 */
function fixture(): { database: TutorDatabase; context: DiagramWriteContext; events: { type: JournalEventType; payload: Record<string, string | number | boolean | null> }[]; applied: string[] } {
  const directory = mkdtempSync(join(root, "case-"));
  const database = new TutorDatabase(directory);
  const events: { type: JournalEventType; payload: Record<string, string | number | boolean | null> }[] = [];
  const applied: string[] = [];
  const context: DiagramWriteContext = {
    store: diagramStoreFor(database, REPO),
    repositoryId: REPO,
    index,
    analysis,
    journal: { append: (type, payload) => { events.push({ type, payload }); } },
    onApplied: (event) => { applied.push(`${event.diagramId}:${event.action}`); }
  };
  return { database, context, events, applied };
}

/** 种一张已经画好的图（走 draw 本身，顺带验初版会留一版历史）。 */
function seeded(context: DiagramWriteContext): Diagram {
  const outcome = applyDiagramEdit(context, { edit: { action: "draw", name: "主线", body: { groups: [], nodes: [moduleNode("n-api", "file:src/api.ts", "接口层", 0, 0), moduleNode("n-core", "file:src/core.ts", "编排", 0, 200)], edges: [] } } }, "agent");
  expect(outcome.ok, outcome.text).toBe(true);
  return outcome.diagram!;
}

afterEach(() => {
  // 每个用例一套临时仓：清掉用例目录但留着 root（下一个 fixture 还要在里面 mkdtemp）
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("applyDiagramEdit：查无此人不落笔", () => {
  it("module 节点的 ref 核不上索引：整次拒写，库里一行都不多、审计一行都不记", () => {
    const f = fixture();
    const outcome = applyDiagramEdit(f.context, { edit: { action: "draw", name: "假节点", body: { groups: [], nodes: [{ id: "n-ghost", kind: "module", label: "查无此人", ref: "file:不存在的那一个.ts", x: 10, y: 10 }], edges: [] } } }, "agent");
    expect(outcome.ok).toBe(false);
    expect(outcome.text, "拒写要说出该改谁，模型才有一步可走").toContain("不在本仓索引里");
    // 认不出的 ref 前缀要单独拒，并给出可用写法
    const retired = applyDiagramEdit(f.context, { edit: { action: "draw", name: "旧引用", body: { groups: [], nodes: [{ id: "n-old", kind: "module", label: "旧模块", ref: "module:src", x: 10, y: 10 }], edges: [] } } }, "agent");
    expect(retired.ok).toBe(false);
    expect(retired.text).toContain("不是可用的 ref");
    expect(retired.text).toContain("file:");
    expect(listDiagrams(f.database, REPO), "被拒的这一次连一张空图都不该留下").toEqual([]);
    expect(f.events).toEqual([]);
    expect(f.applied).toEqual([]);
    f.database.close();
  });

  it("节点指得到、边的一端却不在图上：同样整次拒（先加节点再加边）", () => {
    const f = fixture();
    const outcome = applyDiagramEdit(f.context, { edit: { action: "draw", name: "半张图", body: { groups: [], nodes: [moduleNode("n-api", "file:src/api.ts", "接口层", 0, 0)], edges: [{ id: "e-1", from: "n-api", to: "n-none", origin: "inferred" }] } } }, "agent");
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("一端不在图上");
    expect(listDiagrams(f.database, REPO)).toEqual([]);
    f.database.close();
  });

  it("file/dir/symbol/group 四种引用都能落笔；group 没给 files 整次拒", () => {
    const f = fixture();
    const outcome = applyDiagramEdit(f.context, {
      edit: {
        action: "draw", name: "四种引用", body: {
          groups: [], edges: [], nodes: [
            { id: "n-file", kind: "module", label: "文件", ref: "file:src/api.ts", x: 0, y: 0 },
            { id: "n-dir", kind: "module", label: "目录", ref: "dir:src", x: 100, y: 0 },
            { id: "n-sym", kind: "module", label: "符号", ref: "symbol:src/api.ts#registerOrder", x: 200, y: 0 },
            { id: "n-group", kind: "module", label: "分组", ref: "group:g-1", files: ["src/core.ts", "src/db.ts"], x: 300, y: 0 }
          ]
        }
      }
    }, "agent");
    expect(outcome.ok, outcome.text).toBe(true);
    const byId = new Map(outcome.diagram!.body.nodes.map((node) => [node.id, node]));
    // 单引用节点只留 ref，文件清单在读侧由同一份解析器现算；只有 group 需要把 files 落进结构
    expect(byId.get("n-file")!.ref).toBe("file:src/api.ts");
    expect(byId.get("n-dir")!.ref).toBe("dir:src");
    expect(byId.get("n-sym")!.ref).toBe("symbol:src/api.ts#registerOrder");
    expect(byId.get("n-group")!.files).toEqual(["src/core.ts", "src/db.ts"]);

    const refused = applyDiagramEdit(f.context, { edit: { action: "add_node", node: { id: "n-bad", kind: "module", label: "空分组", ref: "group:g-2", x: 0, y: 0 } } }, "agent");
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("必须给 files");
    f.database.close();
  });

  it("两张图又没说改哪一张：拒，而不是挑一张来改", () => {
    const f = fixture();
    const first = seeded(f.context);
    seeded(f.context); // 第二张同名图会被加序号：从此「不说改哪张」就没有唯一答案
    const refused = applyDiagramEdit(f.context, { edit: { action: "add_node", node: moduleNode("n-extra", "file:src/db.ts", "存储", 400, 400) } }, "agent");
    expect(refused.ok, `两张图且没指名改哪一张：${refused.text}`).toBe(false);
    expect(refused.text).toContain("说清要改哪一张");
    const still = readDiagram(f.database, REPO, first.id)!;
    expect(still.body.nodes.map((node) => node.id)).toEqual(["n-api", "n-core"]);
    expect(still.versions).toHaveLength(1);
    expect(f.events.map((event) => event.type), "被拒的那一步不该留下任何一行审计").toEqual(["diagram_created", "diagram_created"]);
    f.database.close();
  });

  it("只有一张时省略 diagram 就落它身上——那不是猜，是唯一的落点", () => {
    const f = fixture();
    const only = seeded(f.context);
    const outcome = applyDiagramEdit(f.context, { edit: { action: "add_node", node: { id: "n-note", kind: "note", label: "便签", x: 0, y: 0, text: "一条" } } }, "agent");
    expect(outcome.ok, outcome.text).toBe(true);
    expect(outcome.diagram!.id).toBe(only.id);
    f.database.close();
  });

  it("给的名字对不上任何一张：回话里把图库现在有什么念出来", () => {
    const f = fixture();
    seeded(f.context);
    const outcome = applyDiagramEdit(f.context, { diagram: "登录流程", edit: { action: "remove_edge", target: "e-1" } }, "agent");
    expect(outcome.ok).toBe(false);
    expect(outcome.text, `要说清现在有哪些图：${outcome.text}`).toContain("主线");
    f.database.close();
  });
});

describe("applyDiagramEdit：边的可信度只降不升", () => {
  it("报高了的一定降、报低了的不抬、方向反了要说出反向那条", () => {
    const f = fixture();
    const outcome = applyDiagramEdit(f.context, {
      edit: {
        action: "draw", name: "依赖要说清", body: {
          groups: [],
          nodes: [moduleNode("n-api", "file:src/api.ts", "接口层", 0, 0), moduleNode("n-core", "file:src/core.ts", "编排", 200, 0), moduleNode("n-db", "file:src/db.ts", "存储", 400, 0), { id: "n-note", kind: "note", label: "便签", x: 600, y: 0, text: "猜的" }],
          edges: [
            // 真有 import：static 站得住
            { id: "e-true", from: "n-api", to: "n-core", origin: "static" },
            // 其实是 static 却只报 code：引擎按它报的那一档留（上抬等于替它吹）
            { id: "e-low", from: "n-core", to: "n-db", origin: "code" },
            // 三张表里都没有这一对：降
            { id: "e-none", from: "n-api", to: "n-db", origin: "static" },
            // 只有反方向那条：降，且要把「反向」这句说实话
            { id: "e-flip", from: "n-db", to: "n-core", origin: "static" },
            // 便签不参与结构表：任何声称都不成立
            { id: "e-note", from: "n-api", to: "n-note", origin: "code", evidence: "模型自述：它觉得页面会写库" }
          ]
        }
      }
    }, "agent");
    expect(outcome.ok, outcome.text).toBe(true);
    const byId = new Map(outcome.diagram!.body.edges.map((edge) => [edge.id, edge]));
    expect(byId.get("e-true")!.origin).toBe("static");
    expect(byId.get("e-true")!.downgraded).toBeUndefined();
    expect(byId.get("e-true")!.evidence, "核出来的那条依据要落下来，界面悬停读的就是它").toBe("src/api.ts → src/core.ts");
    expect(byId.get("e-low")!.origin, "只降不升：报低了不替它抬").toBe("code");
    expect(byId.get("e-none")!.origin).toBe("inferred");
    expect(byId.get("e-flip")!.origin).toBe("inferred");
    expect(byId.get("e-flip")!.downgraded ?? "", "含糊成「核不到」是不够的：方向对不上是另一件事").toContain("反向");
    expect(byId.get("e-note")!.origin, "便签不是代码，硬标 code 就是撒谎").toBe("inferred");
    expect(byId.get("e-note")!.evidence, "降到 inferred 时模型自述那句理由仍是它的原话").toBe("模型自述：它觉得页面会写库");
    expect(outcome.text).toContain("3 条边核不到依据、已降档");
    expect(f.events[0]!.payload.downgraded).toBe(3);
    f.database.close();
  });

  it("第四张表补上时，注入那条线就不该被降成猜测；方向反了照样降（第四张表也不替它圆）", () => {
    const f = fixture();
    // 真产物由 `facts-verify.test.ts` 对着库验；这里喂一份等价判据，只验「settleEdge 会不会用它」
    const context: DiagramWriteContext = { ...f.context, facts: (fromFiles, toFiles) => (fromFiles.includes("src/api.ts") && toFiles.includes("src/db.ts") ? { origin: "static", detail: "运行时绑定：src/api.ts:7 注入 DbService" } : undefined) };
    const outcome = applyDiagramEdit(context, {
      edit: {
        action: "draw", name: "注入也要算证据", body: {
          groups: [],
          nodes: [moduleNode("n-api", "file:src/api.ts", "接口层", 0, 0), moduleNode("n-db", "file:src/db.ts", "存储", 200, 0)],
          edges: [{ id: "e-di", from: "n-api", to: "n-db", origin: "static" }, { id: "e-back", from: "n-db", to: "n-api", origin: "static" }]
        }
      }
    }, "agent");
    expect(outcome.ok, outcome.text).toBe(true);
    const byId = new Map(outcome.diagram!.body.edges.map((edge) => [edge.id, edge]));
    expect(byId.get("e-di")!.origin, "三张老表核不到，但产物里有这条运行时绑定").toBe("static");
    expect(byId.get("e-di")!.evidence).toContain("注入 DbService");
    expect(byId.get("e-di")!.downgraded).toBeUndefined();
    expect(byId.get("e-back")!.origin, "第四张表也是单向的：反方向没有依据就照降").toBe("inferred");
    expect(outcome.text).toContain("1 条边核不到依据、已降档");
    f.database.close();
  });
});

describe("applyDiagramEdit：删与改都连带收尾", () => {
  it("remove_node 连带去掉挂在它身上的边，版本历史那一行写的是它的名字", () => {
    const f = fixture();
    const diagram = seeded(f.context);
    applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "add_edge", edge: { id: "e-1", from: "n-api", to: "n-core", origin: "static" } } }, "agent");
    const outcome = applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "remove_node", target: "n-core" } }, "agent");
    expect(outcome.ok, outcome.text).toBe(true);
    expect(outcome.diagram!.body.nodes.map((node) => node.id)).toEqual(["n-api"]);
    expect(outcome.diagram!.body.edges, "边的一端没了，边也不能留着").toEqual([]);
    expect(outcome.text).toContain("连带去掉 1 条边");
    const versions = outcome.diagram!.versions;
    expect(versions[versions.length - 1].note).toBe("删除 编排");
    expect(f.events.map((event) => event.type)).toEqual(["diagram_created", "diagram_edited", "diagram_edited"]);
    f.database.close();
  });

  it("remove_group 之后节点上不再写着那个框（不然界面上是个指向空气的分组）", () => {
    const f = fixture();
    const diagram = seeded(f.context);
    applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "add_group", group: { id: "g-1", label: "主链路", x: 0, y: 0, w: 300, h: 300 } } }, "agent");
    applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "relabel", target: "n-api", label: "接口层", sub: "入口" } }, "agent");
    const grouped = applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "add_node", node: { ...moduleNode("n-db", "file:src/db.ts", "存储", 500, 500), group: "g-1" } } }, "agent");
    expect(grouped.diagram!.body.nodes.find((node) => node.id === "n-db")!.group).toBe("g-1");
    const removed = applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "remove_group", target: "g-1" } }, "agent");
    expect(removed.ok, removed.text).toBe(true);
    expect(removed.diagram!.body.groups).toEqual([]);
    expect(removed.diagram!.body.nodes.find((node) => node.id === "n-db")!.group, "框没了，归属这一格也要跟着清").toBeUndefined();
    f.database.close();
  });

  it("relabel 只给 sub 时正文与标签都不动；move 是唯一会挪用户东西的动作", () => {
    const f = fixture();
    const diagram = seeded(f.context);
    const relabeled = applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "relabel", target: "n-api", sub: "对外入口" } }, "agent");
    const api = relabeled.diagram!.body.nodes.find((node) => node.id === "n-api")!;
    expect(api.sub).toBe("对外入口");
    expect(api.label, "没给的字段不该被顺手清空").toBe("接口层");
    const moved = applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "move", target: "n-core", x: 88.6, y: -20 } }, "agent");
    expect(moved.diagram!.body.nodes.find((node) => node.id === "n-core")).toMatchObject({ x: 89, y: 0 });
    expect(moved.text, "这一格要如实告诉模型：位置本来用户自己拖就行").toContain("你自己拖");
    f.database.close();
  });
});

describe("版本历史：存版有上限，恢复只追加", () => {
  it(`连改 ${DIAGRAM_VERSION_LIMIT + 5} 次也只留最近 ${DIAGRAM_VERSION_LIMIT} 版，丢的是最旧那几版`, () => {
    const f = fixture();
    const diagram = seeded(f.context);
    let current = diagram;
    for (let index = 0; index < DIAGRAM_VERSION_LIMIT + 5; index += 1) {
      const outcome = applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "add_node", node: { id: `n-${index}`, kind: "note", label: `便签 ${index}`, x: 0, y: 0, text: "" } } }, "agent");
      expect(outcome.ok, outcome.text).toBe(true);
      current = outcome.diagram!;
    }
    expect(current.versions).toHaveLength(DIAGRAM_VERSION_LIMIT);
    expect(current.versions[0].note, "第一版「agent 初版」是最旧的，早该被挤出去").not.toBe("agent 初版");
    expect(current.versions[current.versions.length - 1].note).toBe(`加 便签 ${DIAGRAM_VERSION_LIMIT + 4}`);
    expect(current.body.nodes).toHaveLength(2 + DIAGRAM_VERSION_LIMIT + 5);
    f.database.close();
  });

  it("恢复某一版：结构回到那一份，历史多出最后一版而不是被砍到那一版", () => {
    const f = fixture();
    const diagram = seeded(f.context);
    const edited = applyDiagramEdit(f.context, { diagram: diagram.id, edit: { action: "add_node", node: { id: "n-note", kind: "note", label: "便签", x: 0, y: 0, text: "一句话" } } }, "agent");
    const first = edited.diagram!.versions[0]!;
    const restored = restoreVersion(f.database, edited.diagram!, 0)!;
    expect(restored, "恢复到那一版").toBeDefined();
    expect(restored.versions).toHaveLength(3);
    expect(restored.versions.map((version) => version.body.nodes.length)).toEqual([2, 3, 2]);
    expect(restored.versions[2].note).toContain("恢复到");
    expect(restored.body).toEqual(first.body);
    expect(listDiagrams(f.database, REPO)[0]!.versions).toBe(3);
    f.database.close();
  });

  it("读侧：引用断掉的节点要报出来，画布现场那份清单把正打开那张标出来", () => {
    const f = fixture();
    const broken = buildDiagram(REPO, { id: diagramId("broken"), name: "过时的一张", source: "agent", body: { groups: [], nodes: [{ id: "n-gone", kind: "module", label: "重命名前的模块", ref: "file:src/gone.ts", x: 0, y: 0 }], edges: [] } });
    applyStructure(f.database, broken, broken.body, "agent 初版");
    const stored = readDiagram(f.database, REPO, broken.id)!;
    expect(diagramWarnings(f.context, stored)).toEqual([{ node: "n-gone", reason: expect.stringContaining("核不上") }]);

    seeded(f.context);
    const inventory = diagramInventoryFor(f.context, broken.id);
    expect(inventory).toContain("画布现场");
    expect(inventory).toContain(broken.id);
    expect(inventory, "「把这条边删掉」得知道用户看的是哪一张").toContain("画布上正打开的这张");
    expect(inventory).toContain("set_diagram");
    f.database.close();
  });
});

describe("applyDiagramEdit：名字这一格也有判据", () => {
  it("draw 不给 name：拒写——图库靠名字认图，「未命名图」下次谁都找不回它", () => {
    expect(parseDiagramEditArguments('{"edit":{"action":"draw","body":{"groups":[],"nodes":[],"edges":[]}}}').error).toContain("draw 要给 name");
  });

  it("节点名末尾搬了个计数：拒写并说清该放哪一格", () => {
    const f = fixture();
    const outcome = applyDiagramEdit(f.context, { edit: { action: "draw", name: "计数名", body: { groups: [], nodes: [moduleNode("n-api", "file:src/api.ts", "控制器（14）", 0, 0)], edges: [] } } }, "agent");
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("把文件数写进名字里");
    expect(listDiagrams(f.database, REPO), "被拒的这一次不该留下一张半成品图").toEqual([]);
    f.database.close();
  });

  it("同一张图里节点名重复：拒写（id 唯一不够，读者点的是名字）", () => {
    const f = fixture();
    const outcome = applyDiagramEdit(f.context, { edit: { action: "draw", name: "重名", body: { groups: [], nodes: [moduleNode("n-a", "file:src/api.ts", "接口层", 0, 0), moduleNode("n-b", "file:src/core.ts", "接口层", 0, 200)], edges: [] } } }, "agent");
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("节点名字重复");
    f.database.close();
  });

  it("规模写进 sub 是合法形状：判据只管名字那一格，不拦数字", () => {
    const f = fixture();
    const node = { ...moduleNode("n-api", "file:src/api.ts", "接口层", 0, 0), sub: "14 个文件" };
    const outcome = applyDiagramEdit(f.context, { edit: { action: "draw", name: "规模在 sub", body: { groups: [], nodes: [node], edges: [] } } }, "agent");
    expect(outcome.ok, outcome.text).toBe(true);
    f.database.close();
  });
});

describe("parseDiagramEditArguments：白名单就是白名单", () => {
  it("摊平写法也认；未知字段不看但在回话里点名", () => {
    const nested = parseDiagramEditArguments('{"diagram":"一张图","edit":{"action":"remove_edge","target":"e-1"}}');
    expect(nested.error).toBeUndefined();
    expect(nested.request).toEqual({ diagram: "一张图", edit: { action: "remove_edge", target: "e-1" } });
    expect(nested.ignored).toEqual([]);

    const flat = parseDiagramEditArguments('{"action":"move","target":"n-1","x":12,"y":7,"color":"red"}');
    expect(flat.request!.edit).toEqual({ action: "move", target: "n-1", x: 12, y: 7 });
    expect(flat.ignored).toEqual(["color"]);
  });

  it("九种之外的动作与缺字段都拒，且拒得出一句下一步", () => {
    expect(parseDiagramEditArguments("不是 JSON").error).toContain("合法 JSON");
    expect(parseDiagramEditArguments('{"edit":{"action":"thicken_edge","target":"e-1"}}').error).toContain("未知 action");
    expect(parseDiagramEditArguments('{"edit":{"action":"add_edge","edge":{"id":"e-2","from":"n-1"}}}').error).toContain("from、to");
    expect(parseDiagramEditArguments('{"edit":{"action":"relabel","target":"n-1"}}').error).toContain("label / sub / text");
    expect(parseDiagramEditArguments('{"edit":{"action":"add_node","node":{"id":"n-9","kind":"module","label":"少了 ref"}}}').error).toContain("ref");
    // 边上那一格由引擎写：模型自己填的降档说明落在白名单之外，会被点名忽略
    const smuggled = parseDiagramEditArguments('{"edit":{"action":"add_edge","edge":{"id":"e-3","from":"n-1","to":"n-2","origin":"static","downgraded":"其实成立"}}}');
    expect(smuggled.ignored).toContain("edge.downgraded");
    expect(JSON.stringify(smuggled.request)).not.toContain("其实成立");
  });

  it("九种动作真能从这一层走到写入口（draw 的整张结构按缺省补空表）", () => {
    const f = fixture();
    const drawn = parseDiagramEditArguments('{"edit":{"action":"draw","name":"从参数层进来","body":{"nodes":[{"id":"n-api","kind":"module","label":"接口层","ref":"file:src/api.ts","x":0,"y":0}]}}}');
    expect(drawn.error).toBeUndefined();
    const outcome = applyDiagramEdit(f.context, drawn.request!, "agent");
    expect(outcome.ok, outcome.text).toBe(true);
    expect(outcome.diagram!.body).toMatchObject({ groups: [], edges: [], nodes: [{ id: "n-api", ref: "file:src/api.ts" }] });
    f.database.close();
  });
});
