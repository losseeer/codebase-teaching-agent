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
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
}

/** 发送一条事件；失败入队重试并告警（不抛给调用方——UI 操作不该因为日志失败而中断）。 */
export async function postJournalEvent(post: JournalPost): Promise<void> {
  try {
    await send(post);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[journal] 事件 ${post.type} 发送失败（已入重试队列）：${reason}`);
    enqueue(post);
  }
}

let flushing = false;

/** 重放 localStorage 里积压的事件；成功的出队、失败的留队。并发调用只跑一次。 */
export async function flushJournalQueue(): Promise<void> {
  if (flushing) return;
  const queue = readQueue();
  if (!queue.length) return;
  flushing = true;
  try {
    const remaining: JournalPost[] = [];
    for (const post of queue) {
      try {
        await send(post);
      } catch {
        remaining.push(post);
      }
    }
    writeQueue(remaining);
    if (remaining.length) console.warn(`[journal] 仍有 ${remaining.length} 条事件待重试`);
  } finally {
    flushing = false;
  }
}
