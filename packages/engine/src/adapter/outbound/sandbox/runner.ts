/** 沙箱 runner：把一组文件加一个入口在强制隔离下真跑一次，返回 stdout/stderr/退出状态；不含判分语义。
    超时杀整个进程组（`detached` + `kill(-pid)`）；输出到量后继续排空但丢弃。`baseline` 不裹 `sandbox-exec`，用真 HOME 跑。 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExerciseLanguage } from "@codebase-tutor/domain";

import { isolationBackend, resolveToolchain, seatbeltProfile, type SandboxToolchain } from "./profile.js";

export type SandboxLanguage = ExerciseLanguage;

export interface SandboxFile {
  /** 相对沙箱工作区的路径；文件名先过形状校验。 */
  path: string;
  contents: string;
}

export interface SandboxRunOptions {
  language: SandboxLanguage;
  files: SandboxFile[];
  /** typescript/python/go：入口文件名（`main.ts`）；java：入口类名（`Solution`） */
  entry: string;
  timeoutMs?: number;
  memoryMb?: number;
  maxOutputBytes?: number;
  /** 故意放宽 profile 的某一项。 */
  profileOverride?: { allowNetwork?: boolean; allowFork?: boolean };
  /** 额外点名拒读的子树；被学习仓的根走这里。 */
  denyRead?: string[];
  /** 不进沙箱跑一遍，当对照组。 */
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
  /** 每步都正常退出且没超时。 */
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** 本次是否真跑在强制隔离下。 */
  isolated: boolean;
  /** 本次是否真的有内存上限；python 与 go 在 macOS 上为 `false`。 */
  memoryGuarded: boolean;
}

const DEFAULTS = { timeoutMs: 8_000, memoryMb: 128, maxOutputBytes: 64_000, goTimeoutMs: 20_000 };

interface StepPlan {
  command: string;
  args: string[];
  /** javac 那一步用 `@argfile` 拿源文件列表。 */
  appendSourceList?: boolean;
}

