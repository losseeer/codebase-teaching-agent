import type { CallEdge, SymbolInfo } from "@codebase-tutor/shared";

/**
  文件内符号的排序——凡是「每文件只能留若干个符号」的地方都用这一份口径，
  避免流程证据与摘要切片各自排序、结果不一致。

  排序用两根轴：
  ① 被**入口文件**直接调用（`CallEdge.callerPath` 落在传入的入口集合里，执行链路上最近的一跳）；
  ② 符号级调用入度（`CallEdge.calleeSymbol` 精确到符号 id，不是按名字匹配）。
  最后回到声明序 + 名字，保证同输入同输出。

  入口轴优先于全局入度轴是有意的：对一个具体入口的执行流程来说，「这个入口用到了它」
  比「全仓很多地方引用它」更有信息量（否则公共配置模块会挤掉真正的链路函数）。

  截断前**按名字去重**：同名符号很常见（两个类各有 `__init__`），而按名字展示的地方
  重复的名字等于白占名额。
*/
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

/** 每个文件的符号总数（与排序无关，用来表达「这个文件还有多少没被展示」）。 */
export function countSymbolsByPath(symbols: SymbolInfo[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol.path, (counts.get(symbol.path) ?? 0) + 1);
  return counts;
}
