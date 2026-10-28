/** 沙箱 profile：macOS 用 Seatbelt（`/usr/bin/sandbox-exec`），其他平台按不可用处理。
    读侧是「默认放行 + 点名拒读」；写侧是整片拒 + 白名单放行。 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hash } from "@codebase-tutor/platform";

/** 恒定拒读的子树；被学习仓的根由调用方经 `denyRead` 逐次点名。 */
function deniedReadRoots(): string[] {
  return [homedir(), "/Volumes", "/Network"];
}

/** 系统级只读根：解释器要用的 dyld、时区、框架。 */
const SYSTEM_READ_ROOTS = ["/usr", "/System/Library", "/Library/Preferences", "/Library/Java", "/private/etc", "/private/var/db", "/dev"];

export interface SandboxToolchain {
  node: string;
  python: string;
  javac: string;
  java: string;
  /** `sys.prefix` 那一份，stdlib 与 site-packages 在其下。 */
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

/** 解释器位置按 PATH 实时计算。 */
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

/** 生成 Seatbelt profile；`workdir` 需是 realpath 后的绝对路径，额外拒读的子树走 `options.denyRead`。 */
export function seatbeltProfile(workdir: string, toolchain: Partial<SandboxToolchain>, options: { allowNetwork?: boolean; allowFork?: boolean; denyRead?: string[] } = {}): string {
  // SBPL 判的是内核解析后的路径，这里必须写 realpath
  const runDir = realpathSafe(workdir);
  // 只许写本次这一份 run 目录
  const writable = [runDir, "/dev"];
  // SBPL 同操作下后写的覆盖先写的：家目录在前、系统根在后
  const blanket = deniedReadRoots().filter((root) => existsSync(root));
  // 点名拒读的仓排在所有 allow 之后
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

/** 本机有没有可用的强制隔离；只有 darwin 有实现。 */
export function isolationBackend(): { platform: NodeJS.Platform; available: boolean; reason: string } {
  const platform = process.platform;
  if (platform !== "darwin") return { platform, available: false, reason: `没有 ${platform} 的隔离后端实现（只写了 macOS Seatbelt），代码题域按不可用处理` };
  if (!existsSync("/usr/bin/sandbox-exec")) return { platform, available: false, reason: "系统里没有 /usr/bin/sandbox-exec，Seatbelt 不可用" };
  return { platform, available: true, reason: "macOS Seatbelt（sandbox-exec）" };
}

/** runner 指纹：隔离后端、解释器版本与 profile 形状；任一变化都要让旧缓存键失效。 */
let cachedFingerprint: string | undefined;
export function runnerFingerprint(): string {
  if (cachedFingerprint) return cachedFingerprint;
  const toolchain = resolveToolchain();
  const probe = (command: string | undefined, args: string[]): string => {
    if (!command) return "missing";
    // javac -version 把版本写在 stderr
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
