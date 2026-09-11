import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export const id = (): string => randomUUID();
export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function repositoryId(path: string): string {
  return `repo_${hash(realpathSync(path)).slice(0, 16)}`;
}

export function isWithin(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}
