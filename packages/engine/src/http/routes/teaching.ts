import type { TutorSettings } from "@codebase-tutor/shared";
import { budgetGate, crossRepoFor, searchCorpusFor, turnBudgetGuard } from "../../application/paid-turn.js";
import { externalAndSkills, recheckTurn } from "../../application/scoped-turn.js";
import { persistTeachingTurn, resolveTeachingState } from "../../application/teaching-turn.js";
import { threadJournalPayload } from "../../application/threads.js";
import { auditsFromResult, mcpCallPayload, recordAbortedAudits } from "../../application/turn-audit.js";
import { summarizeCost } from "../../cost/cost.js";
import { assembleContext } from "../../harness/context.js";
import { createSession, respondWithProvider } from "../../harness/harness.js";
import { scopedChatProviderOr422 } from "../gate.js";
import { beginScopedStream, failScopedTurn, replayTypewriter } from "../../http/sse.js";
import { deriveLearnerProfile } from "../../learner/model.js";
import { id } from "../../identity.js";
import { turnTextPayload } from "../../store/journal.js";
import { turnCheckpointChannel } from "../../application/turn-checkpoint.js";
import { LlmAbortedError } from "../../llm/provider.js";
import { importer, repositoryOr404 } from "../../services.js";
import { dedupeFileReads } from "../../source/read-file.js";
import { parseScopeRef, scopeAvailable, scopeTitle } from "../../source/scope.js";
import { createThread, saveThreadState } from "../../store/chat-store.js";
import { Journal, readJournal } from "../../store/journal.js";
import { markThread } from "../../trace/context.js";
import { defaultTutorSettings, policyFor, validateSettings } from "../../tutor-settings/tutor-settings.js";
import type { FastifyInstance } from "fastify";

/**
  教学会话的建立与回合（SSE）：会话即线程，回合收尾要落正文、用量、复检与审计。
 */
export function registerTeachingRoutes(app: FastifyInstance): void {
app.post<{ Body: { repositoryId?: string; scopeRef?: string; settings?: Partial<TutorSettings>; style?: unknown } }>("/api/sessions", async (request, reply) => {
  const mounted = importer.ensureMounted(request.body?.repositoryId ?? "");
  if (!mounted.ok) return reply.code(404).send({ error: mounted.message, reason: mounted.reason });
  const repository = mounted.repository;
  const scope = parseScopeRef(request.body?.scopeRef ?? "");
  if (!scope) return reply.code(400).send({ error: "教学域格式不对：需要 file:<仓内路径> 或 dir:<仓内目录>" });
  if (!scopeAvailable(scope, repository.index)) return reply.code(404).send({ error: "这里暂时没有可问的代码；请换一个文件或目录。" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : undefined);
  const hasExplicitSettings = Boolean(request.body?.settings && Object.keys(request.body.settings).length) || typeof request.body?.style === "number";
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  let settings = hasExplicitSettings
    ? validateSettings({ ...defaultTutorSettings, ...request.body?.settings, style: requestedStyle })
    : learnerProfile.recommended.settings;
  const session = createSession(repository.index.repositoryId, scope.ref, settings);
  // 会话即线程：id 由 createSession 生成后原样落库，GUI 存的就是这个 id
  const thread = createThread({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scope: "teach", id: session.id, scopeRef: scope.ref, title: scopeTitle(scope) });
  saveThreadState(repository.path, session.id, { settings: session.settings });
  const journal = new Journal(repository.path, repository.index.repositoryId);
  journal.append("session_created", threadJournalPayload(thread, "created"), session.id);
  journal.append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "session_created" }, session.id);
  return reply.code(201).send({ session, recommendedSettings: learnerProfile.recommended, faded: learnerProfile.faded, policy: policyFor(session.settings), context: assembleContext({ scope, policy: policyFor(session.settings), history: [], repositoryPath: repository.path, index: repository.index, analysis: repository.analysis }) });
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
  const session = resolveTeachingState(request.params.sessionId);
  return session ?? reply.code(404).send({ error: "会话不存在" });
});


