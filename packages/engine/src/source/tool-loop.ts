import type { AgentScope } from "@codebase-tutor/contract";
import type { LlmCompletion, LlmCompletionInput, LlmMessage, LlmProvider, LlmUsage } from "../application/port/llm-provider.js";
import { LlmAbortedError, isLlmAborted } from "../application/port/llm-provider.js";
import { addUsage } from "../adapter/outbound/llm/usage.js";
import { hash } from "@codebase-tutor/platform";
import type { McpCallAudit } from "@codebase-tutor/domain";
import type { FileReadRecord } from "./read-file.js";
import type { CodeSearchRecord, SearchCorpus } from "./search-code.js";
import { askBody, type AskClaimAudit, type AskFacet, type AskResume, type AskUserAudit } from "./ask-user.js";
import { registryFor } from "./tools/registry.js";
import { exposeTools, toolIndexBrief } from "./tools/exposure.js";
import { catalogOf } from "./tools/catalog.js";
import { ToolInvoker } from "./tools/invoker.js";
import {
  toLlmTool,
  toolSchemaHash,
  type ExternalToolContext,
  type FactsToolContext,
  type ReadToolProgress,
  type SetDiagramToolContext,
  type SkillReadRecord,
  type SkillsToolContext,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
  type ToolTraceStep
} from "./tools/types.js";

/**
  工具循环：每回合按通道装配注册表与暴露面，调用一律经 `ToolInvoker`。
  上限是工具轮数与累计成功的读取数；用尽时回绝未应答的 tool_call，再做一轮不带工具的收尾。
  messages[0] 恒为首轮 user 消息。
*/

export interface ReadToolLoopInput {
  provider: LlmProvider;
  /** 本轮工作区：只决定工具面过滤。 */
  scope: AgentScope;
  /** 仓库根：read_file 只在此范围内读取。 */
  repoPath?: string;
  system: string;
  user: string;
  /** 输出预算；省略即取 `DEFAULT_MAX_TOKENS`。 */
  maxTokens?: number;
  /** 省略时用 provider 的默认采样温度。 */
  temperature?: number;
  /** 工具轮数上限；省略取 `DEFAULT_TOOL_ROUNDS`。 */
  maxRounds?: number;
  /** 一个回合内成功读取的文件数上限；省略取 `DEFAULT_FILE_READS`。 */
  maxCalls?: number;
  onProgress?: (progress: ReadToolProgress) => void;
  /** 模型与工具调用的轨迹帧。 */
  onTrace?: (step: ToolTraceStep) => void;
  /** 场景标签，透传给每一轮 LLM 调用。 */
  scene?: string;
  /** 提供时开放 search_code 工具。 */
  search?: SearchCorpus;
  /** 外部中止信号，透传给每一轮 LLM 调用。 */
  signal?: AbortSignal;
  /** 画布图结构的写入通道。 */
  diagram?: SetDiagramToolContext;
  /** 静态产物的只读查询通道。 */
  facts?: FactsToolContext;
  /** 技能正文的取用通道。 */
  skills?: SkillsToolContext;
  /** 回合内向用户提问的通道，一个回合最多一次。 */
  ask?: { facets: AskFacet[]; resume?: AskResume };
  /** 外部 MCP 工具面。 */
  external?: ExternalToolContext;
  /** 回合检查点通道；不传则不落检查点。 */
  checkpoint?: TurnCheckpointChannel;
  /** 每轮工具调用前的预算检查：返回停止原因，`undefined` 表示继续。 */
  budgetGuard?: () => string | undefined;
  /** 到上限时中断本轮并保留检查点。 */
  interruptAtLimit?: boolean;
}

/** 随异常带出的工具调用与用量记录。 */
export interface ToolLoopAudits {
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  skillReads: SkillReadRecord[];
  mcpCalls: McpCallAudit[];
  rounds: number;
  /** 抛出前已累计的 token 用量。 */
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
  /** 本回合的 search_code 调用审计，不合并去重。 */
  codeSearches: CodeSearchRecord[];
  /** 取过的技能记录，未命中的也记。 */
  skillReads: SkillReadRecord[];
  /** 外部 MCP 工具的实际调用，一条一次，失败也记。 */
  mcpCalls: McpCallAudit[];
  /** 本回合从检查点续跑时的起始轮次。 */
  resumedFromRound?: number;
  /** 回合提前停止的原因，缺省表示正常答完。 */
  stoppedBy?: TurnStopReason;
  /** 回合内向用户提问时的结构化问句。 */
  asked?: AskUserAudit;
  /** 最近一次提问被拒的原因。 */
  askRefused?: string;
  /** 回合被中断时的结论，无成品。 */
  interrupted?: TurnInterrupt;
  /** 对上一回合提问的认领结局。 */
  askClaimed?: AskClaimAudit;
}

