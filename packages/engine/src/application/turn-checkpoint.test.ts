import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnLoopState } from "../source/tool-loop.js";
import { withDatabase } from "../persistence/database.js";
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

    // 上限写的是字节，就得按字节判：汉字一份字符 ≈ 三个字节，字符数看着没超上限的快照其实早已超标
    const cjkHash = `${HASH}-cjk`;
    const cjk = state(1, "汉".repeat(Math.ceil(CHECKPOINT_MAX_BYTES / 2)));
    expect(Buffer.byteLength(JSON.stringify(cjk), "utf8")).toBeGreaterThan(CHECKPOINT_MAX_BYTES);
    c.save(cjkHash, cjk);
    expect(c.restore(cjkHash), "按字符数算会把这一份存下来，上限被悄悄放宽近三倍").toBeUndefined();
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

  it("等回答的那一档不参与哈希续跑：同一句原样重发绝不接上提问快照", () => {
    const c = channel("t9");
    c.save(HASH, state(1, "首问"), "await_user", { promptHash: "prompt-1", pendingToolCallId: "a1" });
    expect(c.restore(HASH), "点重发、断连重试走的都是哈希这条路：接上「等人回答」的快照等于把没答的提问再发一遍").toBeUndefined();
    expect(withDatabase(repository, (database) => database.claimTurnCheckpoint<TurnLoopState>("t9", "map.chat", "a1", "prompt-1")), "行还在，只是只许按认领取").toMatchObject({ round: 1 });
  });

  it("认领只比调用 id 与「模型 + 系统提示」的指纹，不比答句；认领一次即消费", () => {
    const c = channel("t10");
    c.save("首问的哈希", state(2, "首问"), "await_user", { promptHash: "prompt-1", pendingToolCallId: "a1" });
    expect(c.claimAsk?.("a1", "prompt-1"), "用户给的是选项，不是原问题——按输入哈希找永远找不到").toMatchObject({ round: 2 });
    expect(c.claimAsk?.("a1", "prompt-1"), "同一条提问不许被点两次接走两份状态").toBeUndefined();

    c.save("另一问的哈希", state(1, "首问"), "await_user", { promptHash: "prompt-1", pendingToolCallId: "a2" });
    expect(c.claimAsk?.("a2", "换了模型的指纹"), "换模型后接上旧回合，等于拿另一家的中间状态作答").toBeUndefined();
    expect(withDatabase(repository, (database) => database.turnCheckpointStats()).rows, "答了就等于关闭：核不上也要把行消费掉，别让下一回合再结算一次").toBe(0);
    c.save("又一问", state(1, "首问"), "await_user", { promptHash: "prompt-1", pendingToolCallId: "a3" });
    expect(c.claimAsk?.("别的调用 id", "prompt-1"), "对不上挂着的那条调用就不认，绝不退成全清或猜一条").toBeUndefined();
  });

  it("等回答的残局同样过 TTL：一句没人答的提问不该永久留在库里", () => {
    channel("t11").save(HASH, state(1, "首问"), "await_user", { promptHash: "prompt-1", pendingToolCallId: "a1" });
    expect(channel("t11", "map.chat", -1).claimAsk?.("a1", "prompt-1")).toBeUndefined();
    expect(withDatabase(repository, (database) => database.turnCheckpointStats()).rows).toBe(0);
  });
});
