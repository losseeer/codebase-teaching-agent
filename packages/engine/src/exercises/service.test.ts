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
import { selectZpdTarget } from "./learner.js";
import { ExerciseService, type PracticeRepository } from "./service.js";
import { scheduleSm2 } from "./sm2.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("M2.1 exercise service", () => {
  it("reuses a cached exercise until its content version changes", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const first = await service.next(repository, { kind: "output_prediction" });
    const second = await service.next(repository, { kind: "output_prediction" });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);

    const changedVersion = { ...repository, analysis: { ...repository.analysis, versionStamp: "content-v2" } };
    const regenerated = await service.next(changedVersion, { kind: "output_prediction" });
    expect(regenerated.id).not.toBe(first.id);
    expect(regenerated.contentVersion).toBe("content-v2");
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

  it("generates impact questions with automatic grading and filters targets by knowledge module", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const impact = await service.next(repository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    const passedImpact = await service.answer(repository, impact.id, { selectedIds: ["src/config.js", "src/main.js"] });
    expect(passedImpact.passed).toBe(true);

    // fixture 单元不命中任何默认关键词 → 归「其他」模块；network 模块下无可出题单元
    const moduleIds = ["network", "os", "lang", "other"];
    const scoped = await service.next(repository, { kind: "output_prediction", moduleId: "other", moduleIds });
    expect(scoped.kind).toBe("output_prediction");
    await expect(service.next(repository, { kind: "output_prediction", moduleId: "network", moduleIds })).rejects.toThrow("当前知识模块下没有可出题的代码单元");
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
  });

  it("主题与仓库零命中时不调用 LLM，直接抛出可换的标签提示", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const { provider, calls } = fakeProvider([generationJson]);
    await expect(service.next(repository, { family: "llm", tag: "kubernetes", tagId: "custom-unrelated" }, provider)).rejects.toThrow("没有找到与「kubernetes」主题相关的源码文件");
    expect(calls).toHaveLength(0);
    expect(readJournal(repository.path).some((event) => event.type === "exercise_declined")).toBe(false);
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
