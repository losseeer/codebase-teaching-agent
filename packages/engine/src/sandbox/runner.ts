/**
  沙箱 runner（最小面）：把「一小组文件 + 一个入口」在强制隔离下真跑一次，返回 stdout/stderr/退出状态。
  这一层只做机制，不做判分语义——怎么把读数变成 passed/score 在上层判分器。

  四条实现约束：
  - 异步 spawn，不用 `spawnSync`：沙箱跑的是学习者代码，时长不可预期，不能占住请求线程的 loop。
  - 超时杀整个进程组：`detached: true` 让子进程自成一组，超时 `kill(-pid, SIGKILL)`；
    只杀直接子进程会留下孤儿——沙箱里的代码若能起进程，孙进程就不受控制了。
  - 输出上限是「继续排空但丢弃」，不是「到量就停读」：停读会让子进程卡在满管道上，看起来像超时、其实是死锁。
  - `baseline` 是真的不进沙箱（不裹 sandbox-exec、用真 HOME 跑），用来证明 canary 本身在这台机器上做得到那件坏事。
*/
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExerciseLanguage } from "@codebase-tutor/domain";

import { isolationBackend, resolveToolchain, seatbeltProfile, type SandboxToolchain } from "./profile.js";

/** 沙箱支持的语言 = 共享层那一档，不在引擎里另立一份（加一门语言要同时改 runner 与隔离探测）。 */
export type SandboxLanguage = ExerciseLanguage;

export interface SandboxFile {
  /** 相对沙箱工作区的路径。文件名来自模型，所以先过形状校验：绝对路径、`..`、反斜杠都在这里挡掉，不进沙箱也不经 shell。 */
  path: string;
  contents: string;
}

export interface SandboxRunOptions {
  language: SandboxLanguage;
  files: SandboxFile[];
  /** typescript/python：入口文件名（`main.ts`）；java：入口类名（`Solution`） */
  entry: string;
  timeoutMs?: number;
  memoryMb?: number;
  maxOutputBytes?: number;
  /** 故意放宽 profile 的某一项（隔离探测用它做「这条规则真的在管」的对照） */
  profileOverride?: { allowNetwork?: boolean; allowFork?: boolean };
  /**
    这一次要额外点名拒读的子树：被学习仓的根走这里。判分与自证只吃传进来的文件字符串，
    沙箱里的代码本来就不该读得到仓（`.tutor/tutor.db` 里躺着标准答案与 hidden 测试），
    而「仓一定在家目录里」这一假设不成立（`POST /imports` 收任意绝对路径）。
    产品入口是 `runSandbox`，它把 `repositoryPath` 定成必填并转到这里——漏传编译不过。
  */
  denyRead?: string[];
  /** 完全不进沙箱地跑一遍，只给隔离探测当对照组 */
  baseline?: boolean;
}

