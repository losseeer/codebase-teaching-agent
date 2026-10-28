import { statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { isIngestedPath, listIngestedPaths } from "./indexer.js";
import { createTutorIgnoreMatcher, isTutorIgnoreFile, type TutorIgnoreMatcher } from "@codebase-tutor/analysis";

/** 事件里的路径相对监听起点的状态；`gone` = stat 不到，`predates-watch` = 比监听起点还老。 */
export type ChangedPathKind = "file" | "directory" | "gone" | "predates-watch";

/** 监听此刻的死活与原因；`dead` = 起来过、之后不再来事件。 */
export interface WatchStatus {
  started: boolean;
  dead: boolean;
  error?: string;
}

/** 引擎自己写的产物目录不回声；这一条不走 `.tutorignore`。 */
export function isArtifactEcho(path: string): boolean {
  return path === ".tutor" || path.startsWith(".tutor/");
}

/** 一个监听事件该不该上报成「源码改动」：回放不报，`gone` 与目录保守叫醒，`file` 按收录集筛。 */
export function changeWanted(path: string, matcher: { ignores(path: string, isDirectory?: boolean): boolean }, kind: ChangedPathKind = "gone"): boolean {
  if (kind === "predates-watch") return false;
  if (isTutorIgnoreFile(path)) return true;
  if (isArtifactEcho(path)) return false;
  if (matcher.ignores(path)) return false;
  if (kind !== "file") return true;
  return isIngestedPath(path, matcher);
}

/** 两份收录集快照是否不同（只看路径集合）。 */
export function ingestSetDiffers(previous: Iterable<string>, next: Iterable<string>): boolean {
  const before = new Set(previous);
  const after = new Set(next);
  if (before.size !== after.size) return true;
  for (const path of after) if (!before.has(path)) return true;
  return false;
}

/** 这条 mtime 算不算起监听之后的改动：两边先对到整数毫秒再比。 */
export const changedAfter = (mtimeMs: number, startedAtMs: number): boolean => Math.floor(mtimeMs) > startedAtMs;

/** stat 一下，回答改动是否比监听起点更新、是文件还是目录；读不到按最坏情况叫醒。 */
function kindOf(absolute: string, startedAtMs: number): ChangedPathKind {
  try {
    const stat = statSync(absolute);
    if (!changedAfter(stat.mtimeMs, startedAtMs)) return "predates-watch";
    return stat.isDirectory() ? "directory" : "file";
  } catch {
    return "gone";
  }
}

/**
  文件监听是增强，不是主流程：起不来时导入照样可用，但死活要如实交出去。
  `fs.FSWatcher` 是 EventEmitter，运行中报错而无人监听会变成未捕获异常。
*/
export class RepositoryWatcher {
  private watcher?: FSWatcher;
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private status: WatchStatus = { started: false, dead: false };
  private readonly repositoryBase: string;
  /** 起监听之后才有的判定基准；没起来就没有基准。 */
  private state?: { ignore: TutorIgnoreMatcher; snapshot: Set<string> };

  constructor(private readonly repositoryPath: string, private readonly onChange: (paths: string[]) => void, private readonly debounceMs = 450, private readonly onError?: (message: string) => void) {
    this.repositoryBase = repositoryPath.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) ?? "";
  }

  start(): WatchStatus {
    try {
      const ignore = createTutorIgnoreMatcher(this.repositoryPath);
      this.state = { ignore, snapshot: new Set(listIngestedPaths(this.repositoryPath, ignore)) };
      // 起点取在引擎往仓里写默认配置之后、`watch()` 之前。
      const startedAtMs = Date.now();
      this.watcher = watch(this.repositoryPath, { recursive: true }, (_event, filename) => {
        // 回调里不许往外抛：`fs.watch` 的监听器没有调用方。
        try {
          if (!filename) return;
          const path = String(filename).replaceAll("\\", "/");
          if (!this.wanted(path, kindOf(this.absoluteOf(path), startedAtMs))) return;
          this.pending.add(path);
        } catch (error) {
          this.status = { ...this.status, dead: true, error: error instanceof Error ? error.message : String(error) };
          console.warn(`[watcher] ${this.repositoryPath} 的事件处理抛了，监听判死：${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const changed = [...this.pending].filter(Boolean);
          this.pending.clear();
          if (!changed.length) return;
          // 真叫醒过一次：收录集快照跟着磁盘走。
          this.refreshSnapshot();
          this.onChange(changed);
        }, this.debounceMs);
      });
      this.watcher.on("error", (error) => {
        // 起不来的几种写法在这里合成一条事实：dead + 原因。
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

  /** 这条事件要不要上报成「源码改动」，三道按代价从低到高；`.tutorignore` 按内容签名判。 */
  private wanted(path: string, kind: ChangedPathKind): boolean {
    const state = this.state;
    if (!state) return false;
    if (isTutorIgnoreFile(path)) {
      const next = createTutorIgnoreMatcher(this.repositoryPath);
      if (next.signature === state.ignore.signature) return false;
      state.ignore = next;
      return true;
    }
    if (!changeWanted(path, state.ignore, kind)) return false;
    if (kind !== "file" && !this.refreshSnapshot()) return false;
    return true;
  }

  /** 事件里的路径拼成绝对路径；macOS 会把被监听目录自己报成它那一层的目录名。 */
  private absoluteOf(path: string): string {
    return path === this.repositoryBase ? this.repositoryPath : join(this.repositoryPath, path);
  }

  /** 重列收录集并回答与上次比变了没；无论变没变都推进快照。 */
  private refreshSnapshot(): boolean {
    const state = this.state;
    if (!state) return false;
    const next = new Set(listIngestedPaths(this.repositoryPath, state.ignore));
    const changed = ingestSetDiffers(state.snapshot, next);
    state.snapshot = next;
    return changed;
  }

  /** 当前死活。 */
  get watchStatus(): WatchStatus {
    return this.status;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
  }
}
