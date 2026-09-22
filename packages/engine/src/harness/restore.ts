import type { DecompositionDepth, JournalEvent, Pedagogy, TeachingStage, TutorMessage, TutorSession } from "@codebase-tutor/shared";
import { validateSettings } from "../policy/policy.js";

const STAGES = new Set<TeachingStage>(["orient", "procedure", "concept", "verify", "confirmed"]);

/**
  会话续命：`sessions` 是引擎进程内存态，重启即清零；09-22 起每个教学回合在 journal 里都有
  带 sessionId 的 turn_text（双边文本）+ hint_depth（unit_id/stage/fallback_count）+ style_shift
  （settings 快照），按 sessionId 重放即可重建「最近的对话」。

  诚实边界：
  - 回合文本只能恢复 turn_text 上线之后的部分，更早的回合没有可考之源；上下文只取最近窗口，损失有限；
  - question/answer 各自最多 2000 字（落盘即截断），进提示词前还要再切 160 字/行，实际不构成损失；
  - 缺最低证据（带 unit_id 的 hint_depth）就返回 undefined——调用方照旧 404/400，让 GUI 走新建会话，绝不编造半截状态。
  */
export function restoreSessionFromJournal(events: JournalEvent[], sessionId: string): TutorSession | undefined {
  const mine = events.filter((event) => event.sessionId === sessionId);
  const lastHint = [...mine].reverse().find((event) => event.type === "hint_depth");
  const courseNodeId = typeof lastHint?.payload.unit_id === "string" && lastHint.payload.unit_id ? lastHint.payload.unit_id : undefined;
  if (!lastHint || !courseNodeId) return undefined;

  const lastStyle = [...mine].reverse().find((event) => event.type === "style_shift");
  const settings = validateSettings({
    style: typeof lastStyle?.payload.style === "number" ? lastStyle.payload.style : undefined,
    // journal payload 只保证是 string；具体枚举由 validateSettings 归型（非法值回落默认），这里的断言只是过类型闸
    pedagogy: typeof lastStyle?.payload.pedagogy === "string" ? lastStyle.payload.pedagogy as Pedagogy : undefined,
    depth: typeof lastStyle?.payload.depth === "string" ? lastStyle.payload.depth as DecompositionDepth : undefined
  });
  const stage = STAGES.has(lastHint.payload.stage as TeachingStage) ? (lastHint.payload.stage as TeachingStage) : "orient";
  const rawFallback = lastHint.payload.fallback_count;
  const fallbackCount = typeof rawFallback === "number" && Number.isInteger(rawFallback) && rawFallback >= 0 ? rawFallback : 0;

  const messages: TutorMessage[] = mine
    .filter((event) => event.type === "turn_text" && event.payload.scene === "teach")
    .flatMap((event) => [
      { id: `${event.id}-u`, role: "user" as const, content: typeof event.payload.question === "string" ? event.payload.question : "", createdAt: event.at },
      { id: `${event.id}-a`, role: "assistant" as const, content: typeof event.payload.answer === "string" ? event.payload.answer : "", createdAt: event.at, stage }
    ]);

  return {
    id: sessionId,
    repositoryId: mine[0].repositoryId,
    courseNodeId,
    style: settings.style,
    settings,
    stage,
    fallbackCount,
    messages,
    createdAt: mine[0].at
  };
}
