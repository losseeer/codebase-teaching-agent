import type { ScopedStreamProgress } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmMessage, LlmProvider, LlmTool, LlmUsage } from "../llm/provider.js";
import { LlmAbortedError, isLlmAborted } from "../llm/provider.js";
import { addUsage } from "../llm/usage.js";
import { hash } from "../ids.js";
import type { McpCallAudit } from "../integrations/clients.js";
import { READ_FILE_TOOL, executeReadFile, type FileReadRecord } from "./read-file.js";
import { SEARCH_CODE_TOOL, executeSearchCode, type CodeSearchRecord, type SearchCorpus } from "./search-code.js";
import { CROSS_REPO_LINK_TOOL } from "../depgraph/seams.js";
import { SET_DIAGRAM_TOOL } from "../diagram/set-diagram.js";
import { QUERY_FACTS_TOOL } from "../facts/query.js";
import { READ_SKILL_TOOL } from "../integrations/skills.js";
import { askBody, askUserToolFor, ASK_USER_TOOL_NAME, parseAsk, type AskFacet, type AskUserAudit } from "./ask-user.js";

/**
  read_file / search_code 工具循环（宏观设计 map 与教学 teaching 两个作用域共用）：

  - 预算硬上限是轮数与累计读成功的文件数；用尽时对未应答的 tool_call 明确回绝，再做一轮不带工具的收尾回答。
  - 传入 `search` 语料时额外提供 search_code（词法检索「文件在哪」，只回位置与职责），它同样受轮数上限约束。
  - messages[0] 恒为首轮 user 消息——provider 收到 messages 时忽略 user 字段，
    首轮 user 若不进 messages，工具调用后的轮次会同时丢失代码上下文与学习者提问。
  - 每轮调用前压缩回合上下文，口径见 `compactTurnContext`。
  - 每次 read_file（含拒绝与失败）返回审计记录，由调用方记 journal file_read。
  - `signal` 透传到每一轮 LLM 调用，并在开新一轮前检查：中止一律原样抛出 `LlmAbortedError`，
    不吞成「基于已有上下文直接回答」的收尾结论（那会把用户主动停止伪装成模型答完）。
  */

/** 工具循环的过程事件；类型取自 `shared` 的 `ScopedStreamProgress`，与 SSE 帧共用同一份词表。 */
export type ReadToolProgress = Extract<ScopedStreamProgress, { type: "thinking" | "reading" | "searching" }>;

export interface ReadToolLoopInput {
  provider: LlmProvider;
  /**
    仓库根：read_file 只能在此范围内读取。省略 = 这一轮没有文件面（练习答疑与出题走这一档），
    于是清单里只有 `read_skill` 与外部工具——「没有仓库路径」和「读不到文件」是两件事，前者是能力不给。
    */
  repoPath?: string;
  system: string;
  /** 首轮 user 消息（代码上下文 + 学习者提问） */
  user: string;
  maxTokens: number;
  /** 省略 = 用 provider 的默认采样温度（出题那一路以前就没给）。 */
  temperature?: number;
  maxRounds: number;
  /** 本次对话累计最多读几个文件：只数读成功的；被拒绝或失败的仍进 fileReads 审计，但不占额度。 */
  maxCalls: number;
  onProgress?: (progress: ReadToolProgress) => void;
  /** LLM 工作日志的场景标签（teaching.turn / map.chat），透传给每一轮调用 */
  scene?: string;
  /** 提供时额外开放 search_code 工具（词法检索定位文件）；不提供则模型只有 read_file。 */
  search?: SearchCorpus;
  /** 外部中止信号：透传给每一轮 LLM 调用，并在进入下一轮前检查（读文件是本地操作，不在此列）。 */
  signal?: AbortSignal;
  /** 跨仓访问，见 `CrossRepoContext`。不传 = 只有当前仓，工具清单不变。 */
  cross?: CrossRepoContext;
  /** 画布上那张图的结构改动。不传 = 这个作用域没有改图的权力，清单里不出现 `set_diagram`；教学与练习作用域都不给。 */
  diagram?: SetDiagramToolContext;
  /** 静态产物的只读门。不传 = 清单里没有 `query_facts`：产物层没算过的仓给了它只会每次回「这类产物不在册」。 */
  facts?: FactsToolContext;
  /** 技能正文的取用通道。不传 = 工具清单里没有 `read_skill`，系统提示词也不该出现技能清单。 */
  skills?: SkillsToolContext;
  /**
    回合内向用户提问的通道：只在本轮上下文确实缺某一格时才给（服务层算缺哪一格）。
    不给 = 清单里没有 `ask_user`，回合行为与从前逐字一致。一次回合最多问一次（循环内的本地判据）。
  */
  ask?: { facets: AskFacet[] };
  /**
    外部 MCP 工具面，默认不给：每条外部工具的 schema 都要进每一轮请求的 token，
    还会改变请求前缀的形状（前缀缓存按请求头部算）。服务层只在配置文件里真有启用的 server 时才传。
  */
  external?: ExternalToolContext;
  /** 回合检查点通道（见 `TurnCheckpointChannel`）。不给就是纯内存回合，行为与从前逐字一致。 */
  checkpoint?: TurnCheckpointChannel;
  /**
    每轮开火前的预算闸门：回一句「为什么不能再来一轮」，`undefined` = 可以继续。
    到线时不再开新的一轮工具调用，只回绝掉挂着的调用并做一次不带工具的收尾——
    闸门管的是「别再往上加轮次」，把已经读到的东西咽回去不算答完。
  */
  budgetGuard?: () => string | undefined;
  /**
    预算到线或轮次用完就中断（不出成品、留快照、由用户点重试），而不是回绝后硬答一句。
    只有长回合的宏观设计开这一档：问答类上限本来就低，到限时「基于已读到的答一句」比白跑一趟有价值。
  */
  interruptAtLimit?: boolean;
}

