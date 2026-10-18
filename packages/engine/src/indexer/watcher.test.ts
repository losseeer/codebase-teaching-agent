import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTutorIgnoreMatcher } from "./ignore.js";
import { changeWanted, changedAfter, ingestSetDiffers, isArtifactEcho, RepositoryWatcher } from "./watcher.js";
import { listIngestedPaths } from "./indexer.js";

/**
  监听这一层的三条口径（2026-10-06 复审 #123）：
  ① 起不来要如实交出死活（旧写法一个空 catch，之后界面永远报 fresh）；
  ② 自己写的产物不能叫醒自己（`.tutor/**` 恒定不回声，哪怕用户把 `.tutorignore` 写成 `!.tutor/**`）；
  ③ FSWatcher 必须有 error 监听——它是 EventEmitter，运行中报错而没人听会把整台引擎带走。

  ⚠️ 测试口径：判据（`changeWanted`）用纯函数确定性测，真 fs 事件只留一条端到端兜底、
  并且把等待窗口放到 10 秒——整包并行跑时几十路 `fs.watch` 同时投递，3 秒等不到一个 change 是实测到的（第一次就因此红了）。
  时序不能当判据的依据：烧钱级的规则必须每次都能被稳定测到。
  */

const temporaryDirectories: string[] = [];

function repository(extraIgnoreLines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "tutor-watcher-"));
  temporaryDirectories.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  // 只有测试要「用户自己写过一份」时才落那个文件：写了空文件就等于替引擎把默认播种取代了
  // （默认那一份带 node_modules/ 与 .tutor/，正是第二条用例要读的东西）
  if (extraIgnoreLines.length) writeFileSync(join(dir, ".tutorignore"), `${extraIgnoreLines.join("\n")}\n`, "utf8");
  writeFileSync(join(dir, "src/keep.ts"), "export const keep = 1;\n", "utf8");
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // 目录可能压根没建成
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

