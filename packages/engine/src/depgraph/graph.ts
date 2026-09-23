import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, normalize } from "node:path";
import type { CallEdge, DependencyGraphData, FileEntry, ImpactResult, SourceAnchor, SymbolInfo } from "@codebase-tutor/shared";
import { extractSymbolsFromAst, parseBackendStatus, type ParseBackendStatus } from "./parser.js";
import { isTestPath } from "./roles.js";

export interface DependencyGraph {
  imports: Map<string, string[]>;
  calls: CallEdge[];
  symbols: SymbolInfo[];
  entrypoints: SourceAnchor[];
  semanticBackend: "lsp" | "static";
  lspStatus: DependencyGraphData["lspStatus"];
  /** 符号抽取走的哪条路（`ast` 准确 / `regex` 回落）；回落原因见 `parseBackendReason`。 */
  parseBackend: ParseBackendStatus["backend"];
  parseBackendReason?: string;
}

const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"];
/** C/C++ 一族的扩展名（cpp 语法同时覆盖纯 C）。 */
const cppExtensionPattern = /\.(c|h|cc|cpp|cxx|hpp|hh)$/;
const ignoredCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "require", "import"]);
/** TS/JS 的说明符一律带引号；Python 与 Java 的 import 没有引号，各走 extractPythonSpecifiers / extractJavaSpecifiers。 */
const tsSpecifierPattern = /(?:from\s+|import\s*\(?\s*|require\s*\()\s*["']([^"']+)["']/g;

/**
 * Produces an import graph plus project-local call graph. The static analyzer is
 * deliberately complete enough for the fallback path; LSP availability is surfaced
 * separately so callers never mistake a degraded result for semantic certainty.
 */
export function buildDependencyGraph(repositoryPath: string, files: FileEntry[]): DependencyGraph {
  const available = new Set(files.map((file) => file.path));
  const packages = collectWorkspacePackages(repositoryPath, files);
  const symbols: SymbolInfo[] = [];
  const contents = new Map<string, string>();
  for (const file of files) {
    if (!extensions.includes(file.extension)) continue;
    const content = readFileSync(join(repositoryPath, file.path), "utf8");
    contents.set(file.path, content);
    symbols.push(...extractSymbols(file.path, content));
  }
  // Java 的 import 指向「全限定类名」、Go 的 import 指向「包目录」、C# 的 using 指向「命名空间」，
  // 都要先建全仓索引才能落点，故内容先读全再解析依赖
  const javaTypes = collectJavaTypes(contents);
  const goModules = collectGoModules(repositoryPath, files);
  const goFilesByDir = collectGoFiles(files);
  const csNamespaces = collectCSharpNamespaces(contents);
  const imports = new Map<string, string[]>();
  for (const [path, content] of contents) {
    imports.set(path, resolveFileImports(path, content, { available, packages, javaTypes, goModules, goFilesByDir, csNamespaces }));
  }
  const calls = extractCalls(contents, symbols, imports);
  const lspStatus = detectLspStatus(files);
  const parseStatus = parseBackendStatus();
  return {
    imports,
    calls,
    symbols,
    entrypoints: detectEntrypoints(repositoryPath, files, contents),
    semanticBackend: lspStatus.some((item) => item.status === "available") ? "lsp" : "static",
    lspStatus,
    parseBackend: parseStatus.backend,
    ...(parseStatus.reason ? { parseBackendReason: parseStatus.reason } : {})
  };
}

export function serializeGraph(graph: DependencyGraph): DependencyGraphData {
  return {
    imports: Object.fromEntries([...graph.imports.entries()]),
    calls: graph.calls,
    symbols: graph.symbols,
    entrypoints: graph.entrypoints,
    semanticBackend: graph.semanticBackend,
    lspStatus: graph.lspStatus,
    parseBackend: graph.parseBackend,
    ...(graph.parseBackendReason ? { parseBackendReason: graph.parseBackendReason } : {})
  };
}

export function impactRadius(graph: DependencyGraph, changedPaths: string[]): ImpactResult {
  const reverse = new Map<string, { from: string; kind: "import" | "call" }[]>();
  for (const [from, targets] of graph.imports) {
    for (const to of targets) reverse.set(to, [...(reverse.get(to) ?? []), { from, kind: "import" }]);
  }
  for (const call of graph.calls) {
    reverse.set(call.calleePath, [...(reverse.get(call.calleePath) ?? []), { from: call.callerPath, kind: "call" }]);
  }
  const impacted = new Set(changedPaths);
  const pending = [...changedPaths];
  const edges: ImpactResult["edges"] = [];
  while (pending.length) {
    const target = pending.shift()!;
    for (const edge of reverse.get(target) ?? []) {
      edges.push({ from: edge.from, to: target, kind: edge.kind });
      if (!impacted.has(edge.from)) {
        impacted.add(edge.from);
        pending.push(edge.from);
      }
    }
  }
  return { changedPaths, impactedPaths: [...impacted].sort(), edges };
}

export function graphFromData(data: DependencyGraphData): DependencyGraph {
  return {
    imports: new Map(Object.entries(data.imports)),
    calls: data.calls,
    symbols: data.symbols,
    entrypoints: data.entrypoints,
    semanticBackend: data.semanticBackend,
    lspStatus: data.lspStatus,
    // 旧数据没有该字段（那时只有逐行匹配一条路），按 regex 认，别假装是语法树结果
    parseBackend: data.parseBackend ?? "regex",
    ...(data.parseBackendReason ? { parseBackendReason: data.parseBackendReason } : {})
  };
}

/**
  符号抽取：优先语法树；解析器未就绪或该扩展名没有语法时回落逐行匹配。
  两条路都给同一份 `SymbolInfo` 结构，`endLine` 都是「最后一行（含）」。
*/
function extractSymbols(path: string, content: string): SymbolInfo[] {
  return extractSymbolsFromAst(path, content) ?? extractSymbolsWithRegex(path, content);
}

function extractSymbolsWithRegex(path: string, content: string): SymbolInfo[] {
  const language = path.endsWith(".py") ? "python" : /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path) ? "typescript" : "other";
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = language === "python"
      ? line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/)
      : line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>|^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (!match) continue;
    const name = match[1] ?? match[3] ?? match[5];
    const rawParameters = match[2] ?? match[4] ?? "";
    const kind: SymbolInfo["kind"] = match[5] ? "class" : "function";
    symbols.push({ id: `symbol:${path}:${name}:${index + 1}`, name, kind, path, line: index + 1, endLine: findEndLine(lines, index, language), parameters: rawParameters.split(",").map((value) => value.trim()).filter(Boolean), language });
  }
  return symbols;
}

