import type { ChatScope } from "@codebase-tutor/shared";
import { externalToolSurface } from "../external/clients.js";
import { listSkills, readSkill, skillsBriefing } from "../external/skills.js";
import { appendMessages, getThread, readMessages } from "../store/chat-store.js";
import { Journal } from "../store/journal.js";
import { checkTurnInvariants, invariantTailNotice, screenReply } from "../eval/scorers.js";
import { dedupeFileReads } from "../source/read-file.js";
import type { ExternalToolContext, SkillsToolContext } from "../source/tool-loop.js";
import { traceEngine } from "../trace/engine-log.js";
import type { ScopedChatResult, ScopedChatTurn } from "../scopechat/scopechat.js";
import type { LlmProvider } from "../llm/provider.js";
import { turnTextPayload } from "../store/journal.js";
import { screenNotice } from "../eval/scorers.js";
import type { ImportedRepository } from "../importer/importer.js";
import { mcpCallPayload } from "./turn-audit.js";

/**
  一次作用域回合的收尾：线程上下文取数、正文落库、运行期不变量复检、审计线记账。
  这些以前长在 `server.ts` 里，于是「回合结束时到底写了哪几条账」只能靠读 HTTP 装配文件才知道，
  也任何人想在 HTTP 之外复用（比如批处理重放）都得把 fastify 拖进来。
*/

// ——— 从 server.ts 894-1026 搬来 ———
/**
  作用域回合的线程上下文三件套：核归属 → 从库里取历史。`threadId` 缺席即「单次提问」（不带历史、不落库）。
  收的是**已经过入参守卫的** threadId：解析原始 body 是传输层的事（`http/input.ts`），
  这一层再认 `unknown` 就等于让应用层去猜请求体的形状。
  */
export function scopedThreadTurn(repository: ImportedRepository, threadId: string | undefined, scope: ChatScope): { threadId: string | undefined; history: ScopedChatTurn[]; earlierQuestions: string[] } | undefined {
  if (!threadId) return { threadId: undefined, history: [], earlierQuestions: [] };
  const thread = scopedThread(repository, threadId, scope);
  if (!thread) return undefined;
  return { threadId: thread.id, ...threadScopedHistory(repository.path, thread.id) };
}

/**
  回合正文落库（用户问 + 助手答，全文不截断）：这是产品线，与 journal 的 `turn_text`（审计线，2000 字截断）
  是**有意的双写**——一份供模型下一轮读，一份供指标与裁判读。软删线程不会动这里的行，只让它查不到。

  `threadId` 缺席 = 单次提问，按设计不落库；**线程在但写不进去**（这一轮期间被软删、库写不动）是真丢正文：
  GUI 已经拿到回放，库里却查无此人，下次进会话就是「聊过但没记录」。静默跳过等于把失败说成成功，
  所以这里必须留下一条能在 engine.jsonl 查到的读数（`chat-store.appendMessages` 的契约也是这么写的）。
  */
export function persistScopedTurn(repositoryPath: string, scene: "map_chat" | "practice_chat", threadId: string | undefined, question: string, answer: string): void {
  if (!threadId) return;
  if (appendMessages(repositoryPath, threadId, [{ role: "user", content: question }, { role: "assistant", content: answer }])) return;
  traceEngine("degrade", { what: "turn_body_dropped", scene, thread_id: threadId });
  console.warn(`[engine] ${scene} 这一轮的正文没能写进线程 ${threadId}（线程已被删除或库写不动）；journal 的 turn_text 仍在，产品线缺这一行`);
}

/**
  运行期不变量复检（B 档第 2 刀的那三条，零 token / 纯函数 / 微秒级）。
  外部批评说「回合一旦生成就不再被复核」——这次改动把话收回来：合格也记一条 `turn_invariant`，
  分母因此运行时成立；引用没能核实时在正文尾部补一行明示，学习者读到的是被核过的文本。

  能在尾部补话而不打断体验，靠的是一个实现事实：三种作用域都是**模型算完之后分块回放**
  （`replayTypewriter`，块长 `TYPEWRITER_CHUNK`），不是真 token 流。哪天真流式了，这行提示就得改成独立事件（记在这里防忘）。

  判据与 `phaseB:eval` 第 4 节共用 `checkTurnInvariants` 同一个函数，不分两份实现。
  */
