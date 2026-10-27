import type Database from "better-sqlite3";

/** 一张图的行形状。`payload` 是整份图（节点 / 连线 / 版本历史）的 JSON，解析成领域类型在 `persistence/diagrams.ts`。 */
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

/**
  画布上的一张图（表 `diagram`）。这张表只是存储：一张图的业务形状（名字去空白与撞名加序号、
  版本只能往前追加、恢复同样是追加一版）全在 `persistence/diagrams.ts`，那里是唯一业务读写口，这里只收 SQL。
  列一律 AS 成返回类型上的驼峰名：better-sqlite3 按 SQL 里写的列名交回键，
  类型是断言出来的、编译器不报，键名不一致到运行期才炸。
*/
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
