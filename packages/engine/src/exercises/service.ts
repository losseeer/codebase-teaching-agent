import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { Exercise, ExerciseAnswer, ExerciseKind, ExerciseResult, ImplementationUnit, MasteryLevel, MasteryRecord, PracticeSummary, RepositoryAnalysis, RepositoryIndex, ReviewSchedule } from "@codebase-tutor/shared";
import { classifyModuleId, EXERCISE_KINDS } from "@codebase-tutor/shared";
import type { LlmProvider } from "../llm/provider.js";
import { graphFromData, impactRadius } from "../depgraph/graph.js";
import { hash } from "../lib.js";
import { refineExerciseWithLlm } from "./llm-generate.js";
import { TutorDatabase } from "../store/database.js";
import { Journal, readJournal } from "../store/journal.js";
import { deriveMastery, selectZpdTarget, type ZpdTarget } from "./learner.js";
import { qualityForScore, scheduleSm2 } from "./sm2.js";

type ExpectedAnswer =
  | { type: "output"; expectedOutput: string; invocation: SafeInvocation }
  | { type: "set"; expectedIds: string[] };

interface StoredExercise {
  exercise: Exercise;
  expected: ExpectedAnswer;
}

interface SafeInvocation {
  parameters: string[];
  expression: string;
  args: unknown[];
}

type PracticeTarget<T> = ZpdTarget<T> & { kind: ExerciseKind };

export interface PracticeRepository {
  path: string;
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
}

const kinds: ExerciseKind[] = EXERCISE_KINDS;

export class ExerciseService {
  getSummary(repository: PracticeRepository): PracticeSummary {
    const database = new TutorDatabase(repository.path);
    const mastery = this.mastery(repository, database);
    const dueReviews = database.getReviewSchedules(repository.index.repositoryId).filter((schedule) => schedule.dueAt <= new Date().toISOString()).length;
    database.close();
    return { repositoryId: repository.index.repositoryId, contentVersion: repository.analysis.versionStamp, dueReviews, mastery };
  }

  /**
    生成练习：目标单元与标准答案始终由静态分析产出（可判分）；
    传入 provider 时对题面 title/prompt 做一轮 LLM 润色（失败/未配置则用启发式题面）。
    */
  async next(repository: PracticeRepository, requested: { kind?: ExerciseKind; targetUnitId?: string; moduleId?: string; moduleIds?: string[] } = {}, provider?: LlmProvider): Promise<Exercise> {
    const database = new TutorDatabase(repository.path);
    try {
      if (!requested.kind && !requested.targetUnitId) {
        const due = database.getReviewSchedules(repository.index.repositoryId)
          .filter((schedule) => schedule.dueAt <= new Date().toISOString())
          .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
        for (const schedule of due) {
          const stored = database.getExerciseCacheById<StoredExercise>(repository.index.repositoryId, schedule.exerciseId);
          // 跳过旧版本缓存里已不再支持的题型（如已移除的选型辩护）
          if (stored && EXERCISE_KINDS.includes(stored.exercise.kind) && stored.exercise.contentVersion === repository.analysis.versionStamp) return stored.exercise;
        }
      }
      const mastery = this.mastery(repository, database);
      const target = this.pickTarget(repository, requested, mastery);
      if (!target) {
        throw new Error(requested.moduleId
          ? "当前知识模块下没有可出题的代码单元；换一个模块，或先导入更多相关代码。"
          : "当前分析结果没有可生成的练习。请先重新导入仓库。");
      }
      const cached = database.getExerciseCache<StoredExercise>(repository.index.repositoryId, repository.analysis.versionStamp, target.kind, target.id);
      if (cached) return cached.exercise;
      let stored = this.createExercise(repository, target.kind, target.value, target.difficulty);
      if (provider) {
        const refined = await refineExerciseWithLlm(repository.path, stored.exercise, provider);
        stored = { ...stored, exercise: refined.exercise };
        if (refined.usage) new Journal(repository.path, repository.index.repositoryId).append("token_usage", {
          input_tokens: refined.usage.inputTokens,
          output_tokens: refined.usage.outputTokens,
          provider: provider.modelVersion,
          scene: "exercise_generate"
        });
      }
      database.putExerciseCache(repository.index.repositoryId, repository.analysis.versionStamp, target.kind, target.id, stored);
      return stored.exercise;
    } finally {
      database.close();
    }
  }

