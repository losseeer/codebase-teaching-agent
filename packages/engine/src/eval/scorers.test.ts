import { describe, expect, it } from "vitest";
import { checkTurnInvariants, invariantTailNotice, scoreReferences, scoreSearchArm, scoreTeachInvariants, screenNotice, screenReply, type TeachTurn } from "./scorers.js";

/**
  确定性判分器单测：全部零 token、纯函数，守判分口径本身——
  引用落地认「整路径/裸文件名/行号越界」，检索臂算 hit/recall 与负例误命中。
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

  it("单回合结论：该判几条 / 哪条失守 / 证据只挂失守那条", () => {
    const verdict = checkTurnInvariants(turn({ answer: "见 src/graph/ghost.py:8，为什么？" }), files);
    expect(verdict.applicable).toEqual(["reference-grounding", "anchor-binding"]);
    expect(verdict.failed).toEqual(["reference-grounding"]);
    expect(verdict.evidence["reference-grounding"]).toContain("ghost.py");
    expect(verdict.evidence["anchor-binding"]).toBeUndefined();
  });

  it("map/practice 只判引用那条：点名标识符是问答域的设计承诺，别拿它去缩别的场景的分母", () => {
    for (const scene of ["map_chat", "practice_chat"] as const) {
      // 没引用就没有可判条目：不适用 ≠ 通过，分母如实缩到 0
      expect(checkTurnInvariants(turn({ scene, answer: "这一段没有任何引用也没有标识符" }), files).applicable).toEqual([]);
      const verdict = checkTurnInvariants(turn({ scene, answer: "见 src/graph/ghost.py:8 这一行" }), files);
      expect(verdict.applicable).toEqual(["reference-grounding"]);
      expect(verdict.failed).toEqual(["reference-grounding"]);
    }
  });

  it("尾部明示只在引用失守时出现，且它自己不含任何引用形态的串（否则回放同一份文本会被二次判分）", () => {
    const failing = checkTurnInvariants(turn({ answer: "见 src/graph/ghost.py:8，为什么？" }), files);
    const notice = invariantTailNotice(failing);
    expect(notice).toContain("自动复检");
    expect(notice).toContain("未能");
    expect(scoreReferences([notice ?? ""], files).total).toBe(0);
    // 幂等：把加了明示的文本再判一遍，结论不变、也不会新长出问题
    const again = checkTurnInvariants(turn({ answer: `${"见 src/graph/ghost.py:8，为什么？"}${notice}` }), files);
    expect(again.failed).toEqual(["reference-grounding"]);
    const styleOnly = checkTurnInvariants(turn({ answer: "这里没有问句" }), files);
    expect(invariantTailNotice(styleOnly)).toBeUndefined();
  });

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

/**
  出字前的本地过筛单测：两头都钉住——漏筛＝密钥随正文下发/入库，误筛＝把正常讲代码的回复改坏。
 */
describe("screenReply", () => {
  it("隐去密钥形态与仓库外绝对路径，并只记数量与样例", () => {
    const screened = screenReply("配置里的 sk-abcdefghijklmnop1234 就是凭据；它读的是 /Users/devsecczk/.ssh/id_rsa 那份文件。");
    expect(screened.secrets).toBe(1);
    expect(screened.paths).toBe(1);
    expect(screened.text).toContain("[疑似密钥，已隐去]");
    expect(screened.text).toContain("[仓库外路径，已隐去]");
    expect(screened.text).not.toContain("sk-abcdefghijklmnop");
    expect(screened.text).not.toContain("devsecczk");
    expect(screened.samples.join(" ")).not.toContain("abcdefghijklmnop");
    expect(screenNotice(screened)).toContain("本地过筛");
  });

  it("正常讲代码的回复一个字都不该被改（仓库内路径、占位符、普通赋值句）", () => {
    const plain = '看 src/main/java/com/hmdp/controller/PayController.java:42：这里注入的是占位符 YOUR_KEY，`token = config.get("x")` 之后走缓存。密钥运行时境变量里，别写进代码。';
    const screened = screenReply(plain);
    expect(screened.text).toBe(plain);
    expect(screened.secrets).toBe(0);
    expect(screened.paths).toBe(0);
    expect(screenNotice(screened)).toBeUndefined();
  });

  it("JWT 与 key=value 长值都算命中；短值不算", () => {
    expect(screenReply("请求头带 eyJhbGciOiJIUzI1Ni5z.eyJzdWIiOiIxMjM0NTY3ODkwIn0").secrets).toBeGreaterThan(0);
    expect(screenReply("api_key = " + "a".repeat(24)).secrets).toBe(1);
    expect(screenReply("api_key = short").secrets).toBe(0);
  });
});
