/**
  UI 侧可发射的 journal 事件转出口。清单真源在 shared 的 `UI_JOURNAL_EVENTS`，此处不留副本。
  引擎侧事件（`file_read` / `code_egress` / `token_usage` / `unit_mastered` / `hint_depth` /
  `style_shift`）由引擎在状态机与工具循环里写，前端不得发射。
  */
export { UI_JOURNAL_EVENTS } from "@codebase-tutor/shared";
export type { UiJournalEventType } from "@codebase-tutor/shared";
