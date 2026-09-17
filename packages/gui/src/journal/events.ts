import type { JournalEventType } from "@codebase-tutor/shared";

/**
  UI 侧可发射的 journal 事件——设计文档第 8 章「界面 × 数据契约」表里的「写（journal 事件）」列。

  边界（不要越界）：引擎侧事件（`unit_mastered` / `hint_depth` / `token_usage` / `file_read` …）
  由引擎在状态机与工具循环里写，**前端不得发射**——同一事实只写一处。
  同理 `style_shift` 由引擎写（`trigger: manual | session_created`），本模块不发射。

  `satisfies` 是编译期的契约守卫：这里多写或改写任何取值，都会与 shared 的 `JournalEventType` 对不上而报错。
  */
export const UI_JOURNAL_EVENTS = [
  "flow_node_selected",
  "file_anchored",
  "file_opened",
  "line_located",
  "module_switched",
  "exercise_submitted",
  "repository_switched"
] as const satisfies readonly JournalEventType[];

export type UiJournalEventType = (typeof UI_JOURNAL_EVENTS)[number];