/** 技能通道：清单（`brief`）与取正文的通道必须同时给或同时不给——只给一半就是让模型找一个不存在的工具。 */
export interface SkillsToolContext {
  /** 进上下文的那段清单（名字 + 一句描述 + 「先取正文再照做」那句约束）。 */
  brief: string;
  /**
    取技能正文（`file` 省略 = `SKILL.md`）或该技能目录里的附属文件（正文用相对路径引用它们）。
    回 `undefined` = 没这个技能或没这个文件；工具把这句照实回给模型，不编一段看着像正文的东西。
  */
  bodyOf: (name: string, file?: string) => string | undefined;
}

/**
  外部 MCP 工具面。清单与调用都由服务层实现，本循环不认识 SDK、也不认识子进程。
  ⚠️ `call` 不许抛：外部 server 是别人写的程序，超时、崩溃、回错误都要先变成一句给模型看的实话，
  否则一个第三方故障会把整个回合掀掉。
*/
export interface ExternalToolContext {
  /** 已带 `mcp__<server>__<tool>` 前缀的清单，直接并进本轮工具数组。 */
  tools: LlmTool[];
  call: (name: string, argumentsJson: string) => Promise<{ text: string; audit: McpCallAudit }>;
  /** 一个回合最多打几次外部调用（默认 3）。读文件额度是本地事实的额度，外部的不算进去。 */
  maxCalls?: number;
}

/**
  跨仓访问上下文。只在地址簿里还有别的仓时才传——没有第二个仓时三个工具一个都不多给，工具清单与提示词不变。

  - `roots`：仓名 → 仓库根路径。`read_file` 靠它换根，守卫整套复用（仓内边界、拒读名单、软链接复核都在根路径这一层）；
  - `corpusOf`：仓名 → 检索语料，模型真搜时才现取（取一份语料意味着把那个仓挂进内存）。
    回 `undefined` 表示这仓没产物、只能读不能搜，工具会照实回一句；
  - `links`：当前仓 ↔ 对端仓按归一化 URL 配好的接缝清单。零 token，代价是读两边源码，所以只在模型真调用时才算。
  */
export interface CrossRepoContext {
  roots: Record<string, string>;
  corpusOf?: (repoName: string) => SearchCorpus | undefined;
  links?: (repoName: string, filter: string) => string;
  /** 跨仓读取的独立上限：总额度之外再掐一道，防止模型把两个仓都翻一遍。 */
  maxCrossReads?: number;
  /** 每递出一份对端内容就回报一次（仓名 + 该仓内的裸路径）。回合收尾的引用复检靠它留痕：见 `server.ts` 的 `recheckTurn`。 */
  onHandedOut?: (repoName: string, path: string) => void;
}

/**
  改这张图的落地通道：闭包由服务层给，`apply` 回实际落盘后的状态或拒写原因。
  `inventory` 是画布现场——有副作用的工具必须先看见现状，否则只能猜 id、猜「那条边」指哪条。
*/
export interface SetDiagramToolContext {
  apply: (argumentsJson: string) => string;
  inventory?: string;
}

/** 产物查询通道：闭包由服务层给（它才有 db 句柄与仓 id），工具循环不认识 SQLite 与 payload 形状。 */
export interface FactsToolContext {
  /** 一句「产物在册情况」，随上下文常驻；不给就只有工具清单那一行。 */
  inventory?: string;
  apply: (argumentsJson: string) => string;
}

