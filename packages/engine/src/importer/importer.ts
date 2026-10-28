import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { ImportJob, RepositoryCatalogEntry, RepositoryFreshness, RepositoryMountReason, ServerEvent } from "@codebase-tutor/contract";
import type { ImportEstimate, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";
import type { AuditLine } from "../application/port/audit-sink.js";
import type { ChatStore } from "../application/port/chat-store.js";

import { buildLlmRuntimeProvider } from "../adapter/outbound/llm/runtime.js";
import { budgetExceeded, budgetGateNotice, defaultMonthlyBudgetUsd } from "../cost/cost.js";
import { buildDependencyGraph, graphFromData, impactRadius, serializeGraph } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";
import { collectFileFacts, saveFileFacts } from "../facts/build.js";
import { fileStructureOf } from "@codebase-tutor/analysis";
import { buildImplementationUnits } from "../implementation/units.js";
import { catalogRepositoryId, hash, id } from "@codebase-tutor/platform";
import { scanRepositoryWithDigests, type RepositoryScan } from "../indexer/indexer.js";
import { tutorDataDir } from "@codebase-tutor/platform";
import { RepositoryWatcher, type WatchStatus } from "../indexer/watcher.js";
import { enrichWithLsp } from "@codebase-tutor/analysis";
import { createSummaryProvider } from "../summarizer/summary-provider.js";
import { summarizeFiles } from "../summarizer/summarizer.js";
import { chatStoreFor } from "../adapter/outbound/persistence/chat-store.js";
import { auditLineFor, Journal, journalFootprint } from "../adapter/outbound/persistence/journal.js";
import { RepositoryHandle } from "../adapter/outbound/persistence/repository-handle.js";
import { traceEngine } from "@codebase-tutor/platform";

/** `analyze` 的产物：不含挂载态字段（监听与新鲜度在 `attach` 时才存在）。 */
type AnalyzedRepository = Omit<ImportedRepository, "watcher" | "freshness" | "watch" | "audit" | "chatStore">;

export interface ImportedRepository {
  path: string;
  index: RepositoryIndex;
  estimate: ImportEstimate;
  analysis: RepositoryAnalysis;
  /** 这份产物的连接生命周期（一份 SQLite + 一条审计线），随挂载创建、随卸载关闭。 */
  handle: RepositoryHandle;
  /** 这条仓的审计线（写 + 读）；路径与仓 id 的配对只在挂载这一处发生。 */
  audit: AuditLine;
  /** 这一仓的会话线程读写口；与 `audit` 同一处置，挂载那一刻交出。 */
  chatStore: ChatStore;
  watcher?: RepositoryWatcher;
  /** 挂载那一刻算出的新鲜度（内容哈希 + git HEAD）；只报告，不触发重分析。 */
  freshness: RepositoryFreshness;
  /** fs 监听的死活，随挂载结果一起交出；监听没起来时 `freshness` 只到挂载那一刻为止。 */
  watch: WatchStatus;
}

/** 挂载注册表（地址簿）路径；默认 ~/.codebase-tutor/repositories.json，`TUTOR_REGISTRY_FILE` 可覆盖。 */
function registryFile(): string {
  return process.env.TUTOR_REGISTRY_FILE ?? join(tutorDataDir(), "repositories.json");
}

function preserveCorruptRegistry(file: string): string {
  const backup = `${file}.corrupt`;
  try { copyFileSync(file, backup); } catch { /* 备份写不动也要继续走告警 */ }
  return backup;
}

function readRegistry(): string[] {
  const file = registryFile();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // ENOENT 是常态；读不动时先留原件再按空处理。
    if ((error as { code?: string }).code === "ENOENT") return [];
    preserveCorruptRegistry(file);
    console.warn(`[registry] 地址簿读不动，本轮按空处理：file=${file} error=${String(error)}`);
    traceEngine("mount", { phase: "registry_unreadable", file }, { traceId: null });
    return [];
  }
  let parsed: { repositories?: unknown };
  try {
    parsed = JSON.parse(text) as { repositories?: unknown };
  } catch (error) {
    const backup = preserveCorruptRegistry(file);
    console.warn(`[registry] 地址簿不是合法 JSON，本轮按空处理：backup=${backup} error=${String(error)}`);
    traceEngine("mount", { phase: "registry_corrupt", file, backup }, { traceId: null });
    return [];
  }
  if (!Array.isArray(parsed.repositories)) return [];
  const seen = new Set<string>();
  return parsed.repositories.filter((item): item is string => typeof item === "string" && item.length > 0 && !seen.has(item) && !!seen.add(item));
}

