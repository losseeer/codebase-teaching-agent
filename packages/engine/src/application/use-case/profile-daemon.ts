/** 每 24h 整理一次用户画像：读近一天的问答，整份重写；失败显式记日志，不静默跳过。 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { traceEngine } from "@codebase-tutor/platform";

import { importer, lightLlm, profileStore } from "../../infrastructure/composition-root.js";

const DAY_MS = 86_400_000;
const META_PATH = join(homedir(), ".codebase-tutor", "profile-meta.json");

function lastRunAt(): number {
  try {
    const parsed = JSON.parse(readFileSync(META_PATH, "utf8")) as { lastRunAt?: unknown };
    return typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : 0;
  } catch {
    return 0;
  }
}

function recentTurns(since: string): string[] {
  const lines: string[] = [];
  for (const entry of importer.catalog()) {
    const path = join(entry.repositoryPath, ".tutor", "journal.jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      try {
        const event = JSON.parse(line) as { type?: string; at?: string; payload?: { question?: unknown; answer?: unknown } };
        if (event.type !== "turn_text" || !event.at || event.at < since) continue;
        lines.push(`问：${String(event.payload?.question ?? "").slice(0, 300)}\n答：${String(event.payload?.answer ?? "").slice(0, 300)}`);
      } catch {
        // 坏行按没有这一条处理
      }
    }
  }
  return lines;
}

export async function runProfileDaemon(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastRunAt() < DAY_MS) return;
  const turns = recentTurns(new Date(now - DAY_MS).toISOString());
  if (!turns.length) {
    writeFileSync(META_PATH, JSON.stringify({ lastRunAt: now }), "utf8");
    return;
  }
  const provider = lightLlm();
  if (!provider) {
    traceEngine("degrade", { what: "profile_daemon", reason: "llm_unavailable" }, { traceId: null });
    return;
  }
  try {
    const completion = await provider.complete({
      system: [
        "你在维护跨仓库的用户画像（markdown）。",
        "结合当前画像与最近 24 小时的问答，整份重写画像：保留长期偏好与背景，合并重复、删去过时的；项目里查得到的事实不写。",
        "只输出 JSON：{\"profile\":\"画像全文\"}"
      ].join("\n"),
      user: `当前画像：\n${profileStore.readProfile() || "（空）"}\n\n近 24 小时问答：\n${turns.join("\n---\n").slice(0, 8_000)}`,
      temperature: 0,
      maxTokens: 1_200,
      thinking: "off",
      scene: "profile.daemon"
    });
    const match = completion.text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("模型没有返回画像");
    const parsed = JSON.parse(match[0]) as { profile?: unknown };
    if (typeof parsed.profile !== "string" || !parsed.profile.trim()) throw new Error("模型返回空画像");
    profileStore.writeProfile(parsed.profile);
    writeFileSync(META_PATH, JSON.stringify({ lastRunAt: now }), "utf8");
    traceEngine("profile_daemon", { ok: true, turns: turns.length, chars: parsed.profile.length }, { traceId: null });
  } catch (error) {
    traceEngine("degrade", { what: "profile_daemon", reason: error instanceof Error ? error.message : String(error) }, { traceId: null });
  }
}
