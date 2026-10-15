/**
  隔离探测与闸门（刀 1 的 fail-closed 那一半）。

  为什么不能省这一层：profile 写错了**不会报错**，它只会让沙箱里的代码照常读你的家目录。
  所以判定只能来自「真跑一遍恶意样本、看它是不是真被挡」，而不是「sandbox-exec 存在且 profile 语法过」。

  每一项 checks 全过才叫 `enforced`；任何一个不过就是 `unavailable`，**整个代码题域禁用**
  （2026-10-14 拍板：不降级成「弱隔离照跑」）。`runSandbox` 是唯一对外入口，它先过这道闸。

  对照组（`baseline`）是刻意只给三条做的：读家目录、外连、fork。
  没有对照，「BLOCKED」可能只是样本本身写错了，或者这台机器根本连不上网——那不能算隔离生效的证据。
  对照失败（沙箱外也没漏）**不**把等级判成 unavailable：那只会让离线机器永远出不了题，
  它记在 `control` 字段上如实显示「这一条没证成」。
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
  /** 白话一句：界面与启动日志直接用它，不再各自解释一遍 */
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

/**
  并发请求共享同一次探测；**探过就认结果，失败也缓存**。
  每次请求都重探一遍有两个不能接受的理由：canary 是起九个进程的活儿，请求风暴等于自己 DDoS 自己；
  而「这次没过就不拦了」根本不是 fail-closed——闸门只在没证据的时候关着，有失败证据的时候更要关着。
  要重开这一域就重启引擎（或显式调 `reprobeIsolation`）。
*/
export function ensureIsolation(): Promise<IsolationStatus> {
  if (current.level !== "unknown") return Promise.resolve(current);
  inFlight ??= reprobeIsolation();
  return inFlight;
}

/** 重新跑一遍探测并覆盖缓存（启动时走这里；运行期不自动走，免得把失败悄悄洗掉）。 */
export function reprobeIsolation(): Promise<IsolationStatus> {
  inFlight ??= probeIsolation().then((status) => { current = status; inFlight = undefined; return status; });
  return inFlight;
}

export function resetIsolationForTest(): void {
  current = NOT_PROBED;
  inFlight = undefined;
}

/** 只给测试用：注入一个状态，用来验「探测没过就绝不放行代码题」这条闸门是真的拦得住。 */
export function stubIsolationForTest(status: IsolationStatus): void {
  current = status;
  inFlight = undefined;
}

/**
  判分/出题的唯一入口：先把闸门过一遍，再交给 runner。
  ⚠️ `repositoryPath` 是**必填**的：它不是为了定位源码（判分路径永不读仓库源码，那是不变量），
  而是为了把这一次跑的仓点名拒读。地址簿收的是任意绝对路径，「仓在家目录里」根本不成立，
  只靠家目录那份恒定名单会漏掉 `/opt`、`/srv` 这类位置——那里的 `.tutor/tutor.db` 装着标准答案与 hidden 测试。
  把它定成必填而不是可选项，是为了让「忘了护仓」变成编译错误，不是一条要靠 review 才发现的漏口。
*/
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

/**
  读「被点名拒读的仓」。`/opt`、`/srv` 这类位置的仓不在家目录那份恒定名单里，
  靠调用方每次把仓的根塞进 `denyRead` 才护得住——这一项就是证明确实塞了、也确实生效。
*/
const readSentinelCanary = (target: string): string => `import { readFileSync } from "node:fs";
try { console.log("LEAK", readFileSync(${JSON.stringify(target)}, "utf8").trim()); } catch (error) { console.log("BLOCKED", error.code ?? error.name); }
`;

/**
  沙箱内自己建一条指向仓的符号链接再读：Seatbelt 判的是解析后的目标，链接不该成为绕行口。
  ⚠️ 链接必须建在**工作目录里**（用相对名；cwd 就是 workdir）。写到 /tmp 会被写侧规则先拒一次，
  于是读到的是 ENOENT 而不是 EPERM——那条用例就会「因为别的原因」变绿，等于没验。
*/
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

