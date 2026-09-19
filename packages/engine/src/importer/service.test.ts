import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseTree, ImportEstimate, ImportJob, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { repositoryId as deriveRepositoryId } from "../lib.js";
import { TutorDatabase } from "../store/database.js";
import { ImportService, refinementIsFresh, type ImportedRepository } from "./service.js";

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

/** 测试期的引擎工作日志只打控制台：默认落点是 `~/.codebase-tutor/engine.jsonl`，那是**产品数据**，
    测试回合的 reindex 事件混进去之后，事后排查就分不清哪条来自真实用户操作了。 */
beforeEach(() => {
  process.env.TUTOR_ENGINE_LOG = "off";
});

afterEach(() => {
  delete process.env.TUTOR_ENGINE_LOG;
});

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

/** 私有成员的可访问形状（只用于测试注入在途回合与断言轮次）。 */
type ImportServiceProbe = {
  analyze: (repositoryPath: string, progress: (phase: ImportJob["phase"], value: number, message: string) => void) => Promise<ImportedRepository>;
  reanalyzeIncrementally: (repositoryId: string, changedPaths: string[]) => Promise<void>;
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ImportService 重分析在途守卫（A1）", () => {
  let root: string;
  let registryFile: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-reanalyze-")));
    registryFile = join(root, "registry", "repositories.json");
    process.env.TUTOR_REGISTRY_FILE = registryFile;
    mkdirSync(dirname(registryFile), { recursive: true });
  });

  afterEach(() => {
    delete process.env.TUTOR_REGISTRY_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  /** 把仓库写进注册表并挂进指定 service；调用方自行 close watcher——回合由测试显式驱动，不靠真实文件事件。 */
  function mountInto(service: ImportService, ...repoDirs: string[]): number {
    writeFileSync(registryFile, `${JSON.stringify({ repositories: repoDirs })}\n`);
    return service.restorePersisted();
  }

  it("一轮在途时新变更只累积，本轮结束后合并成下一轮（不重叠、不丢路径）", async () => {
    const { repoDir, repositoryId } = makePersistedRepo(root, "alpha");
    const service = new ImportService();
    expect(mountInto(service, repoDir)).toBe(1);
    const current = service.getRepository(repositoryId)!;
    current.watcher?.close();

    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let rounds = 0;
    const spy = vi.spyOn(service as unknown as ImportServiceProbe, "analyze").mockImplementation(async () => {
      rounds += 1;
      if (rounds === 1) await firstGate;
      return { ...current, analysis: { ...current.analysis, versionStamp: `content:round${rounds}` } };
    });

    const probe = service as unknown as ImportServiceProbe;
    const firstRound = probe.reanalyzeIncrementally(repositoryId, ["src/a.ts"]);
    await tick(); // 让第一轮真正停在 analyze 内部
    const second = probe.reanalyzeIncrementally(repositoryId, ["src/b.ts"]);
    const third = probe.reanalyzeIncrementally(repositoryId, ["src/c.ts", "src/b.ts"]);
    releaseFirst();
    await Promise.all([firstRound, second, third]);

    // 三轮变更只跑两轮：后两轮合并成第二轮
    expect(spy).toHaveBeenCalledTimes(2);
    const mounted = service.getRepository(repositoryId)!;
    // 最终状态来自最后一轮，而不是「先启动、后完成」的那轮
    expect(mounted.analysis.versionStamp).toBe("content:round2");
    expect(mounted.analysis.lastIncrementalUpdate?.changedPaths).toEqual(["src/b.ts", "src/c.ts"]);
    // 合并后的那轮也落进了 SQLite（重启后不丢）
    const database = new TutorDatabase(repoDir);
    expect(database.getAnalysis(repositoryId)?.versionStamp).toBe("content:round2");
    database.close();
  });

  it("在途回合不回写已卸载的仓库：单槽不变量不被破坏", async () => {
    const alpha = makePersistedRepo(root, "alpha");
    const beta = makePersistedRepo(root, "beta");
    const service = new ImportService();
    expect(mountInto(service, alpha.repoDir)).toBe(1);
    const alphaCurrent = service.getRepository(alpha.repositoryId)!;
    alphaCurrent.watcher?.close();

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(service as unknown as ImportServiceProbe, "analyze").mockImplementation(async () => {
      await gate;
      return { ...alphaCurrent, analysis: { ...alphaCurrent.analysis, versionStamp: "content:stale" } };
    });

    const inFlight = (service as unknown as ImportServiceProbe).reanalyzeIncrementally(alpha.repositoryId, ["src/a.ts"]);
    await tick();

    // 切换到 beta：单槽语义下 alpha 被卸载（watcher 已 close）
    writeFileSync(registryFile, `${JSON.stringify({ repositories: [beta.repoDir] })}\n`);
    service.restorePersisted();
    expect(service.getRepository(alpha.repositoryId)).toBeUndefined();

    release();
    await inFlight;

    // 旧回合不得把 alpha 复活进内存映射
    expect(service.getRepository(alpha.repositoryId)).toBeUndefined();
    expect(service.getRepository(beta.repositoryId)).toBeDefined();
    const database = new TutorDatabase(alpha.repoDir);
    expect(database.getAnalysis(alpha.repositoryId)?.versionStamp).toBe("content:fixture"); // 脏结果也没写库
    database.close();
    service.getRepository(beta.repositoryId)?.watcher?.close();
  });
});

describe("refinementIsFresh（宏观润色缓存的失效维度）", () => {
  const marker = { versionStamp: "content:v1", modelVersion: "lite-a", contractVersion: "refine-v1", backendStamp: "backend:ok" };
  const current = { versionStamp: "content:v1", contractVersion: "refine-v1", backendStamp: "backend:ok", modelVersion: "lite-a" };

  it("四个维度全对上才算命中；任一不符就重润", () => {
    expect(refinementIsFresh(marker, current)).toBe(true);
    // 源码内容变了
    expect(refinementIsFresh(marker, { ...current, versionStamp: "content:v2" })).toBe(false);
    // 换了轻量档模型：同一份代码在另一个模型上不是同一套命名
    expect(refinementIsFresh({ ...marker, modelVersion: "lite-b" }, current)).toBe(false);
    // 提示词口径版本 bump（代码一字不变，命名口径已经不同）
    expect(refinementIsFresh(marker, { ...current, contractVersion: "refine-v2" })).toBe(false);
    // LSP 从降级恢复：源码没动，但证据不同
    expect(refinementIsFresh(marker, { ...current, backendStamp: "backend:lsp" })).toBe(false);
  });

  it("没有可用模型（未配置或预算触顶）时放行：复用上次成功的润色好于退回裸命名", () => {
    const withoutModel = { versionStamp: current.versionStamp, contractVersion: current.contractVersion, backendStamp: current.backendStamp };
    expect(refinementIsFresh(marker, withoutModel)).toBe(true);
    expect(refinementIsFresh({ ...marker, modelVersion: undefined }, withoutModel)).toBe(true);
  });

  it("缺任何标记字段都算未命中（旧版本遗留的标记不做兼容猜测）", () => {
    expect(refinementIsFresh(undefined, current)).toBe(false);
    expect(refinementIsFresh({ versionStamp: "content:v1" }, current)).toBe(false);
  });
});