function writeRegistry(paths: string[]): void {
  const file = registryFile();
  mkdirSync(dirname(file), { recursive: true });
  // 先写临时文件再改名覆盖，避免半个 JSON。
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ repositories: paths }, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

/** 记进地址簿并挪到末尾（最近使用在后）。 */
function rememberRepository(repositoryPath: string): void {
  writeRegistry([...readRegistry().filter((item) => item !== repositoryPath), repositoryPath]);
}

/** 从地址簿里移除一条；不动仓库自己的 .tutor 产物。 */
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

/** 同时挂载（一个 fs 监听 + 一份产物内存态）的上限；每次读 `TUTOR_MAX_MOUNTED`，便于测试换档。 */
function maxMounted(): number {
  return Math.max(1, Number(process.env.TUTOR_MAX_MOUNTED ?? 3) || 3);
}

/** 分析那一刻的 git HEAD；非 git 仓或无提交返回 undefined。 */
function gitHeadOf(repositoryPath: string): string | undefined {
  try {
    const head = execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 1_500, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return head || undefined;
  } catch {
    return undefined;
  }
}

/** 一次遍历算出当前内容哈希与相对落库 contentHash 的变化文件数。 */
function stampAndDiff(repositoryPath: string, index: RepositoryIndex, digests?: Map<string, string>): { versionStamp: string; changedFiles: number } {
  let changedFiles = 0;
  // 拼法必须与 `contentVersion` / 索引器一致（utf8 读、path:hash），否则新鲜度永远比不中。
  // 拼进 stamp 的是完整 64 位哈希，不是索引里的 16 位前缀。
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
      changedFiles += 1; // 读不到按「已改动」计
      return `${file.path}:${digest}`;
    }
    if (file.contentHash && !digest.startsWith(file.contentHash)) changedFiles += 1;
    return `${file.path}:${digest}`;
  });
  contents.sort();
  return { versionStamp: `content:${hash(contents.join("\n")).slice(0, 24)}`, changedFiles };
}

/** 两次扫描的「收录集 + 每文件内容哈希」是否完全一致；任一侧缺 `contentHash` 按不一致处理。 */
export function sameIngestedContent(previous: RepositoryIndex, next: RepositoryIndex): boolean {
  if (previous.files.length !== next.files.length) return false;
  const incoming = new Map(next.files.map((file) => [file.path, file.contentHash]));
  return previous.files.every((file) => {
    const before = file.contentHash;
    const after = incoming.get(file.path);
    return Boolean(before) && before === after;
  });
}

/** 新鲜度判定（只报告，不自动重分析）：内容不等 = stale，HEAD 移动 = drifted，无 HEAD 记录 = unknown。 */
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

/** 编辑期免打扰窗口的默认值与上下限（毫秒），到点自动恢复。 */
const WATCH_PAUSE_DEFAULT_MS = 30 * 60_000;
const WATCH_PAUSE_MIN_MS = 60_000;
const WATCH_PAUSE_MAX_MS = 6 * 60 * 60_000;
const pauseWindow = (ms: number): number => (Number.isFinite(ms) && ms > 0 ? Math.round(ms) : WATCH_PAUSE_DEFAULT_MS) || WATCH_PAUSE_DEFAULT_MS;

