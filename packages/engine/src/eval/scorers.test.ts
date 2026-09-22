import { describe, expect, it } from "vitest";
import type { RepositoryFlow } from "@codebase-tutor/shared";
import { scoreFlowArtifacts, scoreReferences, scoreSearchArm, scoreTeachInvariants, type TeachTurn } from "./scorers.js";

/**
  B 档判分器：全部零 token、纯函数。这里守的是判分口径本身——
  引用落地认「整路径/裸文件名/行号越界」，边证据沿用 deepen 的归属闸，检索臂算 hit/recall 与负例误命中。
*/

const FILES = new Map([
  ["src/graph/builder.py", 10],
  ["src/graph/nodes.py", 20],
  ["src/utils/builder.py", 5]
]);

describe("引用落地", () => {
  it("整路径与裸文件名都算落地；行号越界与假文件都进问题清单", () => {
    const score = scoreReferences(
      ["见 src/graph/nodes.py:18 与 nodes.py:4；src/graph/ghost.py:1 不存在；src/graph/nodes.py:99 越界"],
      FILES
    );
    expect(score.total).toBe(4);
    expect(score.ok).toBe(2);
    expect(score.problems.map((problem) => problem.raw)).toEqual(["src/graph/ghost.py:1", "src/graph/nodes.py:99"]);
  });

  it("裸文件名撞上多个同名文件时报「多义」而不是猜一个", () => {
    const score = scoreReferences(["builder.py 里注册"], new Map(FILES).set("other/builder.py", 3));
    // src/graph/builder.py 与 src/utils/builder.py、other/builder.py 三个同名
    expect(score.problems[0]?.why).toContain("同名文件 3 个");
  });
});

function flowOf(edges: RepositoryFlow["edges"]): RepositoryFlow {
  return {
    entry: { path: "src/graph/builder.py", line: 1, label: "入口" },
    title: "t",
    summary: "s",
    stages: [
      { order: 1, kind: "entry", title: "一", detail: "d", files: [{ path: "src/graph/builder.py", line: 1 }], branches: [] },
      { order: 2, kind: "stage", title: "二", detail: "d", files: [{ path: "src/graph/nodes.py", line: 3 }], branches: [] }
    ],
    edges,
    generatedAt: "2026-09-22T00:00:00.000Z"
  };
}

describe("flow 产物判分", () => {
  it("code 边证据须属于端点文件、static 边须引到真实文件；inferred 边不核对", () => {
    const score = scoreFlowArtifacts(
      [flowOf([
        { from: 1, to: 2, origin: "code", evidence: "src/graph/builder.py:4 调用 register_all()" },
        { from: 1, to: 2, origin: "static", evidence: "src/graph/ghost.py:1 → nodes.py:3" },
        { from: 1, to: 2, origin: "inferred", evidence: "猜的" }
      ])],
      FILES
    );
    expect(score.code).toMatchObject({ total: 1, ok: 1 });
    // static 边有 nodes.py:3 能落地就算核过（「至少引到一个存在文件」口径）
    expect(score.static).toMatchObject({ total: 1, ok: 1 });
    expect(score.static.bad).toHaveLength(0);
    expect(score.refs.problems.some((problem) => problem.raw === "src/graph/ghost.py:1")).toBe(true);
  });

  it("证据引别家文件的 code 边进 bad 清单", () => {
    const score = scoreFlowArtifacts([flowOf([{ from: 1, to: 2, origin: "code", evidence: "src/utils/builder.py:2 注册" }])], new Map(FILES).set("src/web/app.py", 8));
    expect(score.code.ok).toBe(0);
    expect(score.code.bad[0]?.key).toContain("1->2");
  });
});

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

describe("教学法不变量机检（第 2 刀）", () => {
  const files = new Map([["src/graph/nodes.py", 20]]);
  const turn = (over: Partial<TeachTurn>): TeachTurn =>
    ({ sessionId: "s", at: "2026-09-22T12:00:00.000Z", question: "问", answer: "答", stage: "orient", pedagogy: "socratic", style: 50, answerTruncated: false, ...over });

  it("苏格拉底未确认轮必须留问句；confirmed 与 explanatory 缩出分母", () => {
    const score = scoreTeachInvariants([
      turn({ answer: "先看 builder.py 的注册顺序，你觉得哪一步会先执行？" }),
      turn({ answer: "这里没有问句，直接讲结论。" }),
      turn({ answer: "很好，这一节到此掌握。", stage: "confirmed" }),
      turn({ answer: "直接解释：状态机在此汇聚。", pedagogy: "explanatory" })
    ], files);
    const socratic = score.checks.find((check) => check.id === "socratic-question");
    expect(socratic?.applicable).toBe(2);
    expect(socratic?.pass).toBe(1);
    expect(socratic?.misses[0]?.excerpt).toContain("没有问句");
  });

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
});
