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
  能回干净 JSON 的判断都在 `prepare*` 里，切流之后只抛错。
  `sessionId` 即 `chat_session` 的线程 id，URL 里没有 `:repositoryId`，挂载由用例补做。
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

/** 建会话：挂载 → 核教学域 → 定设置 → 建线程 → 两条审计 → 回首屏上下文。 */
export function createTeachingSession(input: {
  repositoryId?: string;
  scopeRef?: string;
  settings?: Partial<TutorSettings>;
  /** 风格档位：controller 已按「只有数字算填了」取过形。 */
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
  // 会话即线程：id 由 createSession 生成后原样落库。
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

/** 读一份会话：每次从 `chat_session` / `chat_message` 两张表装配。 */
export function readTeachingSession(sessionId: string): TeachingResult<{ session: TutorSession }> {
  const session = resolveTeachingState(sessionId);
  return session ? { ok: true, value: { session } } : fail("session-missing");
}

/** 发起前备好的这一回合：挂载项、会话、教学域、提问原文与画像读数。 */
export interface PreparedTeachingTurn {
  repository: ImportedRepository;
  session: TutorSession;
  scope: ScopeRef;
  question: string;
  /** 这一回合改了风格 / 教学法 / 深度中的任一项。 */
  styleChanged: boolean;
  faded: FadedState;
}

/** 回合发起前的全部判断：会话与提问成立 → 补挂仓 → 教学域存在 → 合并校验设置 → 取画像。 */
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

/** 回合收尾给界面的那一份料：done 帧除 `type` 之外的载荷。 */
export type TeachingTurnOutcome = {
  session: TutorSession;
  message: TutorMessage;
  policy: ReturnType<typeof policyFor>;
  cost: ReturnType<typeof summarizeCost>;
  provider: string;
};

/**
  教学回合这一趟：装配上下文 → 工具循环 → 复检 → 落库 → 审计线，再交回 done 帧的料。
  过程事件写进 controller 给的那条流。
  `monthlyBudgetUsd` 与预算闸门共用同一次读设置。
*/
export async function runTeachingTurn(turn: PreparedTeachingTurn, provider: LlmProvider, stream: ScopedTurnStream, monthlyBudgetUsd: number): Promise<TeachingTurnOutcome> {
  const { repository, session, scope, question } = turn;
  const crossFiles = new Map<string, number>();
  const outcome = await respondWithProvider(session, scope, question, provider, turn.faded, repository.path, {
    index: repository.index,
    analysis: repository.analysis,
    search: searchCorpusFor(repository),
    cross: crossRepoFor(repository, crossFiles),
    // 中断恢复按线程续跑；预算每轮调用前复查一次。
    checkpoint: turnCheckpointChannel({ repositoryPath: repository.path, threadId: session.id, scene: "teaching.turn" }),
    budgetGuard: turnBudgetGuard(repository.handle),
    onProgress: (progress) => stream.send({ type: "progress", payload: progress }),
    ...(await externalAndSkills()),
    ...(stream.signal ? { signal: stream.signal } : {})
  });
  // 中止赶在最后一趟返回之后到达时没人抛错：按作废收尾，不落库、不回放。
  if (stream.signal?.aborted) {
    recordUnfinishedTurn({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "teach", provider: provider.modelVersion, outcome: "aborted", threadId: outcome.session.id, audits: auditsFromResult(outcome) });
    throw new LlmAbortedError();
  }
  const journal = repository.audit;
  // 运行期复检先于落库与回放：落库、回放、turn_text 是同一份正文。
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
  // 回合正文与设置快照落库。
  persistTeachingTurn(repository.chatStore, repository.index.repositoryId, scope.ref, scopeTitle(scope), outcome.session.id, [
    { role: "user", content: question },
    { role: "assistant", content: outcome.assistant.content }
  ], { settings: outcome.session.settings });
  if (turn.styleChanged) journal.append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "manual" }, session.id);
  // 只在端点回报了 `usage` 时记 token_usage，与 map / practice 同一口径。
  if (outcome.usage) journal.append("token_usage", { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens, cache_hit_tokens: outcome.usage.promptCacheHitTokens ?? null, provider: outcome.provider, scene: "teach" }, session.id);
  // 回合文本落盘：问题与回复双边。
  journal.append("turn_text", turnTextPayload("teach", question, outcome.assistant.content), session.id);
  // read_file 审计与宏观设计同一事件类型；同路径归并为一条。
  for (const read of dedupeFileReads(outcome.fileReads ?? [])) {
    journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, masked: read.masked ?? 0, error: read.error ?? null }, session.id);
  }
  for (const search of outcome.codeSearches ?? []) {
    journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、"), segmented: search.segmented === true }, session.id);
  }
  for (const call of outcome.mcpCalls ?? []) journal.append("mcp_call", mcpCallPayload(call), session.id);
  for (const skill of outcome.skillReads ?? []) journal.append("skill_read", { skill: skill.skill, chars: skill.chars, found: skill.found }, session.id);
  // 回合摘要：只记工具循环的轮次与各类工具次数
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