function findEndLine(lines: string[], start: number, language: SymbolInfo["language"]): number {
  if (language === "python") {
    const indentation = lines[start].match(/^\s*/)?.[0].length ?? 0;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index].trim() && (lines[index].match(/^\s*/)?.[0].length ?? 0) <= indentation) return index;
    }
    return lines.length;
  }
  let balance = 0;
  for (let index = start; index < Math.min(lines.length, start + 200); index += 1) {
    balance += (lines[index].match(/{/g) ?? []).length - (lines[index].match(/}/g) ?? []).length;
    if (index > start && balance <= 0) return index + 1;
  }
  return Math.min(lines.length, start + 1);
}

function extractCalls(contents: Map<string, string>, symbols: SymbolInfo[], imports: Map<string, string[]>): CallEdge[] {
  const byName = new Map<string, SymbolInfo[]>();
  for (const symbol of symbols) byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol]);
  const edges: CallEdge[] = [];
  for (const [path, content] of contents) {
    const localSymbols = symbols.filter((symbol) => symbol.path === path);
    const imported = new Set(imports.get(path) ?? []);
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?(?:const|let|var)\b.*=>|^\s*(?:async\s+)?def\b|^\s*func\b|^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:unsafe\s+)?(?:async\s+)?fn\b/.test(line)) continue;
      // Java 方法/构造器声明行也含「名字(」——不跳过会产生自我调用边
      if (/^\s*(?:@\w+\s*)?(?:(?:public|private|protected|static|final|abstract|synchronized|default|native)\s+)+[\w<>\[\],.?\s]+\(/.test(line)) continue;
      for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = match[1];
        if (ignoredCalls.has(name)) continue;
        const candidates = byName.get(name) ?? [];
        const target = candidates.find((symbol) => symbol.path === path) ?? candidates.find((symbol) => imported.has(symbol.path));
        if (!target) continue;
        const caller = [...localSymbols].reverse().find((symbol) => symbol.line <= index + 1 && symbol.endLine >= index + 1);
        edges.push({ callerPath: path, callerSymbol: caller?.id, calleePath: target.path, calleeSymbol: target.id, line: index + 1 });
      }
    }
  }
  return dedupeCalls(edges);
}

