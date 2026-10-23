import type { DependencyGraphData, SymbolInfo } from "./dependency-graph.js";

export interface ImplementationUnit {
  id: string;
  symbol: SymbolInfo;
  summary: string;
  inputs: string[];
  output: string;
  invariants: string[];
  boundaries: string[];
  traps: string[];
}

export interface RepositoryAnalysis {
  repositoryId: string;
  generatedAt: string;
  graph: DependencyGraphData;
  implementations: ImplementationUnit[];
  versionStamp: string;
  /** 分析那一刻的 git HEAD（`git rev-parse HEAD`）。非 git 仓或取不到时默认；懒挂载用它与当前 HEAD 比对新鲜度。 */
  gitHead?: string;
  lastIncrementalUpdate?: { changedPaths: string[]; impactedPaths: string[]; at: string };
}
