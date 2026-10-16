import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { CourseTree, JournalEvent } from "@codebase-tutor/shared";
import { TutorDatabase } from "../store/database.js";
import { readOverlays } from "../store/overlays.js";
import { Journal, readJournal } from "../store/journal.js";
import { commitOverride, parseOverrideArguments, type OverrideIntent } from "./override-writer.js";

/**
  `set_architecture` 是全仓第一个**有副作用**的 agent 工具，这一组用例钉的是它的边界：
  能改的只有「层怎么归、层叫什么、模块哪一档」，**改不动任何一条边**。
  边是 import 聚合出来的事实；让模型（或界面）能增删一条箭头，这张图就从证据变成了意见。
*/
const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-override-")));
let database: TutorDatabase;

const course = {
  repositoryId: "repo", modelVersion: "fixture", generatedAt: "2026-10-16T00:00:00.000Z",
  root: {
    id: "root", title: "r", summary: "s", kind: "overview", anchors: [],
    children: [{
      id: "modules", title: "模块地图", kind: "overview", summary: "s", anchors: [],
      children: [
        { id: "module:api", title: "接口", kind: "module", summary: "s", tier: "core", anchors: [{ path: "src/api.ts", line: 1, label: "入口" }], children: [] },
        { id: "module:db", title: "存储", kind: "module", summary: "s", tier: "facility", anchors: [{ path: "src/db.ts", line: 1, label: "实现" }], children: [] }
      ]
    }]
  }
} as unknown as CourseTree;

const LAYERS = ["接入", "编排", "数据"];

function contextFor(sessionId?: string): { context: Parameters<typeof commitOverride>[0]; applied: unknown[] } {
  const applied: unknown[] = [];
  return {
    applied,
    context: {
      database,
      repositoryId: "repo",
      course,
      layers: LAYERS,
      journal: { append: (type, payload) => new Journal(dir, "repo").append(type, payload, sessionId) },
      onApplied: (event) => applied.push(event)
    }
  };
}

beforeAll(() => {
  database = new TutorDatabase(dir);
});

