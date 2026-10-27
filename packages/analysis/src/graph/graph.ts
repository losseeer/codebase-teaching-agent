import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { CallEdge, DependencyGraphData, FileEntry, SourceAnchor, SymbolInfo, TypeDispatchEdge } from "@codebase-tutor/domain";

import { parseBackendStatus, type ParseBackendStatus } from "../extraction/parser.js";
import { extractCalls } from "../resolution/call-edges.js";
import { detectEntrypoints } from "../entrypoints/entrypoints.js";
import { packageRoots } from "../resolution/external-names.js";
import { collectGoFiles, collectGoModules } from "../resolution/go-imports.js";
import { collectJavaTypes, extractJavaDispatch } from "../resolution/java-types.js";
import { collectCSharpNamespaces } from "../resolution/csharp-imports.js";
import { extractSymbols } from "../extraction/symbol-extraction.js";
import { handledExtensions, tsFamilyExtensions } from "../ingestion/language-extensions.js";
import { resolveFileImports } from "../resolution/import-edges.js";
import { collectPathAliases, collectWorkspacePackages } from "../resolution/repo-manifest.js";


export interface DependencyGraph {
  imports: Map<string, string[]>;
  /**
    文件 → 它 import 了但仓内解析不到的裸包名（图上「边界之外」那一栏）。
    刻意与 `imports` 分家：这里没有一个字是边，`impactRadius`、角色分层、出题缓存键都不看它。
    没采到外部名的语言（Rust 的 `use serde::` 与 C/C++ 的 `<...>` 头）不写键，读侧按「未采集」处理。
  */
  externals: Map<string, string[]>;
  calls: CallEdge[];
  /** 类型派发边（Java/C# 的 extends/implements 落点）；详见 shared 的 `TypeDispatchEdge` 注释。 */
  dispatch: TypeDispatchEdge[];
  symbols: SymbolInfo[];
  entrypoints: SourceAnchor[];
  semanticBackend: "lsp" | "static";
  lspStatus: DependencyGraphData["lspStatus"];
  /** 符号抽取走的哪条路（`ast` 准确 / `regex` 回落）；回落原因见 `parseBackendReason`。 */
  parseBackend: ParseBackendStatus["backend"];
  parseBackendReason?: string;
}

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
    if (!handledExtensions.has(file.extension)) continue;
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
  const aliases = collectPathAliases(repositoryPath);
  const imports = new Map<string, string[]>();
  const externals = new Map<string, string[]>();
  for (const [path, content] of contents) {
    const resolved = resolveFileImports(path, content, { available, packages, javaTypes, javaRoots: packageRoots(javaTypes.keys()), goModules, goFilesByDir, csNamespaces, csRoots: packageRoots(csNamespaces.keys()), aliases });
    imports.set(path, resolved.paths);
    // 没有外部名的文件不写键：Map 里少一条 = 「这个文件不 import 任何仓外的东西」，是真结论
    if (resolved.externals.length) externals.set(path, resolved.externals);
  }
  const calls = extractCalls(contents, symbols, imports, javaTypes);
  const dispatch: TypeDispatchEdge[] = [];
  for (const [path, content] of contents) {
    if (path.endsWith(".java")) dispatch.push(...extractJavaDispatch(path, content, javaTypes));
  }
  const lspStatus = detectLspStatus(files);
  const parseStatus = parseBackendStatus();
  return {
    imports,
    externals,
    calls,
    dispatch,
    symbols,
    entrypoints: detectEntrypoints(repositoryPath, files, contents),
    semanticBackend: lspStatus.some((item) => item.status === "available") ? "lsp" : "static",
    lspStatus,
    parseBackend: parseStatus.backend,
    ...(parseStatus.reason ? { parseBackendReason: parseStatus.reason } : {})
  };
}

function detectLspStatus(files: FileEntry[]): DependencyGraphData["lspStatus"] {
  // java 没有接入 LSP（符号来自 tree-sitter），不进探测列表
  const languages = new Set(files.map((file) => file.extension === ".py" ? "python" as const : tsFamilyExtensions.has(file.extension) ? "typescript" as const : undefined).filter((value): value is "typescript" | "python" => Boolean(value)));
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
