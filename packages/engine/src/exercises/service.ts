import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { Exercise, ExerciseAnswer, ExerciseFamily, ExerciseKind, ExerciseResult, ImplementationUnit, MasteryLevel, MasteryRecord, PracticeSummary, RepositoryAnalysis, RepositoryIndex, ReviewSchedule, RubricCriterion } from "@codebase-tutor/shared";
import { classifyModuleId, EXERCISE_KINDS, type SymbolInfo } from "@codebase-tutor/shared";
import type { LlmProvider } from "../llm/provider.js";
import { graphFromData, impactRadius } from "../depgraph/graph.js";
import { hash } from "../lib.js";
import { buildTagCandidate, EXERCISE_INPUT_VERSION, generateExerciseWithLlm, judgeRubricWithLlm, polishFeedbackWithLlm, refineExerciseWithLlm } from "./llm-generate.js";
import { guardLlmProposal, type GuardCandidate } from "./verify.js";
import { TutorDatabase } from "../store/database.js";
import { Journal, readJournal } from "../store/journal.js";
import { deriveMastery, selectZpdTarget, type ZpdTarget } from "./learner.js";
import { qualityForScore, scheduleSm2 } from "./sm2.js";

type ExpectedAnswer =
  | { type: "output"; expectedOutput: string; invocation: SafeInvocation }
  | { type: "set"; expectedIds: string[] }
  | { type: "rubric"; answerKey: string; criteria: RubricCriterion[] };

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

/**
  出题缓存的作用域（填进 `exercise_cache.content_version` 那一列）。

  失效轴 = **决定这道题内容的输入**，分两档：
  - 文件粒度（B1）：题面与标准答案只由目标文件决定时（output_prediction / change_localization / llm 族），
    作用域带目标文件自己的 `contentHash`——改无关文件不再让整仓出题重烧；
  - 全仓粒度：答案取决于整张依赖图的 impact_analysis，作用域仍用全仓 `versionStamp`
    （任一文件的 imports 变化都可能改答案，文件粒度在这里是假粒度）。

  两个轴对旧索引同样成立：文件没有 `contentHash`（升级前生成的索引）时以 `repo:<versionStamp>` 充当
  该文件的哈希——自动退化回全仓语义，不会出现「该失效没失效」。

  另外两个轴**换模型**（同一份代码在另一个模型上不是同一道题）、**改题面提示词**（口径版本）对两档都生效。
  注意这里只改缓存键：`exercise.contentVersion` 仍是真实的 `versionStamp`，展示与旧数据兼容靠它，
  作答校验走 `contentHashes`（见 `exerciseIsCurrent`）。
  静态题（output_prediction / change_localization / impact_analysis）的 id 只含**文件哈希部分**、
  不含模型与口径版本——标准答案与判分完全出自静态分析，换模型只换题面措辞，共用一个 id 不会串答案。
 */
function exerciseScope(versionStamp: string, modelVersion: string): string {
  return `${versionStamp}#${EXERCISE_INPUT_VERSION}#${modelVersion}`;
}

/** 文件粒度作用域的「文件部分」：path@hash 逗号串。id 与缓存作用域共用它，保证二者同生同灭。 */
function depsFingerprint(deps: { path: string; hash: string }[]): string {
  return deps.map((dep) => `${dep.path}@${dep.hash}`).join(",");
}

/** 一道题依赖的文件清单及其哈希。查不到 contentHash（旧索引）时以全仓 versionStamp 兜底。 */
function exerciseDeps(repository: PracticeRepository, kind: ExerciseKind, value: unknown): { path: string; hash: string }[] {
  const hashOf = (path: string): string => repository.index.files.find((file) => file.path === path)?.contentHash ?? `repo:${repository.analysis.versionStamp}`;
  if (kind === "impact_analysis") return [];
  const unit = value as ImplementationUnit;
  return [{ path: unit.symbol.path, hash: hashOf(unit.symbol.path) }];
}