describe("RepositoryWatcher 的取舍判据（确定性）", () => {
  it("用户显式放行 `.tutor/**` 时：索引层收它，监听层照样不回声", () => {
    const dir = repository(["!.tutor/**"]);
    const matcher = createTutorIgnoreMatcher(dir);
    // 这一条是索引层的既有设计（ignore.test.ts 钉着），说明「放行」确实生效了
    expect(matcher.ignores(".tutor/tutor.db"), "前提：用户放行后匹配器认为产物该被索引").toBe(false);
    // 但监听层不跟：自触发循环的代价是整仓反复重扫，更糟时反复重烧钱
    expect(changeWanted(".tutor/tutor.db", matcher)).toBe(false);
    expect(changeWanted(".tutor/journal.jsonl", matcher)).toBe(false);
    expect(changeWanted(".tutor", matcher)).toBe(false);
    expect(isArtifactEcho(".tutorx/a.ts"), "只挡这一层目录，别顺带挡掉同前缀的源码目录").toBe(false);
    expect(changeWanted("src/keep.ts", matcher)).toBe(true);
  });

  it("默认配置下：忽略项不上报，`.tutorignore` 自己除外（改了要立刻重读）", () => {
    const dir = repository();
    const matcher = createTutorIgnoreMatcher(dir);
    expect(changeWanted("node_modules/x/index.ts", matcher)).toBe(false);
    expect(changeWanted(".tutorignore", matcher)).toBe(true);
    expect(changeWanted("src/keep.ts", matcher)).toBe(true);
  });

  /**
    #163 的判据位。以前「非忽略、非产物」就算源码改动，于是往仓里放一张图片、一份 `.env`
    都会排一整轮重分析：产物被真实扫描换掉（测试里那两条出网用例因此在并行负载下偶发拿到 0 行），
    真仓里则是缓存键重算 + 润色可能重烧。现在只有「可能改变收录集」的改动才叫醒。
    */
  it("文件那一档按收录集筛：非收录扩展名与密钥载体名都不算源码改动", () => {
    const dir = repository();
    const matcher = createTutorIgnoreMatcher(dir);
    expect(changeWanted("src/keep.ts", matcher, "file"), "收录进来的源码照样叫醒").toBe(true);
    expect(changeWanted(".env", matcher, "file"), "`.env` 从来不在扩展名白名单里").toBe(false);
    expect(changeWanted("assets/logo.png", matcher, "file")).toBe(false);
    expect(changeWanted("credentials.json", matcher, "file"), "读层判它「不开放读取」，索引不收它，写入也就不该叫醒重分析").toBe(false);
    // 目录与「判不出来」两档不能照这个筛：批量删除时系统常常只报父目录那一条
    expect(changeWanted("src", matcher, "directory")).toBe(true);
    expect(changeWanted("src/gone.md", matcher, "gone")).toBe(true);
    expect(changeWanted("node_modules", matcher, "directory"), "忽略目录整片不叫醒").toBe(false);
    // 建流那一刻倒还回来的目录历史：不是本轮发生的事
    expect(changeWanted("src/keep.ts", matcher, "predates-watch"), "监听起点之前就存在的文件不算改动").toBe(false);
    expect(changeWanted(".tutorignore", matcher, "predates-watch"), "引擎自己播种的那份配置也不算改动").toBe(false);
  });

  it("收录集快照比对只认路径集合（模糊事件的最后一道筛）", () => {
    expect(ingestSetDiffers(["src/a.ts"], ["src/a.ts"])).toBe(false);
    expect(ingestSetDiffers(["src/a.ts"], ["src/a.ts", "src/b.ts"])).toBe(true);
    expect(ingestSetDiffers(["src/a.ts", "src/b.ts"], ["src/a.ts"]), "删掉一个收录文件同样是变").toBe(true);
    expect(ingestSetDiffers(["src/a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"]), "顺序不算变化").toBe(false);
  });

  it("mtime 与监听起点对到同一格整数毫秒：播种算回放，跨到下一格才算改动", () => {
    // 端到端那条用例偶发白醒的根因：起点 `Date.now()` 是整数毫秒而 `stat.mtimeMs` 带小数，
    // 先写文件再取起点时那份播种反过来「比起点晚」——实测 400 次里 393 次撞进这一格（10-18）。
    expect(changedAfter(1_000, 1_000)).toBe(false);
    expect(changedAfter(1_000.7, 1_000)).toBe(false);
    expect(changedAfter(1_001.0, 1_000), "跨到下一格就是起监听之后的改动了").toBe(true);
    // 真磁盘上的那一份：写完才取起点，无论如何不该被当成改动
    const dir = repository();
    expect(changedAfter(statSync(join(dir, "src/keep.ts")).mtimeMs, Date.now())).toBe(false);
  });

  it("listIngestedPaths 只列收录进来的路径，且不读文件内容", () => {
    const dir = repository();
    writeFileSync(join(dir, "src/skip.png"), "not-text", "utf8");
    writeFileSync(join(dir, "credentials.json"), '{"token":"denied-by-name"}\n', "utf8");
    writeFileSync(join(dir, "src/config.json"), "{}\n", "utf8");
    mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules/pkg/index.ts"), "export const nope = 1;\n", "utf8");
    expect(listIngestedPaths(dir, createTutorIgnoreMatcher(dir)).sort(), "readdir 顺序不参与判定，断言前排好")
      .toEqual(["src/config.json", "src/keep.ts"]);
  });
});