  async answer(repository: PracticeRepository, exerciseId: string, answer: ExerciseAnswer): Promise<ExerciseResult> {
    const database = new TutorDatabase(repository.path);
    try {
      const stored = database.getExerciseCacheById<StoredExercise>(repository.index.repositoryId, exerciseId);
      if (!stored) throw new Error("练习不存在或已被清理；请重新生成练习。");
      if (stored.exercise.contentVersion !== repository.analysis.versionStamp) throw new Error("仓库内容已更新，请使用新版本生成的练习。");
      const graded = await grade(stored, answer);
      const now = new Date();
      const previous = database.getReviewSchedule(repository.index.repositoryId, exerciseId);
      const review = scheduleSm2(previous, qualityForScore(graded.score), now);
      review.exerciseId = exerciseId;
      review.unitId = stored.exercise.targetUnitId;
      database.saveReviewSchedule(repository.index.repositoryId, review);
      const journal = new Journal(repository.path, repository.index.repositoryId);
      journal.append("exercise_result", {
        exercise_id: exerciseId,
        target_unit_id: stored.exercise.targetUnitId,
        kind: stored.exercise.kind,
        score: graded.score,
        passed: graded.passed,
        grading_mode: stored.exercise.gradingMode
      });
      journal.append("unassisted_test", {
        unit_id: stored.exercise.targetUnitId,
        exercise_id: exerciseId,
        passed: graded.passed,
        score: graded.score,
        minutes: 0
      });
      const mastery = this.mastery(repository, database);
      mastery.find((record) => record.unitId === stored.exercise.targetUnitId) && database.saveMastery(repository.index.repositoryId, mastery.find((record) => record.unitId === stored.exercise.targetUnitId)!);
      return { ...graded, exerciseId, repositoryId: repository.index.repositoryId, targetUnitId: stored.exercise.targetUnitId, kind: stored.exercise.kind, gradingMode: stored.exercise.gradingMode, reviewedAt: now.toISOString(), review };
    } finally {
      database.close();
    }
  }

  private mastery(repository: PracticeRepository, database: TutorDatabase): MasteryRecord[] {
    const fromJournal = deriveMastery(readJournal(repository.path));
    const records = fromJournal.length ? fromJournal : database.getMastery(repository.index.repositoryId);
    for (const record of records) database.saveMastery(repository.index.repositoryId, record);
    return records;
  }

  private pickTarget(repository: PracticeRepository, requested: { kind?: ExerciseKind; targetUnitId?: string; moduleId?: string; moduleIds?: string[] }, mastery: MasteryRecord[]): PracticeTarget<unknown> | undefined {
    const availableKinds = requested.kind ? [requested.kind] : kinds;
    const attemptCount = mastery.reduce((sum, record) => sum + record.attempts, 0);
    const orderedKinds = requested.kind ? availableKinds : [...availableKinds.slice(attemptCount % availableKinds.length), ...availableKinds.slice(0, attemptCount % availableKinds.length)];
    for (const kind of orderedKinds) {
      const targets = this.targets(repository, kind, requested.moduleId, requested.moduleIds ?? []);
      const restricted = requested.targetUnitId ? targets.filter((target) => target.id === requested.targetUnitId) : targets;
      if (requested.targetUnitId && restricted.length) return restricted[0];
      const selected = selectZpdTarget(restricted, mastery) as PracticeTarget<unknown> | undefined;
      if (selected) return selected;
    }
    return undefined;
  }