export interface SandboxStep {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface SandboxRun {
  language: SandboxLanguage;
  steps: SandboxStep[];
  /** 每一步都正常退出且没超时（不代表业务成功——那是判分器读 stdout 的事） */
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** 本次是否真跑在强制隔离下；`baseline` 为 false，两种读数不许混 */
  isolated: boolean;
  /** 这门语言这次是否真的有内存上限：typescript 走 `--max-old-space-size`、java 走 `-Xmx`；
      python 在 macOS 上设不了 `RLIMIT_AS` ⇒ false，读数要区分「跑了但没封顶」和「封顶了」。 */
  memoryGuarded: boolean;
}

const DEFAULTS = { timeoutMs: 8_000, memoryMb: 128, maxOutputBytes: 64_000 };

interface StepPlan {
  command: string;
  args: string[];
  /** javac 那一步用 `@argfile` 拿源文件列表：不受 exec 参数上限约束，也不需要 shell 通配 */
  appendSourceList?: boolean;
}

export function assertSafePath(path: string, language: SandboxLanguage): string {
  const normalized = path.trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("..")) throw new Error(`非法的沙箱文件名：${path}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error(`非法的沙箱文件名：${path}`);
  const extension: Record<SandboxLanguage, string> = { typescript: ".ts", python: ".py", java: ".java" };
  if (!normalized.endsWith(extension[language])) throw new Error(`${language} 的沙箱文件必须以 ${extension[language]} 结尾：${path}`);
  if (language === "java" && !/^[A-Za-z][A-Za-z0-9_]*\.java$/.test(normalized)) throw new Error(`Java 文件名必须是「类名.java」且不带包目录（public class 与文件名同名）：${path}`);
  return normalized;
}

function toolchainOrThrow(): SandboxToolchain {
  const toolchain = resolveToolchain();
  const missing = (["node", "python", "javac", "java"] as const).filter((key) => !toolchain[key]);
  if (missing.length) throw new Error(`沙箱缺解释器：${missing.join("、")}（PATH 里找不到 node/python3/javac/java）`);
  return toolchain as SandboxToolchain;
}

function planFor(language: SandboxLanguage, entry: string, memoryMb: number, toolchain: SandboxToolchain): StepPlan[] {
  if (language === "typescript") return [{ command: toolchain.node, args: [`--max-old-space-size=${memoryMb}`, "--no-warnings", entry] }];
  if (language === "python") {
    /**
      `-I` = 隔离模式：不吃 PYTHONPATH、不吃用户 site-packages、不吃环境变量。
      macOS 拒不下调 python 的 `RLIMIT_AS`（即使当前是 unlimited），`RLIMIT_DATA` 又是空操作，
      所以设限失败只能放过：Python 的内存兜底只剩超时 + 整组 SIGKILL，
      这个缺口由 `memoryGuarded=false` 如实报出去。
    */
    const bootstrap = `import resource, runpy, sys
try:
    resource.setrlimit(resource.RLIMIT_AS, (${memoryMb} * 1024 * 1024, resource.getrlimit(resource.RLIMIT_AS)[1]))
except (ValueError, OSError):
    pass
sys.argv = [${JSON.stringify(entry)}]
runpy.run_path(${JSON.stringify(entry)}, run_name="__main__")
`;
    return [{ command: toolchain.python, args: ["-I", "-c", bootstrap] }];
  }
  return [
    { command: toolchain.javac, args: ["-encoding", "UTF-8", "-d", "."], appendSourceList: true },
    { command: toolchain.java, args: [`-Xmx${memoryMb}m`, "-cp", ".", entry.replace(/\.java$/, "")] }
  ];
}

interface LaunchContext {
  workdir: string;
  profile: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Record<string, string>;
  /** false = 不裹 sandbox-exec（对照组） */
  isolated: boolean;
}

interface LaunchResult { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; truncated: boolean }

function launch(command: string, args: string[], context: LaunchContext): Promise<LaunchResult> {
  const binary = context.isolated ? "/usr/bin/sandbox-exec" : command;
  const forwarded = context.isolated ? ["-p", context.profile, command, ...args] : args;
  return new Promise((resolveLaunch) => {
    const child = spawn(binary, forwarded, { cwd: context.workdir, env: context.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const take = (channel: "stdout" | "stderr", chunk: Buffer): void => {
      const room = context.maxOutputBytes - (channel === "stdout" ? stdout.length : stderr.length);
      if (room <= 0) { truncated = true; return; }
      const text = chunk.toString("utf8");
      if (text.length > room) { truncated = true; if (channel === "stdout") stdout += text.slice(0, room); else stderr += text.slice(0, room); return; }
      if (channel === "stdout") stdout += text; else stderr += text;
    };
    child.stdout?.on("data", (chunk: Buffer) => take("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => take("stderr", chunk));

    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      // 负 pid = 整个进程组：detached 让子进程自成一组，沙箱里再自己起进程也一起带走
      if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已经退了 */ } }
    }, context.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(killer);
      stderr += `\nsandbox spawn failed: ${error.message}`;
      resolveLaunch({ exitCode: null, signal: null, timedOut, stdout, stderr, truncated });
    });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolveLaunch({ exitCode: timedOut ? null : code, signal, timedOut, stdout, stderr, truncated });
    });
  });
}

function sandboxEnv(workdir: string, toolchain: SandboxToolchain): Record<string, string> {
  const binDirs = [...new Set([dirname(toolchain.node), dirname(toolchain.python), dirname(toolchain.javac), dirname(toolchain.java), "/usr/bin", "/bin"])];
  // HOME 指进沙箱目录：口令文件、git 配置、shell 历史都在真 HOME 下，读不到才是本意
  return { PATH: binDirs.join(":"), HOME: workdir, TMPDIR: workdir, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}

function createWorkdir(): string {
  const root = join(tmpdir(), "codebase-tutor-sandbox");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "run-"));
}

/**
  真跑一次。这一层不查隔离状态——隔离探测正要用它跑 canary，查了就成环。
  对外入口是 `runSandbox`（在 isolation.ts 那一侧，先验状态再放行）。
*/
export async function runRaw(options: SandboxRunOptions): Promise<SandboxRun> {
  const { language, entry, baseline = false } = options;
  /**
    形状校验排在隔离闸门前面：文件名合不合法与这台机器有没有沙箱后端无关。
    反过来的话，同一份坏输入在不同机器上报不同的错，调用方（和用例）分不清是模型写坏了还是环境不行。
  */
  const files = options.files.map((file) => ({ ...file, path: assertSafePath(file.path, language) }));
  const backend = isolationBackend();
  if (!backend.available && !baseline) throw new Error(`沙箱不可用：${backend.reason}`);
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
  const toolchain = toolchainOrThrow();
  const plans = planFor(language, entry, options.memoryMb ?? DEFAULTS.memoryMb, toolchain);

  const workdir = createWorkdir();
  const started = Date.now();
  try {
    for (const file of files) {
      /**
        路径可以带子目录（模型会把文件命名成 `pkg/mod.py`），所以父目录要先建出来：
        形状校验只保证不带 `..` 与绝对路径，不保证目录存在。
      */
      const target = join(workdir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents, "utf8");
    }

    const env = baseline ? { ...process.env, TMPDIR: workdir } : sandboxEnv(workdir, toolchain);
    const context: LaunchContext = { workdir, profile: seatbeltProfile(workdir, toolchain, { ...options.profileOverride, denyRead: options.denyRead }), timeoutMs, maxOutputBytes, env, isolated: !baseline };

    const steps: SandboxStep[] = [];
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    for (const plan of plans) {
      const args = [...plan.args];
      if (plan.appendSourceList) {
        writeFileSync(join(workdir, "sources.rsp"), files.map((file) => file.path).join("\n"), "utf8");
        args.push("@sources.rsp");
      }
      const result = await launch(plan.command, args, context);
      steps.push({ command: plan.command, args, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut });
      stdout += result.stdout;
      stderr += result.stderr;
      truncated = truncated || result.truncated;
      timedOut = timedOut || result.timedOut;
      if (result.exitCode !== 0) break; // 编译挂了，再跑一步也只是噪声
    }
    return {
      language, steps, ok: !timedOut && steps.length === plans.length && steps.every((step) => step.exitCode === 0),
      stdout, stderr, timedOut, truncated, durationMs: Date.now() - started, isolated: !baseline,
      memoryGuarded: language !== "python"
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

export { DEFAULTS };
