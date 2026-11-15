import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import { createSkillUseCase, deleteSkillUseCase, listSkillsUseCase, readSkillUseCase, uploadSkillUseCase, writeSkillUseCase } from "./skills.js";

let dir = "";
const original = process.env.TUTOR_SKILLS_DIR;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tutor-skills-")); process.env.TUTOR_SKILLS_DIR = dir; });
afterEach(() => {
  if (original === undefined) delete process.env.TUTOR_SKILLS_DIR;
  else process.env.TUTOR_SKILLS_DIR = original;
  rmSync(dir, { recursive: true, force: true });
});

const frontmatter = (name: string): string => `---\nname: ${name}\ndescription: demo\n---\n\n# ${name}\n`;

describe("用户技能读写", () => {
  it("新建、保存、读取、删除；保存留 .bak 版本", () => {
    expect(createSkillUseCase("demo").ok).toBe(true);
    expect(listSkillsUseCase().map((item) => item.name)).toContain("demo");
    expect(writeSkillUseCase("demo", frontmatter("demo")).ok).toBe(true);
    expect(readSkillUseCase("demo")).toMatchObject({ ok: true });
    expect(deleteSkillUseCase("demo").ok).toBe(true);
    expect(listSkillsUseCase()).toEqual([]);
  });

  it("上传单个 .md 与带一层目录的 .zip", () => {
    const md = Buffer.from(frontmatter("from-md")).toString("base64");
    expect(uploadSkillUseCase("from-md", "skill.md", md).ok).toBe(true);
    expect(readSkillUseCase("from-md")).toMatchObject({ ok: true });

    const zip = Buffer.from(zipSync({
      "bundle/SKILL.md": strToU8(frontmatter("from-zip")),
      "bundle/reference.md": strToU8("# reference")
    })).toString("base64");
    expect(uploadSkillUseCase("from-zip", "bundle.zip", zip).ok).toBe(true);
    expect(readSkillUseCase("from-zip")).toMatchObject({ ok: true });
  });

  it("拒绝越界路径与缺少 frontmatter 的正文", () => {
    expect(writeSkillUseCase("bad", "no frontmatter").ok).toBe(false);
    const zip = Buffer.from(zipSync({ "../evil.md": strToU8("x") })).toString("base64");
    expect(uploadSkillUseCase("evil", "evil.zip", zip).ok).toBe(false);
  });
});
