import { readFileSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CourseTree, ImportJob, ImportEstimate, RepositoryAnalysis, RepositoryIndex, ServerEvent } from "@codebase-tutor/shared";
import { attachQuality, buildCourseTree } from "../coursetree/build.js";
import { refineCourseMap } from "../coursetree/llm-refine.js";
import { createLightLlmProvider, createTeachingProvider } from "../llm/provider.js";
import { summarizeCost } from "../cost/service.js";
import { buildDependencyGraph, impactRadius, serializeGraph } from "../depgraph/graph.js";
import { collectDecisionUnits } from "../decision/evidence.js";
import { buildImplementationUnits } from "../implementation/units.js";
import { hash, id, isWithin } from "../lib.js";
import { indexRepository } from "../indexer/indexer.js";
import { RepositoryWatcher } from "../indexer/watcher.js";
import { enrichWithLsp } from "../lsp/enrich.js";
import { verifyAnalysis } from "../quality/checker.js";
import { createSummaryProvider } from "../summarizer/provider.js";
import { summarizeFiles } from "../summarizer/summarizer.js";
import { TutorDatabase } from "../store/database.js";
import { Journal } from "../store/journal.js";

export interface ImportedRepository {
  path: string;
  index: RepositoryIndex;
  course: CourseTree;
  estimate: ImportEstimate;
  analysis: RepositoryAnalysis;
  watcher?: RepositoryWatcher;
}

export class ImportService extends EventEmitter {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly repositories = new Map<string, ImportedRepository>();
  private queue = Promise.resolve();

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

  private async run(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    try {
      this.update(job, "indexing", 10, "正在建立文件树与 Git 热点索引");
      const imported = await this.analyze(job.repositoryPath, (phase, progress, message) => this.update(job, phase, progress, message));
      const { index, course, estimate, analysis } = imported;

      const previous = this.repositories.get(index.repositoryId);
      previous?.watcher?.close();
      const repository: ImportedRepository = { path: job.repositoryPath, index, course, estimate, analysis };
      repository.watcher = new RepositoryWatcher(job.repositoryPath, (changedPaths) => void this.reanalyzeIncrementally(index.repositoryId, changedPaths));
      repository.watcher.start();
      this.repositories.set(index.repositoryId, repository);
      job.repositoryId = index.repositoryId;
      this.update(job, "completed", 100, `导入完成：${index.totalFiles} 个文件，${course.root.children.length} 个课程分区`);
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.message = "导入失败";
      this.publish({ type: "import.progress", payload: job as unknown as Record<string, unknown> });
    }
  }

  private async analyze(repositoryPath: string, progress: (phase: ImportJob["phase"], value: number, message: string) => void): Promise<ImportedRepository> {
    progress("indexing", 10, "正在建立文件树、Git 热点与语义后备索引");
    const index = indexRepository(repositoryPath);
    const database = new TutorDatabase(repositoryPath);
    database.saveIndex(index);
    progress("summarizing", 40, "正在生成分层摘要并检查缓存");
    const provider = createSummaryProvider();
    const { summaries, estimate } = await summarizeFiles(repositoryPath, index.files, database, provider);
    progress("building_course", 75, "正在生成微观单元、选型证据和影响图");
    const graph = await enrichWithLsp(repositoryPath, buildDependencyGraph(repositoryPath, index.files));
    const decisions = collectDecisionUnits(repositoryPath, index.files);
    const implementations = buildImplementationUnits(repositoryPath, graph.symbols);
    const draftCourse = buildCourseTree({ repositoryId: index.repositoryId, modelVersion: provider.modelVersion, files: index.files, summaries, graph, decisions, implementations });
    const quality = verifyAnalysis(repositoryPath, implementations, draftCourse.root, { timeoutMs: 2_500 });
    const verifiedImplementations = implementations.map((unit) => ({
      ...unit,
      verification: quality.micro.filter((check) => check.anchors[0]?.path === unit.symbol.path && check.anchors[0]?.line === unit.symbol.line)
    }));
    let course = buildCourseTree({ repositoryId: index.repositoryId, modelVersion: provider.modelVersion, files: index.files, summaries, graph, decisions, implementations: verifiedImplementations });
    course = attachQuality(course, quality);
    // 课程地图 LLM 完善层：命名/摘要语义化（结构仍由静态分析锚定；失败原样返回）
    // 轻任务走轻量档（TUTOR_LIGHT_*），未配置回落主力档
    const mapProvider = summarizeCost(repositoryPath).mode === "degraded" ? undefined : (createLightLlmProvider() ?? createTeachingProvider());
    if (mapProvider) {
      progress("building_course", 85, "正在用 LLM 完善课程地图命名与摘要");
      const refinement = await refineCourseMap(course, mapProvider);
      course = refinement.course;
      if (refinement.usage) new Journal(repositoryPath, index.repositoryId).append("token_usage", {
        input_tokens: refinement.usage.inputTokens,
        output_tokens: refinement.usage.outputTokens,
        provider: mapProvider.modelVersion,
        scene: "course_map"
      });
    }
    const analysis: RepositoryAnalysis = {
      repositoryId: index.repositoryId,
      generatedAt: new Date().toISOString(),
      graph: serializeGraph(graph),
      decisions,
      implementations: verifiedImplementations,
      quality,
      versionStamp: contentVersion(repositoryPath, index)
    };
    database.saveCourse(course, estimate);
    database.saveAnalysis(analysis);
    database.close();
    return { path: repositoryPath, index, course, estimate, analysis };
  }

  private async reanalyzeIncrementally(repositoryId: string, changedPaths: string[]): Promise<void> {
    const current = this.repositories.get(repositoryId);
    if (!current) return;
    const impact = impactRadius({ imports: new Map(Object.entries(current.analysis.graph.imports)), calls: current.analysis.graph.calls, symbols: current.analysis.graph.symbols, entrypoints: current.analysis.graph.entrypoints, semanticBackend: current.analysis.graph.semanticBackend, lspStatus: current.analysis.graph.lspStatus }, changedPaths);
    try {
      const next = await this.analyze(current.path, () => undefined);
      next.analysis.lastIncrementalUpdate = { changedPaths, impactedPaths: impact.impactedPaths, at: new Date().toISOString() };
      const database = new TutorDatabase(current.path);
      database.saveAnalysis(next.analysis);
      database.close();
      next.watcher = current.watcher;
      this.repositories.set(repositoryId, next);
      this.publish({ type: "repository.updated", payload: { repositoryId, changedPaths, impactedPaths: impact.impactedPaths } });
    } catch (error) {
      this.publish({ type: "repository.updated", payload: { repositoryId, changedPaths, error: error instanceof Error ? error.message : String(error) } });
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
