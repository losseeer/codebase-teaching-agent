import type { ScopedStreamProgress, TeachingProgress } from "@codebase-tutor/shared/wire";

/** 能变成一行过程提示的帧：`delta` 是正文增量、不进这里，其余四类与教学那层的 `TeachingProgress` 同义。 */
type ProgressFrame = Exclude<ScopedStreamProgress, { type: "delta" }> | TeachingProgress;

/**
  帧 → 三档阶段之一。`progress` 剥一层 payload（教学回合走这个形状），
  宏观与练习那两条流直接把阶段名放在 `type` 上——两侧本来就同一套取值，这里只做换算不做判断。
  穷尽守卫在 `default`：shared 的词表加一类而这里没接，编译就不过。
  */
function activityOf(event: ProgressFrame): TeachingProgress {
  if ("stage" in event) return event;
  switch (event.type) {
    case "thinking": return { stage: "thinking", round: event.round };
    case "reading": return { stage: "reading", path: event.path };
    case "searching": return { stage: "searching", query: event.query };
    case "progress": return event.payload;
    default: {
      const unhandled: never = event;
      throw new Error(`未登记的过程帧：${JSON.stringify(unhandled)}`);
    }
  }
}

/**
  过程提示的中文文案，三个作用域共用一份：文案在这一层定——引擎不该关心中文措辞，GUI 不该猜阶段语义。
  种类由 `shared` 的词表管，漏接编译不过。
  帧整个缺席（引擎没带 payload）时给「回复生成中…」：那是过程提示的措辞档位，不是伪造的事实读数。
  */
export function progressText(event: ProgressFrame | undefined): string {
  if (!event) return "回复生成中…";
  const activity = activityOf(event);
  switch (activity.stage) {
    case "reading": return `正在读取 ${activity.path || "代码文件"} …`;
    case "searching": return `正在检索代码：${activity.query || "关键词"} …`;
    case "thinking": return activity.round && activity.round > 1 ? `正在思考（第 ${activity.round} 轮）…` : "正在思考…";
    default: {
      const unhandled: never = activity;
      throw new Error(`未登记的过程阶段：${JSON.stringify(unhandled)}`);
    }
  }
}
