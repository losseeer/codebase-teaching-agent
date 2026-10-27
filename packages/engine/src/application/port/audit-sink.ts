import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";

/**
  审计线的写入口：只写不读（读是另一件事，见 `ProgressStore.mastery`）。
  管线要记的就是「发生了什么」，不该知道它落在哪个文件、用什么形状追加——
  那两处知道一次，就多一处只有运行时才炸的耦合。
*/
export interface AuditSink {
  append(type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string): void;
}
