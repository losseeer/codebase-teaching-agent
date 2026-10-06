import type { TraceScalar } from "@codebase-tutor/shared";
import type { UiJournalEventType } from "./events";

/**
  journal 事件的传输通道：`POST /api/repositories/:id/journal`。

  失败不静默：网络失败或非 2xx 都先 `console.warn` 再入 localStorage 重试队列——
  「缺事件的 UI 操作是设计漏洞」（设计文档第 8 章 PRINCIPLE 03），所以丢了必须看得见。
  */

const RETRY_KEY = "codebase-tutor.journal-retry";
/** 队列上限：本地重试只兜住短暂断连，不做无限积压（超限丢最早的一条并告警）。 */
const MAX_QUEUED = 50;

export interface JournalPost {
  repositoryId: string;
  type: UiJournalEventType;
  payload: Record<string, TraceScalar>;
  sessionId?: string;
}

function readQueue(): JournalPost[] {
  try {
    const raw = localStorage.getItem(RETRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as JournalPost[] : [];
  } catch {
    // 队列本身损坏就丢弃重建：它只是重试缓冲，不是事实来源
    return [];
  }
}

function writeQueue(queue: JournalPost[]): void {
  try {
    if (queue.length) localStorage.setItem(RETRY_KEY, JSON.stringify(queue));
    else localStorage.removeItem(RETRY_KEY);
  } catch (error) {
    console.warn(`[journal] 重试队列写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function enqueue(post: JournalPost): void {
  const queue = readQueue();
  queue.push(post);
  if (queue.length > MAX_QUEUED) console.warn(`[journal] 重试队列超过 ${MAX_QUEUED} 条，丢弃最早一条：${queue[0]?.type}`);
  writeQueue(queue.slice(-MAX_QUEUED));
}

async function send(post: JournalPost): Promise<void> {
  const response = await fetch(`/api/repositories/${encodeURIComponent(post.repositoryId)}/journal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: post.type, payload: post.payload, ...(post.sessionId ? { sessionId: post.sessionId } : {}) })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "" })) as { error?: string };
    throw new JournalSendError(response.status, body.error ?? `HTTP ${response.status}`);
  }
}

/** 带上状态码：4xx 是「引擎明确不收」，与「网络不通」必须区别对待（前者重试一万次也不会成功）。 */
class JournalSendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
  单条串行队列：每一次发送（含补发积压）都排到上一次之后再走。
  旧实现用 `flushing` 布尔做「并发只跑一次」，结果第二次 emit 直接跳过补发就发新事件
  ——`emit.ts` 那句「顺序即 append 顺序」就成了假话（2026-10-06 复审指出）。
*/
let chain: Promise<unknown> = Promise.resolve();
function schedule(task: () => Promise<unknown>): Promise<void> {
  const result = chain.then(task, task);
  chain = result.then(() => undefined, () => undefined);
  return result.then(() => undefined, () => undefined);
}

/** 发送一条事件；网络失败入队重试，引擎明确拒收（4xx）就丢掉并说清为什么。 */
export async function postJournalEvent(post: JournalPost): Promise<void> {
  try {
    await send(post);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof JournalSendError && error.status >= 400 && error.status < 500) {
      // 4xx = 这条事件本身不被接受（类型不在白名单、仓库没挂载）。留在队列里只会每轮重放、
      // 挤掉真正能补发的事件，所以丢弃，但要把丢弃说得查得回来。
      console.error(`[journal] 事件 ${post.type} 被引擎拒收（HTTP ${error.status}：${reason}），已丢弃，不进重试队列`);
      return;
    }
    console.warn(`[journal] 事件 ${post.type} 发送失败（已入重试队列）：${reason}`);
    enqueue(post);
  }
}

/** 重放 localStorage 里积压的事件；成功的出队、失败的留队。整体排在串行队列里，与新事件不争先后。 */
export async function flushJournalQueue(): Promise<void> {
  return schedule(async () => {
    const queue = readQueue();
    if (!queue.length) return;
    const remaining: JournalPost[] = [];
    for (const post of queue) {
      try {
        await send(post);
      } catch (error) {
        // 积压里也可能混着永远不会成功的 4xx：同样只丢这一条，别让它占着队列
        if (error instanceof JournalSendError && error.status >= 400 && error.status < 500) {
          console.error(`[journal] 补发 ${post.type} 被拒收（HTTP ${error.status}），丢弃这一条`);
          continue;
        }
        remaining.push(post);
      }
    }
    writeQueue(remaining);
    if (remaining.length) console.warn(`[journal] 仍有 ${remaining.length} 条事件待重试`);
  });
}

/** 新事件也走同一条串行链：补发在前、本条在后，顺序与用户动作一致。 */
export async function queueJournalEvent(post: JournalPost): Promise<void> {
  return schedule(() => postJournalEvent(post));
}
