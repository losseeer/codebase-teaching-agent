/**
  沙箱 profile（刀 1）：macOS 用系统自带的 Seatbelt（`/usr/bin/sandbox-exec`），Linux 暂不实现——
  没有可用的强制隔离时**整域禁用代码题**，不降级成「弱隔离照跑」（2026-10-14 拍板）。

  形状是实测出来的，两条反直觉的约束都记在这里，别再改回去：
  - **不能整片 `deny file-read*` 再白名单放行**。这样写 launcher 自己 SIGABRT：`sandbox-exec` 要先 execvp 目标程序，
    而它需要的读也在被拒之列。可用形状是「默认放行 + 点名拒读敏感子树」，
    即 `(deny file-read* (subpath "$HOME"))` 把家目录整片拒掉，**再把解释器自己的根后置放行**——
    SBPL 是同操作下后写的规则覆盖先写的，所以「先拒家目录、再放 `/Users/…/miniconda3`」是真生效的（已验）。
  - **`deny network*` 与 `deny process-fork` 放在 profile 层是安全的**，不会杀掉 launcher（已验：
    echo/node/python3/javac/java 全部照常跑，而 fork 与 connect 在沙箱内拿到 EPERM）。
    这一条顺带解决了 fork 炸弹：连一次 `fork()` 都出不去，不需要 rlimit。

  写侧仍然是整片拒 + 白名单：`(deny file-write*)` 不参与启动，所以不会 SIGABRT。
*/
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hash } from "../lib.js";

/** 沙箱拒读到哪为止：家目录整片（引擎口令、被学习仓、`.ssh` 都在里面）加上可移动盘。 */
const DENY_READ_SUBTREES = () => [homedir(), "/Volumes", "/Network"];

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

/** 解释器位置全部现算，不手写清单：换了 brew/conda 装的 python，profile 跟着变，不会因为注释里的旧路径骗人。 */
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
*/
export function seatbeltProfile(workdir: string, toolchain: Partial<SandboxToolchain>, options: { allowNetwork?: boolean; allowFork?: boolean } = {}): string {
  const writable = [workdir, realpathSafe(tmpdir()), "/dev"];
  const rules: string[] = [
    "(version 1)",
    "(allow default)",
    options.allowNetwork ? "; (network allowed: 仅隔离探测用来证明默认是拒的)" : "(deny network*)",
    options.allowFork ? "; (fork allowed: 仅隔离探测用)" : "(deny process-fork)",
    ...DENY_READ_SUBTREES().filter((root) => root && existsSync(root)).map((root) => `(deny file-read* (subpath ${quote(root)}))`),
    ...[...SYSTEM_READ_ROOTS, ...interpreterReadRoots(toolchain)].filter((root) => existsSync(root)).map((root) => `(allow file-read* (subpath ${quote(root)}))`),
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
  旧题的「必挂」承诺随之作废，所以这一格必须进出题作用域（见 exercises/llm-generate.ts 的 `fileScope`）。
  版本串现读、不写死：写死的那一份会在升级后继续报旧值，等于自证过期。
*/
let cachedFingerprint: string | undefined;
export function runnerFingerprint(): string {
  if (cachedFingerprint) return cachedFingerprint;
  const toolchain = resolveToolchain();
  const probe = (command: string | undefined, args: string[]): string => {
    if (!command) return "missing";
    // spawnSync 而不是 execFileSync：`javac -version` 把版本写在 **stderr** 上，抛异常的版本读不到那一行
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
