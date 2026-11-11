import type { SourceAnchor } from "./repository-index.js";

/**
  依赖图的类型定义：符号、类型派发边、仓外裸包名与符号抽取方式。
*/
export interface SymbolInfo {
  id: string;
  name: string;
  /** `type` = 接口/类型别名/枚举这类只有声明没有可执行体的名字；`method` = 类或对象里的方法。 */
  kind: "function" | "class" | "method" | "variable" | "type";
  path: string;
  line: number;
  endLine: number;
  parameters: string[];
  language: "typescript" | "python" | "java" | "go" | "rust" | "csharp" | "cpp" | "other";
  type?: string;
  referenceCount?: number;
}

export interface CallEdge {
  callerPath: string;
  callerSymbol?: string;
  calleePath: string;
  calleeSymbol?: string;
  line: number;
}

/** 类型派发边：实现/子类文件 → 被扩展类型文件；Java/C# 靠它接回实现类，TS/Python 不产；supertypePath 是近似证据。 */
export interface TypeDispatchEdge {
  subtypePath: string;
  supertypePath: string;
  kind: "implements" | "extends";
  line: number;
}

export interface DependencyGraphData {
  imports: Record<string, string[]>;
  /** 仓内解析不到的裸包名，供「边界之外」栏展示；不新增边、不入缓存键，字段缺失按「未采集」处理。 */
  externals?: Record<string, string[]>;
  calls: CallEdge[];
  /** 类型派发边；产物没有这个字段时按空表处理。 */
  dispatch?: TypeDispatchEdge[];
  symbols: SymbolInfo[];
  entrypoints: SourceAnchor[];
  semanticBackend: "lsp" | "static";
  lspStatus: { language: "typescript" | "python"; status: "available" | "fallback"; reason?: string }[];
  /** 符号抽取路径：ast = 语法树，regex = 回落匹配；字段缺失按 regex 处理。 */
  parseBackend?: "ast" | "regex";
  parseBackendReason?: string;
}

export interface ImpactResult {
  changedPaths: string[];
  impactedPaths: string[];
  edges: { from: string; to: string; kind: "import" | "call" }[];
}
