import { Journal } from "./journal.js";
import { TutorDatabase } from "./database.js";

/**
  一个挂载仓库的连接生命周期：一份 SQLite 句柄 + 一条审计线写入口，随挂载创建、随卸载关闭。
  开合收在这里而不是各处理函数自行 new 再 close：漏一次 close 就漏一个文件描述符
  （better-sqlite3 还带 WAL 的 -wal/-shm 两份），懒挂载反复开合能把整个进程拖到 EMFILE。

  两条不能省的细节：
  - 进行中的引用（pin/unpin）：LRU 驱逐或用户移出仓库时，可能正好有请求握着这份连接。
    关闭是「挂起直到最后一个引用放开」，不是「立刻关」——否则对方下一次语句拿到已关闭的句柄。
  - 脱离挂载的读路径（会话线程两表、离线脚本）本来就按调用开合，那是另一套生命周期，不走这里。
  */
export class RepositoryHandle {
  readonly repositoryPath: string;
  readonly repositoryId: string;
  /** 审计线写入口：与库句柄同生同死，但它自己不占描述符（每次 append 现开现写）。 */
  readonly journal: Journal;
  private database: TutorDatabase | undefined;
  private pinned = 0;
  private closeRequested = false;

  /**
    开库时对账没补上的列（`表.列`）：正常挂载应该是空数组，非空就是要看得见的事件。
    构造时抄一份：「当时这份库缺哪格」是事实，不跟着连接的生死一起消失。
    */
  readonly schemaGaps: readonly string[];

  constructor(repositoryPath: string, repositoryId: string) {
    this.repositoryPath = repositoryPath;
    this.repositoryId = repositoryId;
    this.database = new TutorDatabase(repositoryPath);
    this.schemaGaps = [...this.database.schemaGaps];
    this.journal = new Journal(repositoryPath, repositoryId);
  }

  /**
    库句柄。必须先 pin()：pin 负责「还有人用着就别关」，直接读这个属性等于绕过引用计数。
    已经关闭就抛——拿着已关的连接继续写要当场失败，不能静默写出半个事务。
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
