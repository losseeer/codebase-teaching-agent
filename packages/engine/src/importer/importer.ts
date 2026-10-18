import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
  CourseTree,
  ImportEstimate,
  ImportJob,
  RepositoryAnalysis,
  RepositoryCatalogEntry,
  RepositoryFreshness,
  RepositoryIndex,
  RepositoryMountReason,
  ServerEvent
} from "@codebase-tutor/shared";
import { attachQuality, buildCourseTree, groupImplementationsByModule } from "../coursetree/build.js";
import { REFINE_STEP, refineCourseMap } from "../coursetree/llm-refine.js";
import { buildLlmRuntimeProvider } from "../llm/runtime.js";
import { budgetExceeded, budgetGateNotice, defaultMonthlyBudgetUsd } from "../cost/cost.js";
import { buildDependencyGraph, graphFromData, impactRadius, serializeGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";
import { fileStructureOf } from "../depgraph/roles.js";
import { buildImplementationUnits } from "../implementation/units.js";
import { catalogRepositoryId, hash, id } from "../lib.js";
import { scanRepositoryWithDigests, type RepositoryScan } from "../indexer/indexer.js";
import { RepositoryWatcher, type WatchStatus } from "../indexer/watcher.js";
import { enrichWithLsp } from "../lsp/enrich.js";
import { verifyAnalysis } from "../quality/checker.js";
import { createSummaryProvider } from "../summarizer/summary-provider.js";
import { summarizeFiles } from "../summarizer/summarizer.js";
import { TutorDatabase } from "../store/database.js";
import { journalFootprint } from "../store/journal.js";
import { RepositoryHandle } from "../store/repository-handle.js";
import { traceEngine } from "../trace/engine-log.js";

/** `analyze` 的产物：还没有挂载态——监听死活与新鲜度都是 `attach` 那一刻才存在的东西。 */
type AnalyzedRepository = Omit<ImportedRepository, "watcher" | "freshness" | "watch">;

export interface ImportedRepository {
  path: string;
  index: RepositoryIndex;
  course: CourseTree;
  estimate: ImportEstimate;
  analysis: RepositoryAnalysis;
  /**
    这份产物的连接生命周期（一份 SQLite + 一条审计线）。随挂载创建、随卸载关闭——
    处理函数不再各自 `new TutorDatabase` / `close()`（见 `store/repository-handle.ts`）。
    */
  handle: RepositoryHandle;
  watcher?: RepositoryWatcher;
  /** 挂载那一刻算出的新鲜度（内容哈希 + git HEAD）。只用于如实报告，不触发任何重分析。 */
  freshness: RepositoryFreshness;
  /**
    fs 监听的死活。**必须跟着挂载结果一起交出去**：增量重分析是产物变新的唯一自动通道，
    监听没起来时那次 `freshness` 就只到挂载那一刻为止——界面继续报「产物是新的」是在替引擎撒不实。
    */
  watch: WatchStatus;
}

/**
  挂载注册表（**N 条地址簿**）：engine 重启后据此把用户用过的仓库找回来，但**启动时一条都不读产物、不开监听**。
  默认 ~/.codebase-tutor/repositories.json，测试可用 TUTOR_REGISTRY_FILE 覆盖；顺序 = 最近使用在后。
  为什么不再单槽：产物本来就分仓存在各自的 `.tutor/` 里，内存态也是 `Map<repositoryId, …>`——
  单槽只是这份注册表写死了一条，代价是「切回上一个仓必须重新导入」。
  */
function registryFile(): string {
  return process.env.TUTOR_REGISTRY_FILE ?? join(homedir(), ".codebase-tutor", "repositories.json");
}

function readRegistry(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(), "utf8")) as { repositories?: unknown };
    if (!Array.isArray(parsed.repositories)) return [];
    const seen = new Set<string>();
    return parsed.repositories.filter((item): item is string => typeof item === "string" && item.length > 0 && !seen.has(item) && !!seen.add(item));
  } catch {
    return [];
  }
}

