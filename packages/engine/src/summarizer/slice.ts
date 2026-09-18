import type { FileRole, SymbolInfo } from "@codebase-tutor/shared";
import { buildFileEdges, type FileStructure } from "../depgraph/roles.js";
import { rankSymbolsByCalls, countSymbolsByPath } from "../depgraph/symbol-rank.js";

/**
  L1 的输入：**文件切片**，不是整份正文。

  为什么切成这样：整份正文喂模型有两个毛病——贵（一个 2,000 行的文件就顶掉整批预算），
  且噪声大（导入区、license 头、内部小工具函数与「这个文件负责什么」无关）。
  切片只保留判定文件职责真正需要的东西：**按重要性排过序的符号条目**（签名而非正文）、
  依赖方向、以及结构规则给出的角色。

  切片是**确定性**的（同一份符号表 + 同一份依赖图 → 同一份切片），因此可以直接做缓存键。
*/

export interface SliceEntry {
  name: string;
  kind: SymbolInfo["kind"];
  line: number;
  /** `name(参数)`；类与类型只给名字（它们的参数位置不是调用签名）。 */
  signature: string;
}

export interface FileSlice {
  path: string;
  lines: number;
  role: FileRole;
  entries: SliceEntry[];
  /** 因条目预算被裁掉的符号数（告诉模型「还有东西没看到」）。 */
  omittedSymbols: number;
  /** 它依赖谁 / 谁依赖它（各取前若干个，按依赖方的路径排序保证稳定）。 */
  dependsOn: string[];
  dependedOnBy: string[];
}

/** 每文件进切片的符号条目上限（与「每文件最多展示几个符号」的预算同量级）。 */
export const MAX_SLICE_ENTRIES = 8;
/** 依赖方向各给几条：再多也只是重复「它在图里」这个事实。 */
export const MAX_SLICE_EDGES = 6;

function signatureOf(symbol: SymbolInfo): string {
  if (symbol.kind === "class" || symbol.kind === "type") return symbol.name;
  return `${symbol.name}(${symbol.parameters.join(", ")})`;
}

/**
  一次构建全仓的文件切片。

  ⚠️ 排序用的入口是**全部入口**（被任一入口直接调到的符号优先），所以同一份仓库
  在任何时候算出来的切片都一样——它是缓存键，不能随「这次点的是哪个入口」变。
*/
export function buildFileSlices(structure: FileStructure, roles: Map<string, FileRole>): Map<string, FileSlice> {
  const { dependencies, dependents } = buildFileEdges(structure);
  const ranked = rankSymbolsByCalls(structure.symbols, structure.calls, structure.entrypoints.map((anchor) => anchor.path), MAX_SLICE_ENTRIES);
  const totalSymbols = countSymbolsByPath(structure.symbols);

  const slices = new Map<string, FileSlice>();
  for (const file of structure.files) {
    const entries = (ranked.get(file.path) ?? []).map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      signature: signatureOf(symbol)
    }));
    slices.set(file.path, {
      path: file.path,
      lines: file.lines,
      role: roles.get(file.path) ?? "support",
      entries,
      omittedSymbols: Math.max(0, (totalSymbols.get(file.path) ?? 0) - entries.length),
      dependsOn: [...(dependencies.get(file.path) ?? [])].sort().slice(0, MAX_SLICE_EDGES),
      dependedOnBy: [...(dependents.get(file.path) ?? [])].sort().slice(0, MAX_SLICE_EDGES)
    });
  }
  return slices;
}
