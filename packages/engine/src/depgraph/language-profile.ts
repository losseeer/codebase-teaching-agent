import { LANGUAGE_BY_EXTENSION, UNKNOWN_LANGUAGE_CAPABILITIES, languageCapabilitiesOf, type DependencyGraphData, type FileEntry, type RepositoryLanguageProfile, type RepositoryLanguageRow } from "@codebase-tutor/shared";
import { handledExtensions } from "./graph.js";

/**
  本仓语言画像 = 索引到的文件按扩展名归堆 × 共享语言能力表（`LANGUAGE_CAPABILITIES`）。
  判档表在 `@codebase-tutor/shared`（两侧共用，属引擎自报口径），这里只做读侧统计，不另写语言判断、不碰建图。

  纯元数据，不写回任何产物：调用方在响应里实时计算一份挂上，`repository.analysis` 本体与它的缓存键输入
  （`versionStamp`、`backendStamp`）都不受影响，因此改这张表不会触发起摘要或流程重算。
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
    // 索引器的扩展名来自 `extname`、本来就带点；无后缀文件给空串，按未知语言处理，不硬塞给某一门语言
    const extension = file.extension.toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language) {
      const capabilities = languageCapabilitiesOf(language);
      add(`language:${language}`, { language, displayName: capabilities.displayName, extensions: [...capabilities.extensions], inDependencyGraph: true, capabilities }, file);
      /**
        「这门语言进不进图」是行级事实（`inDependencyGraph`），「这个文件进没进图」要按建图那道大小写敏感的
        后缀闸门算：索引器先 lowercase 再比，所以 `App.TS` 在索引里但不在图里。
        这里若也按小写数，`graphFileShare` 会虚高。
        */
      if (handledExtensions.has(file.extension)) graphFiles += 1;
      continue;
    }
    // 未知语言按扩展名各占一行：并成一行会把「300 个文档」说成「一门语言没有规则」
    const label = extension || "无后缀";
    add(`extension:${label}`, { language: `unknown:${label}`, displayName: `${label} 文件`, extensions: [extension], inDependencyGraph: false, capabilities: UNKNOWN_LANGUAGE_CAPABILITIES }, file);
  }

  const languages = [...rows.values()]
    .map((row) => ({ ...row, fileShare: shareOf(row.files, files.length) }))
    .sort((left, right) => right.files - left.files || left.displayName.localeCompare(right.displayName));
  return {
    languages,
    graphFileShare: shareOf(graphFiles, files.length),
    // parseBackend 缺省时按 regex 认，与 `graphFromData` 同一口径
    parseBackend: graph.parseBackend ?? "regex",
    ...(graph.parseBackendReason ? { parseBackendReason: graph.parseBackendReason } : {})
  };
}