function dedupeCalls(calls: CallEdge[]): CallEdge[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.callerPath}:${call.callerSymbol ?? ""}:${call.calleePath}:${call.calleeSymbol ?? ""}:${call.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Python 的 import 语句不带引号、模块名用点号分隔，需要单独提取：
 * `import a.b as c`、`import a, b`、`from a.b import c`、`from . import c`（相对包）。
 * 第三方模块（fastapi、langgraph）也会被提取出来，最终由 resolvePythonImport 按「仓库内是否存在」过滤。
 */
function extractPythonSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.*)$/);
    if (fromMatch) {
      const module = fromMatch[1];
      specifiers.push(module);
      // `from a.b import c` 里的 c 可能是子模块，也可能是符号名 —— 两种都给出，交由可用性判定
      for (const name of readImportedNames(fromMatch[2])) specifiers.push(module.endsWith(".") ? `${module}${name}` : `${module}.${name}`);
      continue;
    }
    const importMatch = trimmed.match(/^import\s+(.*)$/);
    if (importMatch) specifiers.push(...readImportedNames(importMatch[1]));
  }
  return specifiers;
}

/** 从 `a, b.c as d` 里取出模块名（剥掉别名、括号与行尾注释）。 */
function readImportedNames(raw: string): string[] {
  return raw
    .split("#")[0]
    .split(",")
    .map((item) => item.split(/\s+as\s+/)[0].replace(/^\(+/, "").replace(/\)+$/, "").trim())
    .filter((item) => /^[A-Za-z_][\w.]*$/.test(item));
}

/**
 * Java 的 import 语句：`import com.a.B;`、`import static com.a.B.C;`、`import com.a.*;`。
 * 通配符只取到包名（`.*` 剥掉），静态导入取完整成员路径——两者都由 resolveJavaImport 逐级上溯落点。
 */
function extractJavaSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^import\s+(?:static\s+)?([A-Za-z_]\w*(?:\.\w+)*)(?:\.\*)?\s*;/);
    if (match) specifiers.push(match[1]);
  }
  return specifiers;
}

/** 全仓「全限定类名 → 文件路径」索引：Java 靠 package 声明 + 文件名（public 类名=文件名约定）建这个映射。 */
function collectJavaTypes(contents: Map<string, string>): Map<string, string> {
  const types = new Map<string, string>();
  for (const [path, content] of contents) {
    if (!path.endsWith(".java")) continue;
    const pkg = content.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/m)?.[1];
    if (pkg) types.set(`${pkg}.${basename(path, ".java")}`, path);
  }
  return types;
}

/**
 * 类名精确命中即返回；未命中逐段去掉尾部再试——覆盖静态导入（`a.b.C.member`）与嵌套类（`a.b.C.D`）。
 * 外部依赖（org.springframework、java.util）不会进索引，天然被过滤。
 */
function resolveJavaImport(specifier: string, javaTypes: Map<string, string>): string | undefined {
  let current = specifier;
  for (;;) {
    const hit = javaTypes.get(current);
    if (hit) return hit;
    const cut = current.lastIndexOf(".");
    if (cut < 0) return undefined;
    current = current.slice(0, cut);
  }
}

/** join/normalize 的结果统一成仓库口径的正斜杠路径（win32 下返回反斜杠）。 */
function slash(candidate: string): string {
  return candidate.replaceAll("\\", "/");
}

interface ImportIndex {
  available: Set<string>;
  packages: Map<string, WorkspacePackage>;
  javaTypes: Map<string, string>;
  goModules: Map<string, string>;
  goFilesByDir: Map<string, string[]>;
  csNamespaces: Map<string, string[]>;
}