/** 按「给了哪些通道」现做工具清单：跨仓参数与 cross_repo_link 只在真有对端时出现；没有仓库根时文件面一个都不给。 */
function toolsFor(input: Pick<ReadToolLoopInput, "repoPath" | "search" | "cross" | "diagram" | "skills" | "external" | "facts" | "ask">): LlmTool[] {
  const { cross, diagram, skills, external } = input;
  const names = cross ? Object.keys(cross.roots) : [];
  const withRepo = (tool: LlmTool, extra: string): LlmTool => {
    const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>;
    return {
      ...tool,
      description: `${tool.description} 跨仓时给 repo 参数（${extra}），省略即当前仓。`,
      parameters: { ...tool.parameters, properties: { ...properties, repo: { type: "string", description: `其他仓的名字，可选；本仓请省略。可用值：${names.join(" / ")}` } } }
    };
  };
  const tools: LlmTool[] = [];
  if (input.repoPath) {
    tools.push(names.length ? withRepo(READ_FILE_TOOL, "读对端实现") : READ_FILE_TOOL);
    if (input.search) tools.push(names.length ? withRepo(SEARCH_CODE_TOOL, "在对端仓里定位文件") : SEARCH_CODE_TOOL);
    if (cross?.links) tools.push(CROSS_REPO_LINK_TOOL);
  }
  // 提问排在取证之后、写侧之前：先把能自己查的查了，确实缺的那一格才开口问
  if (input.ask?.facets.length) tools.push(askUserToolFor(input.ask.facets));
  // 写侧工具只在服务层给了闭包时才出现：教学与练习作用域都不该有改图能力
  if (diagram) tools.push(SET_DIAGRAM_TOOL);
  if (skills) tools.push(READ_SKILL_TOOL);
  // 产物门同样要有文件面才有意义：没有仓库根，它能查的「这个文件的产物」根本无从指认
  if (input.repoPath && input.facts) tools.push(QUERY_FACTS_TOOL);
  // 外部工具原样并进清单：描述里已带「【外部 <server>】」前缀，模型分得清这是别人的程序
  if (external?.tools.length) tools.push(...external.tools);
  return tools;
}

/** 取参数里的一个字符串字段（选仓、接缝过滤都用它；解析失败一律回空串，按默认路径走）。 */
function readArg(argumentsJson: string, key: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    return typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
  } catch {
    return "";
  }
}

/**
  回合被中止时随异常带走的「这一轮真做过什么」：中止按作废收尾（不落正文、不回放、不写 turn_text），
  但读过的文件、搜过的查询、打过的外部工具是已经发生的事实——跟着异常一起丢掉，journal 就留下
  「这一轮什么都没干」的假账。走 symbol 键：provider 与 GUI 都不该看见这份旁证。
*/
export interface ToolLoopAudits {
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  skillReads: { skill: string; chars: number; found: boolean }[];
  mcpCalls: McpCallAudit[];
  rounds: number;
  /** 到抛出那一刻为止已发生的 token 用量：那一发已经跑完并计费，中止或失败都不能把它从账上抹掉。 */
  usage?: LlmUsage;
}

const auditsKey = Symbol("codebaseTutor.toolLoopAudits");

export function toolLoopAuditsOf(error: unknown): ToolLoopAudits | undefined {
  return error && typeof error === "object" ? (error as Record<symbol, unknown>)[auditsKey] as ToolLoopAudits | undefined : undefined;
}

function attachToolLoopAudits(error: unknown, audits: ToolLoopAudits): void {
  if (!error || typeof error !== "object") return;
  (error as Record<symbol, unknown>)[auditsKey] = audits;
}

export interface ReadToolLoopResult {
  completion: LlmCompletion;
  usage?: LlmUsage;
  /** 实际发生的工具调用轮数（预算打满提前收尾的轮也算）。 */
  rounds: number;
  fileReads: FileReadRecord[];
  /** 本次对话的 search_code 调用审计（不合并去重——同一查询反复搜本身就是信号）。 */
  codeSearches: CodeSearchRecord[];
  /** 取过的技能正文。`found: false` 也记：模型在清单上找一个不存在的技能，是这份清单与提示词漂移的读数。 */
  skillReads: { skill: string; chars: number; found: boolean }[];
  /** 外部 MCP 工具的实际调用（一条一次，失败也记）。正文不在这里，只有字符数与指纹。 */
  mcpCalls: McpCallAudit[];
  /** 本次回合是从检查点续跑起来的（恢复时该轮从头重跑，但已读到的正文不再重付）。 */
  resumedFromRound?: number;
  /** 回合被预算闸掐断过；没这个字段就是正常答完或轮数/额度用尽。 */
  stoppedBy?: TurnStopReason;
  /**
    本轮向用户提了一个问题并就地收尾：`completion.text` 已是「问句 + 可选项」那一行，
    这一格给的是结构化的那一份（done 载荷与审计都读它）。
  */
  asked?: AskUserAudit;
  /** 模型试过提问但被判据挡下的最后一句原因（参数不合法、超字、本轮已问过）：审计要分得清「没问」和「问不出来」。 */
  askRefused?: string;
  /** 本轮被中断（预算到线或轮次用完）：没有成品，`detail` 就是界面那句话的原因，快照留着等用户点重试。 */
  interrupted?: TurnInterrupt;
}

