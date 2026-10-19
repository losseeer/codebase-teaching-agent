import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bundledSkillSource, installBundledSkills, listSkills, readSkill, skillDirectories, skillsBriefing } from "./skills.js";

/**
  技能加载的回归：清单是**每轮都付费**的那一半，正文与附属文件是按需的那一半。
  这里判的都是「装歪了要不要看得见」——静默跳过一份不合规的技能，等于用户以为自己装了。
*/

const root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-skills-")));
const second = join(root, "second");

function skill(base: string, dir: string, body: string): void {
  mkdirSync(join(base, dir), { recursive: true });
  writeFileSync(join(base, dir, "SKILL.md"), body, "utf8");
}

skill(root, "good-one", `---
name: good-one
description: 一份写好的做法：先跑零成本探针，再决定要不要花钱。
allowed-tools: Bash(pnpm:*)
---

# 做法

1. 先跑 \`pnpm arch:blocks <仓库路径>\`（细节见 references/blocking.md）。
`);
mkdirSync(join(root, "good-one", "references"), { recursive: true });
writeFileSync(join(root, "good-one", "references", "blocking.md"), "被藏却含入口文件 = 红线。\n", "utf8");
writeFileSync(join(root, "good-one", "references", "blob.bin"), "x\0y", "utf8");
skill(root, "1024-limit", `---\nname: 1024-limit\ndescription: ${"字".repeat(1025)}\n---\n\n正文。`);
skill(root, "Name-Upper", "---\nname: Name-Upper\ndescription: 名字不合规格。\n---\n\n正文。");
skill(root, "trailing-hyphen-", "---\nname: trailing-hyphen-\ndescription: 首尾不能是连字符。\n---\n\n正文。");
skill(root, "double--dash", "---\nname: double--dash\ndescription: 连续连字符不合规格。\n---\n\n正文。");
skill(root, "name-mismatch", "---\nname: other-name\ndescription: 名字合规格但与目录名不一致。\n---\n\n正文。");
skill(root, "no-desc", "---\nname: no-desc\n---\n\n正文。");
skill(root, "no-frontmatter", "直接就是正文，没有 frontmatter。");
mkdirSync(join(root, "no-skill-file"), { recursive: true });
skill(second, "good-one", "---\nname: good-one\ndescription: 第二个目录里的同名技能，不该被采纳。\n---\n\n正文。");
skill(second, "only-here", "---\nname: only-here\ndescription: 只有这里才有的一份。\n---\n\n正文。");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("清单（按 Agent Skills 规格验形状）", () => {
  it("只采纳形状正确的，其余连原因一起交回（不静默跳）", () => {
    const load = listSkills([root]);
    expect(load.skills.map((entry) => [entry.name, entry.description.slice(0, 6)])).toEqual([["good-one", "一份写好的做"]]);
    const reasons = Object.fromEntries(load.skipped.map((entry) => [entry.dir.split("（")[0], entry.reason]));
    expect(reasons["1024-limit"]).toContain("description 超过规格上限 1024");
    expect(reasons["Name-Upper"]).toContain("name 不合规格");
    expect(reasons["trailing-hyphen-"]).toContain("name 不合规格");
    expect(reasons["double--dash"]).toContain("name 不合规格");
    expect(reasons["name-mismatch"]).toContain("name「other-name」与目录名不一致");
    expect(reasons["no-desc"]).toContain("缺 description");
    expect(reasons["no-frontmatter"]).toContain("缺 name");
    expect(reasons["no-skill-file"]).toContain("没有可读的 SKILL.md");
  });

  it("描述**不裁短**（规格上限 1024 之内原样进清单）", () => {
    const entry = listSkills([root]).skills.find((skill) => skill.name === "good-one");
    expect(entry?.description).toBe("一份写好的做法：先跑零成本探针，再决定要不要花钱。");
  });

  it("多处目录按先后合并：同名只认前一份，后面的报原因", () => {
    const load = listSkills([root, second]);
    expect(load.skills.map((entry) => entry.name)).toEqual(["good-one", "only-here"]);
    expect(load.skills.find((entry) => entry.name === "good-one")?.directory).toBe(root);
    expect(load.skipped.some((entry) => entry.reason.includes("同名技能已在更靠前的目录里装过"))).toBe(true);
  });

  it("目录不存在就一条都不给，也不编一个空清单占位", () => {
    expect(listSkills([join(root, "没这个目录")])).toEqual({ skills: [], skipped: [] });
    expect(skillsBriefing([])).toBe("");
  });

  it("清单里带「先取正文再照做」与附属文件的取法", () => {
    const brief = skillsBriefing(listSkills([root]).skills);
    expect(brief).toContain("- good-one：一份写好的做法");
    expect(brief).toContain("别凭名字猜内容");
    expect(brief).toContain("file 参数");
  });

  it("默认目录是家目录那两处（用户级安装位，含 ~/.claude/skills 以复用已发布的技能包）", () => {
    const previous = process.env.TUTOR_SKILLS_DIR;
    delete process.env.TUTOR_SKILLS_DIR;
    expect(skillDirectories()).toEqual([join(homedir(), ".codebase-tutor", "skills"), join(homedir(), ".claude", "skills")]);
    process.env.TUTOR_SKILLS_DIR = `${root}:${second}`;
    expect(skillDirectories()).toEqual([root, second]);
    process.env.TUTOR_SKILLS_DIR = `${root},${second}`;
    expect(skillDirectories()).toEqual([root, second]);
    if (previous === undefined) delete process.env.TUTOR_SKILLS_DIR;
    else process.env.TUTOR_SKILLS_DIR = previous;
  });
});

