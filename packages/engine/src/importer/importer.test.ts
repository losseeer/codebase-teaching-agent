import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportJob, RepositoryFreshness, ServerEvent } from "@codebase-tutor/contract";
import type { ImportEstimate, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

import { repositoryId as deriveRepositoryId } from "@codebase-tutor/platform";
import { TutorDatabase } from "../adapter/outbound/persistence/database.js";
import { ImportService, type ImportedRepository } from "./importer.js";

/** 构造带完整 .tutor 数据的最小仓库目录（真实写库）。 */
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
  const analysis: RepositoryAnalysis = {
    repositoryId, generatedAt: now, versionStamp: "content:fixture",
    graph: { imports: {}, calls: [], symbols: [], entrypoints: [], semanticBackend: "static", lspStatus: [] },
    implementations: []
  };
  const estimate: ImportEstimate = { cachedFiles: 0, summarizedFiles: 1, estimatedInputTokens: 0, estimatedCostUsd: 0, provider: "none", modelVersion: "fixture-v1" };
  const database = new TutorDatabase(repoDir);
  database.state.saveIndex(index);
  database.state.saveEstimate(repositoryId, estimate);
  database.state.saveAnalysis(analysis);
  database.close();
  return { repoDir, repositoryId };
}

// 测试期不写引擎工作日志
beforeEach(() => {
  process.env.TUTOR_ENGINE_LOG = "off";
});

afterEach(() => {
  delete process.env.TUTOR_ENGINE_LOG;
});

/** 建一个带真实提交的 git 仓，供新鲜度按 HEAD 判定。 */
function gitInitAndCommit(repository: string): string {
  const run = (...args: string[]): string => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  run("init", "-q");
  run("add", "-A");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
  return run("rev-parse", "HEAD");
}

