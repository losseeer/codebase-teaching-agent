import type { MasteryRecord, ReviewSchedule } from "@codebase-tutor/domain";

/**
  复习排期与掌握度读数（表 `review_schedule` + 审计线推出来的那份掌握度），同样绑定一个仓。
  `mastery` 收在这一格里是有意的取舍：它是 `deriveMastery(readJournal(...))` 的结果，
  两个依赖都是别的模块的细节；出题侧要知道的只是「这个单元现在算不算学过」。
  适配器因此住应用层——那里同时引 learner 与持久层都不破例。
*/
export interface ProgressStore {
  list(): ReviewSchedule[];
  get(exerciseId: string): ReviewSchedule | undefined;
  save(schedule: ReviewSchedule): void;
  mastery(): MasteryRecord[];
}
