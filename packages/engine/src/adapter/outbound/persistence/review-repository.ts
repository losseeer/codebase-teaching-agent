import type Database from "better-sqlite3";
import type { ReviewSchedule } from "@codebase-tutor/domain";

/** 表 `review_schedule`：一道题一行，SM-2 数据存整份 JSON。 */
export class ReviewRepository {
  constructor(private readonly db: Database.Database) {}

  get(repositoryId: string, exerciseId: string): ReviewSchedule | undefined {
    const row = this.db.prepare("SELECT schedule_json FROM review_schedule WHERE repository_id = ? AND exercise_id = ?").get(repositoryId, exerciseId) as { schedule_json: string } | undefined;
    return row ? JSON.parse(row.schedule_json) as ReviewSchedule : undefined;
  }

  /** 这一仓的全部排期。 */
  list(repositoryId: string): ReviewSchedule[] {
    const rows = this.db.prepare("SELECT schedule_json FROM review_schedule WHERE repository_id = ?").all(repositoryId) as { schedule_json: string }[];
    return rows.map((row) => JSON.parse(row.schedule_json) as ReviewSchedule);
  }

  save(repositoryId: string, schedule: ReviewSchedule): void {
    this.db.prepare("INSERT OR REPLACE INTO review_schedule(repository_id, exercise_id, unit_id, schedule_json, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(repositoryId, schedule.exerciseId, schedule.unitId, JSON.stringify(schedule), new Date().toISOString());
  }

  /** 删题时一并删掉它的复习排期，否则待复习里会留一条指向已删题的排期。 */
  remove(repositoryId: string, exerciseId: string): void {
    this.db.prepare("DELETE FROM review_schedule WHERE repository_id = ? AND exercise_id = ?").run(repositoryId, exerciseId);
  }
}
