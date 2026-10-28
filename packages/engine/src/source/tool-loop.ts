import type { ScopedStreamProgress } from "@codebase-tutor/contract";

import type { LlmCompletion, LlmMessage, LlmProvider, LlmTool, LlmUsage } from "../application/port/llm-provider.js";
import { LlmAbortedError, isLlmAborted } from "../application/port/llm-provider.js";
import { addUsage } from "../adapter/outbound/llm/usage.js";
import { hash } from "@codebase-tutor/platform";
import type { McpCallAudit } from "@codebase-tutor/domain";
import { READ_FILE_TOOL, executeReadFile, type FileReadRecord } from "./read-file.js";
import { SEARCH_CODE_TOOL, executeSearchCode, type CodeSearchRecord, type SearchCorpus } from "./search-code.js";
import { CROSS_REPO_LINK_TOOL } from "../seams/seams.js";
import { SET_DIAGRAM_TOOL } from "../diagram/set-diagram.js";
import { QUERY_FACTS_TOOL } from "../facts/query.js";
import { READ_SKILL_TOOL } from "../adapter/outbound/integrations/skills.js";
import { askBody, askUserToolFor, ASK_USER_TOOL_NAME, parseAsk, type AskClaimAudit, type AskFacet, type AskResume, type AskUserAudit } from "./ask-user.js";

/**
  read_file / search_code 工具循环，宏观设计与教学两个作用域共用。
  硬上限是工具轮数与累计读成功的文件数；用尽时回绝未应答的 tool_call，再做一轮不带工具的收尾。
  messages[0] 恒为首轮 user 消息：provider 带 messages 的请求会忽略 user 字段。
*/

/** 工具循环发出的过程帧，不含正文帧 `delta` 与包装层的 `progress`。 */
export type ReadToolProgress = Exclude<ScopedStreamProgress, { type: "delta" } | { type: "progress" }>;

export interface ReadToolLoopInput {
  provider: LlmProvider;
  /** 仓库根：read_file 只在此范围内读取；省略表示本轮不开放文件面工具。 */
  repoPath?: string;
  system: string;
  /** 首轮 user 消息（代码上下文 + 学习者提问） */
  user: string;
  maxTokens: number;
  /** 省略 = 用 provider 的默认采样温度。 */
  temperature?: number;
  maxRounds: number;
  /** 本次对话最多读几个文件：只计读成功的；被拒绝或失败仍进 fileReads 审计但不占额度。 */
  maxCalls: number;
  onProgress?: (progress: ReadToolProgress) => void;
  /** LLM 工作日志的场景标签（teaching.turn / map.chat），透传给每一轮调用 */
  scene?: string;
  /** 提供时开放 search_code 工具（词法检索定位文件）。 */
  search?: SearchCorpus;
  /** 外部中止信号：透传给每一轮 LLM 调用，并在进入下一轮前检查。 */
  signal?: AbortSignal;
  /** 跨仓访问，见 `CrossRepoContext`；不传表示只有当前仓。 */
  cross?: CrossRepoContext;
  /** 画布那张图的结构改动通道；不传则工具清单里没有 `set_diagram`。 */
  diagram?: SetDiagramToolContext;
  /** 静态产物的只读门；不传则清单里没有 `query_facts`。 */
  facts?: FactsToolContext;
  /** 技能正文的取用通道；不传则清单里没有 `read_skill`。 */
  skills?: SkillsToolContext;
  /** 回合内向用户提问的通道；只在服务层判定上下文缺格时给出，一个回合最多问一次。 */
  ask?: { facets: AskFacet[]; resume?: AskResume };
  /** 外部 MCP 工具面；默认不给，工具 schema 会进每轮请求并改变缓存键前缀。 */
  external?: ExternalToolContext;
  /** 回合检查点通道，见 `TurnCheckpointChannel`；不传表示纯内存回合。 */
  checkpoint?: TurnCheckpointChannel;
  /** 每轮工具调用前的预算闸门：回一句「为什么不能再开一轮」，`undefined` = 可继续。 */
  budgetGuard?: () => string | undefined;
  /** 预算或轮次到限时中断本轮（不出成品、留快照），而不是回绝后收尾。 */
  interruptAtLimit?: boolean;
}

/** 技能通道：`brief` 与 `bodyOf` 必须同时给或同时不给。 */
export interface SkillsToolContext {
  /** 进上下文的那段清单（名字 + 一句描述 + 「先取正文再照做」）。 */
  brief: string;
  /** 取技能正文（`file` 省略 = `SKILL.md`）或该技能目录里的附属文件；回 `undefined` = 没有。 */
  bodyOf: (name: string, file?: string) => string | undefined;
}

