import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { diffBundledSkills, listSkillFiles, restoreBundledSkills } from "./skills.js";
import { readSkillVersions } from "./skill-versions.js";

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
    const history = readSkillVersions(join(target, "built-in"));
    expect(history[0]?.source).toBe("migration");
    expect(history.at(-1)?.source).toBe("reset");

  });

  it("用户目录没有该技能时直接装上，不产生备份", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-restore-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    makeSource(source, "built-in");
    const result = restoreBundledSkills({ sourceDir: source, targetDir: target });
    expect(result.restored).toEqual(["built-in"]);
    // 首次安装整目录复制也要计入文件数，与 diffBundledSkills 的预览口径一致（PR #14 回归）
    expect(result.files).toBe(2);
    expect(readFileSync(join(target, "built-in", "SKILL.md"), "utf8")).toContain("出厂正文");
  });
});

describe("用户配置的所有权", () => {
  it("config.json 属用户所有：同步不覆盖、不计入差异；重置时随出厂恢复", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-restore-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    makeSource(source, "built-in");
    writeFileSync(join(source, "built-in", "config.json"), '{"version":1,"exerciseStrategy":"unit"}\n', "utf8");
    mkdirSync(join(target, "built-in"), { recursive: true });
    writeFileSync(join(target, "built-in", "SKILL.md"), readFileSync(join(source, "built-in", "SKILL.md")), "utf8");
    writeFileSync(join(target, "built-in", "extra.md"), readFileSync(join(source, "built-in", "extra.md")), "utf8");
    writeFileSync(join(target, "built-in", "config.json"), '{"version":1,"exerciseStrategy":"reference"}\n', "utf8");

    expect(diffBundledSkills({ sourceDir: source, targetDir: target }).entries).toEqual([]);
    const synced = restoreBundledSkills({ sourceDir: source, targetDir: target });
    expect(synced.files).toBe(2);
    expect(readFileSync(join(target, "built-in", "config.json"), "utf8")).toContain("reference");

    const reset = restoreBundledSkills({ sourceDir: source, targetDir: target, includeUserOwned: true });
    expect(reset.files).toBe(3);
    expect(readFileSync(join(target, "built-in", "config.json"), "utf8")).toContain("unit");
  });
});

describe("出厂技能与用户目录的差异（只读）", () => {
  it("列出被改过的文件、只在用户目录的文件，以及用户目录里缺的技能", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-diff-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    makeSource(source, "built-in");
    makeSource(source, "other-built-in");
    mkdirSync(join(target, "built-in"), { recursive: true });
    writeFileSync(join(target, "built-in", "SKILL.md"), "用户改坏的\n", "utf8");
    writeFileSync(join(target, "built-in", "mine.md"), "我自己加的\n", "utf8");

    const diff = diffBundledSkills({ sourceDir: source, targetDir: target });
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.skill).toBe("built-in");
    expect(diff.entries[0]?.differs).toContain("SKILL.md");
    expect(diff.entries[0]?.differs).toContain("extra.md");
    expect(diff.entries[0]?.extra).toEqual(["mine.md"]);
    expect(diff.missing).toEqual(["other-built-in"]);
    // 文件数含缺失技能要装进去的文件：built-in 的 2 个 + other-built-in 的 2 个
    expect(diff.files).toBe(4);
  });

  it("完全一致时没有差异", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-diff-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    makeSource(source, "built-in");
    restoreBundledSkills({ sourceDir: source, targetDir: target });
    expect(diffBundledSkills({ sourceDir: source, targetDir: target }).entries).toEqual([]);
  });
});

describe("技能文件清单", () => {
  it("能力面列出包内全部文件（含 .json），供维护与校验使用", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-list-"));
    roots.push(root);
    const dir = makeSource(root, "built-in");
    writeFileSync(join(dir, "concepts.json"), "{}", "utf8");
    const files = listSkillFiles("built-in", [root]);
    expect(files).toContain("SKILL.md");
    expect(files).toContain("extra.md");
    expect(files).toContain("concepts.json");
  });
});

describe("技能文件清单", () => {
  it("能力面列出包内全部文件（含 .json），供维护与校验使用", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-list-"));
    roots.push(root);
    const dir = makeSource(root, "built-in");
    writeFileSync(join(dir, "concepts.json"), "{}", "utf8");
    const files = listSkillFiles("built-in", [root]);
    expect(files).toContain("SKILL.md");
    expect(files).toContain("extra.md");
    expect(files).toContain("concepts.json");
  });
});
