import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileEntry, RepositoryIndex } from "@codebase-tutor/shared";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";

/**
  A1（业界潮流第 3 项的前半）：**编译器级精确模块图只当评测证据**，引擎运行时一行都不读它。
  要回答的问题只有一个：引擎那套静态启发式离「编译器自己怎么解析 import」差多少——
  差得大才值得做 A2（在引擎里维护第二条取图路径），差得小就说明缺口是某条具体规则，不是工具链级别的事。

  两种语言各用「不依赖构建」的确定性事实当精确档：
  - **Java**：JLS 规定 `package` 声明 + 顶层类型名就足以确定仓内全限定名的落点（javac 解析 import 用的正是这份事实），
    所以不需要 gradle/maven，零依赖、零 token、纯 CPU。
  - **TS/TSX**：直接调用 `typescript` 包自己的解析器 `resolveModuleName`（尊重 tsconfig 的 paths 别名与扩展名规则），
    这是 tsc 判定模块边的同一套代码。`typescript` 只是仓库自带的 devDependency，不新增依赖。

  口径纪律（不然读数会骗人）：
  - 只比**两侧都认识的仓内文件**，否则「引擎没索引 .vue」这类覆盖差会被算成边差；
  - 精确图按 JLS 的可见性把 `import a.b.*` 展成该包全部仓内类，这是**上界**（javac 只链接真正被用到的那几个），
    所以「精确有、引擎没有」的条数是差距上限，别当精确值引用；
  - 三方与 JDK 的 import 不构成仓内边，两侧都丢。

  用法：pnpm graph:diff [仓库路径]（缺省 = 本引擎仓，跑 TS 档）
*/

const here = dirname(fileURLToPath(import.meta.url));
const repositoryPath = resolve(process.argv.slice(2).find((value) => !value.startsWith("-")) ?? resolve(here, "..", "..", "..", ".."));
const index: RepositoryIndex = indexRepository(repositoryPath);
// 与产品同一条取图路径：先装语法解析器（AST 档），否则引擎在这里退化成逐行正则，差值就不是「启发式 vs 编译器」了
await loadSymbolParser();
const graph = buildDependencyGraph(repositoryPath, index.files);
const known = new Set(index.files.map((file: FileEntry) => file.path));

const edgeKey = (from: string, to: string): string => `${from}→${to}`;
const pct = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");
const incomingOf = (table: Map<string, Set<string>>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const list of table.values()) for (const to of list) counts.set(to, (counts.get(to) ?? 0) + 1);
  return counts;
};

const heuristic = new Map<string, Set<string>>();
for (const [from, list] of graph.imports) heuristic.set(from, new Set(list));

/** 汇报一张对比表：精确档与引擎档的边集、孤立文件、入口判定三件事。 */
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
  console.log(`  - **引擎边的精度**（能被精确档复核）：${pct(shared.length, heuristicEdges.size)}（${shared.length}/${heuristicEdges.size}）`);
  console.log(`  - **引擎边的召回**（精确档的边被引擎抓到）：${pct(shared.length, preciseEdges.size)}（${shared.length}/${preciseEdges.size}）`);
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
  /**
    通配展开要按**源码根**收窄：Maven 布局下 `src/test/java/com/hmdp/utils/XxxTest.java` 的 package 与
    `src/main/java/com/hmdp/utils/` 完全同名，但主源码在编译期看不见测试源码根。参考档如果把测试类也算进
    `com.hmdp.utils.*`，就会造出十几次 javac 永远不会产生的边——那 10 条曾经被读成「引擎漏了 10 条边」。
    */
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
  // monorepo：根上常常没有 tsconfig，各包自己有一份——按 packages/*/tsconfig.json 补齐，否则 TS 档整段没读数
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
