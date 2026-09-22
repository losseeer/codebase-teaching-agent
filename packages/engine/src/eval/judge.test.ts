import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@codebase-tutor/shared";
import { assembleJudgeTurns, axesFor, buildJudgePrompt, parseJudgeResponse, priorTurns, type JudgeTurn } from "./judge.js";

/**
  第 3 刀纯逻辑层单测：零 token。守的是判分口径本身——
  证据核验（逐字/压平空白）、驳回记 0、维度按场景伸缩、前情只取同会话最近 2 轮、teach 约束跟 style_shift 快照走。
*/

const turnOf = (over: Partial<JudgeTurn> = {}): JudgeTurn => ({
  sessionId: "s1",
  at: "2026-09-22T00:00:00Z",
  scene: "teach",
  question: "这一步为什么先校验再写库？",
  answer: "你先说说看：如果跳过校验，UserController.java:42 会发生什么？",
  constraints: ["在给出结论前先要求学习者说明推理", "每轮保留一个可验证的问题"],
  ...over
});

describe("证据核验与驳回", () => {
  it("逐字摘录（含空白重排）成立；改写过的证据驳回并记 0", () => {
    const turn = turnOf();
    const verdict = parseJudgeResponse(JSON.stringify({
      接续: { score: 2, evidence: "你先说说看：如果跳过校验，UserController.java:42 会发生什么？" },
      接地: { score: 1, evidence: "UserController.java:42 会 发生什么" },
      易读: { score: 2, evidence: "你先说说看" },
      教学法契合: { score: 2, evidence: "你先说说看：如果跳过校验" }
    }), turn);
    expect(verdict.parseFailed).toBe(false);
    expect(verdict.axes.接续?.score).toBe(2);
    expect(verdict.axes.接地?.rejected).toBeUndefined();
    const fabricated = parseJudgeResponse(JSON.stringify({
      接续: { score: 2, evidence: "这句话根本不在回复里" },
      接地: { score: 1, evidence: "" },
      易读: { score: 9, evidence: "你先说说看" },
      教学法契合: { score: 2 }
    }), turn);
    expect(fabricated.axes.接续).toMatchObject({ score: 0, rejected: "证据不是被评回复的逐字摘录" });
    expect(fabricated.axes.接地?.rejected).toBe("未给证据");
    expect(fabricated.axes.易读?.rejected).toBe("分数不在 0-2");
    expect(fabricated.axes.教学法契合?.rejected).toBe("未给证据");
  });

  it("被截断的回复：「易读」机械封顶 1 分（裁判给 2 也压回），其余维度不受影响", () => {
    const turn = turnOf({ answerTruncated: true });
    const payload = { 接续: { score: 2, evidence: "你先说说看" }, 接地: { score: 2, evidence: "你先说说看" }, 易读: { score: 2, evidence: "你先说说看" }, 教学法契合: { score: 2, evidence: "你先说说看" } };
    const verdict = parseJudgeResponse(JSON.stringify(payload), turn);
    expect(verdict.axes.易读?.score).toBe(1);
    expect(verdict.axes.易读?.rejected).toBeUndefined();
    expect(verdict.axes.接续?.score).toBe(2);
  });

  it("回包不是 JSON 或维度缺失：全维驳回记 0，parseFailed 留痕", () => {
    const turn = turnOf({ scene: "map_chat" });
    const broken = parseJudgeResponse("我觉得都不错，给满分。", turn);
    expect(broken.parseFailed).toBe(true);
    expect(Object.values(broken.axes).every((axis) => axis.score === 0 && axis.rejected)).toBe(true);
    const partial = parseJudgeResponse(JSON.stringify({ 接续: { score: 2, evidence: "这一步为什么先校验再写库？是问题不是回复" } }), turnOf({ scene: "map_chat", answer: "地图从入口层开始讲。" }));
    expect(partial.axes.接续?.rejected).toBe("证据不是被评回复的逐字摘录");
    expect(partial.axes.易读?.rejected).toBe("维度缺失");
  });
});

