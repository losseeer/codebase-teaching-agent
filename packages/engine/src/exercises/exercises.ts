import { dirname } from "node:path";
import type {
  Exercise,
  ExerciseAnswer,
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
import { CODE_EXERCISE_KINDS, SUPPORTED_EXERCISE_KINDS, type SymbolInfo } from "@codebase-tutor/domain";

import type { LlmProvider } from "../application/port/llm-provider.js";
import type { SkillsToolContext } from "../source/tool-loop.js";
import { graphFromData, handledExtensions, impactRadius } from "@codebase-tutor/analysis";
import { hash } from "@codebase-tutor/platform";
import { buildTagCandidate, EXERCISE_STEP, generateExerciseWithLlm, judgeRubricWithLlm, polishFeedbackWithLlm, refineExerciseWithLlm } from "./llm-generate.js";
import { explainCodeAttempt, generateCodeExercise, verdictOf, type CodeFile } from "./code-generate.js";
import { guardLlmProposal, type GuardCandidate } from "./guard-proposal.js";
import { ensureIsolation, runSandbox } from "../adapter/outbound/sandbox/isolation.js";
import { runnerFingerprint } from "../adapter/outbound/sandbox/profile.js";
import type { ExercisePorts } from "../application/port/exercise-ports.js";
import type { AuditSink } from "../application/port/audit-sink.js";
import { selectZpdTarget, type ZpdTarget } from "./zpd.js";
import { qualityForScore, scheduleSm2 } from "./sm2.js";

const isCodeKind = (kind: ExerciseKind): boolean => CODE_EXERCISE_KINDS.includes(kind);

type ExpectedAnswer =
  | { type: "set"; expectedIds: string[] }
  | { type: "rubric"; answerKey: string; criteria: RubricCriterion[] }
  /**
    出题时冻结的那一组判分文件：`hidden`（测试 + 替身）与 `solution`（参考解）都不下发；
    学习者交上来的只替换 `exercise.code.files` 那几个路径。判分路径因此不读仓库源码，也不依赖模型。
    */
  | { type: "harness"; language: ExerciseLanguage; entry: string; hidden: CodeFile[]; solution: CodeFile[]; defect: string };

interface StoredExercise {
  exercise: Exercise;
  expected: ExpectedAnswer;
  /**
    题面来源：`llm` 模型改写成功 / `failed` 试了但回落启发式 / `not_configured` 没配模型。
    默认（旧行）= 当时没记，读作 unknown，不事后猜。
    */
  polish?: "llm" | "failed" | "not_configured";
  /** 失败形状（`no_excerpt` / `unparsable` / `provider_error`）；跟着缓存行走，命中时才知道当时坏在哪 */
  polishFailure?: string | null;
}

type PracticeTarget<T> = ZpdTarget<T> & { kind: ExerciseKind };

/**
  练习这一侧看到的仓：读的三样 + 能做的四个口。
  `ports` 由装配层（`infrastructure/exercise-ports.ts`）在 `pin()` 的范围内构造——库句柄、审计线写入口、
  引用计数都不进这里，出题与判分拿到手的永远是「已经开好的能力」。
  它跟着仓一起传，服务方法的参数表因此不必为端口多占一格：一次动作的输入就是这一份仓视图。
*/
export interface PracticeRepository {
  path: string;
  index: RepositoryIndex;
  analysis: RepositoryAnalysis;
  ports: ExercisePorts;
}

const kinds: ExerciseKind[] = SUPPORTED_EXERCISE_KINDS;

/**
  出题缓存的作用域（填进 `exercise_cache.content_version` 那一列）。

  失效轴 = 决定这道题内容的输入，分两档粒度：
  - 文件粒度：题面与标准答案只由目标文件决定时（change_localization / 代码题族 / llm 族），
    作用域带目标文件自己的 `contentHash`——改无关文件不会让整仓出题失效；
  - 全仓粒度：答案取决于整张依赖图的 impact_analysis，作用域仍用全仓 `versionStamp`
    （任一文件的 imports 变化都可能改答案，文件粒度在这里是假粒度）。

  旧索引文件没有 `contentHash` 时以 `repo:<versionStamp>` 充当该文件哈希，自动退回全仓粒度，
  不会出现「该失效没失效」。

  换模型（同一份代码在另一个模型上不是同一道题）、改题面提示词（口径版本）对两档都生效。
  图指纹（`graphStampOf`）只对全仓那一档：impact 答案出自 `impactRadius`，图可以在源码不动时被
  引擎判据换掉——图一变旧缓存行自动失效。这里只改缓存键：`exercise.contentVersion` 仍是真实的
  `versionStamp`，作答校验走 `contentHashes`（见 `staleDependencies`）。
 */
function exerciseScope(versionStamp: string, modelVersion: string, graphStamp: string): string {
  return `${versionStamp}#${graphStamp}#${EXERCISE_STEP.contractVersion}#${modelVersion}`;
}

/**
  图的指纹：入口清单 + import 边 + 跨文件调用边 + 类型派发边各取「参与判据的部分」排序后哈希。
  不数行号、不数符号：它们不影响 impact 答案，进键会让每次无关改动都重新出题。
  按 `analysis` 对象记忆化：一个请求里多处算键时不重复遍历整张图。
*/
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

/** 文件粒度作用域的「文件部分」：path@hash 逗号串。id 与缓存作用域共用它，保证二者同生同灭。 */
function depsFingerprint(deps: { path: string; hash: string }[]): string {
  return deps.map((dep) => `${dep.path}@${dep.hash}`).join(",");
}

/**
  文件粒度作用域：依赖文件指纹 + 题面口径版本 + 模型档（代码题再挂 runner 指纹）。
  三条出题路径（规则题、代码题、LLM 题）共用这一个构造。
  runner 指纹只对代码族加：理解题与主观题的答案不出自沙箱，换运行时不该作废它们的旧题；
  代码题的「缺陷版必挂」自证是在具体 runner 上验出来的，runner 一变就得重验。
*/
function fileScope(deps: { path: string; hash: string }[], modelVersion: string, runner?: string): string {
  return `${depsFingerprint(deps)}#${EXERCISE_STEP.contractVersion}#${modelVersion}${runner ? `#runner=${runner}` : ""}`;
}

/** 一道题依赖的文件清单及其哈希。查不到 contentHash（旧索引）时以全仓 versionStamp 兜底。 */
function exerciseDeps(repository: PracticeRepository, kind: ExerciseKind, value: unknown): { path: string; hash: string }[] {
  const hashOf = (path: string): string => repository.index.files.find((file) => file.path === path)?.contentHash ?? `repo:${repository.analysis.versionStamp}`;
  if (kind === "impact_analysis") return [];
  const unit = value as ImplementationUnit;
  return [{ path: unit.symbol.path, hash: hashOf(unit.symbol.path) }];
}

/**
  作答时效校验：带 `contentHashes` 的新题逐文件核对，返回已过期的依赖清单（空 = 仍可用）——
  只有这道题依赖的文件变了才拒绝作答，无关文件的修改不打扰已有题目；
  旧题（无此字段）维持全仓 versionStamp 比对，过期时返回一个非路径占位符。
*/
function staleDependencies(repository: PracticeRepository, exercise: Exercise): string[] {
  if (exercise.contentHashes?.length) {
    /**
      出题时记的是哪一档，就按哪一档比对：老索引没有逐文件 `contentHash`，记的是兜底串
      `repo:<versionStamp>`；拿逐文件哈希去比兜底串永远不等，这道题会此后再也答不了。
      反过来兜底档只该问「全仓动过没有」。
    */
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

  /**
    生成练习：目标单元与标准答案始终由静态分析产出（可判分）；
    传入 provider 时对题面 title/prompt 做一轮 LLM 润色（失败/未配置则用启发式题面）。
    family="llm" 走 LLM 出题族（tag 主题出题，一轮调用可拒绝，rubric 判分）。
    */
  async next(repository: PracticeRepository, requested: { kind?: ExerciseKind; targetUnitId?: string; family?: ExerciseFamily; tag?: string; tagId?: string; variantNonce?: number } = {}, provider?: LlmProvider, skills?: SkillsToolContext): Promise<Exercise> {
    if (requested.family === "llm") return await this.nextLlm(repository, requested, provider, skills);
    const modelVersion = provider?.modelVersion ?? "deterministic";
    if (!requested.kind && !requested.targetUnitId) {
      const due = repository.ports.progress.list()
        .filter((schedule) => schedule.dueAt <= new Date().toISOString())
        .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
      for (const schedule of due) {
        const stored = repository.ports.store.byId<StoredExercise>(schedule.exerciseId);
        // 跳过缓存里已不再支持的题型（如已移除的选型辩护）；时效判定见 `staleDependencies`
        if (stored && SUPPORTED_EXERCISE_KINDS.includes(stored.exercise.kind) && !staleDependencies(repository, stored.exercise).length) {
          repository.ports.audit.append("exercise_generated", { source: "review", kind: stored.exercise.kind, target_unit: stored.exercise.targetUnitId });
          return stored.exercise;
        }
      }
    }
    const mastery = repository.ports.progress.mastery();
    const target = this.pickTarget(repository, requested, mastery);
    if (!target) {
      const reason = "当前分析结果没有可生成的练习。请先重新导入仓库。";
      repository.ports.audit.append("exercise_declined", { family: requested.family ?? "comprehension", tag: requested.tagId ?? "", reason, stage: "no_target" });
      throw new Error(reason);
    }
    const deps = exerciseDeps(repository, target.kind, target.value);
    const scope = deps.length
      ? fileScope(deps, modelVersion, isCodeKind(target.kind) ? runnerFingerprint() : undefined)
      : exerciseScope(repository.analysis.versionStamp, modelVersion, graphStampOf(repository.analysis));
    const cached = repository.ports.store.get<StoredExercise>(scope, target.kind, target.id);
    if (cached) {
      // 缓存命中也要报当时润色过没有：旧行没这个字段读作 unknown（null），不事后猜测
      repository.ports.audit.append("exercise_generated", { source: "cache", kind: cached.exercise.kind, target_unit: cached.exercise.targetUnitId, polish: cached.polish ?? null, polish_failure: cached.polishFailure ?? null });
      return cached.exercise;
    }
    if (isCodeKind(target.kind)) return await this.nextCode(repository, target, provider, scope, deps, skills);
    let stored = this.createExercise(repository, target.kind, target.value, target.difficulty, deps);
    /**
      题面来源按三种成因分开记（模型改写成功 / 试了但失败 / 未配置模型），失败时把失败形状一起写，
      缓存命中上报时才分得清题面出自谁。
      */
    let polish: StoredExercise["polish"] = "not_configured";
    let polishFailure: string | null = null;
    if (provider) {
      const refined = await refineExerciseWithLlm(repository.path, stored.exercise, provider);
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
    repository.ports.store.put(scope, target.kind, target.id, stored);
    repository.ports.audit.append("exercise_generated", { source: "rule", kind: stored.exercise.kind, target_unit: stored.exercise.targetUnitId, polish, polish_failure: polishFailure });
    return stored.exercise;
  }

  /**
    代码族出题（`patch_edit` / `author_function`）：模型交「题面 + 下发件 + 参考解 + 测试 + 替身」，
    引擎在沙箱里跑两趟自证（参考解必过、下发件必挂）才允许落库——没自证过的题不出。
    每次真跑都写一行 `exercise_run`，被拒的也算：要分得开「没走到沙箱」与「沙箱说这题不行」。
    没配模型/预算已达上限时直接拒（与对话作用域同一纪律，不回落本地题面）。
    */
  private async nextCode(repository: PracticeRepository, target: PracticeTarget<unknown>, provider: LlmProvider | undefined, scope: string, deps: { path: string; hash: string }[], skills?: SkillsToolContext): Promise<Exercise> {
    const targetUnitId = target.id;
    if (!provider) {
      const reason = "代码题需要模型：题面、缺陷与测试都由模型设计，判分靠运行测试。当前没配模型，或本月预算已用完。";
      repository.ports.audit.append("exercise_declined", { family: "code", tag: "", reason, stage: "no_provider" });
      throw new Error(reason);
    }
    /**
      沙箱这一关必须走在付费之前：README 承诺「隔离探测不过则代码题整域禁用」，
      而 `runSandbox` 的 `SandboxUnavailableError` 要到模型已经出完一份题（≈6k token）才抛——
      在那台永远出不了题的机器上，每点一次「下一道题」都扣一次钱，账面还看着「沙箱不可用」。
      这里先探（探过就认缓存，不重复起 canary），不是 `enforced` 就直接拒，一行模型调用都不发。
    */
    const isolation = await ensureIsolation();
    if (isolation.level !== "enforced") {
      const reason = `沙箱当前不可用（${isolation.reason}），代码题整域禁用；这一趟没有调用模型，因此没有花费。`;
      repository.ports.audit.append("exercise_declined", { family: "code", tag: "", reason, stage: "sandbox_unavailable" });
      throw new Error(reason);
    }
    const kind = target.kind === "author_function" ? "author_function" : "patch_edit";
    const unit = target.value as ImplementationUnit;
    const generation = await generateCodeExercise({ repositoryPath: repository.path, unit, kind, provider, ...(skills ? { skills } : {}) });
    // 取过哪份出题技能先留痕：拒题的趟也真取过正文，账上不能只写「模型没出题」
    for (const read of generation.skillReads) repository.ports.audit.append("skill_read", { skill: read.skill, chars: read.chars, found: read.found });
    /**
      自证两跑逐条留痕，失败趟也要有行：`exercise_run` 是「沙箱真跑了」的唯一证据，
      只在成功时写会让「沙箱挂了」和「模型没出题」在记录里长成同一个样子。
    */
    const language = generation.ok ? generation.proposal.language : unit.symbol.language;
    for (const run of generation.runs) {
      repository.ports.audit.append("exercise_run", {
        stage: "validate-proposal", label: run.label, language,
        verdict_passed: run.verdict?.passed ?? null, verdict_failed: run.verdict?.failed ?? null,
        exit_code: run.exitCode, timed_out: run.timedOut,
        outcome: generation.ok ? "accepted" : generation.stage
      });
    }
    if (!generation.ok) {
      repository.ports.audit.append("exercise_declined", { family: "code", tag: "", reason: generation.reason, stage: generation.stage });
      throw new Error(generation.reason);
    }
    if (generation.usage) repository.ports.audit.append("token_usage", {
      input_tokens: generation.usage.inputTokens,
      output_tokens: generation.usage.outputTokens,
      cache_hit_tokens: generation.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "exercise_generate_code"
    });
    const proposal = generation.proposal;
    const exercise: Exercise = {
      // 与 LLM 族同理：答案（那组测试）出自模型，换模型/换 runner 就是另一道题，id 必须含 scope
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
      // 代码题的题面整份出自模型，这里记 llm 表示「没有规则版可回落」
      polish: "llm",
      polishFailure: null
    };
    repository.ports.store.put(scope, proposal.kind, targetUnitId, stored);
    repository.ports.audit.append("exercise_generated", { source: "code", kind: exercise.kind, target_unit: targetUnitId, polish: "llm", polish_failure: null });
    return exercise;
  }

  /**
    LLM 出题族：id = hash(repoId + 出题作用域 + tagId + variantNonce)，nonce=0 复用缓存题，
    换一题传 variantNonce+1 生成新题（旧题保留在缓存/复习记录里）。
    一轮调用内由 LLM 判定「能否出题」——拒绝理由与守门否决都记 journal（exercise_declined），不静默。
    */
  private async nextLlm(repository: PracticeRepository, requested: { tag?: string; tagId?: string; variantNonce?: number }, provider: LlmProvider | undefined, skills?: SkillsToolContext): Promise<Exercise> {
    const tag = (requested.tag ?? "").trim();
    if (!tag) throw new Error("出题需要先填主题名称；请在「＋ 配置」里填写。");
    if (!provider) throw new Error("出题用的模型现在用不了：没配模型，或本月预算已用完。");
    const nonce = Math.max(0, Math.floor(requested.variantNonce ?? 0));
    const tagKey = (requested.tagId ?? "").trim() || tag;
    const targetUnitId = `llm:${tagKey}:${nonce}`;
    // 候选选择提前到缓存查找之前：题面与答案全出自模型看到的摘录，作用域要按候选文件自己的哈希算
    const summaries = new Map(repository.ports.summaries.latest().map((row) => [row.path, row.summary]));
    const matched = selectTagCandidates(repository, tag, 3, summaries);
    // 词法零命中不再直接拒题：改从仓库全景挑素材（有摘要 / 改动热点 / 有可讲的函数），仍是一次调用、仍带行号锚点，守门照旧可核
    const candidates = matched.length ? matched : panoramaCandidates(repository, summaries);
    const selection = matched.length ? "tag" : "panorama";
    if (!candidates.length) {
      // 零素材也要留痕：记录要分得清「没走到模型」与「被模型拒绝」，才知道该修选料还是修提示词
      repository.ports.audit.append("exercise_declined", { family: "llm", tag, reason: `词法命中与仓库全景都挑不出可出题的源码文件（主题「${tag}」）。`, stage: "no_candidates" });
      throw new Error(`这个仓库现在找不到能出题的代码：「${tag}」。换一个更具体的主题，或先让它完成一次分析。`);
    }
    const hashOf = (path: string): string => repository.index.files.find((file) => file.path === path)?.contentHash ?? `repo:${repository.analysis.versionStamp}`;
    const deps = candidates.map((candidate) => ({ path: candidate.path, hash: hashOf(candidate.path) }));
    const scope = fileScope(deps, provider.modelVersion);
    const cached = repository.ports.store.get<StoredExercise>(scope, "llm_rubric", targetUnitId);
    if (cached && cached.exercise.kind === "llm_rubric") {
      repository.ports.audit.append("exercise_generated", { source: "cache", kind: cached.exercise.kind, target_unit: targetUnitId, tag, selection });
      return cached.exercise;
    }
    const generation = await generateExerciseWithLlm({ repositoryPath: repository.path, tag, candidates, provider, ...(skills ? { skills } : {}) });
    for (const read of generation.skillReads) repository.ports.audit.append("skill_read", { skill: read.skill, chars: read.chars, found: read.found });
    if (!generation.ok) {
      repository.ports.audit.append("exercise_declined", { family: "llm", tag, reason: generation.reason, stage: "llm_generate" });
      throw new Error(generation.reason);
    }
    if (generation.usage) repository.ports.audit.append("token_usage", {
      input_tokens: generation.usage.inputTokens,
      output_tokens: generation.usage.outputTokens,
      cache_hit_tokens: generation.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "exercise_llm_generate"
    });
    const issues = guardLlmProposal(generation.proposal, candidates);
    if (issues.length) {
      const reason = `模型出的题不合格：${issues.map((issue) => issue.message).join("；")}。`;
      repository.ports.audit.append("exercise_declined", { family: "llm", tag, reason, stage: "guard" });
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
    repository.ports.store.put(scope, "llm_rubric", targetUnitId, stored);
    repository.ports.audit.append("exercise_generated", { source: "llm", kind: exercise.kind, target_unit: targetUnitId, tag, selection });
    return exercise;
  }

  /**
    按需讲评：默认不花钱，判完之后由学习者点一次才发这一趟。
    只对代码题开放，且只回一段话——`passed`/`score` 归沙箱，这里一个字都不改（LLM 永不改判分结论）。
    不做时效校验是有意的：讲评吃的是冻结在缓存行里的那组测试与这次运行的输出，跟仓库现在长什么样无关。
    */
  async explain(repository: PracticeRepository, exerciseId: string, answer: ExerciseAnswer, provider: LlmProvider | undefined): Promise<{ explanation: string }> {
    if (!provider) throw new Error("讲评需要模型：当前没配模型，或本月预算已用完。");
    const stored = repository.ports.store.byId<StoredExercise>(exerciseId);
    if (!stored) throw new Error("练习不存在或已被清理；请重新生成练习。");
    if (stored.expected.type !== "harness") throw new Error("只有代码题有这一趟讲评：其余题型的反馈本来就出自规则或 rubric。");
    const slotPaths = new Set((stored.exercise.code?.files ?? []).map((file) => file.path));
    const learnerFiles = (answer.files ?? []).filter((file) => slotPaths.has(file.path) && file.contents.trim());
    if (!learnerFiles.length) throw new Error("没有收到代码，讲评无从说起。");
    const explained = await explainCodeAttempt({
      repositoryPath: repository.path,
      title: stored.exercise.title,
      prompt: stored.exercise.prompt,
      harness: stored.expected,
      learnerFiles,
      provider
    });
    if (explained.usage) repository.ports.audit.append("token_usage", {
      input_tokens: explained.usage.inputTokens,
      output_tokens: explained.usage.outputTokens,
      cache_hit_tokens: explained.usage.promptCacheHitTokens ?? null,
      provider: provider.modelVersion,
      scene: "exercise_explain"
    });
    return { explanation: explained.explanation };
  }

  async answer(repository: PracticeRepository, exerciseId: string, answer: ExerciseAnswer, provider?: LlmProvider): Promise<ExerciseResult> {
    const stored = repository.ports.store.byId<StoredExercise>(exerciseId);
    if (!stored) throw new Error("练习不存在或已被清理；请重新生成练习。");
    const stale = staleDependencies(repository, stored.exercise);
    if (stale.length) throw new Error(`这道题依赖的源码已更新（${stale.join("、")}）；请使用新版本重新生成练习。`);
    let graded = stored.expected.type === "rubric"
      ? await gradeRubric(stored, answer, provider, repository.ports.audit)
      : await grade(stored, answer, repository.ports.audit, repository.path);
    /**
      程序理解题（规则判分）：反馈解释交 LLM 润色；润色失败保留规则原文并显式标注 feedbackSource="rule"。
      代码题不在这里花钱——它的反馈就是测试计数，「讲一遍」按需由界面点一次才发一趟（见 explain），
      每次提交都自动润色等于把「按需」写回「默认」。
    */
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
    const review = scheduleSm2(previous, qualityForScore(graded.score), now);
    review.exerciseId = exerciseId;
    review.unitId = stored.exercise.targetUnitId;
    repository.ports.progress.save(review);
    repository.ports.audit.append("exercise_result", {
      exercise_id: exerciseId,
      target_unit_id: stored.exercise.targetUnitId,
      kind: stored.exercise.kind,
      score: graded.score,
      passed: graded.passed,
      grading_mode: stored.exercise.gradingMode,
      generation_source: stored.exercise.family === "llm" ? "llm_proposed" : "static",
      feedback_source: graded.feedbackSource ?? "rule"
    });
    return { ...graded, exerciseId, repositoryId: repository.index.repositoryId, targetUnitId: stored.exercise.targetUnitId, kind: stored.exercise.kind, gradingMode: stored.exercise.gradingMode, reviewedAt: now.toISOString(), review };
  }

  private pickTarget(repository: PracticeRepository, requested: { kind?: ExerciseKind; targetUnitId?: string }, mastery: MasteryRecord[]): PracticeTarget<unknown> | undefined {
    const availableKinds = requested.kind ? [requested.kind] : kinds;
    const attemptCount = mastery.reduce((sum, record) => sum + record.attempts, 0);
    const orderedKinds = requested.kind ? availableKinds : [...availableKinds.slice(attemptCount % availableKinds.length), ...availableKinds.slice(0, attemptCount % availableKinds.length)];
    for (const kind of orderedKinds) {
      const targets = this.targets(repository, kind);
      const restricted = requested.targetUnitId ? targets.filter((target) => target.id === requested.targetUnitId) : targets;
      if (requested.targetUnitId && restricted.length) return restricted[0];
      const selected = selectZpdTarget(restricted, mastery) as PracticeTarget<unknown> | undefined;
      if (selected) return selected;
    }
    return undefined;
  }

  private targets(repository: PracticeRepository, kind: ExerciseKind): PracticeTarget<unknown>[] {
    if (isCodeKind(kind)) {
      // 代码族两型共用同一批候选：patch_edit 拿它的真实现改缺陷，author_function 照它的签名重写一份等价实现。
      // 语言闸门在这里，沙箱不支持的语言不进候选，而不是出题时才报「跑不起来」。
      const supported = new Set(["typescript", "python", "java"]);
      return repository.analysis.implementations
        .filter((unit) => supported.has(unit.symbol.language))
        .map((unit) => ({ id: unit.id, title: unit.symbol.name, difficulty: unitDifficulty(unit), value: unit, kind }));
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
  // id 只含文件哈希部分（不含模型/口径版本）：静态题（change_localization / impact_analysis）的答案出自静态分析，
  // 换模型只换题面措辞，共用 id 不串答案；
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

async function grade(stored: StoredExercise, answer: ExerciseAnswer, audit: AuditSink, repositoryPath: string): Promise<GradeOutcome> {
  if (stored.expected.type === "set") return gradeSet(stored.expected.expectedIds, answer.selectedIds ?? []);
  if (stored.expected.type === "harness") return gradeHarness(stored, answer, audit, repositoryPath);
  // 旧缓存行（`{ type: "output" }`，已退役题型的口径）落在这里：当前出题路径不会再写它们；
  // 真读到了要明说「重新生成」，不能默默判错。
  throw new Error("该练习类型已不再支持；请重新生成练习。");
}

/**
  代码题判分：只由沙箱里那组冻结测试决定，模型一律不参与（`automatic: true` 的语义就在这里成立）。
  - 学习者交的文件只替换下发时那几个 path，测试与替身仍是出题时冻结的那一份 ⇒ 判分路径不读仓库源码；
  - 认「TESTS 通过 失败」那一行，不认异常：跑不出结论（没编译过、测试自己崩了）判 0 分并把 stderr 摘要如实交出去，
    它与「测试挂了」是两件事——混起来学习者会去改一个根本不存在的断言；
  - 分数 = 通过数 / 总断言数，与 `gradeSet` 同一个口径（分母是两边的并集，不是只数答对的）。
*/
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
  // journal 的 outcome 与返回给界面的 passed 取同一个布尔值：`TESTS 0 0`（一条断言都没有）时两者必须同向
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

/** rubric 判分（LLM 族）：LLM 拿参考答案与评分细则比对学习者回答；结果 automatic=false，绝不伪装成确定性判分。 */
async function gradeRubric(stored: StoredExercise, answer: ExerciseAnswer, provider: LlmProvider | undefined, audit: AuditSink): Promise<GradeOutcome> {
  if (!provider) throw new Error("这道题的判分需要模型：当前没配模型，或本月预算已用完。");
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
  // 分母取两边的并集（答对 + 答漏 + 答多）：判分与答案口径必须在同一条式子里。
  // 若只在期望项齐全时算分，会出现期望为空却多选了、score=1 而 passed=false，排期按满分推进、界面却显示没过。
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
    // 能出题的素材 = 进了依赖图的源码，扩展名判据由能力表派生（与 sourceOptions 同一份判据）
    .filter((file) => handledExtensions.has(file.extension))
    .map((file) => {
      const path = file.path;
      const symbols = (symbolsByPath.get(path) ?? []).map((symbol) => symbol.name.toLowerCase()).join(" ");
      const summary = (summaries.get(path) ?? "").toLowerCase();
      // 相关性闸门：路径/符号/摘要任一命中才算候选；零相关时按热点塞文件会产出与主题无关的候选
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

/**
  全景选料：主题词在路径、符号名与摘要上都没命中时的兜底。判据只用已有产物——有 L1 摘要、改动热点、
  有可讲的函数，三者打分排序；开窗用该文件里最大的那个函数，不再硬开 80 行。
  同一份产物下结果必须确定：否则每次出题都是新的缓存作用域，缓存等于没有。
 */
function panoramaCandidates(repository: PracticeRepository, summaries: Map<string, string>, limit = 3): GuardCandidate[] {
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

/** 摘录窗口：名字命中任一词元的符号里取分最高者（同分取更靠前的），按它的真实行区间开窗——固定行数的硬窗会把锚点旁边的无关函数一起端进去；无命中回落从第 1 行起的默认窗口。 */
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
  /**
    正解必须出现在选项里：正解只按「在不在索引里」认，扩展名闸门只管干扰项从哪儿捞。
    若正解也先过手写的扩展名白名单，非 JS 仓的答案路径会被当成「非源码」筛掉——
    学习者怎么选都不过，`missingIds` 永远非空。
    */
  const indexed = new Set(repository.index.files.map((file) => file.path));
  const preferred = [...new Set(preferredPaths)].filter((path) => indexed.has(path)).slice(0, limit);
  // 干扰项池的扩展名由共享能力表派生（`handledExtensions` 就是建图那一句判据），不在这里手写一份
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
