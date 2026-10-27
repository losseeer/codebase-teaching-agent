/**
  端口（ports）：管线与用例「需要外部能力」这件事的形状，只写它们真正调用的那几格。
  住在这里而不是 `application/port/`：目标形态把那组接口放在应用层下，但本仓的分层守卫禁止
  「分析管线 → 应用层」，而恰恰是管线要声明自己的存储与模型口。放在这一层，两侧都能依赖它，
  一条既有规则都不必放宽：`http → application → 管线 → port → domain`。
  实现方（`persistence/*-repository.ts`、`llm/provider.ts`、`sandbox/*`）不 import 这里——
  那是「持久层反过来认识领域」那条守卫要拦的事；结构对齐由注入点（use-case / importer）的赋值检查。
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
