import { extname } from "node:path";
import type { SymbolInfo } from "@codebase-tutor/domain";

import { extractSymbolsFromAst } from "./parser.js";
import { tsFamilyExtensions } from "../ingestion/language-extensions.js";

/** 符号抽取：优先语法树，未就绪或无语法时回落逐行匹配；两条路的 `SymbolInfo` 口径一致。 */
export function extractSymbols(path: string, content: string): SymbolInfo[] {
  return extractSymbolsFromAst(path, content) ?? extractSymbolsWithRegex(path, content);
}

function extractSymbolsWithRegex(path: string, content: string): SymbolInfo[] {
  const extension = extname(path);
  const language = extension === ".py" ? "python" : tsFamilyExtensions.has(extension) ? "typescript" : "other";
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = language === "python"
      ? line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/)
      : line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>|^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (!match) continue;
    const name = match[1] ?? match[3] ?? match[5];
    const rawParameters = match[2] ?? match[4] ?? "";
    const kind: SymbolInfo["kind"] = match[5] ? "class" : "function";
    symbols.push({ id: `symbol:${path}:${name}:${index + 1}`, name, kind, path, line: index + 1, endLine: findEndLine(lines, index, language), parameters: rawParameters.split(",").map((value) => value.trim()).filter(Boolean), language });
  }
  return symbols;
}

function findEndLine(lines: string[], start: number, language: SymbolInfo["language"]): number {
  if (language === "python") {
    const indentation = lines[start].match(/^\s*/)?.[0].length ?? 0;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index].trim() && (lines[index].match(/^\s*/)?.[0].length ?? 0) <= indentation) return index;
    }
    return lines.length;
  }
  let balance = 0;
  for (let index = start; index < Math.min(lines.length, start + 200); index += 1) {
    const opens = (lines[index].match(/{/g) ?? []).length;
    balance += opens - (lines[index].match(/}/g) ?? []).length;
    if (balance > 0) continue;
    // 花括号归零：这行闭合了函数体，或本来是无花括号声明
    if (index > start || opens > 0) return index + 1;
    // 无花括号声明到本行为止，但本行以 `=>` 收尾时函数体在下一行
    if (!/=>\s*$/.test(lines[index])) return start + 1;
  }
  return Math.min(lines.length, start + 1);
}

