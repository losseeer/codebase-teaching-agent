/**
  UI 侧可发射的 journal 事件转出口。清单真源在 shared 的 `UI_JOURNAL_EVENTS`，此处不留副本。
  引擎侧事件（`file_read` / `code_egress` / `token_usage` / `style_shift` 等）由引擎在工具循环与
  审计链里写，前端不得发射；`unit_mastered` / `hint_depth` 等是历史事件，已无新生产者。
  */
export { UI_JOURNAL_EVENTS } from "@codebase-tutor/domain";
export type { UiJournalEventType } from "@codebase-tutor/domain";

