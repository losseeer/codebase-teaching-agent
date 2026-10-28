import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dedupeFileReads, executeReadFile, pathReadBlock, READ_FILE_TOOL, type FileReadRecord } from "./read-file.js";
import { readFileLines } from "@codebase-tutor/platform";

let repoRoot = "";
/** 仓库之外的目录，只作软链接的目标。 */
let outsideRoot = "";

/** 只放一条命名管道的临时目录；mkfifo 不可用时，用它跑的两条用例记为 skipped。 */
const pipeDir = mkdtempSync(join(tmpdir(), "tutor-pipe-"));
const hasMkfifo = spawnSync("mkfifo", [join(pipeDir, "pipe.txt")]).status === 0;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "tutor-readfile-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "tutor-readfile-out-"));
  writeFileSync(join(repoRoot, ".env"), "OPENAI_API_KEY=sk-secret\n");
  writeFileSync(join(repoRoot, ".env.example"), "OPENAI_API_KEY=sk-replace-me\n");
  mkdirSync(join(repoRoot, "config"));
  writeFileSync(join(repoRoot, "config/prod.env"), "OPENAI_API_KEY=sk-secret\n");
  writeFileSync(join(repoRoot, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_secret\n");
  writeFileSync(join(repoRoot, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  writeFileSync(join(repoRoot, "credentials.json"), "{\"aws_access_key_id\":\"AKIA\"}\n");
  writeFileSync(join(repoRoot, ".netrc"), "machine api.example.com password hunter2\n");
  writeFileSync(join(repoRoot, "poetry.lock"), "[[package]]\nname = \"x\"\n");
  writeFileSync(join(repoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src/app.ts"), Array.from({ length: 300 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n"));
  // 700 行短行验行数钳制，700 行长行验字符预算
  writeFileSync(join(repoRoot, "src/long.ts"), Array.from({ length: 700 }, (_, index) => `x${index + 1} = 1;`).join("\n"));
  writeFileSync(join(repoRoot, "src/dense.ts"), Array.from({ length: 700 }, (_, index) => `export const value${index + 1} = compute(${index}, "${"x".repeat(60)}", ${index * 3}, ${index * 7});`).join("\n"));
  writeFileSync(join(repoRoot, "server.key"), "-----BEGIN PRIVATE KEY-----");
  writeFileSync(join(repoRoot, "logo.png"), "binary-ish");
  mkdirSync(join(repoRoot, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(repoRoot, "node_modules/pkg/index.js"), "module.exports = 1;");
  mkdirSync(join(repoRoot, ".git"));
  writeFileSync(join(repoRoot, ".git/config"), "[core]");
  // 链接名无害、目标是仓内密钥或仓外文件，需复核链接目标
  writeFileSync(join(outsideRoot, "secret.txt"), "OUTSIDE-SECRET\n");
  symlinkSync(join(repoRoot, ".env"), join(repoRoot, "notes.md"));
  symlinkSync(join(outsideRoot, "secret.txt"), join(repoRoot, "escape.ts"));
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
  rmSync(pipeDir, { recursive: true, force: true });
});

describe("executeReadFile 护栏", () => {
  it("工具定义暴露 read_file 名称与 path 必填", () => {
    expect(READ_FILE_TOOL.name).toBe("read_file");
    expect((READ_FILE_TOOL.parameters as { required: string[] }).required).toContain("path");
  });

  it.skipIf(!hasMkfifo)("命名管道没有 EOF：判成「不是普通文件」就拒，不碰同步读", () => {
    const outcome = executeReadFile(pipeDir, JSON.stringify({ path: "pipe.txt" }));
    expect(outcome.audit.denied).toBe(true);
    expect(outcome.content).toContain("不是普通文件");
  });

  it.skipIf(!hasMkfifo)("readFileLines 同一口径：非普通文件返回 undefined，不阻塞", () => {
    expect(readFileLines(pipeDir, "pipe.txt")).toBeUndefined();
  });

  it("拒绝 .env（防密钥进 prompt）", () => {
    const outcome = executeReadFile(repoRoot, JSON.stringify({ path: ".env" }));
    expect(outcome.audit.denied).toBe(true);
    expect(outcome.content).toContain("已拒绝");
  });

  it("放行 .env 模板：只列键名、不含密钥，是理解配置的入口", () => {
    const outcome = executeReadFile(repoRoot, JSON.stringify({ path: ".env.example" }));
    expect(outcome.audit.denied).toBe(false);
    expect(outcome.content).toContain("OPENAI_API_KEY=sk-replace-me");
  });

  it("拒绝 .env 的后缀写法，以及无扩展名的密钥/凭据载体", () => {
    for (const path of ["config/prod.env", ".npmrc", "id_rsa", "credentials.json", ".netrc"]) {
      expect(executeReadFile(repoRoot, JSON.stringify({ path })).audit.denied, path).toBe(true);
    }
  });

  it("锁文件口径一致：poetry.lock 与 pnpm-lock.yaml 同结论（都是依赖清单，不是二进制）", () => {
    expect(executeReadFile(repoRoot, JSON.stringify({ path: "poetry.lock" })).audit.denied).toBe(false);
    expect(executeReadFile(repoRoot, JSON.stringify({ path: "pnpm-lock.yaml" })).audit.denied).toBe(false);
  });

  it("拒绝密钥后缀与二进制后缀", () => {
    expect(executeReadFile(repoRoot, JSON.stringify({ path: "server.key" })).audit.denied).toBe(true);
    expect(executeReadFile(repoRoot, JSON.stringify({ path: "logo.png" })).audit.denied).toBe(true);
  });

  it("拒绝 node_modules 与 .git 目录", () => {
    expect(executeReadFile(repoRoot, JSON.stringify({ path: "node_modules/pkg/index.js" })).audit.denied).toBe(true);
    expect(executeReadFile(repoRoot, JSON.stringify({ path: ".git/config" })).audit.denied).toBe(true);
  });

  it("拒绝路径穿越与绝对路径", () => {
    expect(executeReadFile(repoRoot, JSON.stringify({ path: "../outside.ts" })).audit.denied).toBe(true);
    expect(executeReadFile(repoRoot, JSON.stringify({ path: "/etc/passwd" })).audit.denied).toBe(true);
  });

  it("软链接不能绕过边界与名单：目标是仓内 .env 或仓外文件时一律拒绝，正文一个字都不给", () => {
    for (const path of ["notes.md", "escape.ts"]) {
      const outcome = executeReadFile(repoRoot, JSON.stringify({ path }));
      expect(outcome.audit.denied, path).toBe(true);
      expect(outcome.content, path).not.toContain("sk-secret");
      expect(outcome.content, path).not.toContain("OUTSIDE-SECRET");
    }
  });

  /** 界面侧与工具侧共用同一份读取判据。 */
  it("pathReadBlock 与 read_file 同一判据：链接目标也过边界与名单，存在性交给调用方", () => {
    expect(pathReadBlock(repoRoot, "src/app.ts"), "正常源码放行").toBeUndefined();
    expect(pathReadBlock(repoRoot, "../outside.ts")).toContain("越出仓库范围");
    expect(pathReadBlock(repoRoot, "/etc/passwd")).toContain("只允许仓库内相对路径");
    expect(pathReadBlock(repoRoot, "credentials.json")).toContain("不开放读取");
    expect(pathReadBlock(repoRoot, "notes.md"), "链接指向仓内 .env 也算绕过名单").toContain("符号链接指向禁读文件");
    expect(pathReadBlock(repoRoot, "escape.ts"), "链接指向仓外文件").toContain("符号链接指向仓库之外");
    // 文件不存在不由这一层判定
    expect(pathReadBlock(repoRoot, "src/gone.ts")).toBeUndefined();
  });

  it("拒绝非法 JSON 与缺 path", () => {
    expect(executeReadFile(repoRoot, "not json").audit.error).toBe("invalid_json");
    expect(executeReadFile(repoRoot, "{}").audit.error).toBe("missing_path");
  });

  it("正常读取返回带行号内容，支持行窗口", () => {
    const outcome = executeReadFile(repoRoot, JSON.stringify({ path: "src/app.ts", offset: 10, limit: 5 }));
    expect(outcome.audit.denied).toBe(false);
    expect(outcome.audit.lines).toBe(5);
    expect(outcome.content).toContain("10| export const line10 = 10;");
    expect(outcome.content).toContain("14| export const line14 = 14;");
    expect(outcome.content).not.toContain("line15");
  });

  // 窗口固定在 40_000 token：行数预算 320 行，字符预算 12_800
  const WINDOW = "40000";

  it("limit 超出行预算时被钳到那一行预算，首行给出文件总行数（钳制 ≠ 截断）", () => {
    process.env.TUTOR_CONTEXT_WINDOW_TOKENS = WINDOW;
    try {
      const outcome = executeReadFile(repoRoot, JSON.stringify({ path: "src/long.ts", limit: 100_000 }));
      expect(outcome.audit.lines).toBe(320);
      expect(outcome.audit.truncated).toBe(false);
      expect(outcome.content.split("\n")[0]).toContain("第 1-320 行，共 700 行");
    } finally {
      delete process.env.TUTOR_CONTEXT_WINDOW_TOKENS;
    }
  });

  it("超字符预算时少给整行：首行报的是实得区间、并给出续读 offset", () => {
    process.env.TUTOR_CONTEXT_WINDOW_TOKENS = WINDOW;
    try {
      const outcome = executeReadFile(repoRoot, JSON.stringify({ path: "src/dense.ts", limit: 320 }));
      expect(outcome.audit.truncated).toBe(true);
      const [header, ...body] = outcome.content.split("\n");
      const claimed = header.match(/第 (\d+)-(\d+) 行/);
      expect(claimed).not.toBeNull();
      const end = Number(claimed![2]);
      // 首行声称的末行 == 正文最后一条行号 == audit.lines，三者必须一致
      const numbers = body.filter((line) => /^\d+\| /.test(line)).map((line) => Number(line.slice(0, line.indexOf("|"))));
      expect(numbers[0]).toBe(1);
      expect(numbers[numbers.length - 1]).toBe(end);
      expect(end).toBe(outcome.audit.lines);
      expect(end).toBeLessThan(320);
      expect(header).toContain("共 700 行");
      expect(header).toContain(`offset=${end + 1}`);
    } finally {
      delete process.env.TUTOR_CONTEXT_WINDOW_TOKENS;
    }
  });
});

describe("dedupeFileReads（journal 落盘归并：审计回答「看过哪些文件」）", () => {
  const rec = (path: string, extra: Partial<FileReadRecord> = {}): FileReadRecord => ({ path, truncated: false, denied: false, ...extra });

  it("同路径只留一条：成功条目里取实得行数最大的一条，顺序保持首次出现", () => {
    const merged = dedupeFileReads([rec("a.ts", { lines: 60 }), rec("b.ts"), rec("a.ts", { lines: 100 }), rec("a.ts", { lines: 95 })]);
    expect(merged).toEqual([rec("a.ts", { lines: 100 }), rec("b.ts")]);
  });

  it("成功优先于拒绝；全体被拒时保留首条（错误原因不丢）", () => {
    expect(dedupeFileReads([rec("x.ts", { denied: true, error: "invalid_json" }), rec("x.ts", { lines: 5 })])).toEqual([rec("x.ts", { lines: 5 })]);
    expect(dedupeFileReads([rec("x.ts", { denied: true, error: "first_reason" }), rec("x.ts", { denied: true, error: "second_reason", lines: 9 })])).toEqual([rec("x.ts", { denied: true, error: "first_reason" })]);
  });
});

/** 入口过筛：文件名干净但内容里带真 key 时，隐去发生在交给模型之前，且首行要说明。 */
describe("read_file 的密钥隐去", () => {
  it("硬编码在普通源文件里的 key 被隐去、数量进审计，正常代码一字不动", () => {
    writeFileSync(join(repoRoot, "src/config.ts"), `export const key = "sk-abcdefghijklmnop1234";\nexport const placeholder = "YOUR_KEY";\n`, "utf8");
    const withSecret = executeReadFile(repoRoot, JSON.stringify({ path: "src/config.ts" }));
    expect(withSecret.audit.masked).toBe(1);
    expect(withSecret.content).toContain("[疑似密钥，已隐去]");
    expect(withSecret.content).toContain("另有 1 处疑似密钥已隐去（不要尝试补全）");
    expect(withSecret.content).not.toContain("sk-abcdefghijklmnop");
    // YOUR_KEY 是占位符，不算密钥
    expect(withSecret.content).toContain("YOUR_KEY");
    writeFileSync(join(repoRoot, "src/clean.ts"), "export const a = 1;\n", "utf8");
    expect(executeReadFile(repoRoot, JSON.stringify({ path: "src/clean.ts" })).audit.masked).toBeUndefined();
  });
});
