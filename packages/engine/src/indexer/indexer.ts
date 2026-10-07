import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { FileEntry, FileTreeNode, Hotspot, RepositoryIndex, UnreadableFile } from "@codebase-tutor/shared";
import { repositoryId, hash } from "../lib.js";
import { graphExtensions } from "../depgraph/graph.js";
import { createTutorIgnoreMatcher } from "./ignore.js";

/**
  索引只收「扩展名白名单」：全量收会一路收进 .png/.mp4/锁文件，白烧字节、也毁掉热点计数。

  ⚠️ 这份名单刻意**不是「引擎支持的源码语言」**——能力表（`LANGUAGE_CAPABILITIES`）才是那个答案。
  图内扩展名从表派生（`graphExtensions`，加一门语言只改表这一处，索引自动跟上），
  表外那一组是「进索引但不进依赖图」的配置 / 文档 / 构建输入，各自写清为什么不进图。
  单测钉住：两组不重叠、并集等于实际名单、且旧的名单里每一项都还在（别让派生悄悄缩小索引范围）。
  */
const nonGraphExtensions = [".rb", ".php", ".svelte", ".json", ".mod", ".md", ".yml", ".yaml"];
const sourceExtensions = new Set([...graphExtensions, ...nonGraphExtensions]);

export function indexRepository(repositoryPath: string): RepositoryIndex {
  const files: FileEntry[] = [];
  /**
    扫描期逐个文件兜底：一个文件读不出来（读到一半被删、权限不对、被换成特殊节点）只该让它自己缺席，
    不该掀掉整次导入。但缺席必须**记名**——静默少索引一批文件，后面「这个仓有多少代码」的读数会跟着说谎。
    */
  const unreadable: UnreadableFile[] = [];
  const ignore = createTutorIgnoreMatcher(repositoryPath);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(repositoryPath, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (ignore.shouldTraverse(path)) visit(absolute);
      }
      else if (entry.isFile() && !ignore.ignores(path) && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        let content: string;
        try {
          content = readFileSync(absolute, "utf8");
        } catch (error) {
          // 读到一半文件被删 / 权限不对 / 被换成特殊节点：只让这一个文件缺席，不掀掉整次导入
          if (unreadable.length < 50) unreadable.push({ path, reason: error instanceof Error ? error.message.split("\n")[0].slice(0, 120) : String(error) });
          continue;
        }
        files.push({ path, extension: extname(entry.name), bytes: Buffer.byteLength(content), lines: content.split("\n").length, contentHash: hash(content).slice(0, 16) });
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
    hotspots: gitHotspots(repositoryPath, ignore),
    ...(unreadable.length ? { unreadable } : {})
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
