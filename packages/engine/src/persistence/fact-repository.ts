import type Database from "better-sqlite3";
import type { FactKind } from "@codebase-tutor/domain";

/**
  文件级静态产物（表 `static_fact`）：一类产物 × 一个文件 = 一行，一行一个 JSON。
  四类产物（cfg / entryCandidates / typeRelations / registry）都由 `facts/build.ts` 现算现写，
  不进任何缓存键——它们是「算出来的事实」，不是「按口径缓存的判断」。
  事务与 `replaceAll` 的语义在这里：整批是全集时才删已消失文件的行，增量重算只动这批文件。
*/
export class FactRepository {
  constructor(private readonly db: Database.Database) {}

  /** 写一批。`replaceAll` = 这批是该产物的全集（删掉已消失文件的行）；不传则只按文件增改，其余文件的产物保持有效。 */
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

  /** 整类产物按文件路径归堆（读侧与报表用；一行一文件，不必解析整仓的大 JSON）。 */
  listByKind<T>(repositoryId: string, kind: FactKind): Map<string, T> {
    const rows = this.db.prepare("SELECT path, payload FROM static_fact WHERE repository_id = ? AND kind = ? ORDER BY path").all(repositoryId, kind) as { path: string; payload: string }[];
    return new Map(rows.map((row) => [row.path, JSON.parse(row.payload) as T]));
  }

  /** 某类产物各占多少文件、总共多少字节——「这项没做过」与「做了但都是空」在这里分开。 */
  coverage(repositoryId: string): { kind: FactKind; files: number; bytes: number }[] {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS files, SUM(LENGTH(payload)) AS bytes FROM static_fact WHERE repository_id = ? GROUP BY kind ORDER BY kind").all(repositoryId) as { kind: string; files: number; bytes: number }[];
    return rows.map((row) => ({ kind: row.kind as FactKind, files: row.files, bytes: row.bytes ?? 0 }));
  }

  /** 各批产物的计算时间（`lastAt` 是这一类最近一次重算）：给读侧说清「读数比代码旧多久」。 */
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
