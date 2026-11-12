import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendVersion, ensureCurrentVersion, readSkillVersions } from "./skill-versions.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeSkill(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-versions-"));
  roots.push(root);
  const dir = join(root, "exercise-code-concepts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# 出题\n", "utf8");
  writeFileSync(join(dir, "concepts.json"), "{}\n", "utf8");
  return dir;
}

describe("技能版本链", () => {
  it("首次记录为迁移版，收进当前内容", () => {
    const first = ensureCurrentVersion(makeSkill(), { reason: "首次" });
    expect(first.version).toBe(1);
    expect(first.parent).toBeNull();
    expect(first.source).toBe("migration");
    expect(first.changed).toEqual(["SKILL.md", "concepts.json"]);
  });

  it("写入后追加一版并记录变更文件；无变化不追加", () => {
    const dir = makeSkill();
    ensureCurrentVersion(dir, { reason: "首次" });
    writeFileSync(join(dir, "SKILL.md"), "# 出题\n\n新内容\n", "utf8");
    const second = appendVersion(dir, { source: "reset", reason: "重置", check: { errors: 0, warnings: 0 } });
    expect(second.version).toBe(2);
    expect(second.parent).toBe(1);
    expect(second.changed).toEqual(["SKILL.md"]);
    expect(appendVersion(dir, { source: "reset", reason: "重置", check: { errors: 0, warnings: 0 } }).version).toBe(2);
  });

  it("外部改动在写入前补记一版 user", () => {
    const dir = makeSkill();
    ensureCurrentVersion(dir, { reason: "首次" });
    writeFileSync(join(dir, "concepts.json"), '{"a":1}\n', "utf8");
    const second = ensureCurrentVersion(dir, { reason: "写入前" });
    expect(second.version).toBe(2);
    expect(second.source).toBe("user");
    expect(second.changed).toEqual(["concepts.json"]);
  });

  it("版本目录自身不进入记录", () => {
    const dir = makeSkill();
    ensureCurrentVersion(dir, { reason: "首次" });
    appendVersion(dir, { source: "reset", reason: "重置", check: { errors: 0, warnings: 0 } });
    const latest = readSkillVersions(dir).at(-1)!;
    expect(Object.keys(latest.files).some((name) => name.startsWith(".versions"))).toBe(false);
  });
});
