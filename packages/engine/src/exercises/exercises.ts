import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AttemptKind,
  Exercise,
  ExerciseAnswer,
  ExerciseBankEntry,
  ExerciseFamily,
  ExerciseKind,
  ExerciseLanguage,
  ExerciseResult,
  ImplementationUnit,
  MasteryLevel,
  MasteryRecord,
  PracticeSummary,
  RepositoryAnalysis,
  RepositoryIndex,
  RubricCriterion
} from "@codebase-tutor/domain";
import { EXERCISE_TYPE_KINDS, exerciseTypeOf, type ExerciseType, type SymbolInfo } from "@codebase-tutor/domain";

import type { LlmProvider } from "../application/port/llm-provider.js";
import type { ExerciseFaces, ExerciseProgressSink } from "./turn-faces.js";
import { fileReadAuditPayload } from "../source/read-file.js";
import { buildSearchCorpus } from "../source/search-code.js";
import { skillReadAuditPayload } from "../source/tools/types.js";
import { graphFromData, handledExtensions, impactRadius } from "@codebase-tutor/analysis";
import { hash, traceEngine } from "@codebase-tutor/platform";
import { buildTagCandidate, EXERCISE_STEP, generateExerciseWithLlm, judgeRubricWithLlm, polishFeedbackWithLlm, refineExerciseWithLlm } from "./llm-generate.js";
import { NO_TOPICS, topicIndex } from "./topic-tiers.js";
import { DEFAULT_EXERCISE_STRATEGY, exerciseStrategyOf } from "./exercise-strategy.js";
import { buildPointIndex, type LandingContext } from "./exam-points.js";
import { examPlanBrief, judgeThemeLandings, loadPointTiers, themeWithLandings, type JudgeResult } from "./exam-plan.js";
import { excerptClues, mechanismCandidate, tagTokens } from "./mechanism-surface.js";
import { explainCodeAttempt, generateCodeExercise, generateCodeExerciseFromReference, verdictOf, type CodeFile, type CodeGeneration } from "./code-generate.js";
import { generateCodeExerciseSegmented, segmentedExerciseEnabled } from "./code-generate-segmented.js";
import { guardLlmProposal, type GuardCandidate } from "./guard-proposal.js";
import { ensureIsolation, runSandbox } from "../adapter/outbound/sandbox/isolation.js";
import { resolveToolchain, runnerFingerprint } from "../adapter/outbound/sandbox/profile.js";
import type { ExercisePorts } from "../application/port/exercise-ports.js";
import { ExerciseDeclinedError } from "../application/port/exercise-decline.js";
import type { AuditSink } from "../application/port/audit-sink.js";
import { selectZpdTarget, type ZpdTarget } from "./zpd.js";
import { qualityForScore, scheduleSm2 } from "./sm2.js";

const isCodeKind = (kind: ExerciseKind): boolean => exerciseTypeOf(kind) === "design";
/** 族别沿用 journal 与旧缓存的 comprehension/code/llm 词表。 */
const familyOf = (kind: ExerciseKind): ExerciseFamily => isCodeKind(kind) ? "code" : exerciseTypeOf(kind) === "analysis" ? "llm" : "comprehension";
/** 主题筛目标的命中文件上限；比发给模型的 3 个宽。 */
const THEME_FILES = 12;

type ExpectedAnswer =
  | { type: "set"; expectedIds: string[] }
  | { type: "rubric"; answerKey: string; criteria: RubricCriterion[] }
  /** 出题时冻结的判分文件；`hidden` 与 `solution` 都不下发。 */
  | { type: "harness"; language: ExerciseLanguage; entry: string; hidden: CodeFile[]; solution: CodeFile[]; defect: string };

interface StoredExercise {
  exercise: Exercise;
  expected: ExpectedAnswer;
  /** 题面来源：`llm` 改写成功 / `failed` 回落启发式 / `not_configured` 没配模型；缺省读作 unknown。 */
  polish?: "llm" | "failed" | "not_configured";
  /** 失败形状（`no_excerpt` / `unparsable` / `provider_error`），跟着缓存行存。 */
  polishFailure?: string | null;
}

type PracticeTarget<T> = ZpdTarget<T> & { kind: ExerciseKind };

export interface PracticeRepository {
  path: string;
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
  ports: ExercisePorts;
}

/** 不点题型时的轮换范围；分析题必须带主题，不进兜底。 */
const kinds: ExerciseKind[] = [...EXERCISE_TYPE_KINDS.comprehension, ...EXERCISE_TYPE_KINDS.design];

/** 出题缓存的作用域（填进 `exercise_cache.content_version`）。 */
function exerciseScope(versionStamp: string, modelVersion: string, graphStamp: string): string {
  // 模型档与题面口径版本对两档都生效；图指纹只对全仓那一档。
  return `${versionStamp}#${graphStamp}#${EXERCISE_STEP.contractVersion}#${modelVersion}`;
}

/** 图指纹：import 边 + 调用边 + 派发边排序后哈希；不含行号与符号。 */
const graphStamps = new WeakMap<RepositoryAnalysis, string>();
function graphStampOf(analysis: RepositoryAnalysis): string {
  const memo = graphStamps.get(analysis);
  if (memo) return memo;
  const graph = analysis.graph;
  const imports = Object.keys(graph.imports).sort().map((path) => `${path}>{${[...(graph.imports[path] ?? [])].sort().join(",")}}`);
  const calls = (graph.calls ?? []).map((call) => `${call.callerPath}>${call.calleePath}`).sort();
  const dispatch = (graph.dispatch ?? []).map((edge) => `${edge.subtypePath}=${edge.kind}=>${edge.supertypePath}`).sort();
  const stamp = hash(`${imports.join(";")}|${calls.join(";")}|${dispatch.join(";")}`).slice(0, 16);
  graphStamps.set(analysis, stamp);
  return stamp;
}

/** path@hash 逗号串；id 与缓存作用域共用它。 */
function depsFingerprint(deps: { path: string; hash: string }[]): string {
  return deps.map((dep) => `${dep.path}@${dep.hash}`).join(",");
}

/** 文件粒度作用域：依赖文件指纹 + 题面口径版本 + 模型档；三条出题路径共用。 */
function fileScope(deps: { path: string; hash: string }[], modelVersion: string, runner?: string): string {
  // runner 指纹只对代码族加。
  return `${depsFingerprint(deps)}#${EXERCISE_STEP.contractVersion}#${modelVersion}${runner ? `#runner=${runner}` : ""}`;
}

