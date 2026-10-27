/**
  沙箱 profile：macOS 用系统自带的 Seatbelt（`/usr/bin/sandbox-exec`），Linux 暂不实现——
  没有可用的强制隔离时整域禁用代码题，不降级成「弱隔离照跑」。

  两条形状约束（改回去会让 launcher 自杀，别改回去）：
  - 不能整片 `deny file-read*` 再白名单放行：`sandbox-exec` 启动时要先 execvp 目标程序，
    它需要的读也在被拒之列，launcher 直接 SIGABRT。可用形状是「默认放行 + 点名拒读敏感子树」：
    `(deny file-read* (subpath "$HOME"))` 把家目录整片拒掉，再把解释器自己的根后置放行
    （规则先后为什么有意义，见 `seatbeltProfile` 里 SBPL 覆盖语义那一条）。
    即使把系统根与解释器根全部放行，「默认拒读」这条路在本机 macOS 上仍走不通；要护住什么就往名单里点名。
  - `deny network*` 与 `deny process-fork` 放在 profile 层是安全的，不会杀掉 launcher
    （三语言 launcher 与解释器都照常跑，而 fork 与 connect 在沙箱内拿到 EPERM）。
    这一条顺带解决了 fork 炸弹：连一次 `fork()` 都出不去，不需要 rlimit。

  写侧是整片拒 + 白名单：`(deny file-write*)` 不参与启动，没有 SIGABRT 问题。
*/
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hash } from "@codebase-tutor/platform";

/**
  恒定拒读的子树：家目录整片（引擎口令、`.ssh`、多数仓都在这里）加上可移动盘与网络挂载。
  这一份不够：`POST /imports` 收任意绝对路径，仓完全可以住在 `/opt`、`/srv` 这类位置，
  那里的 `.tutor/tutor.db` 装着标准答案与 hidden 测试——所以被学习仓的根必须由调用方逐次点名
  （`seatbeltProfile` 的 `options.denyRead`，产品侧入口都经 `runSandbox` 强制带 `repositoryPath`）。
  为什么不改成「默认拒读 + 白名单放行」：本机 macOS 不可行，见文件顶部 SIGABRT 那条。
*/
function deniedReadRoots(): string[] {
  return [homedir(), "/Volumes", "/Network"];
}

/**
  系统级只读根：解释器要用的 dyld/时区/框架都在这里。`/usr` 是宽的，但它不含用户数据，
  收窄它对安全没有收益、对可靠性有成本（macOS 的 `/usr/bin/java` 是个 shim，靠 `/usr/libexec/java_home` 找 JVM）。
*/
const SYSTEM_READ_ROOTS = ["/usr", "/System/Library", "/Library/Preferences", "/Library/Java", "/private/etc", "/private/var/db", "/dev"];

export interface SandboxToolchain {
  node: string;
  python: string;
  javac: string;
  java: string;
  /** `python3 -c 'import sys; print(sys.prefix)'` 的那一份，stdlib 与 site-packages 都在这底下 */
  pythonPrefix: string;
  javaHome: string;
}

