import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryAnalysis } from "@codebase-tutor/domain";
import { flushEngineLog } from "@codebase-tutor/platform";

import { buildDependencyGraph, serializeGraph } from "@codebase-tutor/analysis";
import { buildImplementationUnits } from "../implementation/units.js";
import { indexRepository } from "../indexer/indexer.js";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../application/port/llm-provider.js";
import { TutorDatabase } from "../adapter/outbound/persistence/database.js";
import { readJournal } from "../adapter/outbound/persistence/journal.js";
import { RepositoryHandle } from "../adapter/outbound/persistence/repository-handle.js";
import { resetIsolationForTest, stubIsolationForTest } from "../adapter/outbound/sandbox/isolation.js";
import { selectZpdTarget } from "./zpd.js";
import { exercisePortsFor } from "../infrastructure/exercise-ports.js";
import { ExerciseService, type PracticeRepository } from "./exercises.js";
import { scheduleSm2 } from "./sm2.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../../test-fixtures/frozen-demo-repo");
const temporaryDirectories: string[] = [];

afterEach(() => {
  // 先放开 builder 那次 pin 再关连接，然后删目录：否则留下删不净的 -wal/-shm 边文件。
  for (const handle of handles.splice(0)) {
    handle.unpin();
    handle.close();
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("M2.1 exercise service", () => {
  it("reuses a cached exercise until its target file's content changes（B1：失效轴是依赖文件，不是全仓）", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const first = await service.next(repository, { kind: "change_localization" });
    const second = await service.next(repository, { kind: "change_localization" });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);

    // 无关文件的改动只翻转全仓 versionStamp：应命中缓存。
    const unrelatedChange = { ...repository, analysis: { ...repository.analysis, versionStamp: "content-v2" } };
    const reused = await service.next(unrelatedChange, { kind: "change_localization" });
    expect(reused.id).toBe(first.id);

    // 目标文件自身变了：应重算。
    const targetPath = first.anchors[0]!.path;
    const bumpedFiles = repository.index.files.map((file) => file.path === targetPath ? { ...file, contentHash: "bumped" } : file);
    const targetChange = { ...repository, index: { ...repository.index, files: bumpedFiles }, analysis: { ...repository.analysis, versionStamp: "content-v2" } };
    const regenerated = await service.next(targetChange, { kind: "change_localization" });
    expect(regenerated.id).not.toBe(first.id);
    expect(regenerated.contentVersion).toBe("content-v2");
    expect(regenerated.contentHashes).toContainEqual({ path: targetPath, hash: "bumped" });
  });

  it("作答时效按依赖文件判定：无关文件更新仍可作答，目标文件更新才拒绝", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const exercise = await service.next(repository, { kind: "change_localization" });
    const targetPath = exercise.anchors[0]!.path;
    const bumpedFiles = repository.index.files.map((file) => file.path === targetPath ? { ...file, contentHash: "changed" } : file);

    const unrelatedChange = { ...repository, analysis: { ...repository.analysis, versionStamp: "content-v2" } };
    const result = await service.answer(unrelatedChange, exercise.id, { selectedIds: [targetPath] });
    expect(result.passed).toBe(true);

    const targetChanged = { ...repository, index: { ...repository.index, files: bumpedFiles } };
    await expect(service.answer(targetChanged, exercise.id, { selectedIds: [targetPath] })).rejects.toThrow("依赖的源码已更新");
  });

  it("出题缓存按「模型 + 题面口径」分作用域：换模型会重跑一次，而不是复用旧题面", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    let polishAttempts = 0;
    // 润色调用一律失败：回落启发式题面。
    const provider = (modelVersion: string): LlmProvider => ({
      name: "fake", modelVersion,
      complete: async () => { polishAttempts += 1; throw new Error("unavailable"); }
    });
    await service.next(repository, { kind: "change_localization" }, provider("model-a"));
    await service.next(repository, { kind: "change_localization" }, provider("model-a"));
    expect(polishAttempts).toBe(1);
    await service.next(repository, { kind: "change_localization" }, provider("model-b"));
    expect(polishAttempts).toBe(2);
    // 三种成因要分档记：润色失败不混进成功记录。
    const generated = readJournal(repository.path).filter((event) => event.type === "exercise_generated");
    expect(generated.map((event) => event.payload.polish)).toEqual(["failed", "failed", "failed"]);
    expect(generated.map((event) => event.payload.polish_failure)).toEqual(["provider_error", "provider_error", "provider_error"]);
    // 第二条走缓存命中：失败形状跟着那一行走。
    expect(generated[1].payload.source).toBe("cache");

    // 模型改写成功的题记 polish:"llm"。
    const working: LlmProvider = {
      name: "fake", modelVersion: "model-c",
      complete: async () => ({ text: JSON.stringify({ title: "模型改写的题面", prompt: "模型改写的题干" }), usage: { inputTokens: 800, outputTokens: 120 } })
    };
    const polished = await service.next(repository, { kind: "change_localization" }, working);
    expect(polished.title).toBe("模型改写的题面");
    const last = readJournal(repository.path).filter((event) => event.type === "exercise_generated").at(-1)!;
    expect(last.payload).toMatchObject({ source: "rule", polish: "llm", polish_failure: null });
  });

  /** 指定记录出不了题与整仓没有可生成的题，是两种成因。 */
  it("点出不了题的旧记录不说「请先重新导入仓库」，journal 记 target_stale", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    await expect(service.next(repository, { targetUnitId: "workflow:src/pay.ts" })).rejects.toThrow(/这条练习记录已经出不了题/);
    const declined = readJournal(repository.path).filter((event) => event.type === "exercise_declined").at(-1)!;
    expect(declined.payload).toMatchObject({ stage: "target_stale", family: "comprehension" });
    // 同一份产物里别的单元照样出得出题。
    await expect(service.next(repository, { kind: "impact_analysis" })).resolves.toMatchObject({ kind: "impact_analysis" });
  });

  it("到期复习题优先返回同一道，set_match 按「答对 / 答漏 / 答多」精确判分", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const localization = await service.next(repository, { kind: "change_localization" });
    const expectedPath = localization.anchors[0]?.path;
    expect(expectedPath).toBeTruthy();
    const graded = await service.answer(repository, localization.id, { selectedIds: [expectedPath!] });
    expect(graded.passed).toBe(true);

    // 到期时间改早后，next() 先还复习队列。
    const database = new TutorDatabase(repository.path);
    database.reviews.save(repository.index.repositoryId, { ...graded.review, dueAt: "2020-01-01T00:00:00.000Z" });
    database.close();
    expect((await service.next(repository)).id).toBe(localization.id);

    const mismatch = await service.answer(repository, localization.id, { selectedIds: [expectedPath!, "src/main.js"] });
    expect(mismatch.passed).toBe(false);
    expect(mismatch.unexpectedIds).toContain("src/main.js");
  });

  it("非 JS 仓的 set_match 题：正解必须在选项里，干扰项也得是同族源码", async () => {
    /** 正解必须出现在选项里：夹具把正解排在字典序末尾、同包塞满竞争者。 */
    const repository = testRepository();
    const service = new ExerciseService();
    const answer = "src/main/java/com/demo/ZebraOrderService.java";
    const dependee = "src/main/java/com/demo/A0Component.java";
    // 同包再放 17 个 Java 文件当竞争者：选项上限 8。
    const neighbours = Array.from({ length: 17 }, (_, index) => `src/main/java/com/demo/B${index}Component.java`);
    const javaFiles = [answer, dependee, ...neighbours].map((path) => ({ path, extension: ".java", bytes: 40, lines: 12, contentHash: `h-${path}` }));
    const javaRepository: PracticeRepository = {
      ...repository,
      index: { ...repository.index, files: [...repository.index.files, ...javaFiles] },
      analysis: {
        ...repository.analysis,
        graph: {
          ...repository.analysis.graph,
          imports: { ...repository.analysis.graph.imports, [answer]: [], [dependee]: [answer] }
        }
      }
    };
    const optionIdsOf = (exercise: { options?: { id: string }[] }) => (exercise.options ?? []).map((option) => option.id);

    const impact = await service.next(javaRepository, { kind: "impact_analysis", targetUnitId: `impact:${answer}` });
    expect(optionIdsOf(impact)).toContain(answer);
    // 照着依赖图真答一次必须能过。
    expect((await service.answer(javaRepository, impact.id, { selectedIds: [answer, dependee] })).passed).toBe(true);

    const source = repository.analysis.implementations[0]!;
    const javaUnit = { ...source, symbol: { ...source.symbol, path: answer, language: "java" as const } };
    const localizationRepository: PracticeRepository = { ...javaRepository, analysis: { ...javaRepository.analysis, implementations: [javaUnit] } };
    const localization = await service.next(localizationRepository, { kind: "change_localization", targetUnitId: javaUnit.id });
    const localizationIds = optionIdsOf(localization);
    expect(localizationIds).toContain(answer);
    // 干扰项来自能力表派生的扩展名。
    expect(localizationIds.every((id) => id.endsWith(".java"))).toBe(true);
    expect((await service.answer(localizationRepository, localization.id, { selectedIds: [answer] })).passed).toBe(true);
  });

  it("generates impact questions with automatic grading", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const impact = await service.next(repository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    const passedImpact = await service.answer(repository, impact.id, { selectedIds: ["src/config.js", "src/main.js"] });
    expect(passedImpact.passed).toBe(true);
  });

  it("caps large impact exercises to a focused first review set", async () => {
    const repository = testRepository();
    const consumers = Array.from({ length: 12 }, (_, index) => `src/consumer-${index}.ts`);
    const files = [repository.index.files.find((file) => file.path === "src/config.js")!, ...consumers.map((path) => ({ path, extension: ".ts", bytes: 20, lines: 1 }))];
    const imports = Object.fromEntries([["src/config.js", []], ...consumers.map((path) => [path, ["src/config.js"]])]);
    const largeRepository: PracticeRepository = {
      ...repository,
      index: { ...repository.index, files },
      analysis: { ...repository.analysis, graph: { ...repository.analysis.graph, imports } }
    };
    const exercise = await new ExerciseService().next(largeRepository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    expect(exercise.prompt).toContain("第一批");
    expect(exercise.options).toHaveLength(8);
    const result = await new ExerciseService().answer(largeRepository, exercise.id, { selectedIds: ["src/config.js", "src/consumer-0.ts", "src/consumer-1.ts", "src/consumer-10.ts"] });
    expect(result.passed).toBe(true);
  });

  it("图变了而源码版本一字不动：impact 题的旧缓存行不再伪装成当前答案（键里带图指纹）", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const small = await service.next(repository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    // 源码内容没动、只多认一条依赖边。
    const widenedGraph: RepositoryAnalysis["graph"] = {
      ...repository.analysis.graph,
      imports: { ...repository.analysis.graph.imports, "src/widened-consumer.js": ["src/config.js"] }
    };
    const widened: PracticeRepository = { ...repository, analysis: { ...repository.analysis, graph: widenedGraph } };
    expect(widened.analysis.versionStamp).toBe(repository.analysis.versionStamp);
    const large = await service.next(widened, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    // 回到旧图必须命中原来那一行。
    const back = await service.next(repository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    /** 判据是 journal 里的 `exercise_generated.source` 序列，不是时间戳。 */
    const sourcesOf = (): unknown[] => readJournal(repository.path).filter((event) => event.type === "exercise_generated").map((event) => event.payload.source);
    expect(sourcesOf()).toEqual(["rule", "rule", "cache"]);
    expect(back.createdAt).toBe(small.createdAt);
    expect(large.prompt).toBeTruthy();
  });
});

describe("M2.1 learner scheduling", () => {
  it("follows SM-2 intervals and resets repetitions after a low-quality answer", () => {
    const initial = { exerciseId: "exercise-1", unitId: "unit-1", repetitions: 0, intervalDays: 0, easinessFactor: 2.5, dueAt: "2026-01-01T00:00:00.000Z" };
    const first = scheduleSm2(initial, 5, new Date("2026-01-01T00:00:00.000Z"));
    const second = scheduleSm2(first, 5, new Date("2026-01-02T00:00:00.000Z"));
    const failed = scheduleSm2(second, 1, new Date("2026-01-08T00:00:00.000Z"));
    expect(first).toMatchObject({ repetitions: 1, intervalDays: 1, easinessFactor: 2.6 });
    expect(second).toMatchObject({ repetitions: 2, intervalDays: 6 });
    expect(failed).toMatchObject({ repetitions: 0, intervalDays: 1 });
  });

  it("keeps ZPD target difficulty within one level of latest mastery", () => {
    const selected = selectZpdTarget([
      { id: "easy", title: "easy", difficulty: 1, value: "easy" },
      { id: "near", title: "near", difficulty: 3, value: "near" },
      { id: "far", title: "far", difficulty: 5, value: "far" }
    ], [{ unitId: "recent", level: 2, attempts: 3, successes: 2, lastPracticedAt: "2026-01-03T00:00:00.000Z" }]);
    expect(selected).toBeDefined();
    expect(Math.abs(selected!.difficulty - 2)).toBeLessThanOrEqual(1);
  });
});

describe("沙箱这一关走在扣钱之前", () => {
  // 这条要建临时仓、开真 SQLite、走真实出题路径，给它一条显式超时预算。
  it("隔离不可用 ⇒ 代码题直接拒，provider 一次都没被打", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const unit = repository.analysis.implementations.find((candidate) => candidate.symbol.language === "typescript") ?? repository.analysis.implementations[0]!;
    const sent: LlmCompletionInput[] = [];
    const provider: LlmProvider = {
      name: "fake", modelVersion: "fake-model",
      complete: async (input) => { sent.push(input); return { text: "{}", finishReason: "stop" }; }
    };
    stubIsolationForTest({ level: "unavailable", backend: "seatbelt", checks: [], probedAt: new Date().toISOString(), durationMs: 0, reason: "探测没过（测试注入）" });
    try {
      await expect(service.next(repository, { kind: "patch_edit", targetUnitId: unit.id }, provider)).rejects.toThrow("沙箱当前不可用");
      // 隔离不可用时不允许发出出题调用。
      expect(sent).toEqual([]);
      expect(readJournal(repository.path).filter((event) => event.type === "exercise_declined").at(-1)?.payload).toMatchObject({ stage: "sandbox_unavailable", family: "code" });
    } finally {
      resetIsolationForTest();
    }
  }, 15_000);
});

