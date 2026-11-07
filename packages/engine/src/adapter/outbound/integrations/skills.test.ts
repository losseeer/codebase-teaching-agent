import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { restoreBundledSkills } from "./skills.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** 造一份出厂技能：SKILL.md + 一个附属文件。 */
function makeSource(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 测试用\n---\n\n出厂正文\n`, "utf8");
  writeFileSync(join(dir, "extra.md"), "出厂附属\n", "utf8");
  return dir;
}

describe("恢复出厂技能", () => {
  it("覆盖用户改过的文件；用户多出来的文件保留；用户自建技能不动", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-restore-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    makeSource(source, "built-in");
    makeSource(source, "other-built-in");
    // 用户目录：出厂技能被改过 + 多放了一个文件；另有一个自建技能
    mkdirSync(join(target, "built-in"), { recursive: true });
    writeFileSync(join(target, "built-in", "SKILL.md"), "用户改坏的\n", "utf8");
    writeFileSync(join(target, "built-in", "mine.md"), "我自己加的\n", "utf8");
    mkdirSync(join(target, "my-own"), { recursive: true });
    writeFileSync(join(target, "my-own", "SKILL.md"), "---\nname: my-own\ndescription: 我自己的\n---\n", "utf8");

    const result = restoreBundledSkills({ sourceDir: source, targetDir: target });

    expect(result.restored).toEqual(["built-in", "other-built-in"]);
    expect(readFileSync(join(target, "built-in", "SKILL.md"), "utf8")).toContain("出厂正文");
    expect(readFileSync(join(target, "built-in", "extra.md"), "utf8")).toBe("出厂附属\n");
    expect(readFileSync(join(target, "built-in", "mine.md"), "utf8")).toBe("我自己加的\n");
    expect(readFileSync(join(target, "my-own", "SKILL.md"), "utf8")).toContain("我自己的");
    // 被覆盖的目录留了备份
    expect(result.backupDirs.length).toBe(1);
    expect(readFileSync(join(result.backupDirs[0]!, "SKILL.md"), "utf8")).toBe("用户改坏的\n");
  });

  it("用户目录没有该技能时直接装上，不产生备份", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-restore-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    makeSource(source, "built-in");
    const result = restoreBundledSkills({ sourceDir: source, targetDir: target });
    expect(result.restored).toEqual(["built-in"]);
    expect(result.backupDirs).toEqual([]);
    expect(readFileSync(join(target, "built-in", "SKILL.md"), "utf8")).toContain("出厂正文");
  });
});