/** 真跑 canary。只在探测里用，别拿它当出题/判分路径。 */
function realpathSafeDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function probeIsolation(): Promise<IsolationStatus> {
  const started = Date.now();
  const backend = isolationBackend();
  if (!backend.available) {
    return { level: "unavailable", backend: backend.reason, checks: [], probedAt: new Date().toISOString(), durationMs: Date.now() - started, reason: backend.reason };
  }
  const checks: IsolationCheck[] = [];
  const home = homedir();
  const push = (name: string, passed: boolean, control: ControlOutcome, detail: string) => checks.push({ name, passed, control, detail });

  // 1) 三语言各跑一个真程序：profile 把自己配坏了的话，这里先响
  const tsRun = await runRaw({ language: "typescript", entry: "main.ts", files: [{ path: "main.ts", contents: 'import { twice } from "./dep.ts";\nconsole.log("SANDBOX-OK", twice(21));\n' }, { path: "dep.ts", contents: 'export function twice(n: number): number {\n  return n * 2;\n}\n' }] });
  push("run-typescript", tsRun.ok && tsRun.stdout.includes("SANDBOX-OK 42"), "not-run", outcome(tsRun));

  const pyRun = await runRaw({ language: "python", entry: "main.py", files: [{ path: "main.py", contents: 'import json, math\nprint("SANDBOX-OK", json.dumps({"r": math.sqrt(16)}))\n' }] });
  push("run-python", pyRun.ok && pyRun.stdout.includes('"r": 4.0'), "not-run", outcome(pyRun));

  const javaRun = await runRaw({ language: "java", entry: "SandboxProbe", files: [{ path: "SandboxProbe.java", contents: 'public class SandboxProbe {\n  public static void main(String[] args) { System.out.println("SANDBOX-OK " + (41 * 2)); }\n}\n' }] });
  push("run-java", javaRun.ok && javaRun.stdout.includes("SANDBOX-OK 82"), "not-run", outcome(javaRun));

  // 2) 读家目录（引擎口令、被学习仓、.ssh 全在这条子树底下）
  const homeRun = await runRaw({ language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readHomeCanary(home) }] });
  const homeControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readHomeCanary(home) }] });
  push("read-home", homeRun.stdout.includes("BLOCKED"), homeControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(homeRun)} / 对照 ${outcome(homeControl)}`);

  // 2b) 仓不在家目录里也要读不到：拿一个家目录之外的临时目录当「装在 /opt 的仓」，里面放 `.tutor/tutor.db`
  //     （判分与自证本来就不读仓库源码——读到了就是读到标准答案）
  const standIn = mkdtempSync(join(realpathSafeDir(tmpdir()), "tutor-sandbox-repo-"));
  mkdirSync(join(standIn, ".tutor"), { recursive: true });
  writeFileSync(join(standIn, ".tutor", "tutor.db"), "SENTINEL-STANDARD-ANSWERS\n", "utf8");
  try {
    const repoRun = await runRaw({ denyRead: [standIn], language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readSentinelCanary(join(standIn, ".tutor", "tutor.db")) }] });
    const repoControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readSentinelCanary(join(standIn, ".tutor", "tutor.db")) }] });
    push("read-repo", repoRun.stdout.includes("BLOCKED"), repoControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(repoRun)} / 对照 ${outcome(repoControl)}`);

    const linkTarget = join(standIn, ".tutor", "tutor.db");
    const linkRun = await runRaw({ denyRead: [standIn], language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readSymlinkCanary(linkTarget) }] });
    // 对照组同一条链接在沙箱外必须真读得到：否则「BLOCKED」可能只是链接没建起来
    const linkControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: readSymlinkCanary(linkTarget) }] });
    push("read-repo-via-symlink", linkRun.stdout.includes("BLOCKED"), linkControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(linkRun)} / 对照 ${outcome(linkControl)}`);
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }

  // 3) 外连：打的是探测进程自己起的回环监听，零对外流量
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  const netRun = await runRaw({ language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: networkCanary(port) }] });
  const netControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: networkCanary(port) }] });
  server.close();
  push("network", netRun.stdout.includes("BLOCKED"), netControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(netRun)} / 对照 ${outcome(netControl)}`);

  // 4) fork：fork 炸弹与「自己再起一个进程绕过限制」都归这一条
  const forkRun = await runRaw({ language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: forkCanary }] });
  const forkControl = await runRaw({ baseline: true, language: "typescript", entry: "canary.ts", files: [{ path: "canary.ts", contents: forkCanary }] });
  push("fork", forkRun.stdout.includes("BLOCKED"), forkControl.stdout.includes("LEAK") ? "leaked" : "also-blocked", `${outcome(forkRun)} / 对照 ${outcome(forkControl)}`);

  // 5) 死循环必须被超时杀掉，而且是整组杀（detached + kill(-pgid)）
  const loopRun = await runRaw({ timeoutMs: 1_200, language: "typescript", entry: "loop.ts", files: [{ path: "loop.ts", contents: "while (true) {}\n" }] });
  push("timeout-kill", loopRun.timedOut, "not-run", `signal=${loopRun.steps[0]?.signal ?? "-"} timedOut=${loopRun.timedOut}`);

  // 6) 输出上限：到量必须截断且仍然收尾，不能把子进程卡在满管道上
  const spillRun = await runRaw({ maxOutputBytes: 4_096, timeoutMs: 4_000, language: "typescript", entry: "spill.ts", files: [{ path: "spill.ts", contents: 'for (let i = 0; i < 40_000; i += 1) console.log("x".repeat(64));\n' }] });
  push("output-cap", spillRun.truncated && !spillRun.timedOut, "not-run", `truncated=${spillRun.truncated} bytes=${spillRun.stdout.length} timedOut=${spillRun.timedOut}`);

  // 7) 内存上限至少要「管得住也报得出」：贴着 RLIMIT_AS 的量会掐死解释器本身，那是假阳性
  const memoryRun = await runRaw({ memoryMb: 32, timeoutMs: 4_000, language: "typescript", entry: "mem.ts", files: [{ path: "mem.ts", contents: 'const buckets = [];\nwhile (true) buckets.push("x".repeat(1 << 20));\n' }] });
  push("memory-cap", memoryRun.steps[0]?.exitCode !== 0 && !memoryRun.timedOut, "not-run", `exit=${memoryRun.steps[0]?.exitCode ?? "-"} ${memoryRun.stderr.trim().split("\n")[0]?.slice(0, 60) ?? ""}`);

  const failed = checks.filter((check) => !check.passed).map((check) => check.name);
  const unproven = checks.filter((check) => check.control === "also-blocked").map((check) => check.name);
  const level: IsolationLevel = failed.length ? "unavailable" : "enforced";
  const reason = failed.length ? `以下隔离检查未通过：${failed.join("、")}` : `${checks.length} 项检查全过${unproven.length ? `（${unproven.join("、")} 的对照组也没漏，这一条本机证不了，按沙箱内读数放行）` : ""}`;
  return { level, backend: backend.reason, checks, probedAt: new Date().toISOString(), durationMs: Date.now() - started, reason };
}
