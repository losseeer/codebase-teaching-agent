import { describe, expect, it } from "vitest";
import { checkTurnInvariants, invariantTailNotice, scoreReferences, screenNotice, screenReply, type TeachTurn } from "./turn-invariants.js";

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

  it("依赖图认识的语言都在核验射程里；图外的 Ruby/PHP 与文档也不许被悄悄缩小", () => {
    const score = scoreReferences(["见 src/parser.cpp:88 与 Order.cs:2 与 app.rb:12；样式在 theme.css:1 不算代码引用"], FILES);
    expect(score.problems.map((problem) => problem.raw)).toEqual(["src/parser.cpp:88", "Order.cs:2", "app.rb:12"]);
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
    expect(notice).toContain("未能核实");
    expect(notice).toContain("未能");
    expect(scoreReferences([notice ?? ""], files).total).toBe(0);
    // 幂等：把加了明示的文本再判一遍，结论不变、也不会新长出问题
    const again = checkTurnInvariants(turn({ answer: `${"见 src/graph/ghost.py:8，为什么？"}${notice}` }), files);
    expect(again.failed).toEqual(["reference-grounding"]);
    const styleOnly = checkTurnInvariants(turn({ answer: "这里没有问句" }), files);
    expect(invariantTailNotice(styleOnly)).toBeUndefined();
  });
});

/** 出字前的本地过筛：既不漏筛密钥，也不误改正常讲代码的回复。 */
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
    expect(screenNotice(screened)).toContain("已被隐去");
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
