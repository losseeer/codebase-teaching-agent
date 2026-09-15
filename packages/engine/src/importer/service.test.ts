import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CourseTree, ImportEstimate, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { repositoryId as deriveRepositoryId } from "../lib.js";
import { TutorDatabase } from "../store/database.js";
import { ImportService } from "./service.js";

/** 构造一个带完整 .tutor 持久化数据的最小仓库目录（走 TutorDatabase 真实写库）。 */
function makePersistedRepo(root: string, name: string): { repoDir: string; repositoryId: string } {
  const repoDir = realpathSync(mkdtempSync(join(root, `${name}-`)));
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "main.ts"), "export const main = () => 1;\n");
  const repositoryId = deriveRepositoryId(repoDir);
  const now = new Date().toISOString();
  const index: RepositoryIndex = {
    repositoryId, repositoryPath: repoDir, scannedAt: now, totalFiles: 1, totalLines: 2,
    files: [{ path: "src/main.ts", extension: ".ts", bytes: 30, lines: 2 }],
    fileTree: [], hotspots: []
  };
  const course: CourseTree = {
    repositoryId, modelVersion: "fixture-v1", generatedAt: now,
    root: { id: "root", title: `${name} 课程树`, summary: "测试用", kind: "overview", anchors: [], children: [] }
  };
  const analysis: RepositoryAnalysis = {
    repositoryId, generatedAt: now, versionStamp: "content:fixture",
    graph: { imports: {}, calls: [], symbols: [], entrypoints: [], semanticBackend: "static", lspStatus: [] },
    implementations: [], quality: { generatedAt: now, micro: [], macro: [] }
  };
  const estimate: ImportEstimate = { cachedFiles: 0, summarizedFiles: 1, estimatedInputTokens: 0, estimatedCostUsd: 0, provider: "none", modelVersion: "fixture-v1" };
  const database = new TutorDatabase(repoDir);
  database.saveIndex(index);
  database.saveCourse(course, estimate);
  database.saveAnalysis(analysis);
  database.close();
  return { repoDir, repositoryId };
}

describe("ImportService.restorePersisted（engine 重启恢复注册）", () => {
  let root: string;
  let registryFile: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-import-test-")));
    registryFile = join(root, "registry", "repositories.json");
    process.env.TUTOR_REGISTRY_FILE = registryFile;
  });

  afterEach(() => {
    delete process.env.TUTOR_REGISTRY_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  it("注册表里的仓库从 .tutor 恢复注册，可被 getRepository/findRepositoryForPath 命中", () => {
    const { repoDir, repositoryId } = makePersistedRepo(root, "alpha");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify({ repositories: [repoDir] })}\n`);

    const service = new ImportService();
    expect(service.getRepository(repositoryId)).toBeUndefined(); // 恢复前内存为空（模拟重启后）
    const restored = service.restorePersisted();
    expect(restored).toBe(1);

    const repository = service.getRepository(repositoryId);
    expect(repository).toBeDefined();
    expect(repository?.course.root.title).toBe("alpha 课程树");
    expect(repository?.analysis.versionStamp).toBe("content:fixture");
    expect(service.findRepositoryForPath(join(repoDir, "src", "main.ts"))).toBeDefined();

    repository?.watcher?.close(); // 测试收尾，停掉 fs.watch
  });

  it("目录已删除的注册条目被剔除，不影响其他仓库恢复", () => {
    const { repoDir, repositoryId } = makePersistedRepo(root, "beta");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify({ repositories: [join(root, "deleted-repo"), repoDir] })}\n`);

    const service = new ImportService();
    const restored = service.restorePersisted();
    expect(restored).toBe(1);
    expect(service.getRepository(repositoryId)).toBeDefined();

    // 失效条目被清出注册表
    const remaining = JSON.parse(readFileSync(registryFile, "utf8")) as { repositories: string[] };
    expect(remaining.repositories).toEqual([repoDir]);

    service.getRepository(repositoryId)?.watcher?.close();
  });

  it("空注册表直接返回 0，不做任何 IO", () => {
    const service = new ImportService();
    expect(service.restorePersisted()).toBe(0);
  });
});
