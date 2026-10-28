import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileEntry, RepositoryIndex } from "@codebase-tutor/domain";

import { indexRepository } from "../../src/indexer/indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";

/**
  编译器级精确模块图与静态启发式取图的边差对照，只作评测证据。
  Java 按 package 声明与顶层类型名推全限定名；TS/TSX 用 typescript 的 `resolveModuleName`。
  口径：只比两侧都索引的仓内文件，通配展开取上界，三方与 JDK import 不计。用法：`pnpm graph:diff [仓库路径]`
*/

const here = dirname(fileURLToPath(import.meta.url));
const repositoryPath = resolve(process.argv.slice(2).find((value) => !value.startsWith("-")) ?? resolve(here, "..", "..", "..", ".."));
const index: RepositoryIndex = indexRepository(repositoryPath);
// 与产品同一条取图路径：先装语法解析器。
await loadSymbolParser();
const graph = buildDependencyGraph(repositoryPath, index.files);

const edgeKey = (from: string, to: string): string => `${from}→${to}`;
const pct = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");
const incomingOf = (table: Map<string, Set<string>>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const list of table.values()) for (const to of list) counts.set(to, (counts.get(to) ?? 0) + 1);
  return counts;
};

const heuristic = new Map<string, Set<string>>();
for (const [from, list] of graph.imports) heuristic.set(from, new Set(list));

function report(title: string, nodes: Set<string>, precise: Map<string, Set<string>>): void {
  const collect = (table: Map<string, Set<string>>): Set<string> => {
    const all = new Set<string>();
    for (const [from, list] of table) {
      if (!nodes.has(from)) continue;
      for (const to of list) if (nodes.has(to) && to !== from) all.add(edgeKey(from, to));
    }
    return all;
  };
  const preciseEdges = collect(precise);
  const heuristicEdges = collect(new Map([...heuristic].filter(([from]) => nodes.has(from))));
  const shared = [...preciseEdges].filter((edge) => heuristicEdges.has(edge));
  const onlyPrecise = [...preciseEdges].filter((edge) => !heuristicEdges.has(edge));
  const onlyHeuristic = [...heuristicEdges].filter((edge) => !preciseEdges.has(edge));
  const preciseIn = incomingOf(precise);
  const heuristicIn = incomingOf(heuristic);
  const isolated = (table: Map<string, Set<string>>, counts: Map<string, number>): string[] =>
    [...nodes].filter((path) => (table.get(path)?.size ?? 0) === 0 && (counts.get(path) ?? 0) === 0);
  const isolatedPrecise = isolated(precise, preciseIn);
  const isolatedHeuristic = isolated(heuristic, heuristicIn);
  const entries = graph.entrypoints.map((item) => item.path).filter((path) => nodes.has(path));
  const entryReal = entries.filter((path) => (preciseIn.get(path) ?? 0) === 0);
  const extraIsolated = isolatedHeuristic.filter((path) => !isolatedPrecise.includes(path));

  console.log(`\n## ${title}`);
  console.log(`- 可比节点（两侧都索引的文件）：${nodes.size} 个`);
  console.log(`- 边：精确 ${preciseEdges.size}｜引擎 ${heuristicEdges.size}｜交集 ${shared.length}`);
  console.log(`  - 引擎边的精度（能被精确档复核）：${pct(shared.length, heuristicEdges.size)}（${shared.length}/${heuristicEdges.size}）`);
  console.log(`  - 引擎边的召回（精确档的边被引擎抓到）：${pct(shared.length, preciseEdges.size)}（${shared.length}/${preciseEdges.size}）`);
  console.log(`  - 精确有、引擎没有 ${onlyPrecise.length} 条（上界，见文件头口径纪律）：${onlyPrecise.slice(0, 4).map((edge) => edge.split("→")[1]).join("、") || "—"}`);
  console.log(`  - 引擎有、精确没有 ${onlyHeuristic.length} 条：${onlyHeuristic.slice(0, 4).join("、") || "—"}`);
  console.log(`- 孤立文件（无进无出）：精确 ${isolatedPrecise.length}｜引擎 ${isolatedHeuristic.length}；引擎多报 ${extraIsolated.length} 个：${extraIsolated.slice(0, 3).join("、") || "—"}`);
  console.log(`- 入口判定：引擎标 ${entries.length} 个，精确档里真无入边的 ${entryReal.length}（${pct(entryReal.length, entries.length)}）`);
}

