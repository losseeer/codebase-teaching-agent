/** 画像与技能编辑器共用的文本整理：只返回文本，不落盘。 */
import { lightLlm } from "../../infrastructure/composition-root.js";

const SYSTEM = [
  "你在整理一份用户维护的 markdown 文本。",
  "没有指令时做润色：合并重复、去重、理顺结构与措辞，不新增事实、不改变用户原意。",
  "有指令时只做指令要求的最小改动，其余原样保留。",
  "只输出 JSON：{\"text\":\"整理后的全文\"}"
].join("\n");

export type TextEditResult = { ok: true; text: string } | { ok: false; error: string };

export async function editTextUseCase(input: { text: string; label: string; instruction?: string; limit?: number }): Promise<TextEditResult> {
  const limit = input.limit ?? 8_000;
  const provider = lightLlm();
  if (!provider) return { ok: false, error: "未配置可用的模型，无法润色。" };
  try {
    const completion = await provider.complete({
      system: SYSTEM,
      user: `【${input.label}】\n${input.text.slice(0, limit)}\n\n${input.instruction ? `用户指令：${input.instruction.slice(0, 500)}` : "（无指令：只做润色）"}`,
      temperature: 0,
      maxTokens: 2_000,
      thinking: "off",
      scene: "text.edit"
    });
    const match = completion.text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: "模型没有返回可用文本。" };
    const parsed = JSON.parse(match[0]) as { text?: unknown };
    if (typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > limit) {
      return { ok: false, error: "模型没有返回可用文本。" };
    }
    return { ok: true, text: parsed.text.trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "整理失败" };
  }
}
