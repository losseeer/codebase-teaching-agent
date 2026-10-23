import { coveredByGoModule, coveredByPackageRoot, packageIdentity } from "./external-names.js";
import { cppExtensionPattern, tsSpecifierPattern } from "./language-extensions.js";
import { extractJavaSpecifiers, javaSourceRootOf, resolveJavaImport } from "./java-types.js";
import { extractCppIncludes, resolveCppInclude } from "./cpp-imports.js";
import { extractCSharpSpecifiers, resolveCSharpImport } from "./csharp-imports.js";
import { extractGoSpecifiers, resolveGoImport } from "./go-imports.js";
import { extractPythonSpecifiers, resolvePythonImport } from "./python-imports.js";
import { extractRustSpecifiers, resolveRustImport } from "./rust-imports.js";
import { resolveImport } from "./script-imports.js";
import type { PathAlias, WorkspacePackage } from "./repo-manifest.js";

/**
  通配 import 的落点：只认「这个包里的类名真的出现在正文里」的那些。

  不整包展开：`com.demo.utils.*` 覆盖十几个类，而一个文件通常只用其中三四个；
  全量入图等于给同一包内的每对文件都连一条边——影响范围会虚胖、流程证据会被无关文件挤掉。
  判据用「标识符集合包含」而不是逐个正则：一次分词就能判完整个包，且天然带词边界（`Keys` 不会被 `Keys2` 误配）。
  代价：注释里提过的类名会被算进来，所以这类边的强度低于直接 import，是近似证据而非新的权威证据。
  */
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

/** 去掉 import 行，只留正文：否则 `import com.a.*;` 与相邻的直接导入会把包名/类名自己喂成命中。 */
const javaBodyOf = (content: string): string => content.replace(/^[ \t]*import[ \t][^\n]*$/gm, "");

interface ImportIndex {
  available: Set<string>;
  packages: Map<string, WorkspacePackage>;
  javaTypes: Map<string, string>;
  /** javaTypes 的包根前缀（见 `packageRoots`）：判「这是本项目自己的包」用，一次建表反复查。 */
  javaRoots: Set<string>;
  goModules: Map<string, string>;
  goFilesByDir: Map<string, string[]>;
  csNamespaces: Map<string, string[]>;
  csRoots: Set<string>;
  aliases: PathAlias[];
}

/** 一条 import 语句的两类结果：仓内落点（进图的边）与仓外裸包名（进图上「边界之外」那一栏）。 */
interface ResolvedImports {
  paths: string[];
  externals: string[];
}

/**
  按语言分派「提取说明符 → 落点」。落不到的（stdlib/第三方/系统头）不进图，图里只留仓内依赖。
  这里多做的一件事是把落不到的包名身份记进 `externals`，让「这个系统边界之外碰了什么」有确定性数据可答。
  失败按一条 import 语句判，不按单个候选说明符判——`from a.b import c` 落不到才算这条语句用了外部包。
*/
export function resolveFileImports(path: string, content: string, index: ImportIndex): ResolvedImports {
  /**
    收尾去重 + 去自环。Go 导入自己所在的包目录、Rust 在 `src/a.rs` 里写 `use crate::a::X`、
    Python 的绝对自导入（`import app.store` 写在 store.py 里）都能指回自己。
    角色层靠 `buildFileEdges` 的 key===value 挡了一下，`impactRadius` 没挡——
    自环进了影响范围就变成「改它影响它自己」这种无效证据，还会进流程与出题的图指纹。判据只留这一处。
    */
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
      // 仓内类型表盖得上的名字不是外部包：`import com.demo.dao.X` 落不到只说明 X 没被收录，
      // 把它记成「边界之外的服务」不准确
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
      // 仓内 go.mod 前缀盖得上、只是目录下没解析到文件：那也是仓内断链，不算外部
      else if (!coveredByGoModule(specifier, index.goModules)) externals.push(packageIdentity("go", specifier));
    }
    return finish(paths, externals);
  }
  if (path.endsWith(".rs")) {
    // Rust 的外部 crate 名仍采不到：extractRustSpecifiers 只认 `use (crate|self|super)::`，
    // `use serde::Serialize` 不在候选里。要采得改那条正则，属于「给一门语言加采集面」，不在这里。
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
    // C/C++ 同理：extractCppIncludes 只取引号形式，`<vector>` 这类系统头不在候选里。
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

/** 合法包名的字形：npm / PyPI 的名字里没有空格、尖括号、竖线。脏捕获靠这一条挡掉。 */
const packageNameShape = /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
  「解析不到」不等于「是外部包」，这一关挡掉三类东西：
  - `./missing`、`/abs/path`、命中 tsconfig 别名却没落点的都是仓内意图，只是断链，记成外部服务不准确；
  - 同一个仓里的工作区包（`@codebase-tutor/shared`）：落点算不出是解析能力问题，不是「用了个三方包」；
  - 字形根本不是包名的脏捕获：`tsSpecifierPattern` 在 `.tsx` 里真会吃到 `<div className=`、` | ` 这种串，
    只让 `resolveImport` 返回 undefined 不够，名字要留档就必须先验形。
*/
function isBarePackageName(specifier: string, index: ImportIndex): boolean {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (!packageNameShape.test(specifier)) return false;
  if (index.aliases.some((alias) => specifier.startsWith(alias.prefix))) return false;
  return ![...index.packages.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}
