import type Database from "better-sqlite3";
import type { ImportEstimate, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

/** 表 `repository_state` 的四格状态：索引、导入估算、依赖图产物、每仓设置。 */
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

  /** 一次只取一列；列名取自这张表固定的四列。 */
  private jsonColumn(repositoryId: string, column: "index_json" | "estimate_json" | "analysis_json" | "settings_json"): string | null | undefined {
    const row = this.db.prepare(`SELECT ${column} AS value FROM repository_state WHERE repository_id = ?`).get(repositoryId) as { value: string | null } | undefined;
    return row?.value;
  }

  /** 只写这次给值的列，其余列留在原地；列名取自这张表固定的四列。 */
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
