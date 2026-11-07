import { describe, expect, it } from "vitest";

import { changedLines, normalizeProposal, systemPrompt, tooFarFromSolution, unitFaces, UNIT_HARD_ROUNDS, UNIT_SOFT_ROUNDS, type CodeProposal } from "./code-generate.js";

/** 最小合法产出：三节齐全、path 集合一致、entry 指向 hidden 里的测试文件。 */
const proposal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  language: "typescript",
  kind: "patch_edit",
  title: "缓存顺序",
  prompt: "## 问题描述\n改这里\n## 示例\nf(1)=2\n## 注意事项\n只用标准库",
  given: [{ path: "main.ts", contents: "export const f = () => 1;" }],
  solution: [{ path: "main.ts", contents: "export const f = () => 2;" }],
  hidden: [{ path: "tests.ts", contents: "test('f', () => expect(f()).toBe(2));" }],
  entry: "tests.ts",
  ...over
});

/** 只有 given/solution 会被闸看，其余字段随便合法即可。 */
const proposalBluePrint = {
  kind: "patch_edit", title: "t", prompt: "p", language: "typescript", hidden: [], entry: "tests.ts", defect: ""
} as unknown as CodeProposal;

describe("unit 出题：预算闸", () => {
  it("硬上限 25 轮，软预算 15 轮，和分段口径一致", () => {
    const faces = unitFaces({});
    expect(faces.maxRounds).toBe(UNIT_HARD_ROUNDS);
    const brief = faces.budgetBrief?.({ round: 16, maxRounds: 25, filesRead: 7, newFiles: 0, newPaths: [] }) ?? "";
    expect(brief).toContain(`软预算 ${UNIT_SOFT_ROUNDS}`);
    expect(brief).toContain("已过软预算");
  });

  it("保留调用方原有的 budgetBrief，不覆盖", () => {
    const faces = unitFaces({ budgetBrief: () => "原提示" });
    const brief = faces.budgetBrief?.({ round: 1, maxRounds: 25, filesRead: 1, newFiles: 1, newPaths: ["a.ts"] }) ?? "";
    expect(brief.startsWith("原提示")).toBe(true);
    expect(brief).toContain("已用 1 轮");
  });
});

describe("unit 出题：题面三节校验", () => {
  it("三节齐全通过", () => {
    expect(normalizeProposal(proposal()).proposal).toBeTruthy();
  });

  it("缺一节就判形状错，并点名缺哪节", () => {
    const missed = normalizeProposal(proposal({ prompt: "## 问题描述\n只有这一节" }));
    expect(missed.proposal).toBeUndefined();
    expect(missed.issue).toContain("题面缺这几节");
    expect(missed.issue).toContain("## 示例");
    expect(missed.issue).toContain("## 注意事项");
  });
});

describe("unit 出题：given 允许精简", () => {
  it("systemPrompt 明确可以删注释/空行/无关语句，solution 仍原样", () => {
    const text = systemPrompt("patch_edit", "typescript");
    expect(text).toContain("可以删注释");
    expect(text).toContain("solution 仍要原样");
  });

  it("reference 的 prompt 不受影响（它本来就没有源码绑定）", async () => {
    const { referenceSystemPrompt } = await import("./code-generate.js");
    expect(referenceSystemPrompt("patch_edit")).not.toContain("可以删注释");
  });
});

describe("unit 出题：改一笔闸（B2）", () => {
  const source = ["// 说明：缓存顺序", "class Cache {", "", "  int load() {", "    return 1; // 缺陷：少了失效", "  }", "}"].join("\n");
  const trimmed = ["class Cache {", "  int load() {", "    return 1;", "  }", "}"].join("\n");

  it("given 只删注释与空行时差异为 0，不误杀", () => {
    expect(changedLines(trimmed, source)).toBe(0);
    expect(tooFarFromSolution({ ...proposalBluePrint, given: [{ path: "main.ts", contents: trimmed }], solution: [{ path: "main.ts", contents: source }] })).toBe(false);
  });

  it("整份重写判拒", () => {
    const rewritten = [
      "class Cache {", "  private Map<String, Integer> store = new HashMap<>();", "  private int hits;",
      "  int load(String key) {", "    if (store.containsKey(key)) { hits += 1; return store.get(key); }",
      "    int value = compute(key);", "    store.put(key, value);", "    return value;", "  }",
      "  int compute(String key) { return key.hashCode(); }", "}"
    ].join("\n");
    expect(tooFarFromSolution({ ...proposalBluePrint, given: [{ path: "main.ts", contents: rewritten }], solution: [{ path: "main.ts", contents: source }] })).toBe(true);
  });
});

describe("unit 出题：阅读笔记解析（B1）", () => {
  it("examPoints 原样带出，交给统一校验", () => {
    const parsed = normalizeProposal(proposal({ examPoints: [{ path: "main.ts", line: 3, point: "backend.cache-order", why: "缓存顺序" }] }));
    expect(parsed.proposal?.examPoints).toHaveLength(1);
    expect(normalizeProposal(proposal()).proposal?.examPoints).toBeUndefined();
  });
});
