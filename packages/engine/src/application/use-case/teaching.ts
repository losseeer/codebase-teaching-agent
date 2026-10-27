import type { FadedState, TutorMessage, TutorSettings, TutorSession } from "@codebase-tutor/domain";
import { defaultTutorSettings, policyFor, validateSettings } from "@codebase-tutor/domain";

import { crossRepoFor, searchCorpusFor, turnBudgetGuard } from "../paid-turn.js";
import { externalAndSkills, recheckTurn } from "../scoped-turn.js";
import { turnCheckpointChannel } from "../turn-checkpoint.js";
import { auditsFromResult, mcpCallPayload, recordUnfinishedTurn } from "../turn-audit.js";
import { persistTeachingTurn, resolveTeachingState } from "../teaching-turn.js";
import { threadJournalPayload } from "../threads.js";
import { summarizeCost } from "../../cost/cost.js";
import { assembleContext } from "../../turn/context-teaching.js";
import { createSession } from "../../turn/session.js";
import { respondWithProvider } from "../../turn/run-turn.js";
import { deriveLearnerProfile } from "../../learner/model.js";
import type { LlmProvider } from "../../adapter/outbound/llm/provider.js";
import { LlmAbortedError } from "../../adapter/outbound/llm/provider.js";
import { importer } from "../../infrastructure/composition-root.js";
import { dedupeFileReads } from "../../source/read-file.js";
import { type ScopeRef, parseScopeRef, scopeAvailable, scopeTitle } from "../../source/scope-ref.js";
import { createThread, saveThreadState } from "../../adapter/outbound/persistence/chat-store.js";
import { readJournal, turnTextPayload } from "../../adapter/outbound/persistence/journal.js";
import type { ImportedRepository } from "../../importer/importer.js";
import type { ScopedTurnStream } from "./chat.js";

/**
  教学会话的建立、读取与回合（SSE）。
  切线与 chat 同一条：能回干净 JSON 的判断（挂不上的仓、格式不对的教学域、这里有没有可问的代码、
  会话与消息成不成立、设置合不合法）全在 `prepare*` 里；切流之后只抛错，由 controller 的
  `failScopedTurn` 收尾。
  这一域的 `sessionId` 就是 `chat_session` 的线程 id，所以 URL 里没有 `:repositoryId`：
  懒挂载钩子够不到，挂载这一步由用例自己补做（见 `prepareTeachingTurn`）。
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

/** 建会话：挂载 → 核教学域 → 定设置（显式给的才校验，没给就用画像推荐）→ 建线程 → 两条审计 → 回首屏上下文。 */
export function createTeachingSession(input: {
  repositoryId?: string;
  scopeRef?: string;
  settings?: Partial<TutorSettings>;
  /** 老客户端把风格档位平铺在 body 根上：controller 已按「只有数字算填了」取过形。 */
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
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  const settings = explicit
    ? validateSettings({ ...defaultTutorSettings, ...input.settings, style: input.settings?.style ?? input.style })
    : learnerProfile.recommended.settings;
  const session = createSession(repository.index.repositoryId, scope.ref, settings);
  // 会话即线程：id 由 createSession 生成后原样落库，GUI 存的就是这个 id
  const thread = createThread({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scope: "teach", id: session.id, scopeRef: scope.ref, title: scopeTitle(scope) });
  saveThreadState(repository.path, session.id, { settings: session.settings });
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

/** 读一份会话（教学侧没有常驻内存态：每次从 `chat_session` / `chat_message` 两张表现装配）。 */
export function readTeachingSession(sessionId: string): TeachingResult<{ session: TutorSession }> {
  const session = resolveTeachingState(sessionId);
  return session ? { ok: true, value: { session } } : fail("session-missing");
}

/** 开火前备好的这一回合：挂载项、会话（带这一回合要用的设置）、教学域、提问原文与画像读数。 */
export interface PreparedTeachingTurn {
  repository: ImportedRepository;
  session: TutorSession;
  scope: ScopeRef;
  question: string;
  /** 这一回合改了风格/教学法/深度中的任何一项：改了才补一条 `style_shift`。 */
  styleChanged: boolean;
  faded: FadedState;
}

/**
  回合开火前的全部判断：会话与这句话成不成立 → 把仓补挂回来 → 教学域还在不在 → 合并校验设置 → 取画像。
  补挂的理由是这条 URL 里没有 `:repositoryId`：会话还活在库里、它的仓却已被 LRU 驱逐时，
  应该像别的仓路由那样把它挂回来，而不是回一句「作用域不可用」。
*/
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
      faded: deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path)).faded
    }
  };
}

