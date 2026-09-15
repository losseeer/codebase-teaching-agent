import type { RepositoryAnalysis, SymbolInfo } from "@codebase-tutor/shared";

/**
  调用图邻接：把依赖图里的调用边翻译成「它调用谁 / 谁调用它 / 同文件符号定义位置」的文本段。

  为什么需要它：锚点摘录回答的是「代码长什么样」，调用邻接回答「该去哪儿找」——
  真正相关的代码常常不在锚点附近（跨文件的调用方、被调函数、类型定义），
  模型需要先知道邻接清单才能定向读取。只给路径与符号名（不给源码），成本是路径清单级别。
  */

const MAX_CALL_ENTRIES = 8;
const MAX_LOCAL_SYMBOLS = 12;

export interface CallNeighborhood {
  /** 本文件里的符号调用了谁（文件:符号，去重后按字典序） */
  callsOut: string[];
  /** 谁调用了本文件里的符号（文件:符号，去重后按字典序） */
  callsIn: string[];
  /** 去重前的目标总数（超过上限时调用方可提示「等 N 项」） */
  callsOutTotal: number;
  callsInTotal: number;
  /** 同文件符号定义位置（用于定位，不含源码） */
  localSymbols: { name: string; kind: SymbolInfo["kind"]; line: number; endLine: number }[];
}

export function callNeighborhood(analysis: RepositoryAnalysis, path: string): CallNeighborhood {
  const symbols = analysis.graph.symbols;
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  // 调用边里的 callerSymbol / calleeSymbol 是符号 id（symbol:路径:名字:行号），翻译成人类可读的 路径:名字
  const label = (symbolId: string | undefined, fallbackPath: string): string => {
    const symbol = symbolId ? byId.get(symbolId) : undefined;
    return symbol ? `${symbol.path}:${symbol.name}` : fallbackPath;
  };
  const from = new Set<string>();
  const to = new Set<string>();
  for (const call of analysis.graph.calls) {
    if (call.callerPath === path) from.add(label(call.calleeSymbol, call.calleePath));
    if (call.calleePath === path) to.add(label(call.callerSymbol, call.callerPath));
  }
  const callsOut = [...from].sort();
  const callsIn = [...to].sort();
  return {
    callsOut: callsOut.slice(0, MAX_CALL_ENTRIES),
    callsIn: callsIn.slice(0, MAX_CALL_ENTRIES),
    callsOutTotal: callsOut.length,
    callsInTotal: callsIn.length,
    localSymbols: symbols
      .filter((symbol) => symbol.path === path)
      .slice(0, MAX_LOCAL_SYMBOLS)
      .map((symbol) => ({ name: symbol.name, kind: symbol.kind, line: symbol.line, endLine: symbol.endLine }))
  };
}

/** 渲染成 prompt 段落；没有可说的内容时返回空串（调用方跳过该段）。 */
export function callNeighborhoodSection(analysis: RepositoryAnalysis, path: string): string {
  const neighborhood = callNeighborhood(analysis, path);
  const lines: string[] = [];
  if (neighborhood.callsOut.length) {
    const more = neighborhood.callsOutTotal > neighborhood.callsOut.length ? `…等 ${neighborhood.callsOutTotal} 项` : "";
    lines.push(`它调用：${neighborhood.callsOut.join("、")}${more}`);
  }
  if (neighborhood.callsIn.length) {
    const more = neighborhood.callsInTotal > neighborhood.callsIn.length ? `…等 ${neighborhood.callsInTotal} 项` : "";
    lines.push(`调用它的：${neighborhood.callsIn.join("、")}${more}`);
  }
  if (neighborhood.localSymbols.length) {
    lines.push(`同文件符号位置：${neighborhood.localSymbols.map((symbol) => `${symbol.name}（${symbol.kind}）:${symbol.line}-${symbol.endLine}`).join("、")}`);
  }
  return lines.length ? `调用关系（${path}）：\n${lines.join("\n")}` : "";
}
