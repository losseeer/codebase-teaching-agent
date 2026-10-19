import type { TutorSettings } from "@codebase-tutor/shared";
import { budgetGate, crossRepoFor, searchCorpusFor } from "../../application/paid-turn.js";
import { externalAndSkills, recheckTurn } from "../../application/scoped-turn.js";
import { persistTeachingTurn, resolveTeachingState } from "../../application/teaching-turn.js";
import { threadJournalPayload } from "../../application/threads.js";
import { auditsFromResult, mcpCallPayload, recordAbortedAudits } from "../../application/turn-audit.js";
import { summarizeCost } from "../../cost/cost.js";
import { flattenCourseTree } from "../../coursetree/projection.js";
import { assembleContext } from "../../harness/context.js";
import { createSession, respondWithProvider } from "../../harness/harness.js";
import { scopedChatProviderOr422 } from "../gate.js";
import { beginScopedStream, failScopedTurn, replayTypewriter } from "../../http/sse.js";
import { deriveLearnerProfile } from "../../learner/model.js";
import { id } from "../../identity.js";
import { turnTextPayload } from "../../store/journal.js";
import { LlmAbortedError } from "../../llm/provider.js";
import { importer, repositoryOr404 } from "../../services.js";
import { dedupeFileReads } from "../../source/read-file.js";
import { createThread, latestThreadForNode, saveThreadState } from "../../store/chat-store.js";
import { Journal, readJournal } from "../../store/journal.js";
import { markThread } from "../../trace/context.js";
import { defaultTutorSettings, policyFor, validateSettings } from "../../tutor-settings/tutor-settings.js";
import type { FastifyInstance } from "fastify";

/**
  教学会话的建立与回合（SSE）：会话即线程，回合收尾要落正文、用量、复检与审计。
 */
export function registerTeachingRoutes(app: FastifyInstance): void {
app.post<{ Body: { repositoryId?: string; courseNodeId?: string; settings?: Partial<TutorSettings>; style?: unknown } }>("/api/sessions", async (request, reply) => {
  const mounted = importer.ensureMounted(request.body?.repositoryId ?? "");
  if (!mounted.ok) return reply.code(404).send({ error: mounted.message, reason: mounted.reason });
  const repository = mounted.repository;
  const node = flattenCourseTree(repository.course.root).find((item) => item.id === request.body?.courseNodeId);
  if (!node) return reply.code(404).send({ error: "课程节点不存在" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : undefined);
  const hasExplicitSettings = Boolean(request.body?.settings && Object.keys(request.body.settings).length) || typeof request.body?.style === "number";
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  let settings = hasExplicitSettings
    ? validateSettings({ ...defaultTutorSettings, ...request.body?.settings, style: requestedStyle })
    : learnerProfile.recommended.settings;
  const session = createSession(repository.index.repositoryId, node.id, settings);
  // 会话即线程：id 由 createSession 生成后原样落库，GUI 存的就是这个 id
  const thread = createThread({ repositoryPath: repository.path, repositoryId: repository.index.repositoryId, scope: "teach", id: session.id, courseNodeId: node.id, title: node.title });
  saveThreadState(repository.path, session.id, { settings: session.settings });
  const journal = new Journal(repository.path, repository.index.repositoryId);
  journal.append("session_created", threadJournalPayload(thread, "created"), session.id);
  journal.append("style_shift", { style: session.settings.style, pedagogy: session.settings.pedagogy, depth: session.settings.depth, trigger: "session_created" }, session.id);
  return reply.code(201).send({ session, recommendedSettings: learnerProfile.recommended, faded: learnerProfile.fadedByUnit[node.id] ?? learnerProfile.faded, policy: policyFor(session.settings), context: assembleContext({ node, policy: policyFor(session.settings), history: [], repositoryPath: repository.path, analysis: repository.analysis }) });
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
  const session = resolveTeachingState(request.params.sessionId);
  return session ?? reply.code(404).send({ error: "会话不存在" });
});

/** 该课程节点最近一次教学会话的 id（查 chat_session）：GUI 刷新后即使本地没存过 id，也能找回存量历史。 */
app.get<{ Params: { repositoryId: string }; Querystring: { nodeId?: string } }>("/api/repositories/:repositoryId/latest-session", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: "仓库未挂载" });
  const nodeId = request.query.nodeId ?? "";
  return { sessionId: nodeId ? latestThreadForNode(repository.path, repository.index.repositoryId, nodeId)?.id ?? null : null };
});

app.post<{ Params: { sessionId: string }; Body: { content?: string; settings?: Partial<TutorSettings>; style?: unknown; turnId?: unknown } }>("/api/sessions/:sessionId/messages", async (request, reply) => {
  const current = resolveTeachingState(request.params.sessionId);
  if (!current || !request.body?.content?.trim()) return reply.code(400).send({ error: "会话或消息无效" });
  // 教学侧的 sessionId 就是 chat_session 的线程 id，llm.log 直接沿用它做线程聚合
  markThread(current.id);
  /**
    URL 里没有 `:repositoryId`，懒挂载钩子够不到，这里补挂一次：
    会话还活在内存里、它的仓却已被 LRU 驱逐时，应该像别的仓路由那样把它挂回来，而不是回一句「课程节点不可用」。
    */
  const mounted = importer.ensureMounted(current.repositoryId);
  if (!mounted.ok) return reply.code(404).send({ error: mounted.message, reason: mounted.reason });
  const repository = mounted.repository;
  const node = flattenCourseTree(repository.course.root).find((item) => item.id === current.courseNodeId);
  if (!node) return reply.code(404).send({ error: "课程节点不可用" });
  const requestedStyle = request.body?.settings?.style ?? (typeof request.body?.style === "number" ? request.body.style : current.settings.style);
  const settings = validateSettings({ ...current.settings, ...request.body?.settings, style: requestedStyle });
  const styleChanged = JSON.stringify(settings) !== JSON.stringify(current.settings);
  const session = { ...current, style: settings.style, settings };
  // 与 map/practice 同一条闸门：没配模型、或本月预算已达到上限就在开火前 422，这一域没有本地兜底那一档
  const gate = budgetGate(repository.handle);
  const provider = scopedChatProviderOr422(reply, repository.handle, gate);
  if (!provider) return reply;
  const learnerProfile = deriveLearnerProfile(repository.index.repositoryId, readJournal(repository.path));
  const faded = learnerProfile.fadedByUnit[node.id] ?? learnerProfile.faded;
  // 与 map/practice 同款 SSE：过程提示与 delta 回放并入本请求的响应流
  const { send, turnHandle } = beginScopedStream(request, reply, "teach", request.body?.turnId);
  const crossFiles = new Map<string, number>();
  try {
    const outcome = await respondWithProvider(session, node, request.body.content.trim(), provider, faded, repository.path, {
      analysis: repository.analysis,
      search: searchCorpusFor(repository),
      cross: crossRepoFor(repository, crossFiles),
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
    persistTeachingTurn(repository.path, repository.index.repositoryId, node.id, node.title, outcome.session.id, [
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
    journal.append("loop_round", { scene: "teach", tool_rounds: outcome.toolRounds ?? 0, tool_reads: (outcome.fileReads ?? []).length, tool_searches: (outcome.codeSearches ?? []).length, tool_external: (outcome.mcpCalls ?? []).length, tool_skills: (outcome.skillReads ?? []).length }, session.id);
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
