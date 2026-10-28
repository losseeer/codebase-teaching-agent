import { Journal } from "./journal.js";
import { TutorDatabase } from "./database.js";

/** 一个挂载仓库的连接与审计线写入口，随挂载创建、随卸载关闭。 */
export class RepositoryHandle {
  readonly repositoryPath: string;
  readonly repositoryId: string;
  /** 审计线写入口，与库句柄同生命周期。 */
  readonly journal: Journal;
  private database: TutorDatabase | undefined;
  private pinned = 0;
  private closeRequested = false;

  /** 开库时未补上的列（`表.列`）快照。 */
  readonly schemaGaps: readonly string[];

  constructor(repositoryPath: string, repositoryId: string) {
    this.repositoryPath = repositoryPath;
    this.repositoryId = repositoryId;
    this.database = new TutorDatabase(repositoryPath);
    this.schemaGaps = [...this.database.schemaGaps];
    this.journal = new Journal(repositoryPath, repositoryId);
  }

  /** 库句柄：须在 pin/unpin 之间取用；已关闭则抛。 */
  get db(): TutorDatabase {
    if (!this.database) throw new Error(`仓库 ${this.repositoryId} 的库句柄已经关闭；这个访问本该在 pin/unpin 之间。`);
    return this.database;
  }

  /** 记一次「正在用」并返回库句柄。 */
  pin(): TutorDatabase {
    this.pinned += 1;
    return this.db;
  }

  /** 放开一次「正在用」；最后一个引用放开时执行挂起的关闭。 */
  unpin(): void {
    this.pinned = Math.max(0, this.pinned - 1);
    if (this.closeRequested && this.pinned === 0) this.release();
  }

  /** 卸载；仍有引用则挂起关闭，等最后一个 `unpin`。 */
  close(): void {
    this.closeRequested = true;
    if (this.pinned === 0) this.release();
  }

  /** 当前「正在用」的引用数。 */
  get pinnedCount(): number {
    return this.pinned;
  }

  get closed(): boolean {
    return this.database === undefined;
  }

  private release(): void {
    this.database?.close();
    this.database = undefined;
  }
}
