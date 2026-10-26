import { dirname, join, normalize } from "node:path";
import { slash } from "./repo-paths.js";

/** 只认 `#include "x.h"`（引号形，项目内头文件）；尖括号是系统/第三方头，直接不收。 */
export function extractCppIncludes(content: string): string[] {
  return [...content.matchAll(/^[ \t]*#[ \t]*include[ \t]*"([^"]+)"/gm)].map((match) => match[1]);
}

/** 先按当前文件相对解析（编译器首要规则）；未命中再按全仓路径后缀匹配——include 目录各异，多个命中就全连（自环由 `resolveFileImports` 统一去掉）。 */
export function resolveCppInclude(from: string, specifier: string, available: Set<string>): string[] {
  const relative = slash(normalize(join(dirname(from), specifier)));
  if (available.has(relative)) return [relative];
  const suffix = `/${specifier.replaceAll("\\", "/")}`;
  return [...available].filter((candidate) => candidate.endsWith(suffix));
}
