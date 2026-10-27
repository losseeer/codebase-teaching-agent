import type { DiagramWriteContext } from "../diagram/set-diagram.js";
import type { ImportedRepository } from "../importer/importer.js";
import { diagramWriteContextFor } from "./canvas-tools.js";

/**
  画布这条用例面的装配：把「这一仓的库现在开着」翻译成一份 `DiagramWriteContext`（`store` 那一格就在里面），
  并把 `pin()` / `unpin()` 收在这一层——一次请求里的读图、改名、恢复、记账必须在同一个句柄上完成，
  LRU 驱逐不该发生在半个请求中间（`exercise-ports.ts` 的 `withExercisePorts` 是同一形状）。

  用例侧因此既不认识 `TutorDatabase`，也不需要自己去动引用计数：
  这两件事只要出现在应用层，就是「连接生命周期」泄漏到了业务步骤里，漏一次 unpin 就漏一个文件描述符。
*/
export function withDiagramContext<T>(repository: ImportedRepository, run: (context: DiagramWriteContext) => T): T {
  const database = repository.handle.pin();
  try {
    return run(diagramWriteContextFor(repository, database));
  } finally {
    repository.handle.unpin();
  }
}
