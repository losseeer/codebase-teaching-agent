import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sliceExcerpt } from "./excerpt.js";

const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

/** 19 行 fixture：alpha 占 3-6 行，beta 占 17-19 行，中间为空行。 */
function fixtureRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "codebase-tutor-excerpt-"));
  repositories.push(repository);
  mkdirSync(join(repository, "src"), { recursive: true });
  const lines = ["// 文件头注释", "", "export function alpha() {", "  const value = readConfig();", "  return value;", "}", ...Array.from({ length: 10 }, () => ""), "export function beta() {", "  return 2;", "}"];
  writeFileSync(join(repository, "src/a.ts"), lines.join("\n"), "utf8");
  return repository;
}

const options = { before: 2, after: 3, maxSymbolLines: 80, maxChars: 4_000 };

describe("sliceExcerpt", () => {
  it("逐行取段也挡得住私钥块正文：跨行模式在这里命不中，靠行状态", () => {
    const repository = mkdtempSync(join(tmpdir(), "codebase-tutor-excerpt-pem-"));
    repositories.push(repository);
    writeFileSync(join(repository, "config.ts"), [
      "const key = `",
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "AgMBAAECggEAR8UJ6YUkPz0wZ3tQ9Y4hY1mXc0kM2n7u",
      "-----END PRIVATE KEY-----",
      "`;"
    ].join("\n"), "utf8");
    const slice = sliceExcerpt(repository, { path: "config.ts", line: 2, endLine: 5 }, options);
    const text = slice?.lines.map((item) => item.text).join("\n") ?? "";
    expect(text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7");
    expect(text).not.toContain("AgMBAAECggEAR8UJ6YUkPz0wZ3tQ9Y4hY1mXc0kM2n7u");
    expect(slice?.masked, "块里每一行都算一处被隐去").toBe(4);
  });
  it("有可信符号边界时只取符号自身行区间（不受空白行影响）", () => {
    const repository = fixtureRepository();
    const slice = sliceExcerpt(repository, { path: "src/a.ts", line: 3, endLine: 6 }, options);
    expect(slice).toMatchObject({ from: 3, to: 6, mode: "symbol", truncated: false, symbolEnd: 6 });
    expect(slice?.lines.map((item) => item.line)).toEqual([3, 4, 5, 6]);
    expect(slice?.lines[0].text).toContain("export function alpha");
  });

  it("符号跨度超过上限时取符号开头到上限，并标记截断与真实结尾行", () => {
    const repository = fixtureRepository();
    const slice = sliceExcerpt(repository, { path: "src/a.ts", line: 3, endLine: 90 }, { ...options, maxSymbolLines: 8 });
    expect(slice).toMatchObject({ from: 3, to: 10, mode: "symbol", truncated: true, symbolEnd: 19 });
  });

  it("endLine 缺失或非法时回落固定窗口", () => {
    const repository = fixtureRepository();
    expect(sliceExcerpt(repository, { path: "src/a.ts", line: 17 }, options)).toMatchObject({ from: 15, to: 19, mode: "window" });
    expect(sliceExcerpt(repository, { path: "src/a.ts", line: 17, endLine: 17 }, options)).toMatchObject({ from: 15, to: 19, mode: "window" });
  });

  it("达到单块字符上限时截断并如实报告实际结束行", () => {
    const repository = fixtureRepository();
    const slice = sliceExcerpt(repository, { path: "src/a.ts", line: 3, endLine: 6 }, { ...options, maxChars: 30 });
    expect(slice?.truncated).toBe(true);
    expect(slice?.lines).toHaveLength(1);
    expect(slice?.to).toBe(3);
  });

  it("行号超出文件长度时收敛到末行，不越界读取", () => {
    const repository = fixtureRepository();
    expect(sliceExcerpt(repository, { path: "src/a.ts", line: 999 }, options)).toMatchObject({ from: 17, to: 19 });
  });

  it("路径越界或文件不存在返回 undefined", () => {
    const repository = fixtureRepository();
    expect(sliceExcerpt(repository, { path: "../outside.ts", line: 1 }, options)).toBeUndefined();
    expect(sliceExcerpt(repository, { path: "src/missing.ts", line: 1 }, options)).toBeUndefined();
  });

  it("锚点窗口里的疑似密钥在出门前被隐去，并报告处数（入口那道隐密钥规则同样铺到摘录）", () => {
    const repository = mkdtempSync(join(tmpdir(), "codebase-tutor-excerpt-secret-"));
    repositories.push(repository);
    writeFileSync(join(repository, "config.ts"), ['export const endpoint = "https://api.internal";', 'export const token = "sk-abcdefghijklmnopqrstuvwx";', "export const region = 1;"].join("\n"), "utf8");
    const slice = sliceExcerpt(repository, { path: "config.ts", line: 2 }, options);
    const sent = slice?.lines.map((item) => item.text).join("\n") ?? "";
    expect(sent).toContain("[疑似密钥，已隐去]");
    expect(sent).not.toContain("sk-abcdefghijklmnop");
    expect(slice?.masked).toBe(1);
    // 无隐去时不返回 masked 字段
    expect(sliceExcerpt(fixtureRepository(), { path: "src/a.ts", line: 3, endLine: 6 }, options)?.masked).toBeUndefined();
  });
});
