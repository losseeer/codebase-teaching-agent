import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { FileEntry, FileTreeNode, Hotspot, RepositoryIndex, UnreadableFile } from "@codebase-tutor/domain";

import { repositoryId, hash } from "@codebase-tutor/platform";
import { graphExtensions } from "@codebase-tutor/analysis";
import { deniedSecretNameReason } from "../source/read-file.js";
import { createTutorIgnoreMatcher } from "@codebase-tutor/analysis";
import { traceEngine } from "@codebase-tutor/platform";

/**
  索引只收扩展名白名单内的文件，判定入口是 `isIngestedPath`。
  `nonGraphExtensions` 里的扩展名进索引但不进依赖图。
*/
const nonGraphExtensions = [".rb", ".php", ".svelte", ".json", ".mod", ".md", ".yml", ".yaml"];
const sourceExtensions = new Set([...graphExtensions, ...nonGraphExtensions]);

export { nonGraphExtensions, sourceExtensions };

/** 路径是否进收录集：只查扩展名白名单、`.tutorignore` 与密钥载体名，不判目录规则。 */
export function isIngestedPath(relativePath: string, matcher?: { ignores(path: string, isDirectory?: boolean): boolean }): boolean {
  const path = relativePath.replaceAll("\\", "/");
  if (!sourceExtensions.has(extname(path).toLowerCase())) return false;
  if (deniedSecretNameReason(path)) return false;
  return matcher ? !matcher.ignores(path) : true;
}

/** 列出仓内当前收录的路径，只列名不读内容。 */
export function listIngestedPaths(repositoryPath: string, matcher: { ignores(path: string, isDirectory?: boolean): boolean; shouldTraverse(relativeDirectory: string): boolean }): string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // 目录读不到时这一支按缺席处理。
      return;
    }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (matcher.shouldTraverse(path)) visit(join(directory, entry.name), path);
      }
      else if (entry.isFile() && isIngestedPath(path, matcher)) found.push(path);
    }
  };
  visit(repositoryPath, "");
  return found;
}

/** 一次扫描的产出：索引本体与每个文件的完整内容哈希。 */
export type RepositoryScan = { index: RepositoryIndex; digests: Map<string, string> };

/** 扫一遍仓，返回索引与内容哈希。 */
export function scanRepositoryWithDigests(repositoryPath: string): RepositoryScan {
  const files: FileEntry[] = [];
  const digests = new Map<string, string>();
  /** 读不出来的文件缺席并在此记名。 */
  const unreadable: UnreadableFile[] = [];
  const ignore = createTutorIgnoreMatcher(repositoryPath);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(repositoryPath, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (ignore.shouldTraverse(path)) visit(absolute);
      }
      else if (entry.isFile() && isIngestedPath(path, ignore)) {
        let content: string;
        try {
          content = readFileSync(absolute, "utf8");
        } catch (error) {
          if (unreadable.length < 50) unreadable.push({ path, reason: error instanceof Error ? error.message.split("\n")[0].slice(0, 120) : String(error) });
          continue;
        }
        const digest = hash(content);
        digests.set(path, digest);
        // 落库的内容哈希只保留 16 位前缀。
        files.push({ path, extension: extname(entry.name), bytes: Buffer.byteLength(content), lines: content.split("\n").length, contentHash: digest.slice(0, 16) });
      }
    }
  };
  visit(repositoryPath);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    index: {
      repositoryId: repositoryId(repositoryPath),
      repositoryPath,
      scannedAt: new Date().toISOString(),
      totalFiles: files.length,
      totalLines: files.reduce((sum, file) => sum + file.lines, 0),
      files,
      fileTree: toTree(files),
      hotspots: gitHotspots(repositoryPath, ignore),
      ...(unreadable.length ? { unreadable } : {})
    },
    digests
  };
}

/** 只返回索引部分的包装。 */
export function indexRepository(repositoryPath: string): RepositoryIndex {
  return scanRepositoryWithDigests(repositoryPath).index;
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

/** 热点统计与索引共用同一套排除规则。 */
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
  } catch (error) {
    // git 存在但历史读不出时记一条降级。
    traceEngine("degrade", { component: "hotspots", cause: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
