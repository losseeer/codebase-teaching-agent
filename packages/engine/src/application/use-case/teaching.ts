import type { FadedState, TutorMessage, TutorSettings, TutorSession } from "@codebase-tutor/domain";
import { defaultTutorSettings, policyFor, validateSettings } from "@codebase-tutor/domain";

import { crossRepoFor, searchCorpusFor, turnBudgetGuard } from "../orchestration/paid-turn.js";
import { externalAndSkills, recheckTurn } from "../orchestration/scoped-turn.js";
import { turnCheckpointChannel } from "../runtime/turn-checkpoint.js";
import { auditsFromResult, mcpCallPayload, recordUnfinishedTurn } from "../runtime/turn-audit.js";
import { persistTeachingTurn, resolveTeachingState } from "../orchestration/teaching-turn.js";
import { threadJournalPayload } from "../orchestration/threads.js";
import { summarizeCost } from "../../cost/cost.js";
import { assembleContext } from "../../turn/context-teaching.js";
import { createSession } from "../../turn/session.js";
import { respondWithProvider } from "../../turn/run-turn.js";
import { deriveLearnerProfile } from "../../learner/model.js";
import type { LlmProvider } from "../port/llm-provider.js";
import { LlmAbortedError } from "../port/llm-provider.js";
import { importer } from "../../infrastructure/composition-root.js";
import { dedupeFileReads } from "../../source/read-file.js";
import { type ScopeRef, parseScopeRef, scopeAvailable, scopeTitle } from "../../source/scope-ref.js";
import { turnTextPayload } from "@codebase-tutor/domain";
import type { ImportedRepository } from "../../importer/importer.js";
import type { ScopedTurnStream } from "./chat.js";

/**
  教学会话的建立、读取与回合（SSE）。
  检查都在 `prepare*` 里跑完，切流之后只抛错。
  `sessionId` 即 `chat_session` 的线程 id；URL 不带 repositoryId，挂载由用例补做。
*/
export type TeachingFailure =
  | { kind: "repository-missing"; message: string; reason: string }
  | { kind: "session-missing" }
  | { kind: "session-invalid" }
  | { kind: "scope-format" }
  | { kind: "scope-empty" }
  | { kind: "scope-gone" };

export type TeachingResult<T> = { ok: true; value: T } | { ok: false; failure: TeachingFailure };

type TeachingRejection = Exclude<TeachingFailure, { kind: "repository-missing" }>["kind"];

const fail = (kind: TeachingRejection): TeachingResult<never> => ({ ok: false, failure: { kind } });

const mountFailed = (result: { ok: false; message: string; reason: string }): TeachingResult<never> => ({ ok: false, failure: { kind: "repository-missing", message: result.message, reason: result.reason } });

/** 创建教学会话线程，并返回首屏上下文。 */
export function createTeachingSession(input: {
  repositoryId?: string;
  scopeRef?: string;
  settings?: Partial<TutorSettings>;
  /** 风格档位；只有数字算已填。 */
  style?: number;
}): TeachingResult<{
  session: TutorSession;
  recommendedSettings: ReturnType<typeof deriveLearnerProfile>["recommended"];
  faded: FadedState;
  policy: ReturnType<typeof policyFor>;
  context: string;
}> {
  const mounted = importer.ensureMounted(input.repositoryId ?? "");
  if (!mounted.ok) return mountFailed(mounted);
  const repository = mounted.repository;
  const scope = parseScopeRef(input.scopeRef ?? "");
  if (!scope) return fail("scope-format");
  if (!scopeAvailable(scope, repository.index)) return fail("scope-empty");
  const explicit = Boolean(input.settings && Object.keys(input.settings).length) || input.style !== undefined;
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, repository.audit.read());
  const settings = explicit
    ? validateSettings({ ...defaultTutorSettings, ...input.settings, style: input.settings?.style ?? input.style })
    : learnerProfile.recommended.settings;
  const session = createSession(repository.index.repositoryId, scope.ref, settings);
  // 会话 id 原样作为线程 id 落库
  const thread = repository.chatStore.createThread({ repositoryId: repository.index.repositoryId, scope: "teach", id: session.id, scopeRef: scope.ref, title: scopeTitle(scope) });
  repository.chatStore.saveThreadState(session.id, { settings: session.settings });
  const journal = repository.audit;
  journal.append("session_created", threadJournalPayload(thread, "created"), session.id);
  journal.append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "session_created" }, session.id);
  return {
    ok: true,
    value: {
      session,
      recommendedSettings: learnerProfile.recommended,
      faded: learnerProfile.faded,
      policy: policyFor(session.settings),
      context: assembleContext({ scope, policy: policyFor(session.settings), history: [], repositoryPath: repository.path, index: repository.index, analysis: repository.analysis })
    }
  };
}

/** 按线程 id 读取会话。 */
export function readTeachingSession(sessionId: string): TeachingResult<{ session: TutorSession }> {
  const session = resolveTeachingState(sessionId);
  return session ? { ok: true, value: { session } } : fail("session-missing");
}

/** 回合发起前备好的输入。 */
export interface PreparedTeachingTurn {
  repository: ImportedRepository;
  session: TutorSession;
  scope: ScopeRef;
  question: string;
  /** 这一回合改了风格 / 教学法 / 深度中的任一项。 */
  styleChanged: boolean;
  faded: FadedState;
}

