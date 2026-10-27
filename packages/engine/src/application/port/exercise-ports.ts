import type { AuditSink } from "./audit-sink.js";
import type { ExerciseStore } from "./exercise-store.js";
import type { ProgressStore } from "./progress-store.js";
import type { SummaryStore } from "./summary-store.js";

/**
  一次练习动作要用的外部能力，四个口一起交进去。
  名字用 `ports` 不用 `deps`：练习模块里 `deps` 已经是「一道题依赖的文件清单」（缓存键的轴），两个概念不能共用一个词。
  练习模块（`exercises/exercises.ts`）只认这四个口：不认 SQLite、不认 journal 文件、
  也不认「库现在开着」这件事——`pin()/unpin()` 是连接生命周期，留在装配它的那一层（见
  `application/exercise-ports.ts`）。
*/
export interface ExercisePorts {
  store: ExerciseStore;
  progress: ProgressStore;
  summaries: SummaryStore;
  audit: AuditSink;
}