export class ImportService extends EventEmitter {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly repositories = new Map<string, ImportedRepository>();
  /** 已挂载仓库的 LRU 序（最近使用在后）。 */
  private readonly lru: string[] = [];
  private queue = Promise.resolve();
  /** 每个仓库至多一轮重分析在途；running 期间新路径先累积，本轮结束后合并跑。 */
  private readonly reanalysisQueues = new Map<string, { running: Promise<void>; pending: Set<string> }>();
  /** 监听被挂起的仓（编辑期免打扰）；放在挂载态之外，需要活过驱逐与重新挂载。 */
  private readonly watchPaused = new Map<string, { until: number; timer?: ReturnType<typeof setTimeout> }>();


  submit(inputPath: string, summaryHeaderComments?: boolean): ImportJob {
    const repositoryPath = validateRepositoryPath(inputPath);
    const job: ImportJob = { id: id(), repositoryPath, phase: "queued", progress: 0, message: "已加入导入队列", createdAt: new Date().toISOString(), ...(summaryHeaderComments === undefined ? {} : { summaryHeaderComments }) };
    this.jobs.set(job.id, job);
    // 排队回调继承挂上去那一刻的请求上下文：这一轮导入的花费只靠这个 reqId 关联。
    this.queue = this.queue.then(() => this.run(job.id)).catch(() => undefined);
    return job;
  }

  getJob(jobId: string): ImportJob | undefined {
    return this.jobs.get(jobId);
  }

  getRepository(repositoryId: string): ImportedRepository | undefined {
    return this.repositories.get(repositoryId);
  }

  /** 当前挂在内存里的仓库（≤ `maxMounted()`）；地址簿全量看 `catalog()`。 */
  mountedRepositories(): ImportedRepository[] {
    return [...this.repositories.values()];
  }

  /** 会话线程读写口按库路径交出：被 LRU 驱逐的仓仍要读得到它留下的线程。 */
  chatStore(repositoryPath: string): ChatStore {
    return chatStoreFor(repositoryPath);
  }

  /** 未挂载仓的审计线：按 threadId 找回仓、后台收尾的回合账都从这一格写。 */
  audit(repositoryPath: string, repositoryId: string): AuditLine {
    return auditLineFor(repositoryPath, repositoryId);
  }

