import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushJournalQueue, queueJournalEvent, type JournalPost } from "./transport";

/** 投递失败口径：网络错与 5xx 留队补发，4xx 丢弃，发送串行。 */

const RETRY_KEY = "codebase-tutor.journal-retry";
const post = (index: number): JournalPost => ({ repositoryId: "repo_x", type: "file_opened", payload: { path: `src/${String(index)}.ts` }, sessionId: "s1" });

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value)
  };
}

const respond = (status: number, error?: string) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ error }) });

let queue: string[] = [];

beforeEach(() => {
  queue = [];
  vi.stubGlobal("localStorage", fakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 按脚本回状态码的假 fetch，同时把发出的顺序记下来。 */
function stubFetch(byIndex: (index: number) => number): void {
  let sent = 0;
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    const index = sent;
    sent += 1;
    const body = JSON.parse(String(init?.body)) as { type: string; payload: { path: string } };
    queue.push(`${body.type}:${body.payload.path}:${decodeURIComponent(String(url).split("/")[3])}`);
    return respond(byIndex(index));
  });
}

describe("发不出去的时候", () => {
  it("网络断了就入队，等下一次补发成功再出队", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", async () => {
      attempt += 1;
      if (attempt === 1) return respond(503, "引擎忙");
      return respond(200);
    });
    await queueJournalEvent(post(1));
    expect(JSON.parse(String(localStorage.getItem(RETRY_KEY))) as JournalPost[]).toHaveLength(1);
    await flushJournalQueue();
    expect(localStorage.getItem(RETRY_KEY)).toBeNull();
  });

  it("5xx 留队、4xx 丢弃：一条永远不被接受的记录不该占着补发队列", async () => {
    stubFetch(() => 400);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await queueJournalEvent(post(2));
    expect(localStorage.getItem(RETRY_KEY)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("被引擎拒收"));
    warn.mockRestore();
    error.mockRestore();
  });

  it("补发队列里混着一条永远 400 的：只丢那一条，其余照样补发", async () => {
    localStorage.setItem(RETRY_KEY, JSON.stringify([post(3), post(4), post(5)]));
    stubFetch((index) => (index === 1 ? 400 : 200));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await flushJournalQueue();
    expect(localStorage.getItem(RETRY_KEY)).toBeNull();
    expect(queue).toHaveLength(3);
    error.mockRestore();
  });

  it("队列本身是坏 JSON 就丢弃重建：它只是缓冲，不是事实来源", async () => {
    localStorage.setItem(RETRY_KEY, "{ 坏掉的");
    stubFetch(() => 200);
    await flushJournalQueue();
    expect(queue).toEqual([]);
    await queueJournalEvent(post(6));
    expect(queue).toHaveLength(1);
  });

  it("积压到上限就丢最早的一条并告警：本地重试只兜短暂断连，不做无限积压", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("连不上"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let index = 0; index < 52; index += 1) await queueJournalEvent(post(index));
    const queued = JSON.parse(String(localStorage.getItem(RETRY_KEY))) as JournalPost[];
    expect(queued).toHaveLength(50);
    expect(queued[0]?.payload.path).toBe("src/2.ts");
    expect(queued.at(-1)?.payload.path).toBe("src/51.ts");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("丢弃最早一条"));
    warn.mockRestore();
  });
});

describe("顺序", () => {
  it("补发排在前面、新事件排在后面：审计线的 append 顺序等于用户动作顺序", async () => {
    localStorage.setItem(RETRY_KEY, JSON.stringify([post(101), post(102)]));
    stubFetch(() => 200);
    const fresh = post(103);
    const first = queueJournalEvent(fresh);
    await first;
    expect(queue.map((entry) => entry.split(":")[1])).toEqual(["src/101.ts", "src/102.ts", "src/103.ts"]);
  });

  it("两条几乎同时的事件也必须串行发出去（旧的 flushing 布尔会让第二条插队）", async () => {
    let running = 0;
    let overlapped = false;
    vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
      running += 1;
      if (running > 1) overlapped = true;
      queue.push(String(JSON.parse(String(init?.body)).payload.path));
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return respond(200);
    });
    await Promise.all([queueJournalEvent(post(201)), queueJournalEvent(post(202)), queueJournalEvent(post(203))]);
    expect(overlapped).toBe(false);
    expect(queue).toEqual(["src/201.ts", "src/202.ts", "src/203.ts"]);
  });

  it("一条事件发向它自己那个仓库，不是发向界面当前选中的那个", async () => {
    stubFetch(() => 200);
    await queueJournalEvent({ repositoryId: "repo_其他仓", type: "module_switched", payload: { id: "m1" } });
    expect(queue[0]?.endsWith(":repo_其他仓")).toBe(true);
  });
});