/** 把 db 里的 analysis 换成指定 stamp / HEAD。 */
function rewriteAnalysis(repoDir: string, repositoryId: string, patch: Partial<RepositoryAnalysis>): void {
  const database = new TutorDatabase(repoDir);
  const stored = database.state.analysis(repositoryId)!;
  database.state.saveAnalysis({ ...stored, ...patch });
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

  /** 记下带 watcher 的仓，供 afterEach 关闭。 */
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
    // 重复条目去重，不存在的目录仍列出
    expect(catalog.map((item) => item.name.split("-")[0])).toEqual(["alpha", "beta", "gone"]);
    expect(catalog.map((item) => item.exists)).toEqual([true, true, false]);
    expect(catalog.every((item) => !item.mounted)).toBe(true);
    // 未挂载的条目不探产物。
    expect(catalog.every((item) => item.artifactsReady === undefined)).toBe(true);
    expect(service.mountedRepositories()).toHaveLength(0);
  });

  it("懒挂载：不在地址簿 / 目录没了 / 产物不全，三种失败各有 reason，且都不触发重分析", () => {
    const ok = makePersistedRepo(root, "ok");
    const missing = makePersistedRepo(root, "missing");
    // 有目录有文件，但没有 .tutor 产物。
    const bare = realpathSync(mkdtempSync(join(root, "bare-")));
    mkdirSync(join(bare, "src"), { recursive: true });
    writeFileSync(join(bare, "src", "main.ts"), "export const main = () => 1;\n");
    rmSync(missing.repoDir, { recursive: true, force: true });
    writeRegistry([ok.repoDir, missing.repoDir, bare]);

    const service = new ImportService();
    // 目录存在但从未进过地址簿
    const outside = service.ensureMounted(deriveRepositoryId(root));
    expect(!outside.ok && outside.reason).toBe("not_in_catalog");

    const gone = service.ensureMounted(missing.repositoryId);
    expect(!gone.ok && gone.reason).toBe("directory_missing");

    const broken = service.ensureMounted(deriveRepositoryId(bare));
    expect(!broken.ok && broken.reason).toBe("artifacts_incomplete");

    const good = service.ensureMounted(ok.repositoryId);
    expect(good.ok).toBe(true);
    expect(service.getRepository(ok.repositoryId)?.analysis.repositoryId).toBe(ok.repositoryId);
    quiet(service, ok.repositoryId);
  });

  it("新鲜度只报告不重算：stale → 补上真 stamp 变 unknown（非 git 仓）→ git 仓里对得上才 fresh，HEAD 移动而内容不变是 drifted", () => {
    const repo = makePersistedRepo(root, "alpha");
    writeRegistry([repo.repoDir]);
    /** 每个阶段新起一个 service：模拟进程重启后首次访问。 */
    const judge = (): RepositoryFreshness => {
      const service = new ImportService();
      const result = service.ensureMounted(repo.repositoryId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const freshness = result.repository.freshness;
      quiet(service, repo.repositoryId);
      return freshness;
    };

    // db 里的 stamp 与磁盘上的内容对不上
    const first = judge();
    expect(first.verdict).toBe("stale");
    expect(first.contentChanged).toBe(true);
    // 只报告，不替用户重算
    const database = new TutorDatabase(repo.repoDir);
    expect(database.state.analysis(repo.repositoryId)?.versionStamp).toBe("content:fixture");
    database.close();

    // 非 git 仓没有 HEAD 可比
    rewriteAnalysis(repo.repoDir, repo.repositoryId, { versionStamp: first.versionStamp });
    expect(judge().verdict).toBe("unknown");
    expect(judge().contentChanged).toBe(false);

    // git 仓且产物记了 HEAD
    const head = gitInitAndCommit(repo.repoDir);
    rewriteAnalysis(repo.repoDir, repo.repositoryId, { gitHead: head });
    expect(judge().verdict).toBe("fresh");

    // 空提交挪动 HEAD，内容不变
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
    // alpha 刚用过，挂 gamma 时驱逐的是 beta
    service.ensureMounted(alpha.repositoryId);
    service.ensureMounted(gamma.repositoryId);
    quiet(service, alpha.repositoryId);
    quiet(service, gamma.repositoryId);

    expect(service.getRepository(alpha.repositoryId)).toBeDefined();
    expect(service.getRepository(gamma.repositoryId)).toBeDefined();
    expect(service.getRepository(beta.repositoryId)).toBeUndefined();
    expect(service.catalog().find((item) => item.repositoryId === beta.repositoryId)?.mounted).toBe(false);
    expect(service.ensureMounted(beta.repositoryId).ok).toBe(true);
    quiet(service, beta.repositoryId);
    expect(service.mountedRepositories().length).toBe(2);
    // 挂载与驱逐都不改写地址簿文件
    const book = JSON.parse(readFileSync(registryFile, "utf8")) as { repositories: string[] };
    expect(book.repositories).toEqual([alpha.repoDir, beta.repoDir, gamma.repoDir]);
  });

  it("forget 默认只出簿，不动仓库里的分析结果", () => {
    const repo = makePersistedRepo(root, "alpha");
    writeRegistry([repo.repoDir]);
    const service = new ImportService();
    service.ensureMounted(repo.repositoryId);
    service.forget(repo.repositoryId);

    expect(service.getRepository(repo.repositoryId)).toBeUndefined();
    expect(service.catalog()).toHaveLength(0);
    const database = new TutorDatabase(repo.repoDir);
    expect(database.state.analysis(repo.repositoryId)?.repositoryId).toBe(repo.repositoryId);
    database.close();
    expect(existsSync(join(repo.repoDir, ".tutor"))).toBe(true);
  });

  it("forget 带 artifacts 才删该仓的产物目录", () => {
    const repo = makePersistedRepo(root, "beta");
    writeRegistry([repo.repoDir]);
    const service = new ImportService();
    service.ensureMounted(repo.repositoryId);
    expect(service.forget(repo.repositoryId, true)).toEqual({ artifacts: "removed" });
    expect(existsSync(join(repo.repoDir, ".tutor"))).toBe(false);
  });

  it("产物目录不在仓内常规位置时拒删（软链到仓外也不算删成）", () => {
    const repo = makePersistedRepo(root, "gamma");
    writeRegistry([repo.repoDir]);
    const outside = realpathSync(mkdtempSync(join(root, "outside-")));
    rmSync(join(repo.repoDir, ".tutor"), { recursive: true, force: true });
    symlinkSync(outside, join(repo.repoDir, ".tutor"));
    const service = new ImportService();
    expect(service.forget(repo.repositoryId, true)).toEqual({ artifacts: "refused" });
    expect(lstatSync(join(repo.repoDir, ".tutor")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "tutor.db"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });
});


/** 私有成员的可访问形状，供测试用。 */
type ImportServiceProbe = {
  analyze: (repositoryPath: string, progress: (phase: ImportJob["phase"], value: number, message: string) => void) => Promise<ImportedRepository>;
  reanalyzeIncrementally: (repositoryId: string, changedPaths: string[]) => Promise<void>;
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ImportService 重分析在途守卫（同一仓不并发两轮）", () => {
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

  /** 把仓库写进地址簿并逐个懒挂载；调用方自行 close watcher。 */
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
    // 让出一次循环，第一轮停在 analyze 内部
    await tick();
    const second = probe.reanalyzeIncrementally(repositoryId, ["src/b.ts"]);
    const third = probe.reanalyzeIncrementally(repositoryId, ["src/c.ts", "src/b.ts"]);
    releaseFirst();
    await Promise.all([firstRound, second, third]);

    expect(spy).toHaveBeenCalledTimes(2);
    const mounted = service.getRepository(repositoryId)!;
    expect(mounted.analysis.versionStamp).toBe("content:round2");
    expect(mounted.analysis.lastIncrementalUpdate?.changedPaths).toEqual(["src/b.ts", "src/c.ts"]);
    // 合并后的那一轮同样落库
    const database = new TutorDatabase(repoDir);
    expect(database.state.analysis(repositoryId)?.versionStamp).toBe("content:round2");
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

    const inFlight = (service as unknown as ImportServiceProbe).reanalyzeIncrementally(alpha.repositoryId, ["src/a.ts"]);    await tick();

    // 上限 1 时挂 beta：alpha 被驱逐。
    service.ensureMounted(beta.repositoryId);
    expect(service.getRepository(alpha.repositoryId)).toBeUndefined();

    release();
    await inFlight;

    // 旧回合不得把 alpha 复活进内存映射。
    expect(service.getRepository(alpha.repositoryId)).toBeUndefined();
    expect(service.getRepository(beta.repositoryId)).toBeDefined();
    const database = new TutorDatabase(alpha.repoDir);
    // 过期回合的结果不写库
    expect(database.state.analysis(alpha.repositoryId)?.versionStamp).toBe("content:fixture");
    database.close();
    service.getRepository(beta.repositoryId)?.watcher?.close();
  });

  /** 本轮 `versionStamp` 与挂载中那份相同时不回写、不广播。 */
  it("内容没变的一轮不回写产物、不换内存那份分析、也不广播", async () => {
    const { repoDir, repositoryId } = makePersistedRepo(root, "alpha");
    const service = new ImportService();
    expect(mountInto(service, repoDir)).toBe(1);
    service.getRepository(repositoryId)!.watcher?.close();
    const updates: unknown[] = [];
    service.on("event", (event: ServerEvent) => {
      if (event.type === "repository.updated") updates.push(event.payload);
    });

    const probe = service as unknown as ImportServiceProbe;
    // 第一轮：stamp 与磁盘真值不同，该回写、该广播
    await probe.reanalyzeIncrementally(repositoryId, ["src/main.ts"]);
    const afterFirst = service.getRepository(repositoryId)!;
    expect(afterFirst.analysis.versionStamp, "真内容变了那一轮照旧换产物").not.toBe("content:fixture");
    expect(updates).toHaveLength(1);
    const database = new TutorDatabase(repoDir);
    const storedFirst = database.state.analysis(repositoryId)!.lastIncrementalUpdate;
    database.close();

    // 第二轮：磁盘没动
    await probe.reanalyzeIncrementally(repositoryId, ["README.md"]);
    expect(service.getRepository(repositoryId)!.analysis, "内容没变就不该换掉挂载中那份分析").toBe(afterFirst.analysis);
    expect(updates, "没变化就不该再广播一次「仓更新了」").toHaveLength(1);
    const reopened = new TutorDatabase(repoDir);
    expect(reopened.state.analysis(repositoryId)!.lastIncrementalUpdate, "库里那份也不该被 noop 轮改写").toEqual(storedFirst);
    reopened.close();
  });
});

