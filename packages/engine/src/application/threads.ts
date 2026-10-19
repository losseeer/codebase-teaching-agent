import type { ChatThread } from "@codebase-tutor/shared";
import { getThread } from "../store/chat-store.js";
import { importer } from "../services.js";

/** 会话线程的归属解析：把线程 id 解析到所属仓的库路径，与 HTTP 无关。 */

/**
  线程住在哪个仓的库里就读那个库，不能只看挂在内存里的那几个。
  挂载集有上限（`maxMounted()`），其余按 LRU 驱逐；被驱逐的仓只是不在内存，`.tutor/tutor.db` 不变。
  挂载集查不到就逐仓核地址簿，每条只开一次 SQLite（读完即关）、纯本地读、零 token。
  刻意不挂回该仓：路由只要库路径与仓 id（id 写在线程行上），挂回要多付一趟挂载的代价。
*/
export function locateThread(threadId: string): { repositoryPath: string; repositoryId: string; thread: ChatThread } | undefined {
  for (const repository of importer.mountedRepositories()) {
    const thread = getThread(repository.path, threadId);
    if (thread) return { repositoryPath: repository.path, repositoryId: repository.index.repositoryId, thread };
  }
  for (const entry of importer.catalog()) {
    if (entry.mounted || !entry.exists) continue;
    const thread = getThread(entry.repositoryPath, threadId);
    if (thread) return { repositoryPath: entry.repositoryPath, repositoryId: thread.repositoryId, thread };
  }
  return undefined;
}

export function threadJournalPayload(thread: ChatThread, reason: string): Record<string, string | null> {
  return { scope: thread.scope, thread_id: thread.id, node_id: thread.courseNodeId ?? null, exercise_id: thread.exerciseId ?? null, reason };
}
