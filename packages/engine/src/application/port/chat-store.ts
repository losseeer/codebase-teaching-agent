import type { ChatScope, ChatThread, ChatThreadMessage } from "@codebase-tutor/contract";
import type { TutorSettings } from "@codebase-tutor/domain";

/**
  会话线程的读写口（产品数据线，不是审计线），绑定在一个库路径上。
  被 LRU 驱逐的仓同样可读，不要求先挂载。
  实现方保证：正文不截断、删除是软的、写不进时如实返回 `false`。
*/

/** 一条待写入的正文；`error` 是那一轮失败时同样写入的说明。 */
export interface NewMessage {
  role: "user" | "assistant";
  content: string;
  error?: string;
}

/** 教学线程的状态快照；历史行里的多余键读侧忽略。 */
export interface TeachingThreadState {
  settings: TutorSettings;
}

export interface ChatStore {
  /** 建线程头；`id` 省略则由实现方现发。 */
  createThread(input: { repositoryId: string; scope: ChatScope; title?: string; scopeRef?: string; exerciseId?: string; id?: string }): ChatThread;
  /** 取线程头；已软删的返回 `undefined`。 */
  getThread(threadId: string): ChatThread | undefined;
  /** 会话清单：最近更新在前，且只含已有正文的线程。 */
  listThreads(repositoryId: string, scope: ChatScope, limit?: number): ChatThread[];
  /** 追加正文并续期排序键；线程不在或已软删返回 `false`。 */
  appendMessages(threadId: string, messages: NewMessage[]): boolean;
  /** 宽松读：只保证 `settings` 在场，逐字段归型由 `validateSettings` 负责。 */
  readThreadState(threadId: string): TeachingThreadState | undefined;
  /** 全量覆盖状态快照，不动排序键；已软删线程返回 `false`。 */
  saveThreadState(threadId: string, state: TeachingThreadState): boolean;
  /** 正文：`limit` 取最近 limit 条，仍按时间正序返回；已软删线程返回空数组。 */
  readMessages(threadId: string, limit?: number): ChatThreadMessage[];
  /** 改名：空标题或线程不存在/已删返回 `undefined`。 */
  renameThread(threadId: string, title: string): ChatThread | undefined;
  /** 软删：重复删第二次返回 `false`。 */
  softDeleteThread(threadId: string): boolean;
}