/**
  一个 super-step（一次工具轮）结束时的回合状态——恢复它就是恢复「读到哪儿了」。
  刻意把审计一起装进去：续跑后这一回合仍然要能如实交代它真读过哪些文件。
*/
/** 回合被什么掐断：`budget` = 预算到线、`rounds` = 工具轮次用完、`reads` = 读文件额度用完（三种都不是模型答完）。 */
export type TurnStopReason = "budget" | "rounds" | "reads";

/** 长回合到限时的中断结论：本轮不出成品，`detail` 是给用户看的那一句原因（也是重试气泡上那句话的来源）。 */
export interface TurnInterrupt {
  reason: "budget" | "rounds";
  detail: string;
}

export interface TurnLoopState {
  messages: LlmMessage[];
  rounds: number;
  succeededReads: number;
  crossReads: number;
  externalCalls: number;
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  skillReads: { skill: string; chars: number; found: boolean }[];
  mcpCalls: McpCallAudit[];
}

/**
  回合检查点通道（照 LangGraph 的 checkpoint 语义：一行 = 一个 super-step 的快照，同一线程续跑）。
  循环只管什么时候写、写什么，存哪儿由服务层给闭包。三条口径：
  - 回合正常收尾就 `clear`：留着的行只该是「进程没了/抛异常」的残局；
  - 用户主动停止也 `clear`：那一轮按作废收尾，替他续跑是违背他的意图（见 journal 的 turn_aborted）；
  - 写失败不掀回合：检查点是省钱的旁路，不是回合的前提。
*/
export interface TurnCheckpointChannel {
  /** 上一回合留下的状态；`inputHash` 对不上（换了提问、模型或系统提示词）就回 `undefined`，宁可不续跑。 */
  restore: (inputHash: string) => { round: number; state: TurnLoopState } | undefined;
  save: (inputHash: string, state: TurnLoopState, stoppedReason?: string) => void;
  clear: () => void;
}