/** 一道题依赖的文件清单及其哈希；缺 `contentHash` 时以全仓 `versionStamp` 充当。 */
function exerciseDeps(repository: PracticeRepository, kind: ExerciseKind, value: unknown): { path: string; hash: string }[] {
  const hashOf = (path: string): string => repository.index.files.find((file) => file.path === path)?.contentHash ?? `repo:${repository.analysis.versionStamp}`;
  if (kind === "impact_analysis") return [];
  const unit = value as ImplementationUnit;
  return [{ path: unit.symbol.path, hash: hashOf(unit.symbol.path) }];
}

function targetPath(kind: ExerciseKind, value: unknown): string {
  return kind === "impact_analysis" ? String(value) : (value as ImplementationUnit).symbol.path;
}

/** 返回已过期的依赖清单，空 = 仍可用。 */
function staleDependencies(repository: PracticeRepository, exercise: Exercise): string[] {
  if (exercise.contentHashes?.length) {
    const wholeRepo = `repo:${repository.analysis.versionStamp}`;
    const byPath = new Map(repository.index.files.map((file) => [file.path, file.contentHash]));
    return exercise.contentHashes
      .filter((dep) => (dep.hash.startsWith("repo:") ? dep.hash !== wholeRepo : byPath.get(dep.path) !== dep.hash))
      .map((dep) => dep.path);
  }
  return exercise.contentVersion === repository.analysis.versionStamp ? [] : ["<仓库内容>"];
}

export class ExerciseService {
  getSummary(repository: PracticeRepository): PracticeSummary {
    const mastery = repository.ports.progress.mastery();
    const dueReviews = repository.ports.progress.list().filter((schedule) => schedule.dueAt <= new Date().toISOString()).length;
    return { repositoryId: repository.index.repositoryId, contentVersion: repository.analysis.versionStamp, dueReviews, mastery };
  }

  bank(repository: PracticeRepository): ExerciseBankEntry[] {
    const reviews = new Map(repository.ports.progress.list().map((schedule) => [schedule.exerciseId, schedule]));
    // 同一单元在不同作用域键下会各存一行，题库里只留最近那份。
    const newest = new Map<string, StoredExercise>();
    for (const stored of repository.ports.store.list<StoredExercise>()) {
      if (!newest.has(stored.exercise.id)) newest.set(stored.exercise.id, stored);
    }
    return [...newest.values()].map((stored) => {
      const review = reviews.get(stored.exercise.id);
      return review ? { exercise: stored.exercise, review } : { exercise: stored.exercise };
    }).sort((left, right) => {
      const leftDue = left.review?.dueAt;
      const rightDue = right.review?.dueAt;
      if (leftDue && rightDue) return leftDue.localeCompare(rightDue);
      if (leftDue) return -1;
      if (rightDue) return 1;
      return right.exercise.createdAt.localeCompare(left.exercise.createdAt);
    });
  }

  /** 题与复习排期一起删；journal 历史行不动，掌握度仍按历史算。 */
  remove(repository: PracticeRepository, exerciseId: string): { deleted: number } {
    const deleted = repository.ports.store.remove(exerciseId);
    repository.ports.progress.remove(exerciseId);
    return { deleted };
  }

  /** 题型决定链路：理解题吃静态分析、分析题走 rubric、设计题进沙箱；主题只筛目标单元。 */
  async next(repository: PracticeRepository, requested: { kind?: ExerciseKind; type?: ExerciseType; targetUnitId?: string; tag?: string; tagId?: string; variantNonce?: number } = {}, provider?: LlmProvider, faces?: ExerciseFaces, progress?: ExerciseProgressSink): Promise<Exercise> {
    const tag = (requested.tag ?? "").trim();
    const kind = requested.kind ?? (requested.type === "analysis" || (!requested.type && tag) ? "llm_rubric" : undefined);
    // v8 主题落点判定：付费前、唯一入口，覆盖 llm_rubric / reference / unit 三条路径。
    if (tag && faces?.skills) {
      const judged = this.judgeTheme(repository, tag, faces);
      if (judged && !judged.ok) {
        this.decline(repository, judged.rejection.stage, familyOf(kind ?? "impact_analysis"), tag,
          judged.rejection.reason,
          `未找到与「${tag}」相关的源码，请更换主题。`,
          { suggestions: judged.rejection.suggestions.join("、") });
      }
      if (judged?.ok) {
        faces = { ...faces, examPlan: judged.plan };
        traceEngine("exam_plan", {
          theme: tag, sourceLevel: judged.plan.sourceLevel, concepts: judged.plan.concepts.join(","),
          pointIds: judged.plan.pointIds.join(","), hits: judged.plan.landings.length,
          remaining: judged.plan.remaining, greyHits: judged.plan.greyHits.join(","),
          listed: judged.plan.listedPoints.map((point) => point.id).join(","),
          brief: examPlanBrief(judged.plan).slice(0, 500)
        }, { traceId: null });
      }
    }
    if (kind === "llm_rubric") return await this.nextLlm(repository, { tag, tagId: requested.tagId, variantNonce: requested.variantNonce }, provider, faces, progress);
    // `type=design` 也要解析成代码题型，否则只传 type 的客户端进不了 reference 分支。
    const strategyKind = kind ?? (requested.type === "design" ? "patch_edit" : undefined);
    const strategy = faces?.skills ? exerciseStrategyOf(faces.skills.bodyOf) : DEFAULT_EXERCISE_STRATEGY;
    if (strategyKind && isCodeKind(strategyKind) && strategy === "reference") {
      return await this.nextReferenceCode(repository, { tag, tagId: requested.tagId, kind: strategyKind, variantNonce: requested.variantNonce }, provider, faces, progress);
    }
    const theme = themeWithLandings(tag ? this.themeFiles(repository, tag) : undefined, faces?.examPlan);
    const modelVersion = provider?.modelVersion ?? "deterministic";
    if (!kind && !requested.targetUnitId) {
      const due = repository.ports.progress.list()
        .filter((schedule) => schedule.dueAt <= new Date().toISOString())
        .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
      for (const schedule of due) {
        const stored = repository.ports.store.byId<StoredExercise>(schedule.exerciseId);
        if (stored && !staleDependencies(repository, stored.exercise).length) {
          repository.ports.audit.append("exercise_generated", { source: "review", kind: stored.exercise.kind, target_unit: stored.exercise.targetUnitId, title: stored.exercise.title });
          return stored.exercise;
        }
      }
    }
    const mastery = repository.ports.progress.mastery();
    const target = this.pickTarget(repository, { kind, type: requested.type, targetUnitId: requested.targetUnitId }, mastery, theme);
    if (!target) {
      const family = familyOf(kind ?? "impact_analysis");
      if (requested.targetUnitId) this.decline(repository, "target_stale", family, tag, `按单元 ${requested.targetUnitId} 挑不出可出题的单元（题型已停用，或那个文件不在当前分析结果里）。`, "该练习记录无法出题，请更换其他记录。");
      if (theme?.size) this.decline(repository, "no_candidates", family, tag, `主题「${tag}」命中的文件里没有可出题的函数或路径。`, "这个主题在当前仓库找不到可出题的代码，请换个主题。");
      if (theme) this.decline(repository, "no_theme_hits", family, tag, `主题「${tag}」在源码路径、符号与摘要里都没有词法命中（候选文件 0 个）。`, "这个主题在源码里没有命中；当前题型需要先定位到具体文件，请改用分析题或设计题。");
      this.decline(repository, "no_target", family, tag, "分析结果里没有任何可出题的单元。", "当前分析结果无可出题内容，请重新分析该仓库。");
    }
    const deps = exerciseDeps(repository, target.kind, target.value);
    const scope = deps.length
      ? fileScope(deps, modelVersion, isCodeKind(target.kind) ? runnerFingerprint() : undefined)
      : exerciseScope(repository.analysis.versionStamp, modelVersion, graphStampOf(repository.analysis));
    const cached = repository.ports.store.get<StoredExercise>(scope, target.kind, target.id);
    if (cached) {
      repository.ports.audit.append("exercise_generated", { source: "cache", kind: cached.exercise.kind, target_unit: cached.exercise.targetUnitId, title: cached.exercise.title, polish: cached.polish ?? null, polish_failure: cached.polishFailure ?? null });
      return cached.exercise;
    }
    if (isCodeKind(target.kind)) return await this.nextCode(repository, target, provider, scope, deps, faces, progress);
    let stored = this.createExercise(repository, target.kind, target.value, target.difficulty, deps);
    let polish: StoredExercise["polish"] = "not_configured";
    let polishFailure: string | null = null;
    if (provider) {
      progress?.({ stage: "polishing" });
      const refined = await refineExerciseWithLlm(repository.path, stored.exercise, provider, faces?.signal);
      polish = refined.polished ? "llm" : "failed";
      polishFailure = refined.polishFailure ?? null;
      stored = { ...stored, exercise: refined.exercise, polish, polishFailure };
      if (refined.usage) repository.ports.audit.append("token_usage", {
        input_tokens: refined.usage.inputTokens,
        output_tokens: refined.usage.outputTokens,
        cache_hit_tokens: refined.usage.promptCacheHitTokens ?? null,
        provider: provider.modelVersion,
        scene: "exercise_generate"
      });
    }
    if (faces?.signal?.aborted) throw new Error("出题已取消");
    repository.ports.store.put(scope, target.kind, target.id, stored);
    repository.ports.audit.append("exercise_generated", { source: "rule", kind: stored.exercise.kind, target_unit: stored.exercise.targetUnitId, title: stored.exercise.title, polish, polish_failure: polishFailure });
    return stored.exercise;
  }