export function assertSafePath(path: string, language: SandboxLanguage): string {
  const normalized = path.trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("..")) throw new Error(`非法的沙箱文件名：${path}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error(`非法的沙箱文件名：${path}`);
  const extension: Record<SandboxLanguage, string> = { typescript: ".ts", python: ".py", java: ".java", go: ".go" };
  if (!normalized.endsWith(extension[language])) throw new Error(`${language} 的沙箱文件必须以 ${extension[language]} 结尾：${path}`);
  if (language === "java" && !/^[A-Za-z][A-Za-z0-9_]*\.java$/.test(normalized)) throw new Error(`Java 文件名必须是「类名.java」且不带包目录（public class 与文件名同名）：${path}`);
  return normalized;
}

function toolchainOrThrow(language: SandboxLanguage): SandboxToolchain {
  const toolchain = resolveToolchain();
  const missing = (["node", "python", "javac", "java"] as const).filter((key) => !toolchain[key]);
  if (missing.length) throw new Error(`沙箱缺解释器：${missing.join("、")}（PATH 里找不到 node/python3/javac/java）`);
  // Go 是可选语言：没装 Go 只拒 Go 代码题，不拖垮其余三语言。
  if (language === "go" && !toolchain.go) throw new Error("沙箱缺 Go 工具链：PATH 里找不到 go");
  return toolchain as SandboxToolchain;
}

function planFor(language: SandboxLanguage, entry: string, memoryMb: number, toolchain: SandboxToolchain, files: SandboxFile[]): StepPlan[] {
  if (language === "typescript") return [{ command: toolchain.node, args: [`--max-old-space-size=${memoryMb}`, "--no-warnings", entry] }];
  if (language === "python") {
    /** `-I` = 隔离模式；macOS 上下调 python 的 `RLIMIT_AS` 会失败，设限失败即放过。
        `-I` 同时把工作目录从 `sys.path` 里拿掉：入口同目录的 target 会 import 不到，这里补回入口所在目录。 */
    const bootstrap = `import os, resource, runpy, sys
try:
    resource.setrlimit(resource.RLIMIT_AS, (${memoryMb} * 1024 * 1024, resource.getrlimit(resource.RLIMIT_AS)[1]))
except (ValueError, OSError):
    pass
_entry = ${JSON.stringify(entry)}
sys.path.insert(0, os.path.dirname(os.path.abspath(_entry)))
sys.argv = [_entry]
runpy.run_path(_entry, run_name="__main__")
`;
    return [{ command: toolchain.python, args: ["-I", "-c", bootstrap] }];
  }
  if (language === "go") {
    // 显式列出全部文件：`go run` 不扫描工作目录，隐藏测试与实现一起进同一个 main 包。
    return [{ command: toolchain.go, args: ["run", ...files.map((file) => file.path)] }];
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
  /** false = 不裹 `sandbox-exec`。 */
  isolated: boolean;
}

/**
  活着的子进程组。`detached: true` 让子进程自成会话，父进程一退出它就继续跑；
  只靠超时定时器清理时，父进程（vitest worker / 被测进程）先退就再也杀不到 ——
  这是 loop.ts 孤儿进程的真正来源。这里登记起来，父进程正常退出时统一带走。
*/
const live = new Set<number>();
let hooksInstalled = false;

function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const reap = (): void => {
    for (const pid of live) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* 已经退了 */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* 已经退了 */ }
    }
    live.clear();
  };
  // exit 钩子里只能做同步调用，process.kill 是同步的。
  process.once("exit", reap);
  process.once("SIGINT", () => { reap(); process.exit(130); });
  process.once("SIGTERM", () => { reap(); process.exit(143); });
}

/**
  超时杀进程树：先杀进程组；再按父 pid 补一刀，覆盖子进程另起进程组的平台差异；
  最后补一拍，覆盖 kill 之后才冒出来的孙进程。
*/
function killTree(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); } catch { /* 已经退了 */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经退了 */ }
  try { spawnSync("/usr/bin/pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" }); } catch { /* 没有 pkill 或不给权限 */ }
  const retry = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 已经退了 */ }
    try { spawnSync("/usr/bin/pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" }); } catch { /* 同上 */ }
  }, 50);
  retry.unref?.();
}

/** 测试用：当前还有几个登记在案的子进程组。 */
export function liveProcessCount(): number {
  return live.size;
}

interface LaunchResult { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; truncated: boolean }

function launch(command: string, args: string[], context: LaunchContext): Promise<LaunchResult> {
  const binary = context.isolated ? "/usr/bin/sandbox-exec" : command;
  const forwarded = context.isolated ? ["-p", context.profile, command, ...args] : args;
  return new Promise((resolveLaunch) => {
    installExitHooks();
    const child = spawn(binary, forwarded, { cwd: context.workdir, env: context.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid !== undefined) live.add(child.pid);
    const forget = (): void => { if (child.pid !== undefined) live.delete(child.pid); };
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
      if (child.pid !== undefined) killTree(child.pid);
    }, context.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(killer);
      forget();
      stderr += `\nsandbox spawn failed: ${error.message}`;
      resolveLaunch({ exitCode: null, signal: null, timedOut, stdout, stderr, truncated });
    });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      forget();
      const done = (): void => resolveLaunch({ exitCode: timedOut ? null : code, signal, timedOut, stdout, stderr, truncated });
      // 超时那次还有一拍补刀（50ms 后重杀孙进程）；这里等它跑完再交还，
      // 否则 runRaw 的 finally 会先 rmSync 掉目录，进程还在跑「已删除的文件」。
      if (timedOut) setTimeout(done, 80); else done();
    });
  });
}

function sandboxEnv(workdir: string, toolchain: SandboxToolchain): Record<string, string> {
  const goDir = toolchain.go ? [dirname(toolchain.go)] : [];
  const binDirs = [...new Set([dirname(toolchain.node), dirname(toolchain.python), dirname(toolchain.javac), dirname(toolchain.java), ...goDir, "/usr/bin", "/bin"])];
  return {
    PATH: binDirs.join(":"),
    HOME: workdir,
    TMPDIR: workdir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    // Go 不用模块模式：题目文件都在同一个临时目录，不需要 go.mod 与联网取依赖。
    GO111MODULE: "off",
    CGO_ENABLED: "0",
    ...(toolchain.goRoot ? { GOROOT: toolchain.goRoot } : {})
  };
}

function createWorkdir(): string {
  const root = join(tmpdir(), "codebase-tutor-sandbox");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "run-"));
}

/** 真跑一次；不查隔离状态。 */
export async function runRaw(options: SandboxRunOptions): Promise<SandboxRun> {
  const { language, entry, baseline = false } = options;
  /** 形状校验先于隔离检查。 */
  const files = options.files.map((file) => ({ ...file, path: assertSafePath(file.path, language) }));
  const backend = isolationBackend();
  if (!backend.available && !baseline) throw new Error(`沙箱不可用：${backend.reason}`);
  // Go 首跑要编译标准库依赖链，默认预算比其余语言宽；显式 timeoutMs 仍可覆盖。
  const timeoutMs = options.timeoutMs ?? (language === "go" ? DEFAULTS.goTimeoutMs : DEFAULTS.timeoutMs);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
  const toolchain = toolchainOrThrow(language);
  const plans = planFor(language, entry, options.memoryMb ?? DEFAULTS.memoryMb, toolchain, files);

  const workdir = createWorkdir();
  const started = Date.now();
  try {
    for (const file of files) {
      /** 路径可带子目录。 */
      const target = join(workdir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents, "utf8");
    }

    const env = baseline ? { ...process.env, TMPDIR: workdir } : sandboxEnv(workdir, toolchain);
    // Go 的编译器/链接器是 `go` 命令的子进程；只有 Go 需要放开 fork，读写与网络仍按同一套拒绝。
    const allowFork = options.profileOverride?.allowFork ?? language === "go";
    const context: LaunchContext = { workdir, profile: seatbeltProfile(workdir, toolchain, { ...options.profileOverride, allowFork, denyRead: options.denyRead }), timeoutMs, maxOutputBytes, env, isolated: !baseline };

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
      if (result.exitCode !== 0) break;
    }
    return {
      language, steps, ok: !timedOut && steps.length === plans.length && steps.every((step) => step.exitCode === 0),
      stdout, stderr, timedOut, truncated, durationMs: Date.now() - started, isolated: !baseline,
      memoryGuarded: language !== "python" && language !== "go"
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

export { DEFAULTS };
