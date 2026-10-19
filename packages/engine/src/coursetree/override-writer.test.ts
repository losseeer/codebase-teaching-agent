import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CourseTree } from "@codebase-tutor/shared";
import { TutorDatabase } from "../store/database.js";
import { readOverlays } from "../store/overlays.js";
import { Journal, readJournal } from "../store/journal.js";
import { commitOverride, parseOverrideArguments } from "./override-writer.js";

/**
  `set_module_tier` 是 map 作用域里两个有副作用的 agent 工具之一。这一组钉它的边界：
  能改的只有「模块归哪一档」，层、边、文件都不在可改范围内。
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

function contextFor(sessionId?: string): { context: Parameters<typeof commitOverride>[0]; applied: unknown[] } {
  const applied: unknown[] = [];
  return {
    applied,
    context: {
      database,
      repositoryId: "repo",
      course,
      journal: { append: (type, payload) => new Journal(dir, "repo").append(type, payload, sessionId) },
      onApplied: (event) => applied.push(event)
    }
  };
}

beforeAll(() => { database = new TutorDatabase(dir); });
afterAll(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });

describe("parseOverrideArguments", () => {
  it("只解析 set_tier / reset，多余字段只报「已忽略」不参与执行", () => {
    const set = parseOverrideArguments('{"action":"set_tier","module":"module:api","tier":"core"}');
    expect(set.intent).toEqual({ kind: "set_tier", module: "module:api", tier: "core" });
    expect(set.error).toBeUndefined();
    const withExtra = parseOverrideArguments('{"action":"set_tier","module":"module:api","tier":"core","layer":"编排","edges":[{"from":"a","to":"b"}]}');
    expect(withExtra.ignored.sort()).toEqual(["edges", "layer"]);
    expect(JSON.stringify(withExtra.intent)).not.toContain("edges");
    expect(parseOverrideArguments('{"action":"move_module","module":"module:api","layer":"编排"}').error).toContain("未知 action");
    expect(parseOverrideArguments('{"action":"set_tier","module":"module:api","tier":"主干"}').error).toContain("set_tier 需要");
    expect(parseOverrideArguments("不是 JSON").error).toContain("合法 JSON");
  });
});

describe("commitOverride", () => {
  it("set_tier：写覆盖层、记一条审计、通知一次", () => {
    const { context, applied } = contextFor();
    const outcome = commitOverride(context, { kind: "set_tier", module: "module:api", tier: "facility" }, "agent");
    expect(outcome.ok).toBe(true);
    expect(readOverlays(database, "repo").modules?.tier).toEqual({ "module:api": "facility" });
    expect(applied).toHaveLength(1);
    const events = readJournal(dir).filter((event) => event.type === "module_tier_overridden");
    expect(events.at(-1)?.payload).toMatchObject({ module: "module:api", given: "core", to: "facility", via: "agent", restored: false });
  });

  it("set_tier：模块不在课程树里时拒写，覆盖层一条不动", () => {
    const { context, applied } = contextFor();
    const before = readOverlays(database, "repo");
    const outcome = commitOverride(context, { kind: "set_tier", module: "module:ghost", tier: "core" }, "agent");
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("不在当前课程树");
    expect(readOverlays(database, "repo")).toEqual(before);
    expect(applied).toHaveLength(0);
  });

  it("reset 给 module：只撤那个模块的改档，并记 restored", () => {
    const { context } = contextFor();
    commitOverride(context, { kind: "set_tier", module: "module:db", tier: "core" }, "agent");
    const outcome = commitOverride(context, { kind: "reset", module: "module:db" }, "agent");
    expect(outcome.ok).toBe(true);
    expect(readOverlays(database, "repo").modules?.tier?.["module:db"]).toBeUndefined();
    const events = readJournal(dir).filter((event) => event.type === "module_tier_overridden");
    expect(events.at(-1)?.payload).toMatchObject({ module: "module:db", restored: true });
  });

  it("reset 不给 module：把这个仓的全部人工修正一次清空", () => {
    const { context } = contextFor();
    commitOverride(context, { kind: "set_tier", module: "module:api", tier: "facility" }, "agent");
    const outcome = commitOverride(context, { kind: "reset" }, "agent");
    expect(outcome.ok).toBe(true);
    expect(readOverlays(database, "repo")).toEqual({});
  });

  it("没有可撤的修正时拒写，不退化成全清", () => {
    const { context } = contextFor();
    commitOverride(context, { kind: "reset" }, "agent");
    const outcome = commitOverride(context, { kind: "reset" }, "agent");
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("没有人工修正");
  });
});
