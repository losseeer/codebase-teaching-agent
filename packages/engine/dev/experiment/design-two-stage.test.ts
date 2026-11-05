/** [DEV ONLY] 两段 / 三段生成包确定性部分的回归：schema、骨架、组装、定向修复决策。 */
import { describe, expect, it } from "vitest";

import {
  assembleProposal, generateTwoStage, implSchema, LANGUAGES, parseStageJson, planSchema,
  promptSectionsComplete, repairTargetFor, shapeStageFiles, skeletonSatisfied, stageOneSchema,
  testSkeleton, testsSchema,
  type StageImpl, type StagePlan, type StageTests
} from "./design-two-stage.js";
import type { LlmCompletionInput, LlmProvider, LlmUsage } from "../../src/application/port/llm-provider.js";
import type { CodeProposal, HarnessRun } from "../../src/exercises/code-generate.js";

const prompt = "## 问题描述\n把函数改对。\n\n## 示例\nf(0) → 0\n\n## 注意事项\n只用标准库。";

const plan: StagePlan = {
  ok: true, language: "typescript", title: "修好边界", prompt, defect: "边界比较符写反",
  anchors: [{ path: "src/a.ts", line: 3, endLine: 8, why: "边界写法" }]
};

const impl: StageImpl = {
  given: [{ path: "target.ts", contents: "export function f(n: number) { return n > 0; }" }],
  solution: [{ path: "target.ts", contents: "export function f(n: number) { return n >= 0; }" }]
};

function testsFor(language: StagePlan["language"]): StageTests {
  const skeleton = testSkeleton(language);
  const contents = skeleton.template
    .replace("// <IMPORTS>", 'import { f } from "./target.ts";')
    .replace("# <IMPORTS>", "from target import f")
    .replace("<ASSERTIONS>", [
      'check("零边界", () => f(0) === true);',
      'check("正数", () => f(1) === true);'
    ].join("\n"));
  return { hidden: [{ path: skeleton.filename, contents }], entry: skeleton.entry };
}

describe("parseStageJson", () => {
  it("剥围栏并取首尾大括号", () => {
    expect(parseStageJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseStageJson('说明 {"ok":false} 尾巴')).toEqual({ ok: false });
  });
  it("坏 JSON 返回 undefined，不抛", () => {
    expect(parseStageJson("不是 JSON")).toBeUndefined();
    expect(parseStageJson("```json\n{broken}\n```")).toBeUndefined();
  });
});

describe("题面三节", () => {
  it("缺一节即不通过", () => {
    expect(promptSectionsComplete(prompt)).toBe(true);
    expect(promptSectionsComplete("## 问题描述\n## 示例")).toBe(false);
  });
});

