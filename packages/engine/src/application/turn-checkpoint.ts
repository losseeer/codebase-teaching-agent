import type { TurnCheckpointChannel, TurnLoopState } from "../source/tool-loop.js";
import { traceEngine } from "@codebase-tutor/platform";
import { withDatabase } from "../store/database.js";

/**
  回合检查点通道的装配（照 LangGraph 的 checkpoint：一个 super-step 一份快照，同一线程续跑）。
  通道本身是工具循环的契约，住应用层：持久层只管一行 JSON，不该认识「消息」「读文件审计」这些领域形状。
  住在被学习仓自己的 `.tutor/` 库里，与 journal 同一信任边界——快照里含读过的源码正文，
  而那些正文本来就已经出过一次网（发给了模型），本地这份不比它更外泄。

  三条保留规则（检查点膨胀是 LangGraph 的同款代价，靠这三条压住）：
  - 回合正常收尾 → 删；用户主动停止 → 删（那一轮按作废收尾，替他续跑是违背意图）；
  - 只有异常退出留下 `stopped_reason=error` 的残局，供同线程同问题的下一次请求接上；
    预算到线或轮次用完的中断另留一档 `interrupted`：同样等同一句重发，因为它也没有成品；
    刀 2 的 `await_user`（等用户回答一句提问）不许被哈希那条路命中，那时 `restore` 要按这一格分档；
  - 超过 `CHECKPOINT_TTL_MS` 的残局在任何一次读写前顺手清掉；单份快照超过 `CHECKPOINT_MAX_BYTES` 干脆不存。
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
          database.pruneTurnCheckpoints(Date.now() - (input.ttlMs ?? CHECKPOINT_TTL_MS));
          const row = database.latestTurnCheckpoint<TurnLoopState>(threadId, scene, inputHash);
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
          database.pruneTurnCheckpoints(Date.now() - (input.ttlMs ?? CHECKPOINT_TTL_MS));
          const row = database.claimTurnCheckpoint<TurnLoopState>(threadId, scene, pendingToolCallId, promptHash);
          if (!row || !Array.isArray(row.payload.messages) || !row.payload.messages.length) return undefined;
          return { round: row.round, state: row.payload };
        });
      } catch (error) {
        traceEngine("degrade", { component: "turn_checkpoint", action: "claim_ask", cause: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    },
    save: (inputHash, state, stoppedReason, ask) => {
      // 上限按字节判（`CHECKPOINT_MAX_BYTES`）：`JSON.stringify().length` 数的是 UTF-16 字符，
      // 快照里的源码与中文注释多字节占大头，按字符算会把上限悄悄放宽近三倍。
      const size = Buffer.byteLength(JSON.stringify(state), "utf8");
      if (size > CHECKPOINT_MAX_BYTES) {
        traceEngine("degrade", { component: "turn_checkpoint", action: "skip", cause: `快照 ${size} 字节超过上限 ${CHECKPOINT_MAX_BYTES}，这一轮没存` });
        return;
      }
      try {
        withDatabase(repositoryPath, (database) => database.saveTurnCheckpoint({
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
        withDatabase(repositoryPath, (database) => database.clearTurnCheckpoints(threadId, scene));
      } catch (error) {
        traceEngine("degrade", { component: "turn_checkpoint", action: "clear", cause: error instanceof Error ? error.message : String(error) });
      }
    }
  };
}
