import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import type { TeachingState, TutorAction } from "./state-machine.js";

export interface ActionProposal {
  action: TutorAction | undefined;
  usage?: LlmUsage;
}

export const ACTION_CONTRACTS: Record<TutorAction, string> = {
  advance: "学习者做出实质性尝试（推测、描述执行路径、提出澄清问题），推进到下一教学阶段。",
  step_down: "学习者需要帮助，降低脚手架，给出更小的提示。",
  give_answer: "学习者连续求助无法继续，直接给出答案并转入检验。仅当本阶段已给过至少一次提示时才允许。",
  confirm: "学习者给出连接源码证据的解释、确认掌握。仅当教学阶段为 verify 时才允许。"
};

const SYSTEM_PROMPT = [
  "你是教学对话的动作决策器。基于教学阶段、提示计数、最近对话、课程上下文和学习者最新发言，从固定动作菜单中选择且仅选择一个动作：",
  ...Object.entries(ACTION_CONTRACTS).map(([action, contract]) => `- ${action}：${contract}`),
  "输出契约：只输出一个动作名（advance / step_down / give_answer / confirm），不要解释、不要标点。"
].join("\n");

/**
 * 守门校验——教学法不变量，模型无权绕过：
 * 1. 熔断前置：give_answer 只有在已给过一次提示（fallbackCount + 1 >= 2）时才允许；
 * 2. 确认门禁：confirm 只有在 verify 阶段才允许。
 */
export function isActionAllowed(state: TeachingState, action: TutorAction): boolean {
  if (action === "give_answer") return state.fallbackCount + 1 >= 2;
  if (action === "confirm") return state.stage === "verify";
  return true;
}

/** LLM 单轮动作提议；解析失败或调用失败返回 undefined，由调用方走确定性路径，不阻塞教学回合。 */
export async function proposeAction(state: TeachingState, learnerMessage: string, transcript: string[], context: string, provider: LlmProvider): Promise<ActionProposal> {
  const user = [
    `教学阶段：${state.stage}`,
    `本阶段已给提示次数：${state.fallbackCount}`,
    `学习者尝试轮数：${state.attempts}`,
    "最近对话：",
    transcript.length ? transcript.join("\n") : "（无）",
    "",
    "课程上下文：",
    context,
    "",
    `学习者本轮输入：${learnerMessage}`
  ].join("\n");
  try {
    const completion = await provider.complete({ system: SYSTEM_PROMPT, user, maxTokens: 12, temperature: 0, scene: "teaching.action" });
    return { action: parseAction(completion.text), usage: completion.usage };
  } catch {
    return { action: undefined };
  }
}

function parseAction(text: string): TutorAction | undefined {
  const matches = [...text.matchAll(/\b(advance|step_down|give_answer|confirm)\b/g)].map((match) => match[1] as TutorAction);
  return matches[0];
}
