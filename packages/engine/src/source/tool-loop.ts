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
  read_file / search_code 工具循环，按传入的通道组合工具面。
  上限是工具轮数与累计成功的读取数；用尽时回绝未应答的 tool_call，再做一轮不带工具的收尾。
  messages[0] 恒为首轮 user 消息。
*/

/** 工具循环发出的过程帧类型。 */
export type ReadToolProgress = Exclude<ScopedStreamProgress, { type: "delta" } | { type: "progress" }>;

export interface ReadToolLoopInput {
  provider: LlmProvider;
  /** 仓库根：read_file 只在此范围内读取。 */
  repoPath?: string;
  system: string;
  user: string;
  maxTokens: number;
  /** 省略时用 provider 的默认采样温度。 */
  temperature?: number;
  maxRounds: number;
  /** 一个回合内成功读取的文件数上限。 */
  maxCalls: number;
  onProgress?: (progress: ReadToolProgress) => void;
  /** 场景标签，透传给每一轮 LLM 调用。 */
  scene?: string;
  /** 提供时开放 search_code 工具。 */
  search?: SearchCorpus;
  /** 外部中止信号，透传给每一轮 LLM 调用。 */
  signal?: AbortSignal;
  /** 跨仓访问上下文；不传表示只有当前仓。 */
  cross?: CrossRepoContext;
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

/** 技能通道：清单文本与正文取用函数。 */
export interface SkillsToolContext {
  /** 进上下文的技能清单文本。 */
  brief: string;
  /** 取技能正文或该目录下的附属文件；`file` 省略时取 SKILL.md，返回 `undefined` 表示不存在。 */
  bodyOf: (name: string, file?: string) => string | undefined;
}

/** 外部 MCP 工具的清单与调用通道。 */
export interface ExternalToolContext {
  /** 已带 `mcp__<server>__<tool>` 前缀的工具清单。 */
  tools: LlmTool[];
  /** 不许抛异常：外部 server 的超时与失败须先转成给模型看的文本。 */
  call: (name: string, argumentsJson: string) => Promise<{ text: string; audit: McpCallAudit }>;
  /** 一个回合的外部调用次数上限，默认 3。 */
  maxCalls?: number;
}

/** 跨仓访问上下文。 */
export interface CrossRepoContext {
  /** 仓名到仓库根路径的映射。 */
  roots: Record<string, string>;
  /** 按仓名取检索语料，`undefined` 表示该仓不可检索。 */
  corpusOf?: (repoName: string) => SearchCorpus | undefined;
  /** 取当前仓与对端仓之间的接缝清单。 */
  links?: (repoName: string, filter: string) => string;
  /** 跨仓读取的独立上限。 */
  maxCrossReads?: number;
  /** 每递出一份对端内容回调一次，参数为仓名与仓内路径。 */
  onHandedOut?: (repoName: string, path: string) => void;
}

/** set_diagram 的执行通道，返回落盘结果或拒写原因。 */
export interface SetDiagramToolContext {
  apply: (argumentsJson: string) => string;
  /** 画布现场快照。 */
  inventory?: string;
}

/** 静态产物的查询通道。 */
export interface FactsToolContext {
  /** 静态产物在册情况，随上下文常驻。 */
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

/** 随异常带出的工具调用与用量记录。 */
export interface ToolLoopAudits {
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  skillReads: { skill: string; chars: number; found: boolean }[];
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
  skillReads: { skill: string; chars: number; found: boolean }[];
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
  crossReads: number;
  externalCalls: number;
  fileReads: FileReadRecord[];
  codeSearches: CodeSearchRecord[];
  skillReads: { skill: string; chars: number; found: boolean }[];
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
  /** 本次请求内的工具轮数，与跨续跑累计的 rounds 分开计。 */
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
  // 输入指纹覆盖模型、系统提示与提问，续跑要求三者一致
  const inputHash = hash(`${provider.modelVersion}:${system}:${input.user}`);
  // 由模型与系统提示组成的指纹，不含提问
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
    // 没有文件面时不占读文件额度
    const fileQuotaSpent = Boolean(input.repoPath) && succeededReads >= input.maxCalls;
    const roundsSpent = input.interruptAtLimit ? attemptRounds >= input.maxRounds : rounds >= input.maxRounds;

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
          : `本次对话的工具轮次已用完（${rounds} 轮）${input.repoPath ? `；读文件额度还剩 ${input.maxCalls - succeededReads} 次，但没有下一轮了` : ""}。请基于已读到的正文直接回答，缺什么就照实说缺什么。`;
      if (budgetStop) stoppedBy = "budget";
      else if (roundsSpent) stoppedBy = "rounds";
      else stoppedBy = "reads";
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: refusal });
      }
      input.onProgress?.({ type: "thinking" });
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
        // undefined 表示没有这份技能，空串表示有技能但正文为空
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
        // 提问后本循环结束，这条调用不回灌 tool_result，等认领
        asked = { ...attempt.ask, toolCallId: call.id };
        // 每条 tool_call 都要有配对的 tool 消息
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
      // 仓名来自模型，用 hasOwn 挡掉原型属性名
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
      // 读文件额度在每条调用上判一次，轮首那次只挡下一轮
      if (succeededReads >= input.maxCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: "已达到本次对话的读文件上限，请基于已有上下文直接回答。" });
        continue;
      }
      input.onProgress?.({ type: "reading", path: repo ? `${repo}/${readPathHint(call.argumentsJson)}` : readPathHint(call.argumentsJson) });
      const outcome = executeReadFile(root, call.argumentsJson);
      // file_read 审计只有一个 path 字段，跨仓读取时在前面加仓名
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
    // 提问后本循环结束
    if (asked) break;
    input.checkpoint?.save(inputHash, snapshot());
    input.onProgress?.({ type: "thinking" });
    compactTurnContext(messages);
    completion = await provider.complete({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
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

/** 只开放 read_skill 的最小循环，两轮 = 取一份正文 + 作答。 */
export function completeWithSkillTool(input: Omit<ReadToolLoopInput, "repoPath" | "maxRounds" | "maxCalls" | "search" | "cross" | "diagram" | "facts">): Promise<ReadToolLoopResult> {
  return completeWithReadTool({ ...input, maxRounds: 2, maxCalls: 0 });
}

/** 一次技能取用的审计记录，found 为 false 表示名字不在清单上。 */
export interface SkillReadAudit {
  skill: string;
  chars: number;
  found: boolean;
}

/** 有技能通道时走 read_skill 循环，没有时单轮直发。 */
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
    system: `${input.system}\n\n${input.skills.brief}`,
    skills: input.skills
  });
  return { text: loop.completion.text, usage: loop.usage, skillReads: loop.skillReads };
}

/** 取 read_skill 参数里的 name，解析失败回空串。 */
function readSkillHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name.trim() : "";
  } catch {
    return "";
  }
}

/** 取 read_skill 参数里的 file，未给时回 undefined。 */
function readSkillFileHint(argumentsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { file?: unknown };
    const file = typeof parsed.file === "string" ? parsed.file.trim() : "";
    return file || undefined;
  } catch {
    return undefined;
  }
}

/** 取 read_file 参数里的 path，仅用于进度提示。 */
function readPathHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { path?: unknown };
    return typeof parsed.path === "string" ? parsed.path : "";
  } catch {
    return "";
  }
}

/** 取 search_code 参数里的 query，仅用于进度提示。 */
function readQueryHint(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as { query?: unknown };
    return typeof parsed.query === "string" ? parsed.query : "";
  } catch {
    return "";
  }
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
