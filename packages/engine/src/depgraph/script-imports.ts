import { dirname, extname, join, normalize } from "node:path";
import { nodeNextTargets, specifierExtensions } from "./language-extensions.js";
import type { PathAlias, WorkspacePackage } from "./repo-manifest.js";

/** 通用说明符解析：只服务走到这里的脚本家族（TS / Vue）。py/java/go/rs/cs/cpp 都在 `resolveFileImports` 里被各自的分派截走，不会到这里。 */
export function resolveImport(from: string, specifier: string, available: Set<string>, packages: Map<string, WorkspacePackage>, aliases: PathAlias[]): string | undefined {
  // 落点候选只试发起文件那门语言的扩展名，理由见 `specifierExtensions`
  const candidates = specifierExtensions(from);
  const tryResolve = (candidate: string): string | undefined => {
    const normalized = normalize(candidate).replaceAll("\\", "/");
    const direct = [normalized];
    // TypeScript 的 NodeNext 约定：源码里写的是运行时的后缀，实际文件是 TS 的那一个。
    // 后缀对子是固定的（.js↔.ts、.mjs↔.mts、.cjs↔.cts），所以按表逐项映射，不只写 `.js` 那一支。
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
  // 工作区包没命中再试 tsconfig paths 别名（`@/stores/user` → `src/stores/user`）；仍未命中就丢弃
  const alias = aliases.find((item) => specifier.startsWith(item.prefix));
  if (!alias) return undefined;
  const rest = specifier.slice(alias.prefix.length);
  return alias.dirs.map((dir) => tryResolve(join(dir, rest))).find((hit) => hit !== undefined);
}