/** 回合提前停止的原因类别。 */
export type TurnStopReason = "budget" | "rounds" | "reads";

/** 回合到上限时的中断结论与给用户的原因句。 */
export interface TurnInterrupt {
  reason: "budget" | "rounds";
  detail: string;
}

/** 一个工具轮结束时的回合状态快照。 */
export interface TurnLoopState {
  messages: LlmMessage[];
  rounds: number;
  succeededReads: number;
  externalCalls: number;
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  skillReads: SkillReadRecord[];
  mcpCalls: McpCallAudit[];
}

/** 回合检查点通道：每个工具轮一份快照，同一线程续跑。 */
export interface TurnCheckpointChannel {
  /** 上一回合留下的状态；`inputHash` 不匹配时返回 `undefined`。 */
  restore: (inputHash: string) => { round: number; state: TurnLoopState } | undefined;
  /** 按挂起的调用 id 与 `promptHash` 认领提问状态；可省略。 */
  claimAsk?: (pendingToolCallId: string, promptHash: string) => { round: number; state: TurnLoopState } | undefined;
  save: (inputHash: string, state: TurnLoopState, stoppedReason?: string, ask?: { promptHash: string; pendingToolCallId: string }) => void;
  clear: () => void;
}

/** 缺省上限按「实际碰不到」给：真闸是每轮的预算检查，不是这些数字。 */
export const DEFAULT_TOOL_ROUNDS = 100;
export const DEFAULT_FILE_READS = 100;
const DEFAULT_EXTERNAL_CALLS = 100;

