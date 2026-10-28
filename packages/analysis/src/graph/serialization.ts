import type { DependencyGraphData } from "@codebase-tutor/domain";

import type { DependencyGraph } from "./graph.js";

export function serializeGraph(graph: DependencyGraph): DependencyGraphData {
  return {
    imports: Object.fromEntries([...graph.imports.entries()]),
    externals: Object.fromEntries([...graph.externals.entries()]),
    calls: graph.calls,
    dispatch: graph.dispatch,
    symbols: graph.symbols,
    entrypoints: graph.entrypoints,
    semanticBackend: graph.semanticBackend,
    lspStatus: graph.lspStatus,
    parseBackend: graph.parseBackend,
    ...(graph.parseBackendReason ? { parseBackendReason: graph.parseBackendReason } : {})
  };
}

export function graphFromData(data: DependencyGraphData): DependencyGraph {
  return {
    imports: new Map(Object.entries(data.imports)),
    // 缺 externals 节点按「未采集」处理，不等于「无仓外引用」
    externals: new Map(Object.entries(data.externals ?? {})),
    calls: data.calls,
    // dispatch 缺省按空表处理
    dispatch: data.dispatch ?? [],
    symbols: data.symbols,
    entrypoints: data.entrypoints,
    semanticBackend: data.semanticBackend,
    lspStatus: data.lspStatus,
    // parseBackend 缺省按 regex 认
    parseBackend: data.parseBackend ?? "regex",
    ...(data.parseBackendReason ? { parseBackendReason: data.parseBackendReason } : {})
  };
}

