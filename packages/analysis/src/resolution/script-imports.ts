import { dirname, extname, join, normalize } from "node:path";
import { nodeNextTargets, specifierExtensions } from "../ingestion/language-extensions.js";
import type { PathAlias, WorkspacePackage } from "./repo-manifest.js";

/** 说明符解析：只服务 TS/Vue 家族，其余语言在 `resolveFileImports` 里各自分派。 */
export function resolveImport(from: string, specifier: string, available: Set<string>, packages: Map<string, WorkspacePackage>, aliases: PathAlias[]): string | undefined {
  // 落点候选只试发起文件语言的扩展名，见 `specifierExtensions`
  const candidates = specifierExtensions(from);
  const tryResolve = (candidate: string): string | undefined => {
    const normalized = normalize(candidate).replaceAll("\\", "/");
    const direct = [normalized];
    // NodeNext 约定：源码写运行时后缀，实际文件是 TS 的那一个，按表逐项映射
    const extension = extname(normalized);
    const rewritten = nodeNextTargets[extension];
    if (rewritten) {
      const stripped = normalized.slice(0, -extension.length);
      direct.push(...rewritten.map((target) => `${stripped}${target}`));
    }
    const possibilities = [...direct, ...candidates.map((item) => `${normalized}${item}`), ...candidates.map((item) => `${normalized}/index${item}`)];
    return possibilities.find((value) => available.has(value));
  };
  if (specifier.startsWith(".")) return tryResolve(join(dirname(from), specifier));
  // 裸说明符：只解析仓库内 package.json 声明的工作区包（外部依赖不入图）
  const matched = [...packages.entries()].find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
  if (matched) {
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
  // 工作区包没命中再试 tsconfig paths 别名
  const alias = aliases.find((item) => specifier.startsWith(item.prefix));
  if (!alias) return undefined;
  const rest = specifier.slice(alias.prefix.length);
  return alias.dirs.map((dir) => tryResolve(join(dir, rest))).find((hit) => hit !== undefined);
}