  /** 界面只看 `shown` 那一句，详细成因只写进 journal 的 exercise_declined。 */
  private decline(repository: PracticeRepository, stage: string, family: ExerciseFamily, tag: string, reason: string, shown: string, extra?: Record<string, string>): never {
    repository.ports.audit.append("exercise_declined", { family, tag, reason, stage, ...(extra ?? {}) });
    throw new ExerciseDeclinedError(stage, shown);
  }

  /**
    主题落点判定（v8）：在付费模型调用之前，覆盖所有题型。
    技能没装或考点表没补 id 列时显式告警并跳过，不静默把「判定不可用」当成「有落点」。
  */
  private judgeTheme(repository: PracticeRepository, theme: string, faces: ExerciseFaces): JudgeResult | undefined {
    if (!faces.skills) return undefined;
    const index = buildPointIndex(faces.skills.bodyOf);
    if (!index.points.length || !Object.keys(index.concepts).length) {
      // 词表缺一半时不能继续判定：conceptsOfTheme 恒空会把所有主题都判成零落点。
      console.warn("[exam-plan] 考点表或 concepts.json 未加载（技能缺失、表格没有 id 列、词表解析失败），本趟跳过主题落点判定。");
      return undefined;
    }
    const summaries = new Map(repository.ports.summaries.latest().map((row) => [row.path, row.summary]));
    const corpus = buildSearchCorpus(repository.index, repository.analysis, summaries);
    const ctx: LandingContext = {
      corpus,
      readText: (path) => {
        try { return readFileSync(join(repository.path, path), "utf8"); } catch { return undefined; }
      }
    };
    return judgeThemeLandings({ theme, index, ctx, tiers: loadPointTiers(faces.skills.bodyOf) });
  }

  /** 沙箱自证两跑（参考解必过、下发件必挂）后才落库。 */
  private async nextCode(repository: PracticeRepository, target: PracticeTarget<unknown>, provider: LlmProvider | undefined, scope: string, deps: { path: string; hash: string }[], faces?: ExerciseFaces, progress?: ExerciseProgressSink): Promise<Exercise> {
    const targetUnitId = target.id;
    if (!provider) {
      this.decline(repository, "no_provider", "code", "", "代码题的题面、缺陷与测试都由模型设计，判分靠运行测试；当前没配模型，或本月预算已用完。", "代码题需要模型，当前不可用。");
    }
    const unit = target.value as ImplementationUnit;
    if (unit.symbol.language === "go" && !resolveToolchain().go) {
      this.decline(repository, "toolchain_unavailable", "code", "", "本机 PATH 里找不到 go，Go 代码题无法在沙箱里自证；这一趟没有调用模型。", "Go 代码题需要 Go 工具链，当前不可用。");
    }
    // 沙箱探测在付费之前：非 `enforced` 直接拒，不发模型调用。
    const isolation = await ensureIsolation();
    if (isolation.level !== "enforced") {
      this.decline(repository, "sandbox_unavailable", "code", "", `沙箱当前不可用（${isolation.reason}），代码题整域禁用；这一趟没有调用模型，因此没有花费。`, "代码题当前不可用。");
    }
    const kind = target.kind === "author_function" ? "author_function" : "patch_edit";
    const generation = await generateCodeExercise({ repositoryPath: repository.path, unit, kind, provider, faces, onProgress: progress });
    this.auditCodeGeneration(repository, generation, generation.ok ? generation.proposal.language : unit.symbol.language, provider);
    if (faces?.signal?.aborted) throw new Error("出题已取消");
    if (!generation.ok) {
      this.decline(repository, generation.stage, "code", "", generation.reason, "代码题生成失败，请重试。");
    }
    const proposal = generation.proposal;
    const exercise: Exercise = {
      // id 含 scope：换模型或换 runner 就是另一道题。
      id: `exercise:${hash(`${repository.index.repositoryId}:${scope}:${proposal.kind}:${targetUnitId}`).slice(0, 20)}`,
      repositoryId: repository.index.repositoryId,
      contentVersion: repository.analysis.versionStamp,
      ...(deps.length ? { contentHashes: deps } : {}),
      kind: proposal.kind,
      targetUnitId,
      targetTitle: proposal.defect || target.title,
      difficulty: target.difficulty,
      title: proposal.title,
      prompt: proposal.prompt,
      anchors: [{ path: (target.value as ImplementationUnit).symbol.path, line: (target.value as ImplementationUnit).symbol.line, endLine: (target.value as ImplementationUnit).symbol.endLine, label: "被测代码出处" }],
      inputMode: "code",
      gradingMode: "execution",
      family: "code",
      code: { language: proposal.language, files: proposal.given, entry: proposal.entry },
      createdAt: new Date().toISOString()
    };
    const stored: StoredExercise = {
      exercise,
      expected: { type: "harness", language: proposal.language, entry: proposal.entry, hidden: proposal.hidden, solution: proposal.solution, defect: proposal.defect },

      polish: "llm",
      polishFailure: null
    };
    repository.ports.store.put(scope, proposal.kind, targetUnitId, stored);
    repository.ports.audit.append("exercise_generated", { source: "code", kind: exercise.kind, target_unit: targetUnitId, title: exercise.title, polish: "llm", polish_failure: null });
    return exercise;
  }