function writeRegistry(paths: string[]): void {
  const file = registryFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ repositories: paths }, null, 2)}\n`, "utf8");
}

/** 记进地址簿并挪到末尾（最近使用在后）。 */
function rememberRepository(repositoryPath: string): void {
  writeRegistry([...readRegistry().filter((item) => item !== repositoryPath), repositoryPath]);
}

/** 从地址簿里移除一条（用户显式动作；不动仓库自己的 .tutor 产物）。 */
function dropFromRegistry(repositoryId: string): void {
  writeRegistry(readRegistry().filter((item) => catalogRepositoryId(item) !== repositoryId));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
  同时挂载（每个挂载项 = 一个 fs 监听 + 一份完整产物内存态）的上限。
  地址簿可以有几十条，但只有最近用过的这几个真的占 watcher 与内存；LRU 超出的被驱逐，产物仍在各自 .tutor 里。
  每次读取（`TUTOR_MAX_MOUNTED`），测试要能换档——同 `engineLogPath()` 的理由。
  */
function maxMounted(): number {
  return Math.max(1, Number(process.env.TUTOR_MAX_MOUNTED ?? 3) || 3);
}

/** 分析那一刻的 git HEAD；非 git 仓、git 不在 PATH、或仓库没有一次提交都返回 undefined（新鲜度退化成「只比对了内容」）。 */
function gitHeadOf(repositoryPath: string): string | undefined {
  try {
    const head = execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 1_500, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return head || undefined;
  } catch {
    return undefined;
  }
}

/**
  一次遍历算出「当前内容哈希 + 与落库 contentHash 不符的文件数」。
  口径与 `contentVersion` / 索引器完全一致（utf8 读、同一段 path:hash 拼法），否则新鲜度永远比不中。
  代价是读一遍被索引的文件：只发生在**挂载时**（每仓每进程一次），启动不付这个钱。
  `digests` 给的时候（同一轮里 `scanRepositoryWithDigests` 刚算出来的那份）就不重读——
  拼进 stamp 的是**完整**64 位哈希，不是索引里那 16 位前缀，所以这一份不能省、也不能拿前缀代替。
  */
function stampAndDiff(repositoryPath: string, index: RepositoryIndex, digests?: Map<string, string>): { versionStamp: string; changedFiles: number } {
  let changedFiles = 0;
  const contents = index.files.map((file) => {
    let digest = "unreadable";
    const scanned = digests?.get(file.path);
    if (scanned !== undefined) {
      if (file.contentHash && !scanned.startsWith(file.contentHash)) changedFiles += 1;
      return `${file.path}:${scanned}`;
    }
    try {
      digest = hash(readFileSync(join(repositoryPath, file.path), "utf8"));
    } catch {
      changedFiles += 1; // 读不到＝被删/被移走，本身就是改动
      return `${file.path}:${digest}`;
    }
    if (file.contentHash && !digest.startsWith(file.contentHash)) changedFiles += 1;
    return `${file.path}:${digest}`;
  });
  contents.sort();
  return { versionStamp: `content:${hash(contents.join("\n")).slice(0, 24)}`, changedFiles };
}

/**
  两次扫描的「收录集 + 每文件内容哈希」是否完全一致。一致就说明这一轮算不出任何新东西。
  ⚠️ 任一侧缺 `contentHash`（B1 之前的老索引、或扫描期读不出来的文件）就当**不一致**：
  判不出来不等于没变，宁可重扫一遍，也不要把一个没验证过的状态当成事实。
  */
export function sameIngestedContent(previous: RepositoryIndex, next: RepositoryIndex): boolean {
  if (previous.files.length !== next.files.length) return false;
  const incoming = new Map(next.files.map((file) => [file.path, file.contentHash]));
  return previous.files.every((file) => {
    const before = file.contentHash;
    const after = incoming.get(file.path);
    return Boolean(before) && before === after;
  });
}

/**
  新鲜度判定（**只报告**）：内容哈希不等 = 过期（stale）；内容对得上但 HEAD 移动了 = drifted（产物仍可用，
  只是分析点在别的提交上）；老仓库没记 HEAD 时退化成 unknown，界面明说「只比对了文件内容」。
  刻意不由引擎自动重分析：重跑是花钱的动作，谁脏了、要不要重跑，交给用户点头。
  */
function judgeFreshness(repositoryPath: string, index: RepositoryIndex, analysis: RepositoryAnalysis): RepositoryFreshness {
  const { versionStamp, changedFiles } = stampAndDiff(repositoryPath, index);
  const headNow = gitHeadOf(repositoryPath);
  const contentChanged = versionStamp !== analysis.versionStamp;
  const verdict: RepositoryFreshness["verdict"] = contentChanged
    ? "stale"
    : !analysis.gitHead || !headNow
      ? "unknown"
      : headNow === analysis.gitHead
        ? "fresh"
        : "drifted";
  return {
    verdict,
    analyzedAt: analysis.generatedAt,
    versionStamp,
    contentChanged,
    changedFiles,
    ...(analysis.gitHead ? { headAtAnalysis: analysis.gitHead } : {}),
    ...(headNow ? { headNow } : {})
  };
}

/** 编辑期免打扰的默认窗口与上下限：太短没意义，太长等于忘了它存在（到点自动恢复）。 */
const WATCH_PAUSE_DEFAULT_MS = 30 * 60_000;
const WATCH_PAUSE_MIN_MS = 60_000;
const WATCH_PAUSE_MAX_MS = 6 * 60 * 60_000;
const pauseWindow = (ms: number): number => (Number.isFinite(ms) && ms > 0 ? Math.round(ms) : WATCH_PAUSE_DEFAULT_MS) || WATCH_PAUSE_DEFAULT_MS;

export class ImportService extends EventEmitter {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly repositories = new Map<string, ImportedRepository>();
  /** 已挂载仓库的 LRU 序（最近使用在后）；地址簿的顺序单独存在注册表文件里。 */
  private readonly lru: string[] = [];
  private queue = Promise.resolve();
  /** 每个仓库至多一轮重分析在途；running 期间新到的路径先累积，本轮结束后合并跑下一轮。 */
  private readonly reanalysisQueues = new Map<string, { running: Promise<void>; pending: Set<string> }>();
  /**
    监听被人为挂起的仓（编辑期免打扰）：`until` 之后自动恢复。放在这里而不是挂载态里，
    因为**挂起要活过驱逐与重新挂载**——LRU 把这个仓挤出去再点回来时，用户按下的开关不能悄悄失效。
    */
  private readonly watchPaused = new Map<string, { until: number; timer?: ReturnType<typeof setTimeout> }>();


  submit(inputPath: string, summaryHeaderComments?: boolean): ImportJob {
    const repositoryPath = validateRepositoryPath(inputPath);
    const job: ImportJob = { id: id(), repositoryPath, phase: "queued", progress: 0, message: "已加入导入队列", createdAt: new Date().toISOString(), ...(summaryHeaderComments === undefined ? {} : { summaryHeaderComments }) };
    this.jobs.set(job.id, job);
    this.queue = this.queue.then(() => this.run(job.id)).catch(() => undefined);
    return job;
  }

  getJob(jobId: string): ImportJob | undefined {
    return this.jobs.get(jobId);
  }

  getRepository(repositoryId: string): ImportedRepository | undefined {
    return this.repositories.get(repositoryId);
  }

  /** 当前**挂在内存里**的仓库（≤ `maxMounted()`）；地址簿全量看 `catalog()`。 */
  mountedRepositories(): ImportedRepository[] {
    return [...this.repositories.values()];
  }

  /**
    地址簿清单：**不读任何产物**（除一次 statSync 判目录还在不在），所以引擎启动、GUI 打开切换器都不花钱。
    `mounted` 的条目带上挂载时算好的新鲜度；未挂载的条目 `artifactsReady` 留空——探它就得读它的 db，
    而「用户没点它」正是懒挂载要省掉的那笔。
    `budgetGateNotice` 是唯一的例外：它只看进程自己的环境变量（单价配没配），既不读库也不发请求，
    却必须出现在这里——地址簿是「还没有工作区」的人唯一能看到的页面，而闸门失效正发生在下一次导入。
    */
  catalog(): RepositoryCatalogEntry[] {
    const paths = readRegistry();
    for (const repository of this.repositories.values()) if (!paths.includes(repository.path)) paths.push(repository.path);
    const gateNotice = budgetGateNotice();
    return paths.map((path) => {
      const repositoryId = catalogRepositoryId(path);
      const mounted = this.repositories.get(repositoryId);
      return {
        repositoryId,
        repositoryPath: path,
        name: basename(path) || path,
        mounted: Boolean(mounted),
        exists: isDirectory(path),
        ...(gateNotice ? { budgetGateNotice: gateNotice } : {}),
        ...(mounted
          ? {
              artifactsReady: true,
              freshness: mounted.freshness,
              // 监听死活跟着挂载项走：它决定「这次新鲜度读数是会自己更新的，还是停在挂载那一刻」
              watching: mounted.watch.started && !mounted.watch.dead,
              ...(this.watchPauseOf(repositoryId).paused ? { watchPaused: true, watchPausedUntil: new Date(this.watchPauseOf(repositoryId).until ?? 0).toISOString() } : {}),
              ...(mounted.watch.error ? { watchError: mounted.watch.error.slice(0, 160) } : {})
            }
          : {})
      };
    });
  }

  /**
    懒挂载：已挂着就只更新 LRU；没挂着才从地址簿找到那条路径、读它的 `.tutor` 产物挂进内存并开监听。
    失败分三种原因（GUI 要靠它决定「清掉工作区」还是「留着让用户处置」），且**任何一种都不会触发重分析**。
    */
  ensureMounted(repositoryId: string): { ok: true; repository: ImportedRepository } | { ok: false; reason: RepositoryMountReason; message: string } {
    const live = this.repositories.get(repositoryId);
    if (live) {
      this.touch(live.index.repositoryId);
      return { ok: true, repository: live };
    }
    const path = readRegistry().find((item) => catalogRepositoryId(item) === repositoryId);
    if (!path) return { ok: false, reason: "not_in_catalog", message: "这个仓库不在引擎的地址簿里；请重新导入以恢复它。" };
    if (!isDirectory(path)) return { ok: false, reason: "directory_missing", message: `地址簿记的目录已经不存在：${path}。产物在它原来的 .tutor/ 里，把仓库放回该路径或重新导入即可。` };
    let index: RepositoryIndex | undefined;
    let course: CourseTree | undefined;
    let analysis: RepositoryAnalysis | undefined;
    let estimate: ImportEstimate | undefined;
    /**
      句柄从这里起就交给挂载项，不再「读完就关」：这一带任何一步失败（库读不出、产物缺一半）
      都由当前的 `close()` 收尾，成功则活到卸载为止。
      以前靠 `finally` 关，是因为每个请求都自己开一份——漏一次就漏一个 FD（2026-10-06 复审指出）。
      */
    let handle: RepositoryHandle | undefined;
    try {
      handle = new RepositoryHandle(path, repositoryId);
      index = handle.db.getIndex(repositoryId);
      course = handle.db.getCourse(repositoryId);
      analysis = handle.db.getAnalysis(repositoryId);
      estimate = handle.db.getEstimate(repositoryId);
    } catch {
      handle?.close();
      return { ok: false, reason: "artifacts_incomplete", message: `${path} 的 .tutor/tutor.db 读不出来（文件损坏或权限不足），需要重新导入。` };
    }
    if (!index || !course || !analysis || !estimate) {
      handle?.close();
      return { ok: false, reason: "artifacts_incomplete", message: `${path} 的 .tutor 产物不完整（缺索引、课程树、分析结果或估算），需要重新导入才能继续。` };
    }
    const startedAt = Date.now();
    const repository = this.attach({ path, index, course, estimate, analysis, handle });
    // 顺带记一次审计线体量：journal 只增不删，行数与字节数是「这条读路径还能不能一直这么跑」的判据
    // （读侧现在是按字节水位增量解析，见 `store/journal.ts`；真到需要归档的那天，这两个数就是依据）。
    const journal = journalFootprint(path);
    traceEngine("mount", { repositoryId, phase: "lazy", verdict: repository.freshness.verdict, changedFiles: repository.freshness.changedFiles, mounted: this.repositories.size, journalLines: journal.lines, journalBytes: journal.bytes, schemaGaps: repository.handle.schemaGaps.length }, { traceId: null, durationMs: Date.now() - startedAt });
    // 形状缺口不是审美问题：那一列被真读到时才会炸，所以开机这一次就把列名喊出来（同一份读数也进上面的 trace）
    if (repository.handle.schemaGaps.length) console.warn(`[engine] ${path} 的产物库缺列：${repository.handle.schemaGaps.join("、")}——需要一条一次性迁移，光改声明补不上。`);
    return { ok: true, repository };
  }

  /** 用户显式把某仓移出地址簿（并就地卸载）；不动仓库里的产物。 */
  forget(repositoryId: string): void {
    this.unmountOne(repositoryId);
    dropFromRegistry(repositoryId);
  }

  /**
    挂载一个仓库并监听。**不再卸载别的仓库**（单槽时代「挂载即全卸」是切仓必须重导入的根因），
    改为按 LRU 驱逐超出 `MAX_MOUNTED` 的最久未用项：只关它的 fs 监听、从内存移除，磁盘产物一字不动。
    */
  private attach(repository: AnalyzedRepository): ImportedRepository {
    const repositoryId = repository.index.repositoryId;
    const previous = this.repositories.get(repositoryId);
    previous?.watcher?.close();
    // 重新导入同一个仓：旧句柄要让位给这一轮的（增量重分析传进来的就是同一份，那种情况不动它）
    if (previous && previous.handle !== repository.handle) previous.handle.close();
    // 挂起中：不重新开监听。产物与内存照用，只是磁盘改动不会再叫醒重分析——这正是这个开关存在的理由。
    const paused = this.watchPaused.has(repositoryId);
    if (paused) traceEngine("mount", { repositoryId, phase: "watch_skipped_paused" }, { traceId: null });
    const { watcher, watch } = paused ? { watcher: undefined, watch: { started: false, dead: false } } : this.startWatcher(repository);
    const mounted: ImportedRepository = {
      ...repository,
      watcher,
      watch,
      freshness: judgeFreshness(repository.path, repository.index, repository.analysis)
    };
    this.repositories.set(repositoryId, mounted);
    this.touch(repositoryId);
    this.evictBeyondLru();
    return mounted;
  }

  /** 记一次「刚用过」：把它挪到 LRU 末尾。顺序数组很短（≤ `maxMounted()`），不做链表。 */
  private touch(repositoryId: string): void {
    const position = this.lru.indexOf(repositoryId);
    if (position >= 0) this.lru.splice(position, 1);
    this.lru.push(repositoryId);
  }

  /** 起一条 fs 监听并返回它的初始终态（attach 与恢复共用这一份，别让两处对「起不来怎么办」各写一遍）。 */
  private startWatcher(repository: AnalyzedRepository): { watcher: RepositoryWatcher; watch: WatchStatus } {
    const repositoryId = repository.index.repositoryId;
    const watcher = new RepositoryWatcher(repository.path, (changedPaths) => void this.reanalyzeIncrementally(repositoryId, changedPaths), undefined, (message) => {
      // 运行中途才炸的监听（inotify 额度、网络盘断开）比起不来更阴：它先报 successful start，之后再也不给事件
      traceEngine("mount", { repositoryId, phase: "watch_died", error: message.slice(0, 200) }, { traceId: null });
      console.warn(`[engine] ${repository.path} 的增量监听中途停了：${message}。此后这个仓的产物不会再自动跟上新改动，改完代码请手动重新导入。`);
    });
    const watch = watcher.start();
    if (!watch.started) {
      traceEngine("mount", { repositoryId, phase: "watch_failed", error: (watch.error ?? "").slice(0, 200) }, { traceId: null });
      console.warn(`[engine] ${repository.path} 起不了文件监听：${watch.error}。导入产物照样能用，但改动不会自动重分析，界面会把「新鲜度」按挂载那一刻报。`);
    }
    return { watcher, watch };
  }

  /**
    编辑期免打扰：**关掉这个仓的 fs 监听**，到点自己恢复。给它的理由是这台机器上改代码的人
    与正在被学习的仓常常是同一个（引擎在学它自己的仓），一轮编辑就会叫醒一次重分析并烧 light 调用（§62 实测 8 条）。
    挂起不丢东西：恢复时重算一次新鲜度，脏了由界面横幅如实说，要不要重烧仍由人点。
  */
  pauseWatching(repositoryId: string, ttlMs = WATCH_PAUSE_DEFAULT_MS): { paused: boolean; until: number } {
    const until = Date.now() + Math.min(WATCH_PAUSE_MAX_MS, Math.max(WATCH_PAUSE_MIN_MS, pauseWindow(ttlMs)));
    const previous = this.watchPaused.get(repositoryId);
    if (previous?.timer) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.resumeWatching(repositoryId), until - Date.now());
    timer.unref?.(); // 一个挂起不该把进程钉住
    this.watchPaused.set(repositoryId, { until, timer });
    const mounted = this.repositories.get(repositoryId);
    mounted?.watcher?.close();
    if (mounted) {
      mounted.watcher = undefined;
      mounted.watch = { started: false, dead: false };
    }
    traceEngine("mount", { repositoryId, phase: "watch_paused", until: new Date(until).toISOString() }, { traceId: null });
    return { paused: true, until };
  }

  /** 恢复监听（手动或到点自动）。没挂载的仓只清登记——下次 attach 会按常规自己起。 */
  resumeWatching(repositoryId: string): { paused: boolean; woken: boolean } {
    const previous = this.watchPaused.get(repositoryId);
    if (previous?.timer) clearTimeout(previous.timer);
    this.watchPaused.delete(repositoryId);
    const mounted = this.repositories.get(repositoryId);
    if (!mounted) return { paused: false, woken: false };
    const started = this.startWatcher(mounted);
    mounted.watcher = started.watcher;
    mounted.watch = started.watch;
    // 挂起这段时间磁盘可能已经变了：新鲜度必须重算，否则界面拿着挂起前那一刻的判定说「产物是新的」
    mounted.freshness = judgeFreshness(mounted.path, mounted.index, mounted.analysis);
    traceEngine("mount", { repositoryId, phase: "watch_resumed", freshness: mounted.freshness.verdict, changedWhilePaused: mounted.freshness.changedFiles }, { traceId: null });
    return { paused: false, woken: true };
  }

  /** 此刻的挂起读数（到点即视为已恢复，顺带清登记）。 */
  watchPauseOf(repositoryId: string): { paused: boolean; until?: number } {
    const entry = this.watchPaused.get(repositoryId);
    if (!entry) return { paused: false };
    if (entry.until <= Date.now()) {
      this.resumeWatching(repositoryId);
      return { paused: false };
    }
    return { paused: true, until: entry.until };
  }

  /** 驱逐 = 关它的 fs 监听 + 从内存移除（`fs.FSWatcher.close()` 幂等，重复关闭无害）。
    刻意**不**清内存态 L2 缓存（流程 / 推荐入口）：键里已经带 `repositoryId` + 本层输入哈希，
    换仓后不可能误命中；实测切仓时清缓存会让下一个回合把完全相同的输入重烧一次
    （切换 → 重烧 ≈1.5k in / 200 out），而「切回来还要用」才是常见路径。两层的 TTL + 条数上限本身就把驻留量兜住了。
    */
  private evictBeyondLru(): void {
    while (this.lru.length > maxMounted()) {
      const oldest = this.lru.shift();
      if (!oldest) break;
      const repository = this.repositories.get(oldest);
      this.unmountOne(oldest);
      if (repository) traceEngine("mount", { repositoryId: oldest, phase: "evicted", mounted: this.repositories.size }, { traceId: null });
    }
  }

  private unmountOne(repositoryId: string): void {
    const repository = this.repositories.get(repositoryId);
    repository?.watcher?.close();
    // 句柄的关闭按引用计数走：驱逐时若还有请求卡在 await 里，它挂起等最后一个 unpin（见 RepositoryHandle）
    repository?.handle.close();
    this.repositories.delete(repositoryId);
    const position = this.lru.indexOf(repositoryId);
    if (position >= 0) this.lru.splice(position, 1);
  }

  private async run(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const startedAt = Date.now();
    try {
      this.update(job, "indexing", 10, "正在建立文件树与 Git 热点索引");
      const imported = await this.analyze(job.repositoryPath, (phase, progress, message) => this.update(job, phase, progress, message), job.summaryHeaderComments);
      const { index, course, estimate, analysis, handle } = imported;

      // 新导入的仓库进地址簿（最近使用在后）并就地挂载；其它已挂载仓库不再被卸载。
      // 这一轮的句柄直接交给挂载项——它已经在 analyze 里开好并跑过 migrate，再开一份就是两个连接。
      this.attach({ path: job.repositoryPath, index, course, estimate, analysis, handle });
      job.repositoryId = index.repositoryId;
      try {
        rememberRepository(job.repositoryPath);
      } catch (error) {
        // 地址簿写失败不影响导入结果（重启后大不了重新导入），只提示
        console.warn(`[import] 仓库地址簿写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
      // 读不到的文件只让它们自己缺席，但要在完成消息里点名：否则「导入成功」会把少索引这件事盖住
      const unreadableNote = imported.index.unreadable?.length ? `（${imported.index.unreadable.length} 个文件读不到，已跳过：${imported.index.unreadable.slice(0, 3).map((file) => file.path).join("、")}${imported.index.unreadable.length > 3 ? " 等" : ""}）` : "";
      this.update(job, "completed", 100, `导入完成：${index.totalFiles} 个文件，${course.root.children.length} 个课程分区${unreadableNote}`);
      job.completedAt = new Date().toISOString();
      traceEngine("import", { job: jobId, phase: "completed", repositoryId: index.repositoryId, files: index.totalFiles, cards: course.root.children.length, unreadable: index.unreadable?.length ?? 0 }, { traceId: null, durationMs: Date.now() - startedAt });
    } catch (error) {
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.message = "导入失败";
      this.publish({ type: "import.progress", payload: job as unknown as Record<string, unknown> });
      traceEngine("import", { job: jobId, phase: "failed", error: job.error }, { traceId: null, durationMs: Date.now() - startedAt });
    }
  }

  /**
    句柄生命周期只认这一层，而且分两种情况——这是「漏关就漏 FD」那条评论的继任者：
    - **新建档**（导入那一轮，没传 `existing`）：建的那份交给调用方，成功就进挂载项活到卸载；
      中途抛错则由这里就地关一次，不让一次失败的导入留下连接。
    - **复用挂载句柄**（增量重分析传进 `existing`）：绝不由这一层关。重分析跑在监听触发的后台队列里，
      句柄同时被在途请求用着，关闭的唯一入口是卸载（`unmountOne`）。
    */
  private async analyze(repositoryPath: string, progress: (phase: ImportJob["phase"], value: number, message: string) => void, summaryHeaderComments?: boolean, preScanned?: RepositoryScan, existing?: RepositoryHandle): Promise<AnalyzedRepository> {
    const handle = existing ?? new RepositoryHandle(repositoryPath, catalogRepositoryId(repositoryPath));
    try {
      return await this.analyzeWith(repositoryPath, handle, progress, summaryHeaderComments, preScanned);
    } catch (error) {
      if (!existing) handle.close();
      throw error;
    }
  }

  private async analyzeWith(repositoryPath: string, handle: RepositoryHandle, progress: (phase: ImportJob["phase"], value: number, message: string) => void, summaryHeaderComments?: boolean, preScanned?: RepositoryScan): Promise<AnalyzedRepository> {
    progress("indexing", 10, "正在建立文件树、Git 热点与语义后备索引");
    // 增量重分析先扫过一次再决定要不要跑整轮（`reanalyzeOnce`），那份结果直接接手，别把同一个仓扫两遍
    const scan = preScanned ?? scanRepositoryWithDigests(repositoryPath);
    const index = scan.index;
    // versionStamp 是全量源码内容哈希：内容不变 → 值不变，是「润色结果可否复用」的判据
    const versionStamp = contentVersion(repositoryPath, index, scan.digests);
    handle.db.saveIndex(index);
    progress("summarizing", 40, "正在生成分层摘要并检查缓存");
    // 每仓设置先读出来：`summaryHeaderComments` 决定 L1 切片/提示词是否带注释档（默认关），
    // `refinement`/`monthlyBudgetUsd` 后面润色缓存与预算还要用同一份。
    let storedSettings = handle.db.getSettings<{ refinement?: RefinementMarker; monthlyBudgetUsd?: number; summaryHeaderComments?: boolean }>(index.repositoryId);
    // 导入页的显式选择是**该仓摘要口径唯一的写入时点之一**（另一个是成本监控页开关）：读-合并-写保住其它键，
    // 之后的增量重分析/重导入不再带选择，只读这份落库值。本地副本同步更新——
    // 后面润色标记的读-合并-写展开的就是这份，不更新会把刚写的开关冲掉（真仓实测抓到的丢失更新）。
    if (summaryHeaderComments !== undefined) {
      storedSettings = { ...(storedSettings ?? {}), summaryHeaderComments };
      handle.db.saveSettings(index.repositoryId, storedSettings);
    }
    const withHeaderComments = summaryHeaderComments ?? storedSettings?.summaryHeaderComments === true;
    /**
      该仓预算：取落库值，取不到才用默认。这里**必须**用同一份，否则「把预算改成 $1」的人
      在导入这一步仍按 $5 判——而导入恰好是全流程里最贵的一步（L1 摘要 + 宏观润色）。
      */
    const budgetUsd = storedSettings?.monthlyBudgetUsd ?? defaultMonthlyBudgetUsd;
    // 判据只留一处（`cost.ts` 的 `budgetExceeded`）：这里以前自己抄了一遍 `mode === "degraded"`，
    // 与对话那八处成了两个副本。单价没配时钱恒算 0 ⇒ 闸门一路放行且不报错，
    // 那一档必须作为读数交出去（`/cost` 与成本页、启动日志同一口径，见 `budgetGateNotice`）。
    const lightProvider = budgetExceeded(repositoryPath, budgetUsd) ? undefined : buildLlmRuntimeProvider("light");
    const provider = createSummaryProvider({ llm: lightProvider, withHeaderComments });
    // ⚠️ 顺序不能反：L1 的输入是**结构切片**（符号 + 依赖方向），所以必须先建图再摘要。
    // 旧版是「先摘要、后建图」（那时摘要吃的是整份正文，不需要图）。
    // 语法解析器是异步加载的，必须在建图前就绪；加载失败不抛错，改由 graph 记录回落原因。
    await loadSymbolParser();
    const baseGraph = buildDependencyGraph(repositoryPath, index.files);
    const { summaries, estimate } = await summarizeFiles({
      structure: fileStructureOf(index.files, baseGraph),
      database: handle.db,
      provider,
      withHeaderComments
    });
    progress("building_course", 75, "正在生成微观单元和影响图");
    const graph = await enrichWithLsp(repositoryPath, baseGraph);
    const implementations = buildImplementationUnits(repositoryPath, graph.symbols);
    const draftCourse = buildCourseTree({ repositoryId: index.repositoryId, modelVersion: provider.modelVersion, files: index.files, summaries, graph, implementations });
    const quality = verifyAnalysis(repositoryPath, implementations, draftCourse.root, { timeoutMs: 2_500 });
    const verifiedImplementations = implementations.map((unit) => ({
      ...unit,
      verification: quality.micro.filter((check) => check.anchors[0]?.path === unit.symbol.path && check.anchors[0]?.line === unit.symbol.line)
    }));
    let course = buildCourseTree({ repositoryId: index.repositoryId, modelVersion: provider.modelVersion, files: index.files, summaries, graph, implementations: verifiedImplementations });
    course = attachQuality(course, quality);
    // 宏观设计 LLM 完善层：命名/摘要语义化（结构仍由静态分析锚定；失败原样返回）
    // 走运行时构建器（GUI 设置的模型覆盖生效）；light 档思考强制 off——宏观设计润色是结构化重命名，不需要思考
    // 润色缓存：`settings.refinement` 标记里的四个维度（源码内容 / 模型 / 口径版本 / 图后端）全对上才复用已润色 course。
    // 这是「engine 重启 → GUI 重新导入」不重烧 LLM 账单的关键；标记只在润色确有产出（usage 非空）时写入，失败不缓存。
    const storedAnalysis = handle.db.getAnalysis(index.repositoryId);
    const storedCourse = handle.db.getCourse(index.repositoryId);
    // 图后端指纹：LSP 从降级恢复、语法解析回落变化都发生在**源码内容不变**的时候，只比 versionStamp 抓不到，
    // 会把降级证据下算出的命名当成事实继续复用（同型坑见 docs/开发关键点问题与解决方案.md §3.6）。
    const backendStamp = hash(`${graph.semanticBackend}:${graph.parseBackend}:${JSON.stringify(graph.lspStatus)}`);
    const refinementCacheHit = Boolean(
      storedAnalysis?.versionStamp === versionStamp && storedCourse && refinementIsFresh(storedSettings?.refinement, {
        versionStamp,
        contractVersion: REFINE_STEP.contractVersion,
        backendStamp,
        ...(lightProvider ? { modelVersion: lightProvider.modelVersion } : {})
      })
    );
    if (refinementCacheHit) {
      course = storedCourse as CourseTree;
    } else if (!budgetExceeded(repositoryPath, budgetUsd)) {
      // 复用导入开头建好的轻量档实例（运行期设置在一次导入内不会变）；预算另查一次——
      // L1 摘要可能刚花掉一部分，所以不能沿用开头那个判断结果
      const mapProvider = lightProvider;
      if (mapProvider) {
        progress("building_course", 85, "正在用 LLM 完善宏观设计命名与摘要");
        const refinement = await refineCourseMap(course, mapProvider);
        course = refinement.course;
        if (refinement.usage) {
          handle.journal.append("token_usage", {
            input_tokens: refinement.usage.inputTokens,
            output_tokens: refinement.usage.outputTokens,
            cache_hit_tokens: refinement.usage.promptCacheHitTokens ?? null,
            provider: mapProvider.modelVersion,
            scene: "course_map"
          });
          // 读-合并-写：settings 里还存着 monthlyBudgetUsd 等其他键，不能整体覆盖
          handle.db.saveSettings(index.repositoryId, { ...(storedSettings ?? {}), refinement: { versionStamp, modelVersion: mapProvider.modelVersion, contractVersion: REFINE_STEP.contractVersion, backendStamp } });
        }
      }
    }
    // 微观归组投影跑在润色（含其缓存命中路径）之后：润色的输入结构不变，归组只是重挂位置、可重复执行
    course = groupImplementationsByModule(course);
    const analysisHead = gitHeadOf(repositoryPath);
    const analysis: RepositoryAnalysis = {
      repositoryId: index.repositoryId,
      generatedAt: new Date().toISOString(),
      graph: serializeGraph(graph),
      implementations: verifiedImplementations,
      quality,
      versionStamp,
      // 记下分析时的 HEAD：懒挂载要靠它区分「内容没变但分析点在另一个提交上」与真的过期
      ...(analysisHead ? { gitHead: analysisHead } : {})
    };
    handle.db.saveCourse(course, estimate);
    handle.db.saveAnalysis(analysis);
    return { path: repositoryPath, index, course, estimate, analysis, handle };
  }

  /**
    在途守卫 + 变更合并：watcher 的 debounce 只有 450ms，而一轮全量重分析（含 LLM 润色）远长于此。
    重叠回合会让「先启动、后完成」的那轮用旧快照回写内存与 SQLite，并且每轮都重烧一次全量润色。
    在途时新到的路径只累积进 pending，本轮结束后合并成下一轮——路径不丢，轮次不重叠。
    */
  private async reanalyzeIncrementally(repositoryId: string, changedPaths: string[]): Promise<void> {
    const queue = this.reanalysisQueues.get(repositoryId);
    if (queue) {
      for (const path of changedPaths) queue.pending.add(path);
      await queue.running;
      return;
    }
    const pending = new Set(changedPaths);
    const running = this.drainReanalysis(repositoryId, pending);
    this.reanalysisQueues.set(repositoryId, { running, pending });
    try {
      await running;
    } finally {
      this.reanalysisQueues.delete(repositoryId);
    }
  }

  private async drainReanalysis(repositoryId: string, pending: Set<string>): Promise<void> {
    while (pending.size) {
      const paths = [...pending];
      pending.clear();
      await this.reanalyzeOnce(repositoryId, paths);
    }
  }

  /** 一轮重分析。本函数不 reject——它跑在在途队列里，抛出会让 watcher 的 fire-and-forget 变成未处理拒绝。 */
  private async reanalyzeOnce(repositoryId: string, changedPaths: string[]): Promise<void> {
    const current = this.repositories.get(repositoryId);
    if (!current) return;
    const startedAt = Date.now();
    let impactedPaths: string[] = [];
    /**
      整轮重分析跨几十秒的 await（建图、摘要、润色），期间 LRU 驱逐或用户把仓移出地址簿都不能把这份
      连接关掉——关了就等于让下一次语句拿着已关闭的句柄。pin 住它，`finally` 里放开；
      真有挂起的关闭请求，会在最后一个引用放开时才落地。
      */
    current.handle.pin();
    try {
      /**
        先重扫一遍「收录集 + 每文件内容哈希」，再决定要不要跑整轮。
        监听报上来的改动经常不落在收录集里（往仓根放一张 `.png` 会顶一下仓根的 mtime；
        macOS 建流时还会把目录近期历史倒还一遍），而重分析不问缘由地跑完就回写：
        产物对象被换、SQLite 被重写、`repository.updated` 广播出去，界面以为刚重算过——
        测试里那份手工造的 fixture 产物也是这样被真扫描取代的（#163）。
        */
      const rescan = scanRepositoryWithDigests(current.path);
      if (sameIngestedContent(current.index, rescan.index)) {
        traceEngine("reindex", { repositoryId, changed: changedPaths.length, ok: true, noop: true }, { traceId: null, durationMs: Date.now() - startedAt });
        return;
      }
      impactedPaths = impactRadius(graphFromData(current.analysis.graph), changedPaths).impactedPaths;
      // 复用挂载句柄跑这一轮（不再另开一份连接）：见 `analyze` 的两种生命周期
      const next = await this.analyze(current.path, () => undefined, undefined, rescan, current.handle);
      // 回写前确认挂载项没被换掉：换仓 / 重新导入会让这一轮基于旧快照，写回即用脏数据覆盖内存与
      // SQLite，甚至把刚卸载、watcher 已 close 的仓库复活进映射（破坏「挂载集合 = 监听集合」单槽不变量）。
      if (this.repositories.get(repositoryId) !== current) {
        traceEngine("reindex", { repositoryId, changed: changedPaths.length, ok: false, error: "unmounted-during-run" }, { traceId: null, durationMs: Date.now() - startedAt });
        return;
      }
      next.analysis.lastIncrementalUpdate = { changedPaths, impactedPaths, at: new Date().toISOString() };
      current.handle.db.saveAnalysis(next.analysis);
      // 新鲜度重算一遍：这一轮就是照着当前磁盘内容算的，正常会判 fresh；
      // 要是这几十秒里又改了文件，如实报脏，下一次访问会再排一轮——不假装它是新的。
      this.repositories.set(repositoryId, { ...next, watcher: current.watcher, watch: current.watcher?.watchStatus ?? current.watch, freshness: judgeFreshness(current.path, next.index, next.analysis) });
      this.publish({ type: "repository.updated", payload: { repositoryId, changedPaths, impactedPaths } });
      // 只记条数与结果，不把路径数组写入日志（payload 口径只允许标量）
      traceEngine("reindex", { repositoryId, changed: changedPaths.length, impacted: impactedPaths.length, ok: true }, { traceId: null, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ type: "repository.updated", payload: { repositoryId, changedPaths, error: message } });
      traceEngine("reindex", { repositoryId, changed: changedPaths.length, impacted: impactedPaths.length, ok: false, error: message }, { traceId: null, durationMs: Date.now() - startedAt });
    } finally {
      current.handle.unpin();
    }
  }

  private update(job: ImportJob, phase: ImportJob["phase"], progress: number, message: string): void {
    job.phase = phase;
    job.progress = progress;
    job.message = message;
    this.publish({ type: "import.progress", payload: job as unknown as Record<string, unknown> });
  }

  private publish(event: ServerEvent): void {
    this.emit("event", event);
  }
}

