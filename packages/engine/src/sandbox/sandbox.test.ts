import { afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { nestedSandboxUsable } from "./capability.js";
import { isolationStatus, reprobeIsolation, resetIsolationForTest, runSandbox, SandboxUnavailableError, stubIsolationForTest, type IsolationStatus } from "./isolation.js";
import { runRaw } from "./runner.js";
import { resolveToolchain, seatbeltProfile } from "./profile.js";
import { homedir } from "node:os";

/**
  沙箱（刀 1）。这里的重点不是「跑起来了」，而是**恶意样本真被系统挡下**、
  而且挡不下的时候整域禁用——所以断言全部读真跑出来的 stdout，不接受「profile 看起来对」。

  ⚠️ 分档（2026-10-15，#168）：容器与受限 CI 里嵌套 `sandbox-exec` 起不来（`sandbox_apply: Operation not permitted`），
  那种环境下这些集成用例**自我跳过并点名「环境不支持」**——跳过不等于通过，隔离证据只在能跑的机器上取。
  不依赖真跑的那几条（文件名判据、profile 规则顺序、探测没过时整域拒）永远照跑，
  其中「探测没过 ⇒ `runSandbox` 抛」正是受限环境里仍然成立的那半条安全保证。
*/
const capability = nestedSandboxUsable();
if (!capability.usable) console.warn(`[sandbox] 本机起不了嵌套 sandbox-exec（${capability.detail}）：集成用例按「环境不支持」跳过，这不是通过，是取不到证据`);
const requireSandbox = (ctx: TestContext): void => { if (!capability.usable) ctx.skip(); };

describe("沙箱隔离探测", () => {
  let status: IsolationStatus;

  // 每一项 canary 都要起真进程，整份测试只真跑一次，后面都读同一份结果
  beforeAll(async () => { resetIsolationForTest(); status = await reprobeIsolation(); }, 180_000);
  afterEach(() => resetIsolationForTest());

  /**
    名单是「有哪几项」的读数，所以硬性约束顺序与个数：加一项减一项都要在这里显式改，
    免得哪天探测悄悄少跑一项而测试还绿着。（每项的真伪由下面几条分别读 stdout 断言，不看这里。）

    ⚠️ 但这份名单**只在探测真跑起来的机器上存在**：`isolationBackend()` 判「这台机器没有隔离后端」时
    探测直接短路返回零项（Linux CI 就是这种）。那种环境是一条 canary 都没跑，不是跑完且全过——
    所以先按「有没有 canary」分档，再谈名单。把零项也拿去比 11 个名字，红的是环境，不是产品。
    */
  it("逐项检查全过才算 enforced：三语言跑得起来、读家目录/仓/外连/fork 被拒、死循环与超量输出被兜住", (ctx) => {
    if (!status.checks.length) {
      // 零项只允许出现在「根本没有后端」这一支，且必须判 unavailable 并说清原因（fail-closed 的另一种形态）
      expect(status.level, "一条 canary 都没跑却报出别的等级，就是凭空造证据").toBe("unavailable");
      expect(status.reason.length, "界面直接显示这句白话原因，不能空").toBeGreaterThan(0);
      console.warn(`[sandbox] 本机没有隔离后端（${status.reason}）：逐项证据取不到，跳过 ≠ 通过`);
      ctx.skip();
    }
    expect(status.checks.map((check) => check.name)).toEqual([
      "run-typescript", "run-python", "run-java",
      "read-home", "read-repo", "read-repo-via-symlink", "network", "fork", "timeout-kill", "output-cap", "memory-cap"
    ]);
    // 这条等价律不分环境（零项那支已经在上面跳过）：判成 enforced 必须每一项都过，一项没过就必须判 unavailable
    expect(status.level === "enforced", `级别与逐项读数不一致：${status.level} / 没过的是 ${status.checks.filter((check) => !check.passed).map((check) => check.name).join("、") || "无"}`).toBe(status.checks.every((check) => check.passed));
    if (!capability.usable) {
      // 起不了嵌套 sandbox-exec 的 macOS，或被 `TUTOR_TEST_FORCE_UNSUPPORTED` 挡板的机器：结论只由等价律管，
      // 这里不再断言「一定过」——但挡板不许漏进产品那半条仍然成立：探测真跑了 11 项，就是没被挡板短路
      ctx.skip();
    }
    expect(status.checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`)).toEqual([]);
    expect(status.level).toBe("enforced");
  });

  it("读家目录这条真的有对照：沙箱外读得到、沙箱内读不到（没对照就是自证）", (ctx) => {
    requireSandbox(ctx);
    const readHome = status.checks.find((check) => check.name === "read-home");
    expect(readHome?.control).toBe("leaked");
    expect(readHome?.detail).toContain("BLOCKED");
  });

  /**
    #167：仓不一定在家目录里（`POST /imports` 收任意绝对路径），所以「读不到仓」不能靠家目录那份名单顺带盖住。
    这两条的对照都拿一个**家目录之外**的临时目录当「装在 /opt 的仓」，里面有 `.tutor/tutor.db`（＝标准答案与 hidden 测试）。
    ⚠️ 断言 `control === "leaked"` 是这条用例的要点：沙箱外读不到就说明样本或目录本身有问题，
    那时沙箱内的 "BLOCKED" 什么也没证明。
    */
  it("仓在家目录之外也读不到，经符号链接绕行也一样（对照组必须真读得到）", (ctx) => {
    requireSandbox(ctx);
    for (const name of ["read-repo", "read-repo-via-symlink"]) {
      const check = status.checks.find((item) => item.name === name);
      expect(check?.control, `${name} 的对照组必须在沙箱外真读到，否则这条拒绝不算证据`).toBe("leaked");
      expect(check?.passed, `${name}：沙箱内读到了仓`).toBe(true);
      expect(check?.detail).toContain("BLOCKED");
    }
  });

  it("探测没过的机器上 runSandbox 直接拒，不把弱隔离当可用", async () => {
    stubIsolationForTest({ level: "unavailable", backend: "测试注入", checks: [], probedAt: null, durationMs: 0, reason: "network 检查未通过" });
    await expect(runSandbox({ repositoryPath: "/tmp/whatever-repo", language: "typescript", entry: "a.ts", files: [{ path: "a.ts", contents: "console.log(1);" }] }))
      .rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(isolationStatus().level).toBe("unavailable");
  });
});

describe("沙箱运行", () => {
  it("跨文件 import 的 TS 程序在沙箱里跑通（runner 依赖的正是这个解析形状）", async ({ skip }) => {
    if (!capability.usable) skip();
    const run = await runRaw({
      language: "typescript",
      entry: "main.ts",
      files: [
        { path: "main.ts", contents: 'import { slug } from "./lib.ts";\nconsole.log(slug("Hello World"));\n' },
        { path: "lib.ts", contents: 'export function slug(value: string): string {\n  return value.toLowerCase().replaceAll(/\\s+/g, "-");\n}\n' }
      ]
    });
    expect(run.ok).toBe(true);
    expect(run.stdout.trim()).toBe("hello-world");
    expect(run.isolated).toBe(true);
  }, 60_000);

  it("Python 与 Java 也各跑一条真程序：三语言的 runner 都要能出题", async ({ skip }) => {
    if (!capability.usable) skip();
    const python = await runRaw({ language: "python", entry: "main.py", files: [{ path: "main.py", contents: 'print(sum(len(word) for word in ["ab", "cde"]))\n' }] });
    expect(python.stdout.trim()).toBe("5");
    const java = await runRaw({
      language: "java",
      entry: "Sum",
      files: [{ path: "Sum.java", contents: 'public class Sum {\n  public static void main(String[] args) { System.out.println(1 + 2 + 3 + 4); }\n}\n' }, { path: "Helper.java", contents: 'class Helper {\n  static int zero() { return 0; }\n}\n' }]
    });
    expect(java.stdout.trim()).toBe("10");
  }, 60_000);

  it("路径穿越的文件名在进沙箱之前就被拒", async () => {
    await expect(runRaw({ language: "typescript", entry: "x.ts", files: [{ path: "../../escape.ts", contents: "console.log(1);" }] })).rejects
      .toThrow("非法的沙箱文件名");
  });

  it("带子目录的文件名能跑（真模型会把文件命名成 `pkg/mod.py`，父目录不建就 ENOENT）", async ({ skip }) => {
    if (!capability.usable) skip();
    const run = await runRaw({
      language: "python",
      entry: "pkg/main.py",
      files: [
        { path: "pkg/helper.py", contents: 'def twice(n):\n    return n * 2\n' },
        { path: "pkg/main.py", contents: 'import sys\nsys.path.insert(0, "pkg")\nfrom helper import twice\nprint("TESTS 1 0")\n' }
      ]
    });
    expect(run.ok).toBe(true);
    expect(run.stdout).toContain("TESTS 1 0");
  }, 60_000);

  it("Java 文件名带包目录被拒：public class 与文件名必须同名，否则 javac 挂在无关的错误上", async () => {
    await expect(runRaw({ language: "java", entry: "Solution", files: [{ path: "src/Solution.java", contents: "public class Solution {}\n" }] })).rejects
      .toThrow("类名.java");
  });

  it("沙箱里的代码看不到被学习仓与引擎口令：整片家目录不可读", async ({ skip }) => {
    if (!capability.usable) skip();
    const run = await runRaw({
      language: "typescript",
      entry: "peek.ts",
      files: [{ path: "peek.ts", contents: `import { readdirSync, readFileSync } from "node:fs";\nconst attempts = [];\nfor (const target of [${JSON.stringify(homedir())}, ${JSON.stringify(`${homedir()}/.codebase-tutor/llm-settings.json`)}]) {\n  try { readFileSync(target); attempts.push("LEAK"); } catch (error) { attempts.push(error.code ?? error.name); }\n}\nconsole.log(attempts.join(" "));\n` }]
    });
    expect(run.stdout).not.toContain("LEAK");
    expect(run.stdout.trim().split(" ")).toHaveLength(2);
  }, 60_000);

  it("死循环被整组杀掉并如实标 timedOut，不会被当成「跑完了但失败」", async ({ skip }) => {
    if (!capability.usable) skip();
    const run = await runRaw({ timeoutMs: 1_000, language: "python", entry: "spin.py", files: [{ path: "spin.py", contents: "while True:\n    pass\n" }] });
    expect(run.timedOut).toBe(true);
    expect(run.ok).toBe(false);
    expect(run.steps[0]?.exitCode).toBe(null);
  }, 60_000);
});

describe("profile 组装", () => {
  it("解释器根按本机实时计算：家目录先整片拒读、再放行解释器所在子树，顺序反了就等于没拦", () => {
    const toolchain = resolveToolchain();
    const profile = seatbeltProfile("/private/tmp/sbx-run-1", toolchain);
    const denyHome = profile.indexOf(`(deny file-read* (subpath "${homedir()}"))`);
    expect(denyHome).toBeGreaterThan(-1);
    for (const line of profile.split("\n")) {
      if (line.startsWith("(allow file-read*") && line.includes(homedir())) expect(profile.indexOf(line)).toBeGreaterThan(denyHome);
    }
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny process-fork)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/sbx-run-1"))');
  });

  it("探测用的放宽档只影响它声称的那两条，读拦截照旧", () => {
    const profile = seatbeltProfile("/private/tmp/sbx-run-2", resolveToolchain(), { allowNetwork: true, allowFork: true });
    expect(profile).not.toContain("(deny network*)");
    expect(profile).not.toContain("(deny process-fork)");
    expect(profile).toContain("(deny file-read*");
  });
});