/** 按仓挂起 fs 监听：关掉监听、挂起状态可查、驱逐后仍然有效。 */
describe("ImportService 编辑期免打扰：按仓挂起 fs 监听", () => {
  let root: string;
  let registryFile: string;
  const live: ImportedRepository[] = [];

  function writeRegistry(paths: string[]): void {
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, `${JSON.stringify({ repositories: paths })}\n`);
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-import-pause-")));
    registryFile = join(root, "registry", "repositories.json");
    process.env.TUTOR_REGISTRY_FILE = registryFile;
  });

  afterEach(() => {
    for (const repository of live.splice(0)) repository.watcher?.close();
    delete process.env.TUTOR_REGISTRY_FILE;
    delete process.env.TUTOR_MAX_MOUNTED;
    rmSync(root, { recursive: true, force: true });
  });

  function track(repositoryId: string, service: ImportService): ImportedRepository {
    const repository = service.getRepository(repositoryId)!;
    live.push(repository);
    return repository;
  }

  it("挂起 = 那条 fs 监听被关掉；恢复 = 重新起一条并返回状态", () => {
    const repo = makePersistedRepo(root, "pausable");
    writeRegistry([repo.repoDir]);
    const service = new ImportService();
    expect(service.ensureMounted(repo.repositoryId).ok).toBe(true);
    const mounted = track(repo.repositoryId, service);
    // 常规挂载会起监听
    expect(mounted.watch.started).toBe(true);

    const paused = service.pauseWatching(repo.repositoryId);
    expect(mounted.watch.started).toBe(false);
    expect(mounted.watcher, "挂起要把握着 fs.watch 的那个对象交出去，只改状态不算关").toBeUndefined();
    expect(service.catalog().find((item) => item.repositoryId === repo.repositoryId)?.watchPaused).toBe(true);

    const resumed = service.resumeWatching(repo.repositoryId);
    expect(resumed).toEqual({ paused: false, woken: true });
    expect(mounted.watch.started).toBe(true);
    expect(mounted.watcher).toBeDefined();
    expect(service.catalog().find((item) => item.repositoryId === repo.repositoryId)?.watchPaused, "恢复后读数要跟着回来").toBeUndefined();
    expect(new Date(paused.until).getTime()).toBeGreaterThan(Date.now());
  });

  it("挂起活过 LRU 驱逐：挤出去再点回来，仍然不起监听（用户按下的开关不能悄悄失效）", () => {
    // 上限 1，挂第二条就会挤掉第一条
    process.env.TUTOR_MAX_MOUNTED = "1";
    const alpha = makePersistedRepo(root, "paused-alpha");
    const beta = makePersistedRepo(root, "ejected-beta");
    writeRegistry([alpha.repoDir, beta.repoDir]);
    const service = new ImportService();
    service.ensureMounted(alpha.repositoryId);
    service.pauseWatching(alpha.repositoryId);
    service.ensureMounted(beta.repositoryId);
    track(beta.repositoryId, service);
    expect(service.getRepository(alpha.repositoryId), "前提：alpha 已被驱逐").toBeUndefined();

    service.ensureMounted(alpha.repositoryId);
    const remounted = track(alpha.repositoryId, service);
    expect(remounted.watch.started).toBe(false);
    expect(remounted.watcher).toBeUndefined();
    expect(service.catalog().find((item) => item.repositoryId === alpha.repositoryId)?.watchPaused).toBe(true);
  });

  it("挂起窗口夹在 1 分钟~6 小时：太短没意义，太长等于忘了它存在", () => {
    const repo = makePersistedRepo(root, "bounded-pause");
    writeRegistry([repo.repoDir]);
    const service = new ImportService();
    service.ensureMounted(repo.repositoryId);
    track(repo.repositoryId, service);

    const now = Date.now();
    expect(service.pauseWatching(repo.repositoryId, 1).until - now).toBeGreaterThanOrEqual(59_000);
    expect(service.pauseWatching(repo.repositoryId, 9_999_999_999).until - now).toBeLessThanOrEqual(6 * 60 * 60_000 + 1_000);
    // 非法值按默认 30 分钟
    expect(service.pauseWatching(repo.repositoryId, Number.NaN).until - now).toBeGreaterThanOrEqual(29 * 60_000);
    service.resumeWatching(repo.repositoryId);
    expect(service.watchPauseOf(repo.repositoryId)).toEqual({ paused: false });
  });
});
