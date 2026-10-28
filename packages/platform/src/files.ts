import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** 源码读取底层：仓内边界判定、读行、按符号取行区间。 */

/** candidate 是否落在 root 之内（含 root）；软链接与 `..` 由调用方先解掉。 */
export function isWithin(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}

/** 读文件为行数组，统一换行口径；读不到返回 undefined。 */
export function readFileLines(repositoryPath: string, relativePath: string): string[] | undefined {
  const absolute = join(repositoryPath, relativePath);
  try {
    // 非普通文件的同步读没有 EOF，会冻住单线程引擎
    if (!statSync(absolute).isFile()) return undefined;
    return readFileSync(absolute, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** 取符号定义体行区间 `[line-1, endLine)`；endLine 含末行。 */
export function symbolBodyLines(fileLines: string[], symbol: { line: number; endLine: number }): string[] {
  return fileLines.slice(symbol.line - 1, symbol.endLine);
}
