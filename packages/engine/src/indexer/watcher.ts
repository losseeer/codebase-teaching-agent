import { watch, type FSWatcher } from "node:fs";
import { createTutorIgnoreMatcher, isTutorIgnoreFile } from "./ignore.js";

/** 监听此刻的死活与原因。`dead` 不是「还没启动」，是**曾经想过以后不会再来事件**的那种。 */
export interface WatchStatus {
  started: boolean;
  dead: boolean;
  error?: string;
}

/**
  文件监听是**增强**，不是主流程：不支持 recursive watch 的文件系统（网络盘、只读挂载、inotify 额度用尽）
  上导入照样要能用。但「增强没起来」绝不能等于「没人知道」：
  增量重分析是这仓产物保持新鲜的唯一自动通道，它一停，界面上那个「产物是新的」就会一直停在挂载那一刻。
  所以 start 把死活如实交出去，并且给 FSWatcher 挂了 `error` 监听——
  ⚠️ 那条监听是**必需品不是装饰**：`fs.FSWatcher` 是 EventEmitter，运行中抛 error 而没人听，
  Node 会把这次 emit 变成未捕获异常，一整台引擎跟着掉。
  */
export class RepositoryWatcher {
  private watcher?: FSWatcher;
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private status: WatchStatus = { started: false, dead: false };

  constructor(private readonly repositoryPath: string, private readonly onChange: (paths: string[]) => void, private readonly debounceMs = 450, private readonly onError?: (message: string) => void) {}

  /**
    引擎产物目录**在这一层恒定不回声**，且刻意**不走** `.tutorignore`：
    那份配置是用户拥有的，`ignore.test.ts` 里钉着一条「写了 `!.tutor/**` 就该把产物当源码索引」的支持用例
    ——那是个自洽但奇怪的选择，索引层照办。但监听层不能照办：产物是引擎自己写的，
    一旦喂回事件就是「写产物 → 触发重分析 → 又写产物」的自激循环，代价为整仓反复重扫（更糟时反复重烧钱）。
    所以这一条住在这里而不是共用判据里：**「把产物当源码读」可以，「被自己的产物叫醒」不行。**
    */
  private echoesOwnArtifacts(path: string): boolean {
    return path === ".tutor" || path.startsWith(".tutor/");
  }

  start(): WatchStatus {
    try {
      let ignore = createTutorIgnoreMatcher(this.repositoryPath);
      this.watcher = watch(this.repositoryPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const path = String(filename).replaceAll("\\", "/");
        if (isTutorIgnoreFile(path)) ignore = createTutorIgnoreMatcher(this.repositoryPath);
        if (!isTutorIgnoreFile(path) && (this.echoesOwnArtifacts(path) || ignore.ignores(path))) return;
        this.pending.add(path);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const changed = [...this.pending].filter(Boolean);
          this.pending.clear();
          if (changed.length) this.onChange(changed);
        }, this.debounceMs);
      });
      this.watcher.on("error", (error) => {
        // 起不来的三种写法（同步 throw / 异步 error / 两者都有）在这里合成一条事实：dead + 原因
        this.status = { ...this.status, dead: true, error: error instanceof Error ? error.message : String(error) };
        this.onError?.(this.status.error ?? "未知监听错误");
      });
      this.status = { started: true, dead: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { started: false, dead: true, error: message };
      this.onError?.(message);
    }
    return this.status;
  }

  /** 当前死活（同步 throw 之后与异步 error 之后都读得到）。 */
  get watchStatus(): WatchStatus {
    return this.status;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
  }
}