export async function completeWithReadTool(input: ReadToolLoopInput): Promise<ReadToolLoopResult> {
  const { provider, maxTokens, temperature } = input;
  const maxRounds = input.maxRounds ?? DEFAULT_TOOL_ROUNDS;
  const maxCalls = input.maxCalls ?? DEFAULT_FILE_READS;
  const messages: LlmMessage[] = [{ role: "user", content: input.user }];
  const fileReads: FileReadRecord[] = [];
  const codeSearches: CodeSearchRecord[] = [];
  const skillReads: SkillReadRecord[] = [];
  const mcpCalls: McpCallAudit[] = [];
  let rounds = 0;
  /** 本次请求内的工具轮数，与跨续跑累计的 rounds 分开计。 */
  let attemptRounds = 0;
  let succeededReads = 0;
  let externalCalls = 0;
  let asked: AskUserAudit | undefined;
  let askRefused: string | undefined;
  let askClaimed: AskClaimAudit | undefined;
  let interrupted: TurnInterrupt | undefined;
  let usage: LlmUsage | undefined;
  const audits = (): ToolLoopAudits => ({ fileReads, codeSearches, skillReads, mcpCalls, rounds, usage });
  const snapshot = (): TurnLoopState => ({ messages, rounds, succeededReads, externalCalls, fileReads, codeSearches, skillReads, mcpCalls });

  const baseContext: ToolContext = {
    scope: input.scope,
    ...(input.repoPath ? { repoPath: input.repoPath } : {}),
    ...(input.search ? { search: input.search } : {}),
    ...(input.diagram ? { diagram: input.diagram } : {}),
    ...(input.facts ? { facts: input.facts } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.ask ? { ask: input.ask } : {}),
    ...(input.external ? { external: input.external } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {})
  };
  const registry = registryFor(baseContext);
  // 暴露面每回合只算一次：tools 数组与按需目录都不在中途变化
  const exposure = exposeTools(registry, baseContext);
  const system = `${input.system}${toolIndexBrief(exposure)}`;
  const tools = exposure.always.map(toLlmTool);
  let context = baseContext;
  const catalog = catalogOf(exposure.onDemand, (name) => registry.find(name, context));
  context = { ...baseContext, catalog };
  const invoker = new ToolInvoker(registry, exposure);
  const schemaKey = hash(toolSchemaHash(registry.entries(baseContext).map((entry) => entry.definition)));
  const promptHash = hash(`${provider.modelVersion}:${system}:${schemaKey}`);
  const inputHash = hash(`${promptHash}:${input.user}`);

  const guard = (definition: ToolDefinition): string | undefined => {
    if (definition.cost === "read" && succeededReads >= maxCalls) return "已达到本次对话的读文件上限，请基于已有上下文直接回答。";
    if (definition.cost === "external") {
      const cap = input.external?.maxCalls ?? DEFAULT_EXTERNAL_CALLS;
      if (externalCalls >= cap) return `外部工具一个回合最多打 ${cap} 次，额度已用完。请基于已拿到的外部内容回答，并说明哪些部分没核实。`;
    }
    return undefined;
  };
  const collect = (outcome: ToolOutcome): void => {
    for (const read of outcome.audits?.fileReads ?? []) {
      fileReads.push(read);
      if (!read.denied) succeededReads += 1;
    }
    for (const search of outcome.audits?.codeSearches ?? []) codeSearches.push(search);
    for (const skill of outcome.audits?.skillReads ?? []) skillReads.push(skill);
    for (const call of outcome.audits?.mcpCalls ?? []) {
      mcpCalls.push(call);
      externalCalls += 1;
    }
  };

  let resumedFromRound: number | undefined;
  let stoppedBy: TurnStopReason | undefined;
  let completion: LlmCompletion;
  let modelCalls = 0;
  const askModel = async (args: LlmCompletionInput, label: string): Promise<LlmCompletion> => {
    const stepId = `m${++modelCalls}`;
    const round = rounds + 1;
    input.onTrace?.({ kind: "model", status: "start", stepId, label, round, model: provider.modelVersion });
    const startedAt = Date.now();
    try {
      const result = await provider.complete(args);
      input.onTrace?.({
        kind: "model", status: "ok", stepId, label: "模型回复", round, model: provider.modelVersion,
        ms: Date.now() - startedAt,
        ...(result.text ? { reply: result.text } : {}),
        ...(result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : {}),
        ...(result.finishReason ? { finishReason: result.finishReason } : {})
      });
      return result;
    } catch (error) {
      input.onTrace?.({ kind: "model", status: "error", stepId, label: "模型调用失败", round, model: provider.modelVersion, ms: Date.now() - startedAt, ...(error instanceof Error ? { detail: error.message } : {}) });
      throw error;
    }
  };
  try {

    const claimed = input.ask?.resume ? input.checkpoint?.claimAsk?.(input.ask.resume.toolCallId, promptHash) : undefined;
    if (input.ask?.resume) askClaimed = { toolCallId: input.ask.resume.toolCallId, outcome: claimed ? "claimed" : "missed" };
    const restored = claimed ?? input.checkpoint?.restore(inputHash);
    if (restored) {
      messages.splice(0, messages.length, ...restored.state.messages);
      if (claimed && input.ask?.resume) messages.push({ role: "tool", toolCallId: input.ask.resume.toolCallId, content: input.ask.resume.answer });
      rounds = restored.state.rounds;
      succeededReads = restored.state.succeededReads;
      externalCalls = restored.state.externalCalls;
      fileReads.push(...restored.state.fileReads);
      codeSearches.push(...restored.state.codeSearches);
      skillReads.push(...restored.state.skillReads);
      mcpCalls.push(...restored.state.mcpCalls);
      resumedFromRound = restored.round;

      input.onProgress?.({ type: "thinking" });
      compactTurnContext(messages);
      completion = await askModel({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal }, "续跑");
    } else {
      input.onProgress?.({ type: "thinking" });
      completion = await askModel({ system, user: input.user, tools, maxTokens, temperature, scene: input.scene, signal: input.signal }, "模型思考中");
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
    // 没有文件面时不占读文件额度
    const fileQuotaSpent = Boolean(input.repoPath) && succeededReads >= maxCalls;
    const roundsSpent = input.interruptAtLimit ? attemptRounds >= maxRounds : rounds >= maxRounds;

    if (input.interruptAtLimit && (budgetStop || roundsSpent)) {
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
      const detail = budgetStop ?? `这一次已连开 ${attemptRounds} 轮工具调用，还没到能答完的程度`;
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
          : `本次对话的工具轮次已用完（${rounds} 轮）${input.repoPath ? `；读文件额度还剩 ${maxCalls - succeededReads} 次，但没有下一轮了` : ""}。请基于已读到的正文直接回答，缺什么就照实说缺什么。`;
      if (budgetStop) stoppedBy = "budget";
      else if (roundsSpent) stoppedBy = "rounds";
      else stoppedBy = "reads";
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: refusal });
      }
      input.onProgress?.({ type: "thinking" });
      compactTurnContext(messages, { keepToolResults: true });
      completion = await askModel({ system, messages, maxTokens, temperature, scene: input.scene, signal: input.signal }, "到限收尾");
      usage = addUsage(usage, completion.usage);
      break;
    }
    rounds += 1;
    attemptRounds += 1;
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
    for (const call of completion.toolCalls) {
      const { outcome } = await invoker.invoke(call, context, { round: rounds, ...(input.onTrace ? { onTrace: input.onTrace } : {}) }, guard);
      collect(outcome);
      if (outcome.askRefused) askRefused = outcome.askRefused;
      if (outcome.stop?.reason === "await_user") {
        // 提问后本循环结束，这条调用不回灌 tool_result，等认领
        asked = { ...outcome.stop.asked, toolCallId: call.id };
        // 每条 tool_call 都要有配对的 tool 消息
        const answered = new Set(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId));
        for (const sibling of completion.toolCalls) {
          if (sibling.id !== call.id && !answered.has(sibling.id)) messages.push({ role: "tool", toolCallId: sibling.id, content: "本轮改为先向用户问一句，这一条没有执行。" });
        }
        break;
      }
      messages.push({ role: "tool", toolCallId: call.id, content: outcome.text });
    }
    // 提问后本循环结束
    if (asked) break;
    input.checkpoint?.save(inputHash, snapshot());
    input.onProgress?.({ type: "thinking" });
    compactTurnContext(messages);
    completion = await askModel({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal }, "模型思考中");
    usage = addUsage(usage, completion.usage);
  }
  if (asked) {
    // 挂起提问时把待认领的调用 id 与 promptHash 一并写入检查点
    input.checkpoint?.save(inputHash, snapshot(), "await_user", { promptHash, pendingToolCallId: asked.toolCallId });
  } else if (interrupted) {
    // 中断的回合保留检查点并写明原因，同一提问可续跑
    input.checkpoint?.save(inputHash, snapshot(), "interrupted");
  } else {
    input.checkpoint?.clear();
  }
  // 提问回合的成品文本是问句加可选项
  if (asked) completion = { ...completion, text: askBody(asked) };
  return { completion, usage, rounds, fileReads, codeSearches, skillReads, mcpCalls, ...(resumedFromRound === undefined ? {} : { resumedFromRound }), ...(stoppedBy === undefined ? {} : { stoppedBy }), ...(asked === undefined ? {} : { asked }), ...(askRefused === undefined ? {} : { askRefused }), ...(interrupted === undefined ? {} : { interrupted }), ...(askClaimed === undefined ? {} : { askClaimed }) };
  } catch (error) {
    // 中止与失败都要带出已发生的工具审计
    attachToolLoopAudits(error, audits());
    if (isLlmAborted(error)) {
      // 用户主动停止的回合不续跑，检查点随之清除
      input.checkpoint?.clear();
    } else {
      // 其它异常保留检查点并记为 error
      input.checkpoint?.save(inputHash, snapshot(), "error");
    }
    throw error;
  }
}