export async function completeWithReadTool(input: ReadToolLoopInput): Promise<ReadToolLoopResult> {
  const { provider, system, maxTokens, temperature } = input;
  const tools = toolsFor(input);
  const available = tools.map((tool) => tool.name).join(" 与 ");
  const crossNames = input.cross ? Object.keys(input.cross.roots) : [];
  const messages: LlmMessage[] = [{ role: "user", content: input.user }];
  const fileReads: FileReadRecord[] = [];
  const codeSearches: CodeSearchRecord[] = [];
  const skillReads: { skill: string; chars: number; found: boolean }[] = [];
  const mcpCalls: McpCallAudit[] = [];
  let rounds = 0;
  let succeededReads = 0;
  let crossReads = 0;
  let externalCalls = 0;
  let asked: AskUserAudit | undefined;
  let askRefused: string | undefined;
  let interrupted: TurnInterrupt | undefined;
  let usage: LlmUsage | undefined;
  const audits = (): ToolLoopAudits => ({ fileReads, codeSearches, skillReads, mcpCalls, rounds, usage });
  const snapshot = (): TurnLoopState => ({ messages, rounds, succeededReads, crossReads, externalCalls, fileReads, codeSearches, skillReads, mcpCalls });
  let resumedFromRound: number | undefined;
  let stoppedBy: TurnStopReason | undefined;
  let completion: LlmCompletion;
  // 指纹把「同一个问题」钉住：线程续得上、提问也必须是同一句，否则接的是别人的中间状态
  const inputHash = hash(`${provider.modelVersion}:${system}:${input.user}`);
  try {
    const restored = input.checkpoint?.restore(inputHash);
    if (restored) {
      messages.splice(0, messages.length, ...restored.state.messages);
      rounds = restored.state.rounds;
      succeededReads = restored.state.succeededReads;
      crossReads = restored.state.crossReads;
      externalCalls = restored.state.externalCalls;
      fileReads.push(...restored.state.fileReads);
      codeSearches.push(...restored.state.codeSearches);
      skillReads.push(...restored.state.skillReads);
      mcpCalls.push(...restored.state.mcpCalls);
      resumedFromRound = restored.round;
      // 恢复的是「第 N 轮做完」的状态，接下来开第 N+1 轮：这一次带工具，续在同一线程的上下文之后
      input.onProgress?.({ type: "thinking", round: rounds + 1 });
      compactTurnContext(messages);
      completion = await provider.complete({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
    } else {
      input.onProgress?.({ type: "thinking", round: 1 });
      completion = await provider.complete({ system, user: input.user, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
    }
  } catch (error) {
    attachToolLoopAudits(error, audits());
    throw error;
  }
  usage = completion.usage;
  try {
  while (completion.toolCalls?.length) {
    // 中止检查点：上一轮的 LLM 已返回，若此时用户已经停了，就绝不再开新一轮（也不落收尾调用）。
    if (input.signal?.aborted) throw new LlmAbortedError();
    const budgetStop = input.budgetGuard?.();
    // 读文件额度只在有文件面时才算：出题与练习答疑没有 read_file，`maxCalls` 给 0 不该被读成「额度用完」。
    const fileQuotaSpent = Boolean(input.repoPath) && succeededReads >= input.maxCalls;
    const roundsSpent = rounds >= input.maxRounds;
    // 长回合到限就中断（不出成品，交给用户点重试）：只有宏观设计开这一档——问答类上限本来就低，
    // 到限硬答一句比白跑一趟划算，而 10 轮还没完通常意味着它陷在取证里，硬答出来的东西更不可信。
    if (input.interruptAtLimit && (budgetStop || roundsSpent)) {
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
      const detail = budgetStop ?? `工具轮次已用完（${rounds} 轮）`;
      // 未应答的 tool_call 先回一句实话再存快照：带着悬挂调用的消息数组下次发出去会被协议层直接拒
      for (const call of completion.toolCalls) messages.push({ role: "tool", toolCallId: call.id, content: `这一轮在这里中断：${detail}。接着做就从这里继续，已读过的内容不必重读。` });
      interrupted = { reason: budgetStop ? "budget" : "rounds", detail };
      stoppedBy = budgetStop ? "budget" : "rounds";
      break;
    }
    if (budgetStop || roundsSpent || fileQuotaSpent) {
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
      // 到闸时说的是**真正到限的那一项**。轮次用完时读文件额度常常还剩着，两种情况混成同一句「读文件上限」，
      // 模型只会把这句错话转述给学习者（实测读数：3 轮 / 只读了 2 个文件，上限是 4）。
      const refusal = budgetStop
        ? `${budgetStop}请基于已读到的正文直接回答，缺什么就照实说缺什么。`
        : fileQuotaSpent
          ? "已达到本次对话的读文件上限，请基于已有上下文直接回答。"
          : `本次对话的工具轮次已用完（${rounds} 轮）${input.repoPath ? `；读文件额度还剩 ${input.maxCalls - succeededReads} 次，但没有下一轮了` : ""}。请基于已读到的正文直接回答，缺什么就照实说缺什么。`;
      if (budgetStop) stoppedBy = "budget";
      else if (roundsSpent) stoppedBy = "rounds";
      else stoppedBy = "reads";
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: refusal });
      }
      input.onProgress?.({ type: "thinking", round: rounds + 2 });
      // 这是本回合最后一次调用：折叠换来的省没有下一轮可享，把刚读到的正文抽走只会让这一回合交不出东西。
      // 所以早期轮次的工具原文留着（reasoning 照丢，那才是账单大头）。
      compactTurnContext(messages, { keepToolResults: true });
      completion = await provider.complete({ system, messages, maxTokens, temperature, scene: input.scene, signal: input.signal });
      usage = addUsage(usage, completion.usage);
      break;
    }
    rounds += 1;
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
    for (const call of completion.toolCalls) {
      if (call.name === CROSS_REPO_LINK_TOOL.name) {
        // 零 token 实时计算：代价是读两边源码（几十毫秒），所以只在模型真开口要跨仓落点时才算一次
        const repo = readArg(call.argumentsJson, "repo");
        const content = !input.cross?.links ? "当前没有可配对的其他仓。"
          : !crossNames.includes(repo) ? `未知仓库「${repo}」；可配对的其他仓：${crossNames.join(" / ")}`
            : input.cross.links(repo, readArg(call.argumentsJson, "filter"));
        messages.push({ role: "tool", toolCallId: call.id, content });
        continue;
      }
      if (call.name === SEARCH_CODE_TOOL.name && (input.search || input.cross?.corpusOf)) {
        const repo = readArg(call.argumentsJson, "repo");
        const corpus = repo ? input.cross?.corpusOf?.(repo) : input.search;
        if (!corpus) {
          // 说清「这个仓能读不能搜」，否则模型会以为工具坏了而反复重试
          messages.push({ role: "tool", toolCallId: call.id, content: repo
            ? `仓「${repo}」没有可检索的产物（可能还没导入完成），但可以用 read_file 带 repo="${repo}" 直接读它的文件。`
            : "当前作用域未开放 search_code。" });
          continue;
        }
        input.onProgress?.({ type: "searching", query: readQueryHint(call.argumentsJson) });
        const outcome = executeSearchCode(corpus, call.argumentsJson);
        codeSearches.push(repo ? { ...outcome.audit, query: `${outcome.audit.query}（仓 ${repo}）` } : outcome.audit);
        messages.push({ role: "tool", toolCallId: call.id, content: outcome.content });
        continue;
      }
      if (call.name === SET_DIAGRAM_TOOL.name) {
        // 结构改动一次一回执：落成了什么、被降了几条边、或为什么整次拒写
        messages.push({ role: "tool", toolCallId: call.id, content: input.diagram?.apply(call.argumentsJson) ?? "这个作用域没有改这张图的权力。" });
        continue;
      }
      if (call.name === QUERY_FACTS_TOOL.name) {
        messages.push({ role: "tool", toolCallId: call.id, content: input.facts?.apply(call.argumentsJson) ?? "这个作用域没开放静态产物查询。" });
        continue;
      }
      if (call.name === READ_SKILL_TOOL.name && input.skills) {
        const skill = readSkillHint(call.argumentsJson);
        const file = readSkillFileHint(call.argumentsJson);
        const body = input.skills.bodyOf(skill, file);
        // 「取到了但正文是空的」与「没有这份技能」是两个读数：用 Boolean(body) 会把前者判成后者，
        // 模型于是回用户一句「这个技能不存在」——那是假话
        const found = body !== undefined;
        skillReads.push({ skill: file ? `${skill}/${file}` : skill, chars: body?.length ?? 0, found });
        messages.push({ role: "tool", toolCallId: call.id, content: found ? (body || "（这份技能装好了，但正文是空的：只有 frontmatter，没有可照做的步骤。）") : `没有「${skill}」这份技能${file ? `或它目录里的 ${file}` : ""}；清单上的名字以外都不要用。` });
        continue;
      }
      if (call.name === ASK_USER_TOOL_NAME) {
        if (!input.ask?.facets.length) {
          messages.push({ role: "tool", toolCallId: call.id, content: "这一轮没有向用户提问的通道（缺的那一格上下文里已经有了）。请直接作答。" });
          continue;
        }
        const attempt = parseAsk(call.argumentsJson, input.ask.facets);
        if (!attempt.ok) {
          askRefused = attempt.reason;
          messages.push({ role: "tool", toolCallId: call.id, content: attempt.reason });
          continue;
        }
        if (asked) {
          askRefused = "一个回合最多问一次";
          messages.push({ role: "tool", toolCallId: call.id, content: "本轮已经问过一句了，不能再问第二句。请基于已读到的内容作答，把没核实的部分写明。" });
          continue;
        }
        // 提问即收尾：这句之后不回灌 tool_result、不再发第二次调用，未应答的 tool_call 就留在 messages 末尾
        asked = attempt.ask;
        break;
      }
      if (input.external?.tools.some((tool) => tool.name === call.name)) {
        const cap = input.external.maxCalls ?? 3;
        if (externalCalls >= cap) {
          // 照实说额度用完了，不写成工具故障
          messages.push({ role: "tool", toolCallId: call.id, content: `外部工具一个回合最多打 ${cap} 次，额度已用完。请基于已拿到的外部内容回答，并说明哪些部分没核实。` });
          continue;
        }
        externalCalls += 1;
        const outcome = await input.external.call(call.name, call.argumentsJson);
        mcpCalls.push(outcome.audit);
        messages.push({ role: "tool", toolCallId: call.id, content: outcome.text });
        continue;
      }
      if (call.name !== READ_FILE_TOOL.name) {
        messages.push({ role: "tool", toolCallId: call.id, content: `未知工具 ${call.name}；只支持 ${available}。` });
        continue;
      }
      const repo = readArg(call.argumentsJson, "repo");
      // 仓名由模型给出：`__proto__`、`constructor` 这类原型属性名在普通对象上取得到真值，会被当成可访问的仓库往下读并把整回合抛死
      const roots = input.cross?.roots;
      const root = repo ? (roots && Object.hasOwn(roots, repo) ? roots[repo] : undefined) : input.repoPath;
      if (!root) {
        messages.push({ role: "tool", toolCallId: call.id, content: input.repoPath
          ? `未知仓库「${repo}」；可访问：当前仓${crossNames.length ? ` / ${crossNames.join(" / ")}` : "（地址簿里没有其他仓，跨仓请省略 repo 参数）"}。`
          : "这一轮没有开放文件读取，只有技能正文可取（read_skill）。请照清单取正文后直接作答。" });
        continue;
      }
      if (repo && crossReads >= (input.cross?.maxCrossReads ?? 2)) {
        messages.push({ role: "tool", toolCallId: call.id, content: `跨仓读取最多 ${input.cross?.maxCrossReads ?? 2} 个文件，额度已用完。请基于已读到的对端内容回答，并说明哪些部分没核实。` });
        continue;
      }
      // 读文件额度逐条判：轮首那次判据（上面 `succeededReads >= input.maxCalls`）只挡得到「下一轮」，
      // 模型在同一轮里连发十个 read_file 时，不在这里挡就真读十个——「本次最多读 N 个」就成了空话。
      if (succeededReads >= input.maxCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: "已达到本次对话的读文件上限，请基于已有上下文直接回答。" });
        continue;
      }
      input.onProgress?.({ type: "reading", path: repo ? `${repo}/${readPathHint(call.argumentsJson)}` : readPathHint(call.argumentsJson) });
      const outcome = executeReadFile(root, call.argumentsJson);
      // 审计与正文都要带上仓名：journal 的 file_read 只有一个 path 字段，不带仓名就分不出这是哪个仓的文件
      fileReads.push(repo ? { ...outcome.audit, path: `${repo}/${outcome.audit.path}` } : outcome.audit);
      if (!outcome.audit.denied) {
        succeededReads += 1;
        if (repo) {
          crossReads += 1;
          input.cross?.onHandedOut?.(repo, outcome.audit.path);
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, content: repo ? `【来自仓 ${repo}】\n${outcome.content}` : outcome.content });
    }
    // 问了就收尾：这一份不写检查点（刀 1 没有「等用户回答再接着算」的语义，留着快照只会在下次误续跑）
    if (asked) break;
    // 一个 super-step 落一份快照：进程在这之后被杀掉，下一次同线程同问题的请求就从这里接上
    input.checkpoint?.save(inputHash, snapshot());
    input.onProgress?.({ type: "thinking", round: rounds + 1 });
    compactTurnContext(messages);
    completion = await provider.complete({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
    usage = addUsage(usage, completion.usage);
  }
  if (interrupted) {
    // 中断不是「答完了」：留一份写明原因的快照，用户点重试就是同一句重发，输入哈希相同 ⇒ 从这里接上，读过的不重付
    input.checkpoint?.save(inputHash, snapshot(), "interrupted");
  } else {
    // 答完了：留着检查点只会在下次误续跑一个已经结束的回合
    input.checkpoint?.clear();
  }
  // 提问这一轮交出去的成品就是问句：正文 = 问句 + 可选项，落库、回放、journal 三处仍读同一份文本
  if (asked) completion = { ...completion, text: askBody(asked) };
  return { completion, usage, rounds, fileReads, codeSearches, skillReads, mcpCalls, ...(resumedFromRound === undefined ? {} : { resumedFromRound }), ...(stoppedBy === undefined ? {} : { stoppedBy }), ...(asked === undefined ? {} : { asked }), ...(askRefused === undefined ? {} : { askRefused }), ...(interrupted === undefined ? {} : { interrupted }) };
  } catch (error) {
    // 「读过哪些文件、搜过什么、调过哪些外部工具」是已发生的事实，中止与失败两条路都要把它带出循环
    attachToolLoopAudits(error, audits());
    if (isLlmAborted(error)) {
      // 用户主动停止 = 这一轮作废，检查点跟着作废（替他续跑是违背他的意图）
      input.checkpoint?.clear();
    } else {
      // 其它异常（端点 500、进程被 OOM 杀之前的这一趟）留下残局并写明为什么没走完
      input.checkpoint?.save(inputHash, snapshot(), "error");
    }
    throw error;
  }
}

/**
  只开放 `read_skill`（以及外部工具）的最小循环：出题与练习答疑没有文件面，但技能正文要能按需取。
  两轮 = 取一份正文 + 作答；再多就是拿一次出题的钱买一次搜索。没有装技能时这条路径根本不会被走到。
*/
export function completeWithSkillTool(input: Omit<ReadToolLoopInput, "repoPath" | "maxRounds" | "maxCalls" | "search" | "cross" | "diagram" | "facts">): Promise<ReadToolLoopResult> {
  return completeWithReadTool({ ...input, maxRounds: 2, maxCalls: 0 });
}

/** 技能取用读数：一条 = 模型真取过一份正文（`found:false` 表示清单上没这个名字）。 */
export interface SkillReadAudit {
  skill: string;
  chars: number;
  found: boolean;
}

/**
  「装了技能就能取正文，没装就单轮」的收口：两条路的返回形状统一在这里，调用点不必各写一套分支。
  没给 `skills` 时走的就是原来那一趟 `provider.complete`，请求体逐字不变——清单每轮都付费，
  所以「默认关 = 不加」在这里同样成立。
*/
export async function completeWithOptionalSkills(input: {
  provider: LlmProvider;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  scene: string;
  skills?: SkillsToolContext;
}): Promise<{ text: string; usage?: LlmUsage; skillReads: SkillReadAudit[] }> {
  if (!input.skills) {
    const response = await input.provider.complete({
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      scene: input.scene
    });
    return { text: response.text, usage: response.usage, skillReads: [] };
  }
  const loop = await completeWithSkillTool({
    provider: input.provider,
    user: input.user,
    maxTokens: input.maxTokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    scene: input.scene,
    // 清单由这里并进去：调用点只说「有技能通道」，不必各自再拼一遍文案（五处各拼一次迟早漂）
    system: `${input.system}\n\n${input.skills.brief}`,
    skills: input.skills
  });
  return { text: loop.completion.text, usage: loop.usage, skillReads: loop.skillReads };
}

/** 读取 read_skill 参数里的 name（仅用于审计与回话；解析失败按空名走，工具会回「没有这份技能」）。 */
function readSkillHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name.trim() : "";
  } catch {
    return "";
  }
}

