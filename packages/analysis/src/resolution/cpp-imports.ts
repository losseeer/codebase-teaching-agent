import { dirname, join, normalize } from "node:path";
import { slash } from "./repo-paths.js";

/** 只认引号形式的 `#include`；尖括号是系统与第三方头。 */
export function extractCppIncludes(content: string): string[] {
  return [...content.matchAll(/^[ \t]*#[ \t]*include[ \t]*"([^"]+)"/gm)].map((match) => match[1]);
}

/** 先按当前文件相对解析，未命中再按全仓路径后缀匹配，多个命中全连。 */
export function resolveCppInclude(from: string, specifier: string, available: Set<string>): string[] {
  const relative = slash(normalize(join(dirname(from), specifier)));
  if (available.has(relative)) return [relative];
  const suffix = `/${specifier.replaceAll("\\", "/")}`;
  return [...available].filter((candidate) => candidate.endsWith(suffix));
}

