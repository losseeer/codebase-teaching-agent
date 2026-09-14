import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeReadFile, READ_FILE_TOOL } from "./tools.js";

let repoRoot = "";

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "tutor-readfile-"));
  writeFileSync(join(repoRoot, ".env"), "TUTOR_OPENAI_API_KEY=sk-secret\n");
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src/app.ts"), Array.from({ length: 300 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n"));
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

  it("limit 超上限被钳制并标注 truncated", () => {
    const outcome = executeReadFile(repoRoot, JSON.stringify({ path: "src/app.ts", limit: 100_000 }));
    expect(outcome.audit.lines).toBe(300);
    expect(outcome.audit.truncated).toBe(true);
  });
});
