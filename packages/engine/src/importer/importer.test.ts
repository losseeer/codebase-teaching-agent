import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseTree, ImportEstimate, ImportJob, RepositoryAnalysis, RepositoryFreshness, RepositoryIndex } from "@codebase-tutor/shared";
import { repositoryId as deriveRepositoryId } from "../lib.js";
import { TutorDatabase } from "../store/database.js";
import { ImportService, refinementIsFresh, type ImportedRepository } from "./importer.js";

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

/** 测试用 git 仓：新鲜度判定的 HEAD 轴需要真提交，非 git 仓只能验到 unknown/stale。 */
function gitInitAndCommit(repository: string): string {
  const run = (...args: string[]): string => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  run("init", "-q");
  run("add", "-A");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
  return run("rev-parse", "HEAD");
}

/** 把 db 里的 analysis 换成指定 stamp / HEAD（模拟「产物是在这个状态下算出来的」）。 */
function rewriteAnalysis(repoDir: string, repositoryId: string, patch: Partial<RepositoryAnalysis>): void {
  const database = new TutorDatabase(repoDir);
  const stored = database.getAnalysis(repositoryId)!;
  database.saveAnalysis({ ...stored, ...patch });
  database.close();
}

describe("ImportService 地址簿与懒挂载", () => {
  let root: string;
  let registryFile: string;
  const mounted: ImportedRepository[] = [];

  function writeRegistry(paths: string[]): void {
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify({ repositories: paths })}\n`);
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-import-test-")));
    registryFile = join(root, "registry", "repositories.json");
    process.env.TUTOR_REGISTRY_FILE = registryFile;
  });

  afterEach(() => {
    for (const repository of mounted.splice(0)) repository.watcher?.close();
    delete process.env.TUTOR_REGISTRY_FILE;
    delete process.env.TUTOR_MAX_MOUNTED;
    rmSync(root, { recursive: true, force: true });
  });

  /** 记下 watcher 好收尾；测试里不让真实文件事件驱动重分析。 */
  function quiet(service: ImportService, repositoryId: string): ImportedRepository {
    const repository = service.getRepository(repositoryId)!;
    repository.watcher?.close();
    mounted.push(repository);
    return repository;
  }

  it("启动只登记：catalog 列全地址簿，但一条都不挂、不读产物", () => {
    const alpha = makePersistedRepo(root, "alpha");
    const beta = makePersistedRepo(root, "beta");
    writeRegistry([alpha.repoDir, beta.repoDir, beta.repoDir, join(root, "gone")]);

    const service = new ImportService();
    const catalog = service.catalog();
    // 重复条目去重；目录不存在的条目保留并如实标注（由用户决定移除，不悄悄丢）
    expect(catalog.map((item) => item.name.split("-")[0])).toEqual(["alpha", "beta", "gone"]);
    expect(catalog.map((item) => item.exists)).toEqual([true, true, false]);
    expect(catalog.every((item) => !item.mounted)).toBe(true);
    // 未挂载的条目不探产物——探它就得读它的 db
    expect(catalog.every((item) => item.artifactsReady === undefined)).toBe(true);
    expect(service.mountedRepositories()).toHaveLength(0);
  });

  it("懒挂载：不在地址簿 / 目录没了 / 产物不全，三种失败各有 reason，且都不触发重分析", () => {
    const ok = makePersistedRepo(root, "ok");
    const missing = makePersistedRepo(root, "missing");
    // 有目录、有文件，但从来没被分析过（没有 .tutor 产物）
    const bare = realpathSync(mkdtempSync(join(root, "bare-")));
    mkdirSync(join(bare, "src"), { recursive: true });
    writeFileSync(join(bare, "src", "main.ts"), "export const main = () => 1;\n");
    rmSync(missing.repoDir, { recursive: true, force: true });
    writeRegistry([ok.repoDir, missing.repoDir, bare]);

    const service = new ImportService();
    // 目录真实存在、但从来没入簿：GUI 拿到的 workspace 指向它时必须说清「不在地址簿」，而不是假装能挂
    const outside = service.ensureMounted(deriveRepositoryId(root));
    expect(!outside.ok && outside.reason).toBe("not_in_catalog");

    const gone = service.ensureMounted(missing.repositoryId);
    expect(!gone.ok && gone.reason).toBe("directory_missing");

    const broken = service.ensureMounted(deriveRepositoryId(bare));
    expect(!broken.ok && broken.reason).toBe("artifacts_incomplete");

    const good = service.ensureMounted(ok.repositoryId);
    expect(good.ok).toBe(true);
    expect(service.getRepository(ok.repositoryId)?.course.root.title).toBe("ok 课程树");
    quiet(service, ok.repositoryId);
  });

  it("新鲜度只报告不重算：stale → 补上真 stamp 变 unknown（非 git 仓）→ git 仓里对得上才 fresh，HEAD 移动而内容不变是 drifted", () => {
    const repo = makePersistedRepo(root, "alpha");
    writeRegistry([repo.repoDir]);
    /** 每个阶段都新起一个 service：模拟「进程重启后第一次访问」，判定只在挂载时发生一次，不需要 unmount 原语 */
    const judge = (): RepositoryFreshness => {
      const service = new ImportService();
      const result = service.ensureMounted(repo.repositoryId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const freshness = result.repository.freshness;
      quiet(service, repo.repositoryId);
      return freshness;
    };

    // db 里是假的 "content:fixture"，磁盘内容对不上 → 判过期，并给出当前真 stamp
    const first = judge();
    expect(first.verdict).toBe("stale");
    expect(first.contentChanged).toBe(true);
    // 只报告：产物里写的还是那个旧 stamp，引擎没顺手替用户重算
    const database = new TutorDatabase(repo.repoDir);
    expect(database.getAnalysis(repo.repositoryId)?.versionStamp).toBe("content:fixture");
    database.close();

    // 把产物「假装」是在当前内容下算的：非 git 仓没有 HEAD 可比，只能退化成 unknown
    rewriteAnalysis(repo.repoDir, repo.repositoryId, { versionStamp: first.versionStamp });
    expect(judge().verdict).toBe("unknown");
    expect(judge().contentChanged).toBe(false);

    // git 仓 + 产物记了当时的 HEAD：对上才是 fresh
    const head = gitInitAndCommit(repo.repoDir);
    rewriteAnalysis(repo.repoDir, repo.repositoryId, { gitHead: head });
    expect(judge().verdict).toBe("fresh");

    // 挪动 HEAD 但工作树内容不变（空提交）：产物仍可用，只是要知道分析点在别的提交上
    execFileSync("git", ["-C", repo.repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "moved"], { encoding: "utf8" });
    const drifted = judge();
    expect(drifted.verdict).toBe("drifted");
    expect(drifted.contentChanged).toBe(false);
    expect(drifted.headNow).not.toBe(drifted.headAtAnalysis);
  });

  it("LRU：超出 maxMounted 的最久未用项被驱逐（关监听、摘内存），但仍在地址簿里、可再挂回来", () => {
    process.env.TUTOR_MAX_MOUNTED = "2";
    const alpha = makePersistedRepo(root, "alpha");
    const beta = makePersistedRepo(root, "beta");
    const gamma = makePersistedRepo(root, "gamma");
    writeRegistry([alpha.repoDir, beta.repoDir, gamma.repoDir]);

    const service = new ImportService();
    service.ensureMounted(alpha.repositoryId);
    service.ensureMounted(beta.repositoryId);
    quiet(service, beta.repositoryId);
    // 先用一次 alpha，让它比 beta 更新鲜 → 挂 gamma 时该驱逐的是 beta
    service.ensureMounted(alpha.repositoryId);
    service.ensureMounted(gamma.repositoryId);
    quiet(service, alpha.repositoryId);
    quiet(service, gamma.repositoryId);

    expect(service.getRepository(alpha.repositoryId)).toBeDefined();
    expect(service.getRepository(gamma.repositoryId)).toBeDefined();
    expect(service.getRepository(beta.repositoryId)).toBeUndefined();
    // 驱逐不等于遗忘：地址簿照旧列它，再访问就重新挂
    expect(service.catalog().find((item) => item.repositoryId === beta.repositoryId)?.mounted).toBe(false);
    expect(service.ensureMounted(beta.repositoryId).ok).toBe(true);
    quiet(service, beta.repositoryId);
    // 上限仍然守住：挂回 beta 把它挤出去的是最久未用的 alpha
    expect(service.mountedRepositories().length).toBe(2);
    // 挂载/驱逐都不改写地址簿——它是用户资产，不是进程状态
    const book = JSON.parse(readFileSync(registryFile, "utf8")) as { repositories: string[] };
    expect(book.repositories).toEqual([alpha.repoDir, beta.repoDir, gamma.repoDir]);
  });

  it("forget 出簿并就地卸载；不动仓库自己的 .tutor 产物", () => {
    const repo = makePersistedRepo(root, "alpha");
    writeRegistry([repo.repoDir]);
    const service = new ImportService();
    service.ensureMounted(repo.repositoryId);
    service.forget(repo.repositoryId);

    expect(service.getRepository(repo.repositoryId)).toBeUndefined();
    expect(service.catalog()).toHaveLength(0);
    const database = new TutorDatabase(repo.repoDir);
    expect(database.getAnalysis(repo.repositoryId)?.repositoryId).toBe(repo.repositoryId);
    database.close();
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
    delete process.env.TUTOR_MAX_MOUNTED;
    rmSync(root, { recursive: true, force: true });
  });

  /** 把仓库写进地址簿并逐个懒挂载；调用方自行 close watcher——回合由测试显式驱动，不靠真实文件事件。 */
  function mountInto(service: ImportService, ...repoDirs: string[]): number {
    writeFileSync(registryFile, `${JSON.stringify({ repositories: repoDirs })}\n`);
    for (const path of repoDirs) service.ensureMounted(deriveRepositoryId(path));
    return service.mountedRepositories().length;
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

  it("在途回合不回写已被驱逐的仓库：旧回合不得把它复活进内存、也不得覆盖它的产物", async () => {
    process.env.TUTOR_MAX_MOUNTED = "1";
    const alpha = makePersistedRepo(root, "alpha");
    const beta = makePersistedRepo(root, "beta");
    const service = new ImportService();
    writeFileSync(registryFile, `${JSON.stringify({ repositories: [alpha.repoDir, beta.repoDir] })}\n`);
    service.ensureMounted(alpha.repositoryId);
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

    // 挂 beta：上限 1 → alpha 被 LRU 驱逐（watcher 已 close、内存里没了）
    service.ensureMounted(beta.repositoryId);
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