describe("取正文与附属文件", () => {
  it("SKILL.md 取到的是 frontmatter 之后的部分", () => {
    const body = readSkill("good-one", undefined, [root]) as string;
    expect(body).toContain("pnpm arch:blocks");
    expect(body).not.toContain("description:");
  });

  it("附属文件按目录内相对路径取（规格第三层：正文引用它们）", () => {
    expect(readSkill("good-one", "references/blocking.md", [root])).toContain("被藏却含入口文件");
  });

  it("跳出技能目录的写法一律不接：绝对路径、.. 段、二进制", () => {
    expect(readSkill("good-one", "/etc/passwd", [root])).toBeUndefined();
    expect(readSkill("good-one", "../no-skill-file/x", [root])).toBeUndefined();
    expect(readSkill("good-one", "references/blob.bin", [root])).toBeUndefined();
    expect(readSkill("good-one", "references/没这个文件.md", [root])).toBeUndefined();
  });

  it("没这份技能回 undefined（工具据此照实回话，不编正文）", () => {
    expect(readSkill("no-such", undefined, [root])).toBeUndefined();
    expect(readSkill("../../etc", undefined, [root])).toBeUndefined(); // 名字不合规格，连试都不试
  });

  it("超长正文截断并留一句声明，不静默裁", () => {
    skill(root, "huge", `---\nname: huge\ndescription: 一份超长的技能正文。\n---\n\n${"字".repeat(20_000)}`);
    const body = readSkill("huge", undefined, [root]) as string;
    expect(body.length).toBeLessThan(20_000);
    expect(body).toContain("正文已截断，共 20000 字");
  });
});

/**
  出厂预置技能的播种：把引擎包里的 `skills/` 复制到 `TUTOR_SKILLS_DIR` 第一处。
  这条通道要拦的事故有两个方向——**冲掉用户改过的那份**，和**把坏形状搬进人家目录**（之后每轮多一条噪音，
  且没人说得清是谁搬进来的）。所以两条都各测一条，外加「源目录指得对」这条自证。
*/
describe("出厂预置技能播种", () => {
  const seedRoot = join(root, "seed");
  const source = join(seedRoot, "src");
  const target = join(seedRoot, "target");

  it("只装合规格的，整目录搬（含附属文件），目标不存在就建出来", () => {
    skill(source, "tutor-cost-audit", "---\nname: tutor-cost-audit\ndescription: 对账一次对话花了多少钱。\n---\n\n先看 llm.log。");
    mkdirSync(join(source, "tutor-cost-audit", "references"), { recursive: true });
    writeFileSync(join(source, "tutor-cost-audit", "references", "lines.md"), "两条账的落点。\n", "utf8");
    skill(source, "Broken_Name", "---\nname: Broken_Name\ndescription: 名字不合规格，不该被搬走。\n---\n\n正文。");
    writeFileSync(join(source, "README.md"), "顶层的说明文件不是技能，不该进读数。", "utf8");
    const seeded = installBundledSkills({ sourceDir: source, targetDir: target });
    expect(seeded.installed).toEqual(["tutor-cost-audit"]);
    expect(readFileSync(join(target, "tutor-cost-audit", "references", "lines.md"), "utf8")).toContain("两条账的落点");
    // 坏形状连原因一起回，但**没搬**；顶层的 README.md 是文件，加载器本来就不看它
    expect(seeded.skipped.map((entry) => entry.dir)).toEqual([expect.stringContaining("Broken_Name")]);
    expect(seeded.skipped[0].reason).toContain("name 不合规格");
    expect(existsSync(join(target, "Broken_Name"))).toBe(false);
    // 装完就该被加载器认出来：播种与读取是同一套判据，不是两份规则
    expect(listSkills([target]).skills.map((entry) => entry.name)).toEqual(["tutor-cost-audit"]);
  });

  it("同名一律不覆盖，第二次开机什么都不做", () => {
    skill(target, "tutor-cost-audit", "---\nname: tutor-cost-audit\ndescription: 我自己改过的一份。\n---\n\n我的做法。");
    const seeded = installBundledSkills({ sourceDir: source, targetDir: target });
    expect(seeded.installed).toEqual([]);
    expect(seeded.kept).toEqual(["tutor-cost-audit"]);
    expect(readSkill("tutor-cost-audit", "SKILL.md", [target])).toContain("我的做法");
  });

  it("引擎包里的出厂目录解析得到，装的正是那四份可视化技能（一份通用 + 三份图类型）", () => {
    const found = bundledSkillSource();
    expect(found, "解析不到 packages/engine/skills ⇒ 播种会静默什么都不做").toBeTruthy();
    expect(found!.endsWith(join("packages", "engine", "skills"))).toBe(true);
    const seeded = installBundledSkills({ sourceDir: found, targetDir: join(seedRoot, "bundled-target") });
    expect(seeded.skipped, "出厂技能形状不合规就是给自己留一条永久噪音").toEqual([]);
    expect(seeded.installed.sort()).toEqual(["diagram-architecture", "diagram-flow", "diagram-sequence", "project-visualization"]);
    // 清单每轮都进上下文：这一句钉住「出厂技能不能写成解释性长文」
    for (const skill of listSkills([join(seedRoot, "bundled-target")]).skills) {
      expect(skill.description.length, skill.name).toBeLessThan(300);
      expect(readSkill(skill.name, "SKILL.md", [join(seedRoot, "bundled-target")]), skill.name).toContain("证据");
    }
  });
});
