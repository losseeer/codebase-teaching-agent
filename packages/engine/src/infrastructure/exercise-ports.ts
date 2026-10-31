import type { ExercisePorts } from "../application/port/exercise-ports.js";
import type { PracticeRepository } from "../exercises/exercises.js";
import { deriveMastery } from "../learner/mastery.js";
import type { TutorDatabase } from "../adapter/outbound/persistence/database.js";
import { readJournal } from "../adapter/outbound/persistence/journal.js";
import type { RepositoryHandle } from "../adapter/outbound/persistence/repository-handle.js";

/**
  练习侧端口装配：由一个已挂载的仓句柄交出 store、progress、summaries、audit 四个口。
*/
export function exercisePortsFor(handle: RepositoryHandle, database: TutorDatabase): ExercisePorts {
  const repositoryId = handle.repositoryId;
  return {
    // repositoryId 由闭包带上，端口方法不带仓参数
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
    audit: handle.journal
  };
}

/** 仓视图＝path/index/analysis 加这次的端口。 */
export function practiceView(repository: { path: string; index: PracticeRepository["index"]; analysis: PracticeRepository["analysis"] }, ports: ExercisePorts): PracticeRepository {
  return { path: repository.path, index: repository.index, analysis: repository.analysis, ports };
}

/** 在 `pin()` 的范围内构造端口、交给回调，回调落地才 `unpin()`。 */
export async function withExercisePorts<T>(handle: RepositoryHandle, run: (ports: ExercisePorts, database: TutorDatabase) => T | Promise<T>): Promise<T> {
  const database = handle.pin();
  try {
    // run 可能返回 Promise，await 之后才走到 unpin
    return await run(exercisePortsFor(handle, database), database);
  } finally {
    handle.unpin();
  }
}
