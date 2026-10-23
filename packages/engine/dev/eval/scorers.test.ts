import { describe, expect, it } from "vitest";
import { checkTurnInvariants, type TeachTurn } from "../../src/application/turn-invariants.js";
import { scoreSearchArm, scoreTeachInvariants } from "./scorers.js";

/**
  确定性判分器单测：全部零 token、纯函数，守判分口径本身——
  引用落地认「整路径/裸文件名/行号越界」，检索臂算 hit/recall 与负例误命中。
*/

describe("检索 gold 命中", () => {
  const cases = [
    { id: "a", query: "q1", goldPaths: ["x/one.py", "x/two.py"] },
    { id: "b", query: "q2", goldPaths: ["x/three.py"] },
    { id: "neg", query: "q3", goldPaths: [] }
  ];
  it("hit 看有没有、recall 看漏了几个；负例有输出即误命中", () => {
    const table: Record<string, string[]> = {
      q1: ["x/one.py", "y/other.py", "y/more.py", "y/deep.py", "y/five.py"],
      q2: ["y/nope.py"],
      q3: ["x/one.py"]
    };
    const arm = scoreSearchArm(cases, (query) => table[query] ?? []);
    expect(arm.perCase[0]).toMatchObject({ hit: true, recall: 0.5 });
    expect(arm.perCase[1].hit).toBe(false);
    expect(arm.hitRate).toEqual({ numerator: 1, denominator: 2 });
    expect(arm.negatives).toEqual([{ id: "neg", wrongHits: ["x/one.py"] }]);
  });
});

describe("不变量机检（批量回合上的两条判据）", () => {
  const files = new Map([["src/graph/nodes.py", 20]]);
  const turn = (over: Partial<TeachTurn>): TeachTurn =>
    ({ sessionId: "s", at: "2026-09-22T12:00:00.000Z", question: "问", answer: "答", style: 50, answerTruncated: false, ...over });

  it("引用核落地：假路径回合进 misses；无引用的回合不适用；截断行只计数", () => {
    const score = scoreTeachInvariants([
      turn({ answer: "见 src/graph/nodes.py:8，这一步为什么放锁？" }),
      turn({ answer: "见 src/graph/ghost.py:8，下一步看哪里？" }),
      turn({ answer: "纯概念，无引用。这一步对吗？" }),
      turn({ answer: "后半截引用被切 in src/grap", answerTruncated: true })
    ], files);
    const refs = score.checks.find((check) => check.id === "reference-grounding");
    expect(refs?.applicable).toBe(2);
    expect(refs?.pass).toBe(1);
    expect(refs?.misses[0]?.excerpt).toContain("ghost.py");
    expect(score.skippedTruncated).toBe(1);
  });

  it("点名标识符只判非通俗档；短标识符（<5 字符）不算点名", () => {
    const score = scoreTeachInvariants([
      turn({ style: 50, answer: "RedisKey 这里为什么加前缀？" }),
      turn({ style: 50, answer: "为什么要加前缀？" }),
      turn({ style: 90, answer: "咱们打个比方，锁就像门闩，你说呢？" })
    ], files);
    const binding = score.checks.find((check) => check.id === "anchor-binding");
    expect(binding?.applicable).toBe(2);
    expect(binding?.pass).toBe(1);
  });

  it("socratic-question 这条度量已随教学状态机删除（判据吃 stage 与本轮动作）", () => {
    expect(scoreTeachInvariants([turn({ answer: "这一节到此掌握。" })], files).checks.map((check) => check.id)).toEqual(["reference-grounding", "anchor-binding"]);
  });
});

describe("运行期运行时复检（同样的两条在回合收尾判）", () => {
  const files = new Map([["src/graph/nodes.py", 20]]);
  const turn = (over: Partial<TeachTurn>): TeachTurn =>
    ({ sessionId: "s", at: "2026-10-04T12:00:00.000Z", question: "问", answer: "答", style: 50, answerTruncated: false, ...over });

  it("离线聚合与运行时单回合判分同源：分母之和必须逐条相等（两份实现迟早漂移，这条钉住）", () => {
    const turns = [
      turn({ answer: "先看 src/graph/nodes.py:8 的顺序，你觉得哪步先跑？" }),
      turn({ answer: "这里没有问句，直接讲结论。" }),
      turn({ answer: "见 src/graph/ghost.py:8，下一步看哪里？" }),
      turn({ scene: "map_chat", answer: "地图问答里的 src/graph/ghost.py:3 引用" }),
      turn({ answer: "半截引用 src/grap", answerTruncated: true })
    ];
    const score = scoreTeachInvariants(turns, files);
    const perTurn = turns.map((item) => checkTurnInvariants(item, files));
    for (const check of score.checks) {
      const applicable = perTurn.filter((verdict) => verdict.applicable.includes(check.id)).length;
      const failed = perTurn.filter((verdict) => verdict.failed.includes(check.id)).length;
      expect([check.id, check.applicable, check.pass]).toEqual([check.id, applicable, applicable - failed]);
    }
  });
});
