import type { ExercisePorts } from "./port/exercise-ports.js";
import type { PracticeRepository } from "../exercises/exercises.js";
import { deriveMastery } from "../learner/mastery.js";
import type { TutorDatabase } from "../persistence/database.js";
import { readJournal } from "../persistence/journal.js";
import type { RepositoryHandle } from "../persistence/repository-handle.js";

/**
  练习这条路的装配层：把「这一仓的库现在开着」翻译成练习侧要的四个口，用完就收回。
  住在这里而不是练习模块里，是因为它要同时认识持久层（四张表的 repository）、learner（掌握度从审计线推）
  与连接生命周期（引用计数）——这三样都不该出现在出题与判分的逻辑里。
*/
export function exercisePortsFor(handle: RepositoryHandle, database: TutorDatabase): ExercisePorts {
  const repositoryId = handle.repositoryId;
  return {
    // 端口都绑在这个仓上：闭包掉 repositoryId，练习侧每格少带一个参数，也少一次传错的机会
    store: {
      get: <T>(scope: string, kind: string, targetUnitId: string) => database.exercises.get<T>(repositoryId, scope, kind, targetUnitId),
      byId: <T>(exerciseId: string) => database.exercises.byId<T>(repositoryId, exerciseId),
      put: (scope, kind, targetUnitId, stored) => database.exercises.put(repositoryId, scope, kind, targetUnitId, stored)
    },
    progress: {
      list: () => database.reviews.list(repositoryId),
      get: (exerciseId) => database.reviews.get(repositoryId, exerciseId),
      save: (schedule) => database.reviews.save(repositoryId, schedule),
      mastery: () => deriveMastery(readJournal(handle.repositoryPath))
    },
    summaries: {
      get: <T extends { path: string; summary: string }>(cacheKey: string) => database.summaries.get<T>(cacheKey),
      put: (cacheKey, value) => database.summaries.put(cacheKey, value),
      latest: () => database.summaries.latest()
    },
    // 审计线跟着挂载走：它是这条仓的 append-only 线，不是一次性句柄
    audit: handle.journal
  };
}

/** 练习侧的仓视图：读的那三样原样带过去，能力那格由这次的端口填。 */
export function practiceView(repository: { path: string; index: PracticeRepository["index"]; analysis: PracticeRepository["analysis"] }, ports: ExercisePorts): PracticeRepository {
  return { path: repository.path, index: repository.index, analysis: repository.analysis, ports };
}

/**
  在 `pin()` 的范围内构造端口、交给回调，回调落地才 `unpin()`。
  引用计数不进端口：出题/判分/讲评各方法以前自己开自己关，四处 try/finally 各写一遍，
  现在这一层一处管完，服务方法只管用口。
*/
export async function withExercisePorts<T>(handle: RepositoryHandle, run: (ports: ExercisePorts) => T | Promise<T>): Promise<T> {
  const database = handle.pin();
  try {
    // 必须 await：这些方法全是异步的，同步收尾等于在模型还没答完时就把库关了
    return await run(exercisePortsFor(handle, database));
  } finally {
    handle.unpin();
  }
}