function validateRepositoryPath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== "string" || !inputPath.trim()) throw new Error("请提供待学习仓库的绝对路径");
  const raw = normalizeInput(inputPath);
  if (!raw) throw new Error("请提供待学习仓库的绝对路径");
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    throw new Error(`请提供绝对路径（或 ~/ 开头）："${raw}" 是相对路径，引擎无法确定你指的是哪个目录`);
  }
  let path: string;
  try {
    path = realpathSync(expanded);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`路径不存在：${expanded}`);
    if (code === "EACCES") throw new Error(`路径无法访问（权限不足）：${expanded}`);
    if (code === "ELOOP") throw new Error(`路径包含循环符号链接，无法解析：${expanded}`);
    if (code === "ENOTDIR") throw new Error(`路径中有一段不是目录：${expanded}`);
    throw new Error(`无法解析路径 ${expanded}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!statSync(path).isDirectory()) throw new Error(`导入路径必须是目录，收到的是文件：${path}`);
  return path;
}

/**
 * 归一化用户粘贴的路径：
 * - 去掉首尾空白（含全角空格）
 * - 去掉成对包裹的引号 / 反引号（从终端复制 `cd "~/my repo"` 时常见）
 * - 去掉 `file://` 前缀（从浏览器地址栏拖拽 / 复制时常见）
 */
function normalizeInput(raw: string): string {
  let value = raw.replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      value = value.slice(1, -1).trim();
    }
  }
  if (value.startsWith("file://")) {
    try { value = decodeURIComponent(value.slice("file://".length)); } catch { value = value.slice("file://".length); }
  }
  return value;
}