  /** 证据账：技能、读过的文件、自证两跑、用量；被拒的趟也要有行。 */
  private auditCodeGeneration(repository: PracticeRepository, generation: CodeGeneration, language: string, provider: LlmProvider): void {
    for (const read of generation.skillReads) repository.ports.audit.append("skill_read", skillReadAuditPayload(read));
    for (const read of generation.fileReads ?? []) repository.ports.audit.append("file_read", fileReadAuditPayload(read));
    for (const run of generation.runs) {
      // 每跑按自己的结论记账，修复通过不能把首轮失败记成已接受。
      const accepted = run.label === "solution"
        ? Boolean(run.verdict && run.verdict.passed > 0 && run.verdict.failed === 0 && run.exitCode === 0)
        : Boolean(run.verdict && run.verdict.failed > 0);
      repository.ports.audit.append("exercise_run", {
        stage: "validate-proposal", label: run.label, language,
        verdict_passed: run.verdict?.passed ?? null, verdict_failed: run.verdict?.failed ?? null,
        exit_code: run.exitCode, timed_out: run.timedOut,
        outcome: accepted ? "accepted" : "harness_validation",
        ...(run.output ? { output: run.output.slice(-800) } : {})
      });
    }
    // 用量账走在拒绝之前。
    if (generation.usage) repository.ports.audit.append("token_usage", {
      input_tokens: generation.usage.inputTokens,
      output_tokens: generation.usage.outputTokens,
      cache_hit_tokens: generation.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "exercise_generate_code"
    });
  }

  /** 先走分段产出，形状不合或自证不过就退回整份产出。 */
  private async generateSegmentedOrWhole(input: {
    repositoryPath: string;
    tag: string;
    kind: "patch_edit" | "author_function";
    reference: string;
    provider: LlmProvider;
    faces?: ExerciseFaces;
    progress?: ExerciseProgressSink;
  }): Promise<CodeGeneration> {
    const segmented = await generateCodeExerciseSegmented({
      repositoryPath: input.repositoryPath,
      tag: input.tag,
      kind: input.kind,
      reference: input.reference,
      provider: input.provider,
      ...(input.faces ? { faces: input.faces } : {}),
      ...(input.progress ? { onProgress: input.progress } : {})
    });
    if (segmented.ok) return segmented;
    // provider_error 不兜底。
    if (segmented.stage === "provider_error") return segmented;
    // 兜底沿用分段已定好的题面，只跑一次、不再修复重试。
    const whole = await generateCodeExerciseFromReference({
      repositoryPath: input.repositoryPath,
      tag: input.tag,
      kind: input.kind,
      reference: input.reference,
      provider: input.provider,
      repair: { maxRetries: 0, retryShape: false },
      ...(segmented.plan ? { priorPlan: segmented.plan } : {}),
      ...(input.faces ? { faces: input.faces } : {}),
      ...(input.progress ? { onProgress: input.progress } : {})
    });
    return whole.ok ? whole : { ...whole, reason: `${whole.reason}（分段那次：${segmented.reason.slice(0, 160)}）` };
  }

