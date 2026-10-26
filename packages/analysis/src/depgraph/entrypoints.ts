import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { FileEntry, SourceAnchor } from "@codebase-tutor/domain";

import { cppExtensionPattern, handledExtensions } from "./language-extensions.js";
import { detectJavaEntrypoints } from "./java-entrypoints.js";
import { detectNodeEntrypoints } from "./node-entrypoints.js";
import { detectPythonEntrypoints } from "./python-entrypoints.js";
import { isTestPath } from "./roles.js";

export function detectEntrypoints(repositoryPath: string, files: FileEntry[], contents: Map<string, string>): SourceAnchor[] {
  // Spring 仓的入口只写在注解里，常规规则（package.json、惯用文件名）一条都碰不到；注解命中优先入列
  const java = detectJavaEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  // Go/Rust/C/C# 的 main 函数与 Java 注解同级：确定的启动点，不是文件名猜测
  const mains = detectMainFunctionEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  // Python 同理：框架约定（Flask/FastAPI/Django）与脚本守卫都是确定的启动点，命中即取代按文件名猜的那条
  const python = detectPythonEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  // Node/TS 的框架入口（Express/Fastify/Koa/Nest）：同一类服务级证据
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
    } catch { /* A malformed package file is not fatal to import. */ }
  }
  for (const file of files) {
    // 只在这文件进得了依赖图的语言里认约定名：`files` 是索引清单，里面还有 .md/.json/.yml。
    // 不筛的话 `docs/index.md`、`config/app.json` 会顶着「conventional entrypoint」进入口清单，
    // 而入口清单进 `classifyFileRoles`（它把文件抬成 core）又进流程 digest，等于让流程从一份 Markdown 讲起。
    if (!handledExtensions.has(file.extension)) continue;
    const name = basename(file.path, extname(file.path)).toLowerCase();
    if (["main", "server", "app", "index", "cli", "manage"].includes(name)) candidates.set(file.path, "conventional entrypoint");
  }
  // 测试夹具里的 main.py / index.js 不是真入口（package.json 的 scripts 会指进去）——
  // 与结构角色用同一套测试路径判定，把这类候选剔除。
  // 注解命中的入口是权威清单（每一个都对应真实的路由/启动点），不能沿用弱启发式的 12 截断；
  // 给宽上限只为兜底极端仓。
  const conventional = [...candidates.entries()]
    .filter(([path]) => !isTestPath(path) && !authoritativePaths.has(path) && files.some((file) => file.path === path))
    .map(([path, label]) => ({ path, line: 1, label }));
  return [...java.slice(0, 60), ...mains.slice(0, 60), ...python.slice(0, 60), ...node.slice(0, 60), ...conventional.slice(0, 12)];
}

/**
 * Go/Rust/C/C# 的主函数约定：每个文件只取首个命中，锚点落在声明行。
 * 与 Java 注解同按「权威入口」对待——这是启动点的确定性证据，不是文件名猜测。
 */
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

/**
  这个入口锚点是不是「外部会打到它」那一类：HTTP 路由/路由表/服务启动，或框架启动类。
  `脚本主入口`（Python 的 `if __name__ == "__main__"`）与 `Go/Rust/C/C++/C# 主函数` 都不算——
  它们只说明「这个文件能自己跑」，不说明它在执行流里的位置；把一份自动加载的运维脚本当入口，
  会把它所在的整个模块抬成主干。
  已知残留：整个仓就是一个 CLI（只靠 `main`）拿不到这条特权，只能靠模块占比那一档。
  按标签判而不是给 `SourceAnchor` 加 `trigger`（http | binary | script）字段：
  加字段会进流程 digest、触发全部流程重算；标签字符串就是本文件产的那几个，两边同源。
*/
export function isServedEntrypoint(anchor: SourceAnchor): boolean {
  return /HTTP|启动类/.test(anchor.label ?? "");
}
