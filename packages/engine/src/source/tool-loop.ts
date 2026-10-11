import type { LlmCompletion, LlmMessage, LlmProvider, LlmTool, LlmUsage } from "../llm/provider.js";
import { LlmAbortedError, isLlmAborted } from "../llm/provider.js";
import { addUsage } from "../llm/usage.js";
import { READ_FILE_TOOL, executeReadFile, type FileReadRecord } from "./read-file.js";
import { SEARCH_CODE_TOOL, executeSearchCode, type CodeSearchRecord, type SearchCorpus } from "./search-code.js";

/**
  read_file / search_code 工具循环（宏观设计 map 与教学 teaching 两个作用域共用）：

  - 预算硬上限（轮数 / 累计**读成功**的文件数）；用尽时对未应答的 tool_call 明确回绝，再做一轮不带工具的收尾回答。
    被护栏拒绝或路径写错的调用**不占文件额度**（代价只有一行文本，且「反复乱试」已由轮数兜住），但仍逐条进 fileReads 审计；
  - 传入 `search` 语料时额外提供 search_code（词法检索「文件在哪」，只回位置与职责）：
    它不读任何文件，**不占文件额度也不记 file_read**，单独进 codeSearches 审计；轮数上限同样约束它；
  - messages[0] 恒为首轮 user 消息——provider 提供 messages 时忽略 user 字段，
    首轮 user 若不进 messages，工具调用后的轮次会同时丢失代码上下文与学习者提问（回归防线）；
  - 每轮调用前 micro_compact：更早轮次的 tool 结果压成占位符、早期 reasoningContent 丢弃
    （读取结果可再生，推理 token 是账单大头）；最近一轮 assistant 的 reasoningContent 保留（部分协议要求回传）；
  - 每次 read_file（含拒绝与失败）返回审计记录，由调用方记 journal file_read。
  - `signal` 透传到每一轮 LLM 调用，并在开新一轮前检查：中止一律抛 LlmAbortedError 原样上抛，
    不吞成「基于已有上下文直接回答」的收尾结论（那会把用户主动停止伪装成模型答完）。
  */

export type ReadToolProgress = { type: "thinking"; round: number } | { type: "reading"; path: string } | { type: "searching"; query: string };

export interface ReadToolLoopInput {
  provider: LlmProvider;
  /** 仓库根：read_file 只能在此范围内读取 */
  repoPath: string;
  system: string;
  /** 首轮 user 消息（代码上下文 + 学习者提问） */
  user: string;
  maxTokens: number;
  temperature: number;
  /** 最多几轮工具调用 */
  maxRounds: number;
  /** 本次对话累计最多读取几个文件（只数读成功的；被拒绝/失败的仍进 fileReads 审计但不占额度） */
  maxCalls: number;
  onProgress?: (progress: ReadToolProgress) => void;
  /** LLM 工作日志的场景标签（teaching.turn / map.chat），透传给每一轮调用 */
  scene?: string;
  /** 提供时额外开放 search_code 工具（词法检索定位文件）；不提供则模型只有 read_file。 */
  search?: SearchCorpus;
  /** 外部中止信号：透传给每一轮 LLM 调用，并在进入下一轮前检查（读文件是本地操作，不在此列）。 */
  signal?: AbortSignal;
  /** 跨仓访问：见 `CrossRepoContext`。不传 = 只有当前仓，工具清单与从前逐字一致。 */
  cross?: CrossRepoContext;
}

/**
  跨仓访问上下文。**只在地址簿里还有别的仓时才传**——没有第二个仓时三个工具一个都不多给，
  工具清单与提示词逐字不变（多一段没用的清单就是每轮白付 token，还会让模型去猜不存在的对端）。

  - `roots`：仓名 → 仓库根路径。`read_file` 靠它换根，**守卫整套复用**（仓内边界、拒读名单、软链接复核都在根路径这一层）；
  - `corpusOf`：仓名 → 检索语料，**模型真搜时才现取**（取一份对端语料意味着要把那个仓挂进内存，不该为「它可能问一句」先付）；
    回 `undefined` 表示这仓没产物、只能读不能搜，工具会照实回一句，不让模型以为工具坏了；
  - `links`：当前仓 ↔ 对端仓按归一化 URL 配好的接缝清单（零 token 现算，代价是读两边源码，所以只在模型真调用时才算）。
  */
