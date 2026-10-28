import type { TurnCheckpointChannel, TurnLoopState } from "../../source/tool-loop.js";
import { traceEngine } from "@codebase-tutor/platform";
import { withDatabase } from "../../adapter/outbound/persistence/database.js";

/**
  回合检查点通道的装配：一个工具轮一份快照，同一线程续跑；通道形状住应用层，持久层只管一行 JSON。
  残局只在异常退出、预算或轮次中断、等用户回答三种情况下留下；正常收尾与用户主动停止都删行。
  超过 `CHECKPOINT_TTL_MS` 的残局在任何读写前清掉；单份快照超过 `CHECKPOINT_MAX_BYTES` 不存。
*/

/** 残局多久就没人认：隔了半天的「接着上次想」多半已经换话题，续错比不续更糟。 */
export const CHECKPOINT_TTL_MS = 6 * 60 * 60 * 1000;
/** 单份快照的字节上限：一次 read_file 现在能回几十万字，超了就不存（续跑是可选优化，不该把库撑爆）。 */
export const CHECKPOINT_MAX_BYTES = 4_000_000;

export function turnCheckpointChannel(input: {
  repositoryPath: string;
  threadId: string;
  scene: string;
  /** 没线程就没有续跑的对象：单次提问走这条，通道所有动作都是空操作。 */
  enabled?: boolean;
  /** 残局保留多久；省略 = `CHECKPOINT_TTL_MS`。用例要靠它把「过期」变成可判的动作，而不是等时钟走。 */
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
          // 残局里的 messages 必须还能用：形状对不上（改了消息结构后的旧行）就当没有，别拿半截状态去发请求
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
      // 上限按字节判：快照里多字节字符占大头，按字符算会悄悄放宽近三倍。
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