  /** 地址簿清单：不读任何产物；只有挂载项带挂载时算好的新鲜度。 */
  catalog(): RepositoryCatalogEntry[] {
    const paths = readRegistry();
    for (const repository of this.repositories.values()) if (!paths.includes(repository.path)) paths.push(repository.path);
    // 预算闸门读数只依赖进程环境变量，未挂载时也要出现在清单上。
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

              watching: mounted.watch.started && !mounted.watch.dead,
              ...(this.watchPauseOf(repositoryId).paused ? { watchPaused: true, watchPausedUntil: new Date(this.watchPauseOf(repositoryId).until ?? 0).toISOString() } : {}),
              ...(mounted.watch.error ? { watchError: mounted.watch.error.slice(0, 160) } : {})
            }
          : {})
      };
    });
  }

  /** 懒挂载：已挂着只更新 LRU；失败分三种原因，任何一种都不触发重分析。 */
  ensureMounted(repositoryId: string): { ok: true; repository: ImportedRepository } | { ok: false; reason: RepositoryMountReason; message: string } {
    const live = this.repositories.get(repositoryId);
    if (live) {
      this.touch(live.index.repositoryId);
      return { ok: true, repository: live };
    }
    const path = readRegistry().find((item) => catalogRepositoryId(item) === repositoryId);
    if (!path) return { ok: false, reason: "not_in_catalog", message: "这个仓库不在引擎的地址簿里；请重新导入以恢复它。" };
    if (!isDirectory(path)) return { ok: false, reason: "directory_missing", message: `地址簿记的目录已经不在了：${path}。把仓库放回该路径，或重新导入。` };
    let index: RepositoryIndex | undefined;
    let analysis: RepositoryAnalysis | undefined;
    let estimate: ImportEstimate | undefined;
    /** 句柄从这里起交给挂载项；这一带任何一步失败都由当前的 `close()` 收尾。 */
    let handle: RepositoryHandle | undefined;
    try {
      handle = new RepositoryHandle(path, repositoryId);
      index = handle.db.state.index(repositoryId);
      analysis = handle.db.state.analysis(repositoryId);
      estimate = handle.db.state.estimate(repositoryId);
    } catch {
      handle?.close();
      return { ok: false, reason: "artifacts_incomplete", message: `${path} 的分析结果读不出来（文件损坏或权限不足），需要重新导入。` };
    }
    if (!index || !analysis || !estimate) {
      handle?.close();
      return { ok: false, reason: "artifacts_incomplete", message: `${path} 的分析结果不完整，需要重新导入才能继续。` };
    }
    const startedAt = Date.now();
    const repository = this.attach({ path, index, estimate, analysis, handle });

    const journal = journalFootprint(path);
    traceEngine("mount", { repositoryId, phase: "lazy", verdict: repository.freshness.verdict, changedFiles: repository.freshness.changedFiles, mounted: this.repositories.size, journalLines: journal.lines, journalBytes: journal.bytes, schemaGaps: repository.handle.schemaGaps.length }, { traceId: null, durationMs: Date.now() - startedAt });
    // 缺列在挂载这一次就报出来：只有真读到那一列才会炸。
    if (repository.handle.schemaGaps.length) console.warn(`[engine] ${path} 的产物库缺列：${repository.handle.schemaGaps.join("、")}——需要一条一次性迁移，光改声明补不上。`);
    return { ok: true, repository };
  }

  /** 用户显式把某仓移出地址簿并就地卸载；`deleteArtifacts` 只删仓根 `.tutor/`，不动全局日志。 */
  forget(repositoryId: string, deleteArtifacts = false): { artifacts?: "removed" | "absent" | "refused" } {
    const path = readRegistry().find((item) => catalogRepositoryId(item) === repositoryId);
    this.unmountOne(repositoryId);
    dropFromRegistry(repositoryId);
    // artifacts：removed 删了、absent 本来没有、refused 没敢删或删不动。
    if (!deleteArtifacts) return {};
    if (!path || !isAbsolute(path)) return { artifacts: "refused" };
    try {
      const target = realpathSync(join(path, ".tutor"));
      // 只删仓根下那个叫 .tutor 的真实目录；指向别处或不是目录就拒。
      if (!target.startsWith(`${realpathSync(path)}${sep}`) || !statSync(target).isDirectory()) return { artifacts: "refused" };
      rmSync(target, { recursive: true, force: true });
      traceEngine("mount", { repositoryId, phase: "artifacts_removed", path: target }, { traceId: null });
      return { artifacts: existsSync(target) ? "refused" : "removed" };
    } catch (error) {
      // ENOENT = 本来没有；EACCES/EPERM = 没删成。
      if ((error as { code?: string }).code === "ENOENT") return { artifacts: "absent" };
      console.warn(`[importer] ${path} 的 .tutor 没删掉：${String(error)}`);
      traceEngine("mount", { repositoryId, phase: "artifacts_remove_failed", error: String(error) }, { traceId: null });
      return { artifacts: "refused" };
    }
  }

  /** 挂载一个仓库并开监听；按 LRU 驱逐超出 `maxMounted()` 的最久未用项，只关监听与移出内存，磁盘产物不动。 */
  private attach(repository: AnalyzedRepository): ImportedRepository {
    const repositoryId = repository.index.repositoryId;
    const previous = this.repositories.get(repositoryId);
    previous?.watcher?.close();
    // 换句柄时关掉旧的；增量重分析传入同一份，那种情况不动它。
    if (previous && previous.handle !== repository.handle) previous.handle.close();
    // 挂起中：不开监听，产物与内存照用。
    const paused = this.watchPaused.has(repositoryId);
    if (paused) traceEngine("mount", { repositoryId, phase: "watch_skipped_paused" }, { traceId: null });
    const { watcher, watch } = paused ? { watcher: undefined, watch: { started: false, dead: false } } : this.startWatcher(repository);
    const mounted: ImportedRepository = {
      ...repository,
      audit: auditLineFor(repository.path, repository.index.repositoryId),
      chatStore: chatStoreFor(repository.path),
      watcher,
      watch,
      freshness: judgeFreshness(repository.path, repository.index, repository.analysis)
    };
    this.repositories.set(repositoryId, mounted);
    this.touch(repositoryId);
    this.evictBeyondLru();
    return mounted;
  }

  /** 记一次「刚用过」：挪到 LRU 末尾。 */
  private touch(repositoryId: string): void {
    const position = this.lru.indexOf(repositoryId);
    if (position >= 0) this.lru.splice(position, 1);
    this.lru.push(repositoryId);
  }

  /** 起一条 fs 监听并返回它的终态（attach 与恢复共用）。 */
  private startWatcher(repository: AnalyzedRepository): { watcher: RepositoryWatcher; watch: WatchStatus } {
    const repositoryId = repository.index.repositoryId;
    const watcher = new RepositoryWatcher(repository.path, (changedPaths) => void this.reanalyzeIncrementally(repositoryId, changedPaths), undefined, (message) => {
      // 监听起来后中途死掉时不再给事件，需要单独记账。
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

  /** 编辑期免打扰：关掉这个仓的 fs 监听，到点自动恢复。 */
  pauseWatching(repositoryId: string, ttlMs = WATCH_PAUSE_DEFAULT_MS): { paused: boolean; until: number } {
    const until = Date.now() + Math.min(WATCH_PAUSE_MAX_MS, Math.max(WATCH_PAUSE_MIN_MS, pauseWindow(ttlMs)));
    const previous = this.watchPaused.get(repositoryId);
    if (previous?.timer) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.resumeWatching(repositoryId), until - Date.now());
    timer.unref?.(); // 挂起定时器不该钉住进程
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
    // 挂起期间磁盘可能已变：新鲜度要重算。
    mounted.freshness = judgeFreshness(mounted.path, mounted.index, mounted.analysis);
    traceEngine("mount", { repositoryId, phase: "watch_resumed", freshness: mounted.freshness.verdict, changedWhilePaused: mounted.freshness.changedFiles }, { traceId: null });
    return { paused: false, woken: true };
  }

  /** 此刻的挂起读数；到点即视为已恢复。 */
  watchPauseOf(repositoryId: string): { paused: boolean; until?: number } {
    const entry = this.watchPaused.get(repositoryId);
    if (!entry) return { paused: false };
    if (entry.until <= Date.now()) {
      this.resumeWatching(repositoryId);
      return { paused: false };
    }
    return { paused: true, until: entry.until };
  }

  /** 驱逐 = 关它的 fs 监听 + 从内存移除；不清 L2 缓存（键含 `repositoryId` 与本层输入哈希，换仓不会误命中）。 */
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
    // 句柄按引用计数关闭：在途请求未清零时不真关。
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
      this.update(job, "indexing", 10, "正在读取文件结构");
      const imported = await this.analyze(job.repositoryPath, (phase, progress, message) => this.update(job, phase, progress, message), job.summaryHeaderComments);
      const { index, estimate, analysis, handle } = imported;

      // 新导入的仓进地址簿（最近使用在后）并就地挂载；句柄沿用 analyze 那一份，不再开第二个连接。
      this.attach({ path: job.repositoryPath, index, estimate, analysis, handle });
      job.repositoryId = index.repositoryId;
      try {
        rememberRepository(job.repositoryPath);
      } catch (error) {
        // 地址簿写失败不影响导入结果，只提示。
        console.warn(`[import] 仓库地址簿写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
      // 读不到的文件要在完成消息里点名。
      const unreadableNote = imported.index.unreadable?.length ? `（${imported.index.unreadable.length} 个文件读不到，已跳过：${imported.index.unreadable.slice(0, 3).map((file) => file.path).join("、")}${imported.index.unreadable.length > 3 ? " 等" : ""}）` : "";
      this.update(job, "completed", 100, `导入完成：${index.totalFiles} 个文件，${analysis.implementations.length} 个实现单元${unreadableNote}`);
      job.completedAt = new Date().toISOString();
      traceEngine("import", { job: jobId, phase: "completed", repositoryId: index.repositoryId, files: index.totalFiles, implementations: analysis.implementations.length, unreadable: index.unreadable?.length ?? 0 }, { traceId: null, durationMs: Date.now() - startedAt });
    } catch (error) {
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.message = "导入失败";
      this.publish({ type: "import.progress", payload: job as unknown as Record<string, unknown> });
      traceEngine("import", { job: jobId, phase: "failed", error: job.error }, { traceId: null, durationMs: Date.now() - startedAt });
    }
  }

  /** 句柄生命周期：新建档失败时就地关一次；复用挂载句柄时绝不由这一层关，唯一入口是卸载。 */
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
    progress("indexing", 10, "正在读取文件结构");
    // 增量重分析传入的扫描结果直接接手，不重复扫仓。
    const scan = preScanned ?? scanRepositoryWithDigests(repositoryPath);
    const index = scan.index;
    // versionStamp = 全量源码内容哈希，内容不变则值不变。
    const versionStamp = contentVersion(repositoryPath, index, scan.digests);
    handle.db.state.saveIndex(index);
    progress("summarizing", 40, "正在生成文件摘要并检查缓存");
    // 每仓设置先读出来：summaryHeaderComments 决定 L1 是否带注释档，预算后面还要用同一份。
    let storedSettings = handle.db.state.settings<{ monthlyBudgetUsd?: number; summaryHeaderComments?: boolean }>(index.repositoryId);
    // 导入页的显式选择是该仓摘要口径唯一的写入点；读-合并-写保住其它键。
    if (summaryHeaderComments !== undefined) {
      storedSettings = { ...(storedSettings ?? {}), summaryHeaderComments };
      handle.db.state.saveSettings(index.repositoryId, storedSettings);
    }
    const withHeaderComments = summaryHeaderComments ?? storedSettings?.summaryHeaderComments === true;
    // 该仓预算取落库值，取不到才用默认；这一处必须与闸门同一份。
    const budgetUsd = storedSettings?.monthlyBudgetUsd ?? defaultMonthlyBudgetUsd;
    // 单价未配时花费恒为 0，闸门放行这一状态要作为读数交出。
    const lightProvider = budgetExceeded(repositoryPath, budgetUsd) ? undefined : buildLlmRuntimeProvider("light");
    const provider = createSummaryProvider({ llm: lightProvider, withHeaderComments });
    // 顺序固定：L1 摘要的输入是结构切片，必须先建图。
    // 语法解析器异步加载，须在建图前就绪；失败不抛错，由 graph 记录回落原因。
    await loadSymbolParser();
    const baseGraph = buildDependencyGraph(repositoryPath, index.files);
    const summaryJournal = new Journal(repositoryPath, index.repositoryId);
    const { estimate } = await summarizeFiles({
      structure: fileStructureOf(index.files, baseGraph),
      store: handle.db.summaries,
      repositoryPath: handle.db.repositoryPath,
      provider,
      withHeaderComments,
      // 每一批花费当场入账 journal。
      onUsage: (usage) => {
        if (!usage || (!usage.inputTokens && !usage.outputTokens)) return;
        summaryJournal.append("token_usage", {
          input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
          cache_hit_tokens: usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "map.summary"
        });
      },
      // L1 是导入最慢的一段，逐批回报进度。
      onProgress: (done, total) => {
        const value = 40 + Math.round((35 * done) / Math.max(1, total));
        progress("summarizing", value, `正在生成文件摘要（${done}/${total}）`);
      }
    });
    progress("summarizing", 75, "正在整理模块与代码单元");
    const graph = await enrichWithLsp(repositoryPath, baseGraph);
    const implementations = buildImplementationUnits(repositoryPath, graph.symbols);
    const analysisHead = gitHeadOf(repositoryPath);
    const analysis: RepositoryAnalysis = {
      repositoryId: index.repositoryId,
      generatedAt: new Date().toISOString(),
      graph: serializeGraph(graph),
      implementations,
      versionStamp,
      // 记下分析时的 HEAD，供懒挂载区分 drifted 与 stale。
      ...(analysisHead ? { gitHead: analysisHead } : {})
    };
    handle.db.state.saveEstimate(index.repositoryId, estimate);
    handle.db.state.saveAnalysis(analysis);
    // 静态产物层零 token：失败降级但不阻断导入，并记 degrade。
    try {
      saveFileFacts(handle.db, index.repositoryId, collectFileFacts(repositoryPath, index.files, graph.symbols));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[engine] 静态产物层没算完（${reason}）：依赖图与摘要不受影响，但这次没有控制流图`);
      traceEngine("degrade", { component: "facts", repositoryId: index.repositoryId, reason }, { traceId: null });
    }
    return { path: repositoryPath, index, estimate, analysis, handle };
  }

  /** 在途守卫 + 变更合并：在途时新路径只累积进 pending，本轮结束后合并跑下一轮。 */
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

  /** 一轮重分析；不 reject——它跑在后台队列里，抛出会变成未处理拒绝。 */
  private async reanalyzeOnce(repositoryId: string, changedPaths: string[]): Promise<void> {
    const current = this.repositories.get(repositoryId);
    if (!current) return;
    const startedAt = Date.now();
    let impactedPaths: string[] = [];
    /** 整轮重分析跨多个 await；期间驱逐或移出地址簿都不能关掉这份连接。 */
    current.handle.pin();
    try {
      /** 先重扫收录集与每文件内容哈希，再决定要不要跑整轮。 */
      const rescan = scanRepositoryWithDigests(current.path);
      if (sameIngestedContent(current.index, rescan.index)) {
        traceEngine("reindex", { repositoryId, changed: changedPaths.length, ok: true, noop: true }, { traceId: null, durationMs: Date.now() - startedAt });
        return;
      }
      impactedPaths = impactRadius(graphFromData(current.analysis.graph), changedPaths).impactedPaths;

      const next = await this.analyze(current.path, () => undefined, undefined, rescan, current.handle);
      // 回写前确认挂载项没被换掉，避免用旧快照覆盖内存与 SQLite。
      if (this.repositories.get(repositoryId) !== current) {
        traceEngine("reindex", { repositoryId, changed: changedPaths.length, ok: false, error: "unmounted-during-run" }, { traceId: null, durationMs: Date.now() - startedAt });
        return;
      }
      next.analysis.lastIncrementalUpdate = { changedPaths, impactedPaths, at: new Date().toISOString() };
      current.handle.db.state.saveAnalysis(next.analysis);
      // 新鲜度按当前磁盘内容重算；这几十秒里又改了文件就如实报脏。
      this.repositories.set(repositoryId, { ...next, audit: current.audit, chatStore: current.chatStore, watcher: current.watcher, watch: current.watcher?.watchStatus ?? current.watch, freshness: judgeFreshness(current.path, next.index, next.analysis) });
      this.publish({ type: "repository.updated", payload: { repositoryId, changedPaths, impactedPaths } });
      // journal payload 只允许标量，不写路径数组。
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

/** 归一化用户粘贴的路径：去首尾空白、去成对引号或反引号、去 `file://` 前缀。 */
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

/** 展开 `~` 与 `~/...` 为 home 目录；其他形式原样返回。 */
function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

/** 练习缓存版本跟随源码内容，不跟随导入时间。 */
function contentVersion(repositoryPath: string, index: RepositoryIndex, digests?: Map<string, string>): string {
  return stampAndDiff(repositoryPath, index, digests).versionStamp;
}

