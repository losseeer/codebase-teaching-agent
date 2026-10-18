import { Journal } from "./journal.js";
import { TutorDatabase } from "./database.js";

/**
  一个挂载仓库的连接生命周期：一份 SQLite 句柄 + 一条审计线写入口，**随挂载创建、随卸载关闭**。

  为什么要有这个类型：`/api/repositories/:repositoryId/*` 的二十多个处理函数各自
  `new TutorDatabase(repository.path)` 再 `finally { database.close() }`。句柄挂在构造函数上，
  漏一次 `close()` 就漏一个文件描述符（better-sqlite3 还带 WAL 的 -wal/-shm 两份），
  而懒挂载是「每个请求都可能新开一份」——一个读不出来的库反复被请求，能把整个进程拖到 EMFILE。
  `importer.ts` 早就为这件事写过一段注释，但那条纪律只活在注释里；现在由类型与挂载生命周期代劳。

  两条不能省的细节：
  - **进行中的引用**（`pin`/`unpin`）：LRU 驱逐或用户显式移出仓库时，可能正好有请求卡在两次 await 之间
    握着这份连接。直接关就是让对方下一次语句拿到已关闭的句柄（SQLite 报 misuse，界面变成一个 500）。
    所以关闭是「挂起直到最后一个引用放开」，不是「立刻关」。
  - **只用一次的地方不许绕过它**：脱离挂载的读路径（会话线程两表、离线脚本）本来就按调用开合，
    那是另一套生命周期，别混进来——混了就要么漏关，要么把「进程级句柄」当成「请求级句柄」用。
  */
export class RepositoryHandle {
  readonly repositoryPath: string;
  readonly repositoryId: string;
  /** 审计线写入口：与库句柄同生同死，但它自己不占描述符（每次 append 现开现写）。 */
  readonly journal: Journal;
  private database: TutorDatabase | undefined;
  private pinned = 0;
  private closeRequested = false;

  constructor(repositoryPath: string, repositoryId: string) {
    this.repositoryPath = repositoryPath;
    this.repositoryId = repositoryId;
    this.database = new TutorDatabase(repositoryPath);
    this.journal = new Journal(repositoryPath, repositoryId);
  }

  /**
    库句柄。**必须先 `pin()`**：`pin` 负责「还有人用着就别关」这件事，直接读这个属性等于绕过引用计数。
    已经关闭就抛——把「拿着一份已关的连接继续写」变成一次当场可见的失败，比让它静默写出半个事务好。
    */
  get db(): TutorDatabase {
    if (!this.database) throw new Error(`仓库 ${this.repositoryId} 的库句柄已经关闭；这个访问本该在 pin/unpin 之间。`);
    return this.database;
  }

  /** 记一次「正在用」并给出句柄：HTTP 走挂载钩子与 onResponse，后台任务自己配对 finally。 */
  pin(): TutorDatabase {
    this.pinned += 1;
    return this.db;
  }

  /** 放开一次「正在用」；这是最后一个引用而关闭已经挂起过，就在这里真关。 */
  unpin(): void {
    this.pinned = Math.max(0, this.pinned - 1);
    if (this.closeRequested && this.pinned === 0) this.release();
  }

  /** 卸载（LRU 驱逐、移出地址簿、进程收尾）：还有引用就挂起，等最后一个 `unpin`。 */
  close(): void {
    this.closeRequested = true;
    if (this.pinned === 0) this.release();
  }

  /** 读数，给日志与将来可能的「这个仓还有几个回合在跑」用；不是判据。 */
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