  /** 参考模式：源码只作参考，题目由模型自定。 */
  private async nextReferenceCode(repository: PracticeRepository, requested: { tag: string; tagId?: string; kind: ExerciseKind; variantNonce?: number }, provider: LlmProvider | undefined, faces?: ExerciseFaces, progress?: ExerciseProgressSink): Promise<Exercise> {
    const tag = requested.tag.trim();
    if (!tag) throw new Error("出题需要先填主题名称；请在「＋ 配置」里填写。");
    if (!provider) {
      this.decline(repository, "no_provider", "code", tag, "代码题的题面、缺陷与测试都由模型设计；当前没配模型，或本月预算已用完。", "代码题需要模型，当前不可用。");
    }
    // 沙箱探测在付费之前：非 `enforced` 直接拒，不发模型调用。
    const isolation = await ensureIsolation();
    if (isolation.level !== "enforced") {
      this.decline(repository, "sandbox_unavailable", "code", tag, `沙箱当前不可用（${isolation.reason}），代码题整域禁用；这一趟没有调用模型，因此没有花费。`, "代码题当前不可用。");
    }
    const kind = requested.kind === "author_function" ? "author_function" : "patch_edit";
    const nonce = Math.max(0, Math.floor(requested.variantNonce ?? 0));
    const tagKey = (requested.tagId ?? "").trim() || tag;
    const targetUnitId = `llm-code:${tagKey}:${nonce}`;
    const summaries = new Map(repository.ports.summaries.latest().map((row) => [row.path, row.summary]));
    const candidates = selectTagCandidates(repository, tag, 6, summaries);
    const selection = candidates.length ? "tag" : "none";
    const hashOf = (path: string): string => repository.index.files.find((file) => file.path === path)?.contentHash ?? `repo:${repository.analysis.versionStamp}`;
    const deps = candidates.map((candidate) => ({ path: candidate.path, hash: hashOf(candidate.path) }));
    // 键不带单元，只认被当成参考的这批文件。
    const scope = deps.length ? `${fileScope(deps, provider.modelVersion, runnerFingerprint())}#reference` : `reference#${repository.analysis.versionStamp}#${provider.modelVersion}`;
    const cached = repository.ports.store.get<StoredExercise>(scope, kind, targetUnitId);
    if (cached) {
      repository.ports.audit.append("exercise_generated", { source: "cache", kind: cached.exercise.kind, target_unit: targetUnitId, title: cached.exercise.title, tag, selection, strategy: "reference" });
      return cached.exercise;
    }
    const reference = candidates.map((candidate) => `## ${candidate.path}\n${candidate.excerpt}`).join("\n\n").slice(0, 24_000);
    const generation = segmentedExerciseEnabled()
      ? await this.generateSegmentedOrWhole({ repositoryPath: repository.path, tag, kind, reference, provider, faces, progress })
      : await generateCodeExerciseFromReference({ repositoryPath: repository.path, tag, kind, reference, provider, faces, onProgress: progress });
    this.auditCodeGeneration(repository, generation, generation.ok ? generation.proposal.language : "unknown", provider);
    if (!generation.ok) {
      this.decline(repository, generation.stage, "code", tag, generation.reason, "代码题生成失败，请重试。");
    }
    const proposal = generation.proposal;
    // 锚点只认这一趟真看过的代码：预注入的摘录，或模型自己 read_file 读到的。
    const readPaths = new Set([
      ...candidates.map((candidate) => candidate.path),
      ...(generation.fileReads ?? []).filter((read) => !read.denied && !read.error).map((read) => read.path)
    ]);
    const accepted = (proposal.anchors ?? []).filter((anchor) => readPaths.has(anchor.path));
    const anchors = accepted.map((anchor) => ({ path: anchor.path, line: anchor.line, ...(anchor.endLine ? { endLine: anchor.endLine } : {}), label: "参考代码" }));
    const exercise: Exercise = {
      id: `exercise:${hash(`${repository.index.repositoryId}:${scope}:${proposal.kind}:${targetUnitId}`).slice(0, 20)}`,
      repositoryId: repository.index.repositoryId,
      contentVersion: repository.analysis.versionStamp,
      ...(deps.length ? { contentHashes: deps } : {}),
      kind: proposal.kind,
      targetUnitId,
      targetTitle: proposal.defect || tag,
      // 题目不在真实代码上，难度按中档记。
      difficulty: 3,
      title: proposal.title,
      prompt: proposal.prompt,
      anchors,
      inputMode: "code",
      gradingMode: "execution",
      family: "code",
      tag,
      ...(requested.tagId?.trim() ? { topicId: requested.tagId.trim() } : {}),
      code: { language: proposal.language, files: proposal.given, entry: proposal.entry },
      createdAt: new Date().toISOString()
    };
    const stored: StoredExercise = {
      exercise,
      expected: { type: "harness", language: proposal.language, entry: proposal.entry, hidden: proposal.hidden, solution: proposal.solution, defect: proposal.defect },
      polish: "llm",
      polishFailure: null
    };
    if (faces?.signal?.aborted) throw new Error("出题已取消");
    repository.ports.store.put(scope, proposal.kind, targetUnitId, stored);
    repository.ports.audit.append("exercise_generated", { source: "code", kind: exercise.kind, target_unit: targetUnitId, title: exercise.title, tag, selection, strategy: "reference", polish: "llm", polish_failure: null });
    // 锚点的 why 只进 journal，一条一个。
    for (const anchor of accepted) {
      repository.ports.audit.append("exercise_anchor", {
        target_unit: targetUnitId, tag, path: anchor.path, line: anchor.line,
        ...(anchor.endLine ? { end_line: anchor.endLine } : {}),
        ...(anchor.why ? { why: anchor.why } : {})
      });
    }
    return exercise;
  }

  /** LLM 出题族：一轮调用内由模型判定能否出题，拒绝与守门否决都记 `exercise_declined`。 */
  private async nextLlm(repository: PracticeRepository, requested: { tag?: string; tagId?: string; variantNonce?: number }, provider: LlmProvider | undefined, faces?: ExerciseFaces, progress?: ExerciseProgressSink): Promise<Exercise> {
    const tag = (requested.tag ?? "").trim();
    if (!tag) throw new Error("出题需要先填主题名称；请在「＋ 配置」里填写。");
    if (!provider) throw new Error("出题模型当前不可用：未配置模型或本月预算已用完。");
    const nonce = Math.max(0, Math.floor(requested.variantNonce ?? 0));
    const tagKey = (requested.tagId ?? "").trim() || tag;
    const targetUnitId = `llm:${tagKey}:${nonce}`;
    // 候选选择先于缓存查找：作用域按候选文件自己的哈希算。
    const summaries = new Map(repository.ports.summaries.latest().map((row) => [row.path, row.summary]));
    const matched = selectTagCandidates(repository, tag, 3, summaries);
    const candidates = matched.length ? matched : panoramaCandidates(repository, summaries);
    const selection = matched.length ? "tag" : "panorama";
    // 配置键、建表语句、依赖清单不在收录集里，机制级考点要有它们才读得到东西。
    const clues = [...new Set([...tagTokens(tag), ...excerptClues(candidates)])];
    const mechanism = mechanismCandidate(repository.path, clues, new Set(candidates.map((item) => item.path)));
    const pool = mechanism ? [...candidates, mechanism.candidate] : candidates;
    if (!pool.length) {
      this.decline(repository, "no_candidates", "llm", tag, `词法命中、仓库全景与机制声明面都挑不出可出题的文件（主题「${tag}」）。`, `未找到与「${tag}」相关的源码，请更换主题。`);
    }
    const hashOf = (path: string): string => repository.index.files.find((file) => file.path === path)?.contentHash ?? `repo:${repository.analysis.versionStamp}`;
    const deps = pool.map((candidate) => ({ path: candidate.path, hash: mechanism && candidate.path === mechanism.candidate.path ? mechanism.digest : hashOf(candidate.path) }));
    // 档位与可考点不进缓存键。
    const scope = fileScope(deps, provider.modelVersion);
    const topics = faces?.skills ? topicIndex(faces.skills.bodyOf) : NO_TOPICS;
    const extra: Record<string, string> = {
      ...(topics.tiers.length ? { tiers_offered: topics.tiers.map((tier) => tier.id).join(",") } : {}),
      ...(mechanism ? { mechanism_file: mechanism.candidate.path } : {})
    };
    const cached = repository.ports.store.get<StoredExercise>(scope, "llm_rubric", targetUnitId);
    if (cached && cached.exercise.kind === "llm_rubric") {
      repository.ports.audit.append("exercise_generated", { source: "cache", kind: cached.exercise.kind, target_unit: targetUnitId, title: cached.exercise.title, tag, selection, ...extra });
      return cached.exercise;
    }
    const generation = await generateExerciseWithLlm({ repositoryPath: repository.path, tag, candidates: pool, provider, topics, faces, onProgress: progress });
    for (const read of generation.skillReads) repository.ports.audit.append("skill_read", skillReadAuditPayload(read));
    for (const read of generation.fileReads) repository.ports.audit.append("file_read", fileReadAuditPayload(read));
    // 用量账先落，再看拒绝。
    if (generation.usage) repository.ports.audit.append("token_usage", {
      input_tokens: generation.usage.inputTokens,
      output_tokens: generation.usage.outputTokens,
      cache_hit_tokens: generation.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "exercise_llm_generate"
    });
    if (!generation.ok) {
      this.decline(repository, "llm_generate", "llm", tag, generation.reason, "模型判定该主题无法出题，请更换主题。", extra);
    }
    const issues = guardLlmProposal(generation.proposal, pool);
    if (issues.length) {
      this.decline(repository, "guard", "llm", tag, `模型出的题不合格：${issues.map((issue) => issue.message).join("；")}。`, "题目校验未通过，请重试。", extra);
    }
    const proposal = generation.proposal;
    const exercise: Exercise = {
      // id 含 scope：换模型就是另一道题。
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
      ...(requested.tagId?.trim() ? { topicId: requested.tagId.trim() } : {}),
      createdAt: new Date().toISOString()
    };
    const stored: StoredExercise = { exercise, expected: { type: "rubric", answerKey: proposal.answerKey, criteria: proposal.criteria } };
    if (faces?.signal?.aborted) throw new Error("出题已取消");
    repository.ports.store.put(scope, "llm_rubric", targetUnitId, stored);
    repository.ports.audit.append("exercise_generated", {
      source: "llm", kind: exercise.kind, target_unit: targetUnitId, title: exercise.title, tag, selection, ...extra,
      ...(proposal.topicTier ? { topic_tier: proposal.topicTier } : {}),
      ...(proposal.examPoint ? { exam_point: proposal.examPoint } : {})
    });
    return exercise;
  }