describe("LLM 出题族（tag 出题 + rubric 判分 + 缓存）", () => {
  const generationJson = JSON.stringify({
    ok: true,
    title: "分析 clamp 的输入处理",
    prompt: "阅读下面摘录里第 1 行的 clamp 函数：传入一个值后它如何处理边界？结合代码说明这个设计的取舍。",
    answerKey: "clamp 对传入值没有任何特殊处理，直接返回原值；边界职责完全交给调用方。",
    criteria: [
      { dimension: "正确性", description: "指出直接返回原值" },
      { dimension: "解释性", description: "说明了边界职责在调用方" }
    ],
    anchors: [{ path: "src/config.js", line: 1 }],
    targetTitle: "clamp"
  });
  const judgeJson = JSON.stringify({ score: 0.8, passed: true, feedback: "要点基本答到，缺少对调用方职责的说明。" });

  function fakeProvider(responses: string[]): { provider: LlmProvider; calls: LlmCompletionInput[] } {
    const calls: LlmCompletionInput[] = [];
    let index = 0;
    return {
      calls,
      provider: {
        name: "fake",
        modelVersion: "fake-model",
        async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
          calls.push(input);
          const text = responses[Math.min(index, responses.length - 1)];
          index += 1;
          return { text };
        }
      }
    };
  }

  it("一轮调用出题并落缓存；同 tag+nonce 复用，换 nonce 出新题", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider, calls } = fakeProvider([generationJson]);
    const first = await service.next(repository, { family: "llm", tag: "config", tagId: "custom-tag" }, provider);
    expect(first.kind).toBe("llm_rubric");
    expect(first.family).toBe("llm");
    expect(first.inputMode).toBe("open");
    expect(first.gradingMode).toBe("rubric");
    expect(first.tag).toBe("config");
    expect(first.anchors[0]?.path).toBe("src/config.js");
    expect(calls).toHaveLength(1);
    const reused = await service.next(repository, { family: "llm", tag: "config", tagId: "custom-tag" }, provider);
    expect(reused.id).toBe(first.id);
    expect(calls).toHaveLength(1);
    const variant = await service.next(repository, { family: "llm", tag: "config", tagId: "custom-tag", variantNonce: 1 }, provider);
    expect(variant.id).not.toBe(first.id);
    expect(calls).toHaveLength(2);
    // 每次送达都留痕：分得清新生成与缓存复用。
    expect(readJournal(repository.path).filter((event) => event.type === "exercise_generated").map((event) => event.payload.source)).toEqual(["llm", "cache", "llm"]);
  });

  it("换模型 = 换一道题：不共用缓存，也不共用 id（旧题仍可按 id 回查判分）", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider, calls } = fakeProvider([generationJson]);
    const first = await service.next(repository, { family: "llm", tag: "config", tagId: "custom-tag" }, provider);
    const second = await service.next(repository, { family: "llm", tag: "config", tagId: "custom-tag" }, { ...provider, modelVersion: "other-model" });
    expect(calls).toHaveLength(2);
    expect(second.id).not.toBe(first.id);
    // 两代题必须各自留痕：排期与答题都按 id 回查缓存行。
    const database = new TutorDatabase(repository.path);
    expect(database.exercises.byId(repository.index.repositoryId, first.id)).toBeTruthy();
    database.close();
  });

  it("主题与仓库零命中时改从全景挑素材：仍打模型一次，并记 selection=panorama", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider, calls } = fakeProvider([generationJson]);
    const exercise = await service.next(repository, { family: "llm", tag: "kubernetes", tagId: "custom-unrelated" }, provider);
    expect(calls, "词法零命中不再直接拒题：全景挑得出的素材照样出题").toHaveLength(1);
    expect(exercise.kind).toBe("llm_rubric");
    const events = readJournal(repository.path);
    expect(events.some((event) => event.type === "exercise_declined" && event.payload.stage === "no_candidates"), "不该再记零候选拒绝").toBe(false);
    expect(events.find((event) => event.type === "exercise_generated" && event.payload.source === "llm")?.payload.selection, "留痕要分得清这次是命中选题还是全景兜底").toBe("panorama");
  });

  it("LLM 拒绝出题时抛出理由并记 exercise_declined journal", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider } = fakeProvider([JSON.stringify({ ok: false, reason: "当前仓库没有与该主题相关的代码素材。" })]);
    await expect(service.next(repository, { family: "llm", tag: "config", tagId: "custom-x" }, provider)).rejects.toThrow("当前仓库没有与该主题相关的代码素材。");
    expect(readJournal(repository.path).some((event) => event.type === "exercise_declined")).toBe(true);
  });

  it("LLM 返回幻觉锚点时被守门否决", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const hallucinated = JSON.parse(generationJson);
    hallucinated.anchors = [{ path: "src/invented.ts", line: 1 }];
    const { provider } = fakeProvider([JSON.stringify(hallucinated)]);
    await expect(service.next(repository, { family: "llm", tag: "config", tagId: "custom-x" }, provider)).rejects.toThrow("模型出的题不合格");
    expect(readJournal(repository.path).some((event) => event.type === "exercise_declined" && event.payload.stage === "guard")).toBe(true);
  });

  it("rubric 判分走 LLM 比对，automatic=false；未配置 provider 时显式报错", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider } = fakeProvider([generationJson, judgeJson]);
    const exercise = await service.next(repository, { family: "llm", tag: "config", tagId: "custom-tag" }, provider);
    const result = await service.answer(repository, exercise.id, { text: "返回原值，边界交给调用方。" }, provider);
    expect(result.automatic).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.8);
    expect(result.feedbackSource).toBe("llm_judge");
    await expect(service.answer(repository, exercise.id, { text: "再答一次" })).rejects.toThrow("判分需要模型");
  });

  it("模型把分数写成字符串（\"0.00\"）时照它给的分判，不再整趟失败", async () => {
    // 模型会把 score 写成字符串（`"0.00"`）。
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider } = fakeProvider([generationJson, JSON.stringify({ score: "0.00", passed: false, feedback: "回答为“不知道”，未提供任何要点。" })]);
    const exercise = await service.next(repository, { family: "llm", tag: "config", tagId: "custom-quote" }, provider);
    const result = await service.answer(repository, exercise.id, { text: "不知道" }, provider);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("未提供任何要点");
  });

  it("回复里读不出 JSON 时照旧失败，并往引擎日志记一条能归因的形状读数", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider } = fakeProvider([generationJson, "这道题我没法评分。"]);
    const exercise = await service.next(repository, { family: "llm", tag: "config", tagId: "custom-prose" }, provider);
    const log = join(temporaryDirectories[temporaryDirectories.length - 1]!, "engine.jsonl");
    process.env.TUTOR_ENGINE_LOG = log;
    try {
      await expect(service.answer(repository, exercise.id, { text: "随便写点什么" }, provider)).rejects.toThrow("这次判分没成功");
      await flushEngineLog();
      expect(readFileSync(log, "utf8")).toContain("exercise_judge_unreadable");
    } finally {
      delete process.env.TUTOR_ENGINE_LOG;
    }
  });
});

