import { basename, dirname } from "node:path";
import type { RepositoryAnalysis } from "@codebase-tutor/domain";

import { CONTEXT_SHARE, contextShare, contextShareLines } from "../adapter/outbound/llm/context-window.js";
import type { SearchCorpus } from "../source/search-code.js";

/** 宏观设计（map）作用域的装配段：项目结构全景、画布选中模块的作用域清单、依赖邻域。 */

const mapContextCap = () => contextShare(CONTEXT_SHARE.mapContext);
/** 全景里一个目录最多列多少个文件名：超出只报总数，目录本身不丢。 */
const panoramaPerDirectoryCap = () => Math.max(1, Math.floor(contextShareLines(CONTEXT_SHARE.panorama, 60) / 4));

/** 已分析文件按目录分组的路径清单；根目录文件单列。 */
function structurePanorama(analysis: RepositoryAnalysis): string {
  const paths = Object.keys(analysis.graph.imports).sort();
  if (!paths.length) return "";
  const directories = new Map<string, string[]>();
  for (const path of paths) {
    const directory = dirname(path);
    const key = directory === "." ? "" : directory;
    directories.set(key, [...(directories.get(key) ?? []), basename(path)]);
  }
  const lines = [...directories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([directory, names]) => {
    const perDirectory = panoramaPerDirectoryCap();
    const shown = names.length > perDirectory ? `${names.slice(0, perDirectory).join("、")}…等 ${names.length} 个` : names.join("、");
    return directory ? `- ${directory}/ 共 ${names.length} 个文件：${shown}` : `- （根目录）共 ${names.length} 个文件：${shown}`;
  });
  return `项目结构全景（${paths.length} 个已分析文件，按目录分组；目录名只用来定位与写 ref，节点名写职责）：\n${lines.join("\n")}`;
}

/** 作用域段逐个列出的文件数上限；超出的只报总数。 */
const MAX_SCOPE_LISTED = 60;

/** 已分析文件全集：与目录全景同源（imports 的空数组键也算「被分析过」）。 */
function analyzedPathSet(analysis: RepositoryAnalysis): Set<string> {
  const paths = new Set(Object.keys(analysis.graph.imports));
  for (const symbol of analysis.graph.symbols) paths.add(symbol.path);
  return paths;
}

/** 画布选中模块的作用域段：清单与已分析集求交后列「路径（行数）：摘要」，交集为空回空串。 */
function scopeSection(analysis: RepositoryAnalysis, search: SearchCorpus | undefined, scopePaths: string[]): string {
  const analyzed = analyzedPathSet(analysis);
  const files = [...new Set(scopePaths)].filter((candidate) => analyzed.has(candidate)).sort();
  if (!files.length) return "";
  const corpusOf = search ? new Map(search.entries.map((entry) => [entry.path, entry])) : undefined;
  const lines = files.slice(0, MAX_SCOPE_LISTED).map((file) => {
    const entry = corpusOf?.get(file);
    const meta = entry?.lines === undefined ? "" : `（${entry.lines} 行）`;
    return `- ${file}${meta}${entry?.summary ? `：${entry.summary}` : ""}`;
  });
  const tail = files.length > MAX_SCOPE_LISTED ? `\n…其余 ${files.length - MAX_SCOPE_LISTED} 个文件未列出，需要时可用 search_code 定位。` : "";
  return `当前作用域：学习者在架构图选中的模块，含 ${files.length} 个已分析文件：\n${lines.join("\n")}${tail}`;
}

/** 依赖图中某文件的邻域：一度（直接 import / 被 import）+ 二度（import 的 import / 被被 import），去重排序。 */
function graphNeighborhood(analysis: RepositoryAnalysis, path?: string): {
  importsOut: string[];
  importedBy: string[];
  outTwo: string[];
  inTwo: string[];
} {
  if (!path) return { importsOut: [], importedBy: [], outTwo: [], inTwo: [] };
  const imports = analysis.graph.imports;
  const importsOut = imports[path] ?? [];
  const importedBy = Object.entries(imports)
    .filter(([source]) => source !== path)
    .filter(([, targets]) => targets.includes(path))
    .map(([source]) => source)
    .sort();
  const outTwo = [...new Set(importsOut.flatMap((target) => imports[target] ?? []))]
    .filter((candidate) => candidate !== path && !importsOut.includes(candidate))
    .sort();
  const inTwo = Object.entries(imports)
    .filter(([source, targets]) => source !== path && !importedBy.includes(source) && targets.some((target) => importedBy.includes(target)))
    .map(([source]) => source)
    .sort();
  return { importsOut, importedBy, outTwo, inTwo };
}

function joinList(items: string[]): string {
  return items.join("、") || "（无）";
}

export { mapContextCap, structurePanorama, scopeSection, graphNeighborhood, joinList };
