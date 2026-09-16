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

  it("单槽：注册表里只有最后挂载的那一条进内存，文件被规范化成单条", () => {
    const alpha = makePersistedRepo(root, "alpha");
    const beta = makePersistedRepo(root, "beta");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify({ repositories: [alpha.repoDir, beta.repoDir] })}\n`);

    const service = new ImportService();
    expect(service.restorePersisted()).toBe(1);
    expect(service.getRepository(beta.repositoryId)).toBeDefined();
    expect(service.getRepository(alpha.repositoryId)).toBeUndefined(); // 非最后挂载的那条不再被监听

    const remaining = JSON.parse(readFileSync(registryFile, "utf8")) as { repositories: string[] };
    expect(remaining.repositories).toEqual([beta.repoDir]);

    service.getRepository(beta.repositoryId)?.watcher?.close();
  });

  it("单槽：切换到另一个仓库时，旧仓库被卸载，不再留在内存注册表里", () => {
    const alpha = makePersistedRepo(root, "alpha");
    const beta = makePersistedRepo(root, "beta");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify({ repositories: [alpha.repoDir] })}\n`);

    const service = new ImportService();
    expect(service.restorePersisted()).toBe(1);
    expect(service.getRepository(alpha.repositoryId)).toBeDefined();

    writeFileSync(registryFile, `${JSON.stringify({ repositories: [beta.repoDir] })}\n`);
    expect(service.restorePersisted()).toBe(1);
    expect(service.getRepository(alpha.repositoryId)).toBeUndefined();
    expect(service.getRepository(beta.repositoryId)).toBeDefined();

    service.getRepository(beta.repositoryId)?.watcher?.close();
  });

  it("最后一条目录已删除：不恢复任何仓库，注册表被清空（不留回挂条目）", () => {
    const { repoDir } = makePersistedRepo(root, "beta");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify({ repositories: [repoDir, join(root, "deleted-repo")] })}\n`);

    const service = new ImportService();
    expect(service.restorePersisted()).toBe(0);

    const remaining = JSON.parse(readFileSync(registryFile, "utf8")) as { repositories: string[] };
    expect(remaining.repositories).toEqual([]);
  });

  it("空注册表直接返回 0，不做任何 IO", () => {
    const service = new ImportService();
    expect(service.restorePersisted()).toBe(0);
  });
});
