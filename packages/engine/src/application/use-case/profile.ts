/** 用户与 agent 的画像沟通：按一句话更新画像，返回回话与更新后的全文。 */
import { lightLlm } from "../../infrastructure/composition-root.js";
import { appendAutoMemory, readProfile, writeProfile } from "../../adapter/outbound/profile.js";

const SYSTEM = [
  "你在维护用户画像（跨仓库生效的长期偏好与背景）。",
  "只做用户这句话要求的最小改动：新增就追加到合适的「## 」小节，删除就删掉对应内容，修改就原地改；用户没提到的内容原样保留。",
  "只记用户明确表达过的偏好，不编造，也不写具体项目里的事实。",
  "只输出 JSON：{\"reply\":\"一句回话，不超过 40 字\",\"profile\":\"更新后的画像全文（markdown）\"}"
].join("\n");

export type ProfileChatResult = { ok: true; reply: string; profile: string } | { ok: false; error: string };

export function parseProfileUpdate(raw: string): { reply: string; profile: string } | undefined {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { reply?: unknown; profile?: unknown };
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    const profile = typeof parsed.profile === "string" ? parsed.profile : "";
    if (!profile || profile.length > 4000) return undefined;
    return { reply: reply || "已更新画像。", profile };
  } catch {
    return undefined;
  }
}

export async function profileChatUseCase(message: string): Promise<ProfileChatResult> {
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "请先输入要记住或修改的内容。" };
  const provider = lightLlm();
  if (!provider) {
    // 没有可用模型：只做追加，并如实说明没做整理
    const added = appendAutoMemory(trimmed);
    return { ok: true, reply: added ? "已追加到自动记录（未配置模型，未做整理）。" : "这条已经记过了。", profile: readProfile() };
  }
  try {
    const completion = await provider.complete({
      system: SYSTEM,
      user: `当前画像：\n${readProfile() || "（空）"}\n\n用户这句话：${trimmed.slice(0, 500)}`,
      temperature: 0,
      maxTokens: 800,
      thinking: "off",
      scene: "profile.chat"
    });
    const parsed = parseProfileUpdate(completion.text);
    if (!parsed) return { ok: false, error: "模型没有返回可用的画像更新，请重试或直接编辑。" };
    writeProfile(parsed.profile);
    return { ok: true, reply: parsed.reply, profile: readProfile() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "更新画像失败" };
  }
}
