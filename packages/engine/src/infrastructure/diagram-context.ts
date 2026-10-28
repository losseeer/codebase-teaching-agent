import type { DiagramWriteContext } from "../diagram/set-diagram.js";
import type { ImportedRepository } from "../importer/importer.js";
import { diagramWriteContextFor } from "./canvas-tools.js";

/** 把仓库句柄装配成 `DiagramWriteContext`，并在本层做 pin/unpin。 */
export function withDiagramContext<T>(repository: ImportedRepository, run: (context: DiagramWriteContext) => T): T {
  const database = repository.handle.pin();
  try {
    return run(diagramWriteContextFor(repository, database));
  } finally {
    repository.handle.unpin();
  }
}
