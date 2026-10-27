import type Database from "better-sqlite3";

/** chat_session 的行形状（snake_case 贴着表；域类型转换在 persistence/chat-store.ts）。 */
export interface ChatSessionRow {
  id: string;
  repository_id: string;
  scope: string;
  /** 教学作用域：`file:<path>` / `dir:<path>`；旧行的 course_node_id 不再读取。 */
  scope_ref: string | null;
  exercise_id: string | null;
  title: string;
  state_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ChatMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  error: string | null;
}

/**
  会话线程的两张表（`chat_session` / `chat_message`）的语句层。
  业务出入口是 `persistence/chat-store.ts`——id 与时间戳怎么生成、入参守卫、行 → 领域类型的转换都在那里，
  这里只把 SQL 说清楚。
  软删语义在这一层落实：所有读侧带 `deleted_at IS NULL`，「列表看不见」与「消息行仍在」同时成立。
*/
export class ChatRepository {
  constructor(private readonly db: Database.Database) {}

  insertSession(session: { id: string; repositoryId: string; scope: string; scopeRef: string | null; exerciseId: string | null; title: string; at: string }): void {
    this.db.prepare(`INSERT INTO chat_session(id, repository_id, scope, scope_ref, exercise_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.repositoryId, session.scope, session.scopeRef, session.exerciseId, session.title, session.at, session.at);
  }

  /** 按 id 取一行（已软删的行也回：调用方看 `deleted_at` 自己判，删除的幂等判据在这里成立）。 */
  session(sessionId: string): ChatSessionRow | undefined {
    return this.db.prepare("SELECT id, repository_id, scope, scope_ref, exercise_id, title, state_json, created_at, updated_at, deleted_at FROM chat_session WHERE id = ?").get(sessionId) as ChatSessionRow | undefined;
  }

  /**
    会话清单：只回**已经有正文**的线程，最近更新在前。
    零消息的 `chat_session` 行是正常中间态（新建先发行，第一条消息才落正文），但它不该进界面上的会话下拉——
    那里列的是「谈过的话」，不是「开着的空壳」。行本身留着不删：删行等于作废用户刚点的新建，而且界面还指着这个 id。
    `chat_message(session_id)` 上有索引，这条 EXISTS 不走全表。`limit` 兜住长期累积。
  */
  sessions(repositoryId: string, scope: string, limit = 100): ChatSessionRow[] {
    return this.db.prepare(`SELECT s.id, s.repository_id, s.scope, s.scope_ref, s.exercise_id, s.title, s.state_json, s.created_at, s.updated_at, s.deleted_at
      FROM chat_session s
      WHERE s.repository_id = ? AND s.scope = ? AND s.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM chat_message m WHERE m.session_id = s.id)
      ORDER BY s.updated_at DESC LIMIT ?`)
      .all(repositoryId, scope, limit) as ChatSessionRow[];
  }

  touchSession(sessionId: string, at: string): void {
    this.db.prepare("UPDATE chat_session SET updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, sessionId);
  }

  /** 问答线程的设置快照：续接会话时用同一套设置开下一轮。 */
  saveState(sessionId: string, stateJson: string): void {
    this.db.prepare("UPDATE chat_session SET state_json = ? WHERE id = ? AND deleted_at IS NULL").run(stateJson, sessionId);
  }

  renameSession(sessionId: string, title: string, at: string): number {
    const result = this.db.prepare("UPDATE chat_session SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(title, at, sessionId);
    return result.changes;
  }

  /** 软删：只打时间戳，消息行与会话行都留在库里。已删的再删返回 0 行（幂等判据由调用方看 changes）。 */
  softDelete(sessionId: string, at: string): number {
    const result = this.db.prepare("UPDATE chat_session SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, sessionId);
    return result.changes;
  }

  /** 正文行入库。stage 是遗留列，一律不写不读，留着不迁移。 */
  insertMessage(message: { id: string; sessionId: string; role: string; content: string; createdAt: string; error: string | null }): void {
    this.db.prepare("INSERT INTO chat_message(id, session_id, role, content, created_at, error) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, message.sessionId, message.role, message.content, message.createdAt, message.error);
  }

  /**
    取会话正文：未删会话才有内容（会话已删时调用方拿到空数组，等于「这个会话不存在」）。
    给了 `limit` 就是尾窗语义——先倒序取最近 limit 条再反转回升序，调用方拿到的永远是时间正序。
    定序用 `rowid`（SQLite 插入序）而不是 `id`：id 是随机 UUID，按它排会把同一回合的 user/assistant 排反。
  */
  messages(sessionId: string, limit?: number): ChatMessageRow[] {
    const base = `SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.error
      FROM chat_message m JOIN chat_session s ON s.id = m.session_id
      WHERE m.session_id = ? AND s.deleted_at IS NULL`;
    if (!limit) {
      return this.db.prepare(`${base} ORDER BY m.rowid ASC`).all(sessionId) as ChatMessageRow[];
    }
    const tail = this.db.prepare(`${base} ORDER BY m.rowid DESC LIMIT ?`).all(sessionId, limit) as ChatMessageRow[];
    return tail.reverse();
  }

  /** 某会话的消息条数（含已软删会话的行——用于机检「删除只动标记，不动原文」）。 */
  countMessages(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chat_message WHERE session_id = ?").get(sessionId) as { count: number };
    return row.count;
  }
}
