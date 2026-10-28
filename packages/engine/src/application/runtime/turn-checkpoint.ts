import type { TurnCheckpointChannel, TurnLoopState } from "../../source/tool-loop.js";
import { traceEngine } from "@codebase-tutor/platform";
import { withDatabase } from "../../adapter/outbound/persistence/database.js";

/**
  回合检查点通道的装配：一个工具轮一份快照，同一线程续跑。
  残局只在异常退出、预算或轮次中断、等用户回答三种情况下留下；正常收尾与用户主动停止都删行。
  超过 `CHECKPOINT_TTL_MS` 的残局在任何读写前清掉；单份快照超过 `CHECKPOINT_MAX_BYTES` 不存。
*/

/** 残局的保留时长，超过即在任何读写前清掉。 */
export const CHECKPOINT_TTL_MS = 6 * 60 * 60 * 1000;
/** 单份快照的字节上限，超过则本轮不存。 */
export const CHECKPOINT_MAX_BYTES = 4_000_000;

export function turnCheckpointChannel(input: {
  repositoryPath: string;
  threadId: string;
  scene: string;
  /** 为 `false` 或没有线程时，通道的每个动作都是空操作。 */
  enabled?: boolean;
  /** 残局保留时长；省略 = `CHECKPOINT_TTL_MS`。 */
  ttlMs?: number;
}): TurnCheckpointChannel {
  const { repositoryPath, threadId, scene } = input;
  if (input.enabled === false || !threadId) {
    return { restore: () => undefined, claimAsk: () => undefined, save: () => undefined, clear: () => undefined };
  }
  return {
    restore: (inputHash) => {
      try {
        return withDatabase(repositoryPath, (database) => {
          database.checkpoints.prune(Date.now() - (input.ttlMs ?? CHECKPOINT_TTL_MS));
          const row = database.checkpoints.latest<TurnLoopState>(threadId, scene, inputHash);
          // messages 形状对不上的旧行，当作没有残局。
          if (!row || !Array.isArray(row.payload.messages) || !row.payload.messages.length) return undefined;
          return { round: row.round, state: row.payload };
        });
      } catch (error) {
        traceEngine("degrade", { component: "turn_checkpoint", action: "restore", cause: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    },
    claimAsk: (pendingToolCallId, promptHash) => {
      try {
        return withDatabase(repositoryPath, (database) => {
          database.checkpoints.prune(Date.now() - (input.ttlMs ?? CHECKPOINT_TTL_MS));
          const row = database.checkpoints.claim<TurnLoopState>(threadId, scene, pendingToolCallId, promptHash);
          if (!row || !Array.isArray(row.payload.messages) || !row.payload.messages.length) return undefined;
          return { round: row.round, state: row.payload };
        });
      } catch (error) {
        traceEngine("degrade", { component: "turn_checkpoint", action: "claim_ask", cause: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    },
    save: (inputHash, state, stoppedReason, ask) => {
      // 上限按字节判，不按字符数。
      const size = Buffer.byteLength(JSON.stringify(state), "utf8");
      if (size > CHECKPOINT_MAX_BYTES) {
        traceEngine("degrade", { component: "turn_checkpoint", action: "skip", cause: `快照 ${size} 字节超过上限 ${CHECKPOINT_MAX_BYTES}，这一轮没存` });
        return;
      }
      try {
        withDatabase(repositoryPath, (database) => database.checkpoints.save({
          threadId,
          scene,
          round: state.rounds,
          inputHash,
          ...(stoppedReason ? { stoppedReason } : {}),
          ...(ask ? { promptHash: ask.promptHash, pendingToolCallId: ask.pendingToolCallId } : {}),
          payload: state
        }));
      } catch (error) {
        traceEngine("degrade", { component: "turn_checkpoint", action: "save", cause: error instanceof Error ? error.message : String(error) });
      }
    },
    clear: () => {
      try {
        withDatabase(repositoryPath, (database) => database.checkpoints.clear(threadId, scene));
      } catch (error) {
        traceEngine("degrade", { component: "turn_checkpoint", action: "clear", cause: error instanceof Error ? error.message : String(error) });
      }
    }
  };
}