  /** 只对代码题开放，只回一段话，不改 `passed` / `score`。 */
  async explain(repository: PracticeRepository, exerciseId: string, answer: ExerciseAnswer, provider: LlmProvider | undefined, faces?: ExerciseFaces): Promise<{ explanation: string }> {
    // 讲评不做时效校验：吃的是缓存行里冻结的测试。
    if (!provider) throw new Error("讲解需要模型，当前不可用。");
    const stored = repository.ports.store.byId<StoredExercise>(exerciseId);
    if (!stored) throw new Error("该练习不存在，请重新生成。");
    if (stored.expected.type !== "harness") throw new Error("仅代码题支持讲解。");
    const slotPaths = new Set((stored.exercise.code?.files ?? []).map((file) => file.path));
    const learnerFiles = (answer.files ?? []).filter((file) => slotPaths.has(file.path) && file.contents.trim());
    if (!learnerFiles.length) throw new Error("未收到代码，无法讲解。");
    const explained = await explainCodeAttempt({
      repositoryPath: repository.path,
      title: stored.exercise.title,
      prompt: stored.exercise.prompt,
      harness: stored.expected,
      learnerFiles,
      provider,
      faces
    });
    for (const read of explained.fileReads) repository.ports.audit.append("file_read", fileReadAuditPayload(read));
    if (explained.usage) repository.ports.audit.append("token_usage", {
      input_tokens: explained.usage.inputTokens,
      output_tokens: explained.usage.outputTokens,
      cache_hit_tokens: explained.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "exercise_explain"
    });
    return { explanation: explained.explanation };
  }

  async answer(repository: PracticeRepository, exerciseId: string, answer: ExerciseAnswer, provider?: LlmProvider, faces?: ExerciseFaces): Promise<ExerciseResult> {
    const stored = repository.ports.store.byId<StoredExercise>(exerciseId);
    if (!stored) throw new Error("该练习不存在，请重新生成。");
    const stale = staleDependencies(repository, stored.exercise);
    if (stale.length) throw new Error("该练习依赖的源码已更新，请重新生成。");
    let graded = stored.expected.type === "rubric"
      ? await gradeRubric(stored, answer, provider, repository.ports.audit, faces)
      : await grade(stored, answer, repository.ports.audit, repository.path);
    // 润色失败时保留原文，feedbackSource 仍是 "rule"。
    if (provider && graded.automatic && stored.exercise.gradingMode !== "execution") {
      const learnerAnswer = answer.text?.trim() || (answer.selectedIds ?? []).join(", ");
      const polished = await polishFeedbackWithLlm({ repositoryPath: repository.path, exercise: stored.exercise, learnerAnswer, graded, provider });
      if (polished) {
        graded = { ...graded, feedback: polished.feedback, feedbackSource: "llm_polished" };
        if (polished.usage) repository.ports.audit.append("token_usage", {
          input_tokens: polished.usage.inputTokens,
          output_tokens: polished.usage.outputTokens,
          cache_hit_tokens: polished.usage.promptCacheHitTokens ?? null,
          provider: provider.modelVersion,
          scene: "exercise_feedback_polish"
        });
      }
    }
    const now = new Date();
    const previous = repository.ports.progress.get(exerciseId);
    const attemptKind: AttemptKind = previous === undefined ? "first" : previous.dueAt <= now.toISOString() ? "review" : "retry";
    const review = scheduleSm2(previous, qualityForScore(graded.score), now);
    review.exerciseId = exerciseId;
    review.unitId = stored.exercise.targetUnitId;
    repository.ports.progress.save(review);
    const appended = repository.ports.audit.append("exercise_result", {
      exercise_id: exerciseId,
      target_unit_id: stored.exercise.targetUnitId,
      kind: stored.exercise.kind,
      score: graded.score,
      passed: graded.passed,
      grading_mode: stored.exercise.gradingMode,
      attempt_kind: attemptKind,
      ...(stored.exercise.topicId ? { topic_id: stored.exercise.topicId } : {}),
      ...(stored.exercise.tag ? { tag: stored.exercise.tag } : {}),
      generation_source: stored.exercise.family === "llm" ? "llm_proposed" : "static",
      feedback_source: graded.feedbackSource ?? "rule"
    });
    return {
      ...graded,
      exerciseId,
      repositoryId: repository.index.repositoryId,
      targetUnitId: stored.exercise.targetUnitId,
      kind: stored.exercise.kind,
      gradingMode: stored.exercise.gradingMode,
      attemptKind,
      ...(stored.exercise.topicId ? { topicId: stored.exercise.topicId } : {}),
      // 与 journal 行共用同一时间戳：跨仓 contribution 按它做幂等去重。
      reviewedAt: appended.at,
      review
    };
  }

