import { describe, expect, it } from "vitest";
import type { CourseNode, TeachingPolicy, TutorMessage } from "@codebase-tutor/shared";
import { assembleContext } from "./context.js";

/**
  窗口外的抽取式压缩：滑出「最近对话」（8 条）窗口的轮次只保留学习者提问（零 LLM 成本）——
  长线程（含续命恢复的存量历史）里，模型至少看得到「一路问过什么」，导师长答出窗即弃。
  */

const node: CourseNode = { id: "n", title: "入口", summary: "入口摘要。", kind: "workflow", anchors: [], children: [] };
const policy = { constraints: ["先复述目标"] } as unknown as TeachingPolicy;
const msg = (role: "user" | "assistant", content: string, i: number): TutorMessage => ({ id: `m${i}`, role, content } as TutorMessage);

describe("assembleContext 此前问题脉络", () => {
  it("窗口外提取学习者提问入脉络（时间序、超长行截断），导师长答不混入；脉络排在最近对话之前", () => {
    const history: TutorMessage[] = [
      msg("user", "老问题一", 1),
      msg("assistant", "导师长答A".repeat(60), 2),
      msg("user", "尾".repeat(200), 3),
      ...Array.from({ length: 8 }, (_, i) => msg(i % 2 ? "assistant" : "user", `近期${i}`, 10 + i))
    ];
    const context = assembleContext({ node, policy, history });
    expect(context).toContain("此前问题脉络（更早轮次的学习者提问，按时间序）");
    expect(context).toContain("- 老问题一");
    expect(context).toContain("尾".repeat(160));
    expect(context).not.toContain("尾".repeat(161));
    expect(context).not.toContain("导师长答A");
    expect(context).not.toContain("- 近期0"); // 窗口内条目只走「最近对话」，不重复进脉络
    expect(context.indexOf("此前问题脉络")).toBeLessThan(context.indexOf("最近对话"));
  });

  it("历史不超窗口、或窗口外只剩导师消息 → 不生成脉络块", () => {
    const short = [msg("user", "首问", 1), msg("assistant", "首答", 2)];
    expect(assembleContext({ node, policy, history: short })).not.toContain("此前问题脉络");
    const assistantOnlyTail = [msg("assistant", "窗口外的导师独白", 0), ...Array.from({ length: 8 }, (_, i) => msg("user", `近期${i}`, i))];
    expect(assembleContext({ node, policy, history: assistantOnlyTail })).not.toContain("此前问题脉络");
  });

  it("窗口外提问超过 8 条 → 只留最近 8 条", () => {
    const history = [...Array.from({ length: 10 }, (_, i) => msg("user", `问${i}`, i)), ...Array.from({ length: 8 }, (_, i) => msg("assistant", `答${i}`, 20 + i))];
    const context = assembleContext({ node, policy, history });
    expect(context).toContain("- 问2");
    expect(context).toContain("- 问9");
    expect(context).not.toContain("- 问0");
    expect(context).not.toContain("- 问1");
  });
});
