import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { CourseTree, ImportJob, ImportEstimate, RepositoryAnalysis, RepositoryIndex, ServerEvent } from "@codebase-tutor/shared";
import { attachQuality, buildCourseTree } from "../coursetree/build.js";
import { REFINEMENT_CONTRACT_VERSION, refineCourseMap } from "../coursetree/llm-refine.js";
import { buildLlmRuntimeProvider } from "../llm/runtime.js";
import { summarizeCost } from "../cost/service.js";
import { buildDependencyGraph, graphFromData, impactRadius, serializeGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";
import { fileStructureOf } from "../depgraph/roles.js";
import { buildImplementationUnits } from "../implementation/units.js";
import { hash, id, isWithin, repositoryId as deriveRepositoryId } from "../lib.js";
import { indexRepository } from "../indexer/indexer.js";
import { RepositoryWatcher } from "../indexer/watcher.js";
import { enrichWithLsp } from "../lsp/enrich.js";
import { verifyAnalysis } from "../quality/checker.js";
import { createSummaryProvider } from "../summarizer/provider.js";
import { summarizeFiles } from "../summarizer/summarizer.js";
import { TutorDatabase } from "../store/database.js";
import { Journal } from "../store/journal.js";
import { traceEngine } from "../trace/engine-log.js";

export interface ImportedRepository {
  path: string;
  index: RepositoryIndex;
  course: CourseTree;
  estimate: ImportEstimate;
  analysis: RepositoryAnalysis;
  watcher?: RepositoryWatcher;
}

/** 挂载注册表（单槽）：engine 重启后据此从该仓库的 .tutor/tutor.db 恢复挂载与监听，免重新导入。
    默认 ~/.codebase-tutor/repositories.json，测试可用 TUTOR_REGISTRY_FILE 覆盖。
    单槽 = 同一时刻只挂载/监听一个仓库；写文件时只留最后挂载的那一个（保留数组形状以兼容旧文件）。 */
function registryFile(): string {
  return process.env.TUTOR_REGISTRY_FILE ?? join(homedir(), ".codebase-tutor", "repositories.json");
}

function readRegistry(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(), "utf8")) as { repositories?: unknown };
    return Array.isArray(parsed.repositories) ? parsed.repositories.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeMountedRepository(repositoryPath?: string): void {
  const file = registryFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ repositories: repositoryPath ? [repositoryPath] : [] }, null, 2)}\n`, "utf8");
}

export class ImportService extends EventEmitter {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly repositories = new Map<string, ImportedRepository>();
  private queue = Promise.resolve();
  /** 每个仓库至多一轮重分析在途；running 期间新到的路径先累积，本轮结束后合并跑下一轮。 */
  private readonly reanalysisQueues = new Map<string, { running: Promise<void>; pending: Set<string> }>();

  submit(inputPath: string): ImportJob {
    const repositoryPath = validateRepositoryPath(inputPath);
    const job: ImportJob = { id: id(), repositoryPath, phase: "queued", progress: 0, message: "已加入导入队列", createdAt: new Date().toISOString() };
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

  findRepositoryForPath(candidatePath: string): ImportedRepository | undefined {
    return [...this.repositories.values()].find((repository) => isWithin(repository.path, candidatePath));
  }

  /**
    启动恢复（单槽）：只恢复注册表里最后挂载的那一个仓库——把它的 .tutor/tutor.db 里持久化的
    index/course/analysis 重新挂进内存并监听，GUI 侧已有 workspace 在 engine 重启后不再 404、
    无需重新导入（也就不再触发 LLM 润色重跑）。目录不存在或数据不全 → 不恢复任何仓库并清空注册表，
    避免失效条目在每次启动时被回挂、把该目录的任何写入都变成一次全量重分析。
    返回恢复的仓库数（0 或 1）；同时卸载内存里其它仓库，保证「挂载集合 = 监听集合」恒为单槽。
    */
  restorePersisted(): number {
    const target = readRegistry().at(-1);
    if (!target) { this.unmountAll(); return 0; }
    try {
      if (!statSync(target).isDirectory()) throw new Error("目录不存在");
      const repositoryId = deriveRepositoryId(target);
      const database = new TutorDatabase(target);
      const index = database.getIndex(repositoryId);
      const course = database.getCourse(repositoryId);
      const analysis = database.getAnalysis(repositoryId);
      const estimate = database.getEstimate(repositoryId);
      database.close();
      if (!index || !course || !analysis || !estimate) throw new Error(".tutor 数据不完整");
      this.mount({ path: target, index, course, estimate, analysis });
      writeMountedRepository(target);
      return 1;
    } catch {
      this.unmountAll();
      writeMountedRepository();
      return 0;
    }
  }

  /** 挂载一个仓库并监听：先卸载已有仓库（含同一 id 的旧实例，其 watcher 一并 close），保证单槽。 */
  private mount(repository: ImportedRepository): void {
    this.unmountAll();
    repository.watcher = new RepositoryWatcher(repository.path, (changedPaths) => void this.reanalyzeIncrementally(repository.index.repositoryId, changedPaths));
    repository.watcher.start();
    this.repositories.set(repository.index.repositoryId, repository);
  }

  /** 卸载全部仓库并停掉它们的 fs 监听；fs.FSWatcher.close() 幂等，重复关闭无害。
      刻意**不**清内存态 L2 缓存：键里已经带 `repositoryId` + 本层输入哈希，换仓后不可能误命中；
      实测在切换仓库时清缓存会让下一个回合把完全相同的输入重烧一次（切换 → 重烧 ≈1.5k in / 200 out），
      而「切回来还要用」才是常见路径。两层的 TTL + 条数上限本身就把驻留量兜住了。 */
  private unmountAll(): void {
    for (const repository of this.repositories.values()) repository.watcher?.close();
    this.repositories.clear();
  }

  private async run(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const startedAt = Date.now();
    try {
      this.update(job, "indexing", 10, "正在建立文件树与 Git 热点索引");
      const imported = await this.analyze(job.repositoryPath, (phase, progress, message) => this.update(job, phase, progress, message));
      const { index, course, estimate, analysis } = imported;

      // 单槽：新导入的仓库成为唯一挂载项，旧仓库（含其 watcher）在此被卸载
      this.mount({ path: job.repositoryPath, index, course, estimate, analysis });
      job.repositoryId = index.repositoryId;
      try {
        writeMountedRepository(job.repositoryPath);
      } catch (error) {
        // 注册表写失败不影响导入结果（重启后大不了重新导入），只提示
        console.warn(`[import] 仓库注册表写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
      this.update(job, "completed", 100, `导入完成：${index.totalFiles} 个文件，${course.root.children.length} 个课程分区`);
      job.completedAt = new Date().toISOString();
      traceEngine("import", { job: jobId, phase: "completed", repositoryId: index.repositoryId, files: index.totalFiles, cards: course.root.children.length }, { traceId: null, durationMs: Date.now() - startedAt });
    } catch (error) {
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.message = "导入失败";
      this.publish({ type: "import.progress", payload: job as unknown as Record<string, unknown> });
      traceEngine("import", { job: jobId, phase: "failed", error: job.error }, { traceId: null, durationMs: Date.now() - startedAt });
    }
  }

  private async analyze(repositoryPath: string, progress: (phase: ImportJob["phase"], value: number, message: string) => void): Promise<ImportedRepository> {
    progress("indexing", 10, "正在建立文件树、Git 热点与语义后备索引");
    const index = indexRepository(repositoryPath);
    // versionStamp 是全量源码内容哈希：内容不变 → 值不变，是「润色结果可否复用」的判据
    const versionStamp = contentVersion(repositoryPath, index);
    const database = new TutorDatabase(repositoryPath);
    database.saveIndex(index);
    progress("summarizing", 40, "正在生成分层摘要并检查缓存");
    // L1 走**轻任务角色**（同一套配置、思考强制 off）：文件级摘要是量大、单条简单的活，开思考只会白烧 token。
    // 预算已降级时不传 llm ⇒ 自动落到确定性档，不在超预算时继续花钱。
    const lightProvider = summarizeCost(repositoryPath).mode === "degraded" ? undefined : buildLlmRuntimeProvider("light");
    const provider = createSummaryProvider({ llm: lightProvider });
    // ⚠️ 顺序不能反：L1 的输入是**结构切片**（符号 + 依赖方向），所以必须先建图再摘要。
    // 旧版是「先摘要、后建图」（那时摘要吃的是整份正文，不需要图）。
    // 语法解析器是异步加载的，必须在建图前就绪；加载失败不抛错，改由 graph 记录回落原因。
    await loadSymbolParser();
    const baseGraph = buildDependencyGraph(repositoryPath, index.files);
    const { summaries, estimate } = await summarizeFiles({
      structure: fileStructureOf(index.files, baseGraph),
      database,
      provider
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
    const storedAnalysis = database.getAnalysis(index.repositoryId);
    const storedCourse = database.getCourse(index.repositoryId);
    // 图后端指纹：LSP 从降级恢复、语法解析回落变化都发生在**源码内容不变**的时候，只比 versionStamp 抓不到，
    // 会把降级证据下算出的命名当成事实继续复用（同型坑见 docs/开发关键点问题与解决方案.md §3.6）。
    const backendStamp = hash(`${graph.semanticBackend}:${graph.parseBackend}:${JSON.stringify(graph.lspStatus)}`);
    const storedSettings = database.getSettings<{ refinement?: RefinementMarker; monthlyBudgetUsd?: number }>(index.repositoryId);
    const refinementCacheHit = Boolean(
      storedAnalysis?.versionStamp === versionStamp && storedCourse && refinementIsFresh(storedSettings?.refinement, {
        versionStamp,
        contractVersion: REFINEMENT_CONTRACT_VERSION,
        backendStamp,
        ...(lightProvider ? { modelVersion: lightProvider.modelVersion } : {})
      })
    );
    if (refinementCacheHit) {
      course = storedCourse as CourseTree;
    } else if (summarizeCost(repositoryPath).mode !== "degraded") {
      // 复用导入开头建好的轻量档实例（运行期设置在一次导入内不会变）；预算另查一次——
      // L1 摘要可能刚花掉一部分，所以不能沿用开头那个判断结果
      const mapProvider = lightProvider;
      if (mapProvider) {
        progress("building_course", 85, "正在用 LLM 完善宏观设计命名与摘要");
        const refinement = await refineCourseMap(course, mapProvider);
        course = refinement.course;
        if (refinement.usage) {
          new Journal(repositoryPath, index.repositoryId).append("token_usage", {
            input_tokens: refinement.usage.inputTokens,
            output_tokens: refinement.usage.outputTokens,
            cache_hit_tokens: refinement.usage.promptCacheHitTokens ?? null,
            provider: mapProvider.modelVersion,
            scene: "course_map"
          });
          // 读-合并-写：settings 里还存着 monthlyBudgetUsd 等其他键，不能整体覆盖
          database.saveSettings(index.repositoryId, { ...(storedSettings ?? {}), refinement: { versionStamp, modelVersion: mapProvider.modelVersion, contractVersion: REFINEMENT_CONTRACT_VERSION, backendStamp } });
        }
      }
    }
    const analysis: RepositoryAnalysis = {
      repositoryId: index.repositoryId,
      generatedAt: new Date().toISOString(),
      graph: serializeGraph(graph),
      implementations: verifiedImplementations,
      quality,
      versionStamp
    };
    database.saveCourse(course, estimate);
    database.saveAnalysis(analysis);
    database.close();
    return { path: repositoryPath, index, course, estimate, analysis };
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
    try {
      impactedPaths = impactRadius(graphFromData(current.analysis.graph), changedPaths).impactedPaths;
      const next = await this.analyze(current.path, () => undefined);
      // 回写前确认挂载项没被换掉：换仓 / 重新导入会让这一轮基于旧快照，写回即用脏数据覆盖内存与
      // SQLite，甚至把刚卸载、watcher 已 close 的仓库复活进映射（破坏「挂载集合 = 监听集合」单槽不变量）。
      if (this.repositories.get(repositoryId) !== current) {
        traceEngine("reindex", { repositoryId, changed: changedPaths.length, ok: false, error: "unmounted-during-run" }, { traceId: null, durationMs: Date.now() - startedAt });
        return;
      }
      next.analysis.lastIncrementalUpdate = { changedPaths, impactedPaths, at: new Date().toISOString() };
      const database = new TutorDatabase(current.path);
      database.saveAnalysis(next.analysis);
      database.close();
      next.watcher = current.watcher;
      this.repositories.set(repositoryId, next);
      this.publish({ type: "repository.updated", payload: { repositoryId, changedPaths, impactedPaths } });
      // 只记条数与结果，不把路径数组塞进日志（payload 口径只允许标量）
      traceEngine("reindex", { repositoryId, changed: changedPaths.length, impacted: impactedPaths.length, ok: true }, { traceId: null, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ type: "repository.updated", payload: { repositoryId, changedPaths, error: message } });
      traceEngine("reindex", { repositoryId, changed: changedPaths.length, impacted: impactedPaths.length, ok: false, error: message }, { traceId: null, durationMs: Date.now() - startedAt });
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
function contentVersion(repositoryPath: string, index: RepositoryIndex): string {
  const contents = index.files.map((file) => {
    try { return `${file.path}:${hash(readFileSync(join(repositoryPath, file.path), "utf8"))}`; }
    catch { return `${file.path}:unreadable`; }
  }).sort().join("\n");
  return `content:${hash(contents).slice(0, 24)}`;
}

/** 落在 settings 里的宏观润色标记：记录「这份已润色的课程树是在什么输入下算出来的」。 */
export type RefinementMarker = { versionStamp?: string; modelVersion?: string; contractVersion?: string; backendStamp?: string };

/**
  润色缓存能否复用：标记里的四个维度全对上才算命中——源码内容、当时用哪个模型润的、本层提示词口径、图后端。
  唯独 `modelVersion` 缺省（当前没有可用模型：未配置或预算触顶）时放行——复用上次成功的润色结果，
  好于把它丢掉、退回未润色的裸命名。旧标记缺某个字段时该维度自然不等 → 未命中，重润一次属预期。
 */
export function refinementIsFresh(marker: RefinementMarker | undefined, current: { versionStamp: string; contractVersion: string; backendStamp: string; modelVersion?: string }): boolean {
  if (!marker) return false;
  if (marker.versionStamp !== current.versionStamp) return false;
  if (marker.contractVersion !== current.contractVersion) return false;
  if (marker.backendStamp !== current.backendStamp) return false;
  return current.modelVersion === undefined || marker.modelVersion === current.modelVersion;
}