  /** 空集也是答案，不退化成全仓出题。 */
  private themeFiles(repository: PracticeRepository, tag: string): Set<string> {
    const summaries = new Map(repository.ports.summaries.latest().map((row) => [row.path, row.summary]));
    return new Set(selectTagCandidates(repository, tag, THEME_FILES, summaries).map((candidate) => candidate.path));
  }

  private pickTarget(repository: PracticeRepository, requested: { kind?: ExerciseKind; type?: ExerciseType; targetUnitId?: string }, mastery: MasteryRecord[], theme?: Set<string>): PracticeTarget<unknown> | undefined {
    const availableKinds = requested.kind ? [requested.kind] : requested.type ? EXERCISE_TYPE_KINDS[requested.type] : kinds;
    const attemptCount = mastery.reduce((sum, record) => sum + record.attempts, 0);
    const orderedKinds = requested.kind ? availableKinds : [...availableKinds.slice(attemptCount % availableKinds.length), ...availableKinds.slice(0, attemptCount % availableKinds.length)];
    for (const kind of orderedKinds) {
      const targets = this.targets(repository, kind)
        .filter((target) => !theme || theme.has(targetPath(kind, target.value)));
      const restricted = requested.targetUnitId ? targets.filter((target) => target.id === requested.targetUnitId) : targets;
      if (requested.targetUnitId && restricted.length) return restricted[0];
      const selected = selectZpdTarget(restricted, mastery) as PracticeTarget<unknown> | undefined;
      if (selected) return selected;
    }
    return undefined;
  }

  private targets(repository: PracticeRepository, kind: ExerciseKind): PracticeTarget<unknown>[] {
    if (isCodeKind(kind)) {
      // 沙箱不支持的语言不进候选。
      const supported = new Set(["typescript", "python", "java", "go"]);
      // 外部依赖：同文件里有几处跨文件调用。这是文件级属性，同一文件的 unit 共享——
      // 只做同难度 tie-break，不进 unitDifficulty（那里已经把 traps 与 referenceCount 计进复杂度）。
      const crossFileCalls = new Map<string, number>();
      for (const call of repository.analysis.graph.calls ?? []) {
        if (call.callerPath === call.calleePath) continue;
        crossFileCalls.set(call.callerPath, (crossFileCalls.get(call.callerPath) ?? 0) + 1);
      }
      return repository.analysis.implementations
        .filter((unit) => supported.has(unit.symbol.language))
        .map((unit) => ({
          id: unit.id, title: unit.symbol.name, difficulty: unitDifficulty(unit), value: unit, kind,
          externalDeps: crossFileCalls.get(unit.symbol.path) ?? 0
        }));
    }
    if (kind === "change_localization") {
      return repository.analysis.implementations
        .map((unit) => ({ id: unit.id, title: unit.symbol.name, difficulty: unitDifficulty(unit), value: unit, kind }));
    }
    if (kind === "impact_analysis") {
      const graph = graphFromData(repository.analysis.graph);
      return Object.keys(repository.analysis.graph.imports)
        .map((path) => {
          const impact = impactRadius(graph, [path]);
          return { id: `impact:${path}`, title: path, difficulty: Math.min(5, Math.max(1, impact.impactedPaths.length)) as MasteryLevel, value: path, kind };
        });
    }
    return [];
  }

  private createExercise(repository: PracticeRepository, kind: ExerciseKind, value: unknown, difficulty: MasteryLevel, deps: { path: string; hash: string }[]): StoredExercise {
    if (kind === "change_localization") return localizationExercise(repository, value as ImplementationUnit, difficulty, deps);
    if (kind === "impact_analysis") return impactExercise(repository, value as string, difficulty);
    throw new Error("不支持的练习题型");
  }
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
  // id 只含文件哈希部分，换模型不串答案；deps 为空时沿用全仓 `versionStamp`。
  const idBase = deps.length ? depsFingerprint(deps) : repository.analysis.versionStamp;
  const id = `exercise:${hash(`${repository.index.repositoryId}:${idBase}:${kind}:${targetUnitId}`).slice(0, 20)}`;
  return {
    id, repositoryId: repository.index.repositoryId, contentVersion: repository.analysis.versionStamp,
    ...(deps.length ? { contentHashes: deps } : {}),
    kind, targetUnitId, targetTitle, difficulty, createdAt: new Date().toISOString(), ...input
  };
}

type GradeOutcome = Omit<ExerciseResult, "exerciseId" | "repositoryId" | "targetUnitId" | "kind" | "gradingMode" | "attemptKind" | "topicId" | "reviewedAt" | "review">;

async function grade(stored: StoredExercise, answer: ExerciseAnswer, audit: AuditSink, repositoryPath: string): Promise<GradeOutcome> {
  if (stored.expected.type === "set") return gradeSet(stored.expected.expectedIds, answer.selectedIds ?? []);
  if (stored.expected.type === "harness") return gradeHarness(stored, answer, audit, repositoryPath);
  throw new Error("该练习无法判分，请重新生成。");
}