/** 回合收尾要给界面的那一份料（done 帧除 `type` 之外的载荷，形状照原样）。 */
export type TeachingTurnOutcome = {
  session: TutorSession;
  message: TutorMessage;
  policy: ReturnType<typeof policyFor>;
  cost: ReturnType<typeof summarizeCost>;
  provider: string;
};

/**
  教学回合这一趟：装配上下文 → 工具循环 → 复检 → 正文与状态落库 → 审计线，最后把 done 帧的料交回去。
  过程事件写进 controller 给的那条流；中止若赶在最后一趟 LLM 之后才到，这一轮照样作废（不落库、不回放）。
  `monthlyBudgetUsd` 是开火闸门那一次读设置的另一半：闸门与本会话成本必须按同一份预算，不各读一趟。
*/
export async function runTeachingTurn(turn: PreparedTeachingTurn, provider: LlmProvider, stream: ScopedTurnStream, monthlyBudgetUsd: number): Promise<TeachingTurnOutcome> {
  const { repository, session, scope, question } = turn;
  const crossFiles = new Map<string, number>();
  const outcome = await respondWithProvider(session, scope, question, provider, turn.faded, repository.path, {
    index: repository.index,
    analysis: repository.analysis,
    search: searchCorpusFor(repository),
    cross: crossRepoFor(repository, crossFiles),
    // 中断恢复与预算复查都挂在工具循环上：前者按线程续跑，后者每轮开火前问一次
    checkpoint: turnCheckpointChannel({ repositoryPath: repository.path, threadId: session.id, scene: "teaching.turn" }),
    budgetGuard: turnBudgetGuard(repository.handle),
    onProgress: (progress) => stream.send({ type: "progress", payload: progress }),
    ...(await externalAndSkills()),
    ...(stream.signal ? { signal: stream.signal } : {})
  });
  // 中止可能赶在最后一趟 LLM 返回之后才到，那时没人抛错：点了停止就按「作废」收尾，不落库、不回放；
  // 断线（没点停止）才是另一条路，照常算完并落库
  if (stream.signal?.aborted) {
    recordUnfinishedTurn({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "teach", provider: provider.modelVersion, outcome: "aborted", threadId: outcome.session.id, audits: auditsFromResult(outcome) });
    throw new LlmAbortedError();
  }
  const journal = repository.audit;
  // 运行期复检（零 token）先于落库与回放：引用核不上就在正文尾部补一行明示，
  // 让落库的正文、回放的正文、journal 的 turn_text 是同一份
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
  // 回合正文 + 设置快照落库：GUI 重启后接着聊、以及「这一轮用的是哪档设置」都从这里取
  persistTeachingTurn(repository.path, repository.index.repositoryId, scope.ref, scopeTitle(scope), outcome.session.id, [
    { role: "user", content: question },
    { role: "assistant", content: outcome.assistant.content }
  ], { settings: outcome.session.settings });
  if (turn.styleChanged) journal.append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "manual" }, session.id);
  // 没有 `usage` 就是端点这趟没回报用量，这一轮不进 token_usage：估算值等于让不存在的钱吃掉预算，
  // 反过来把付费分支关掉；「有 usage 才记」与 map/practice 同一口径
  if (outcome.usage) journal.append("token_usage", { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens, cache_hit_tokens: outcome.usage.promptCacheHitTokens ?? null, provider: outcome.provider, scene: "teach" }, session.id);
  // 回合文本落盘：问题 + 回复双边，各截 2000 字并留痕
  journal.append("turn_text", turnTextPayload("teach", question, outcome.assistant.content), session.id);
  // 问答回合的 read_file 审计：与宏观设计作用域同一事件类型；同路径重复读取归并为一条
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