  private targets(repository: PracticeRepository, kind: ExerciseKind, moduleId?: string, moduleIds: string[] = []): PracticeTarget<unknown>[] {
    const inModule = (text: string): boolean => !moduleId || classifyModuleId(text, moduleIds) === moduleId;
    if (kind === "output_prediction") {
      return repository.analysis.implementations
        .filter((unit) => inModule(`${unit.symbol.path} ${unit.symbol.name}`))
        .flatMap((unit) => safeInvocationFor(repository.path, unit) ? [{ id: unit.id, title: unit.symbol.name, difficulty: unitDifficulty(unit), value: unit, kind }] : []);
    }
    if (kind === "change_localization") {
      return repository.analysis.implementations
        .filter((unit) => inModule(`${unit.symbol.path} ${unit.symbol.name}`))
        .map((unit) => ({ id: unit.id, title: unit.symbol.name, difficulty: unitDifficulty(unit), value: unit, kind }));
    }
    if (kind === "impact_analysis") {
      const graph = graphFromData(repository.analysis.graph);
      return Object.keys(repository.analysis.graph.imports)
        .filter((path) => inModule(path))
        .map((path) => {
          const impact = impactRadius(graph, [path]);
          return { id: `impact:${path}`, title: path, difficulty: Math.min(5, Math.max(1, impact.impactedPaths.length)) as MasteryLevel, value: path, kind };
        });
    }
    return [];
  }

  private createExercise(repository: PracticeRepository, kind: ExerciseKind, value: unknown, difficulty: MasteryLevel): StoredExercise {
    if (kind === "output_prediction") return outputExercise(repository, value as ImplementationUnit, difficulty);
    if (kind === "change_localization") return localizationExercise(repository, value as ImplementationUnit, difficulty);
    if (kind === "impact_analysis") return impactExercise(repository, value as string, difficulty);
    throw new Error("不支持的练习题型");
  }
}

function outputExercise(repository: PracticeRepository, unit: ImplementationUnit, difficulty: MasteryLevel): StoredExercise {
  const invocation = safeInvocationFor(repository.path, unit);
  if (!invocation) throw new Error("该实现不满足受限执行验证条件。");
  const expectedOutput = executeSafeInvocation(invocation);
  const exercise = baseExercise(repository, "output_prediction", unit.id, unit.symbol.name, difficulty, {
    title: "预测函数输出",
    prompt: `阅读 ${unit.symbol.path}:${unit.symbol.line} 的 ${unit.symbol.name}。当 ${formatArguments(unit.symbol.parameters, invocation.args)} 时，它返回什么？只填写返回值。`,
    anchors: [{ path: unit.symbol.path, line: unit.symbol.line, endLine: unit.symbol.endLine, label: "函数实现" }],
    inputMode: "text",
    gradingMode: "execution"
  });
  return { exercise, expected: { type: "output", expectedOutput, invocation } };
}

function localizationExercise(repository: PracticeRepository, unit: ImplementationUnit, difficulty: MasteryLevel): StoredExercise {
  const options = sourceOptions(repository, [unit.symbol.path]);
  const exercise = baseExercise(repository, "change_localization", unit.id, unit.symbol.name, difficulty, {
    title: "定位行为修改",
    prompt: `需要修改 ${unit.symbol.name} 的局部行为，但不改变它的调用接口。请选择必须首先修改的源码文件。`,
    anchors: [{ path: unit.symbol.path, line: unit.symbol.line, endLine: unit.symbol.endLine, label: "实现定义" }],
    inputMode: "multi_select",
    gradingMode: "set_match",
    options
  });
  return { exercise, expected: { type: "set", expectedIds: [unit.symbol.path] } };
}

function impactExercise(repository: PracticeRepository, changedPath: string, difficulty: MasteryLevel): StoredExercise {
  const result = impactRadius(graphFromData(repository.analysis.graph), [changedPath]);
  const reviewPaths = prioritizedImpactPaths(result, changedPath);
  const isLargeImpact = reviewPaths.length < result.impactedPaths.length;
  const exercise = baseExercise(repository, "impact_analysis", `impact:${changedPath}`, changedPath, difficulty, {
    title: "分析变更影响",
    prompt: isLargeImpact
      ? `假设 ${changedPath} 的导出行为发生改变。影响范围较大；根据当前依赖图，选择应优先复查的第一批本地源码文件（包含变更文件本身）。`
      : `假设 ${changedPath} 的导出行为发生改变。根据当前依赖图，选择需要复查的全部本地源码文件（包含变更文件本身）。`,
    anchors: [{ path: changedPath, line: 1, label: "变更起点" }],
    inputMode: "multi_select",
    gradingMode: "set_match",
    options: sourceOptions(repository, reviewPaths)
  });
  return { exercise, expected: { type: "set", expectedIds: reviewPaths } };
}

