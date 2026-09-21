import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dedupeFileReads, executeReadFile, READ_FILE_TOOL, type FileReadRecord } from "./read-file.js";

let repoRoot = "";

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "tutor-readfile-"));
  writeFileSync(join(repoRoot, ".env"), "TUTOR_OPENAI_API_KEY=sk-secret\n");
  writeFileSync(join(repoRoot, ".env.example"), "TUTOR_OPENAI_API_KEY=sk-replace-me\n");
  mkdirSync(join(repoRoot, "config"));
  writeFileSync(join(repoRoot, "config/prod.env"), "TUTOR_OPENAI_API_KEY=sk-secret\n");
  writeFileSync(join(repoRoot, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_secret\n");
  writeFileSync(join(repoRoot, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  writeFileSync(join(repoRoot, "credentials.json"), "{\"aws_access_key_id\":\"AKIA\"}\n");
  writeFileSync(join(repoRoot, ".netrc"), "machine api.example.com password hunter2\n");
  writeFileSync(join(repoRoot, "poetry.lock"), "[[package]]\nname = \"x\"\n");
  writeFileSync(join(repoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src/app.ts"), Array.from({ length: 300 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n"));
  // 700 行极短行（400 行仍远低于字符预算 → 单独验行数钳制）与 700 行长行（验字符预算）
  writeFileSync(join(repoRoot, "src/long.ts"), Array.from({ length: 700 }, (_, index) => `x${index + 1} = 1;`).join("\n"));
  writeFileSync(join(repoRoot, "src/dense.ts"), Array.from({ length: 700 }, (_, index) => `export const value${index + 1} = compute(${index}, "${"x".repeat(60)}", ${index * 3}, ${index * 7});`).join("\n"));
  writeFileSync(join(repoRoot, "server.key"), "-----BEGIN PRIVATE KEY-----");
  writeFileSync(join(repoRoot, "logo.png"), "binary-ish");
  mkdirSync(join(repoRoot, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(repoRoot, "node_modules/pkg/index.js"), "module.exports = 1;");
  mkdirSync(join(repoRoot, ".git"));
  writeFileSync(join(repoRoot, ".git/config"), "[core]");
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("executeReadFile 护栏", () => {
  it("工具定义暴露 read_file 名称与 path 必填", () => {
    expect(READ_FILE_TOOL.name).toBe("read_file");
    expect((READ_FILE_TOOL.parameters as { required: string[] }).required).toContain("path");
  });

  it("拒绝 .env（防密钥进 prompt）", () => {
    const outcome = executeReadFile(repoRoot, JSON.stringify({ path: ".env" }));
    expect(outcome.audit.denied).toBe(true);
    expect(outcome.content).toContain("已拒绝");
  });

  it("放行 .env 模板：只列键名、不含密钥，是理解配置的入口", () => {
    const outcome = executeReadFile(repoRoot, JSON.stringify({ path: ".env.example" }));
    expect(outcome.audit.denied).toBe(false);
    expect(outcome.content).toContain("TUTOR_OPENAI_API_KEY=sk-replace-me");
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

  it("limit 超上限被钳制到 400 行，首行给出文件总行数（钳制 ≠ 截断）", () => {
    const outcome = executeReadFile(repoRoot, JSON.stringify({ path: "src/long.ts", limit: 100_000 }));
    expect(outcome.audit.lines).toBe(400);
    expect(outcome.audit.truncated).toBe(false);
    expect(outcome.content.split("\n")[0]).toContain("第 1-400 行，共 700 行");
  });

  it("超字符预算时少给整行：首行报的是实得区间、并给出续读 offset", () => {
    const outcome = executeReadFile(repoRoot, JSON.stringify({ path: "src/dense.ts", limit: 400 }));
    expect(outcome.audit.truncated).toBe(true);
    const [header, ...body] = outcome.content.split("\n");
    const claimed = header.match(/第 (\d+)-(\d+) 行/);
    expect(claimed).not.toBeNull();
    const end = Number(claimed![2]);
    // 首行声称的末行 == 正文最后一条行号 == audit.lines，三者必须一致（这正是以前没说清楚的地方）
    const numbers = body.filter((line) => /^\d+\| /.test(line)).map((line) => Number(line.slice(0, line.indexOf("|"))));
    expect(numbers[0]).toBe(1);
    expect(numbers[numbers.length - 1]).toBe(end);
    expect(end).toBe(outcome.audit.lines);
    expect(end).toBeLessThan(400);
    expect(header).toContain("共 700 行");
    expect(header).toContain(`offset=${end + 1}`);
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