describe("schema 与骨架", () => {
  it("plan 语言白名单四语言", () => {
    for (const language of LANGUAGES) expect(planSchema.safeParse({ ...plan, language }).success).toBe(true);
    expect(planSchema.safeParse({ ...plan, language: "csharp" }).success).toBe(false);
  });
  it("impl / tests 的基本形状", () => {
    expect(implSchema.safeParse(impl).success).toBe(true);
    expect(implSchema.safeParse({ ...impl, given: [] }).success).toBe(false);
    expect(testsSchema.safeParse(testsFor("typescript")).success).toBe(true);
  });
  it("四语言骨架都有计数、TESTS 与退出码", () => {
    for (const language of LANGUAGES) {
      const skeleton = testSkeleton(language);
      expect(skeleton.template).toContain("<ASSERTIONS>");
      expect(skeleton.markers.length).toBeGreaterThanOrEqual(3);
      for (const marker of skeleton.markers) expect(skeleton.template).toContain(marker);
      expect(skeletonSatisfied(testsFor(language).hidden[0]!.contents, language)).toBe(true);
    }
  });
  it("少一条断言、留占位符、删结论行都不通过", () => {
    const contents = testsFor("python").hidden[0]!.contents;
    expect(skeletonSatisfied(contents.replace(/check\("正数"[^\n]*\n/, ""), "python")).toBe(false);
    expect(skeletonSatisfied(contents.replace('print(f"TESTS {pass_count} {fail_count}")', ""), "python")).toBe(false);
    expect(skeletonSatisfied(contents.replace("<ASSERTIONS>", "<ASSERTIONS>").replace('check("零边界"', '// <ASSERTIONS>\ncheck("零边界"'), "python")).toBe(false);
  });
  it("文件名/大小/路径按语言校验", () => {
    expect(shapeStageFiles(impl.given, "typescript")).toBeUndefined();
    expect(shapeStageFiles([{ path: "target.py", contents: "x" }], "typescript")).toMatch(/必须以/);
    expect(shapeStageFiles([{ path: "../target.ts", contents: "x" }], "typescript")).toMatch(/非法/);
    expect(shapeStageFiles([{ path: "target.ts", contents: "" }], "typescript")).toMatch(/为空/);
    expect(shapeStageFiles([], "typescript")).toMatch(/文件数/);
  });
});

describe("assembleProposal", () => {
  it("三段合法 → 产品同款 proposal，hidden 含测试 + stubs", () => {
    const result = assembleProposal(plan, { ...impl, stubs: [{ path: "stub.ts", contents: "export const k = 1;" }] }, testsFor("typescript"), "patch_edit");
    expect(result.issue).toBeUndefined();
    expect(result.proposal?.entry).toBe("tests.ts");
    expect(result.proposal?.hidden.map((file) => file.path)).toEqual(["tests.ts", "stub.ts"]);
    expect(result.proposal?.defect).toBe("边界比较符写反");
    expect(result.proposal?.anchors?.[0]?.path).toBe("src/a.ts");
  });
  it("given/solution 路径集合不一致被拒", () => {
    const broken: StageImpl = { given: impl.given, solution: [{ path: "other.ts", contents: "x" }] };
    expect(assembleProposal(plan, broken, testsFor("typescript"), "patch_edit").issue).toMatch(/完全一致/);
  });
  it("hidden 与 given 撞名被拒", () => {
    const broken: StageImpl = { ...impl, stubs: [{ path: "target.ts", contents: "x" }] };
    expect(assembleProposal(plan, broken, testsFor("typescript"), "patch_edit").issue).toMatch(/同名/);
  });
  it("题面缺节、测试没用骨架都被拒", () => {
    expect(assembleProposal({ ...plan, prompt: "## 问题描述" }, impl, testsFor("typescript"), "patch_edit").issue).toMatch(/三节/);
    expect(assembleProposal(plan, impl, { hidden: [{ path: "tests.ts", contents: "console.log(1)" }], entry: "tests.ts" }, "patch_edit").issue).toMatch(/骨架/);
  });
});

describe("repairTargetFor", () => {
  const okSolution = { label: "solution" as const, verdict: { passed: 2, failed: 0 }, exitCode: 0, timedOut: false, ran: true };
  it("参考解没过 → 只重出实现段", () => {
    expect(repairTargetFor("参考解没过", [{ ...okSolution, verdict: { passed: 1, failed: 1 }, exitCode: 1 }])).toBe("impl");
  });
  it("下发件全过 → 只重出测试段", () => {
    expect(repairTargetFor("发出去的代码不改也能全过", [okSolution, { label: "given", verdict: { passed: 2, failed: 0 }, exitCode: 0, timedOut: false, ran: true }])).toBe("tests");
  });
  it("下发件没跑出结论 → 只重出测试段", () => {
    expect(repairTargetFor("发出去的代码那次运行没有测试结论", [okSolution])).toBe("tests");
  });
  it("参考解没跑出结论 → 测试文件自身有问题，重出测试段", () => {
    expect(repairTargetFor("参考实现那次运行没有测试结论（可能没编译过，或测试文件自己出错）", [{ ...okSolution, verdict: undefined }])).toBe("tests");
  });
  it("参考解一条都没过 → 断言整体有问题，重出测试段", () => {
    expect(repairTargetFor("参考解一条测试都没过（TESTS 0 2）", [{ ...okSolution, verdict: { passed: 0, failed: 2 } }])).toBe("tests");
  });
});

/** 离线自检：假模型 + 假沙箱，不花 token、不跑真沙箱，验证三段编排与定向修复。 */
describe("generateTwoStage（两段臂离线自检）", () => {
  const usage: LlmUsage = { inputTokens: 100, outputTokens: 50 };
  const okSolution: HarnessRun = { label: "solution", verdict: { passed: 2, failed: 0 }, exitCode: 0, timedOut: false, ran: true };
  const okGiven: HarnessRun = { label: "given", verdict: { passed: 1, failed: 1 }, exitCode: 1, timedOut: false, ran: true };
  const base = () => ({ repositoryPath: "/repo", tag: "Graph 状态图编排", kind: "patch_edit" as const, reference: "## a.ts\nexcerpt" });
  const firstStage = () => ({ ...plan, given: impl.given, solution: impl.solution });
  const firstHook = (calls: { n: number }) => async (): Promise<{ text: string; usage: LlmUsage; skillReads: []; fileReads: [] }> => {
    calls.n += 1;
    return { text: JSON.stringify(firstStage()), usage, skillReads: [], fileReads: [] };
  };
  const testsProvider = (users: string[]) => ({
    name: "mock", modelVersion: "mock:v1",
    complete: async (input: LlmCompletionInput) => {
      users.push(input.user ?? "");
      if (input.system.includes("只交测试文件")) return { text: JSON.stringify(testsFor("typescript")), usage };
      throw new Error("两段模式只应再调一次测试段");
    }
  }) satisfies LlmProvider;

  it("stageOneSchema 接受题面+实现，拒绝缺 given", () => {
    expect(stageOneSchema.safeParse(firstStage()).success).toBe(true);
    const missing = { ...firstStage() } as Record<string, unknown>;
    delete missing.given;
    expect(stageOneSchema.safeParse(missing).success).toBe(false);
  });

  it("两段全过：首段走工具循环、第二段只出测试，只调用一次裸 complete", async () => {
    const calls = { n: 0 };
    const users: string[] = [];
    const result = await generateTwoStage({
      ...base(), provider: testsProvider(users),
      hooks: {
        firstLoop: firstHook(calls),
        validate: async () => ({ ok: true, runs: [okSolution, okGiven] })
      }
    });
    expect(result.ok).toBe(true);
    expect(calls.n).toBe(1);
    expect(users).toHaveLength(1);
    if (result.ok) {
      expect(result.proposal.entry).toBe("tests.ts");
      expect(result.proposal.given.map((file) => file.path)).toEqual(result.proposal.solution.map((file) => file.path));
    }
  });

  it("参考解没过：定向修复重发首段，不重发测试段", async () => {
    const calls = { n: 0 };
    const users: string[] = [];
    let round = 0;
    const result = await generateTwoStage({
      ...base(), provider: testsProvider(users),
      hooks: {
        firstLoop: firstHook(calls),
        validate: async () => {
          round += 1;
          return round === 1
            ? { ok: false as const, reason: "参考解没过：TESTS 1 1", runs: [{ ...okSolution, verdict: { passed: 1, failed: 1 }, exitCode: 1, output: "FAIL boundary" }] }
            : { ok: true as const, runs: [okSolution, okGiven] };
        }
      }
    });
    expect(result.ok).toBe(true);
    expect(calls.n).toBe(2);
    expect(users).toHaveLength(1);
  });
});
