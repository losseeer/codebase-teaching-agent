import { describe, expect, it } from "vitest";
import { guardLlmProposal, type GuardCandidate, type LlmExerciseProposal } from "./guard-proposal.js";
import { clipProposalTitle, MAX_PROPOSAL_TITLE } from "./llm-generate.js";

const candidates: GuardCandidate[] = [
  { path: "src/config.ts", excerpt: "1| export function clamp(value: number) {\n2|   return value;", lineCount: 2 },
  { path: "src/app.ts", excerpt: "1| import { clamp } from \"./config.js\";", lineCount: 1 }
];

function proposal(overrides: Partial<LlmExerciseProposal> = {}): LlmExerciseProposal {
  return {
    title: "预测 clamp 的边界行为",
    prompt: "阅读 src/config.ts 中第 1-2 行的 clamp 函数。当传入 0 时它返回什么，为什么？请解释这段代码的处理意图。",
    answerKey: "传入 0 时返回 0，因为函数体没有对 0 做特殊处理，直接返回原值。",
    criteria: [
      { dimension: "正确性", description: "正确指出返回值为 0" },
      { dimension: "解释性", description: "说明了直接返回原值的行为" }
    ],
    anchors: [{ path: "src/config.ts", line: 1, endLine: 2 }],
    targetTitle: "clamp",
    ...overrides
  };
}

describe("LLM 出题守门", () => {
  it("放行字段齐全、锚点真实、无泄漏的提案", () => {
    expect(guardLlmProposal(proposal(), candidates)).toEqual([]);
  });

  it("契约检查：空字段、缺细则、缺锚点都要否决", () => {
    expect(guardLlmProposal(proposal({ prompt: " " }), candidates).some((issue) => issue.check === "contract")).toBe(true);
    expect(guardLlmProposal(proposal({ criteria: [] }), candidates).some((issue) => issue.check === "contract")).toBe(true);
    expect(guardLlmProposal(proposal({ answerKey: "" }), candidates).some((issue) => issue.check === "contract")).toBe(true);
    expect(guardLlmProposal(proposal({ anchors: [] }), candidates).some((issue) => issue.check === "fact")).toBe(true);
  });

  it("事实检查：锚点不在候选摘录集合内 / 行号越界都要否决", () => {
    const hallucinated = proposal({ anchors: [{ path: "src/invented.ts", line: 1 }] });
    expect(guardLlmProposal(hallucinated, candidates).some((issue) => issue.message.includes("不在出题候选摘录中"))).toBe(true);
    const outOfRange = proposal({ anchors: [{ path: "src/config.ts", line: 99 }] });
    expect(guardLlmProposal(outOfRange, candidates).some((issue) => issue.message.includes("行号超出候选摘录范围"))).toBe(true);
  });

  it("泄漏检查：题面包含参考答案片段要否决；短答案不触发", () => {
    const leaking = proposal({ prompt: "传入 0 时返回 0，因为函数体没有对 0 做特殊处理。这题怎么分析？" });
    expect(guardLlmProposal(leaking, candidates).some((issue) => issue.check === "leak")).toBe(true);
    const shortKey = proposal({ answerKey: "是 0", prompt: "当传入 0 时它返回什么？" });
    expect(guardLlmProposal(shortKey, candidates).every((issue) => issue.check !== "leak")).toBe(true);
  });
});

describe("候选摘录窗口（startLine）", () => {
  const windowed: GuardCandidate[] = [{ path: "src/deep.ts", excerpt: "100| ...\n120| ...", lineCount: 200, startLine: 100 }];

  it("锚点落在窗口内（>= startLine）不否决", () => {
    const issues = guardLlmProposal(proposal({ anchors: [{ path: "src/deep.ts", line: 120 }] }), windowed);
    expect(issues).toEqual([]);
  });

  it("锚点行号在文件范围内但低于窗口起点时否决", () => {
    const issues = guardLlmProposal(proposal({ anchors: [{ path: "src/deep.ts", line: 10 }] }), windowed);
    expect(issues.some((issue) => issue.check === "fact")).toBe(true);
  });
});

/** 长度口径的两端都在这一条链上：守门只拦废件，标题上限由出题侧解析时截（拒题等于让用户白付这一趟调用）。 */
describe("题面长度：只否决废件，不否决长题", () => {
  it("900 字的题面（旧口径 600 字会整题否决）现在放行", () => {
    expect(guardLlmProposal(proposal({ prompt: "若".repeat(900) }), candidates)).toEqual([]);
  });

  it("超过 4000 字的题面按废件否决", () => {
    const issues = guardLlmProposal(proposal({ prompt: "若".repeat(4_001) }), candidates);
    expect(issues.some((issue) => issue.check === "contract" && issue.message.includes("不像题面"))).toBe(true);
  });

  it("参考答案与评分细则条数仍受控：那是判分依据，不是给人读的散文", () => {
    expect(guardLlmProposal(proposal({ answerKey: "答".repeat(2_001) }), candidates).some((issue) => issue.message.includes("参考答案超长"))).toBe(true);
    const many = Array.from({ length: 7 }, (_, index) => ({ dimension: `维度${index}`, description: "说明" }));
    expect(guardLlmProposal(proposal({ criteria: many }), candidates).some((issue) => issue.message.includes("评分维度太多"))).toBe(true);
  });

  it("标题超长不再否决，改由出题侧截到稳定上限", () => {
    expect(guardLlmProposal(proposal({ title: "标".repeat(200) }), candidates)).toEqual([]);
    expect(clipProposalTitle(`  ${"标".repeat(200)}  `)).toHaveLength(MAX_PROPOSAL_TITLE);
  });
});
