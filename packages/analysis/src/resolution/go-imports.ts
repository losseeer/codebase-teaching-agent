import { readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import type { FileEntry } from "@codebase-tutor/domain";

import { slash } from "./repo-paths.js";

/** Go 的 import 指向包目录：go.mod 的 `module` 前缀划仓内边界，命中后落该目录下全部非测试 .go 文件。 */
export function collectGoModules(repositoryPath: string, files: FileEntry[]): Map<string, string> {
  const modules = new Map<string, string>();
  for (const file of files) {
    if (basename(file.path) !== "go.mod") continue;
    try {
      const match = readFileSync(join(repositoryPath, file.path), "utf8").match(/^module\s+(\S+)/m);
      if (match) modules.set(match[1], dirname(file.path));
    } catch { /* A malformed go.mod is not fatal to import. */ }
  }
  return modules;
}

export function collectGoFiles(files: FileEntry[]): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    if (file.extension !== ".go" || file.path.endsWith("_test.go")) continue;
    const dir = dirname(file.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), file.path]);
  }
  return byDir;
}

/** Go 的 import 两种形态：`import "x"`（可带别名）与 `import ( … )` 分组块。 */
export function extractGoSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let inBlock = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!inBlock) {
      const single = trimmed.match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"$/);
      if (single) specifiers.push(single[1]);
      if (/^import\s*\($/.test(trimmed)) inBlock = true;
      continue;
    }
    if (trimmed === ")") {
      inBlock = false;
      continue;
    }
    const item = trimmed.match(/^(?:[\w.]+\s+)?"([^"]+)"$/);
    if (item) specifiers.push(item[1]);
  }
  return specifiers;
}

export function resolveGoImport(specifier: string, goModules: Map<string, string>, goFilesByDir: Map<string, string[]>): string[] {
  for (const [name, dir] of goModules) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const rest = specifier.slice(name.length).replace(/^\//, "");
    return goFilesByDir.get(slash(normalize(join(dir, rest)))) ?? [];
  }
  return [];
}

