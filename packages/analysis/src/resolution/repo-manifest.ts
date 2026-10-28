import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import type { FileEntry } from "@codebase-tutor/domain";

import { slash } from "./repo-paths.js";

export interface WorkspacePackage {
  dir: string;
  main?: string;
}

/** tsconfig `paths` 的一条通配别名：`"@/*": ["src/*"]` → `{ prefix: "@/", dirs: ["src"] }`。 */
export interface PathAlias {
  prefix: string;
  dirs: string[];
}

/** 去掉 JSONC 的注释与尾逗号，按字符扫描以避开字符串内的 `//`。 */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (char === "\\") { out += source[index + 1] ?? ""; index += 1; }
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === ",") {
      let ahead = index + 1;
      while (ahead < source.length && /\s/.test(source[ahead])) ahead += 1;
      if (source[ahead] === "}" || source[ahead] === "]") continue;
    }
    out += char;
  }
  return out;
}

/** 根 tsconfig 的 `baseUrl` + `paths` 转别名前缀表，只收通配条目。 */
export function collectPathAliases(repositoryPath: string): PathAlias[] {
  const manifest = join(repositoryPath, "tsconfig.json");
  if (!existsSync(manifest)) return [];
  try {
    const raw = JSON.parse(stripJsonComments(readFileSync(manifest, "utf8"))) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> } };
    const paths = raw.compilerOptions?.paths;
    if (!paths) return [];
    const base = typeof raw.compilerOptions?.baseUrl === "string" ? raw.compilerOptions.baseUrl : ".";
    const aliases: PathAlias[] = [];
    for (const [key, value] of Object.entries(paths)) {
      if (!key.endsWith("*") || !Array.isArray(value)) continue;
      const prefix = key.slice(0, -1);
      const dirs = (value as unknown[]).flatMap((item): string[] => (typeof item === "string" ? [slash(normalize(join(base, item.slice(0, -1))))] : []));
      if (prefix && dirs.length) aliases.push({ prefix, dirs });
    }
    return aliases;
  } catch { /* A malformed tsconfig is not fatal to import. */ }
  return [];
}

/** 各 package.json 的 name 到包目录与入口，供裸说明符解析。 */
export function collectWorkspacePackages(repositoryPath: string, files: FileEntry[]): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const file of files) {
    if (basename(file.path) !== "package.json") continue;
    try {
      const pkg = JSON.parse(readFileSync(join(repositoryPath, file.path), "utf8")) as { name?: string; main?: string };
      if (typeof pkg.name === "string" && pkg.name) {
        packages.set(pkg.name, { dir: dirname(file.path), main: typeof pkg.main === "string" ? pkg.main.replace(/^\.\//, "") : undefined });
      }
    } catch { /* A malformed package file is not fatal to import. */ }
  }
  return packages;
}

