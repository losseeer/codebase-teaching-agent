import { statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { isIngestedPath, listIngestedPaths } from "./indexer.js";
import { createTutorIgnoreMatcher, isTutorIgnoreFile, type TutorIgnoreMatcher } from "./ignore.js";

/**
  事件里那条路径**相对监听开始的那一刻**是什么：
  - `file` / `directory`：改动之后还在磁盘上；
  - `gone`：stat 不到（刚删掉，或事件与 stat 抢了先后）——判不出来就当最坏情况；
  - `predates-watch`：这条路径比监听起点还老。macOS 的 recursive watch 建立时会把目录近期历史**倒还一遍**，
    那些「监听开始前就发生的改动」不是本轮要响应的事（详见 `changeWanted` 那段）。
  */
export type ChangedPathKind = "file" | "directory" | "gone" | "predates-watch";

/** 监听此刻的死活与原因。`dead` 不是「还没启动」，是**曾经想过以后不会再来事件**的那种。 */
export interface WatchStatus {
  started: boolean;
  dead: boolean;
  error?: string;
}

/**
  引擎产物目录**在这一层恒定不回声**，且刻意**不走** `.tutorignore`：
  那份配置是用户拥有的，`ignore.test.ts` 里钉着一条「写了 `!.tutor/**` 就该把产物当源码索引」的支持用例
  ——那是个自洽但奇怪的选择，索引层照办。但监听层不能照办：产物是引擎自己写的，
  一旦回传给事件就是「写产物 → 触发重分析 → 又写产物」的自触发循环，代价为整仓反复重扫（更糟时反复重烧钱）。
  所以这一条住在这里而不是共用判据里：**「把产物当源码读」可以，「被自己的产物叫醒」不行。**
  */
export function isArtifactEcho(path: string): boolean {
  return path === ".tutor" || path.startsWith(".tutor/");
}

/**
  一个监听事件该不该上报成「源码改动」。**抽成纯函数是有原因的**：
  真 fs 事件在整包并行跑测试时不守时（几十路 fs.watch 同时投递，几秒都可能等不到一个 change），
  判据留在类里就只能靠时序测；而这条判据一旦破是烧钱级的（自触发重分析），所以它必须能确定性测。

  三道筛，各自拦一种白扫：
  1. `predates-watch` 直接不报。⚠️ 这条拦的是**挂载那一刻的回放**：macOS 的 `fs.watch(recursive)` 建流时会把
     目录近期历史倒还一遍，实测（2026-10-14）新建临时仓、先写好 `src/a.ts`、再 `start()`，
     第一批事件里就带着仓根目录、`src`、`src/a.ts` 和引擎自己播种的 `.tutorignore`——
     照旧当源码改动，等于**每次挂载都白排一轮全量重分析**（产物被真实扫描换掉、缓存键重算、润色可能重烧）。
  2. `gone` 与目录两档保守叫醒：批量删除时系统常常只报父目录那一条，漏了就永远漏。
  3. `file` 那一档按**收录集**筛（`isIngestedPath`：扩展名白名单 ∩ `.tutorignore` ∩ 非密钥载体名）。
     往仓里放一张 `.png`、一份 `.env`、一个 `credentials.json` 都不该惊动整仓重扫。
  */
export function changeWanted(path: string, matcher: { ignores(path: string, isDirectory?: boolean): boolean }, kind: ChangedPathKind = "gone"): boolean {
  if (kind === "predates-watch") return false;
  if (isTutorIgnoreFile(path)) return true;
  if (isArtifactEcho(path)) return false;
  if (matcher.ignores(path)) return false;
  if (kind !== "file") return true;
  return isIngestedPath(path, matcher);
}

/**
  两份「收录集」快照是否不同（只看路径集合，不看内容）。
  抽成纯函数是为了确定性测——它守的是「别白扫整仓」，靠时序测不出来。
  */
export function ingestSetDiffers(previous: Iterable<string>, next: Iterable<string>): boolean {
  const before = new Set(previous);
  const after = new Set(next);
  if (before.size !== after.size) return true;
  for (const path of after) if (!before.has(path)) return true;
  return false;
}

/**
  stat 一下，只为回答「这次改动比监听的起点更新吗、是文件还是目录」。
  读不到就当判不出来——删除事件到这里时路径通常已经没了，那种情况必须叫醒（收录集真的少了东西）。
  mtime 不晚于监听起点的是**回放**（`changeWanted` 第 1 条），不是本轮要响应的事。
  ⚠️ 同一毫秒内的真改动会被一起丢弃：那一刻的 `judgeFreshness` 比这一判晚（attach 里先起监听再算新鲜度），
  那次改动照样会被判成脏并在界面上露出来——不是静默丢掉。
  */
function kindOf(absolute: string, startedAtMs: number): ChangedPathKind {
  try {
    const stat = statSync(absolute);
    // mtimeMs 是小数毫秒、startedAtMs 是整数毫秒，两者的差常不到 1ms：所以「同一毫秒内的播种」不靠这里挡，
    // 靠下面那份 `.tutorignore` 内容签名（时序在这条路上不可靠）。
    if (stat.mtimeMs <= startedAtMs) return "predates-watch";
    return stat.isDirectory() ? "directory" : "file";
  } catch {
    return "gone";
  }
}

/**
  文件监听是**增强**，不是主流程：不支持 recursive watch 的文件系统（网络盘、只读挂载、inotify 额度用尽）
  上导入照样要能用。但「增强没起来」绝不能等于「没人知道」：
  增量重分析是这仓产物保持新鲜的唯一自动通道，它一停，界面上那个「产物是新的」就会一直停在挂载那一刻。
  所以 `start()` 把死活如实交出去，并且给 FSWatcher 挂了 `error` 监听——
  ⚠️ 那条监听是**必需品不是装饰**：`fs.FSWatcher` 是 EventEmitter，运行中报错而没人听，
  Node 会把这次 emit 变成未捕获异常，一整台引擎跟着掉。
  */
export class RepositoryWatcher {
  private watcher?: FSWatcher;
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private status: WatchStatus = { started: false, dead: false };
  private readonly repositoryBase: string;
  /** 起监听之后才有的判定基准（那份配置 + 上一次看到的收录集）。没起来就没有基准。 */
  private state?: { ignore: TutorIgnoreMatcher; snapshot: Set<string> };

  constructor(private readonly repositoryPath: string, private readonly onChange: (paths: string[]) => void, private readonly debounceMs = 450, private readonly onError?: (message: string) => void) {
    this.repositoryBase = repositoryPath.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) ?? "";
  }

  start(): WatchStatus {
    try {
      const ignore = createTutorIgnoreMatcher(this.repositoryPath);
      this.state = { ignore, snapshot: new Set(listIngestedPaths(this.repositoryPath, ignore)) };
      // 起点取在「引擎自己要往仓里写的东西」之后、`watch()` 之前：建流时倒还回来的那批目录历史
      // 都比这一瞬间老，一律不当成本轮改动（判据见 `changeWanted` 第 1 条）。
      const startedAtMs = Date.now();
      this.watcher = watch(this.repositoryPath, { recursive: true }, (_event, filename) => {
        // 回调里什么都不许往外抛：`fs.watch` 的监听器没有调用方，异常直接变成进程的未捕获异常。
        // 真实形态就是「用户把仓删了/挪走了，而下一次事件还要去读它的 .tutorignore」——
        // 判 dead 并说清原因，与下面 `on("error")` 那条同一个口径（界面据此报「监听停了」，不是假装还在跟）。
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
          // 真叫醒过一次：收录集快照跟着磁盘走，下一次模糊事件才有正确的比较基准
          this.refreshSnapshot();
          this.onChange(changed);
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

  /**
    这条事件要不要上报成「源码改动」。三道，按代价从低到高：
    1. `.tutorignore`：**内容签名**变了才重读并上报。起监听时引擎自己会往仓里播种默认那一份，
       那次写入也是真事件、也常与起监听落在同一毫秒里——按 mtime 判先后挡不住（实测挡不住），按内容判才稳。
    2. `changeWanted` 的取舍（回放、产物回声、忽略项、收录集）。
    3. 模糊事件（目录、stat 不到）不带文件路径：往仓根放一张 `.png` 会把**仓根目录的 mtime** 顶一下，
       那种事件既不是文件也读不出内容，于是比一下收录集——没多也没少就别为它整仓重扫。
    */
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

  /**
    事件里的路径拼成绝对路径。macOS 的 recursive 监听会把**被监听目录自己**报成它那一层的名字
    （实测：仓根事件带的是 `watch-repro-XYZ` 这种目录名，不是空串也不是 `.`），
    照字面 join 就拼出一个不存在的子路径 → 被判成「stat 不到」→ 白醒一轮。
    */
  private absoluteOf(path: string): string {
    return path === this.repositoryBase ? this.repositoryPath : join(this.repositoryPath, path);
  }

  /** 重列收录集并回答「与上次比变了没」；无论变没变都把快照推进到眼前这份。 */
  private refreshSnapshot(): boolean {
    const state = this.state;
    if (!state) return false;
    const next = new Set(listIngestedPaths(this.repositoryPath, state.ignore));
    const changed = ingestSetDiffers(state.snapshot, next);
    state.snapshot = next;
    return changed;
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
