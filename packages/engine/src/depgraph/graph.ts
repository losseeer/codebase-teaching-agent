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

const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java"];
const ignoredCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "require", "import"]);
/** TS/JS 的说明符一律带引号；Python 的 import 语句没有引号，另走 extractPythonSpecifiers。 */
const tsSpecifierPattern = /(?:from\s+|import\s*\(?\s*|require\s*\()\s*["']([^"']+)["']/g;

/**
 * Produces an import graph plus project-local call graph. The static analyzer is
 * deliberately complete enough for the fallback path; LSP availability is surfaced
 * separately so callers never mistake a degraded result for semantic certainty.
 */
export function buildDependencyGraph(repositoryPath: string, files: FileEntry[]): DependencyGraph {
  const available = new Set(files.map((file) => file.path));
  const packages = collectWorkspacePackages(repositoryPath, files);
  const imports = new Map<string, string[]>();
  const symbols: SymbolInfo[] = [];
  const contents = new Map<string, string>();
  for (const file of files) {
    if (!extensions.includes(file.extension)) continue;
    const content = readFileSync(join(repositoryPath, file.path), "utf8");
    contents.set(file.path, content);
    const specifiers = file.extension === ".py" ? extractPythonSpecifiers(content) : [...content.matchAll(tsSpecifierPattern)].map((match) => match[1]);
    const resolved = specifiers.map((value) => resolveImport(file.path, value, available, packages)).filter((value): value is string => Boolean(value));
    imports.set(file.path, [...new Set(resolved)]);
    symbols.push(...extractSymbols(file.path, content));
  }
  const calls = extractCalls(contents, symbols, imports);
  const lspStatus = detectLspStatus(files);
  const parseStatus = parseBackendStatus();
  return {
    imports,
    calls,
    symbols,
    entrypoints: detectEntrypoints(repositoryPath, files),
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
      if (/^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?(?:const|let|var)\b.*=>|^\s*(?:async\s+)?def\b/.test(line)) continue;
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

function detectEntrypoints(repositoryPath: string, files: FileEntry[]): SourceAnchor[] {
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
  return [...candidates.entries()]
    .filter(([path]) => !isTestPath(path) && files.some((file) => file.path === path))
    .slice(0, 12)
    .map(([path, label]) => ({ path, line: 1, label }));
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
