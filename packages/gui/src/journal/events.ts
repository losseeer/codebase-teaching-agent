/**
  UI 侧可发射的 journal 事件——设计文档第 8 章「界面 × 数据契约」表里的「写（journal 事件）」列。

  **清单的真源在 shared（`UI_JOURNAL_EVENTS`），这里只是转出口**：同一张表还要被引擎的
  `POST /api/repositories/:id/journal` 用来拒绝越权写入——`file_read` / `code_egress` / `token_usage`
  这些由引擎写，界面发不出去（2026-10-12，见 §46）。前端留一份副本的话两边迟早对不上，
  而那时的表现是「界面点了按钮、审计线里没行」。

  边界（不要越界）：引擎侧事件（`unit_mastered` / `hint_depth` / `token_usage` / `file_read` …）
  由引擎在状态机与工具循环里写，**前端不得发射**——同一事实只写一处。
  同理 `style_shift` 由引擎写（`trigger: manual | session_created`），本模块不发射。
  */
export { UI_JOURNAL_EVENTS } from "@codebase-tutor/shared";
export type { UiJournalEventType } from "@codebase-tutor/shared";
