/** 沙箱 runner：把一组文件加一个入口在强制隔离下真跑一次，返回 stdout/stderr/退出状态；不含判分语义。
    超时杀整个进程组（`detached` + `kill(-pid)`）；输出到量后继续排空但丢弃。`baseline` 不裹 `sandbox-exec`，用真 HOME 跑。 */
import { spawn } from "node:child_process";
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
  /** typescript/python：入口文件名（`main.ts`）；java：入口类名（`Solution`） */
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
  /** 本次是否真的有内存上限；python 在 macOS 上为 `false`。 */
  memoryGuarded: boolean;
}

const DEFAULTS = { timeoutMs: 8_000, memoryMb: 128, maxOutputBytes: 64_000 };

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
    /** `-I` = 隔离模式；macOS 上下调 python 的 `RLIMIT_AS` 会失败，设限失败即放过。 */
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
  /** false = 不裹 `sandbox-exec`。 */
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
      // 负 pid = 整个进程组
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
  return { PATH: binDirs.join(":"), HOME: workdir, TMPDIR: workdir, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
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
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
  const toolchain = toolchainOrThrow();
  const plans = planFor(language, entry, options.memoryMb ?? DEFAULTS.memoryMb, toolchain);

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
      if (result.exitCode !== 0) break;
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
