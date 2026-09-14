import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { FileEntry, FileTreeNode, Hotspot, RepositoryIndex } from "@codebase-tutor/shared";
import { repositoryId } from "../lib.js";
import { createTutorIgnoreMatcher } from "./ignore.js";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".php", ".vue", ".svelte", ".json", ".md", ".yml", ".yaml"]);

export function indexRepository(repositoryPath: string): RepositoryIndex {
  const files: FileEntry[] = [];
  const ignore = createTutorIgnoreMatcher(repositoryPath);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(repositoryPath, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (ignore.shouldTraverse(path)) visit(absolute);
      }
      else if (entry.isFile() && !ignore.ignores(path) && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        const content = readFileSync(absolute, "utf8");
        files.push({ path, extension: extname(entry.name), bytes: Buffer.byteLength(content), lines: content.split("\n").length });
      }
    }
  };
  visit(repositoryPath);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    repositoryId: repositoryId(repositoryPath),
    repositoryPath,
    scannedAt: new Date().toISOString(),
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    files,
    fileTree: toTree(files),
    hotspots: gitHotspots(repositoryPath, ignore)
  };
}

function toTree(files: FileEntry[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", kind: "directory", children: [] };
  for (const file of files) {
    let parent = root;
    const parts = file.path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const path = parts.slice(0, index + 1).join("/");
      const kind = index === parts.length - 1 ? "file" : "directory";
      let node = parent.children?.find((item) => item.name === name);
      if (!node) {
        node = { name, path, kind, children: kind === "directory" ? [] : undefined };
        parent.children!.push(node);
      }
      parent = node;
    }
  }
  const sort = (nodes: FileTreeNode[]): void => {
    nodes.sort((a, b) => Number(a.kind === "file") - Number(b.kind === "file") || a.name.localeCompare(b.name));
    nodes.forEach((node) => node.children && sort(node.children));
  };
  sort(root.children!);
  return root.children!;
}

/** Hotspot statistics follow the same exclusion rules as indexing; ignored paths must not surface. */
function gitHotspots(repositoryPath: string, ignore: ReturnType<typeof createTutorIgnoreMatcher>): Hotspot[] {
  if (!existsSync(join(repositoryPath, ".git"))) return [];
  try {
    const output = execFileSync("git", ["-C", repositoryPath, "log", "--name-only", "--format="], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const changes = new Map<string, number>();
    for (const path of output.split("\n").map((value) => value.trim()).filter(Boolean)) {
      if (ignore.ignores(path)) continue;
      changes.set(path, (changes.get(path) ?? 0) + 1);
    }
    return [...changes.entries()].map(([path, count]) => ({ path, changes: count }))
      .sort((a, b) => b.changes - a.changes || a.path.localeCompare(b.path)).slice(0, 30);
  } catch {
    return [];
  }
}