function baseExercise(repository: PracticeRepository, kind: ExerciseKind, targetUnitId: string, targetTitle: string, difficulty: MasteryLevel, input: Pick<Exercise, "title" | "prompt" | "anchors" | "inputMode" | "gradingMode" | "options">): Exercise {
  const id = `exercise:${hash(`${repository.index.repositoryId}:${repository.analysis.versionStamp}:${kind}:${targetUnitId}`).slice(0, 20)}`;
  return { id, repositoryId: repository.index.repositoryId, contentVersion: repository.analysis.versionStamp, kind, targetUnitId, targetTitle, difficulty, createdAt: new Date().toISOString(), ...input };
}

type GradeOutcome = Omit<ExerciseResult, "exerciseId" | "repositoryId" | "targetUnitId" | "kind" | "gradingMode" | "reviewedAt" | "review">;

async function grade(stored: StoredExercise, answer: ExerciseAnswer): Promise<GradeOutcome> {
  if (stored.expected.type === "output") {
    const expected = executeSafeInvocation(stored.expected.invocation);
    const passed = normalizeOutput(answer.text) === normalizeOutput(expected);
    return { score: passed ? 1 : 0, passed, automatic: true, feedback: passed ? "执行验证通过：返回值与受限运行结果一致。" : "执行验证未通过：请沿着返回表达式重新检查输入如何流动。" };
  }
  if (stored.expected.type === "set") return gradeSet(stored.expected.expectedIds, answer.selectedIds ?? []);
  throw new Error("该练习类型已不再支持；请重新生成练习。");
}

function gradeSet(expected: string[], selected: string[]): GradeOutcome {
  const expectedSet = new Set(expected);
  const selectedSet = new Set(selected);
  const matchedIds = expected.filter((id) => selectedSet.has(id));
  const missingIds = expected.filter((id) => !selectedSet.has(id));
  const unexpectedIds = [...selectedSet].filter((id) => !expectedSet.has(id)).sort();
  const passed = missingIds.length === 0 && unexpectedIds.length === 0;
  const score = expected.length ? matchedIds.length / (matchedIds.length + missingIds.length + unexpectedIds.length) : 1;
  return {
    score,
    passed,
    automatic: true,
    feedback: passed ? "集合匹配通过：选择与依赖/实现答案完全一致。" : "集合不完全匹配：补齐遗漏项，并排除不在当前证据范围内的文件。",
    matchedIds,
    missingIds,
    unexpectedIds
  };
}

function safeInvocationFor(repositoryPath: string, unit: ImplementationUnit): SafeInvocation | undefined {
  if (unit.symbol.language !== "typescript") return undefined;
  const parameters = unit.symbol.parameters;
  if (parameters.some((parameter) => !/^[A-Za-z_$][\w$]*$/.test(parameter))) return undefined;
  const source = readFileSync(join(repositoryPath, unit.symbol.path), "utf8").split("\n").slice(unit.symbol.line - 1, unit.symbol.endLine).join("\n");
  const opening = source.indexOf("{");
  const closing = source.lastIndexOf("}");
  const body = opening >= 0 && closing > opening ? source.slice(opening + 1, closing).trim() : "";
  const match = body.match(/^return\s+(.+?);?\s*$/s);
  if (!match || !safeExpression(match[1], parameters)) return undefined;
  return { parameters, expression: match[1].replace(/;\s*$/, "").trim(), args: parameters.map((parameter) => parameter === "environment" ? { GREETING: "practice" } : "practice") };
}