app.post<{ Params: { sessionId: string }; Body: { content?: string; settings?: Partial<TutorSettings>; style?: unknown; turnId?: unknown } }>("/api/sessions/:sessionId/messages", async (request, reply) => {
  const current = resolveTeachingState(request.params.sessionId);
  if (!current || !request.body?.content?.trim()) return reply.code(400).send({ error: "会话或消息无效" });
  // 教学侧的 sessionId 就是 chat_session 的线程 id，llm.log 直接沿用它做线程聚合
  markThread(current.id);
  /**
    URL 里没有 `:repositoryId`，懒挂载钩子够不到，这里补挂一次：
    会话还活在内存里、它的仓却已被 LRU 驱逐时，应该像别的仓路由那样把它挂回来，而不是回一句「作用域不可用」。
    */
  const mounted = importer.ensureMounted(current.repositoryId);
  if (!mounted.ok) return reply.code(404).send({ error: mounted.message, reason: mounted.reason });
  const repository = mounted.repository;
  const scope = parseScopeRef(current.scopeRef);
  if (!scope || !scopeAvailable(scope, repository.index)) return reply.code(404).send({ error: "这个教学域已不可用；请重新选择一个文件或目录。" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : current.settings.style);
  const settings = validateSettings({ ...current.settings, ...request.body?.settings, style: requestedStyle });
  const styleChanged = JSON.stringify(settings) !== JSON.stringify(current.settings);
  const session = { ...current, style: settings.style, settings };
  // 与 map/practice 同一条闸门：没配模型、或本月预算已达到上限就在开火前 422，这一域没有本地兜底那一档
  const gate = budgetGate(repository.handle);
  const provider = scopedChatProviderOr422(reply, repository.handle, gate);
  if (!provider) return reply;
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  const faded = learnerProfile.faded;
  // 与 map/practice 同款 SSE：过程提示与 delta 回放并入本请求的响应流
  const { send, turnHandle } = beginScopedStream(request, reply, "teach", request.body?.turnId);
  const crossFiles = new Map<string, number>();
  try {
    const outcome = await respondWithProvider(session, scope, request.body.content.trim(), provider, faded, repository.path, {
      index: repository.index,
      analysis: repository.analysis,
      search: searchCorpusFor(repository),
      cross: crossRepoFor(repository, crossFiles),
      // 中断恢复与预算复查都挂在工具循环上：前者按线程续跑，后者每轮开火前问一次
      checkpoint: turnCheckpointChannel({ repositoryPath: repository.path, threadId: session.id, scene: "teaching.turn" }),
      budgetGuard: turnBudgetGuard(repository.handle),
      onProgress: (progress) => send({ type: "progress", payload: progress }),
      ...(await externalAndSkills()),
      ...(turnHandle.signal ? { signal: turnHandle.signal } : {})
    });
    // 中止可能赶在最后一趟 LLM 返回之后才到，那时没人抛错：点了停止就按「作废」收尾，不落库、不回放；
    // 断线（没点停止）才是另一条路，照常算完并落库
    if (turnHandle.signal?.aborted) {
      recordAbortedAudits({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "teach", threadId: outcome.session.id, audits: auditsFromResult(outcome) });
      throw new LlmAbortedError();
    }
    const journal = new Journal(repository.path, repository.index.repositoryId);
    // 运行期复检（零 token）先于落库与回放：引用核不上就在正文尾部补一行明示，
    // 让落库的正文、回放的正文、journal 的 turn_text 是同一份
    outcome.assistant.content = recheckTurn({
      repository,
      journal,
      sessionId: outcome.session.id,
      scene: "teach",
      crossFiles,
      question: request.body.content.trim(),
      answer: outcome.assistant.content,
      style: outcome.session.settings.style
    }).answer;
    // 回合正文 + 设置快照落库：GUI 重启后接着聊、以及「这一轮用的是哪档设置」都从这里取
    persistTeachingTurn(repository.path, repository.index.repositoryId, scope.ref, scopeTitle(scope), outcome.session.id, [
      { role: "user", content: request.body.content.trim() },
      { role: "assistant", content: outcome.assistant.content }
    ], { settings: outcome.session.settings });
    if (styleChanged) journal.append("style_shift", { style: settings.style, pedagogy: settings.pedagogy, depth: settings.depth, trigger: "manual" }, session.id);
    // 没有 `usage` 就是端点这趟没回报用量，这一轮不进 token_usage：估算值等于让不存在的钱吃掉预算，
    // 反过来把付费分支关掉；「有 usage 才记」与 map/practice 同一口径
    if (outcome.usage) journal.append("token_usage", { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens, cache_hit_tokens: outcome.usage.promptCacheHitTokens ?? null, provider: outcome.provider, scene: "teach" }, session.id);
    // 回合文本落盘：问题 + 回复双边，各截 2000 字并留痕
    journal.append("turn_text", turnTextPayload("teach", request.body.content.trim(), outcome.assistant.content), session.id);
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
    const cost = summarizeCost(repository.path, gate.monthlyBudgetUsd, session.id);
    replayTypewriter(send, outcome.assistant.content);
    send({ type: "done", session: outcome.session, message: outcome.assistant, policy: policyFor(settings), cost, provider: outcome.provider });
  } catch (error) {
    failScopedTurn({ send, repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scene: "teach", turnHandle, threadId: session.id, error, fallbackError: "教学回合失败" });
  } finally {
    turnHandle.dispose();
  }
  reply.raw.end();
});
}
