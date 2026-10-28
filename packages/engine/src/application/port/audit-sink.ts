import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";

/**
  审计线的写入口：只写不读。
  返回写进去的那一条，供 ingest 那条路把回执原样交给调用方。
*/
export interface AuditSink {
  append(type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string): JournalEvent;
}

/** 审计线的读口：指标、掌握度、画像、线程回放都从这里取整本事件。 */
export interface AuditLine extends AuditSink {
  read(): JournalEvent[];
}
