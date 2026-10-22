import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { FileEntry, FileTreeNode, Hotspot, RepositoryIndex, UnreadableFile } from "@codebase-tutor/shared";
import { repositoryId, hash } from "../identity.js";
import { graphExtensions } from "../depgraph/graph.js";
import { deniedSecretNameReason } from "../source/read-file.js";
import { createTutorIgnoreMatcher } from "./ignore.js";
import { traceEngine } from "../trace/engine-log.js";

/**
  索引只收「扩展名白名单」：全量收会一路收进 .png/.mp4/锁文件，既花字节也毁掉热点计数。
  白名单不是唯一的一道：真正落地的口径是 `isIngestedPath`（白名单 ∩ `.tutorignore` ∩ 非密钥载体名）。

  ⚠️ 这份名单刻意不是「引擎支持的源码语言」——能力表（`LANGUAGE_CAPABILITIES`）才是那个答案。
  图内扩展名从表派生（`graphExtensions`，加一门语言只改表这一处，索引自动跟上），
  表外那一组是「进索引但不进依赖图」的配置 / 文档 / 构建输入，各自写清为什么不进图。
  单测钉住：两组不重叠、并集等于实际名单、且每一项都还在（别让派生悄悄缩小索引范围）。
  */
const nonGraphExtensions = [".rb", ".php", ".svelte", ".json", ".mod", ".md", ".yml", ".yaml"];
const sourceExtensions = new Set([...graphExtensions, ...nonGraphExtensions]);

// 导出这两份清单给单测钉住上面那段口径；graphExtensions 由 capabilities.test 直接从 graph.js 取，这里不转发。
export { nonGraphExtensions, sourceExtensions };

/**
  「这条路径会不会进收录集」——索引与监听共用这一份判据（监听层用它决定一次改动要不要叫醒整轮重分析）。
  三道：扩展名白名单、`.tutorignore`、读层拒读名单里的「名字」那一半（`credentials.json` 这类密钥载体）。
  第三道的理由是口径自洽：`GET /source` 与 `read_file` 都判它「不开放读取」，索引却收着它
  （路径与行数进产物、文件树里看得见），「摘要参考注释」开关一开还会把正文读出来，只剩 maskSecrets 一道。
  ⚠️ 目录规则不在这里：见 `deniedSecretNameReason` 那段（用户显式放行 `.tutor` 目录时索引层照收是既有设计）。
  */
export function isIngestedPath(relativePath: string, matcher?: { ignores(path: string, isDirectory?: boolean): boolean }): boolean {
  const path = relativePath.replaceAll("\\", "/");
  if (!sourceExtensions.has(extname(path).toLowerCase())) return false;
  if (deniedSecretNameReason(path)) return false;
  return matcher ? !matcher.ignores(path) : true;
}

/**
  「这个仓现在收录哪些路径」——只列名字，不读内容，比逐个算哈希便宜一个数量级。
  给监听层用：一条「目录」或「stat 不到」的模糊事件到来时，比一比收录集有没有真的变，
  变不了就别叫醒整轮重分析（往仓根放一张 `.png` 会把父目录的 mtime 顶一下，那种事件不带任何文件路径）。
  */
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

/**
  扫一遍仓，除了索引还交出每个文件的完整内容哈希：紧接着 `analyzeWith` 要算 `versionStamp`，
  吃的就是这些哈希，多交这一份省掉它对全仓再读一遍。
  */
export function scanRepositoryWithDigests(repositoryPath: string): RepositoryScan {
  const files: FileEntry[] = [];
  const digests = new Map<string, string>();
  /**
    扫描期逐个文件兜底：一个文件读不出来（读到一半被删、权限不对、被换成特殊节点）只该让它自己缺席，
    不该让整次导入失败。但缺席必须记名——静默少索引一批文件，后面「这个仓有多少代码」的读数会跟着说不实。
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
        // 落库的那份只留 16 位前缀：出题作用域与缓存键吃的都是它，改长度等于把所有旧题判过期
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

/** 只要索引的那一层包装（扫描脚本、评测台架、监听层的收录集比对都用它，别为了拿哈希去改它们的返回形状）。 */
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
  } catch (error) {
    // 「这仓没有 git」走上面那条 return；走到这里说明 git 跑起来了却没交出可读的历史
    // （超过 maxBuffer、被信号杀掉、二进制不在）。两种情况都返回空，但只有后者要出声——
    // 否则界面「Git 热点」空着，谁都不知道是没数据还是读崩了。
    traceEngine("degrade", { component: "hotspots", cause: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