function searchPath(name: string, pathValue: string): string | undefined {
  for (const directory of (pathValue || "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 解释器位置全部实时计算，不手写清单：换了 brew/conda 装的 python，profile 跟着变，不会因为注释里的旧路径误导人。 */
export function resolveToolchain(env: NodeJS.ProcessEnv = process.env): Partial<SandboxToolchain> {
  const pathValue = env.PATH ?? "";
  const resolve = (name: string): string | undefined => {
    const found = searchPath(name, pathValue);
    if (!found) return undefined;
    try { return realpathSync(found); } catch { return found; }
  };
  const node = resolve("node");
  const python = resolve("python3");
  const javac = resolve("javac");
  const java = resolve("java");
  const pythonPrefix = python ? dirname(dirname(python)) : undefined;
  const javaHome = env.JAVA_HOME ?? (java ? dirname(dirname(java)) : undefined);
  const toolchain: Partial<SandboxToolchain> = {};
  if (node) toolchain.node = node;
  if (python) toolchain.python = python;
  if (javac) toolchain.javac = javac;
  if (java) toolchain.java = java;
  if (pythonPrefix) toolchain.pythonPrefix = pythonPrefix;
  if (javaHome) toolchain.javaHome = javaHome;
  return toolchain;
}

/** 解释器自己那一份运行时要读的东西（node 的 lib、python 的 stdlib、JDK 的 jre）。 */
function interpreterReadRoots(toolchain: Partial<SandboxToolchain>): string[] {
  const roots = new Set<string>();
  if (toolchain.node) roots.add(dirname(realpathSafe(toolchain.node)));
  if (toolchain.python) roots.add(realpathSafe(dirname(toolchain.python)));
  if (toolchain.pythonPrefix) roots.add(realpathSafe(toolchain.pythonPrefix));
  if (toolchain.java) roots.add(realpathSafe(dirname(toolchain.java)));
  if (toolchain.javaHome) roots.add(realpathSafe(toolchain.javaHome));
  if (toolchain.javac) roots.add(realpathSafe(dirname(toolchain.javac)));
  return [...roots].filter((root) => root && existsSync(root));
}

function realpathSafe(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

const quote = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
  生成一份 Seatbelt profile。
  @param workdir 本次运行的沙箱目录（必须是 realpath 后的绝对路径，`/tmp` 会解析成 `/private/tmp`）
  @param options.denyRead 额外点名拒读的子树——被学习仓的根就走这里（见 `deniedReadRoots`）
*/
export function seatbeltProfile(workdir: string, toolchain: Partial<SandboxToolchain>, options: { allowNetwork?: boolean; allowFork?: boolean; denyRead?: string[] } = {}): string {
  // SBPL 判的是内核解析后的路径：`/var` 与 `/private/var` 必须写成同一份，否则下面这条放行压不过上面的拒读
  const runDir = realpathSafe(workdir);
  // 只许写自己这一份 run 目录：TMPDIR 已经指进 workdir，放行整片临时目录等于让沙箱代码读写同根的历次 run
  const writable = [runDir, "/dev"];
  // 家目录那一档在前、系统根在后：SBPL 是同操作下后写的覆盖先写的，
  // 所以「先拒家目录、再放解释器根」是真生效的。
  const blanket = deniedReadRoots().filter((root) => existsSync(root));
  // 点名要护住的仓放在所有 allow 之后：反过来会让 allow 覆盖这条 deny，
  // 恰好住在 `/usr/local/...` 里的仓就白护了。沙箱本来就不该读仓（判分不读仓库源码是不变量），
  // 所以这一档压在所有放行上面没有副作用。
  const named = (options.denyRead ?? []).map((root) => realpathSafe(root)).filter((root) => root && existsSync(root));
  const rules: string[] = [
    "(version 1)",
    "(allow default)",
    options.allowNetwork ? "; (network allowed: 仅隔离探测用来证明默认是拒的)" : "(deny network*)",
    options.allowFork ? "; (fork allowed: 仅隔离探测用)" : "(deny process-fork)",
    ...blanket.map((root) => `(deny file-read* (subpath ${quote(root)}))`),
    ...[...SYSTEM_READ_ROOTS, ...interpreterReadRoots(toolchain)].filter((root) => existsSync(root)).map((root) => `(allow file-read* (subpath ${quote(root)}))`),
    ...[...new Set(named)].map((root) => `(deny file-read* (subpath ${quote(root)}))`),
    "(deny file-write*)",
    ...writable.map((root) => `(allow file-write* (subpath ${quote(root)}))`)
  ];
  return rules.join("\n");
}

/** 本机有没有可用的强制隔离；目前只有 darwin 有实现。 */
export function isolationBackend(): { platform: NodeJS.Platform; available: boolean; reason: string } {
  const platform = process.platform;
  if (platform !== "darwin") return { platform, available: false, reason: `没有 ${platform} 的隔离后端实现（只写了 macOS Seatbelt），代码题域按不可用处理` };
  if (!existsSync("/usr/bin/sandbox-exec")) return { platform, available: false, reason: "系统里没有 /usr/bin/sandbox-exec，Seatbelt 不可用" };
  return { platform, available: true, reason: "macOS Seatbelt（sandbox-exec）" };
}

/**
  runner 指纹：换解释器、改 profile 形状、动默认上限，都要让旧题的缓存键一起失效。
  题面的标准答案是「这套 harness 在这套 runner 上跑出来的」——node 升一档，缺陷版可能就不挂了，
  旧题的「必挂」承诺随之作废，所以这个指纹必须进出题作用域（见 exercises/llm-generate.ts 的 `fileScope`）。
  版本串现读、不写死：写死的那一份会在升级后继续报旧值。
*/
let cachedFingerprint: string | undefined;
export function runnerFingerprint(): string {
  if (cachedFingerprint) return cachedFingerprint;
  const toolchain = resolveToolchain();
  const probe = (command: string | undefined, args: string[]): string => {
    if (!command) return "missing";
    // 用 spawnSync 而不是 execFileSync：`javac -version` 把版本写在 stderr，按异常处理的读法拿不到那一行
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000 });
    if (result.error) return `error ${result.error.message.slice(0, 40)}`;
    return (result.stdout || result.stderr || "").trim().split("\n")[0];
  };
  const shape = seatbeltProfile("<WORKDIR>", toolchain);
  cachedFingerprint = hash([
    isolationBackend().reason,
    toolchain.node ? probe(toolchain.node, ["--version"]) : "missing",
    toolchain.python ? probe(toolchain.python, ["--version"]) : "missing",
    toolchain.javac ? probe(toolchain.javac, ["-version"]) : "missing",
    shape
  ].join("|")).slice(0, 16);
  return cachedFingerprint;
}