afterAll(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("parseOverrideArguments（工具入参的白名单）", () => {
  it("四条动作各自解析，多余字段只报「已忽略」不参与执行", () => {
    const moved = parseOverrideArguments('{"action":"move_module","module":"module:api","layer":"编排"}');
    expect(moved.intent).toEqual({ kind: "move_module", module: "module:api", layer: "编排" });
    expect(moved.error).toBeUndefined();
    const withEdges = parseOverrideArguments('{"action":"move_module","module":"module:api","layer":"编排","edges":[{"from":"接入","to":"数据"}],"files":["src/a.ts"]}');
    expect(withEdges.ignored.sort()).toEqual(["edges", "files"]);
    // 解析出来的 intent 里根本没有 edges 这一格可放——不是运行时要拦，是这个形状写不出来
    expect(JSON.stringify(withEdges.intent)).not.toContain("edges");
    expect(parseOverrideArguments('{"action":"add_edge","from":"接入"}').error).toContain("未知 action");
    expect(parseOverrideArguments('{"action":"set_tier","module":"module:api","tier":"主干"}').error).toContain("set_tier 需要");
    expect(parseOverrideArguments("不是 JSON").error).toContain("合法 JSON");
  });
});

describe("commitOverride（写盘、审计与通知）", () => {
  it("改层名要连着改归层表里的旧名：不留两套名字", () => {
    const first = contextFor();
    expect(commitOverride(first.context, { kind: "move_module", module: "module:api", layer: "接入" }, "gui").ok).toBe(true);
    const second = contextFor();
    const renamed = commitOverride(second.context, { kind: "rename_layer", from: "接入", to: "入口" }, "gui");
    expect(renamed.ok).toBe(true);
    const overlays = readOverlays(database, "repo");
    expect(overlays.architecture?.layerRenames).toEqual({ 接入: "入口" });
    expect(overlays.architecture?.moduleLayer).toEqual({ "module:api": "入口" });
  });

  it("层名不在图上 / 模块不在树里：整笔不写，审计一行不落，通知一次不发", () => {
    const before = JSON.stringify(readOverlays(database, "repo"));
    const eventsBefore = readJournal(dir).filter((event) => event.type === "architecture_layer_overridden").length;
    const first = contextFor();
    const rejected = commitOverride(first.context, { kind: "move_module", module: "module:api", layer: "不存在的层" }, "agent");
    expect(rejected.ok).toBe(false);
    expect(rejected.text).toContain("只支持");
    expect(rejected.text).toContain("不在现在的图上");
    expect(first.applied).toEqual([]);
    const second = contextFor();
    expect(commitOverride(second.context, { kind: "set_tier", module: "module:ghost", tier: "core" }, "agent").ok).toBe(false);
    expect(JSON.stringify(readOverlays(database, "repo"))).toBe(before);
    expect(readJournal(dir).filter((event) => event.type === "architecture_layer_overridden").length, "拒写不留审计行").toBe(eventsBefore);
  });

  it("成功那笔要落审计并带上引擎当时的原判：改档次数就是分层判断唯一的错误率读数", () => {
    const { context, applied } = contextFor("thread-1");
    const outcome = commitOverride(context, { kind: "move_module", module: "module:db", layer: "编排", from: "数据" }, "agent");
    expect(outcome.ok).toBe(true);
    expect(applied).toEqual([{ repositoryId: "repo", module: "module:db", via: "agent" }]);
    const events = readJournal(dir).filter((event): event is JournalEvent => event.type === "architecture_layer_overridden");
    const last = events[events.length - 1];
    expect(last.payload).toMatchObject({ module: "module:db", from: "数据", to: "编排", via: "agent" });
    expect(typeof last.payload.correction_id).toBe("string");
    expect(last.sessionId).toBe("thread-1");

    const tier = commitOverride(contextFor("thread-2").context, { kind: "set_tier", module: "module:api", tier: "periphery" }, "gui");
    expect(tier.ok).toBe(true);
    const tierEvents = readJournal(dir).filter((event) => event.type === "module_tier_overridden");
    expect(tierEvents[tierEvents.length - 1].payload).toMatchObject({ module: "module:api", to: "periphery", via: "gui" });
    // 覆盖层落盘后可读回：GUI 与 agent 看到的是同一份
    expect(readOverlays(database, "repo").modules?.tier).toEqual({ "module:api": "periphery" });
  });

  it("reset 只撤一个模块时不能顺手把别的模块的修正也清掉", () => {
    const context = contextFor().context;
    commitOverride(context, { kind: "move_module", module: "module:api", layer: "编排" }, "gui");
    commitOverride(contextFor().context, { kind: "move_module", module: "module:db", layer: "接入" }, "gui");
    commitOverride(contextFor().context, { kind: "reset", module: "module:api" }, "gui");
    const overlays = readOverlays(database, "repo");
    expect(overlays.architecture?.moduleLayer).not.toHaveProperty("module:api");
    expect(overlays.architecture?.moduleLayer?.["module:db"], "别的模块的修正要留着").toBe("接入");
  });

  it("整份 reset 之后覆盖层是空的，但图上没有多出任何边（边来自 import，不来自这份文件）", () => {
    commitOverride(contextFor().context, { kind: "reset" }, "gui");
    const overlays = readOverlays(database, "repo");
    expect(overlays.architecture ?? {}).toEqual({});
    expect(JSON.stringify(overlays), "覆盖层里任何时候都不该出现边").not.toMatch(/edges|weight|samplePaths/);
  });
});

describe("合并块的 id 也是可写的（图上看到什么就能改什么）", () => {
  const blocksContext = (): Parameters<typeof commitOverride>[0] => ({
    ...contextFor().context,
    blocks: [{ id: "arch:src/a/x:core", title: "一、二、三", members: ["module:a/x/one", "module:a/x/two", "module:a/x/three"], role: "core" }]
  });

  it("move_module 收方块 id：审计与回话里带的是方块标题，不是原 id", () => {
    const outcome = commitOverride(blocksContext(), { kind: "move_module", module: "arch:src/a/x:core", layer: "数据" }, "agent");
    expect(outcome.ok, "agent 读到的就是方块 id，拒收等于让它改不动这张图").toBe(true);
    expect(outcome.text).toContain("一、二、三");
    const layerEvents = readJournal(dir).filter((event) => event.type === "architecture_layer_overridden");
    expect(layerEvents[layerEvents.length - 1].payload).toMatchObject({ module: "arch:src/a/x:core", module_title: "一、二、三", to: "数据", via: "agent" });
    expect(readOverlays(database, "repo").architecture?.moduleLayer?.["arch:src/a/x:core"]).toBe("数据");
  });

  it("set_tier 不收方块 id：档位是原子模块那一格的属性，报错要说清该改谁", () => {
    const refused = commitOverride(blocksContext(), { kind: "set_tier", module: "arch:src/a/x:core", tier: "core" }, "agent");
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("合并出来的方块");
    expect(refused.text, "拒写要给出下一步：让 agent 直接换成成员 id").toContain("逐个模块");
  });
});

describe("撤销的审计分寸", () => {
  it("撤掉档位时才补一行 restored；只撤归层不碰档的，不混进「恢复」计数", () => {
    const tierEvents = () => readJournal(dir).filter((event) => event.type === "module_tier_overridden");
    const before = tierEvents().length;
    commitOverride(contextFor().context, { kind: "move_module", module: "module:api", layer: "编排" }, "gui");
    commitOverride(contextFor().context, { kind: "reset", module: "module:api" }, "gui");
    expect(tierEvents().length, "这个模块当时没有档位覆盖，不该补 restored 行").toBe(before);

    commitOverride(contextFor().context, { kind: "set_tier", module: "module:db", tier: "core", given: "facility" }, "gui");
    const afterSet = tierEvents().length;
    commitOverride(contextFor().context, { kind: "reset", module: "module:db" }, "gui");
    const restored = tierEvents()[tierEvents().length - 1];
    expect(tierEvents().length).toBe(afterSet + 1);
    expect(restored.payload).toMatchObject({ module: "module:db", restored: true, given: "core" });
  });
});

describe("意图到工具的翻译（写工具只能表达这四件事）", () => {
  it("OverrideIntent 的四条分支之外没有第五种写法：改边在类型层面就没有落点", () => {
    const kinds = ["move_module", "rename_layer", "set_tier", "reset"];
    const parsed = kinds.map((action) => parseOverrideArguments(JSON.stringify({ action, module: "module:api", layer: "编排", from: "接入", to: "入口", tier: "core" })).intent?.kind);
    expect(parsed).toEqual(["move_module", "rename_layer", "set_tier", "reset"]);
    // 每一条意图序列化后都不含边、文件、模块清单这三类事实字段
    for (const kind of ["move_module", "rename_layer", "set_tier", "reset"] as const) {
      const intent: OverrideIntent = kind === "move_module" ? { kind, module: "module:api", layer: "编排" } : kind === "rename_layer" ? { kind, from: "接入", to: "入口" } : kind === "set_tier" ? { kind, module: "module:api", tier: "core" } : { kind };
      expect(JSON.stringify(intent)).not.toMatch(/edges|paths|files/);
    }
  });
});
