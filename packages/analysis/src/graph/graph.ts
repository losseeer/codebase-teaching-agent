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
  /** 仓内解析不到的裸包名；不是依赖边，`impactRadius` 与角色分层都不看它。 */
  externals: Map<string, string[]>;
  calls: CallEdge[];
  /** 类型派发边（Java/C# 的 extends/implements 落点）。 */
  dispatch: TypeDispatchEdge[];
  symbols: SymbolInfo[];
  entrypoints: SourceAnchor[];
  semanticBackend: "lsp" | "static";
  lspStatus: DependencyGraphData["lspStatus"];
  /** 符号抽取走的路：`ast` 或 `regex` 回落。 */
  parseBackend: ParseBackendStatus["backend"];
  parseBackendReason?: string;
}

/** 建导入图、调用图、符号表与入口清单；解析后端与 LSP 状态一并外露。 */
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
  // Java/Go/C# 的落点都要先建全仓索引，故内容先读全再解析依赖
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
    // 无外部名的文件不写键，缺键即「无仓外引用」
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
  // Java 未接入 LSP，不进探测列表
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

