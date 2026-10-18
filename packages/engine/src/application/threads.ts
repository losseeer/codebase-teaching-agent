import type { ChatThread } from "@codebase-tutor/shared";
import { getThread } from "../store/chat-store.js";
import { importer } from "../services.js";

/**
  会话线程的归属解析。三条线程路由（取正文 / 改名 / 删除）都先要回答「这个线程 id 住在哪个仓的库里」，
  这件事与 HTTP 无关，所以从 `server.ts` 搬出来一份。
*/

/**
  线程住在**哪个仓的库**里，就读那个库——不能只看挂在内存里的那几个。
  挂载集有上限（`maxMounted()`，其余按 LRU 驱逐），而被驱逐的仓只是不在内存，它的 `.tutor/tutor.db` 一字未动。
  过去这三条线程路由只扫挂载集，于是切够几次仓再点开旧对话，就得到一句「会话不存在或已删除」，
  改名和删除也跟着 404——库里明明还在。兜法是把地址簿逐仓核一趟：每条只开一次 SQLite（读完即关）、纯本地读，零 token。
  ⚠️ 这里**刻意不挂回该仓**：三条路由要的只是库路径与仓 id（id 就写在线程行上），
  挂回来反而会把「产物读不动」误报成「会话没了」，还为一次读历史付一趟挂载的代价。
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
