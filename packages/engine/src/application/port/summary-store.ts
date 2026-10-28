/** 端口层：只声明模块真正调用的那几格，不 import 实现方。 */

/** L1 文件摘要的存取口：只声明按键取一份、写一份。 */
export interface SummaryStore {
  get<T extends { path: string; summary: string }>(cacheKey: string): T | undefined;
  /** 整份记录一次写全；`summaries.created_at` 每次写入都取当下。 */
  put(cacheKey: string, value: { path: string; summary: string }): void;
  /** 每个文件最新的一句摘要；行数上限由存储侧控制。 */
  latest(): { path: string; summary: string }[];
}
