/**
  隔离探测与闸门：全部 checks 通过才判 `enforced`，任一不过判 `unavailable` 并禁用代码题域。
  判定只来自真跑恶意样本的结果，不来自 `sandbox-exec` 是否存在或 profile 语法是否过。
  `baseline` 对照组只给读家目录、外连、fork 三条做；对照失败记在 `control` 字段，不改判等级。
*/
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { runRaw, type SandboxRun, type SandboxRunOptions } from "./runner.js";
import { isolationBackend } from "./profile.js";

export type IsolationLevel = "unknown" | "enforced" | "unavailable";
export type ControlOutcome = "leaked" | "also-blocked" | "not-run";

export interface IsolationCheck {
  name: string;
  passed: boolean;
  control: ControlOutcome;
  detail: string;
}

export interface IsolationStatus {
  level: IsolationLevel;
  backend: string;
  checks: IsolationCheck[];
  probedAt: string | null;
  durationMs: number;
  /** 一句结论，直接展示。 */
  reason: string;
}

export class SandboxUnavailableError extends Error {
  readonly status: IsolationStatus;
  constructor(status: IsolationStatus) {
    super(`代码题沙箱不可用：${status.reason}`);
    this.name = "SandboxUnavailableError";
    this.status = status;
  }
}

const NOT_PROBED: IsolationStatus = { level: "unknown", backend: isolationBackend().reason, checks: [], probedAt: null, durationMs: 0, reason: "还没跑过隔离探测" };

let current: IsolationStatus = NOT_PROBED;
let inFlight: Promise<IsolationStatus> | undefined;

export function isolationStatus(): IsolationStatus {
  return current;
}

/** 并发请求共享同一次探测；成功与失败都缓存。 */
export function ensureIsolation(): Promise<IsolationStatus> {
  if (current.level !== "unknown") return Promise.resolve(current);
  inFlight ??= reprobeIsolation();
  return inFlight;
}

/** 重跑探测并覆盖缓存；两种结局都要清 `inFlight`。 */
export function reprobeIsolation(): Promise<IsolationStatus> {
  inFlight ??= probeIsolation().then(
    (status) => { current = status; return status; },
    (error: unknown) => {
      // 探测自身异常也判成不可用并缓存
      const reason = error instanceof Error ? error.message : String(error);
      current = { level: "unavailable", backend: isolationBackend().reason, checks: [], probedAt: new Date().toISOString(), durationMs: 0, reason: `隔离探测没跑成：${reason}` };
      return current;
    }
  ).finally(() => { inFlight = undefined; });
  return inFlight;
}

export function resetIsolationForTest(): void {
  current = NOT_PROBED;
  inFlight = undefined;
}

/** 注入一个探测状态，仅测试用。 */
export function stubIsolationForTest(status: IsolationStatus): void {
  current = status;
  inFlight = undefined;
}

/** 判分与出题的唯一入口：先过闸门，再把 `repositoryPath` 写进拒读名单。 */
export async function runSandbox(options: SandboxRunOptions & { repositoryPath: string }): Promise<SandboxRun> {
  const status = await ensureIsolation();
  if (status.level !== "enforced") throw new SandboxUnavailableError(status);
  const { repositoryPath, ...rest } = options;
  return runRaw({ ...rest, denyRead: [...(rest.denyRead ?? []), repositoryPath] });
}

const readHomeCanary = (home: string): string => `import { readdirSync } from "node:fs";
try { console.log("LEAK", readdirSync(${JSON.stringify(home)}).length); } catch (error) { console.log("BLOCKED", error.code ?? error.name); }
`;

const networkCanary = (port: number): string => `import net from "node:net";
const socket = net.connect({ host: "127.0.0.1", port: ${port} }, () => { console.log("LEAK"); socket.destroy(); process.exit(0); });
socket.on("error", (error) => { console.log("BLOCKED", error.code ?? error.name); process.exit(0); });
setTimeout(() => { console.log("BLOCKED", "timeout"); process.exit(0); }, 1500);
`;