/** 读取 read_skill 参数里的 file（附属文件相对路径；没给就取正文）。 */
function readSkillFileHint(argumentsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { file?: unknown };
    const file = typeof parsed.file === "string" ? parsed.file.trim() : "";
    return file || undefined;
  } catch {
    return undefined;
  }
}

/** 读取 read_file 参数里的 path（仅用于进度提示，不参与校验）。 */
function readPathHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { path?: unknown };
    return typeof parsed.path === "string" ? parsed.path : "";
  } catch {
    return "";
  }
}

/** 读取 search_code 参数里的 query（仅用于进度提示，不参与校验）。 */
function readQueryHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { query?: unknown };
    return typeof parsed.query === "string" ? parsed.query : "";
  } catch {
    return "";
  }
}

/**
  回合内压缩（每轮开火前跑一次，就地改 messages）。两条口径：

  1. **reasoning 一律丢**。推理内容服务的是「当轮怎么决定下一步」，下一轮用不上，而它是账单大头。
     唯一例外是最近一次工具调用那条 assistant：DeepSeek thinking + tools 要求原样回传，少了直接 400（见 `llm/provider.ts`）。
  2. **工具结果只完整保留最近 `TOOL_CONTEXT_KEEP_ROUNDS` 轮**，更早的换成占位符。
     占位符必须保住开头那行身份（哪个文件、第几到第几行、隐去几处密钥）：模型据此仍能说「我读过 X 的前 N 行」，
     既不会误以为自己没读过而重复读同一段，也不会把折叠说成读取失败。
     tool_calls 本身留着——摘掉它后面那条 tool 消息就悬空了，协议不认。

  折叠换来的省要有下一轮才享受得到，所以到闸那一次调用传 `keepToolResults`：
  最后一次调用把正文抽走，省的是一个不存在的成本，代价是这一回合交不出东西。
*/
/** 工具结果完整保留最近几轮：更早的正文可再生（再调一次同一个工具就有），不值得逐轮重付。 */
export const TOOL_CONTEXT_KEEP_ROUNDS = 2;
/** 折叠后保留的身份行取自结果开头，最多两行：首行整行保留，第二行起受 200 字符上限；再多就成了一段小摘录，折叠白折。 */
const MASK_HEAD_CHARS = 200;

