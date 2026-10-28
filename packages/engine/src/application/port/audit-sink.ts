import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";

/** 审计线的写入口（只写不读）；`append` 返回写入的那一条。 */
export interface AuditSink {
  append(type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string): JournalEvent;
}

/** 审计线的读口：取出全部事件。 */
export interface AuditLine extends AuditSink {
  read(): JournalEvent[];
}
