import { statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { isIngestedPath, listIngestedPaths } from "./indexer.js";
import { createTutorIgnoreMatcher, isTutorIgnoreFile, type TutorIgnoreMatcher } from "@codebase-tutor/analysis";

/** 事件路径相对监听起点的状态。 */
export type ChangedPathKind = "file" | "directory" | "gone" | "predates-watch";

/** 监听当前的运行状态与失败原因。 */
export interface WatchStatus {
  started: boolean;
  dead: boolean;
  error?: string;
}

/** 引擎自写的产物目录不算源码改动，且不受 `.tutorignore` 影响。 */
export function isArtifactEcho(path: string): boolean {
  return path === ".tutor" || path.startsWith(".tutor/");
}

/** 该监听事件是否算源码改动。 */
export function changeWanted(path: string, matcher: { ignores(path: string, isDirectory?: boolean): boolean }, kind: ChangedPathKind = "gone"): boolean {
  if (kind === "predates-watch") return false;
  if (isTutorIgnoreFile(path)) return true;
  if (isArtifactEcho(path)) return false;
  if (matcher.ignores(path)) return false;
  if (kind !== "file") return true;
  return isIngestedPath(path, matcher);
}

/** 两份收录集的路径集合是否不同。 */
export function ingestSetDiffers(previous: Iterable<string>, next: Iterable<string>): boolean {
  const before = new Set(previous);
  const after = new Set(next);
  if (before.size !== after.size) return true;
  for (const path of after) if (!before.has(path)) return true;
  return false;
}

/** mtime 是否晚于监听起点。 */
export const changedAfter = (mtimeMs: number, startedAtMs: number): boolean => Math.floor(mtimeMs) > startedAtMs;

/** 按 stat 结果给出事件路径的类型。 */
function kindOf(absolute: string, startedAtMs: number): ChangedPathKind {
  try {
    const stat = statSync(absolute);
    if (!changedAfter(stat.mtimeMs, startedAtMs)) return "predates-watch";
    return stat.isDirectory() ? "directory" : "file";
  } catch {
    return "gone";
  }
}

/** 仓库文件监听：把收录集内的改动交给回调，并上交运行状态。 */
export class RepositoryWatcher {
  private watcher?: FSWatcher;
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private status: WatchStatus = { started: false, dead: false };
  private readonly repositoryBase: string;
  /** 监听启动后建立的判定基准。 */
  private state?: { ignore: TutorIgnoreMatcher; snapshot: Set<string> };

  constructor(private readonly repositoryPath: string, private readonly onChange: (paths: string[]) => void, private readonly debounceMs = 450, private readonly onError?: (message: string) => void) {
    this.repositoryBase = repositoryPath.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) ?? "";
  }

  start(): WatchStatus {
    try {
      const ignore = createTutorIgnoreMatcher(this.repositoryPath);
      this.state = { ignore, snapshot: new Set(listIngestedPaths(this.repositoryPath, ignore)) };
      // 起点取在引擎写默认配置之后、`watch()` 之前
      const startedAtMs = Date.now();
      this.watcher = watch(this.repositoryPath, { recursive: true }, (_event, filename) => {
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
          this.refreshSnapshot();
          this.onChange(changed);
        }, this.debounceMs);
      });
      this.watcher.on("error", (error) => {
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

  /** 事件是否算源码改动；`.tutorignore` 的改动按内容签名判定。 */
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

  /** 事件路径转绝对路径；macOS 会把被监听目录自己报成它的目录名。 */
  private absoluteOf(path: string): string {
    return path === this.repositoryBase ? this.repositoryPath : join(this.repositoryPath, path);
  }

  /** 重列收录集，返回路径集合是否变化。 */
  private refreshSnapshot(): boolean {
    const state = this.state;
    if (!state) return false;
    const next = new Set(listIngestedPaths(this.repositoryPath, state.ignore));
    const changed = ingestSetDiffers(state.snapshot, next);
    state.snapshot = next;
    return changed;
  }

  /** 当前监听状态。 */
  get watchStatus(): WatchStatus {
    return this.status;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
  }
}
