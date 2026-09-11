import { existsSync, readFileSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { CourseTree, ImportJob, ImportEstimate, RepositoryAnalysis, RepositoryIndex, ServerEvent } from "@codebase-tutor/shared";
import { attachQuality, buildCourseTree } from "../coursetree/build.js";
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
  if (!inputPath || typeof inputPath !== "string") throw new Error("请提供待学习仓库的绝对路径");
  const path = realpathSync(inputPath);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("导入路径必须是可访问的目录");
  return path;
}

/** Exercise cache versioning follows source content, not an import timestamp. */
function contentVersion(repositoryPath: string, index: RepositoryIndex): string {
  const contents = index.files.map((file) => {
    try { return `${file.path}:${hash(readFileSync(join(repositoryPath, file.path), "utf8"))}`; }
    catch { return `${file.path}:unreadable`; }
  }).sort().join("\n");
  return `content:${hash(contents).slice(0, 24)}`;
}