/** 按语言分派「提取说明符 → 落点」。落不了的（stdlib/第三方/系统头）一律丢弃，图里只留仓内依赖。 */
function resolveFileImports(path: string, content: string, index: ImportIndex): string[] {
  const dedupe = (values: Iterable<string>): string[] => [...new Set(values)];
  const kept = (values: (string | undefined)[]): string[] => dedupe(values.filter((value): value is string => Boolean(value)));
  if (path.endsWith(".py")) return kept(extractPythonSpecifiers(content).map((value) => resolvePythonImport(path, value, index.available)));
  if (path.endsWith(".java")) return kept(extractJavaSpecifiers(content).map((value) => resolveJavaImport(value, index.javaTypes)));
  if (path.endsWith(".go")) return dedupe(extractGoSpecifiers(content).flatMap((value) => resolveGoImport(value, index.goModules, index.goFilesByDir)));
  if (path.endsWith(".rs")) return kept(extractRustSpecifiers(content).map((value) => resolveRustImport(path, value, index.available)));
  if (path.endsWith(".cs")) return kept(extractCSharpSpecifiers(content).flatMap((value) => resolveCSharpImport(value, index.csNamespaces)).filter((value) => value !== path));
  if (cppExtensionPattern.test(path)) return dedupe(extractCppIncludes(content).flatMap((value) => resolveCppInclude(path, value, index.available)).filter((value) => value !== path));
  return kept([...content.matchAll(tsSpecifierPattern)].map((match) => resolveImport(path, match[1], index.available, index.packages)));
}

/**
 * Go 的 import 路径指向「包」（目录）而非文件：go.mod 的 `module X` 前缀决定仓内边界，
 * 命中后落点为该目录下全部非测试 .go —— 依赖粒度本来就是整个包。
 */
function collectGoModules(repositoryPath: string, files: FileEntry[]): Map<string, string> {
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

function collectGoFiles(files: FileEntry[]): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    if (file.extension !== ".go" || file.path.endsWith("_test.go")) continue;
    const dir = dirname(file.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), file.path]);
  }
  return byDir;
}

/** Go 的 import 两种形态：`import "x"`（可带别名）与 `import ( … )` 分组块。 */
function extractGoSpecifiers(content: string): string[] {
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

function resolveGoImport(specifier: string, goModules: Map<string, string>, goFilesByDir: Map<string, string[]>): string[] {
  for (const [name, dir] of goModules) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const rest = specifier.slice(name.length).replace(/^\//, "");
    return goFilesByDir.get(slash(normalize(join(dir, rest)))) ?? [];
  }
  return [];
}

/**
 * Rust 的仓内依赖两种：`mod x;`（声明子模块，对应 x.rs 或 x/mod.rs）与 `use crate::a::b;`。
 * `use x::{c, d}` 取路径前缀即可；外部 crate（`use serde::…`）不经 crate/self/super 打头，天然不落点。
 */
function extractRustSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const modMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/);
    if (modMatch) specifiers.push(`mod:${modMatch[1]}`);
    const useMatch = trimmed.match(/^use\s+(crate|self|super)::([\w:]+)/);
    if (useMatch) specifiers.push(`use:${useMatch[1]}:${useMatch[2]}`);
  }
  return specifiers;
}

function resolveRustImport(from: string, specifier: string, available: Set<string>): string | undefined {
  const dir = dirname(from);
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    return [slash(join(dir, `${name}.rs`)), slash(join(dir, name, "mod.rs"))].find((candidate) => available.has(candidate));
  }
  const rest = specifier.slice(4); // `crate:a::b`
  const originEnd = rest.indexOf(":");
  const origin = rest.slice(0, originEnd);
  const chain = rest.slice(originEnd + 1).replace(/:$/, "").replaceAll("::", "/");
  const base = origin === "crate" ? "src" : origin === "self" ? dir : dirname(dir);
  let current = slash(normalize(join(base, chain)));
  for (;;) {
    const hit = [`${current}.rs`, `${current}/mod.rs`].find((candidate) => available.has(candidate));
    if (hit) return hit;
    const cut = current.lastIndexOf("/");
    if (cut <= 0) return undefined;
    current = current.slice(0, cut);
  }
}

/**
 * C# 的 `using A.B.C;` 指向命名空间而非文件：全仓建「命名空间 → 声明它的文件」索引
 * （块式与文件式 `namespace X;` 都收），逐级去尾命中后连到该命名空间下的全部文件。
 */
function extractCSharpSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^using\s+(?:static\s+)?(?:[\w]+\s*=\s*)?([A-Za-z_][\w.]*);/);
    if (match) specifiers.push(match[1]);
  }
  return specifiers;
}

