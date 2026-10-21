import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnLoopState } from "../source/tool-loop.js";
import { withDatabase } from "../store/database.js";
import { CHECKPOINT_MAX_BYTES, turnCheckpointChannel } from "../application/turn-checkpoint.js";

/**
  回合检查点通道的口径（LangGraph 的 checkpoint 语义 + 三条保留规则）。
  这里只管「存得下、认得出同一问题、收尾就清掉、过期会瘦」；什么时候写由工具循环的用例守。
*/

const state = (rounds: number, marker: string): TurnLoopState => ({
  messages: [{ role: "user", content: marker }, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: "{}" }] }, { role: "tool", toolCallId: "c1", content: "文件 a.ts（第 1-2 行）：\n1| x" }],
  rounds,
  succeededReads: 1,
  crossReads: 0,
  externalCalls: 0,
  fileReads: [{ path: "a.ts", lines: 2, truncated: false, denied: false }],
  codeSearches: [],
  skillReads: [],
  mcpCalls: []
});

describe("回合检查点通道", () => {
  let repository: string;
  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-checkpoint-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  const channel = (threadId: string, scene = "map.chat", ttlMs?: number) => turnCheckpointChannel({ repositoryPath: repository, threadId, scene, ...(ttlMs === undefined ? {} : { ttlMs }) });
  const HASH = "abc123";

  it("写一轮读一轮：取的是最近那个 super-step，读回来带得续跑的审计", () => {
    const c = channel("t1");
    c.save(HASH, state(1, "首问"));
    expect(c.restore(HASH)).toMatchObject({ round: 1 });
    c.save(HASH, state(2, "首问"));
    const restored = c.restore(HASH);
    expect(restored?.round, "续跑要接在最后一条之后，不是第一条").toBe(2);
    expect(restored?.state.fileReads.map((read) => read.path), "已经读过的文件必须跟着状态回来，否则这一回合会重付一遍").toEqual(["a.ts"]);
    expect(restored?.state.messages).toHaveLength(3);
  });

  it("不是同一个问题就不续跑：inputHash 对不上时残局留着也不接", () => {
    const c = channel("t2");
    c.save(HASH, state(1, "首问"));
    expect(c.restore("别的提问的哈希"), "换个提问接上别人的中间状态等于答非所问").toBeUndefined();
  });

  it("收尾与作废都清空：留着的行只该是没人收尾的残局", () => {
    const c = channel("t3");
    c.save(HASH, state(1, "首问"));
    c.clear();
    expect(c.restore(HASH)).toBeUndefined();
  });

  it("异常退出写下原因，读回来仍认得出这是残局", () => {
    const c = channel("t4");
    c.save(HASH, state(1, "首问"), "error");
    expect(withDatabase(repository, (database) => database.latestTurnCheckpoint<TurnLoopState>("t4", "map.chat", HASH))?.stoppedReason).toBe("error");
  });

  it("过期的残局在下一次读时被清掉：隔了半天的续跑多半已经换话题", () => {
    const c = channel("t5");
    c.save(HASH, state(1, "首问"));
    expect(c.restore(HASH)).toBeDefined();
    expect(channel("t5", "map.chat", -1).restore(HASH), "TTL 调到负数就是全都算过期").toBeUndefined();
    expect(withDatabase(repository, (database) => database.turnCheckpointStats()).rows, "过期行要真删掉，不是读的时候跳过").toBe(0);
  });

  it("场景之间不串：同一个线程在宏观设计与代码问答里各有一份进度", () => {
    channel("t6", "map.chat").save(HASH, state(1, "首问"));
    expect(channel("t6", "teaching.turn").restore(HASH)).toBeUndefined();
  });

  it("超过单份上限的快照干脆不存：续跑是可选优化，不该把库撑爆", () => {
    const c = channel("t7");
    const huge = state(1, "x".repeat(CHECKPOINT_MAX_BYTES + 10));
    c.save(HASH, huge);
    expect(c.restore(HASH)).toBeUndefined();
    expect(withDatabase(repository, (database) => database.turnCheckpointStats()).rows).toBe(0);
  });

  it("没有线程就没有续跑的对象：三个动作全是空操作", () => {
    const c = turnCheckpointChannel({ repositoryPath: repository, threadId: "", scene: "map.chat" });
    c.save(HASH, state(1, "首问"));
    expect(c.restore(HASH)).toBeUndefined();
    expect(() => c.clear()).not.toThrow();
  });

  it("形状对不上的旧残局（改了消息结构之后的历史行）不拿来发请求", () => {
    withDatabase(repository, (database) => database.saveTurnCheckpoint({ threadId: "t8", scene: "map.chat", round: 1, inputHash: HASH, payload: { rounds: 1 } }));
    expect(channel("t8").restore(HASH)).toBeUndefined();
  });
});
