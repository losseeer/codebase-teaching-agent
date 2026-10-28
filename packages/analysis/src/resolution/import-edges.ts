import { coveredByGoModule, coveredByPackageRoot, packageIdentity } from "./external-names.js";
import { cppExtensionPattern, tsSpecifierPattern } from "../ingestion/language-extensions.js";
import { extractJavaSpecifiers, javaSourceRootOf, resolveJavaImport } from "./java-types.js";
import { extractCppIncludes, resolveCppInclude } from "./cpp-imports.js";
import { extractCSharpSpecifiers, resolveCSharpImport } from "./csharp-imports.js";
import { extractGoSpecifiers, resolveGoImport } from "./go-imports.js";
import { extractPythonSpecifiers, resolvePythonImport } from "./python-imports.js";
import { extractRustSpecifiers, resolveRustImport } from "./rust-imports.js";
import { resolveImport } from "./script-imports.js";
import type { PathAlias, WorkspacePackage } from "./repo-manifest.js";

/** 通配 import 只展开正文里出现过的类名，属近似证据。 */
function expandJavaWildcard(caller: string, pkg: string, body: string, javaTypes: Map<string, string>): string[] {
  const identifiers = new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const callerRoot = javaSourceRootOf(caller);
  const targets: string[] = [];
  for (const [fqn, path] of javaTypes) {
    const dot = fqn.lastIndexOf(".");
    if (dot < 0 || fqn.slice(0, dot) !== pkg) continue;
    if (javaSourceRootOf(path) !== callerRoot) continue;
    if (!identifiers.has(fqn.slice(dot + 1))) continue;
    targets.push(path);
  }
  return targets;
}

/** 去掉 import 行只留正文，避免包名与类名自匹配。 */
const javaBodyOf = (content: string): string => content.replace(/^[ \t]*import[ \t][^\n]*$/gm, "");

interface ImportIndex {
  available: Set<string>;
  packages: Map<string, WorkspacePackage>;
  javaTypes: Map<string, string>;
  /** javaTypes 的包根前缀，用于判断是否本项目自有包。 */
  javaRoots: Set<string>;
  goModules: Map<string, string>;
  goFilesByDir: Map<string, string[]>;
  csNamespaces: Map<string, string[]>;
  csRoots: Set<string>;
  aliases: PathAlias[];
}

/** 一条 import 的两类结果：仓内落点与仓外裸包名。 */
interface ResolvedImports {
  paths: string[];
  externals: string[];
}

/** 按语言分派「提取说明符 → 落点」；外部包按整条 import 语句判定。 */
export function resolveFileImports(path: string, content: string, index: ImportIndex): ResolvedImports {
  // 去重并去自环：Go 目录导入、Rust `use crate::`、Python 绝对自导入都可能指回自己
  // 自环不进影响范围与图指纹
  const dedupe = (values: Iterable<string>): string[] => [...new Set(values)].filter((value) => value !== path);
  const finish = (paths: (string | undefined)[], externals: string[]): ResolvedImports => ({
    paths: dedupe(paths.filter((value): value is string => Boolean(value))),
    externals: [...new Set(externals)].sort()
  });

  if (path.endsWith(".py")) {
    const paths: (string | undefined)[] = [];
    const externals: string[] = [];
    for (const group of extractPythonSpecifiers(content)) {
      const hits = group.candidates.map((value) => resolvePythonImport(path, value, index.available));
      if (hits.some(Boolean)) paths.push(...hits);
      // 相对导入（`from . import x`）落不到是「仓内断链」，不是「用了包」
      else if (!group.primary.startsWith(".")) externals.push(packageIdentity("python", group.primary));
    }
    return finish(paths, externals);
  }
  if (path.endsWith(".java")) {
    const body = javaBodyOf(content);
    const paths: (string | undefined)[] = [];
    const externals: string[] = [];
    for (const item of extractJavaSpecifiers(content)) {
      const hits = item.wildcard ? expandJavaWildcard(path, item.specifier, body, index.javaTypes) : [resolveJavaImport(item.specifier, index.javaTypes)];
      if (hits.some(Boolean)) paths.push(...hits);
      // 仓内包根盖得上的名字不算外部包
      else if (!coveredByPackageRoot(index.javaRoots, item.specifier)) externals.push(packageIdentity("java", item.specifier));
    }
    return finish(paths, externals);
  }
  if (path.endsWith(".go")) {
    const paths: string[] = [];
    const externals: string[] = [];
    for (const specifier of extractGoSpecifiers(content)) {
      const hits = resolveGoImport(specifier, index.goModules, index.goFilesByDir);
      if (hits.length) paths.push(...hits);
      // go.mod 前缀盖得上的算仓内断链，不算外部
      else if (!coveredByGoModule(specifier, index.goModules)) externals.push(packageIdentity("go", specifier));
    }
    return finish(paths, externals);
  }
  if (path.endsWith(".rs")) {
    // Rust 外部 crate 名未采集：extractRustSpecifiers 只认 crate/self/super
    return finish(extractRustSpecifiers(content).map((value) => resolveRustImport(path, value, index.available)), []);
  }
  if (path.endsWith(".cs")) {
    const paths: string[] = [];
    const externals: string[] = [];
    for (const specifier of extractCSharpSpecifiers(content)) {
      const hits = resolveCSharpImport(specifier, index.csNamespaces);
      if (hits.length) paths.push(...hits);
      else if (!coveredByPackageRoot(index.csRoots, specifier)) externals.push(packageIdentity("csharp", specifier));
    }
    return finish(paths, externals);
  }
  if (cppExtensionPattern.test(path)) {
    // C/C++ 系统头未采集：extractCppIncludes 只取引号形式
    return finish(dedupe(extractCppIncludes(content).flatMap((value) => resolveCppInclude(path, value, index.available))), []);
  }
  const paths: (string | undefined)[] = [];
  const externals: string[] = [];
  for (const match of [...content.matchAll(tsSpecifierPattern)]) {
    const hit = resolveImport(path, match[1], index.available, index.packages, index.aliases);
    if (hit) paths.push(hit);
    else if (isBarePackageName(match[1], index)) externals.push(packageIdentity("node", match[1]));
  }
  return finish(paths, externals);
}

/** 合法包名字形：npm/PyPI 的名字不含空格、尖括号、竖线。 */
const packageNameShape = /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** 「解析不到」不等于「外部包」：挡掉仓内路径、别名无落点、工作区包与不合字形的捕获。 */
function isBarePackageName(specifier: string, index: ImportIndex): boolean {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (!packageNameShape.test(specifier)) return false;
  if (index.aliases.some((alias) => specifier.startsWith(alias.prefix))) return false;
  return ![...index.packages.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}


