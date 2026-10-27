import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";

/**
  审计线的写入口：只写不读（读是另一件事，见 `ProgressStore.mastery`）。
  管线要记的就是「发生了什么」，不该知道它落在哪个文件、用什么形状追加——
  那两处知道一次，就多一处只有运行时才炸的耦合。
  返回写进去的那一条：外部 ingest 那条路要把回执原样交给调用方，不让它再拼一份形状。
*/
export interface AuditSink {
  append(type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string): JournalEvent;
}

/**
  同一件事的另一侧：审计线的读口。指标、掌握度、学习者画像、线程回放都从这里取整本事件。
  合在一个接口里而不是拆成两个格子，是因为它天然按「这一仓的那条线」一起交出：
  写的时候不必读，读的时候也不必假装在写。增量缓存与「什么算一行」的判据留在实现方，这里只声明形状。
  */
export interface AuditLine extends AuditSink {
  read(): JournalEvent[];
}
