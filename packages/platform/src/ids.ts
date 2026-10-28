import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

/** id 与哈希原语；只依赖 node:crypto 与 node:fs。 */

export const id = (): string => randomUUID();
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** 仓库目录身份：realpath 后哈希取前 16 位。 */
export function repositoryId(path: string): string {
  return `repo_${hash(realpathSync(path)).slice(0, 16)}`;
}

/** 地址簿条目 id；目录不存在时按字面路径哈希，不抛错。 */
export function catalogRepositoryId(path: string): string {
  try {
    return repositoryId(path);
  } catch {
    return `repo_${hash(path).slice(0, 16)}`;
  }
}