/** 读被点名拒读的仓。 */
const readSentinelCanary = (target: string): string => `import { readFileSync } from "node:fs";
try { console.log("LEAK", readFileSync(${JSON.stringify(target)}, "utf8").trim()); } catch (error) { console.log("BLOCKED", error.code ?? error.name); }
`;

/** 沙箱内自建指向仓的符号链接再读。链接必须建在工作目录里，否则写侧先拒、用例假绿。 */
const readSymlinkCanary = (target: string): string => `import { symlinkSync, readFileSync } from "node:fs";
symlinkSync(${JSON.stringify(target)}, "link-to-repo");
try { console.log("LEAK", readFileSync("link-to-repo", "utf8").trim()); } catch (error) { console.log("BLOCKED", error.code ?? error.name); }
`;

const forkCanary = `import { spawnSync } from "node:child_process";
const result = spawnSync("/usr/bin/true", { encoding: "utf8" });
console.log(result.error ? \`BLOCKED \${result.error.code ?? result.error.name}\` : "LEAK");
`;

function outcome(run: SandboxRun): string {
  return `${run.stdout.trim().split("\n")[0] ?? ""}${run.stderr ? ` | stderr ${run.stderr.trim().slice(0, 60)}` : ""}`;
}

function realpathSafeDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 真跑一轮全部 canary 并汇总状态；只在探测里用。 */
export async function probeIsolation(): Promise<IsolationStatus> {
  const started = Date.now();
  const backend = isolationBackend();
  if (!backend.available) {
    return { level: "unavailable", backend: backend.reason, checks: [], probedAt: new Date().toISOString(), durationMs: Date.now() - started, reason: backend.reason };
  }
  const checks: IsolationCheck[] = [];
  const home = homedir();
  const push = (name: string, passed: boolean, control: ControlOutcome, detail: string) => checks.push({ name, passed, control, detail });

  // 1) 三语言各跑一个真程序
  const tsRun = await runRaw({ language: "typescript", entry: "main.ts", files: [{ path: "main.ts", contents: 'import { twice } from "./dep.ts";\nconsole.log("SANDBOX-OK", twice(21));\n' }, { path: "dep.ts", contents: 'export function twice(n: number): number {\n  return n * 2;\n}\n' }] });
  push("run-typescript", tsRun.ok && tsRun.stdout.includes("SANDBOX-OK 42"), "not-run", outcome(tsRun));

  const pyRun = await runRaw({ language: "python", entry: "main.py", files: [{ path: "main.py", contents: 'import json, math\nprint("SANDBOX-OK", json.dumps({"r": math.sqrt(16)}))\n' }] });
  push("run-python", pyRun.ok && pyRun.stdout.includes('"r": 4.0'), "not-run", outcome(pyRun));

  const javaRun = await runRaw({ language: "java", entry: "SandboxProbe", files: [{ path: "SandboxProbe.java", contents: 'public class SandboxProbe {\n  public static void main(String[] args) { System.out.println("SANDBOX-OK " + (41 * 2)); }\n}\n' }] });
  push("run-java", javaRun.ok && javaRun.stdout.includes("SANDBOX-OK 82"), "not-run", outcome(javaRun));

  // 2) 读家目录
  const homeRun = await runRaw({ language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readHomeCanary(home) }] });
  const homeControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readHomeCanary(home) }] });
  push("read-home", homeRun.stdout.includes("BLOCKED"), homeControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(homeRun)} / 对照 ${outcome(homeControl)}`);

  // 2b) 仓不在家目录里时也要读不到：用家目录外的临时目录当仓，里面放 `.tutor/tutor.db`
  const standIn = mkdtempSync(join(realpathSafeDir(tmpdir()), "tutor-sandbox-repo-"));
  mkdirSync(join(standIn, ".tutor"), { recursive: true });
  writeFileSync(join(standIn, ".tutor", "tutor.db"), "SENTINEL-STANDARD-ANSWERS\n", "utf8");
  try {
    const repoRun = await runRaw({ denyRead: [standIn], language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readSentinelCanary(join(standIn, ".tutor", "tutor.db")) }] });
    const repoControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readSentinelCanary(join(standIn, ".tutor", "tutor.db")) }] });
    push("read-repo", repoRun.stdout.includes("BLOCKED"), repoControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(repoRun)} / 对照 ${outcome(repoControl)}`);

    const linkTarget = join(standIn, ".tutor", "tutor.db");
    const linkRun = await runRaw({ denyRead: [standIn], language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readSymlinkCanary(linkTarget) }] });
    // 对照组同一条链接在沙箱外必须真读得到
    const linkControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readSymlinkCanary(linkTarget) }] });
    push("read-repo-via-symlink", linkRun.stdout.includes("BLOCKED"), linkControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(linkRun)} / 对照 ${outcome(linkControl)}`);
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }

  // 3) 外连：探测进程自己起的回环监听
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  const netRun = await runRaw({ language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: networkCanary(port) }] });
  const netControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: networkCanary(port) }] });
  server.close();
  push("network", netRun.stdout.includes("BLOCKED"), netControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(netRun)} / 对照 ${outcome(netControl)}`);

  // 4) fork
  const forkRun = await runRaw({ language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: forkCanary }] });
  const forkControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: forkCanary }] });
  push("fork", forkRun.stdout.includes("BLOCKED"), forkControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(forkRun)} / 对照 ${outcome(forkControl)}`);

  // 5) 死循环被超时杀掉，且整组杀
  const loopRun = await runRaw({ timeoutMs: 1_200, language: "typescript", entry: "loop.ts", files: [{ path: "loop.ts", contents: "while (true) {}\n" }] });
  push("timeout-kill", loopRun.timedOut, "not-run", `signal=${loopRun.steps[0]?.signal ?? "-"} timedOut=${loopRun.timedOut}`);

  // 6) 输出上限：到量截断且仍然收尾
  const spillRun = await runRaw({ maxOutputBytes: 4_096, timeoutMs: 4_000, language: "typescript", entry: "spill.ts", files: [{ path: "spill.ts", contents: 'for (let i = 0; i < 40_000; i += 1) console.log("x".repeat(64));\n' }] });
  push("output-cap", spillRun.truncated && !spillRun.timedOut, "not-run", `truncated=${spillRun.truncated} bytes=${spillRun.stdout.length} timedOut=${spillRun.timedOut}`);

  // 7) 内存上限：拦得住也报得出
  const memoryRun = await runRaw({ memoryMb: 32, timeoutMs: 4_000, language: "typescript", entry: "mem.ts", files: [{ path: "mem.ts", contents: 'const buckets = [];\nwhile (true) buckets.push("x".repeat(1 << 20));\n' }] });
  push("memory-cap", memoryRun.steps[0]?.exitCode !== 0 && !memoryRun.timedOut, "not-run", `exit=${memoryRun.steps[0]?.exitCode ?? "-"} ${memoryRun.stderr.trim().split("\n")[0]?.slice(0, 60) ?? ""}`);

  const failed = checks.filter((check) => !check.passed).map((check) => check.name);
  const unproven = checks.filter((check) => check.control === "also-blocked").map((check) => check.name);
  const level: IsolationLevel = failed.length ? "unavailable" : "enforced";
  const reason = failed.length ? `以下隔离检查未通过：${failed.join("、")}` : `${checks.length} 项检查全过${unproven.length ? `（${unproven.join("、")} 的对照组也没漏，这一条本机证不了，按沙箱内读数放行）` : ""}`;
  return { level, backend: backend.reason, checks, probedAt: new Date().toISOString(), durationMs: Date.now() - started, reason };
}