/** 只由沙箱里冻结的那组测试决定，模型不参与，不读仓库源码。 */
async function gradeHarness(stored: StoredExercise, answer: ExerciseAnswer, audit: AuditSink, repositoryPath: string): Promise<GradeOutcome> {
  const expected = stored.expected as Extract<ExpectedAnswer, { type: "harness" }>;
  const slotPaths = new Set((stored.exercise.code?.files ?? []).map((file) => file.path));
  const submitted = (answer.files ?? []).filter((file) => slotPaths.has(file.path) && file.contents.trim());
  if (!slotPaths.size || !submitted.length) {
    return { score: 0, passed: false, automatic: true, feedbackSource: "sandbox", feedback: "没收到代码文件；请在编辑器里写下实现再提交。" };
  }
  const files = [...expected.hidden.map((file) => ({ ...file })), ...submitted.map((file) => ({ path: file.path, contents: file.contents }))];
  const run = await runSandbox({ language: expected.language, entry: expected.entry, files, repositoryPath });
  const verdict = verdictOf(run);
  // journal 的 outcome 与返回的 passed 取同一个布尔值。
  const passed = verdict ? verdict.failed === 0 && verdict.passed >= 1 && run.ok : false;
  audit.append("exercise_run", {
    stage: "grade", label: "learner", language: expected.language, exercise_id: stored.exercise.id,
    verdict_passed: verdict?.passed ?? null, verdict_failed: verdict?.failed ?? null,
    exit_code: run.steps.at(-1)?.exitCode ?? null, timed_out: run.timedOut, truncated: run.truncated,
    outcome: verdict ? (passed ? "passed" : "failed") : "no-verdict"
  });
  if (!verdict) {
    const detail = (run.stderr || (run.timedOut ? "运行超时被终止" : "没有输出")).trim().split("\n").slice(0, 3).join(" / ").slice(0, 400);
    return { score: 0, passed: false, automatic: true, feedbackSource: "sandbox", feedback: `测试没能跑完，所以这一份还没有被判分。沙箱报：${detail}。` };
  }
  const total = verdict.passed + verdict.failed;
  return {
    score: total ? verdict.passed / total : 0,
    passed,
    automatic: true,
    feedbackSource: "sandbox",
    feedback: passed
      ? `测试全过：${verdict.passed} 条断言逐条通过。`
      : `测试 ${verdict.passed} 过 ${verdict.failed} 挂${run.timedOut ? "（并且运行超时被终止）" : ""}。${stored.exercise.kind === "patch_edit" && expected.defect ? `要修的是：${expected.defect}` : ""}`
  };
}

/** 模型拿参考答案与细则比对学习者回答，`automatic: false`。 */
async function gradeRubric(stored: StoredExercise, answer: ExerciseAnswer, provider: LlmProvider | undefined, audit: AuditSink, faces?: ExerciseFaces): Promise<GradeOutcome> {
  if (!provider) throw new Error("该题判分需要模型，当前不可用。");
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
    provider,
    faces
  });
  for (const read of judged.fileReads) audit.append("file_read", fileReadAuditPayload(read));
  if (judged.usage) audit.append("token_usage", { input_tokens: judged.usage.inputTokens, output_tokens: judged.usage.outputTokens, cache_hit_tokens: judged.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "exercise_judge" });
  return { score: judged.score, passed: judged.passed, automatic: false, feedbackSource: "llm_judge", feedback: judged.feedback };
}

function gradeSet(expected: string[], selected: string[]): GradeOutcome {
  const expectedSet = new Set(expected);
  const selectedSet = new Set(selected);
  const matchedIds = expected.filter((id) => selectedSet.has(id));
  const missingIds = expected.filter((id) => !selectedSet.has(id));
  const unexpectedIds = [...selectedSet].filter((id) => !expectedSet.has(id)).sort();
  const passed = missingIds.length === 0 && unexpectedIds.length === 0;
  const union = expectedSet.size + unexpectedIds.length;
  const score = union ? matchedIds.length / union : 1;
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

export function selectTagCandidates(repository: PracticeRepository, tag: string, limit = 3, summaries: Map<string, string> = new Map()): GuardCandidate[] {
  const tokens = tagTokens(tag);
  const symbolsByPath = new Map<string, SymbolInfo[]>();
  for (const symbol of repository.analysis.graph.symbols) {
    const list = symbolsByPath.get(symbol.path) ?? [];
    list.push(symbol);
    symbolsByPath.set(symbol.path, list);
  }
  const hotspots = new Map(repository.index.hotspots.map((hotspot) => [hotspot.path, hotspot.changes]));
  const scored = repository.index.files
    // 扩展名判据与 `sourceOptions` 共用能力表。
    .filter((file) => handledExtensions.has(file.extension))
    .map((file) => {
      const path = file.path;
      const symbols = (symbolsByPath.get(path) ?? []).map((symbol) => symbol.name.toLowerCase()).join(" ");
      const summary = (summaries.get(path) ?? "").toLowerCase();
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
    const candidate = buildTagCandidate(repository.path, path, windowSpan(symbolsByPath.get(path) ?? [], tokens));
    return candidate ? [candidate] : [];
  });
}

function panoramaCandidates(repository: PracticeRepository, summaries: Map<string, string>, limit = 3): GuardCandidate[] {
  // 同一份产物下选料必须确定，否则每次出题都是新的缓存作用域。
  const bodyOf = new Map<string, SymbolInfo>();
  for (const symbol of repository.analysis.graph.symbols) {
    if (symbol.kind !== "function" && symbol.kind !== "method") continue;
    const best = bodyOf.get(symbol.path);
    if (!best || symbol.endLine - symbol.line > best.endLine - best.line) bodyOf.set(symbol.path, symbol);
  }
  const hotspots = new Map(repository.index.hotspots.map((hotspot) => [hotspot.path, hotspot.changes]));
  const scored = repository.index.files
    .filter((file) => handledExtensions.has(file.extension))
    .map((file) => {
      const body = bodyOf.get(file.path);
      return {
        path: file.path,
        score: (summaries.has(file.path) ? 20 : 0) + Math.min(hotspots.get(file.path) ?? 0, 10) + (body ? Math.min(body.endLine - body.line + 1, 30) : 0)
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
  return scored.flatMap(({ path }) => {
    const body = bodyOf.get(path);
    const candidate = buildTagCandidate(repository.path, path, body ? { start: body.line, end: body.endLine } : { start: 1 });
    return candidate ? [candidate] : [];
  });
}

function windowSpan(symbols: SymbolInfo[], tokens: string[]): { start: number; end?: number } {
  let best: { score: number; symbol: SymbolInfo } | undefined;
  for (const symbol of symbols) {
    const name = symbol.name.toLowerCase();
    const score = tokens.reduce((total, token) => total + (name.includes(token) ? 1 : 0), 0);
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && symbol.line < best.symbol.line)) best = { score, symbol };
  }
  return best ? { start: best.symbol.line, end: best.symbol.endLine } : { start: 1 };
}

function prioritizedImpactPaths(result: ReturnType<typeof impactRadius>, changedPath: string, limit = 4): string[] {
  const directDependents = result.edges.filter((edge) => edge.to === changedPath).map((edge) => edge.from).sort();
  return [...new Set([changedPath, ...directDependents, ...result.impactedPaths])].slice(0, limit);
}

function sourceOptions(repository: PracticeRepository, preferredPaths: string[], limit = 8) {
  // 正解只按「在不在索引里」认；扩展名闸门只管干扰项从哪儿捞。
  const indexed = new Set(repository.index.files.map((file) => file.path));
  const preferred = [...new Set(preferredPaths)].filter((path) => indexed.has(path)).slice(0, limit);
  const sourcePaths = repository.index.files.filter((file) => handledExtensions.has(file.extension)).map((file) => file.path);
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