/** 技能清单并进系统提示词；没有通道就原样返回。 */
export function withSkillsBrief(system: string, skills?: SkillsToolContext): string {
  return skills ? `${system}\n\n${skills.brief}` : system;
}

/** 工具结果完整保留的最近轮数。 */
export const TOOL_CONTEXT_KEEP_ROUNDS = 2;
/** 折叠后保留的结果开头字符上限。 */
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

/** 就地压缩回合上下文的消息体积，只改正文与 reasoning，不删消息。 */
export function compactTurnContext(messages: LlmMessage[], options: { keepToolResults?: boolean; keepRounds?: number } = {}): void {
  const keepRounds = Math.max(1, options.keepRounds ?? TOOL_CONTEXT_KEEP_ROUNDS);
  const roundStarts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === "assistant" && messages[index].toolCalls?.length) roundStarts.push(index);
  }
  if (!roundStarts.length) return;
  const newestRound = roundStarts[roundStarts.length - 1];
  // 分界线之前的工具结果才折叠
  const foldBoundary = roundStarts[Math.max(0, roundStarts.length - keepRounds)];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    // 最近一次工具调用的 assistant 保留 reasoning：provider 要求原样回传
    if (message.role === "assistant" && index !== newestRound) message.reasoningContent = undefined;
    if (options.keepToolResults || index >= foldBoundary) continue;
    if (message.role === "tool" && message.content.length > MASK_HEAD_CHARS) {
      message.content = `${headLinesOf(message.content)}\n…（这一轮的其余结果已折叠：需要正文就再调一次同一个工具。）`;
    }
  }
}