/** 回合发起前的校验与装配。 */
export function prepareTeachingTurn(sessionId: string, input: { content?: string; settings?: Partial<TutorSettings>; style?: number }): TeachingResult<PreparedTeachingTurn> {
  const current = resolveTeachingState(sessionId);
  const question = input.content?.trim();
  if (!current || !question) return fail("session-invalid");
  const mounted = importer.ensureMounted(current.repositoryId);
  if (!mounted.ok) return mountFailed(mounted);
  const repository = mounted.repository;
  const scope = parseScopeRef(current.scopeRef);
  if (!scope || !scopeAvailable(scope, repository.index)) return fail("scope-gone");
  const settings = validateSettings({ ...current.settings, ...input.settings, style: input.settings?.style ?? input.style ?? current.settings.style });
  const styleChanged = JSON.stringify(settings) !== JSON.stringify(current.settings);
  return {
    ok: true,
    value: {
      repository,
      session: { ...current, style: settings.style, settings },
      scope,
      question,
      styleChanged,
      faded: deriveLearnerProfile(repository.index.repositoryId, repository.audit.read()).faded
    }
  };
}

/** 回合收尾的载荷：done 帧除 `type` 之外的字段。 */
export type TeachingTurnOutcome = {
  session: TutorSession;
  message: TutorMessage;
  policy: ReturnType<typeof policyFor>;
  cost: ReturnType<typeof summarizeCost>;
  provider: string;
};

/** 跑一个教学回合，返回 done 帧的载荷。 */
export async function runTeachingTurn(turn: PreparedTeachingTurn, provider: LlmProvider, stream: ScopedTurnStream, monthlyBudgetUsd: number): Promise<TeachingTurnOutcome> {
  const { repository, session, scope, question } = turn;
  const crossFiles = new Map<string, number>();
  const outcome = await respondWithProvider(session, scope, question, provider, turn.faded, repository.path, {
    index: repository.index,
    analysis: repository.analysis,
    search: searchCorpusFor(repository),
    cross: crossRepoFor(repository, crossFiles),
    checkpoint: turnCheckpointChannel({ repositoryPath: repository.path, threadId: session.id, scene: "teaching.turn" }),
    budgetGuard: turnBudgetGuard(repository.handle),
    onProgress: (progress) => stream.send({ type: "progress", payload: progress }),
    ...(await externalAndSkills()),
    ...(stream.signal ? { signal: stream.signal } : {})
  });
  // 末趟返回之后才到达的中止不会抛错，这里按作废收尾
  if (stream.signal?.aborted) {
    recordUnfinishedTurn({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "teach", provider: provider.modelVersion, outcome: "aborted", threadId: outcome.session.id, audits: auditsFromResult(outcome) });
    throw new LlmAbortedError();
  }
  const journal = repository.audit;
  // 复检先于落库与回放，正文三处同源
  outcome.assistant.content = recheckTurn({
    repository,
    journal,
    sessionId: outcome.session.id,
    scene: "teach",
    crossFiles,
    question,
    answer: outcome.assistant.content,
    style: outcome.session.settings.style
  }).answer;
  persistTeachingTurn(repository.chatStore, repository.index.repositoryId, scope.ref, scopeTitle(scope), outcome.session.id, [
    { role: "user", content: question },
    { role: "assistant", content: outcome.assistant.content }
  ], { settings: outcome.session.settings });
  if (turn.styleChanged) journal.append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "manual" }, session.id);
  // 端点回报 usage 时才记 token_usage
  if (outcome.usage) journal.append("token_usage", { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens, cache_hit_tokens: outcome.usage.promptCacheHitTokens ?? null, provider: outcome.provider, scene: "teach" }, session.id);
  journal.append("turn_text", turnTextPayload("teach", question, outcome.assistant.content), session.id);
  for (const read of dedupeFileReads(outcome.fileReads ?? [])) {
    journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, masked: read.masked ?? 0, error: read.error ?? null }, session.id);
  }
  for (const search of outcome.codeSearches ?? []) {
    journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、"), segmented: search.segmented === true }, session.id);
  }
  for (const call of outcome.mcpCalls ?? []) journal.append("mcp_call", mcpCallPayload(call), session.id);
  for (const skill of outcome.skillReads ?? []) journal.append("skill_read", { skill: skill.skill, chars: skill.chars, found: skill.found }, session.id);
  journal.append("loop_round", {
    scene: "teach",
    tool_rounds: outcome.toolRounds ?? 0,
    tool_reads: (outcome.fileReads ?? []).length,
    tool_searches: (outcome.codeSearches ?? []).length,
    tool_external: (outcome.mcpCalls ?? []).length,
    tool_skills: (outcome.skillReads ?? []).length,
    ...(outcome.resumedFromRound === undefined ? {} : { resumed_from_round: outcome.resumedFromRound }),
    ...(outcome.stoppedBy === undefined ? {} : { stopped_by: outcome.stoppedBy })
  }, session.id);
  journal.append("turn_context", { scene: "teach", conversation_folded: outcome.conversation.foldedMessages, conversation_recalled: outcome.conversation.recalledMessages }, session.id);
  return {
    session: outcome.session,
    message: outcome.assistant,
    policy: policyFor(session.settings),
    cost: summarizeCost(repository.path, monthlyBudgetUsd, session.id),
    provider: outcome.provider
  };
}
