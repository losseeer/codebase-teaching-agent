import type { MasteryRecord, ReviewSchedule } from "@codebase-tutor/domain";

/** 复习排期与掌握度读数（表 `review_schedule` + 审计线推导的那份掌握度），绑定在一个仓上。 */
export interface ProgressStore {
  list(): ReviewSchedule[];
  get(exerciseId: string): ReviewSchedule | undefined;
  save(schedule: ReviewSchedule): void;
  remove(exerciseId: string): void;
  mastery(): MasteryRecord[];
}
