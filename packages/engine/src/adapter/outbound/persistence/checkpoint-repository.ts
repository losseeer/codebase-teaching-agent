import type Database from "better-sqlite3";

/**
  回合检查点（表 `turn_checkpoint`，一个 super-step 一行）：进程被杀或端点报错后，同一线程的同一问题
  从这里接上，已经读过的源码不必再付一遍。
  这里是这张表唯一的读写口；「什么算同一个问题」「答了就算关闭」这些判据住在 `application/runtime/turn-checkpoint.ts`，
  它按线程与场景开合这条通道，不直接落 SQL。
*/
export class CheckpointRepository {
  constructor(private readonly db: Database.Database) {}

  /**
    同一回合的每一轮各写一行，续跑取最大 round 那行。
    `stoppedReason` 只在没走完那一次写：正常收尾走 `clear`，留着的行就是没人收尾的残局。
    `pendingToolCallId` + `promptHash` 只有「等用户回答一句提问」那一档才两个都有——认领走 `claim`，
    不走输入哈希（回灌的是用户的答句，本来就不是同一句话）。
  */
  save(input: { threadId: string; scene: string; round: number; inputHash: string; promptHash?: string; stoppedReason?: string; pendingToolCallId?: string; payload: unknown }): void {
    this.db.prepare("INSERT OR REPLACE INTO turn_checkpoint(thread_id, scene, round, input_hash, prompt_hash, stopped_reason, pending_tool_call_id, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.threadId, input.scene, input.round, input.inputHash, input.promptHash ?? null, input.stoppedReason ?? null, input.pendingToolCallId ?? null, JSON.stringify(input.payload), Date.now());
  }

  /**
    这个线程最近一轮的检查点；`inputHash` 对不上就不算「同一个问题」，宁可不续跑。
    等用户回答那档（`await_user`）在这里跳过：它等的下一句是答句、不是同一句话，
    让哈希那条路接上它就会「拿上一个问题的中间状态答这一句」，那正是这层一直防的事。
  */
  latest<T>(threadId: string, scene: string, inputHash: string): { round: number; stoppedReason?: string; payload: T } | undefined {
    const row = this.db.prepare("SELECT round, stopped_reason, payload, input_hash FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND COALESCE(stopped_reason, '') <> 'await_user' ORDER BY round DESC LIMIT 1")
      .get(threadId, scene) as { round: number; stopped_reason: string | null; payload: string; input_hash: string } | undefined;
    if (!row || row.input_hash !== inputHash) return undefined;
    return { round: row.round, ...(row.stopped_reason ? { stoppedReason: row.stopped_reason } : {}), payload: JSON.parse(row.payload) as T };
  }

  /**
    认领一句提问：按挂着的调用 id 取，**取到即删**——用户答了，这条提问就此关闭，哪怕指纹核不上、
    哪怕手滑点了第二次，都不该再被结算或被另一份状态接走。
    `promptHash`（模型与系统提示）核不上回 `undefined`：接上另一家的中间状态等于答非所问，调用方按「老实重跑」处理。
  */
  claim<T>(threadId: string, scene: string, pendingToolCallId: string, promptHash: string): { round: number; payload: T } | undefined {
    const row = this.db.prepare("SELECT round, payload, prompt_hash FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id = ? ORDER BY round DESC LIMIT 1")
      .get(threadId, scene, pendingToolCallId) as { round: number; payload: string; prompt_hash: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id = ?").run(threadId, scene, pendingToolCallId);
    if (row.prompt_hash !== promptHash) return undefined;
    return { round: row.round, payload: JSON.parse(row.payload) as T };
  }

  /**
    结算这条线程上挂着的提问：按 TTL 分成「过期」与「换话题」两档，**取出即删**——
    同一句提问不许在下一回合被再结算一次（报表里的 `discarded` 会因此翻倍）。
    `keepPendingToolCallId` 是这一句正要认领的那条：它不归这里管，留给 `claim` 去读。
  */
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

  /** 过期残局清理（TTL 是检查点膨胀的唯一解药；LangGraph 也要配 retention 同理）。 */
  prune(olderThan: number): number {
    return this.db.prepare("DELETE FROM turn_checkpoint WHERE updated_at < ?").run(olderThan).changes;
  }

  /** 检查点存量读数（报表用）：留了多少行、最旧的一行多久了。 */
  stats(): { rows: number; oldestAt: number | null } {
    const row = this.db.prepare("SELECT COUNT(*) AS rows, MIN(updated_at) AS oldest_at FROM turn_checkpoint").get() as { rows: number; oldest_at: number | null };
    return { rows: row.rows, oldestAt: row.oldest_at ?? null };
  }
}