/**
  作答时效校验：带 `contentHashes` 的新题逐文件核对，返回**已过期**的依赖清单（空 = 仍可用）——
  只有这道题依赖的文件变了才拒绝作答，无关文件的修改不打扰已有题目；
  旧题（无此字段）维持全仓 versionStamp 比对，过期时返回一个非路径占位符。
*/
function staleDependencies(repository: PracticeRepository, exercise: Exercise): string[] {
  if (exercise.contentHashes?.length) {
    const byPath = new Map(repository.index.files.map((file) => [file.path, file.contentHash]));
    return exercise.contentHashes.filter((dep) => byPath.get(dep.path) !== dep.hash).map((dep) => dep.path);
  }
  return exercise.contentVersion === repository.analysis.versionStamp ? [] : ["<仓库内容>"];
}

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
    family="llm" 走 LLM 出题族（tag 主题出题，一轮调用可拒绝，rubric 判分）。
    */
  async next(repository: PracticeRepository, requested: { kind?: ExerciseKind; targetUnitId?: string; moduleId?: string; moduleIds?: string[]; family?: ExerciseFamily; tag?: string; tagId?: string; variantNonce?: number } = {}, provider?: LlmProvider): Promise<Exercise> {
    const database = new TutorDatabase(repository.path);
    try {
      if (requested.family === "llm") return await this.nextLlm(repository, requested, provider, database);
      const modelVersion = provider?.modelVersion ?? "deterministic";
      if (!requested.kind && !requested.targetUnitId) {
        const due = database.getReviewSchedules(repository.index.repositoryId)
          .filter((schedule) => schedule.dueAt <= new Date().toISOString())
          .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
        for (const schedule of due) {
          const stored = database.getExerciseCacheById<StoredExercise>(repository.index.repositoryId, schedule.exerciseId);
          // 跳过旧版本缓存里已不再支持的题型（如已移除的选型辩护）；时效判定见 exerciseIsCurrent
          if (stored && EXERCISE_KINDS.includes(stored.exercise.kind) && !staleDependencies(repository, stored.exercise).length) return stored.exercise;
        }
      }
      const mastery = this.mastery(repository, database);
      const target = this.pickTarget(repository, requested, mastery);
      if (!target) {
        throw new Error(requested.moduleId
          ? "当前知识模块下没有可出题的代码单元；换一个模块，或先导入更多相关代码。"
          : "当前分析结果没有可生成的练习。请先重新导入仓库。");
      }
      // 文件粒度作用域：题面与答案由目标文件决定的题型按文件哈希失效；impact 答案取决于整张图，保持全仓
      const deps = exerciseDeps(repository, target.kind, target.value);
      const scope = deps.length
        ? `${depsFingerprint(deps)}#${EXERCISE_INPUT_VERSION}#${modelVersion}`
        : exerciseScope(repository.analysis.versionStamp, modelVersion);
      const cached = database.getExerciseCache<StoredExercise>(repository.index.repositoryId, scope, target.kind, target.id);
      if (cached) return cached.exercise;
      let stored = this.createExercise(repository, target.kind, target.value, target.difficulty, deps);
      if (provider) {
        const refined = await refineExerciseWithLlm(repository.path, stored.exercise, provider);
        stored = { ...stored, exercise: refined.exercise };
        if (refined.usage) new Journal(repository.path, repository.index.repositoryId).append("token_usage", {
          input_tokens: refined.usage.inputTokens,
          output_tokens: refined.usage.outputTokens,
          cache_hit_tokens: refined.usage.promptCacheHitTokens ?? null,
          provider: provider.modelVersion,
          scene: "exercise_generate"
        });
      }
      database.putExerciseCache(repository.index.repositoryId, scope, target.kind, target.id, stored);
      return stored.exercise;
    } finally {
      database.close();
    }
  }

  /**
    LLM 出题族：id = hash(repoId + 出题作用域 + tagId + variantNonce)，nonce=0 复用缓存题，
    换一题传 variantNonce+1 生成新题（旧题保留在缓存/复习记录里）。
    一轮调用内由 LLM 判定「能否出题」——拒绝理由与守门否决都记 journal（exercise_declined），不静默。
    */
  private async nextLlm(repository: PracticeRepository, requested: { tag?: string; tagId?: string; variantNonce?: number }, provider: LlmProvider | undefined, database: TutorDatabase): Promise<Exercise> {
    const tag = (requested.tag ?? "").trim();
    if (!tag) throw new Error("LLM 出题需要提供主题标签；请在「＋ 配置」里填写。");
    if (!provider) throw new Error("LLM 出题不可用：未配置 LLM 或本月预算已触顶。");
    const nonce = Math.max(0, Math.floor(requested.variantNonce ?? 0));
    const tagKey = (requested.tagId ?? "").trim() || tag;
    const targetUnitId = `llm:${tagKey}:${nonce}`;
    // 候选选择提前到缓存查找之前：题面与答案全出自模型看到的摘录，作用域要按候选文件自己的哈希算
    const summaries = new Map(database.getLatestFileSummaries().map((row) => [row.path, row.summary]));
    const candidates = selectTagCandidates(repository, tag, 3, summaries);
    if (!candidates.length) throw new Error(`没有找到与「${tag}」主题相关的源码文件；可换一个更贴近本仓库的主题标签，或在配置里补充业务 tag。`);
    const hashOf = (path: string): string => repository.index.files.find((file) => file.path === path)?.contentHash ?? `repo:${repository.analysis.versionStamp}`;
    const deps = candidates.map((candidate) => ({ path: candidate.path, hash: hashOf(candidate.path) }));
    const scope = `${depsFingerprint(deps)}#${EXERCISE_INPUT_VERSION}#${provider.modelVersion}`;
    const cached = database.getExerciseCache<StoredExercise>(repository.index.repositoryId, scope, "llm_rubric", targetUnitId);
    if (cached && cached.exercise.kind === "llm_rubric") return cached.exercise;
    const journal = new Journal(repository.path, repository.index.repositoryId);
    const generation = await generateExerciseWithLlm({ tag, candidates, provider });
    if (!generation.ok) {
      journal.append("exercise_declined", { tag, reason: generation.reason, stage: "llm_generate" });
      throw new Error(generation.reason);
    }
    if (generation.usage) journal.append("token_usage", {
      input_tokens: generation.usage.inputTokens,
      output_tokens: generation.usage.outputTokens,
      cache_hit_tokens: generation.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "exercise_llm_generate"
    });
    const issues = guardLlmProposal(generation.proposal, candidates);
    if (issues.length) {
      const reason = `LLM 出题未通过守门校验：${issues.map((issue) => issue.message).join("；")}。`;
      journal.append("exercise_declined", { tag, reason, stage: "guard" });
      throw new Error(reason);
    }
    const proposal = generation.proposal;
    const exercise: Exercise = {
      // id 里用 scope 而不是裸 versionStamp：LLM 题的题面与答案全出自模型，换模型就是另一道题，
      // 两者不能共用一个 id（判分与复习排期都按 id 回查缓存行）。
      id: `exercise:${hash(`${repository.index.repositoryId}:${scope}:llm_rubric:${targetUnitId}`).slice(0, 20)}`,
      repositoryId: repository.index.repositoryId,
      contentVersion: repository.analysis.versionStamp,
      ...(deps.length ? { contentHashes: deps } : {}),
      kind: "llm_rubric",
      targetUnitId,
      targetTitle: proposal.targetTitle || tag,
      difficulty: 3,
      title: proposal.title,
      prompt: proposal.prompt,
      anchors: proposal.anchors.map((anchor) => ({ path: anchor.path, line: anchor.line, endLine: anchor.endLine, label: "主题相关代码" })),
      inputMode: "open",
      gradingMode: "rubric",
      family: "llm",
      tag,
      createdAt: new Date().toISOString()
    };
    const stored: StoredExercise = { exercise, expected: { type: "rubric", answerKey: proposal.answerKey, criteria: proposal.criteria } };
    database.putExerciseCache(repository.index.repositoryId, scope, "llm_rubric", targetUnitId, stored);
    return exercise;
  }

  async answer(repository: PracticeRepository, exerciseId: string, answer: ExerciseAnswer, provider?: LlmProvider): Promise<ExerciseResult> {
    const database = new TutorDatabase(repository.path);
    try {
      const stored = database.getExerciseCacheById<StoredExercise>(repository.index.repositoryId, exerciseId);
      if (!stored) throw new Error("练习不存在或已被清理；请重新生成练习。");
      const stale = staleDependencies(repository, stored.exercise);
      if (stale.length) throw new Error(`这道题依赖的源码已更新（${stale.join("、")}）；请使用新版本重新生成练习。`);
      const journal = new Journal(repository.path, repository.index.repositoryId);
      let graded = stored.expected.type === "rubric"
        ? await gradeRubric(stored, answer, provider)
        : await grade(stored, answer);
      // 程序理解题（规则判分）：反馈解释交 LLM 润色；润色失败保留规则原文并显式标注 feedbackSource="rule"。
      if (provider && graded.automatic) {
        const learnerAnswer = answer.text?.trim() || (answer.selectedIds ?? []).join(", ");
        const polished = await polishFeedbackWithLlm({ repositoryPath: repository.path, exercise: stored.exercise, learnerAnswer, graded, provider });
        if (polished) {
          graded = { ...graded, feedback: polished.feedback, feedbackSource: "llm_polished" };
          if (polished.usage) journal.append("token_usage", {
            input_tokens: polished.usage.inputTokens,
            output_tokens: polished.usage.outputTokens,
            cache_hit_tokens: polished.usage.promptCacheHitTokens ?? null,
            provider: provider.modelVersion,
            scene: "exercise_feedback_polish"
          });
        }
      }
      const now = new Date();
      const previous = database.getReviewSchedule(repository.index.repositoryId, exerciseId);
      const review = scheduleSm2(previous, qualityForScore(graded.score), now);
      review.exerciseId = exerciseId;
      review.unitId = stored.exercise.targetUnitId;
      database.saveReviewSchedule(repository.index.repositoryId, review);
      journal.append("exercise_result", {
        exercise_id: exerciseId,
        target_unit_id: stored.exercise.targetUnitId,
        kind: stored.exercise.kind,
        score: graded.score,
        passed: graded.passed,
        grading_mode: stored.exercise.gradingMode,
        generation_source: stored.exercise.family === "llm" ? "llm_proposed" : "static",
        feedback_source: graded.feedbackSource ?? "rule"
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

  private createExercise(repository: PracticeRepository, kind: ExerciseKind, value: unknown, difficulty: MasteryLevel, deps: { path: string; hash: string }[]): StoredExercise {
    if (kind === "output_prediction") return outputExercise(repository, value as ImplementationUnit, difficulty, deps);
    if (kind === "change_localization") return localizationExercise(repository, value as ImplementationUnit, difficulty, deps);
    if (kind === "impact_analysis") return impactExercise(repository, value as string, difficulty);
    throw new Error("不支持的练习题型");
  }
}

function outputExercise(repository: PracticeRepository, unit: ImplementationUnit, difficulty: MasteryLevel, deps: { path: string; hash: string }[]): StoredExercise {
  const invocation = safeInvocationFor(repository.path, unit);
  if (!invocation) throw new Error("该实现不满足受限执行验证条件。");
  const expectedOutput = executeSafeInvocation(invocation);
  const exercise = baseExercise(repository, "output_prediction", unit.id, unit.symbol.name, difficulty, deps, {
    title: "预测函数输出",
    prompt: `阅读 ${unit.symbol.path}:${unit.symbol.line} 的 ${unit.symbol.name}。当 ${formatArguments(unit.symbol.parameters, invocation.args)} 时，它返回什么？只填写返回值。`,
    anchors: [{ path: unit.symbol.path, line: unit.symbol.line, endLine: unit.symbol.endLine, label: "函数实现" }],
    inputMode: "text",
    gradingMode: "execution"
  });
  return { exercise, expected: { type: "output", expectedOutput, invocation } };
}

function localizationExercise(repository: PracticeRepository, unit: ImplementationUnit, difficulty: MasteryLevel, deps: { path: string; hash: string }[]): StoredExercise {
  const options = sourceOptions(repository, [unit.symbol.path]);
  const exercise = baseExercise(repository, "change_localization", unit.id, unit.symbol.name, difficulty, deps, {
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
  const exercise = baseExercise(repository, "impact_analysis", `impact:${changedPath}`, changedPath, difficulty, [], {
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

function baseExercise(repository: PracticeRepository, kind: ExerciseKind, targetUnitId: string, targetTitle: string, difficulty: MasteryLevel, deps: { path: string; hash: string }[], input: Pick<Exercise, "title" | "prompt" | "anchors" | "inputMode" | "gradingMode" | "options">): Exercise {
  // id 只含文件哈希部分（不含模型/口径版本）：静态题的答案出自静态分析，换模型只换题面措辞，共用 id 不串答案；
  // deps 为空（impact_analysis / 旧索引兜底）时沿用全仓 versionStamp 的旧 id 形状
  const idBase = deps.length ? depsFingerprint(deps) : repository.analysis.versionStamp;
  const id = `exercise:${hash(`${repository.index.repositoryId}:${idBase}:${kind}:${targetUnitId}`).slice(0, 20)}`;
  return {
    id, repositoryId: repository.index.repositoryId, contentVersion: repository.analysis.versionStamp,
    ...(deps.length ? { contentHashes: deps } : {}),
    kind, targetUnitId, targetTitle, difficulty, createdAt: new Date().toISOString(), ...input
  };
}

type GradeOutcome = Omit<ExerciseResult, "exerciseId" | "repositoryId" | "targetUnitId" | "kind" | "gradingMode" | "reviewedAt" | "review">;

async function grade(stored: StoredExercise, answer: ExerciseAnswer): Promise<GradeOutcome> {
  if (stored.expected.type === "output") {
    const expected = executeSafeInvocation(stored.expected.invocation);
    const passed = normalizeOutput(answer.text) === normalizeOutput(expected);
    return { score: passed ? 1 : 0, passed, automatic: true, feedbackSource: "rule", feedback: passed ? "执行验证通过：返回值与受限运行结果一致。" : "执行验证未通过：请沿着返回表达式重新检查输入如何流动。" };
  }
  if (stored.expected.type === "set") return gradeSet(stored.expected.expectedIds, answer.selectedIds ?? []);
  throw new Error("该练习类型已不再支持；请重新生成练习。");
}

/** rubric 判分（LLM 族）：LLM 拿参考答案与评分细则比对学习者回答；结果 automatic=false，绝不冒充确定性判分。 */
async function gradeRubric(stored: StoredExercise, answer: ExerciseAnswer, provider: LlmProvider | undefined): Promise<GradeOutcome> {
  if (!provider) throw new Error("rubric 判分需要 LLM；当前未配置 LLM 或本月预算已触顶。");
  const learnerAnswer = (answer.text ?? "").trim();
  if (!learnerAnswer) {
    return { score: 0, passed: false, automatic: false, feedbackSource: "llm_judge", feedback: "回答为空；请写下你的分析后再提交。" };
  }
  const expected = stored.expected as Extract<ExpectedAnswer, { type: "rubric" }>;
  const judged = await judgeRubricWithLlm({
    prompt: stored.exercise.prompt,
    answerKey: expected.answerKey,
    criteria: expected.criteria,
    learnerAnswer,
    provider
  });
  return { score: judged.score, passed: judged.passed, automatic: false, feedbackSource: "llm_judge", feedback: judged.feedback };
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
    feedbackSource: "rule",
    feedback: passed ? "集合匹配通过：选择与依赖/实现答案完全一致。" : "集合不完全匹配：补齐遗漏项，并排除不在当前证据范围内的文件。",
    matchedIds,
    missingIds,
    unexpectedIds
  };
}

/**
  规则侧候选选择：按主题标签的词元对文件路径与文件内符号名打分（路径命中 30 / 符号命中 20 / 热点 ≤10），
  取前 3 个文件构造带行号的摘录交给 LLM。相关性不足时 LLM 会在出题轮内拒绝——这里是「有素材可给」，不是「保证可出题」。
  */
function selectTagCandidates(repository: PracticeRepository, tag: string, limit = 3, summaries: Map<string, string> = new Map()): GuardCandidate[] {
  const lowered = tag.toLowerCase();
  const tokens = [...new Set([lowered, ...lowered.split(/[\s,，、/·:：_-]+/).filter((token) => token.length >= 2)])];
  const symbolsByPath = new Map<string, SymbolInfo[]>();
  for (const symbol of repository.analysis.graph.symbols) {
    const list = symbolsByPath.get(symbol.path) ?? [];
    list.push(symbol);
    symbolsByPath.set(symbol.path, list);
  }
  const hotspots = new Map(repository.index.hotspots.map((hotspot) => [hotspot.path, hotspot.changes]));
  const scored = repository.index.files
    .filter((file) => /\.(?:[cm]?[jt]sx?|py|java)$/.test(file.path))
    .map((file) => {
      const path = file.path;
      const symbols = (symbolsByPath.get(path) ?? []).map((symbol) => symbol.name.toLowerCase()).join(" ");
      const summary = (summaries.get(path) ?? "").toLowerCase();
      // 相关性闸门：路径/符号/摘要任一命中才算候选——旧版零相关时按热点兜底塞文件，正是「候选与主题无关」的来源
      let matches = 0;
      let score = 0;
      for (const token of tokens) {
        if (path.toLowerCase().includes(token)) { score += 30; matches += 1; }
        if (symbols.includes(token)) { score += 20; matches += 1; }
        if (summary.includes(token)) { score += 15; matches += 1; }
      }
      if (matches) score += Math.min(hotspots.get(path) ?? 0, 10);
      return { path, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
  return scored.flatMap(({ path }) => {
    const candidate = buildTagCandidate(repository.path, path, 80, windowOffset(symbolsByPath.get(path) ?? [], tokens));
    return candidate ? [candidate] : [];
  });
}

/** 摘录窗口起点：名字命中任一词元的符号里取分最高者（同分取更靠前的），从其起始行开窗；无命中回落第 1 行。 */
function windowOffset(symbols: SymbolInfo[], tokens: string[]): number {
  let best: { score: number; line: number } | undefined;
  for (const symbol of symbols) {
    const name = symbol.name.toLowerCase();
    const score = tokens.reduce((total, token) => total + (name.includes(token) ? 1 : 0), 0);
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && symbol.line < best.line)) best = { score, line: symbol.line };
  }
  return best ? Math.max(1, best.line) : 1;
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
