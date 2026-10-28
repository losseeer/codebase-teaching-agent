import type Database from "better-sqlite3";
import type { FactKind } from "@codebase-tutor/domain";

/** 表 `static_fact`：一类产物 × 一个文件 = 一行，一行一个 JSON。 */
export class FactRepository {
  constructor(private readonly db: Database.Database) {}

  /** 写一批；`replaceAll` 表示这批是该产物的全集，先清该类再写。 */
  save(repositoryId: string, kind: FactKind, rows: { path: string; payload: unknown }[], options?: { replaceAll?: boolean }): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO static_fact(repository_id, kind, path, payload, at) VALUES (?, ?, ?, ?, ?)");
    const at = Date.now();
    const tx = this.db.transaction((batch: { path: string; payload: unknown }[]) => {
      if (options?.replaceAll) this.db.prepare("DELETE FROM static_fact WHERE repository_id = ? AND kind = ?").run(repositoryId, kind);
      for (const row of batch) insert.run(repositoryId, kind, row.path, JSON.stringify(row.payload), at);
    });
    tx(rows);
  }

  read<T>(repositoryId: string, kind: FactKind, path: string): T | undefined {
    const row = this.db.prepare("SELECT payload FROM static_fact WHERE repository_id = ? AND kind = ? AND path = ?").get(repositoryId, kind, path) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }

  /** 整类产物按文件路径归堆。 */
  listByKind<T>(repositoryId: string, kind: FactKind): Map<string, T> {
    const rows = this.db.prepare("SELECT path, payload FROM static_fact WHERE repository_id = ? AND kind = ? ORDER BY path").all(repositoryId, kind) as { path: string; payload: string }[];
    return new Map(rows.map((row) => [row.path, JSON.parse(row.payload) as T]));
  }

  /** 每类产物占多少文件、总共多少字节。 */
  coverage(repositoryId: string): { kind: FactKind; files: number; bytes: number }[] {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS files, SUM(LENGTH(payload)) AS bytes FROM static_fact WHERE repository_id = ? GROUP BY kind ORDER BY kind").all(repositoryId) as { kind: string; files: number; bytes: number }[];
    return rows.map((row) => ({ kind: row.kind as FactKind, files: row.files, bytes: row.bytes ?? 0 }));
  }

  /** 每类产物的文件数与最早、最近一次计算时间。 */
  stamps(repositoryId: string): { kind: FactKind; files: number; firstAt: number; lastAt: number }[] {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS files, MIN(at) AS first_at, MAX(at) AS last_at FROM static_fact WHERE repository_id = ? GROUP BY kind ORDER BY kind").all(repositoryId) as { kind: string; files: number; first_at: number; last_at: number }[];
    return rows.map((row) => ({ kind: row.kind as FactKind, files: row.files, firstAt: row.first_at, lastAt: row.last_at }));
  }

  drop(repositoryId: string, kind: FactKind, paths: string[]): void {
    if (!paths.length) return;
    const del = this.db.prepare("DELETE FROM static_fact WHERE repository_id = ? AND kind = ? AND path = ?");
    const tx = this.db.transaction((batch: string[]) => {
      for (const path of batch) del.run(repositoryId, kind, path);
    });
    tx(paths);
  }
}
