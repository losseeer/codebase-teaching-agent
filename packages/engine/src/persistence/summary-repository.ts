import type Database from "better-sqlite3";

/**
  摘要读取的行数上限：`summaries` 是只追加表（每个「切片 × 模型版本」一行），
  取「每个文件最新的一份」必须有个兜底行数，否则全表扫描随重烧次数线性变贵。
  同时导出给调用方做「达到上限」的判据，避免各处字面量分叉。
*/
export const LATEST_SUMMARY_LIMIT = 2_000;

/**
  L1 文件摘要（表 `summaries`）。`summary` 列是不透明 TEXT，内容是 JSON：
  读不出来一律当未命中重算，不猜、不补默认值。
  缓存键（切片 + 模型版本 + 口径）由 `summarizer/summarizer.ts` 算，这里只按键存取。
*/
export class SummaryRepository {
  constructor(private readonly db: Database.Database) {}

  get<T extends { path: string; summary: string }>(cacheKey: string): T | undefined {
    const row = this.db.prepare("SELECT summary FROM summaries WHERE cache_key = ?").get(cacheKey) as { summary: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.summary) as T;
      return parsed && typeof parsed === "object" && typeof parsed.path === "string" && typeof parsed.summary === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** `summaries.created_at` 每次写入都取当下（缓存命中也回写）：它是「最近一次被确认 / 刷新的时间」，不是首次生成时间。 */
  put(cacheKey: string, value: { path: string; summary: string }): void {
    this.db.prepare("INSERT OR REPLACE INTO summaries(cache_key, summary, created_at) VALUES (?, ?, ?)")
      .run(cacheKey, JSON.stringify(value), new Date().toISOString());
  }

  /**
    每个文件最新的摘要（缓存键含切片与模型版本，同一文件有多行）；按写入时间倒序取每个路径的首次出现。
    `limit` 兜住只追加表的全表扫描；取不到 = 该文件没有已确认的职责，调用方按未知处理。
  */
  latest(limit = LATEST_SUMMARY_LIMIT): { path: string; summary: string; role?: string; coverageLow?: boolean }[] {
    const rows = this.db.prepare("SELECT summary FROM summaries ORDER BY created_at DESC LIMIT ?").all(limit) as { summary: string }[];
    const latest = new Map<string, { path: string; summary: string; role?: string; coverageLow?: boolean }>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.summary) as { path?: unknown; summary?: unknown; role?: unknown; coverage?: { low?: unknown } };
        if (typeof parsed.path !== "string" || typeof parsed.summary !== "string" || latest.has(parsed.path)) continue;
        latest.set(parsed.path, {
          path: parsed.path,
          summary: parsed.summary,
          ...(typeof parsed.role === "string" ? { role: parsed.role } : {}),
          ...(typeof parsed.coverage?.low === "boolean" ? { coverageLow: parsed.coverage.low } : {})
        });
      } catch {
        // 非 JSON 行：跳过，当作没有这条摘要
      }
    }
    return [...latest.values()];
  }
}
