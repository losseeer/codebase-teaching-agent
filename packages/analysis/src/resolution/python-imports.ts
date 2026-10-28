import { dirname } from "node:path";

/** 提取 Python import 语句：一条语句一组，`primary` 是语句写的模块，`candidates` 是所有可能落点。 */
export function extractPythonSpecifiers(content: string): { primary: string; candidates: string[] }[] {
  const groups: { primary: string; candidates: string[] }[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.*)$/);
    if (fromMatch) {
      const module = fromMatch[1];
      const candidates = [module];
      // c 可能是子模块也可能是符号名，两种都给出
      for (const name of readImportedNames(fromMatch[2])) candidates.push(module.endsWith(".") ? `${module}${name}` : `${module}.${name}`);
      groups.push({ primary: module, candidates });
      continue;
    }
    const importMatch = trimmed.match(/^import\s+(.*)$/);
    if (importMatch) for (const name of readImportedNames(importMatch[1])) groups.push({ primary: name, candidates: [name] });
  }
  return groups;
}

/** 取出模块名：剥掉别名、括号与行尾注释。 */
function readImportedNames(raw: string): string[] {
  return raw
    .split("#")[0]
    .split(",")
    .map((item) => item.split(/\s+as\s+/)[0].replace(/^\(+/, "").replace(/\)+$/, "").trim())
    .filter((item) => /^[A-Za-z_][\w.]*$/.test(item));
}

/** Python 模块名到仓内文件：绝对导入从仓根起算，相对导入以当前文件所在包为基准。 */
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

