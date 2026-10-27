/**
  端口（ports）：模块「需要外部能力」这件事的形状，只声明它真正调用的那几格。
  这一层是内层：`http → application（除 port）→ 管线 → application/port → domain` 里，
  只有它是所有内侧模块都能直接依赖的——管线要声明自己的存储与模型口，而守卫禁止管线认识应用层，
  所以守卫为此单开一个口子（`architecture.test.ts` 那条规则里写明只许 `application/port`）。
  这里的文件零依赖（最多引 domain 的类型），也不 import 任何实现方：
  实现（`persistence/*-repository.ts`、`llm/provider.ts`、`sandbox/*`）反过来不必认识这里，
  结构对齐由注入点（use-case / importer）的赋值检查。
*/

/**
  L1 文件摘要的存取口。实现是 `persistence/summary-repository.ts`（表 `summaries`），
  但摘要流水线不该认识 SQLite 句柄：它只需要「按键取一份、写一份」。
  缓存键的组成（切片指纹 × 模型版本 × 口径开关）仍由摘要侧算——那是它的判断，不是存储的细节。
*/
export interface SummaryStore {
  get<T extends { path: string; summary: string }>(cacheKey: string): T | undefined;
  /** 整份记录一次写全：`summaries.created_at` 每次写入都取当下，读侧据此认「最近被确认的时间」。 */
  put(cacheKey: string, value: { path: string; summary: string }): void;
}
