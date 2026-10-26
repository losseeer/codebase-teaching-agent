/**
  代码分析流水线：解析、符号与边、入口、图、静态事实。
  引擎只许从这一个出口取东西（深路径 import 由分层守卫拦）；要 DB 句柄或模型提供者的编排留在引擎侧。
*/

export * from "./depgraph/call-edges.js";
export * from "./depgraph/cpp-imports.js";
export * from "./depgraph/csharp-imports.js";
export * from "./depgraph/entrypoints.js";
export * from "./depgraph/external-catalog.js";
export * from "./depgraph/external-names.js";
export * from "./depgraph/go-imports.js";
export * from "./depgraph/graph.js";
export * from "./depgraph/impact-radius.js";
export * from "./depgraph/import-edges.js";
export * from "./depgraph/java-entrypoints.js";
export * from "./depgraph/java-types.js";
export * from "./depgraph/language-extensions.js";
export * from "./depgraph/lsp/client.js";
export * from "./depgraph/lsp/enrich.js";
export * from "./depgraph/neighbors.js";
export * from "./depgraph/node-entrypoints.js";
export * from "./depgraph/parser.js";
export * from "./depgraph/python-entrypoints.js";
export * from "./depgraph/python-imports.js";
export * from "./depgraph/repo-manifest.js";
export * from "./depgraph/repo-paths.js";
export * from "./depgraph/roles.js";
export * from "./depgraph/rust-imports.js";
export * from "./depgraph/script-imports.js";
export * from "./depgraph/serialization.js";
export * from "./depgraph/symbol-extraction.js";
export * from "./depgraph/symbol-rank.js";
export * from "./depgraph/url-routes.js";
export * from "./facts/cfg.js";
export * from "./facts/dataflow.js";
export * from "./facts/registration.js";
export * from "./facts/types.js";
export * from "./facts/version.js";
export * from "./indexer/ignore.js";
export * from "./summarizer/l1-slice.js";