describe("维度按场景伸缩与前情", () => {
  it("teach 判四维、非教学场景只判三维；提示词带约束段", () => {
    expect(axesFor("teach").map((axis) => axis.key)).toEqual(["接续", "接地", "易读", "教学法契合"]);
    expect(axesFor("practice_chat").map((axis) => axis.key)).toEqual(["接续", "接地", "易读"]);
    const prompt = buildJudgePrompt(turnOf(), [turnOf({ at: "2026-09-22T00:00:00Z", question: "前一问", answer: "前一答" })]);
    expect(prompt).toContain("教学策略约束");
    expect(prompt).toContain("在给出结论前先要求学习者说明推理");
    expect(prompt).toContain("前一答");
    expect(buildJudgePrompt(turnOf({ scene: "map_chat" }), [])).not.toContain("教学策略约束");
  });

  it("前情只取同会话、时间更早的最近 2 轮", () => {
    const turns = [
      turnOf({ at: "1", question: "q1" }),
      turnOf({ at: "2", question: "q2" }),
      turnOf({ at: "3", question: "q3" }),
      turnOf({ at: "4", question: "q4" }),
      turnOf({ at: "5", sessionId: "other", question: "别的会话" })
    ];
    expect(priorTurns(turns, turns[3]).map((item) => item.question)).toEqual(["q2", "q3"]);
    expect(priorTurns(turns, turns[0])).toEqual([]);
  });
});

describe("journal 事件流组装", () => {
  const event = (type: string, payload: Record<string, string | number | boolean>, at: string, sessionId?: string): JournalEvent => ({
    id: `e-${type}-${at}`, type: type as JournalEvent["type"], at, repositoryId: "repo_x", sessionId, payload
  });

  it("turn_text 全场景入选；teach 取生效的 style_shift 快照展开约束；缺问或缺答的行跳过", () => {
    const { turns, truncatedAnswers } = assembleJudgeTurns([
      event("style_shift", { style: 10, pedagogy: "socratic", depth: "macro" }, "1", "s1"),
      event("turn_text", { scene: "teach", question: "q", answer: "a" }, "2", "s1"),
      event("style_shift", { style: 80, pedagogy: "explanatory", depth: "micro" }, "3", "s1"),
      event("turn_text", { scene: "teach", question: "q2", answer: "a2", answer_truncated: true }, "4", "s1"),
      event("turn_text", { scene: "map_chat", question: "mq", answer: "ma" }, "5", "s1"),
      event("turn_text", { scene: "teach", question: "", answer: "空问题不进样本" }, "6", "s1")
    ]);
    expect(turns.map((turn) => [turn.scene, turn.at])).toEqual([["teach", "2"], ["teach", "4"], ["map_chat", "5"]]);
    expect(truncatedAnswers).toBe(1);
    expect(turns[0]?.constraints.join("")).toContain("说明推理");
    // 第三条 style_shift（通俗/解释型）生效后：不再要求苏格拉底式提问，约束段仍要非空
    expect(turns[1]?.constraints.length).toBeGreaterThan(0);
    expect(turns[1]?.constraints.join("")).not.toContain("说明推理");
    expect(turns[2]?.constraints).toEqual([]);
  });

  it("无 sessionId 的回合按场景各自成桶：前情不跨场景串话", () => {
    const { turns } = assembleJudgeTurns([
      event("turn_text", { scene: "map_chat", question: "m1", answer: "a" }, "1"),
      event("turn_text", { scene: "practice_chat", question: "p1", answer: "a" }, "2"),
      event("turn_text", { scene: "map_chat", question: "m2", answer: "a" }, "3")
    ]);
    expect(turns[2]?.sessionId).toBe("scene:map_chat");
    expect(priorTurns(turns, turns[2]).map((item) => item.question)).toEqual(["m1"]);
  });

  it("无快照的 teach 回合回落默认设置；场景标签非法的整行忽略", () => {
    const { turns } = assembleJudgeTurns([
      event("turn_text", { scene: "teach", question: "q", answer: "a" }, "9", "s9"),
      event("turn_text", { scene: "nonsense", question: "q", answer: "a" }, "10", "s9")
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.constraints.length).toBeGreaterThan(0);
  });
});