export interface CrossRepoContext {
  roots: Record<string, string>;
  corpusOf?: (repoName: string) => SearchCorpus | undefined;
  links?: (repoName: string, filter: string) => string;
  /** 跨仓读取的独立上限：总额度之外再掐一道，防止模型把两个仓都翻一遍。 */
  maxCrossReads?: number;
}

/** 跨仓接缝查询工具：把「点这个按钮之后代码在哪个仓的哪一行」这条零 token 的证据交给模型。 */
export const CROSS_REPO_LINK_TOOL: LlmTool = {
  name: "cross_repo_link",
  description: "查询当前仓库与另一个仓库之间按 URL 配好的 HTTP 接缝：本仓调用的地址落在对端哪个文件哪一行，以及对端提供了哪些地址被本仓调用。回答跨仓「这个请求打到哪里去」时先调用它拿准确落点，不要靠猜 URL 字符串。",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "对端仓库名" },
      filter: { type: "string", description: "只看包含该片段（路径或 URL 片段）的接缝，可选" }
    },
    required: ["repo"]
  }
};

/** 按「有没有第二个仓」现做工具清单：跨仓参数与 cross_repo_link 只在真有对端时出现。 */
function toolsFor(withSearch: boolean, cross?: CrossRepoContext): LlmTool[] {
  const names = cross ? Object.keys(cross.roots) : [];
  const withRepo = (tool: LlmTool, extra: string): LlmTool => {
    const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>;
    return {
      ...tool,
      description: `${tool.description} 跨仓时给 repo 参数（${extra}），省略即当前仓。`,
      parameters: { ...tool.parameters, properties: { ...properties, repo: { type: "string", description: `其他仓的名字，可选；本仓请省略。可用值：${names.join(" / ")}` } } }
    };
  };
  const tools: LlmTool[] = [names.length ? withRepo(READ_FILE_TOOL, "读对端实现") : READ_FILE_TOOL];
  if (withSearch) tools.push(names.length ? withRepo(SEARCH_CODE_TOOL, "在对端仓里定位文件") : SEARCH_CODE_TOOL);
  if (cross?.links) tools.push(CROSS_REPO_LINK_TOOL);
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

export interface ReadToolLoopResult {
  completion: LlmCompletion;
  usage?: LlmUsage;
  /** 实际发生的工具调用轮数（预算上限打满提前收尾的轮也算）。 */
  rounds: number;
  fileReads: FileReadRecord[];
  /** 本次对话的 search_code 调用审计（不合并去重——同一查询反复搜本身就是信号）。 */
  codeSearches: CodeSearchRecord[];
}

export async function completeWithReadTool(input: ReadToolLoopInput): Promise<ReadToolLoopResult> {
  const { provider, system, maxTokens, temperature } = input;
  const tools = toolsFor(Boolean(input.search), input.cross);
  const available = tools.map((tool) => tool.name).join(" 与 ");
  const crossNames = input.cross ? Object.keys(input.cross.roots) : [];
  const messages: LlmMessage[] = [{ role: "user", content: input.user }];
  input.onProgress?.({ type: "thinking", round: 1 });
  let completion = await provider.complete({ system, user: input.user, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
  const fileReads: FileReadRecord[] = [];
  const codeSearches: CodeSearchRecord[] = [];
  let usage: LlmUsage | undefined = completion.usage;
  let rounds = 0;
  let succeededReads = 0;
  let crossReads = 0;
  while (completion.toolCalls?.length) {
    // 中止检查点：上一轮的 LLM 已返回，若此时用户已经停了，就绝不再开新一轮（也不落收尾调用）。
    if (input.signal?.aborted) throw new LlmAbortedError();
    if (rounds >= input.maxRounds || succeededReads >= input.maxCalls) {
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: "已达到本次对话的读文件上限，请基于已有上下文直接回答。" });
      }
      input.onProgress?.({ type: "thinking", round: rounds + 2 });
      compactToolHistory(messages);
      completion = await provider.complete({ system, messages, maxTokens, temperature, scene: input.scene, signal: input.signal });
      usage = addUsage(usage, completion.usage);
      break;
    }
    rounds += 1;
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
    for (const call of completion.toolCalls) {
      if (call.name === CROSS_REPO_LINK_TOOL.name) {
        // 零 token 现算：代价是读两边源码（几十毫秒），所以只在模型真开口要跨仓落点时才算一次
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
          // 说清「这个仓能读不能搜」，否则模型会以为工具坏了而反复重试；不占任何额度
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
      if (call.name !== READ_FILE_TOOL.name) {
        messages.push({ role: "tool", toolCallId: call.id, content: `未知工具 ${call.name}；只支持 ${available}。` });
        continue;
      }
      const repo = readArg(call.argumentsJson, "repo");
      const root = repo ? input.cross?.roots[repo] : input.repoPath;
      if (!root) {
        messages.push({ role: "tool", toolCallId: call.id, content: `未知仓库「${repo}」；可访问：当前仓${crossNames.length ? ` / ${crossNames.join(" / ")}` : "（地址簿里没有其他仓，跨仓请省略 repo 参数）"}。` });
        continue;
      }
      if (repo && crossReads >= (input.cross?.maxCrossReads ?? 2)) {
        messages.push({ role: "tool", toolCallId: call.id, content: `跨仓读取最多 ${input.cross?.maxCrossReads ?? 2} 个文件，额度已用完。请基于已读到的对端内容回答，并说明哪些部分没核实。` });
        continue;
      }
      input.onProgress?.({ type: "reading", path: repo ? `${repo}/${readPathHint(call.argumentsJson)}` : readPathHint(call.argumentsJson) });
      const outcome = executeReadFile(root, call.argumentsJson);
      // 审计与正文都要带上仓名：journal 的 file_read 只有一个 path 字段，不带仓名就分不出这是哪个仓的文件
      fileReads.push(repo ? { ...outcome.audit, path: `${repo}/${outcome.audit.path}` } : outcome.audit);
      if (!outcome.audit.denied) {
        succeededReads += 1;
        if (repo) crossReads += 1;
      }
      messages.push({ role: "tool", toolCallId: call.id, content: repo ? `【来自仓 ${repo}】\n${outcome.content}` : outcome.content });
    }
    input.onProgress?.({ type: "thinking", round: rounds + 1 });
    compactToolHistory(messages);
    completion = await provider.complete({ system, messages, tools, maxTokens, temperature, scene: input.scene, signal: input.signal });
    usage = addUsage(usage, completion.usage);
  }
  return { completion, usage, rounds, fileReads, codeSearches };
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

/** micro_compact（借鉴 Claude Code s06 的分级压缩）：发给下一轮前，只保留最近一轮的 tool 结果原文，
    更早轮次的 tool 内容替换为短占位符（模型忘了可再次调用 read_file 重取——结果可再生，不值得逐轮重付）；
    早期 assistant 的 reasoningContent 一并丢弃（后续轮不需要重放思考，推理 token 是账单大头）。
    最近一轮 assistant 的 reasoningContent 保留——部分协议要求 tool 调用轮回传 reasoning_content。 */
export function compactToolHistory(messages: LlmMessage[], placeholderChars = 240): void {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && messages[index].toolCalls?.length) {
      lastAssistant = index;
      break;
    }
  }
  if (lastAssistant <= 0) return;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (index < lastAssistant && message.role === "assistant") message.reasoningContent = undefined;
    if (index < lastAssistant && message.role === "tool" && message.content.length > placeholderChars) {
      message.content = `${message.content.slice(0, placeholderChars)}\n…（早期读取结果已省略以控制上下文，需要完整内容可再次调用 read_file。）`;
    }
  }
}
