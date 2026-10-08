import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryAnalysis } from "@codebase-tutor/shared";
import { buildDependencyGraph, serializeGraph } from "../depgraph/graph.js";
import { buildImplementationUnits } from "../implementation/units.js";
import { indexRepository } from "../indexer/indexer.js";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { TutorDatabase } from "../store/database.js";
import { readJournal } from "../store/journal.js";
import { selectZpdTarget } from "./zpd.js";
import { ExerciseService, type PracticeRepository } from "./exercises.js";
import { scheduleSm2 } from "./sm2.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("M2.1 exercise service", () => {
  it("reuses a cached exercise until its target file's content changes（B1：失效轴是依赖文件，不是全仓）", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const first = await service.next(repository, { kind: "output_prediction" });
    const second = await service.next(repository, { kind: "output_prediction" });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);

    // 无关文件的改动只会翻转全仓 versionStamp，不碰目标文件的 contentHash → 命中缓存，不重烧
    const unrelatedChange = { ...repository, analysis: { ...repository.analysis, versionStamp: "content-v2" } };
    const reused = await service.next(unrelatedChange, { kind: "output_prediction" });
    expect(reused.id).toBe(first.id);

    // 目标文件自身变了 → 重算，新题带上自己的依赖哈希
    const targetPath = first.anchors[0]!.path;
    const bumpedFiles = repository.index.files.map((file) => file.path === targetPath ? { ...file, contentHash: "bumped" } : file);
    const targetChange = { ...repository, index: { ...repository.index, files: bumpedFiles }, analysis: { ...repository.analysis, versionStamp: "content-v2" } };
    const regenerated = await service.next(targetChange, { kind: "output_prediction" });
    expect(regenerated.id).not.toBe(first.id);
    expect(regenerated.contentVersion).toBe("content-v2");
    expect(regenerated.contentHashes).toContainEqual({ path: targetPath, hash: "bumped" });
  });

  it("作答时效按依赖文件判定：无关文件更新仍可作答，目标文件更新才拒绝", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const exercise = await service.next(repository, { kind: "output_prediction" });
    const targetPath = exercise.anchors[0]!.path;
    const bumpedFiles = repository.index.files.map((file) => file.path === targetPath ? { ...file, contentHash: "changed" } : file);

    const unrelatedChange = { ...repository, analysis: { ...repository.analysis, versionStamp: "content-v2" } };
    const result = await service.answer(unrelatedChange, exercise.id, { text: "practice" });
    expect(result.passed).toBe(true);

    const targetChanged = { ...repository, index: { ...repository.index, files: bumpedFiles } };
    await expect(service.answer(targetChanged, exercise.id, { text: "practice" })).rejects.toThrow("依赖的源码已更新");
  });

  it("出题缓存按「模型 + 题面口径」分作用域：换模型会重跑一次，而不是复用旧题面", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    let polishAttempts = 0;
    // 润色调用一律失败 → refineExerciseWithLlm 回落启发式题面；调用次数就是「这一层重算了几次」的读数
    const provider = (modelVersion: string): LlmProvider => ({
      name: "fake", modelVersion,
      complete: async () => { polishAttempts += 1; throw new Error("unavailable"); }
    });
    await service.next(repository, { kind: "output_prediction" }, provider("model-a"));
    await service.next(repository, { kind: "output_prediction" }, provider("model-a"));
    expect(polishAttempts).toBe(1);
    await service.next(repository, { kind: "output_prediction" }, provider("model-b"));
    expect(polishAttempts).toBe(2);
    // 静态题的答案与判分不出自模型，所以两档作用域共用同一个 id 是安全的
    //
    // 润色失败必须自己站出来：这三条在过去全记成同一副样子（只有 source:"rule"），
    // 于是漏斗里「模型写过的题面」永远比真相少，端点抽风的那几天看着像「没人用润色」。
    const generated = readJournal(repository.path).filter((event) => event.type === "exercise_generated");
    expect(generated.map((event) => event.payload.polish)).toEqual(["failed", "failed", "failed"]);
    expect(generated.map((event) => event.payload.polish_failure)).toEqual(["provider_error", "provider_error", "provider_error"]);
    // 第二条走的是缓存命中：失败形状跟着那一行走，命中时照样知道当时坏在哪
    expect(generated[1].payload.source).toBe("cache");

    // 另一头也要能看出来：模型真的改写过的题，记的是 polish:"llm"，而不是同样一句「rule」
    const working: LlmProvider = {
      name: "fake", modelVersion: "model-c",
      complete: async () => ({ text: JSON.stringify({ title: "模型改写的题面", prompt: "模型改写的题干" }), usage: { inputTokens: 800, outputTokens: 120 } })
    };
    const polished = await service.next(repository, { kind: "change_localization" }, working);
    expect(polished.title).toBe("模型改写的题面");
    const last = readJournal(repository.path).filter((event) => event.type === "exercise_generated").at(-1)!;
    expect(last.payload).toMatchObject({ source: "rule", polish: "llm", polish_failure: null });
  });

  it("executes a bounded output oracle and grades exact dependency sets", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const output = await service.next(repository, { kind: "output_prediction" });
    expect(output.gradingMode).toBe("execution");
    const outputResult = await service.answer(repository, output.id, { text: "practice" });
    expect(outputResult.passed).toBe(true);
    const database = new TutorDatabase(repository.path);
    database.saveReviewSchedule(repository.index.repositoryId, { ...outputResult.review, dueAt: "2020-01-01T00:00:00.000Z" });
    database.close();
    expect((await service.next(repository)).id).toBe(output.id);

    const localization = await service.next(repository, { kind: "change_localization" });
    const expectedPath = localization.anchors[0]?.path;
    expect(expectedPath).toBeTruthy();
    expect((await service.answer(repository, localization.id, { selectedIds: [expectedPath!] })).passed).toBe(true);
    const mismatch = await service.answer(repository, localization.id, { selectedIds: [expectedPath!, "src/main.js"] });
    expect(mismatch.passed).toBe(false);
    expect(mismatch.unexpectedIds).toContain("src/main.js");
  });

  it("非 JS 仓的 set_match 题：正解必须在选项里，干扰项也得是同族源码", async () => {
    /**
      旧 `sourceOptions` 先按**手写的**扩展名白名单（ts/js/py）筛一遍再取正解，非 JS 仓的
      `change_localization` / `impact_analysis` 于是给出「怎么选都不过」的题——dianping 库里那条
      `CircuitBreakerAspect.java` 的缓存行实测选项全是 `stress/report/content/js/*.js`。
      夹具把正解排在字典序末尾、同包塞满竞争者，是为了让这条测试咬得住：只换宽干扰项池过不了它，
      必须有「正解不被扩展名筛掉」这条不变量在才选得出答案。
      */
    const repository = testRepository();
    const service = new ExerciseService();
    const answer = "src/main/java/com/demo/ZebraOrderService.java";
    const dependee = "src/main/java/com/demo/A0Component.java";
    // 同包再放 17 个 Java 文件当竞争者：选项上限 8，正解按字典序排在末尾，靠干扰项池「顺带捞到」是捞不回来的
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
    // 照着依赖图真答一次必须能过——「选项里没有正解」的题在这一条上会直接现形
    expect((await service.answer(javaRepository, impact.id, { selectedIds: [answer, dependee] })).passed).toBe(true);

    const source = repository.analysis.implementations[0]!;
    const javaUnit = { ...source, symbol: { ...source.symbol, path: answer, language: "java" as const } };
    const localizationRepository: PracticeRepository = { ...javaRepository, analysis: { ...javaRepository.analysis, implementations: [javaUnit] } };
    const localization = await service.next(localizationRepository, { kind: "change_localization", targetUnitId: javaUnit.id });
    const localizationIds = optionIdsOf(localization);
    expect(localizationIds).toContain(answer);
    // 干扰项来自依赖图那套扩展名（能力表派生），不再是「本模块手写的一份 JS 清单」
    expect(localizationIds.every((id) => id.endsWith(".java"))).toBe(true);
    expect((await service.answer(localizationRepository, localization.id, { selectedIds: [answer] })).passed).toBe(true);
  });

  it("判分吃缓存行里冻结的那一份标准答案，不再把可执行表达式冻进缓存、每次作答重跑一个子进程", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const output = await service.next(repository, { kind: "output_prediction" });
    // 判分结论仍然对（冻结值 == 当时重跑的值，源码变了由 staleDependencies 先拦）
    expect((await service.answer(repository, output.id, { text: "practice" })).passed).toBe(true);
    const database = new TutorDatabase(repository.path);
    const row = database.getExerciseCacheById<{ expected: { expectedOutput?: string; invocation?: unknown } }>(repository.index.repositoryId, output.id);
    database.close();
    expect(row?.expected.expectedOutput).toBeTruthy();
    expect(row?.expected.invocation).toBeUndefined();
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

  it("图变了而源码版本一字不动：impact 题的旧缓存行不再冒充当前答案（键里带图指纹）", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const small = await service.next(repository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    // 模拟 10-06 那种改图：源代码内容没动（versionStamp 不变），只是引擎多认出一条依赖边
    const widenedGraph: RepositoryAnalysis["graph"] = {
      ...repository.analysis.graph,
      imports: { ...repository.analysis.graph.imports, "src/widened-consumer.js": ["src/config.js"] }
    };
    const widened: PracticeRepository = { ...repository, analysis: { ...repository.analysis, graph: widenedGraph } };
    expect(widened.analysis.versionStamp).toBe(repository.analysis.versionStamp);
    const large = await service.next(widened, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    // 没有图指纹的话这一条会直接命中上一行（createdAt 一字不差），拿旧图的答案出新题
    expect(large.createdAt).not.toBe(small.createdAt);
    // 原图那一行必须还在自己的作用域里：回到旧图要能命中它，而不是被新行覆盖掉
    const back = await service.next(repository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    expect(back.createdAt).toBe(small.createdAt);
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
    // 每次「送达」都留痕：漏斗分母要分得清 llm 新生成与缓存复用
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
    // 复习排期与答题都按 id 回查缓存行，所以两代题必须各自留痕
    const database = new TutorDatabase(repository.path);
    expect(database.getExerciseCacheById(repository.index.repositoryId, first.id)).toBeTruthy();
    database.close();
  });

  it("主题与仓库零命中时不调用 LLM，抛出可换的标签提示并记 no_candidates 拒绝", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider, calls } = fakeProvider([generationJson]);
    await expect(service.next(repository, { family: "llm", tag: "kubernetes", tagId: "custom-unrelated" }, provider)).rejects.toThrow("没有找到与「kubernetes」主题相关的源码文件");
    expect(calls).toHaveLength(0);
    // 09-22 改口径：零候选也要留痕——漏斗必须分得清「没走到模型」与「被模型拒绝」
    expect(readJournal(repository.path).some((event) => event.type === "exercise_declined" && event.payload.stage === "no_candidates")).toBe(true);
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
    await expect(service.next(repository, { family: "llm", tag: "config", tagId: "custom-x" }, provider)).rejects.toThrow("守门校验");
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
    await expect(service.answer(repository, exercise.id, { text: "再答一次" })).rejects.toThrow("rubric 判分需要 LLM");
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
    quality: { generatedAt: "2026-01-01T00:00:00.000Z", micro: [], macro: [] },
    versionStamp: "content-v1"
  };
  return { path: repositoryPath, index, analysis };
}
