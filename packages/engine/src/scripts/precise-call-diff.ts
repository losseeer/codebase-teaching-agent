import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CallEdge, FileEntry, RepositoryAnalysis, SymbolInfo } from "@codebase-tutor/shared";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, serializeGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";

/**
  L2 校验通道的第二格：**符号级调用边**的差值（文件级 import 差值已由 `pnpm graph:diff` 量过，见 §32/§33）。
  要回答的问题：引擎那条「按方法名 + 已导入文件」配调用边的规则，值不值得升级成 L1 的接收者类型消歧——
  这需要一个独立参照，而且参照必须**宁可少报也不能错报**，否则差值就是噪声。

  参照口径（故意保守，是**下界**）：只认「显式以类型名作接收者」的调用 `Type.method(...)`，并且要求
  ① 该 `Type` 在发起文件里可见（直接 import、通配 import 的整包、或**同包**——Java 同包不需要 import，
  这条引擎现在完全没有）；② 该 `Type` 所在文件里确实声明了同名方法（跳过构造器与关键字）。
  于是两条读法不对称，别混着说：
  - **参照有、引擎没有** ⇒ 引擎确实漏了（这是可以拿去修 L1 的靶子）。
  - **引擎有、参照没有** ⇒ 只是「这条规则确认不了」，因为通过变量/接口/继承的调用本来就不在下界里，
    **不能当成假阳性引用**。要判假阳性得另建证据，别用这一格。

  零 token、零新依赖、只读被分析仓。用法：pnpm calls:diff [仓库路径]
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

// 1) 每个文件里**声明**的方法名（含包内私有类的方法都算在这个文件上，因为落点就是文件）
const methodDeclPattern = /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|default|native|strictfp)\s+)*(?!class|interface|enum|record|if|for|while|switch|catch|return|new|throw|else|do|try|synchronized)([\w<>\[\],.?]+(?:<[^>]*>)?\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws [\w., ]+)?\{?\s*$/;
const methodsByFile = new Map<string, Set<string>>();
const simpleNameOf = (path: string): string => path.split("/").pop()!.replace(/\.java$/, "");
for (const file of javaFiles) {
  const declared = new Set<string>();
  for (const line of textOf(file.path).split("\n")) {
    const match = methodDeclPattern.exec(line);
    if (!match) continue;
    const name = match[2]!;
    if (name === simpleNameOf(file.path)) continue; // 构造器不算「被调用的方法名」
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
  // 同包可见（Java 不需要 import）——这是引擎目前完全没有的一路
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
// 「参照有、引擎没有」按成因拆两类：同包调用（引擎压根没有这一路）vs 跨包（通配落点之外的漏配）
const samePackageMisses = onlyReference.filter((key) => referenceKeys.get(key)?.samePackage);
const crossPackageMisses = onlyReference.filter((key) => !referenceKeys.get(key)?.samePackage);
const shortKey = (key: string): string => key.replace(/[^→:]*\//g, "").replace(/\.java/g, "");
const pct = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");

console.log(`# 符号级调用边差值（参照为**下界**：只认 Type.method( 且类型可见、方法声明在同文件）｜${repositoryPath}`);
console.log(`- 参照边（按 文件→文件:方法名 去重）：${referenceKeys.size}｜引擎跨文件调用边：${engine.size}｜交集：${both.length}`);
console.log(`- **参照有、引擎没有 ${onlyReference.length} 条**（同包 ${samePackageMisses.length}／跨包 ${crossPackageMisses.length}）⇒ 这是可以断定的漏配`);
console.log(`  例：${onlyReference.slice(0, 5).map(shortKey).join("、") || "—"}`);
console.log(`- 引擎有、参照确认不了 ${unconfirmed.length} 条（占引擎 ${pct(unconfirmed.length, engine.size)}）：变量接收者、继承与接口分派都在下界之外，**别当假阳性引用**`);
console.log(`  例：${unconfirmed.slice(0, 5).map(shortKey).join("、") || "—"}`);
