/**
  端口（ports）：模块需要外部能力时的形状，只声明真正调用的那几格。
  这一层零依赖（最多引 domain 的类型），不 import 任何实现方，实现方也不必认识这里。
  分层守卫为它单开口子：内侧模块只许依赖 `application/port`。
*/

/** L1 文件摘要的存取口：只声明按键取一份、写一份。 */
export interface SummaryStore {
  get<T extends { path: string; summary: string }>(cacheKey: string): T | undefined;
  /** 整份记录一次写全：`summaries.created_at` 每次写入都取当下，读侧据此认「最近被确认的时间」。 */
  put(cacheKey: string, value: { path: string; summary: string }): void;
  /** 每个文件最新的一句职责；行数上限是存储侧的自保。 */
  latest(): { path: string; summary: string }[];
}
