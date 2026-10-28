import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CallEdge, FileEntry, RepositoryAnalysis, SymbolInfo } from "@codebase-tutor/domain";

import { indexRepository } from "../../src/indexer/indexer.js";
import { buildDependencyGraph, serializeGraph } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";

/**
  符号级调用边差值脚本，与一份确定性参照对齐；只读、零 token。
  参照口径是下界：显式类型名作接收者、该类型在发起文件可见、发起文件声明同名方法。
  用法：`pnpm calls:diff [仓库路径]`（文件级 import 差值由 `pnpm graph:diff` 量）
*/

const repositoryPath = resolve(process.argv.slice(2).find((value) => !value.startsWith("-")) ?? "");
if (!repositoryPath) {
  console.log("用法：pnpm calls:diff <仓库路径>（目前只出 Java 档）");
  process.exit(1);
}
const index = indexRepository(repositoryPath);
const javaFiles = index.files.filter((file: FileEntry) => file.extension === ".java");
if (!javaFiles.length) {
  console.log(`${repositoryPath}：没有 .java 文件，参照档暂未覆盖该语言`);
  process.exit(0);
}
await loadSymbolParser();
const graph = buildDependencyGraph(repositoryPath, index.files);
const analysis: Pick<RepositoryAnalysis, "graph"> = { graph: serializeGraph(graph) };

const textOf = (path: string): string => readFileSync(join(repositoryPath, path), "utf8");

// 1) 每个文件里声明的方法名，落点按文件计
const methodDeclPattern = /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|default|native|strictfp)\s+)*(?!class|interface|enum|record|if|for|while|switch|catch|return|new|throw|else|do|try|synchronized)([\w<>\[\],.?]+(?:<[^>]*>)?\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws [\w., ]+)?\{?\s*$/;
const methodsByFile = new Map<string, Set<string>>();
const simpleNameOf = (path: string): string => path.split("/").pop()!.replace(/\.java$/, "");
for (const file of javaFiles) {
  const declared = new Set<string>();
  for (const line of textOf(file.path).split("\n")) {
    const match = methodDeclPattern.exec(line);
    if (!match) continue;
    const name = match[2]!;
    // 构造器不算被调用的方法名
    if (name === simpleNameOf(file.path)) continue;
    declared.add(name);
  }
  methodsByFile.set(file.path, declared);
}

// 2) 类型可见性：直接 import + 通配 import（按源码根收窄）+ 同包
const sourceRootOf = (path: string): string => {
  const match = /(^|\/)src\/(main|test)\//.exec(path);
  return match ? `${path.slice(0, match.index)}src/${match[2]}` : path;
};
const packageOf = new Map<string, string>();
const typeByFqn = new Map<string, string>();
for (const file of javaFiles) {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(textOf(file.path))?.[1];
  if (!pkg) continue;
  packageOf.set(file.path, pkg);
  typeByFqn.set(`${pkg}.${simpleNameOf(file.path)}`, file.path);
}
const byPackage = new Map<string, string[]>();
for (const [path, pkg] of packageOf) {
  const list = byPackage.get(pkg);
  if (list) list.push(path);
  else byPackage.set(pkg, [path]);
}
function visibleTypesOf(path: string): Map<string, string> {
  const visible = new Map<string, string>();
  const add = (target: string): void => {
    if (target === path) return;
    visible.set(simpleNameOf(target), target);
  };
  const content = textOf(path);
  for (const line of content.split("\n")) {
    const match = /^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?\s*;/.exec(line);
    if (!match) continue;
    if (match[2]) {
      for (const sibling of byPackage.get(match[1]!) ?? []) {
        if (sourceRootOf(sibling) === sourceRootOf(path)) add(sibling);
      }
      continue;
    }
    const direct = typeByFqn.get(match[1]!) ?? typeByFqn.get(match[1]!.split(".").slice(0, -1).join("."));
    if (direct) add(direct);
  }
  // 同包类型不需要 import 也可见
  for (const sibling of byPackage.get(packageOf.get(path) ?? "") ?? []) {
    if (sourceRootOf(sibling) === sourceRootOf(path)) add(sibling);
  }
  return visible;
}

// 3) 参照边：显式 `Type.method(` 且该类型可见、该方法在其文件里声明
interface RefEdge { caller: string; callee: string; method: string; samePackage: boolean }
const reference: RefEdge[] = [];
for (const file of javaFiles) {
  const visible = visibleTypesOf(file.path);
  if (!visible.size) continue;
  const content = textOf(file.path).replace(/^[ \t]*import[ \t][^\n]*$/gm, "");
  const seen = new Set<string>();
  for (const match of content.matchAll(/\b([A-Z][\w$]*)\s*\.\s*([a-z_$][\w$]*)\s*\(/g)) {
    const receiver = match[1]!, method = match[2]!;
    const target = visible.get(receiver);
    if (!target) continue;
    if (!(methodsByFile.get(target)?.has(method) ?? false)) continue;
    const key = `${target}:${method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reference.push({ caller: file.path, callee: target, method, samePackage: packageOf.get(file.path) === packageOf.get(target) });
  }
}

// 4) 引擎跨文件调用边，归到同一粒度（文件名 + 被调方法名）
const symbolName = new Map<string, string>(graph.symbols.map((symbol: SymbolInfo) => [symbol.id, symbol.name]));
const engine = new Set<string>();
for (const call of analysis.graph.calls as CallEdge[]) {
  if (call.callerPath === call.calleePath) continue;
  const name = call.calleeSymbol ? symbolName.get(call.calleeSymbol) : undefined;
  if (!name) continue;
  engine.add(`${call.callerPath}→${call.calleePath}:${name}`);
}
const referenceKeys = new Map<string, RefEdge>(reference.map((edge) => [`${edge.caller}→${edge.callee}:${edge.method}`, edge]));
const both = [...referenceKeys.keys()].filter((key) => engine.has(key));
const onlyReference = [...referenceKeys.keys()].filter((key) => !engine.has(key));
const unconfirmed = [...engine].filter((key) => !referenceKeys.has(key));
const samePackageMisses = onlyReference.filter((key) => referenceKeys.get(key)?.samePackage);
const crossPackageMisses = onlyReference.filter((key) => !referenceKeys.get(key)?.samePackage);
const shortKey = (key: string): string => key.replace(/[^→:]*\//g, "").replace(/\.java/g, "");
const pct = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");

console.log(`# 符号级调用边差值（参照为下界：只认 Type.method( 且类型可见、方法声明在同文件）｜${repositoryPath}`);
console.log(`- 参照边（按 文件→文件:方法名 去重）：${referenceKeys.size}｜引擎跨文件调用边：${engine.size}｜交集：${both.length}`);
console.log(`- 参照有、引擎没有 ${onlyReference.length} 条（同包 ${samePackageMisses.length}／跨包 ${crossPackageMisses.length}）⇒ 这是可以断定的漏配`);
console.log(`  例：${onlyReference.slice(0, 5).map(shortKey).join("、") || "—"}`);
console.log(`- 引擎有、参照确认不了 ${unconfirmed.length} 条（占引擎 ${pct(unconfirmed.length, engine.size)}）：变量接收者、继承与接口分派都在下界之外，不能当假阳性引用`);
console.log(`  例：${unconfirmed.slice(0, 5).map(shortKey).join("、") || "—"}`);
