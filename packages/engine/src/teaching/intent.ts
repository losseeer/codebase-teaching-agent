import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { classifyIntentRegex } from "./state-machine.js";
import type { LearnerIntent, TeachingState } from "./state-machine.js";

export interface IntentClassification {
  intent: LearnerIntent;
  source: "llm" | "regex";
  usage?: LlmUsage;
}

const SYSTEM_PROMPT = [
  "你是教学对话的意图分类器。根据教学阶段、最近对话和学习者最新发言，把本轮输入分类为且仅分类为以下标签之一：",
  "- needs_help：学习者表达无法继续、请求提示或直接要答案。",
  "- confirmation：学习者给出连接证据的解释，或明确表示理解并说明原因。",
  "- progress：学习者做出实质性尝试（推测、描述执行路径、提出澄清问题），既非求助也非确认。",
  "输出契约：只输出一个标签（needs_help / confirmation / progress），不要解释、不要标点。"
].join("\n");

/** LLM 单轮意图分类；任何失败（网络、空输出、非法标签）都回落正则分类，不阻塞教学回合。降级通过 source 字段显式暴露。 */
export async function classifyIntent(state: TeachingState, learnerMessage: string, transcript: string[], provider: LlmProvider): Promise<IntentClassification> {
  const user = [
    `教学阶段：${state.stage}`,
    "最近对话：",
    transcript.length ? transcript.join("\n") : "（无）",
    `学习者本轮输入：${learnerMessage}`
  ].join("\n");
  try {
    const completion = await provider.complete({ system: SYSTEM_PROMPT, user, maxTokens: 12, temperature: 0, scene: "teaching.intent" });
    const intent = parseLabel(completion.text);
    if (!intent) {
      return { intent: classifyIntentRegex(state, learnerMessage), source: "regex", usage: completion.usage };
    }
    return { intent, source: "llm", usage: completion.usage };
  } catch {
    return { intent: classifyIntentRegex(state, learnerMessage), source: "regex" };
  }
}

function parseLabel(text: string): LearnerIntent | undefined {
  const matches = [...text.matchAll(/\b(needs_help|confirmation|progress)\b/g)].map((match) => match[1] as LearnerIntent);
  return matches[0];
}