export function recheckTurn(input: {
  repository: ImportedRepository;
  journal: Journal;
  sessionId?: string;
  scene: "teach" | "map_chat" | "practice_chat";
  /**
    本回合经 `cross_repo_link` / 跨仓 read_file **由引擎亲手递给模型**的对端路径（裸路径 → 总行数）。
    没有这份登记，模型引用后端 controller 的行号会被判成「未在当前仓库核实」——那是引擎给它的证据，
    判它编造是假阳性；但只有登记过的路径算数，模型自己凭空写一个后端文件照样过不去。
   */
  crossFiles?: Map<string, number>;
  question: string;
  answer: string;
  style?: number;
}): { answer: string; failed: string[] } {
  // 先过筛再复检：判的必须是「用户将会看到的那一份」，且密钥不能等到下发之后才挡
  const screened = screenReply(input.answer);
  const verdict = checkTurnInvariants({
    sessionId: input.sessionId ?? "unscoped",
    at: new Date().toISOString(),
    question: input.question,
    answer: screened.text,
    style: input.style ?? 0,
    answerTruncated: false,
    scene: input.scene
  }, new Map<string, number>([...input.repository.index.files.map((file) => [file.path, file.lines] as [string, number]), ...(input.crossFiles ?? [])]));
  input.journal.append("turn_invariant", {
    scene: input.scene,
    applicable: verdict.applicable.join("、") || null,
    failed: verdict.failed.join("、") || null,
    evidence: Object.entries(verdict.evidence).map(([id, text]) => `${id}=${text}`).join(" ｜ ") || null,
    // 过筛只记数量与首个样例（不记原文——那正是不能外泄的东西）：审计线要能回答「这轮被改过没有」
    masked_secrets: screened.secrets || null,
    masked_paths: screened.paths || null,
    masked_samples: screened.samples.join("、") || null
  }, input.sessionId);
  const notice = `${screenNotice(screened) ?? ""}${invariantTailNotice(verdict) ?? ""}`;
  return { answer: notice ? `${screened.text}${notice}` : screened.text, failed: verdict.failed };
}

/** map_chat 回合的统一收尾（JSON 与 SSE 两条路由共用）：复检（零 token）→ 正文落库 → 审计线，三处读同一份文本。 */
export function finishMapChatTurn(repository: ImportedRepository, provider: LlmProvider, threadId: string | undefined, question: string, result: ScopedChatResult, crossFiles: Map<string, number>): void {
  const journal = new Journal(repository.path, repository.index.repositoryId);
  result.reply = recheckTurn({ repository, journal, sessionId: threadId, scene: "map_chat", question, answer: result.reply, crossFiles }).answer;
  persistScopedTurn(repository.path, "map_chat", threadId, question, result.reply);
  if (result.usage) journal.append("token_usage", {
    input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
    cache_hit_tokens: result.usage.promptCacheHitTokens ?? null, provider: provider.modelVersion, scene: "map_chat"
  }, threadId);
  // 同一轮对同一路径的重复读取（重试/换窗口）在 journal 归并为一条：审计回答「看过哪些文件」
  for (const read of dedupeFileReads(result.fileReads ?? [])) {
    journal.append("file_read", { path: read.path, lines: read.lines ?? null, truncated: read.truncated, denied: read.denied, masked: read.masked ?? 0, error: read.error ?? null }, threadId);
  }
  // 检索漏斗：搜了什么、命中多少、前几条落在哪——「先搜后读」的转化率要靠这条读数
  for (const search of result.codeSearches ?? []) {
    journal.append("code_search", { query: search.query, hits: search.hits, top_paths: search.topPaths.join("、"), segmented: search.segmented === true }, threadId);
  }
  // 外部工具与技能：一条调用一行，**失败也记**（连不上 / 超时 / 参数不合法 / server 报错是四种不同处置）
  for (const call of result.mcpCalls ?? []) journal.append("mcp_call", mcpCallPayload(call), threadId);
  for (const skill of result.skillReads ?? []) journal.append("skill_read", { skill: skill.skill, chars: skill.chars, found: skill.found }, threadId);
  // 作用域验收信号：降级次数是「上下文≠选中项」的负向代理指标（设计方案 §10 层2），必须留痕可聚合
  if (result.scopeDegraded) {
    journal.append("scope_degraded", { node_id: result.scopeDegraded.nodeId, scope_paths: result.scopeDegraded.scopePathsCount }, threadId);
  }
  journal.append("loop_round", { scene: "map_chat", decision: "deterministic", proposed: null, executed: null, tool_rounds: result.toolRounds, tool_reads: (result.fileReads ?? []).length, tool_searches: (result.codeSearches ?? []).length, tool_external: (result.mcpCalls ?? []).length, tool_skills: (result.skillReads ?? []).length }, threadId);
  journal.append("turn_text", turnTextPayload("map_chat", question, result.reply), threadId);
}

