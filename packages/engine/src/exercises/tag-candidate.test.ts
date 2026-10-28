import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTagCandidate } from "./llm-generate.js";

/**
  规则侧候选摘录的取码口径：窗口跟着符号边界走，长注释块折成一行标注。
  startLine 与 endLine 始终是文件真实行号。
 */
const root = mkdtempSync(join(tmpdir(), "tutor-tag-candidate-"));

beforeAll(() => {
  writeFileSync(join(root, "body.ts"), [
    "export function target(a: number): number {",
    "  // 说明一",
    "  // 说明二",
    "  // 说明三",
    "  // 说明四",
    "  // 说明五",
    "  return a + 1;",
    "}",
    "",
    "export function unrelated(): void {",
    '  console.log("不该进摘录");',
    "}"
  ].join("\n"), "utf8");
  writeFileSync(join(root, "short.ts"), [
    "export function target(a: number): number {",
    "  // 说明一",
    "  // 说明二",
    "  // 说明三",
    "  return a + 1;",
    "}"
  ].join("\n"), "utf8");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("候选摘录按符号边界开窗", () => {
  it("只给符号自身的行区间，锚点旁边的无关函数不进摘录", () => {
    const candidate = buildTagCandidate(root, "body.ts", { start: 1, end: 8 });
    expect(candidate?.excerpt).toContain("1| export function target");
    expect(candidate?.excerpt).toContain("7|   return a + 1;");
    expect(candidate?.excerpt, "第 10 行的 unrelated 与锚点无关，不该被硬窗端进来").not.toContain("unrelated");
    expect(candidate?.startLine).toBe(1);
    expect(candidate?.endLine).toBe(8);
  });

  it("连续 5 行注释折成一行标注，被折的行号不再出现在摘录里", () => {
    const candidate = buildTagCandidate(root, "body.ts", { start: 1, end: 8 });
    const excerpt = candidate?.excerpt ?? "";
    expect(excerpt).toContain("…（第 2-6 行是注释，省略 5 行）");
    expect(excerpt).not.toContain("2|   // 说明一");
    expect(excerpt, "折叠后出门的行数少于行跨度，末行仍要报真实行号").toBe(
      ["1| export function target(a: number): number {", "…（第 2-6 行是注释，省略 5 行）", "7|   return a + 1;", "8| }"].join("\n")
    );
  });

  it("三行注释不折：短注释常常正是题目要问的内容", () => {
    const excerpt = buildTagCandidate(root, "short.ts", { start: 1, end: 6 })?.excerpt ?? "";
    expect(excerpt).toContain("3|   // 说明二");
    expect(excerpt).not.toContain("省略");
  });

  it("符号超出窗口上限时截到上限并说明截到哪", () => {
    const candidate = buildTagCandidate(root, "body.ts", { start: 1, end: 8 }, 3);
    expect(candidate?.excerpt).toContain("1| export function target");
    expect(candidate?.excerpt).toContain("…（该符号到第 8 行才结束，摘录只给到第 3 行）");
    expect(candidate?.endLine, "字符/行数上限之后的行没出网，末行只能报到第 3 行").toBe(3);
  });

  it("文件读不到返回 undefined，不编一段空摘录", () => {
    expect(buildTagCandidate(root, "missing.ts", { start: 1, end: 4 })).toBeUndefined();
  });
});
