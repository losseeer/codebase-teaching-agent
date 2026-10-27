import { dirname } from "node:path";

/**
 * Python 的 import 语句不带引号、模块名用点号分隔，需要单独提取：
 * `import a.b as c`、`import a, b`、`from a.b import c`、`from . import c`（相对包）。
 * 第三方模块（fastapi、langgraph）也会被提取出来，最终由 resolvePythonImport 按「仓库内是否存在」过滤。
 *
 * 返回的是「一条 import 语句一组」（`primary` = 语句写的那个模块，`candidates` = 所有可能的落点），
 * 不是一个平铺的说明符数组：`from a.b import c` 会同时给出 `a.b` 与 `a.b.c`（c 可能是子模块也可能是符号名），
 * 平铺之后就判不出「这条语句落不到」，而外部包名这一栏要的正是语句级的失败。
 */
export function extractPythonSpecifiers(content: string): { primary: string; candidates: string[] }[] {
  const groups: { primary: string; candidates: string[] }[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.*)$/);
    if (fromMatch) {
      const module = fromMatch[1];
      const candidates = [module];
      // `from a.b import c` 里的 c 可能是子模块，也可能是符号名 —— 两种都给出，交由可用性判定
      for (const name of readImportedNames(fromMatch[2])) candidates.push(module.endsWith(".") ? `${module}${name}` : `${module}.${name}`);
      groups.push({ primary: module, candidates });
      continue;
    }
    const importMatch = trimmed.match(/^import\s+(.*)$/);
    if (importMatch) for (const name of readImportedNames(importMatch[1])) groups.push({ primary: name, candidates: [name] });
  }
  return groups;
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
 * Python 模块名 → 仓库内文件：绝对导入从仓库根起算（`a.b.c` → `a/b/c.py` 或 `a/b/c/__init__.py`），
 * 相对导入以当前文件所在包为基准（`.` = 当前包，`..` 再上溯一层）。
 */
export function resolvePythonImport(from: string, specifier: string, available: Set<string>): string | undefined {
  const level = specifier.match(/^\.+/)?.[0].length ?? 0;
  const relative = specifier.slice(level);
  let base = level > 0 ? dirname(from) : "";
  for (let index = 1; index < level; index += 1) base = dirname(base);
  const module = relative.replaceAll(".", "/");
  const target = [base, module].filter(Boolean).join("/");
  if (!target || target === ".") return undefined;
  return [`${target}.py`, `${target}/__init__.py`].find((candidate) => available.has(candidate));
}
