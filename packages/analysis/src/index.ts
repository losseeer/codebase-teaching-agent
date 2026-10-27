/**
  代码分析流水线：解析、符号与边、入口、图、静态事实。
  引擎只许从这一个出口取东西（深路径 import 由分层守卫拦）；要 DB 句柄或模型提供者的编排留在引擎侧。
*/

export * from "./resolution/call-edges.js";
export * from "./resolution/cpp-imports.js";
export * from "./resolution/csharp-imports.js";
export * from "./entrypoints/entrypoints.js";
export * from "./resolution/external-catalog.js";
export * from "./resolution/external-names.js";
export * from "./resolution/go-imports.js";
export * from "./graph/graph.js";
export * from "./graph/impact-radius.js";
export * from "./resolution/import-edges.js";
export * from "./entrypoints/java-entrypoints.js";
export * from "./resolution/java-types.js";
export * from "./ingestion/language-extensions.js";
export * from "./resolution/lsp/client.js";
export * from "./resolution/lsp/enrich.js";
export * from "./graph/neighbors.js";
export * from "./entrypoints/node-entrypoints.js";
export * from "./extraction/parser.js";
export * from "./entrypoints/python-entrypoints.js";
export * from "./resolution/python-imports.js";
export * from "./resolution/repo-manifest.js";
export * from "./resolution/repo-paths.js";
export * from "./extraction/roles.js";
export * from "./resolution/rust-imports.js";
export * from "./resolution/script-imports.js";
export * from "./graph/serialization.js";
export * from "./extraction/symbol-extraction.js";
export * from "./extraction/symbol-rank.js";
export * from "./entrypoints/url-routes.js";
export * from "./facts/cfg.js";
export * from "./facts/dataflow.js";
export * from "./facts/registration.js";
export * from "./facts/types.js";
export * from "./facts/version.js";
export * from "./ingestion/ignore.js";
export * from "./summarization/l1-slice.js";