/** 展开 `~` 与 `~/...` 为用户 home 目录；其他形式原样返回，交给 isAbsolute 校验。 */
function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

/** Exercise cache versioning follows source content, not an import timestamp. */
function contentVersion(repositoryPath: string, index: RepositoryIndex, digests?: Map<string, string>): string {
  // 与新鲜度判定共用同一次实现：两边口径必须逐字相同，否则挂载时永远比不中、每次访问都报过期
  return stampAndDiff(repositoryPath, index, digests).versionStamp;
}

/** 落在 settings 里的宏观润色标记：记录「这份已润色的课程树是在什么输入下算出来的」。 */
export type RefinementMarker = { versionStamp?: string; modelVersion?: string; contractVersion?: string; backendStamp?: string };

/**
  润色缓存能否复用：标记里的四个维度全对上才算命中——源码内容、当时用哪个模型润的、本层提示词口径、图后端。
  唯独 `modelVersion` 默认（当前没有可用模型：未配置或预算已达上限）时放行——复用上次成功的润色结果，
  好于把它丢掉、退回未润色的裸命名。旧标记缺某个字段时该维度自然不等 → 未命中，重润一次属预期。
 */
export function refinementIsFresh(marker: RefinementMarker | undefined, current: { versionStamp: string; contractVersion: string; backendStamp: string; modelVersion?: string }): boolean {
  if (!marker) return false;
  if (marker.versionStamp !== current.versionStamp) return false;
  if (marker.contractVersion !== current.contractVersion) return false;
  if (marker.backendStamp !== current.backendStamp) return false;
  return current.modelVersion === undefined || marker.modelVersion === current.modelVersion;
}
