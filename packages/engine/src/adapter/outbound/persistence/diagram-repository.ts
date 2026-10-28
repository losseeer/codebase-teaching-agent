import type Database from "better-sqlite3";

/** 一张图的行形状；`payload` 存整份图的 JSON。 */
export interface DiagramRow {
  name: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  payload: string;
}

/** 清单行：比单张多一个 `diagramId`。 */
export interface DiagramListRow extends DiagramRow {
  diagramId: string;
}

/** 表 `diagram` 的语句层；列一律 `AS` 成驼峰名以对上返回类型的键名。 */
export class DiagramRepository {
  constructor(private readonly db: Database.Database) {}

  /** 一仓的所有图，最近更新在前。 */
  list(repositoryId: string): DiagramListRow[] {
    return this.db.prepare("SELECT diagram_id AS diagramId, name, source, created_at AS createdAt, updated_at AS updatedAt, payload FROM diagram WHERE repository_id = ? ORDER BY updated_at DESC").all(repositoryId) as DiagramListRow[];
  }

  byId(repositoryId: string, diagramId: string): DiagramRow | undefined {
    return this.db.prepare("SELECT name, source, created_at AS createdAt, updated_at AS updatedAt, payload FROM diagram WHERE repository_id = ? AND diagram_id = ?").get(repositoryId, diagramId) as DiagramRow | undefined;
  }

  put(repositoryId: string, diagramId: string, row: { name: string; source: string; createdAt: number; updatedAt: number; payload: unknown }): void {
    this.db.prepare("INSERT OR REPLACE INTO diagram(repository_id, diagram_id, name, source, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(repositoryId, diagramId, row.name, row.source, row.createdAt, row.updatedAt, JSON.stringify(row.payload));
  }

  remove(repositoryId: string, diagramId: string): void {
    this.db.prepare("DELETE FROM diagram WHERE repository_id = ? AND diagram_id = ?").run(repositoryId, diagramId);
  }
}
