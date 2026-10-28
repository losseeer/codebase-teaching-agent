import type Database from "better-sqlite3";

/** `turn_checkpoint` 唯一的读写口，一个 super-step 一行；续跑判据不在这一层。 */
export class CheckpointRepository {
  constructor(private readonly db: Database.Database) {}

  /** 一个 round 一行；等待答句那档才同时写 `promptHash` 与 `pendingToolCallId`。 */
  save(input: { threadId: string; scene: string; round: number; inputHash: string; promptHash?: string; stoppedReason?: string; pendingToolCallId?: string; payload: unknown }): void {
    this.db.prepare("INSERT OR REPLACE INTO turn_checkpoint(thread_id, scene, round, input_hash, prompt_hash, stopped_reason, pending_tool_call_id, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.threadId, input.scene, input.round, input.inputHash, input.promptHash ?? null, input.stoppedReason ?? null, input.pendingToolCallId ?? null, JSON.stringify(input.payload), Date.now());
  }

  /** 该线程最近一轮；`inputHash` 不合或 `await_user` 档返回 `undefined`。 */
  latest<T>(threadId: string, scene: string, inputHash: string): { round: number; stoppedReason?: string; payload: T } | undefined {
    const row = this.db.prepare("SELECT round, stopped_reason, payload, input_hash FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND COALESCE(stopped_reason, '') <> 'await_user' ORDER BY round DESC LIMIT 1")
      .get(threadId, scene) as { round: number; stopped_reason: string | null; payload: string; input_hash: string } | undefined;
    if (!row || row.input_hash !== inputHash) return undefined;
    return { round: row.round, ...(row.stopped_reason ? { stoppedReason: row.stopped_reason } : {}), payload: JSON.parse(row.payload) as T };
  }

  /** 认领一句提问：按挂起的调用 id 取，取到即删；`promptHash` 不合返回 `undefined`。 */
  claim<T>(threadId: string, scene: string, pendingToolCallId: string, promptHash: string): { round: number; payload: T } | undefined {
    const row = this.db.prepare("SELECT round, payload, prompt_hash FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id = ? ORDER BY round DESC LIMIT 1")
      .get(threadId, scene, pendingToolCallId) as { round: number; payload: string; prompt_hash: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id = ?").run(threadId, scene, pendingToolCallId);
    if (row.prompt_hash !== promptHash) return undefined;
    return { round: row.round, payload: JSON.parse(row.payload) as T };
  }

  /** 结算该线程挂起的提问，取出即删；`keepPendingToolCallId` 那一条留给 `claim`。 */
  settleAsks(threadId: string, scene: string, olderThan: number, keepPendingToolCallId?: string): { pendingToolCallId: string; cause: "expired" | "new_question" }[] {
    const rows = this.db.prepare("SELECT round, pending_tool_call_id, updated_at FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id IS NOT NULL ORDER BY round DESC")
      .all(threadId, scene) as { pending_tool_call_id: string; updated_at: number }[];
    const remove = this.db.prepare("DELETE FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id = ?");
    const settled: { pendingToolCallId: string; cause: "expired" | "new_question" }[] = [];
    for (const row of rows) {
      if (row.pending_tool_call_id === keepPendingToolCallId) continue;
      settled.push({ pendingToolCallId: row.pending_tool_call_id, cause: row.updated_at < olderThan ? "expired" : "new_question" });
      remove.run(threadId, scene, row.pending_tool_call_id);
    }
    return settled;
  }

  clear(threadId: string, scene: string): number {
    return this.db.prepare("DELETE FROM turn_checkpoint WHERE thread_id = ? AND scene = ?").run(threadId, scene).changes;
  }

  /** 按 TTL 删除过期检查点。 */
  prune(olderThan: number): number {
    return this.db.prepare("DELETE FROM turn_checkpoint WHERE updated_at < ?").run(olderThan).changes;
  }

  /** 现存行数与最旧一行的时间戳。 */
  stats(): { rows: number; oldestAt: number | null } {
    const row = this.db.prepare("SELECT COUNT(*) AS rows, MIN(updated_at) AS oldest_at FROM turn_checkpoint").get() as { rows: number; oldest_at: number | null };
    return { rows: row.rows, oldestAt: row.oldest_at ?? null };
  }
}
