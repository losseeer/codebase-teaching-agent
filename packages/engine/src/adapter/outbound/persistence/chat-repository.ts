import type Database from "better-sqlite3";

/** `chat_session` 的行形状，列名贴着表。 */
export interface ChatSessionRow {
  id: string;
  repository_id: string;
  scope: string;
  /** 形如 `file:<path>` 或 `dir:<path>`。 */
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

/** `chat_session` / `chat_message` 的语句层；读侧一律带 `deleted_at IS NULL`。 */
export class ChatRepository {
  constructor(private readonly db: Database.Database) {}

  insertSession(session: { id: string; repositoryId: string; scope: string; scopeRef: string | null; exerciseId: string | null; title: string; at: string }): void {
    this.db.prepare(`INSERT INTO chat_session(id, repository_id, scope, scope_ref, exercise_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.repositoryId, session.scope, session.scopeRef, session.exerciseId, session.title, session.at, session.at);
  }

  /** 按 id 取一行，含已软删的行。 */
  session(sessionId: string): ChatSessionRow | undefined {
    return this.db.prepare("SELECT id, repository_id, scope, scope_ref, exercise_id, title, state_json, created_at, updated_at, deleted_at FROM chat_session WHERE id = ?").get(sessionId) as ChatSessionRow | undefined;
  }

  /** 会话清单：未软删且已有正文，按最近更新在前。 */
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

  /** 写入会话的设置快照到 `state_json`。 */
  saveState(sessionId: string, stateJson: string): void {
    this.db.prepare("UPDATE chat_session SET state_json = ? WHERE id = ? AND deleted_at IS NULL").run(stateJson, sessionId);
  }

  renameSession(sessionId: string, title: string, at: string): number {
    const result = this.db.prepare("UPDATE chat_session SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(title, at, sessionId);
    return result.changes;
  }

  /** 软删：只写 `deleted_at`；已删的再删返回 0 行。 */
  softDelete(sessionId: string, at: string): number {
    const result = this.db.prepare("UPDATE chat_session SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, sessionId);
    return result.changes;
  }

  insertMessage(message: { id: string; sessionId: string; role: string; content: string; createdAt: string; error: string | null }): void {
    this.db.prepare("INSERT INTO chat_message(id, session_id, role, content, created_at, error) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, message.sessionId, message.role, message.content, message.createdAt, message.error);
  }

  /** 会话正文按时间正序返回；会话已删时为空；给了 `limit` 则取最近 `limit` 条。 */
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

  /** 某会话的消息条数，不按软删过滤。 */
  countMessages(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chat_message WHERE session_id = ?").get(sessionId) as { count: number };
    return row.count;
  }
}
