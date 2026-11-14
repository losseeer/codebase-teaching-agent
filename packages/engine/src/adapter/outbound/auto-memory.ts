/** 画像的自动记录：从一回合问答里提炼一条长期记忆，用户可在面板里改或删。 */
import type { LlmProvider } from "../../application/port/llm-provider.js";
import { appendAutoMemory, readProfile } from "./profile.js";

const SYSTEM = [
  "你是记忆整理助手。判断这一回合里有没有值得长期记住的用户信息：表达偏好、背景、长期关注方向。",
  "只记用户明确表达过的内容；项目里查得到的事实、一次性的临时要求、助手自己的猜测都不要记。",
  "有就只输出 JSON：{\"memory\":\"一句话，不超过 60 字\"}；没有就只输出 {\"memory\":null}。"
].join("\n");

export function parseMemory(raw: string): string | undefined {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { memory?: unknown };
    const value = typeof parsed.memory === "string" ? parsed.memory.trim() : "";
    return value && value.length <= 80 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function extractProfileMemory(input: { question: string; answer: string; profile: string; provider: LlmProvider }): Promise<string | undefined> {
  const completion = await input.provider.complete({
    system: SYSTEM,
    user: `现有画像：\n${input.profile || "（空）"}\n\n本轮问答：\n用户：${input.question.slice(0, 600)}\n助手：${input.answer.slice(0, 1200)}`,
    temperature: 0,
    maxTokens: 120,
    thinking: "off",
    scene: "profile.memory"
  });
  return parseMemory(completion.text);
}

/** 回合结束后异步调用；失败不写画像，也不影响回答。 */
export async function rememberProfileMemory(input: { question: string; answer: string; provider: LlmProvider }): Promise<void> {
  try {
    const memory = await extractProfileMemory({ ...input, profile: readProfile() });
    if (memory) appendAutoMemory(memory);
  } catch {
    // 提炼失败不影响本轮回答；下次回合再试
  }
}