/** 外部 MCP 工具面：清单与调用都由服务层实现，本循环不感知 SDK 与子进程。 */
export interface ExternalToolContext {
  /** 已带 `mcp__<server>__<tool>` 前缀的清单，直接并进本轮工具数组。 */
  tools: LlmTool[];
  /** 不许抛：外部 server 的超时、崩溃、错误须先变成一句给模型看的文本。 */
  call: (name: string, argumentsJson: string) => Promise<{ text: string; audit: McpCallAudit }>;
  /** 一个回合最多几次外部调用（默认 3）。 */
  maxCalls?: number;
}

/** 跨仓访问上下文：只在地址簿里还有别的仓时才传。 */
export interface CrossRepoContext {
  /** 仓名 → 仓库根路径；`read_file` 靠它换根，仓内边界与拒读守卫整套复用。 */
  roots: Record<string, string>;
  /** 仓名 → 检索语料，模型真搜时才现取；回 `undefined` 表示这仓只能读不能搜。 */
  corpusOf?: (repoName: string) => SearchCorpus | undefined;
  /** 当前仓与对端仓按归一化 URL 配好的接缝清单，零 token、调用时才计算。 */
  links?: (repoName: string, filter: string) => string;
  /** 跨仓读取的独立上限。 */
  maxCrossReads?: number;
  /** 每递出一份对端内容回报一次（仓名 + 该仓内的裸路径）。 */
  onHandedOut?: (repoName: string, path: string) => void;
}

/** 改这张图的落地通道：`apply` 由服务层给出，回实际落盘后的状态或拒写原因。 */
export interface SetDiagramToolContext {
  apply: (argumentsJson: string) => string;
  /** 画布现场快照。 */
  inventory?: string;
}

/** 产物查询通道：闭包由服务层给出，工具循环不认识 SQLite 与 payload 形状。 */
export interface FactsToolContext {
  /** 一句「产物在册情况」，随上下文常驻。 */
  inventory?: string;
  apply: (argumentsJson: string) => string;
}

/** 按已给的通道构造工具清单。 */
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

  if (input.ask?.facets.length) tools.push(askUserToolFor(input.ask.facets));

  if (diagram) tools.push(SET_DIAGRAM_TOOL);
  if (skills) tools.push(READ_SKILL_TOOL);

  if (input.repoPath && input.facts) tools.push(QUERY_FACTS_TOOL);

  if (external?.tools.length) tools.push(...external.tools);
  return tools;
}

/** 取参数里的一个字符串字段；解析失败回空串。 */
function readArg(argumentsJson: string, key: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    return typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
  } catch {
    return "";
  }
}

/** 回合中止时随异常带走的本轮已发生事实（工具调用与用量）。 */
export interface ToolLoopAudits {
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  skillReads: { skill: string; chars: number; found: boolean }[];
  mcpCalls: McpCallAudit[];
  rounds: number;
  /** 抛出那一刻已发生的 token 用量：那一发已跑完并计费。 */
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
  /** 实际发生的工具调用轮数。 */
  rounds: number;
  fileReads: FileReadRecord[];
  /** 本次对话的 search_code 调用审计，不合并去重。 */
  codeSearches: CodeSearchRecord[];
  /** 取过的技能正文；`found: false` 也记。 */
  skillReads: { skill: string; chars: number; found: boolean }[];
  /** 外部 MCP 工具的实际调用，一条一次，失败也记。 */
  mcpCalls: McpCallAudit[];
  /** 本次回合从检查点续跑时的起始轮次。 */
  resumedFromRound?: number;
  /** 回合被预算闸或额度掐断的原因；缺省表示正常答完。 */
  stoppedBy?: TurnStopReason;
  /** 本轮向用户提问并就地收尾时的结构化问句。 */
  asked?: AskUserAudit;
  /** 提问被挡下的最后一句原因（参数不合法、超字、本轮已问过）。 */
  askRefused?: string;
  /** 本轮被中断（预算或轮次到限）：无成品，`detail` 是界面原因。 */
  interrupted?: TurnInterrupt;
  /** 本句是对上一回合提问的回答及其认领结局（`claimed` / `missed`）。 */
  askClaimed?: AskClaimAudit;
}

/** 回合被什么掐断：`budget` = 预算到线、`rounds` = 工具轮次用完、`reads` = 读文件额度用完。 */
export type TurnStopReason = "budget" | "rounds" | "reads";

/** 长回合到限时的中断结论：本轮不出成品，`detail` 是给用户的原句。 */
export interface TurnInterrupt {
  reason: "budget" | "rounds";
  detail: string;
}

