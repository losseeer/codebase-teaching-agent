import type { SymbolInfo } from "@codebase-tutor/domain";

/** 测试夹具：集中符号对象的 id 模板与默认值，各测试只补差异字段。 */
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
