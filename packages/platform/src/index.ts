/**
  进程侧原语：身份与哈希、文件读取、词法切分、路径、trace 上下文与引擎日志。
  只依赖 node 内置与 `@codebase-tutor/domain`；界面不许 import 这个包（有守卫钉住）。
*/

export * from "./files.js";
export * from "./ids.js";
export * from "./paths.js";
export * from "./text.js";
export * from "./trace/context.js";
export * from "./trace/engine-log.js";
export * from "./trace/log-target.js";