/** 一个工具轮结束时的回合状态；审计一并装入，续跑后仍能交代读过哪些文件。 */
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

/** 回合检查点通道：一行 = 一个工具轮的快照，同一线程续跑；存哪儿由服务层给闭包。 */
export interface TurnCheckpointChannel {
  /** 上一回合留下的状态；`inputHash` 对不上就回 `undefined`。 */
  restore: (inputHash: string) => { round: number; state: TurnLoopState } | undefined;
  /** 按挂着的调用 id + `promptHash` 认领一句提问的状态；可省略，纯续跑通道给空操作。 */
  claimAsk?: (pendingToolCallId: string, promptHash: string) => { round: number; state: TurnLoopState } | undefined;
  save: (inputHash: string, state: TurnLoopState, stoppedReason?: string, ask?: { promptHash: string; pendingToolCallId: string }) => void;
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
  /** 本次请求内的工具轮数；中断闸门用它，累计的 `rounds` 用于快照与审计。 */
  let attemptRounds = 0;
  let succeededReads = 0;
  let crossReads = 0;
  let externalCalls = 0;
  let asked: AskUserAudit | undefined;
  let askRefused: string | undefined;
  let askClaimed: AskClaimAudit | undefined;
  let interrupted: TurnInterrupt | undefined;
  let usage: LlmUsage | undefined;
  const audits = (): ToolLoopAudits => ({ fileReads, codeSearches, skillReads, mcpCalls, rounds, usage });
  const snapshot = (): TurnLoopState => ({ messages, rounds, succeededReads, crossReads, externalCalls, fileReads, codeSearches, skillReads, mcpCalls });
  let resumedFromRound: number | undefined;
  let stoppedBy: TurnStopReason | undefined;
  let completion: LlmCompletion;
  // 输入指纹：续跑的线程必须是同一个模型与同一句提问。
  const inputHash = hash(`${provider.modelVersion}:${system}:${input.user}`);
  // 不含答句的指纹（模型 + 系统提示），认领提问时用。
  const promptHash = hash(`${provider.modelVersion}:${system}`);
  try {

    const claimed = input.ask?.resume ? input.checkpoint?.claimAsk?.(input.ask.resume.toolCallId, promptHash) : undefined;
    if (input.ask?.resume) askClaimed = { toolCallId: input.ask.resume.toolCallId, outcome: claimed ? "claimed" : "missed" };
    const restored = claimed ?? input.checkpoint?.restore(inputHash);
    if (restored) {
      messages.splice(0, messages.length, ...restored.state.messages);
      if (claimed && input.ask?.resume) messages.push({ role: "tool", toolCallId: input.ask.resume.toolCallId, content: input.ask.resume.answer });
      rounds = restored.state.rounds;
      succeededReads = restored.state.succeededReads;
      crossReads = restored.state.crossReads;
      externalCalls = restored.state.externalCalls;
      fileReads.push(...restored.state.fileReads);
      codeSearches.push(...restored.state.codeSearches);
      skillReads.push(...restored.state.skillReads);
      mcpCalls.push(...restored.state.mcpCalls);
      resumedFromRound = restored.round;

      input.onProgress?.({ type: "thinking" });
      compactTurnContext(messages);
      completion = await provider.complete({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
    } else {
      input.onProgress?.({ type: "thinking" });
      completion = await provider.complete({ system, user: input.user, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
    }
  } catch (error) {
    attachToolLoopAudits(error, audits());
    throw error;
  }
  usage = completion.usage;
  try {
  while (completion.toolCalls?.length) {

    if (input.signal?.aborted) throw new LlmAbortedError();
    const budgetStop = input.budgetGuard?.();
    // 无文件面时不计读文件额度：`maxCalls` 为 0 不该被读成额度用完。
    const fileQuotaSpent = Boolean(input.repoPath) && succeededReads >= input.maxCalls;
    const roundsSpent = input.interruptAtLimit ? attemptRounds >= input.maxRounds : rounds >= input.maxRounds;

    if (input.interruptAtLimit && (budgetStop || roundsSpent)) {
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
      const detail = budgetStop ?? `这一次已连开 ${attemptRounds} 轮工具调用，还没到能答完的程度`;
      // 未应答的 tool_call 先各回一句，再存快照。
      for (const call of completion.toolCalls) messages.push({ role: "tool", toolCallId: call.id, content: `这一轮在这里中断：${detail}。接着做就从这里继续，已读过的内容不必重读。` });
      interrupted = { reason: budgetStop ? "budget" : "rounds", detail };
      stoppedBy = budgetStop ? "budget" : "rounds";
      break;
    }
    if (budgetStop || roundsSpent || fileQuotaSpent) {
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });

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
      input.onProgress?.({ type: "thinking" });
      // 收尾这一发没有下一轮，工具原文不折叠。
      compactTurnContext(messages, { keepToolResults: true });
      completion = await provider.complete({ system, messages, maxTokens, temperature, scene: input.scene, signal: input.signal });
      usage = addUsage(usage, completion.usage);
      break;
    }
    rounds += 1;
    attemptRounds += 1;
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
    for (const call of completion.toolCalls) {
      if (call.name === CROSS_REPO_LINK_TOOL.name) {

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

        input.onProgress?.({ type: "editing_diagram" });
        messages.push({ role: "tool", toolCallId: call.id, content: input.diagram?.apply(call.argumentsJson) ?? "这个作用域没有改这张图的权力。" });
        continue;
      }
      if (call.name === QUERY_FACTS_TOOL.name) {
        input.onProgress?.({ type: "querying_facts" });
        messages.push({ role: "tool", toolCallId: call.id, content: input.facts?.apply(call.argumentsJson) ?? "这个作用域没开放静态产物查询。" });
        continue;
      }
      if (call.name === READ_SKILL_TOOL.name && input.skills) {
        const skill = readSkillHint(call.argumentsJson);
        const file = readSkillFileHint(call.argumentsJson);
        input.onProgress?.({ type: "loading_skill", skill });
        const body = input.skills.bodyOf(skill, file);
        // undefined = 没有这份技能；空串 = 有技能但正文为空。
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
        // 提问即收尾：被问的这条调用不回灌 tool_result，留给认领。
        asked = { ...attempt.ask, toolCallId: call.id };
        // 同批未执行的兄弟调用先各回一句，避免留下多个悬挂 tool_call。
        const answered = new Set(messages.map((message) => message.toolCallId));
        for (const sibling of completion.toolCalls) {
          if (sibling.id !== call.id && !answered.has(sibling.id)) messages.push({ role: "tool", toolCallId: sibling.id, content: "本轮改为先向用户问一句，这一条没有执行。" });
        }
        break;
      }
      if (input.external?.tools.some((tool) => tool.name === call.name)) {
        const cap = input.external.maxCalls ?? 3;
        if (externalCalls >= cap) {

          messages.push({ role: "tool", toolCallId: call.id, content: `外部工具一个回合最多打 ${cap} 次，额度已用完。请基于已拿到的外部内容回答，并说明哪些部分没核实。` });
          continue;
        }
        externalCalls += 1;

        input.onProgress?.({ type: "calling_external" });
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
      // 仓名来自模型：用 hasOwn 挡掉 __proto__ / constructor 等原型属性名。
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
    // 问了就收尾：等回答的那一档在下面单独留一份快照（见 `await_user`），这一轮的正文就是那句问句
    if (asked) break;
    // 一个 super-step 落一份快照：进程在这之后被杀掉，下一次同线程同问题的请求就从这里接上
    input.checkpoint?.save(inputHash, snapshot());
    input.onProgress?.({ type: "thinking" });
    compactTurnContext(messages);
    completion = await provider.complete({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
    usage = addUsage(usage, completion.usage);
  }
  if (asked) {
    // 等回答的这一档：留快照并把「挂着的调用 id + 模型与系统提示的指纹」写在行上，点选项才认领得到、换模型就认不上
    input.checkpoint?.save(inputHash, snapshot(), "await_user", { promptHash, pendingToolCallId: asked.toolCallId });
  } else if (interrupted) {
    // 中断不是「答完了」：留一份写明原因的快照，用户点重试就是同一句重发，输入哈希相同 ⇒ 从这里接上，读过的不重付
    input.checkpoint?.save(inputHash, snapshot(), "interrupted");
  } else {
    // 答完了：留着检查点只会在下次误续跑一个已经结束的回合
    input.checkpoint?.clear();
  }
  // 提问这一轮交出去的成品就是问句：正文 = 问句 + 可选项，落库、回放、journal 三处仍读同一份文本
  if (asked) completion = { ...completion, text: askBody(asked) };
  return { completion, usage, rounds, fileReads, codeSearches, skillReads, mcpCalls, ...(resumedFromRound === undefined ? {} : { resumedFromRound }), ...(stoppedBy === undefined ? {} : { stoppedBy }), ...(asked === undefined ? {} : { asked }), ...(askRefused === undefined ? {} : { askRefused }), ...(interrupted === undefined ? {} : { interrupted }), ...(askClaimed === undefined ? {} : { askClaimed }) };
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
