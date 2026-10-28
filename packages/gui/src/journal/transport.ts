import type { TraceScalar } from "@codebase-tutor/domain";

import type { UiJournalEventType } from "./events";

/** journal 事件传输通道：POST /api/repositories/:id/journal；失败入 localStorage 重试队列。 */

const RETRY_KEY = "codebase-tutor.journal-retry";
/** 重试队列上限：超限丢最早一条。 */
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
    // 队列只是重试缓冲，损坏即丢弃重建
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

/** 4xx = 引擎明确拒收，丢弃；5xx 与网络错留队待补发。 */
function rejected(event: JournalSendError): boolean {
  return event.status >= 400 && event.status < 500;
}

/** 带状态码，区分 4xx 拒收与网络失败。 */
class JournalSendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 单条串行队列：append 顺序等于用户动作顺序。 */
let chain: Promise<unknown> = Promise.resolve();
function schedule(task: () => Promise<unknown>): Promise<void> {
  const result = chain.then(task, task);
  // 链上只挂吞掉结局的一份，链不断
  const settled = result.then(() => undefined, () => undefined);
  chain = settled;
  return settled;
}

/** 发送一条事件：网络失败入队重试，4xx 丢弃。 */
export async function postJournalEvent(post: JournalPost): Promise<void> {
  try {
    await send(post);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof JournalSendError && rejected(error)) {
      console.error(`[journal] 事件 ${post.type} 被引擎拒收（HTTP ${error.status}：${reason}），已丢弃，不进重试队列`);
      return;
    }
    console.warn(`[journal] 事件 ${post.type} 发送失败（已入重试队列）：${reason}`);
    enqueue(post);
  }
}

/** 重放积压：成功出队，4xx 丢弃，其余留队。 */
async function drain(): Promise<void> {
  const queue = readQueue();
  if (!queue.length) return;
  const remaining: JournalPost[] = [];
  for (const post of queue) {
    try {
      await send(post);
    } catch (error) {
      // 4xx 只丢当前这一条
      if (error instanceof JournalSendError && rejected(error)) {
        console.error(`[journal] 补发 ${post.type} 被拒收（HTTP ${error.status}），丢弃这一条`);
        continue;
      }
      remaining.push(post);
    }
  }
  writeQueue(remaining);
  if (remaining.length) console.warn(`[journal] 仍有 ${remaining.length} 条事件待重试`);
}

/** 补发积压；排在串行队列里，与新事件不争顺序。 */
export async function flushJournalQueue(): Promise<void> {
  return schedule(drain);
}

/** 新事件同走串行链：先补积压再发本条。 */
export async function queueJournalEvent(post: JournalPost): Promise<void> {
  return schedule(async () => {
    await drain();
    await postJournalEvent(post);
  });
}
