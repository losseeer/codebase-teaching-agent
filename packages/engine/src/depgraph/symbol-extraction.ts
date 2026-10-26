import { extname } from "node:path";
import type { SymbolInfo } from "@codebase-tutor/domain";

import { extractSymbolsFromAst } from "./parser.js";
import { tsFamilyExtensions } from "./language-extensions.js";

/**
  符号抽取：优先语法树；解析器未就绪或该扩展名没有语法时回落逐行匹配。
  两条路都给同一份 `SymbolInfo` 结构，`endLine` 都是「最后一行（含）」。
*/
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
    if (balance > 0) continue; // 还在函数体里
    // 花括号已归零：要么这行闭合了函数体（签名行开了括号，或已经走到签名行之后），要么是「无花括号」的声明
    if (index > start || opens > 0) return index + 1;
    // 无花括号的声明行（表达式体箭头函数 `const f = (a) => a + b`、单行 `function f(){return 1}`）就到本行为止；
    // 但若本行以 `=>` 收尾，函数体还在下一行（`const f = (a) =>\n  { … }`），不能在此收尾
    if (!/=>\s*$/.test(lines[index])) return start + 1;
  }
  return Math.min(lines.length, start + 1);
}
