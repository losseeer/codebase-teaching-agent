/** 递归列出目录下所有文件的相对路径；默认跳过版本目录。 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function listFilesUnder(root: string, options?: { skip?: Set<string> }): string[] {
  const skip = options?.skip ?? new Set([".versions"]);
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else out.push(`${prefix}${name}`);
    }
  };
  walk(root, "");
  return out;
}
