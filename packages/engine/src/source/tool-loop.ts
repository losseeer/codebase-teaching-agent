import type { LlmCompletion, LlmMessage, LlmProvider, LlmUsage } from "../llm/provider.js";
import { READ_FILE_TOOL, executeReadFile, type FileReadRecord } from "./read-file.js";

/**
  read_file 工具循环（宏观设计 map 与教学 teaching 两个作用域共用）：

  - 预算硬上限（轮数 / 累计**读成功**的文件数）；用尽时对未应答的 tool_call 明确回绝，再做一轮不带工具的收尾回答。
    被护栏拒绝或路径写错的调用**不占文件额度**（代价只有一行文本，且「反复乱试」已由轮数兜住），但仍逐条进 fileReads 审计；
  - messages[0] 恒为首轮 user 消息——provider 提供 messages 时忽略 user 字段，
    首轮 user 若不进 messages，工具调用后的轮次会同时丢失代码上下文与学习者提问（回归防线）；
  - 每轮调用前 micro_compact：更早轮次的 tool 结果压成占位符、早期 reasoningContent 丢弃
    （读取结果可再生，推理 token 是账单大头）；最近一轮 assistant 的 reasoningContent 保留（部分协议要求回传）；
  - 每次 read_file（含拒绝与失败）返回审计记录，由调用方记 journal file_read。
  */

export type ReadToolProgress = { type: "thinking"; round: number } | { type: "reading"; path: string };

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
}

export interface ReadToolLoopResult {
  completion: LlmCompletion;
  usage?: LlmUsage;
  fileReads: FileReadRecord[];
}

export async function completeWithReadTool(input: ReadToolLoopInput): Promise<ReadToolLoopResult> {
  const { provider, system, maxTokens, temperature } = input;
  const messages: LlmMessage[] = [{ role: "user", content: input.user }];
  input.onProgress?.({ type: "thinking", round: 1 });
  let completion = await provider.complete({ system, user: input.user, tools: [READ_FILE_TOOL], maxTokens, temperature, scene: input.scene });
  const fileReads: FileReadRecord[] = [];
  let usage: LlmUsage | undefined = completion.usage;
  let rounds = 0;
  let succeededReads = 0;
  while (completion.toolCalls?.length) {
    if (rounds >= input.maxRounds || succeededReads >= input.maxCalls) {
      messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", toolCallId: call.id, content: "已达到本次对话的读文件上限，请基于已有上下文直接回答。" });
      }
      input.onProgress?.({ type: "thinking", round: rounds + 2 });
      compactToolHistory(messages);
      completion = await provider.complete({ system, messages, maxTokens, temperature, scene: input.scene });
      usage = addUsage(usage, completion.usage);
      break;
    }
    rounds += 1;
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls, reasoningContent: completion.reasoningContent });
    for (const call of completion.toolCalls) {
      if (call.name !== READ_FILE_TOOL.name) {
        messages.push({ role: "tool", toolCallId: call.id, content: `未知工具 ${call.name}；只支持 read_file。` });
        continue;
      }
      input.onProgress?.({ type: "reading", path: readPathHint(call.argumentsJson) });
      const outcome = executeReadFile(input.repoPath, call.argumentsJson);
      fileReads.push(outcome.audit);
      if (!outcome.audit.denied) succeededReads += 1;
      messages.push({ role: "tool", toolCallId: call.id, content: outcome.content });
    }
    input.onProgress?.({ type: "thinking", round: rounds + 1 });
    compactToolHistory(messages);
    completion = await provider.complete({ system, messages, tools: [READ_FILE_TOOL], maxTokens, temperature, scene: input.scene });
    usage = addUsage(usage, completion.usage);
  }
  return { completion, usage, fileReads };
}

function addUsage(total: LlmUsage | undefined, addition?: LlmUsage): LlmUsage | undefined {
  if (!addition) return total;
  if (!total) return { inputTokens: addition.inputTokens, outputTokens: addition.outputTokens };
  return { inputTokens: total.inputTokens + addition.inputTokens, outputTokens: total.outputTokens + addition.outputTokens };
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
