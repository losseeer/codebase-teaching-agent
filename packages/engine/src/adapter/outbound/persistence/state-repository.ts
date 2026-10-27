import type Database from "better-sqlite3";
import type { ImportEstimate, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

/**
  一份产物的四格状态（表 `repository_state`）：索引、导入估算、依赖图产物、每仓设置。
  四格各自独立写：一次重分析只换 `index_json` / `analysis_json`，不该顺手重写估算与设置——
  所以「只写这次给出来的那几列」是这张表的根本语义，判分与读侧看到的设置才不会被一次重烧悄悄改掉。
*/
export class StateRepository {
  constructor(private readonly db: Database.Database) {}

  saveIndex(index: RepositoryIndex): void {
    this.upsert(index.repositoryId, { index: JSON.stringify(index) });
  }

  saveEstimate(repositoryId: string, estimate: ImportEstimate): void {
    this.upsert(repositoryId, { estimate: JSON.stringify(estimate) });
  }

  saveAnalysis(analysis: RepositoryAnalysis): void {
    this.upsert(analysis.repositoryId, { analysis: JSON.stringify(analysis) });
  }

  saveSettings(repositoryId: string, settings: Record<string, unknown>): void {
    this.upsert(repositoryId, { settings: JSON.stringify(settings) });
  }

  index(repositoryId: string): RepositoryIndex | undefined {
    const value = this.jsonColumn(repositoryId, "index_json");
    return value ? JSON.parse(value) as RepositoryIndex : undefined;
  }

  estimate(repositoryId: string): ImportEstimate | undefined {
    const value = this.jsonColumn(repositoryId, "estimate_json");
    return value ? JSON.parse(value) as ImportEstimate : undefined;
  }

  analysis(repositoryId: string): RepositoryAnalysis | undefined {
    const value = this.jsonColumn(repositoryId, "analysis_json");
    return value ? JSON.parse(value) as RepositoryAnalysis : undefined;
  }

  settings<T extends Record<string, unknown>>(repositoryId: string): T | undefined {
    const value = this.jsonColumn(repositoryId, "settings_json");
    return value ? JSON.parse(value) as T : undefined;
  }

  /**
    一次只取要的那一列：analysis_json 是大仓里最重的一块，整行捞取会让轻读付重代价。
    列名取自这张表固定的四个，不接受外部字符串，拼进 SQL 不构成注入面。
    */
  private jsonColumn(repositoryId: string, column: "index_json" | "estimate_json" | "analysis_json" | "settings_json"): string | null | undefined {
    const row = this.db.prepare(`SELECT ${column} AS value FROM repository_state WHERE repository_id = ?`).get(repositoryId) as { value: string | null } | undefined;
    return row?.value;
  }

  /**
    只写这次给出来的那几列：ON CONFLICT DO UPDATE 只碰给了值的列，其余留在原地不动。
    列名从这张表固定的四个键里查，外部字符串进不了 SQL。
    */
  private upsert(repositoryId: string, patch: { index?: string; estimate?: string; analysis?: string; settings?: string }): void {
    const columnOf = { index: "index_json", estimate: "estimate_json", analysis: "analysis_json", settings: "settings_json" } as const;
    const keys = (Object.keys(columnOf) as (keyof typeof columnOf)[]).filter((key) => patch[key] !== undefined);
    if (!keys.length) return;
    const columns = keys.map((key) => columnOf[key]).join(", ");
    const assignments = keys.map((key) => `${columnOf[key]} = excluded.${columnOf[key]}`).join(", ");
    this.db.prepare(`INSERT INTO repository_state(repository_id, updated_at, ${columns})
      VALUES (?, ?, ${keys.map(() => "?").join(", ")})
      ON CONFLICT(repository_id) DO UPDATE SET updated_at = excluded.updated_at, ${assignments}`)
      .run(repositoryId, new Date().toISOString(), ...keys.map((key) => patch[key]));
  }
}
