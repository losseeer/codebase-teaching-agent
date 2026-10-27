import type Database from "better-sqlite3";
import type { ReviewSchedule } from "@codebase-tutor/domain";

/**
  复习排期（表 `review_schedule`）：一道题一行，SM-2 的那几个数存整份 JSON。
  主键是 `(repository_id, exercise_id)`——排期跟着题走，不跟着作用域键走：
  换模型重烧出来的那道题是另一个 id，它的排期自然从头算，不该继承旧题的间隔。
  写入口只有判分那一步（`exercises/exercises.ts` 的 `answer`），所以这里不做读-合并-写。
*/
export class ReviewRepository {
  constructor(private readonly db: Database.Database) {}

  get(repositoryId: string, exerciseId: string): ReviewSchedule | undefined {
    const row = this.db.prepare("SELECT schedule_json FROM review_schedule WHERE repository_id = ? AND exercise_id = ?").get(repositoryId, exerciseId) as { schedule_json: string } | undefined;
    return row ? JSON.parse(row.schedule_json) as ReviewSchedule : undefined;
  }

  /** 这一仓的全部排期（练习页的「今天有几道到期」读数与到期题选择都从这里起）。 */
  list(repositoryId: string): ReviewSchedule[] {
    const rows = this.db.prepare("SELECT schedule_json FROM review_schedule WHERE repository_id = ?").all(repositoryId) as { schedule_json: string }[];
    return rows.map((row) => JSON.parse(row.schedule_json) as ReviewSchedule);
  }

  save(repositoryId: string, schedule: ReviewSchedule): void {
    this.db.prepare("INSERT OR REPLACE INTO review_schedule(repository_id, exercise_id, unit_id, schedule_json, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(repositoryId, schedule.exerciseId, schedule.unitId, JSON.stringify(schedule), new Date().toISOString());
  }
}
