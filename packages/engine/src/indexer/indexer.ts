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
  索引只收扩展名白名单；真正落地的口径是 `isIngestedPath`。
  图内扩展名由能力表派生，表外那一组进索引但不进依赖图。
*/
const nonGraphExtensions = [".rb", ".php", ".svelte", ".json", ".mod", ".md", ".yml", ".yaml"];
const sourceExtensions = new Set([...graphExtensions, ...nonGraphExtensions]);

// 这两份清单导出给单测；graphExtensions 由 capability-coverage.test 自己取。
export { nonGraphExtensions, sourceExtensions };

/** 「这条路径会不会进收录集」：索引与监听共用；三道 = 扩展名白名单、`.tutorignore`、密钥载体名。目录规则不在这里判。 */
export function isIngestedPath(relativePath: string, matcher?: { ignores(path: string, isDirectory?: boolean): boolean }): boolean {
  const path = relativePath.replaceAll("\\", "/");
  if (!sourceExtensions.has(extname(path).toLowerCase())) return false;
  if (deniedSecretNameReason(path)) return false;
  return matcher ? !matcher.ignores(path) : true;
}

/** 「这个仓现在收录哪些路径」：只列名字不读内容，给监听层比对收录集用。 */
export function listIngestedPaths(repositoryPath: string, matcher: { ignores(path: string, isDirectory?: boolean): boolean; shouldTraverse(relativeDirectory: string): boolean }): string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // 读到一半目录没了：这一支就当没有，调用方按「收录集变了」处理
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

/** 一次扫描的两样产出：索引本体，以及算 `versionStamp` 要用的完整内容哈希（按仓内相对路径）。 */
export type RepositoryScan = { index: RepositoryIndex; digests: Map<string, string> };

/** 扫一遍仓，除了索引还交出每个文件的完整内容哈希，供算 `versionStamp`。 */
export function scanRepositoryWithDigests(repositoryPath: string): RepositoryScan {
  const files: FileEntry[] = [];
  const digests = new Map<string, string>();
  /** 单个文件读不出来只让它自己缺席，但缺席要记名。 */
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
        // 落库只留 16 位前缀：出题作用域与缓存键吃的都是它。
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

/** 只要索引的那一层包装。 */
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

/** 热点统计与索引同一套排除规则：被忽略的路径不该出现。 */
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
    // git 跑起来却没交出可读历史时也要出声；没 git 走上面那条 return。
    traceEngine("degrade", { component: "hotspots", cause: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
