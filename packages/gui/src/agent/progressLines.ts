import type { ScopedStreamProgress, TeachingProgress } from "@codebase-tutor/contract";

/** 可转成过程提示行的帧；delta 是正文增量，不含。 */
type ProgressFrame = Exclude<ScopedStreamProgress, { type: "delta" }> | TeachingProgress;

/** 帧 → 阶段：progress 形状剥一层 payload。 */
function activityOf(event: ProgressFrame): TeachingProgress {
  if ("stage" in event) return event;
  switch (event.type) {
    case "thinking": return { stage: "thinking" };
    case "reading": return { stage: "reading", path: event.path };
    case "searching": return { stage: "searching", query: event.query };
    case "loading_skill": return { stage: "loading_skill", skill: event.skill };
    case "editing_diagram": return { stage: "editing_diagram" };
    case "querying_facts": return { stage: "querying_facts" };
    case "calling_external": return { stage: "calling_external" };
    case "progress": return event.payload;
    default: {
      const unhandled: never = event;
      throw new Error(`未登记的过程帧：${JSON.stringify(unhandled)}`);
    }
  }
}

/** 中断标题：预算与超时两种原因分开说。 */
export function interruptText(reason: string): string {
  return reason === "budget" ? "本月预算已用完，已中断" : "执行耗时过长，已中断";
}

/** 过程提示的中文文案，三作用域共用；帧缺席时返回「回复生成中…」。 */
export function progressText(event: ProgressFrame | undefined): string {
  if (!event) return "回复生成中…";
  const activity = activityOf(event);
  switch (activity.stage) {
    case "reading": return `正在读取 ${activity.path || "代码文件"} …`;
    case "searching": return `正在检索代码：${activity.query || "关键词"} …`;
    case "loading_skill": return activity.skill ? `正在加载技能 ${activity.skill} …` : "正在加载已装的做法 …";
    case "editing_diagram": return "正在改画布上的图 …";
    case "querying_facts": return "正在查询已有产物 …";
    case "calling_external": return "正在调用外部工具 …";
    case "thinking": return "正在思考…";
  }
}

/** 过程行列表：同一行去重并挪到末尾，最多留 6 行。 */
export function foldProgress(lines: readonly string[], text: string): string[] {
  const index = lines.indexOf(text);
  if (index < 0) return [...lines, text].slice(-6);
  if (index === lines.length - 1) return [...lines];
  return [...lines.filter((_, at) => at !== index), text].slice(-6);
}
