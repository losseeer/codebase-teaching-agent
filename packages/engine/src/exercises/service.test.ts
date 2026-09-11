import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryAnalysis } from "@codebase-tutor/shared";
import { collectDecisionUnits } from "../decision/evidence.js";
import { buildDependencyGraph, serializeGraph } from "../depgraph/graph.js";
import { buildImplementationUnits } from "../implementation/units.js";
import { indexRepository } from "../indexer/indexer.js";
import { TutorDatabase } from "../store/database.js";
import { selectZpdTarget } from "./learner.js";
import { ExerciseService, type PracticeRepository } from "./service.js";
import { scheduleSm2 } from "./sm2.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("M2.1 exercise service", () => {
  it("reuses a cached exercise until its content version changes", () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const first = service.next(repository, { kind: "output_prediction" });
    const second = service.next(repository, { kind: "output_prediction" });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);

    const changedVersion = { ...repository, analysis: { ...repository.analysis, versionStamp: "content-v2" } };
    const regenerated = service.next(changedVersion, { kind: "output_prediction" });
    expect(regenerated.id).not.toBe(first.id);
    expect(regenerated.contentVersion).toBe("content-v2");
  });

  it("executes a bounded output oracle and grades exact dependency sets", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const output = service.next(repository, { kind: "output_prediction" });
    expect(output.gradingMode).toBe("execution");
    const outputResult = await service.answer(repository, output.id, { text: "practice" });
    expect(outputResult.passed).toBe(true);
    const database = new TutorDatabase(repository.path);
    database.saveReviewSchedule(repository.index.repositoryId, { ...outputResult.review, dueAt: "2020-01-01T00:00:00.000Z" });
    database.close();
    expect(service.next(repository).id).toBe(output.id);

    const localization = service.next(repository, { kind: "change_localization" });
    const expectedPath = localization.anchors[0]?.path;
    expect(expectedPath).toBeTruthy();
    expect((await service.answer(repository, localization.id, { selectedIds: [expectedPath!] })).passed).toBe(true);
    const mismatch = await service.answer(repository, localization.id, { selectedIds: [expectedPath!, "src/main.js"] });
    expect(mismatch.passed).toBe(false);
    expect(mismatch.unexpectedIds).toContain("src/main.js");
  });

  it("generates impact and evidence-defense questions with automatic grading", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const impact = service.next(repository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
    const passedImpact = await service.answer(repository, impact.id, { selectedIds: ["src/config.js", "src/main.js"] });
    expect(passedImpact.passed).toBe(true);

    const defense = service.next(repository, { kind: "decision_defense" });
    const evidence = defense.options?.[0];
    expect(evidence).toBeTruthy();
    const defenseResult = await service.answer(repository, defense.id, { selectedIds: [evidence!.id], rationale: `这是直接证据：${evidence!.label}` });
    expect(defenseResult.gradingMode).toBe("rubric");
    expect(defenseResult.rubric).toHaveLength(3);
    expect(defenseResult.passed).toBe(true);
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
    const exercise = new ExerciseService().next(largeRepository, { kind: "impact_analysis", targetUnitId: "impact:src/config.js" });
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
    decisions: collectDecisionUnits(repositoryPath, index.files),
    implementations,
    quality: { generatedAt: "2026-01-01T00:00:00.000Z", micro: [], macro: [] },
    versionStamp: "content-v1"
  };
  return { path: repositoryPath, index, analysis };
}
