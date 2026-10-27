import type { ChatScope, ChatThread, ChatThreadMessage } from "@codebase-tutor/contract";
import type { TutorSettings } from "@codebase-tutor/domain";

/**
  会话线程的读写口（产品数据线，不是审计线），**绑定在一个库路径上**。
  线程住在它所属仓的 `chat_session` / `chat_message` 两张表里，而被 LRU 驱逐的仓也要能读自己留下的线程，
  所以这一格刻意不要求「先挂载」：按路径开口由挂载服务交出（`importer.chatStore(path)`），调用方只认这个接口。
  三条口径由实现方保证，用例侧不许再各写一遍：正文不截断（2000 字截断只属于审计线）、删除是软的、写不进要如实返回 `false`。
*/

/** 一条待写入的正文（用户问 / 助手答；`error` 是那一轮失败时也要留下的说明，不是异常路径的旁路）。 */
export interface NewMessage {
  role: "user" | "assistant";
  content: string;
  error?: string;
}

/** 教学线程的状态快照：只剩设置这一格（历史行里的多余键读侧忽略，不迁移）。 */
export interface TeachingThreadState {
  settings: TutorSettings;
}

export interface ChatStore {
  /** 建线程头。`id` 由调用方持有时传进来（教学作用域的那份来自 createSession），省略则由实现方现发。 */
  createThread(input: { repositoryId: string; scope: ChatScope; title?: string; scopeRef?: string; exerciseId?: string; id?: string }): ChatThread;
  /** 线程头；已软删的返回 `undefined`（调用方按「不存在」处理，不给界面区分两种形态的机会）。 */
  getThread(threadId: string): ChatThread | undefined;
  /** 会话清单：最近更新在前，且只含已有正文的线程。 */
  listThreads(repositoryId: string, scope: ChatScope, limit?: number): ChatThread[];
  /** 追加正文并续期排序键；线程不在或已软删返回 `false`——正文是不可恢复的产品数据，静默丢弃不许发生。 */
  appendMessages(threadId: string, messages: NewMessage[]): boolean;
  /** 宽松读：只保证形状对（settings 在场），逐字段归型留给 `validateSettings`。 */
  readThreadState(threadId: string): TeachingThreadState | undefined;
  /** 全量覆盖状态快照（回合收尾写；不动排序键）。已软删线程返回 `false`。 */
  saveThreadState(threadId: string, state: TeachingThreadState): boolean;
  /** 正文：`limit` 取最近 limit 条，仍按时间正序返回；已软删线程返回空数组。 */
  readMessages(threadId: string, limit?: number): ChatThreadMessage[];
  /** 改名：空标题或线程不存在/已删返回 `undefined`（路由据此回 400/404）。 */
  renameThread(threadId: string, title: string): ChatThread | undefined;
  /** 软删：返回是否真的删掉了一条未删线程（重复删第二次返回 `false`）。 */
  softDeleteThread(threadId: string): boolean;
}
