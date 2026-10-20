import type { FileEntry, RepositoryIndex } from "@codebase-tutor/shared";

/**
  教学作用域：一个文件或一个目录。存成 `file:<path>` / `dir:<path>`，
  既做线程绑定键，也做上下文装配的入口；不依赖任何课程树。
*/
export interface TeachingScope {
  kind: "file" | "dir";
  path: string;
  ref: string;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

export function parseScopeRef(ref: string): TeachingScope | undefined {
  const match = /^(file|dir):(.*)$/.exec(ref);
  if (!match) return undefined;
  const raw = normalizePath(match[2] ?? "");
  if (match[1] === "file" && !raw) return undefined;
  const path = raw || ".";
  return { kind: match[1] as "file" | "dir", path, ref: `${match[1]}:${path}` };
}

export function scopeFiles(scope: TeachingScope, index: RepositoryIndex): FileEntry[] {
  if (scope.kind === "file") return index.files.filter((file) => file.path === scope.path);
  if (scope.path === ".") return index.files;
  const prefix = `${scope.path}/`;
  return index.files.filter((file) => file.path.startsWith(prefix));
}

export function scopeAvailable(scope: TeachingScope, index: RepositoryIndex): boolean {
  return scopeFiles(scope, index).length > 0;
}

export function scopeTitle(scope: TeachingScope): string {
  if (scope.kind === "file") return scope.path.split("/").pop() ?? scope.path;
  return scope.path === "." ? "仓库根目录" : scope.path;
}
