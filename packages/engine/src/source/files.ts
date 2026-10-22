import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** 读被学习仓库源码的三件底层小件：仓内边界判定、把一个文件读成行、按符号取行区间。 */

/** 路径 `candidate` 是否落在 `root` 之内（含 root 自己）。软链接与 `..` 由调用方先解掉。 */
export function isWithin(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}

/**
  读文件为行数组，统一 `/\r?\n/` 换行口径（CRLF 文件不留行尾 `\r`）；读不到返回 `undefined`，
  由调用方决定「缺席」还是「待确认」。实现单元、质量校验、练习出题共用这一份读行口径。
  */
export function readFileLines(repositoryPath: string, relativePath: string): string[] | undefined {
  const absolute = join(repositoryPath, relativePath);
  try {
    // 非普通文件（命名管道、设备节点）的同步读没有 EOF，一次调用就把单线程引擎冻住
    if (!statSync(absolute).isFile()) return undefined;
    return readFileSync(absolute, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** 取符号定义体的行区间 `[line-1, endLine)`：`SymbolInfo.endLine` 是「含末行」，slice 右界因此不必 +1。 */
export function symbolBodyLines(fileLines: string[], symbol: { line: number; endLine: number }): string[] {
  return fileLines.slice(symbol.line - 1, symbol.endLine);
}