/**
  本轮的技能通道（2026-10-17 接入）。装了才给：**没装时工具清单与上下文逐字不变**，
  不加一个「技能不可用」的占位节点——每轮白付一句没人用的说明，还会诱导模型去找不存在的工具。
*/
export function skillsForTurn(): SkillsToolContext | undefined {
  const load = listSkills();
  const brief = skillsBriefing(load.skills);
  if (!brief) return undefined;
  if (load.skipped.length) traceEngine("degrade", { what: "skill_skipped", skipped: load.skipped.map((item) => `${item.dir}：${item.reason}`).join("、") });
  return { brief, bodyOf: (name, file) => readSkill(name, file) };
}

/**
  本轮的外部 MCP 工具面（2026-10-17 接入）。默认关：配置文件不存在就一个工具都不加。
  连不上不报错、只是不给——原因由 `GET /api/external` 说清（读侧不静默降级，也不为「可能用得上」先付 token）。
*/
export async function externalForTurn(): Promise<ExternalToolContext | undefined> {
  const surface = await externalToolSurface();
  if (!surface?.tools.length) return undefined;
  return { tools: surface.tools, call: surface.call };
}

/**
  两条外部能力一次取齐（map-chat JSON / map-chat SSE / 教学回合三个入口共用）。
  都缺省时回空对象——展开进去等于**一个字都不变**，这是「默认关闭」的实现方式，不是一道开关。
*/
export async function externalAndSkills(): Promise<{ skills?: SkillsToolContext; external?: ExternalToolContext }> {
  const skills = skillsForTurn();
  const external = await externalForTurn();
  return { ...(skills ? { skills } : {}), ...(external ? { external } : {}) };
}

// ——— 从 server.ts 339-367 搬来 ———
/**
  线程正文 → 模型上下文：最近 6 条进「最近对话」窗口，窗口外只留学习者提问作问题脉络。
  窗口大小就是下面这两个字面量（6 / 8）——**这里才是选行的地方**。scopechat 的
  `HISTORY_TURNS` / `EARLIER_QUESTIONS_MAX` 只在那一侧做渲染期再裁剪，对这里交出去的条数是恒等操作，
  所以调窗口要改本函数，只改那边不会跟着变（逐行截断确实只在那边）。

  它替换掉的是「客户端回传 history + earlierQuestions」那条通路（09-27 会话持久化）：
  进模型上下文的东西必须能在库里考据到——客户端临时拼的窗口正文既可能是旧的、也可能被改，
  与「上下文≠选中项」是同一类事故。
  */
export function threadScopedHistory(repositoryPath: string, threadId: string | undefined): { history: ScopedChatTurn[]; earlierQuestions: string[] } {
  const messages = threadId ? readMessages(repositoryPath, threadId) : [];
  const boundary = Math.max(0, messages.length - 6);
  return {
    history: messages.slice(boundary).map((message) => ({ role: message.role, content: message.content })),
    earlierQuestions: messages.slice(0, boundary).filter((message) => message.role === "user").slice(-8).map((message) => message.content)
  };
}

/**
  取线程并核归属：不在库里 / 已软删 / 属于别的仓库 / 属于别的作用域一律 `undefined`（调用方据此拒绝本轮）。
  跨作用域复用线程会把教学问答送入宏观设计的上下文，这种串味比一个 409 难查得多。
  */
export function scopedThread(repository: ImportedRepository, threadId: string | undefined, scope: ChatScope) {
  if (!threadId) return undefined;
  const thread = getThread(repository.path, threadId);
  if (!thread || thread.repositoryId !== repository.index.repositoryId || thread.scope !== scope) return undefined;
  return thread;
}