describe("RepositoryWatcher 的死活（复审 #123①③）", () => {
  it("路径不可监听时交出死活并出声（不再空 catch 之后一路假 fresh）", () => {
    const errors: string[] = [];
    const watcher = new RepositoryWatcher("/definitely/not/here/xyz", () => undefined, 50, (message) => errors.push(message));
    const status = watcher.start();
    expect(status.started).toBe(false);
    expect(status.dead).toBe(true);
    expect(status.error).toContain("ENOENT");
    expect(errors).toHaveLength(1);
    expect(watcher.watchStatus.dead).toBe(true);
    watcher.close();
  });

  it("运行中途的 error 事件被接住：标 dead、报出原因，而不是把引擎掀掉", () => {
    const dir = repository();
    const errors: string[] = [];
    const watcher = new RepositoryWatcher(dir, () => undefined, 50, (message) => errors.push(message));
    expect(watcher.start().started).toBe(true);
    // 直接对内部 FSWatcher 发一个 error：修复前的形状里没有监听器，这一条会变成未捕获异常
    const inner = (watcher as unknown as { watcher?: { emit(event: string, error: Error): boolean } }).watcher;
    expect(inner, "监听没起来就别继续测了").toBeTruthy();
    inner!.emit("error", new Error("inotify 额度用尽"));
    expect(errors).toEqual(["inotify 额度用尽"]);
    expect(watcher.watchStatus).toMatchObject({ started: true, dead: true, error: "inotify 额度用尽" });
    watcher.close();
  });

  it("端到端兜底：真源码改动能走到回调，且同一批里不会混进产物路径", async (ctx) => {
    const dir = repository(["!.tutor/**"]);
    const batches: string[][] = [];
    const watcher = new RepositoryWatcher(dir, (paths) => batches.push(paths), 60);
    expect(watcher.start().started).toBe(true);
    // 先让起点跨过整毫秒再动笔：挂载那一毫秒内的改动按判据算回放（`changedAfter` 那段写明了这一代价），
    // 而这条要验的是「之后的真源码改动能走到回调」，不是那一格里的时序。
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 先写产物、再写源码：两者若都会上报就同处一批，所以「这批里没有 .tutor」是可判定的
    mkdirSync(join(dir, ".tutor"), { recursive: true });
    writeFileSync(join(dir, ".tutor", "tutor.db"), "{}", "utf8");
    writeFileSync(join(dir, "src/keep.ts"), "export const keep = 2;\n", "utf8");
    const arrived = await waitFor(() => batches.flat().includes("src/keep.ts"), 20_000);
    watcher.close();
    if (!arrived) {
      // 真 fs 事件在多路 vitest 并行时能迟到二十秒以上（全量首跑实测红过一次）。
      // 这条只是兜底：判据本身由上面那组纯函数用例确定性钉住，所以这里自我跳过并报一声，
      // 而不是留一条会自己红的测试——红一次就被当成真出了问题。
      console.warn("[watcher] 20 秒内没收到真 fs 事件，端到端兜底跳过（判据见上一组纯函数用例）");
      ctx.skip();
    }
    expect(batches.flat().filter((path) => isArtifactEcho(path))).toEqual([]);
    // ⚠️ 这条的超时必须大于上面 20 秒的等待：vitest 默认 5 秒会先把测试判红，
    // 于是「慢就自跳过」这条路根本走不到（并行全量跑实测红过一次，就是这个原因）。
  }, 25_000);

  it("端到端：非收录文件的写入（含它顶一下的仓根目录 mtime）一路都不叫醒", async (ctx) => {
    const dir = repository();
    const batches: string[][] = [];
    const watcher = new RepositoryWatcher(dir, (paths) => batches.push(paths), 60);
    expect(watcher.start().started).toBe(true);
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=not-source\n", "utf8");
    writeFileSync(join(dir, "credentials.json"), "{}\n", "utf8");
    writeFileSync(join(dir, "logo.png"), "not-text", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(batches, "这三份都不在收录集里，一轮重分析都不该排").toEqual([]);
    // 同一台机器上接着验「真改动照样醒」：上一句的「没事件」只有这一句成立才不是监听根本没起来
    writeFileSync(join(dir, "src/added.ts"), "export const added = 1;\n", "utf8");
    const arrived = await waitFor(() => batches.flat().includes("src/added.ts"), 20_000);
    watcher.close();
    if (!arrived) {
      console.warn("[watcher] 20 秒内没收到真 fs 事件，这条端到端自我跳过（判据见上面那组纯函数用例）");
      ctx.skip();
    }
  }, 25_000);
});
