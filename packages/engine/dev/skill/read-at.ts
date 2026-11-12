/** 按 (技能名, 文件名) 读取指定技能目录；读不到返回 undefined。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function fileReaderAt(root: string | undefined): (name: string, file?: string) => string | undefined {
  return (name, file = "SKILL.md") => {
    try {
      return readFileSync(join(root ?? "", name, file), "utf8");
    } catch {
      return undefined;
    }
  };
}
