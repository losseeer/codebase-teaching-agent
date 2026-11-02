import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentSurface } from "@codebase-tutor/contract";

import { createRouteFixture, type RouteFixture } from "../controller-test-kit.js";

/** 只读能力面：静态注册表按工作区给可用性，读侧不发模型。 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });
afterEach(() => {
  delete process.env.TUTOR_SKILLS_DIR;
  delete process.env.TUTOR_MCP_SETTINGS_FILE;
});

function emptySkills(): string {
  const dir = join(fx.root, "skills-empty");
  mkdirSync(dir, { recursive: true });
  process.env.TUTOR_SKILLS_DIR = dir;
  process.env.TUTOR_MCP_SETTINGS_FILE = join(fx.root, "no-mcp.json");
  return dir;
}

async function surface(scope: string): Promise<AgentSurface> {
  const response = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/agent-surface?scope=${scope}` });
  expect(response.statusCode).toBe(200);
  return response.json() as AgentSurface;
}

describe("GET /agent-surface 的只读能力面", () => {
  it("按工作区给可用性：架构全景开画布与产物查询，练习只剩文件与技能", async () => {
    emptySkills();
    const before = fx.fetchCalls();
    const map = await surface("map");
    expect(fx.fetchCalls(), "读侧不发模型").toBe(before);
    expect(map.scope).toBe("map");
    expect(map.tools.map((tool) => tool.name)).toEqual(["read_file", "search_code", "ask_user", "set_diagram", "read_skill", "query_facts", "外部工具"]);
    const byName = new Map(map.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("set_diagram")?.available).toBe(true);
    expect(byName.get("query_facts")?.available).toBe(true);
    expect(byName.get("ask_user")).toMatchObject({ available: true, conditional: true });
    expect(byName.get("read_skill")).toMatchObject({ available: false, reason: "没有装载技能" });

    const practice = await surface("practice");
    expect(practice.tools.find((tool) => tool.name === "search_code")).toMatchObject({ available: false, reason: "练习工作区不开放检索" });
    expect(practice.tools.find((tool) => tool.name === "set_diagram")?.available).toBe(false);
    expect(practice.tools.find((tool) => tool.name === "read_file")?.available).toBe(true);
  });

  it("装了技能后 read_skill 亮起，清单与目录来自注册表", async () => {
    const dir = join(fx.root, "skills");
    mkdirSync(join(dir, "tutor-fixture"), { recursive: true });
    writeFileSync(join(dir, "tutor-fixture", "SKILL.md"), "---\nname: tutor-fixture\ndescription: 测试用做法。\n---\n\n正文\n", "utf8");
    process.env.TUTOR_SKILLS_DIR = dir;
    process.env.TUTOR_MCP_SETTINGS_FILE = join(fx.root, "no-mcp.json");

    const teaching = await surface("teaching");
    expect(teaching.skills.map((skill) => skill.name)).toEqual(["tutor-fixture"]);
    expect(teaching.directories).toEqual([dir]);
    expect(teaching.tools.find((tool) => tool.name === "read_skill")?.available).toBe(true);
    expect(teaching.tools.find((tool) => tool.name === "search_code")?.available).toBe(true);
    expect(teaching.tools.find((tool) => tool.name === "query_facts")?.available).toBe(false);
  });
});
