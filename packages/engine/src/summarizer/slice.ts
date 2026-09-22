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
  /** 仅「摘要参考注释」开关打开时附带：文件首个非 license 注释段（≤120 字），见 extractHeaderComment。 */
  headerComment?: string;
}

/** 每文件进切片的符号条目上限（与「每文件最多展示几个符号」的预算同量级）。 */
export const MAX_SLICE_ENTRIES = 8;
/** 依赖方向各给几条：再多也只是重复「它在图里」这个事实。 */
export const MAX_SLICE_EDGES = 6;

/** headerComment 的字符预算：够一段文件/类自述，不够抄整页注释。 */
export const MAX_HEADER_COMMENT_CHARS = 120;

/** 出现即整段跳过的样板注释特征（license/@author 块没有概念）。 */
const BOILERPLATE_PATTERN = /copyright|licen[cs]e|spdx|©/i;

/**
  「摘要参考注释」开关打开时附进切片的文件自述：**源码顺序上第一段正经注释**。

  取材规则（宁缺毋滥，抽不到就 undefined，绝不捞行内碎语）：
  - 块注释 / Javadoc / Python 三引号 docstring，或连续 ≥1 行的整行注释组；
  - 跳过 license/SPDX/纯 @author 样板段；正文里的 @param/@return 标签行剔除；
  - 清洗后不足 8 字的（如 `// getter`）不算自述，继续找下一段；
  - 首个合格段折叠空白、截 120 字。
  注意 Python 三引号只认「前面不是 `=`」的——字符串赋值不是 docstring。
*/
export function extractHeaderComment(path: string, text: string): string | undefined {
  const isPython = path.endsWith(".py");
  const spans: { start: number; body: string }[] = [];
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\/|"""[\s\S]*?"""/g)) {
    const before = text.slice(Math.max(0, match.index - 4), match.index);
    if (match[0].startsWith('"""') && before.includes("=")) continue;
    spans.push({ start: match.index, body: match[0].replace(/^\/\*+|^\s*"""/, "").replace(/\*\/$|"""$/, "") });
  }
  const lines = text.split("\n");
  let offset = 0;
  let group: { start: number; parts: string[] } | undefined;
  const flush = (): void => {
    if (group && group.parts.length && group.parts.join(" ").trim().length >= 8) spans.push({ start: group.start, body: group.parts.join("\n") });
    group = undefined;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const marker = trimmed.startsWith("//") && !isPython ? "//" : trimmed.startsWith("#") && isPython ? "#" : undefined;
    if (marker && trimmed.length > marker.length + 1) {
      group ??= { start: offset, parts: [] };
      group.parts.push(trimmed.slice(marker.length).trim());
    } else {
      flush();
    }
    offset += line.length + 1;
  }
  flush();
  spans.sort((left, right) => left.start - right.start);
  for (const span of spans) {
    if (BOILERPLATE_PATTERN.test(span.body)) continue;
    const cleaned = span.body
      .split("\n")
      .map((line) => line.replace(/^\s*\*+\s?/, "").replace(/^@param\b.*$/, "").replace(/^@(return|author|version|since|date)\b.*$/, "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ");
    if (cleaned.length < 8) continue;
    return cleaned.slice(0, MAX_HEADER_COMMENT_CHARS);
  }
  return undefined;
}

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