function headLinesOf(content: string): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of content.split("\n")) {
    if (kept.length && used + line.length + 1 > MASK_HEAD_CHARS) break;
    kept.push(line);
    used += line.length + 1;
    if (kept.length >= 2) break;
  }
  return kept.join("\n");
}

export function compactTurnContext(messages: LlmMessage[], options: { keepToolResults?: boolean; keepRounds?: number } = {}): void {
  const keepRounds = Math.max(1, options.keepRounds ?? TOOL_CONTEXT_KEEP_ROUNDS);
  const roundStarts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === "assistant" && messages[index].toolCalls?.length) roundStarts.push(index);
  }
  if (!roundStarts.length) return;
  const newestRound = roundStarts[roundStarts.length - 1];
  /*
    折叠分界线 = 保留窗口里最早那一轮的起点，分界线之前的工具结果才折叠。
    轮数没超出窗口时它就是第一轮自己——窗口前只剩首条 user 消息，等于什么都不折。
  */
  const foldBoundary = roundStarts[Math.max(0, roundStarts.length - keepRounds)];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && index !== newestRound) message.reasoningContent = undefined;
    if (options.keepToolResults || index >= foldBoundary) continue;
    if (message.role === "tool" && message.content.length > MASK_HEAD_CHARS) {
      message.content = `${headLinesOf(message.content)}\n…（这一轮的其余结果已折叠：需要正文就再调一次同一个工具。）`;
    }
  }
}
