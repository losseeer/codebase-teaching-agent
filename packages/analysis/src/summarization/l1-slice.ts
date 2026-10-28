import type { FileRole, SymbolInfo } from "@codebase-tutor/domain";

import { buildFileEdges, type FileStructure } from "../extraction/roles.js";
import { rankSymbolsByCalls, countSymbolsByPath } from "../extraction/symbol-rank.js";

/**
  L1 输入是文件切片而非整份正文：排序后的符号条目（签名）、依赖方向与结构角色。
  切片是确定性的：同一份符号表与依赖图算出同一份切片，可直接当缓存键。
*/

export interface SliceEntry {
  name: string;
  kind: SymbolInfo["kind"];
  line: number;
  /** `name(参数)`；类与类型只给名字。 */
  signature: string;
}

export interface FileSlice {
  path: string;
  lines: number;
  role: FileRole;
  entries: SliceEntry[];
  /** 因条目预算被裁掉的符号数。 */
  omittedSymbols: number;
  /** 它依赖谁 / 谁依赖它，各取前若干条，按路径排序。 */
  dependsOn: string[];
  dependedOnBy: string[];
  /** 「摘要参考注释」开关打开时附带，见 extractHeaderComment。 */
  headerComment?: string;
}

/** 每文件进切片的符号条目上限。 */
export const MAX_SLICE_ENTRIES = 8;
/** 两个依赖方向各给的条数上限。 */
const MAX_SLICE_EDGES = 6;

/** headerComment 的字符上限。 */
export const MAX_HEADER_COMMENT_CHARS = 120;

/** 出现即整段跳过的样板注释特征。 */
const BOILERPLATE_PATTERN = /copyright|licen[cs]e|spdx|©/i;

/** 取第一段合格注释作文件自述：跳过样板段与标签行，清洗后不足 8 字则找下一段。 */
export function extractHeaderComment(path: string, text: string): string | undefined {
  const isPython = path.endsWith(".py");
  const spans: { start: number; body: string }[] = [];
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\/|"""[\s\S]*?"""/g)) {
    const before = text.slice(Math.max(0, match.index - 4), match.index);
    // 前面有 = 的三引号是字符串赋值，不是 docstring
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

/** 一次构建全仓文件切片；排序用全部入口，切片当缓存键，不随所选入口变。 */
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

