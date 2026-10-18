import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
  读被学习仓库源码的三件底层小件：仓内边界判定、把一个文件读成行、按符号取行区间。
  住在 `source/` 是因为这三件都只在「要看仓库里的代码」时才有意义；
  以前它们和哈希、日志落点混在同一个顶层 `lib.ts` 里，于是「读源码的口径」没有归属，
  谁要用谁就去顶层捞一条，两条 CRLF 口径迟早分叉。
  */

/** 路径 `candidate` 是否落在 `root` 之内（含 root 自己）。软链接与 `..` 由调用方先解掉。 */
export function isWithin(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}

/**
  读文件为行数组，统一 `/\r?\n/` 换行口径（CRLF 文件不留行尾 `\r`）；读不到返回 `undefined`，
  由调用方决定「缺席」还是「待确认」。实现单元、质量校验、练习出题共用这一份读行口径，别各写一份 split。
  */
export function readFileLines(repositoryPath: string, relativePath: string): string[] | undefined {
  try {
    return readFileSync(join(repositoryPath, relativePath), "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** 取符号定义体的行区间 `[line-1, endLine)`：`SymbolInfo.endLine` 是「含末行」，slice 右界因此不必 +1。 */
export function symbolBodyLines(fileLines: string[], symbol: { line: number; endLine: number }): string[] {
  return fileLines.slice(symbol.line - 1, symbol.endLine);
}