// ---------- Java 档 ----------
const javaFiles = index.files.filter((file: FileEntry) => file.extension === ".java");
if (javaFiles.length) {
  const fqnToPath = new Map<string, string>();
  const packageOf = new Map<string, string>();
  const typePattern = /^\s*(?:(?:public|protected|private|final|abstract|static|sealed|non-sealed)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/gm;
  for (const file of javaFiles) {
    const content = readFileSync(join(repositoryPath, file.path), "utf8");
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1];
    if (!pkg) continue;
    packageOf.set(file.path, pkg);
    const names = new Set<string>([file.path.split("/").pop()!.replace(/\.java$/, "")]);
    for (const match of content.matchAll(typePattern)) names.add(match[1]!);
    for (const name of names) {
      const fqn = `${pkg}.${name}`;
      if (!fqnToPath.has(fqn)) fqnToPath.set(fqn, file.path);
    }
  }
  const precise = new Map<string, Set<string>>();
  let wildcards = 0;
  /** 通配展开按源码根收窄，主源码根与测试源码根分开。 */
  const sourceRootOf = (path: string): string => {
    const match = /(^|\/)src\/(main|test)\//.exec(path);
    return match ? `${path.slice(0, match.index)}src/${match[2]}` : path;
  };
  const typesByPackage = new Map<string, { path: string; simpleName: string; root: string }[]>();
  for (const [fqn, path] of fqnToPath) {
    const dot = fqn.lastIndexOf(".");
    const list = typesByPackage.get(fqn.slice(0, dot));
    const item = { path, simpleName: fqn.slice(dot + 1), root: sourceRootOf(path) };
    if (list) list.push(item);
    else typesByPackage.set(fqn.slice(0, dot), [item]);
  }
  for (const file of javaFiles) {
    const content = readFileSync(join(repositoryPath, file.path), "utf8");
    const targets = new Set<string>();
    precise.set(file.path, targets);
    for (const line of content.split("\n")) {
      const match = /^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?\s*;/.exec(line);
      if (!match) continue;
      const qualified = match[1]!;
      if (match[2]) {
        wildcards += 1;
        for (const item of typesByPackage.get(qualified) ?? []) {
          if (item.root === sourceRootOf(file.path) && item.path !== file.path) targets.add(item.path);
        }
        continue;
      }
      const direct = fqnToPath.get(qualified) ?? fqnToPath.get(qualified.split(".").slice(0, -1).join("."));
      if (direct && direct !== file.path) targets.add(direct);
    }
  }
  report(`Java 档（${javaFiles.length} 个 .java；仓内通配 import ${wildcards} 处）`, new Set(javaFiles.map((file: FileEntry) => file.path)), precise);
}

// ---------- TS 档 ----------
const tsFiles = index.files.filter((file: FileEntry) => [".ts", ".tsx"].includes(file.extension));
if (tsFiles.length) {
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  const configPaths: string[] = [];
  const rootConfig = ts.findConfigFile(repositoryPath, ts.sys.fileExists, "tsconfig.json");
  if (rootConfig) configPaths.push(rootConfig);
  // 根上没有 tsconfig 时按 packages/*/tsconfig.json 补齐。
  else if (existsSync(join(repositoryPath, "packages"))) {
    for (const entry of readdirSync(join(repositoryPath, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(repositoryPath, "packages", entry.name, "tsconfig.json");
      if (existsSync(candidate)) configPaths.push(candidate);
    }
  }
  if (!configPaths.length) console.log(`\n## TS 档：找不到任何 tsconfig.json，跳过（精确档没有编译口径，不做近似）`);
  const runTsMode = (configPath: string): void => {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(resolve(configPath)));
    const relOf = (path: string | undefined): string | undefined => {
      if (!path || path.includes("node_modules")) return undefined;
      const rel = relative(repositoryPath, path.split(/[\\/]/).join("/"));
      return rel.startsWith("..") ? undefined : rel;
    };
    const precise = new Map<string, Set<string>>();
    for (const fileName of parsed.fileNames) {
      const from = relOf(fileName);
      if (!from) continue;
      const targets = precise.get(from) ?? new Set<string>();
      precise.set(from, targets);
      let source;
      try {
        source = ts.createSourceFile(fileName, readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, true);
      } catch {
        continue;
      }
      const specifiers: string[] = [];
      const walk = (node: import("typescript").Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
        else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) && ["require", "import"].includes(node.expression.getText(source))) specifiers.push(node.arguments[0].text);
        ts.forEachChild(node, walk);
      };
      walk(source);
      for (const specifier of specifiers) {
        const hit = ts.resolveModuleName(specifier, fileName, parsed.options, ts.sys).resolvedModule;
        const to = relOf(hit?.resolvedFileName);
        if (to && to !== from) targets.add(to);
      }
    }
    report(`TS 档（tsconfig 收录 ${precise.size} 个文件，仓内 .ts/.tsx 共 ${tsFiles.length} 个｜${relative(process.cwd(), configPath)}）`, new Set(precise.keys()), precise);
  };
  for (const configPath of configPaths) runTsMode(configPath);
}
console.log(`\n仓库：\`${repositoryPath}\`｜引擎索引 ${index.files.length} 文件、静态档 ${heuristic.size} 个节点有出边记录`);
