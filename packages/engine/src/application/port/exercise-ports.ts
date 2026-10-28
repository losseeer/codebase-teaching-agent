import type { AuditSink } from "./audit-sink.js";
import type { ExerciseStore } from "./exercise-store.js";
import type { ProgressStore } from "./progress-store.js";
import type { SummaryStore } from "./summary-store.js";

/** 一次练习动作要用的外部能力：存储、进度、摘要、审计四个口一起交进去。 */
export interface ExercisePorts {
  store: ExerciseStore;
  progress: ProgressStore;
  summaries: SummaryStore;
  audit: AuditSink;
}
