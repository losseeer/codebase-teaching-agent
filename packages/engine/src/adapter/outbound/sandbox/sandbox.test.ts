import { afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { nestedSandboxUsable } from "./capability.js";
import { isolationStatus, reprobeIsolation, resetIsolationForTest, runSandbox, SandboxUnavailableError, stubIsolationForTest, type IsolationStatus } from "./isolation.js";
import { runRaw } from "./runner.js";
import { resolveToolchain, seatbeltProfile } from "./profile.js";
import { homedir } from "node:os";

/** 沙箱测试读真跑出来的 stdout 断言，不接受「profile 看起来对」。
    嵌套 `sandbox-exec` 起不来的环境里集成用例跳过并点名环境不支持。 */
const capability = nestedSandboxUsable();
if (!capability.usable) console.warn(`[sandbox] 本机起不了嵌套 sandbox-exec（${capability.detail}）：集成用例按「环境不支持」跳过，这不是通过，是取不到证据`);
const requireSandbox = (ctx: TestContext): void => { if (!capability.usable) ctx.skip(); };

describe("沙箱隔离探测", () => {
  let status: IsolationStatus;

  // canary 要起真进程，整份测试只真跑一次
  beforeAll(async () => { resetIsolationForTest(); status = await reprobeIsolation(); }, 180_000);
  afterEach(() => resetIsolationForTest());

  /** 名单的顺序与个数在这里钉住：增删一项都要显式改。 */
  it("逐项检查全过才算 enforced：三语言跑得起来、读家目录/仓/外连/fork 被拒、死循环与超量输出被兜住", (ctx) => {
    if (!status.checks.length) {
      // 零项只出现在没有后端那一支，且必须判 unavailable
      expect(status.level, "一条 canary 都没跑却报出别的等级，就是凭空造证据").toBe("unavailable");
      expect(status.reason.length, "界面直接显示这句白话原因，不能空").toBeGreaterThan(0);
      console.warn(`[sandbox] 本机没有隔离后端（${status.reason}）：逐项证据取不到，跳过 ≠ 通过`);
      ctx.skip();
    }
    expect(status.checks.map((check) => check.name)).toEqual([
      "run-typescript", "run-python", "run-java",
      "read-home", "read-repo", "read-repo-via-symlink", "network", "fork", "timeout-kill", "output-cap", "memory-cap"
    ]);
    // 判成 enforced 必须每项都过；一项没过必须判 unavailable
    expect(status.level === "enforced", `级别与逐项读数不一致：${status.level} / 没过的是 ${status.checks.filter((check) => !check.passed).map((check) => check.name).join("、") || "无"}`).toBe(status.checks.every((check) => check.passed));
    if (!capability.usable) {
      // 环境不支持时只靠上面的等价律，不断言一定过
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

  /** 对照组必须真读得到，否则沙箱内的 BLOCKED 不算证据。 */
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
