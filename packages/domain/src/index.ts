/**
  共享内核：领域模型、常量与纯函数，零依赖，引擎与界面都可 import。
  跨进程的可校验形状（zod schema）在 `@codebase-tutor/contract`，它依赖本包，本包不依赖任何包。
*/

export * from "./dependency-graph.js";
export * from "./diagram.js";
export * from "./engine-trace.js";
export * from "./exercises.js";
export * from "./external-category.js";
export * from "./import-estimate.js";
export * from "./journal.js";
export * from "./language-capabilities.js";
export * from "./learner-profile.js";
export * from "./repository-analysis.js";
export * from "./repository-index.js";
export * from "./route-seams.js";
export * from "./static-facts.js";
export * from "./style-band.js";
export * from "./teaching-policy.js";
export * from "./tool-audit.js";
export * from "./tutor-settings.js";
