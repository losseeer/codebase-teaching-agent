import type { DependencyGraphData } from "@codebase-tutor/shared";
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
    // 产物里没有 externals 节点时按「未采集」处理成空表：图读到空表要说「这份产物还没采外部依赖」，
    // 不能说「这个仓不碰任何外部服务」
    externals: new Map(Object.entries(data.externals ?? {})),
    calls: data.calls,
    // 产物里可能只有 import 与 call 两类关系：dispatch 缺省按空表处理，别硬造
    dispatch: data.dispatch ?? [],
    symbols: data.symbols,
    entrypoints: data.entrypoints,
    semanticBackend: data.semanticBackend,
    lspStatus: data.lspStatus,
    // parseBackend 缺省按 regex 认（逐行匹配产出的图），别假装是语法树结果
    parseBackend: data.parseBackend ?? "regex",
    ...(data.parseBackendReason ? { parseBackendReason: data.parseBackendReason } : {})
  };
}
