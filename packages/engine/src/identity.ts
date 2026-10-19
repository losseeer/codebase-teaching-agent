import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

/**
  发 id 与定 id：整棵引擎树最底下的一层，只认 node:crypto 与 node:fs。
  这里只放「放在任何领域里都不对」的原语——哈希、UUID、仓库身份。
  */

export const id = (): string => randomUUID();
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** 一个仓库目录的身份：realpath 之后取哈希前 16 位（同一目录不论从哪条路径进来都是同一个 id）。 */
export function repositoryId(path: string): string {
  return `repo_${hash(realpathSync(path)).slice(0, 16)}`;
}

/**
  地址簿条目的 id：目录在就按 `repositoryId` 的口径（realpath 后哈希），目录不在退化成按字面路径哈希，绝不抛——
  列清单与按帧归属仓 id 都不能因某个目录被挪走而失败。
  等它回到原路径时 `realpath(path) === path`（入簿存的就是 realpath），两种算法给出同一个 id，条目不漂。
  */
export function catalogRepositoryId(path: string): string {
  try {
    return repositoryId(path);
  } catch {
    return `repo_${hash(path).slice(0, 16)}`;
  }
}