function testRepository(): PracticeRepository {
  const directory = mkdtempSync(join(tmpdir(), "codebase-tutor-exercises-"));
  temporaryDirectories.push(directory);
  const repositoryPath = join(directory, "fixture");
  cpSync(fixture, repositoryPath, { recursive: true, filter: (source) => !source.endsWith("/.tutor") && !source.includes("/.tutor/") });
  const index = indexRepository(repositoryPath);
  const graph = buildDependencyGraph(repositoryPath, index.files);
  const implementations = buildImplementationUnits(repositoryPath, graph.symbols);
  const analysis: RepositoryAnalysis = {
    repositoryId: index.repositoryId,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: serializeGraph(graph),
    implementations,
    versionStamp: "content-v1"
  };
  const handle = openHandle(repositoryPath, index.repositoryId);
  // 夹具在这里装配一次真存储；引用由 afterEach 放开。
  return { path: repositoryPath, index, analysis, ports: exercisePortsFor(handle, handle.pin()) };
}

/** 夹具也要真句柄：出题与判分都经它读写产物库。 */
const handles: RepositoryHandle[] = [];
function openHandle(repositoryPath: string, repositoryId: string): RepositoryHandle {
  const handle = new RepositoryHandle(repositoryPath, repositoryId);
  handles.push(handle);
  return handle;
}