function safeExpression(expression: string, parameters: string[]): boolean {
  if (expression.length > 240 || /(?:\b(?:process|globalThis|require|import|eval|Function|constructor|prototype|__proto__|new|await|throw|while|for|fetch|setTimeout)\b|[;{}])/i.test(expression)) return false;
  if (/\b[A-Za-z_$][\w$]*\s*\(/.test(expression)) return false;
  const terms = expression.split(/\s*(?:\|\||\?\?)\s*/);
  return terms.every((term) => /^(["'][^"']*["']|`[^`$]*`|true|false|null|undefined|-?\d+(?:\.\d+)?|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.test(term.trim()) && (isLiteral(term.trim()) || parameters.some((parameter) => term.trim() === parameter || term.trim().startsWith(`${parameter}.`))));
}

function executeSafeInvocation(invocation: SafeInvocation): string {
  const parameters = invocation.parameters.join(", ");
  const program = `const args = ${JSON.stringify(invocation.args)}; const exerciseTarget = (${parameters}) => (${invocation.expression}); const result = exerciseTarget(...args); process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));`;
  const execution = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "--eval", program], { encoding: "utf8", timeout: 1_500, maxBuffer: 4_096, env: { PATH: process.env.PATH ?? "" } });
  if (execution.status !== 0 || execution.error || execution.signal) throw new Error("受限输出验证未能完成");
  return execution.stdout.trim();
}

function prioritizedImpactPaths(result: ReturnType<typeof impactRadius>, changedPath: string, limit = 4): string[] {
  const directDependents = result.edges.filter((edge) => edge.to === changedPath).map((edge) => edge.from).sort();
  return [...new Set([changedPath, ...directDependents, ...result.impactedPaths])].slice(0, limit);
}

function sourceOptions(repository: PracticeRepository, preferredPaths: string[], limit = 8) {
  const sourcePaths = repository.index.files.filter((file) => /\.(?:[cm]?[jt]sx?|py)$/.test(file.path)).map((file) => file.path);
  const available = new Set(sourcePaths);
  const preferred = [...new Set(preferredPaths)].filter((path) => available.has(path)).slice(0, limit);
  const preferredSet = new Set(preferred);
  const related = relatedPaths(repository, preferred);
  const preferredDirectories = preferred.map((path) => dirname(path));
  const hotspots = new Map(repository.index.hotspots.map((hotspot) => [hotspot.path, hotspot.changes]));
  const candidates = sourcePaths.filter((path) => !preferredSet.has(path)).map((path) => ({
    path,
    score: relevanceScore(path, preferredDirectories, related, hotspots)
  })).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return [...preferred, ...candidates.slice(0, Math.max(0, limit - preferred.length)).map((candidate) => candidate.path)]
    .map((path) => ({ id: path, label: path }));
}

function relatedPaths(repository: PracticeRepository, preferred: string[]): Set<string> {
  const related = new Set<string>();
  for (const path of preferred) {
    for (const dependency of repository.analysis.graph.imports[path] ?? []) related.add(dependency);
    for (const [candidate, dependencies] of Object.entries(repository.analysis.graph.imports)) if (dependencies.includes(path)) related.add(candidate);
  }
  return related;
}

function relevanceScore(path: string, preferredDirectories: string[], related: Set<string>, hotspots: Map<string, number>): number {
  const directory = dirname(path);
  const sameDirectory = preferredDirectories.includes(directory) ? 60 : 0;
  const sameTopLevel = preferredDirectories.some((preferred) => preferred.split("/")[0] === directory.split("/")[0]) ? 15 : 0;
  return sameDirectory + sameTopLevel + (related.has(path) ? 45 : 0) + Math.min(hotspots.get(path) ?? 0, 10);
}

function unitDifficulty(unit: ImplementationUnit): MasteryLevel {
  const explicitGuards = unit.invariants.filter((item) => !item.startsWith("源码中未检测")).length;
  const explicitBoundaries = unit.boundaries.filter((item) => !item.startsWith("未检测")).length;
  const complexity = unit.symbol.parameters.length + explicitGuards + explicitBoundaries + unit.traps.length + Math.ceil((unit.symbol.referenceCount ?? 0) / 4);
  return Math.max(1, Math.min(5, 1 + Math.floor(complexity / 2))) as MasteryLevel;
}

function formatArguments(parameters: string[], args: unknown[]): string {
  return parameters.length ? parameters.map((parameter, index) => `${parameter} = ${JSON.stringify(args[index])}`).join("，") : "不传入参数";
}

function normalizeOutput(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/\r\n/g, "\n");
  return /^(["'])(.*)\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function isLiteral(value: string): boolean {
  return /^(?:["'][^"']*["']|`[^`$]*`|true|false|null|undefined|-?\d+(?:\.\d+)?)$/.test(value);
}