function collectCSharpNamespaces(contents: Map<string, string>): Map<string, string[]> {
  const byNamespace = new Map<string, string[]>();
  for (const [path, content] of contents) {
    if (!path.endsWith(".cs")) continue;
    for (const match of content.matchAll(/^\s*namespace\s+([A-Za-z_][\w.]*)/gm)) {
      const list = byNamespace.get(match[1]) ?? [];
      if (!list.includes(path)) list.push(path);
      byNamespace.set(match[1], list);
    }
  }
  return byNamespace;
}

function resolveCSharpImport(specifier: string, namespaces: Map<string, string[]>): string[] {
  let current = specifier;
  for (;;) {
    const hit = namespaces.get(current);
    if (hit) return hit;
    const cut = current.lastIndexOf(".");
    if (cut < 0) return [];
    current = current.slice(0, cut);
  }
}

/** 只认 `#include "x.h"`（引号形，项目内头文件）；尖括号是系统/第三方头，直接不收。 */
function extractCppIncludes(content: string): string[] {
  return [...content.matchAll(/^[ \t]*#[ \t]*include[ \t]*"([^"]+)"/gm)].map((match) => match[1]);
}

/** 先按当前文件相对解析（编译器首要规则）；未命中再按全仓路径后缀匹配——include 目录各异，多个命中就全连。 */
function resolveCppInclude(from: string, specifier: string, available: Set<string>): string[] {
  const relative = slash(normalize(join(dirname(from), specifier)));
  if (available.has(relative)) return [relative];
  const suffix = `/${specifier.replaceAll("\\", "/")}`;
  return [...available].filter((candidate) => candidate.endsWith(suffix) && candidate !== from);
}

interface WorkspacePackage {
  dir: string;
  main?: string;
}

/** 收集仓库内各 package.json 的 name → 包目录/入口（monorepo 工作区包，供裸说明符解析）。 */
function collectWorkspacePackages(repositoryPath: string, files: FileEntry[]): Map<string, WorkspacePackage> {
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

/**
 * Python 模块名 → 仓库内文件：绝对导入从仓库根起算（`a.b.c` → `a/b/c.py` 或 `a/b/c/__init__.py`），
 * 相对导入以当前文件所在包为基准（`.` = 当前包，`..` 再上溯一层）。
 */
function resolvePythonImport(from: string, specifier: string, available: Set<string>): string | undefined {
  const level = specifier.match(/^\.+/)?.[0].length ?? 0;
  const relative = specifier.slice(level);
  let base = level > 0 ? dirname(from) : "";
  for (let index = 1; index < level; index += 1) base = dirname(base);
  const module = relative.replaceAll(".", "/");
  const target = [base, module].filter(Boolean).join("/");
  if (!target || target === ".") return undefined;
  return [`${target}.py`, `${target}/__init__.py`].find((candidate) => available.has(candidate));
}

function resolveImport(from: string, specifier: string, available: Set<string>, packages: Map<string, WorkspacePackage>): string | undefined {
  if (from.endsWith(".py")) return resolvePythonImport(from, specifier, available);
  const tryResolve = (candidate: string): string | undefined => {
    const normalized = normalize(candidate).replaceAll("\\", "/");
    const direct = [normalized];
    // TypeScript 的 NodeNext 约定：源码里写 .js/.mjs 等后缀，实际文件可能是 .ts/.tsx/.d.ts
    const extension = extname(normalized);
    if ([".js", ".mjs", ".cjs", ".jsx"].includes(extension)) {
      const stripped = normalized.slice(0, -extension.length);
      direct.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.d.ts`);
    }
    const possibilities = [...direct, ...extensions.map((item) => `${normalized}${item}`), ...extensions.map((item) => `${normalized}/index${item}`)];
    return possibilities.find((value) => available.has(value));
  };
  if (specifier.startsWith(".")) return tryResolve(join(dirname(from), specifier));
  // 裸说明符：只解析仓库内 package.json 声明的工作区包（外部依赖不入图）
  const matched = [...packages.entries()].find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
  if (!matched) return undefined;
  const [name, pkg] = matched;
  if (specifier === name) {
    if (pkg.main) {
      const viaMain = tryResolve(join(pkg.dir, pkg.main));
      if (viaMain) return viaMain;
    }
    return tryResolve(join(pkg.dir, "src/index")) ?? tryResolve(join(pkg.dir, "index"));
  }
  return tryResolve(join(pkg.dir, specifier.slice(name.length + 1)));
}

function detectEntrypoints(repositoryPath: string, files: FileEntry[], contents: Map<string, string>): SourceAnchor[] {
  // Spring 仓的入口只写在注解里，常规规则（package.json、惯用文件名）一条都碰不到；注解命中优先入列
  const java = detectJavaEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  // Go/Rust/C/C# 的 main 函数与 Java 注解同级：确定的启动点，不是文件名猜测
  const mains = detectMainFunctionEntrypoints(contents).filter((anchor) => !isTestPath(anchor.path));
  const javaPaths = new Set([...java, ...mains].map((anchor) => anchor.path));
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
    const name = basename(file.path, extname(file.path)).toLowerCase();
    if (["main", "server", "app", "index", "cli", "manage"].includes(name)) candidates.set(file.path, "conventional entrypoint");
  }
  // 测试夹具里的 main.py / index.js 不是真入口（实测 fixture 仓的 package.json scripts 会指进去）——
  // 与结构角色用同一套测试路径判定，把这类候选剔除。
  // 注解命中的入口是权威清单（每一个都对应真实的路由/启动点），不能沿用弱启发式的 12 截断——
  // 实测 Spring 仓 15 个入口会在 12 处静默丢掉 UserController。给宽上限只为兜底极端仓。
  const conventional = [...candidates.entries()]
    .filter(([path]) => !isTestPath(path) && !javaPaths.has(path) && files.some((file) => file.path === path))
    .map(([path, label]) => ({ path, line: 1, label }));
  return [...java.slice(0, 60), ...mains.slice(0, 60), ...conventional.slice(0, 12)];
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
 * Java/Spring 入口识别：启动类看 @SpringBootApplication，HTTP 路由看 @Controller/@RestController。
 * 锚点落在类声明行（跳过注解块），GUI 跳转直达正文；@ControllerAdvice 不算入口（词边界已排除）。
 */
function detectJavaEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const classDecl = /^\s*(?:(?:public|private|protected|final|abstract|sealed|static)\s+)*(?:class|interface|enum|record)\s+\w+/;
  const boot: SourceAnchor[] = [];
  const controllers: SourceAnchor[] = [];
  for (const [path, content] of contents) {
    if (!path.endsWith(".java")) continue;
    const lines = content.split("\n");
    const classLineOf = (from: number): number => {
      for (let index = from; index < lines.length; index += 1) {
        if (classDecl.test(lines[index])) return index + 1;
      }
      return from + 1;
    };
    const bootIndex = lines.findIndex((line) => /^\s*@SpringBootApplication\b/.test(line));
    if (bootIndex >= 0) {
      boot.push({ path, line: classLineOf(bootIndex), label: "Spring Boot 启动类" });
      continue;
    }
    const controllerIndex = lines.findIndex((line) => /^\s*@(?:Rest)?Controller\b/.test(line));
    if (controllerIndex < 0) continue;
    // 类级 @RequestMapping 前缀从注解行扫到类声明为止，路径即视图上可直接报的挂载点
    let prefix = "";
    for (let index = controllerIndex; index < lines.length; index += 1) {
      if (classDecl.test(lines[index])) break;
      const match = lines[index].match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
      if (match) {
        prefix = match[1];
        break;
      }
    }
    controllers.push({ path, line: classLineOf(controllerIndex), label: `HTTP 路由 (Spring MVC)${prefix ? `：${prefix}` : ""}` });
  }
  return [...boot, ...controllers];
}

function detectLspStatus(files: FileEntry[]): DependencyGraphData["lspStatus"] {
  // java 没有接入 LSP（符号来自 tree-sitter），不进探测列表
  const languages = new Set(files.map((file) => file.extension === ".py" ? "python" : /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.extension) ? "typescript" : undefined).filter((value): value is "typescript" | "python" => Boolean(value)));
  return [...languages].map((language) => {
    const command = language === "typescript" ? "typescript-language-server" : "pylsp";
    try {
      const probe = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 600 });
      return probe.status === 0 ? { language, status: "available" as const } : { language, status: "fallback" as const, reason: `${command} 不可用，已使用静态语法分析` };
    } catch {
      return { language, status: "fallback" as const, reason: `${command} 不可用，已使用静态语法分析` };
    }
  });
}
