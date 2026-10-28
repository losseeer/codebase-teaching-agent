import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { FileEntry, SourceAnchor } from "@codebase-tutor/domain";

import { cppExtensionPattern, handledExtensions } from "../ingestion/language-extensions.js";
import { detectJavaEntrypoints } from "./java-entrypoints.js";
import { detectNodeEntrypoints } from "./node-entrypoints.js";
import { detectPythonEntrypoints } from "./python-entrypoints.js";
import { isTestPath } from "../extraction/roles.js";

export function detectEntrypoints(repositoryPath: string, files: FileEntry[], contents: Map<string, string>): SourceAnchor[] {
  // 注解命中即权威入口，优先入列
  const java = detectJavaEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  // Go/Rust/C/C# 的 main 函数与 Java 注解同为权威入口
  const mains = detectMainFunctionEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  // Python 的框架约定与脚本守卫同为权威入口
  const python = detectPythonEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  const node = detectNodeEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  const authoritativePaths = new Set([...java, ...mains, ...python, ...node].map((anchor) => anchor.path));
  const candidates = new Map<string, string>();
  const manifest = join(repositoryPath, "package.json");
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { main?: string; bin?: string | Record<string, string>; scripts?: Record<string, string> };
      if (pkg.main) candidates.set(pkg.main.replace(/^\.\//, ""), "package main");
      const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
      bins.forEach((bin) => candidates.set(bin.replace(/^\.\//, ""), "CLI command"));
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        const match = command.match(/(?:tsx|node|vite|python)\s+([^\s]+)/);
        if (match) candidates.set(match[1].replace(/^\.\//, ""), `script: ${name}`);
      }
    } catch { /* package.json 读失败不影响入口识别 */ }
  }
  for (const file of files) {
    // 约定名只在进得了依赖图的语言里认
    if (!handledExtensions.has(file.extension)) continue;
    const name = basename(file.path, extname(file.path)).toLowerCase();
    if (["main", "server", "app", "index", "cli", "manage"].includes(name)) candidates.set(file.path, "conventional entrypoint");
  }
  // 测试夹具里的候选剔除，与结构角色共用同一套测试路径判据
  // 权威入口不沿用弱启发式的 12 条截断
  const conventional = [...candidates.entries()]
    .filter(([path]) => !isTestPath(path) && !authoritativePaths.has(path) && files.some((file) => file.path === path))
    .map(([path, label]) => ({ path, line: 1, label }));
  return [...java.slice(0, 60), ...mains.slice(0, 60), ...python.slice(0, 60), ...node.slice(0, 60), ...conventional.slice(0, 12)];
}

/** Go/Rust/C/C# 主函数入口：每个文件取首个命中，锚在声明行。 */
function detectMainFunctionEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const rules: { extension: RegExp; pattern: RegExp; label: string }[] = [
    { extension: /\.go$/, pattern: /^[ \t]*func main\(\)/m, label: "Go 主函数" },
    { extension: /\.rs$/, pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?fn main\(\)/m, label: "Rust 主函数" },
    { extension: cppExtensionPattern, pattern: /^[ \t]*(?:signed\s+)?int main\s*\(/m, label: "C/C++ 主函数" },
    { extension: /\.cs$/, pattern: /^[ \t]*(?:(?:public|private|internal|protected|static|unsafe|partial|async)\s+)*(?:void|int|Task)\s+Main(?:Async)?\s*\(/m, label: "C# 主函数" }
  ];
  const anchors: SourceAnchor[] = [];
  for (const [path, content] of contents) {
    const rule = rules.find((item) => item.extension.test(path));
    if (!rule) continue;
    const match = content.match(rule.pattern);
    if (!match) continue;
    anchors.push({ path, line: content.slice(0, match.index ?? 0).split("\n").length, label: rule.label });
  }
  return anchors;
}

