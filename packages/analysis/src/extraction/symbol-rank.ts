import type { CallEdge, SymbolInfo } from "@codebase-tutor/domain";

/** 文件内符号排序的统一口径：入口直接调用优先，再按符号级调用入度，末尾回到声明序与名字。 */
export function rankSymbolsByCalls(
  symbols: SymbolInfo[],
  calls: CallEdge[],
  entryPaths: string[],
  limit: number
): Map<string, SymbolInfo[]> {
  const inDegree = new Map<string, number>();
  const calledByEntry = new Set<string>();
  const entries = new Set(entryPaths);
  for (const call of calls) {
    if (!call.calleeSymbol) continue;
    inDegree.set(call.calleeSymbol, (inDegree.get(call.calleeSymbol) ?? 0) + 1);
    if (entries.has(call.callerPath)) calledByEntry.add(call.calleeSymbol);
  }
  const byPath = new Map<string, SymbolInfo[]>();
  for (const symbol of symbols) byPath.set(symbol.path, [...(byPath.get(symbol.path) ?? []), symbol]);
  const ranked = new Map<string, SymbolInfo[]>();
  for (const [path, list] of byPath) {
    const ordered = [...list].sort((left, right) =>
      Number(calledByEntry.has(right.id)) - Number(calledByEntry.has(left.id))
      || (inDegree.get(right.id) ?? 0) - (inDegree.get(left.id) ?? 0)
      || left.line - right.line
      || left.name.localeCompare(right.name));
    const kept: SymbolInfo[] = [];
    const seen = new Set<string>();
    for (const symbol of ordered) {
      if (seen.has(symbol.name)) continue;
      seen.add(symbol.name);
      kept.push(symbol);
      if (kept.length >= limit) break;
    }
    ranked.set(path, kept);
  }
  return ranked;
}

/** 每个文件的符号总数：表达「这个文件还有多少没被展示」。 */
export function countSymbolsByPath(symbols: SymbolInfo[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol.path, (counts.get(symbol.path) ?? 0) + 1);
  return counts;
}

