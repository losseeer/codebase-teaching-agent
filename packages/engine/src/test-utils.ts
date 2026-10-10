import type { SymbolInfo } from "@codebase-tutor/shared";

/**
  测试夹具：符号对象字面量在多个测试文件里反复出现同一套 id 模板（`symbol:${path}:${name}:${line}`）
  与默认值（`kind:"function"`、`parameters:[]`）。这里集中一份，各测试只补差异字段（line/endLine/language/kind/parameters）。
  */
export function makeSymbol(
  path: string,
  name: string,
  options: { line?: number; endLine?: number; kind?: SymbolInfo["kind"]; parameters?: string[]; language?: SymbolInfo["language"] } = {}
): SymbolInfo {
  const line = options.line ?? 1;
  return {
    id: `symbol:${path}:${name}:${line}`,
    name,
    kind: options.kind ?? "function",
    path,
    line,
    endLine: options.endLine ?? line + 2,
    parameters: options.parameters ?? [],
    language: options.language ?? "typescript"
  };
}
