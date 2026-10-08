import { LANGUAGE_BY_EXTENSION, UNKNOWN_LANGUAGE_CAPABILITIES, languageCapabilitiesOf, type DependencyGraphData, type FileEntry, type RepositoryLanguageProfile, type RepositoryLanguageRow } from "@codebase-tutor/shared";
import { handledExtensions } from "./graph.js";

/**
  本仓语言画像 = 索引到的文件按扩展名归堆 × 共享语言能力表（`LANGUAGE_CAPABILITIES`）。

  为什么单独一个文件、只做加法：判档的那张表在 `@codebase-tutor/shared`（两侧共用，且明确写着它是
  「引擎自报口径」），这里只补「本仓有哪些语言、各占多少」这一层读侧统计——
  不在这里另写一套语言判断，也不碰建图。

  ⚠️ 纯元数据，**不写回任何产物**：调用方（`server.ts` 的仓库分析路由）在响应里现算一份挂上，
  `repository.analysis` 本体与它的缓存键输入（`versionStamp`、`backendStamp`）都不受影响。
  所以改这张表不会引发摘要或流程重烧，已导入的仓库当场就能看到新口径。
*/

function shareOf(files: number, total: number): number {
  if (!total) return 0;
  return Number((files / total).toFixed(4));
}

export function languageProfileOf(files: FileEntry[], graph: Pick<DependencyGraphData, "parseBackend" | "parseBackendReason">): RepositoryLanguageProfile {
  const rows = new Map<string, RepositoryLanguageRow>();
  const add = (key: string, build: Omit<RepositoryLanguageRow, "files" | "lines" | "fileShare">, file: FileEntry): void => {
    const row = rows.get(key) ?? { ...build, files: 0, lines: 0, fileShare: 0 };
    row.files += 1;
    row.lines += file.lines;
    rows.set(key, row);
  };

  let graphFiles = 0;
  for (const file of files) {
    // 索引器的扩展名来自 `extname`，本来就带点；无后缀文件给空串——按未知语言处理，不硬塞给某一门语言
    const extension = file.extension.toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language) {
      const capabilities = languageCapabilitiesOf(language);
      add(`language:${language}`, { language, displayName: capabilities.displayName, extensions: [...capabilities.extensions], inDependencyGraph: true, capabilities }, file);
      /**
        「这门语言进不进图」是行级事实（`inDependencyGraph`），「这个文件进没进图」得按建图那一句判据算——
        两者不一样：索引器的闸门先 lowercase 再比，`App.TS` 因此在索引里；图层是大小写敏感的，它不在图里
        （大写后缀整链排除是记录在案的已知局限）。这里若也按小写数，画像会把「进了索引、没进图」
        报成图内文件数，`graphFileShare` 跟着虚高。
        */
      if (handledExtensions.has(file.extension)) graphFiles += 1;
      continue;
    }
    // 未知语言按扩展名各占一行：并成一行会把「300 个文档」说成「一门语言没有规则」，读数就废了
    const label = extension || "无后缀";
    add(`extension:${label}`, { language: `unknown:${label}`, displayName: `${label} 文件`, extensions: [extension], inDependencyGraph: false, capabilities: UNKNOWN_LANGUAGE_CAPABILITIES }, file);
  }

  const languages = [...rows.values()]
    .map((row) => ({ ...row, fileShare: shareOf(row.files, files.length) }))
    .sort((left, right) => right.files - left.files || left.displayName.localeCompare(right.displayName));
  return {
    languages,
    graphFileShare: shareOf(graphFiles, files.length),
    // 旧产物的图里没有 parseBackend（那时只有逐行匹配一条路），与 `graphFromData` 同一口径按 regex 认
    parseBackend: graph.parseBackend ?? "regex",
    ...(graph.parseBackendReason ? { parseBackendReason: graph.parseBackendReason } : {})
  };
}
