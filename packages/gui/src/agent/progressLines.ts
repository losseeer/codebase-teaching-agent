import type { ScopedStreamProgress, TeachingProgress } from "@codebase-tutor/contract";

/** 能变成一行过程提示的帧：`delta` 是正文增量、不进这里，其余各档与教学那层的 `TeachingProgress` 同义。 */
type ProgressFrame = Exclude<ScopedStreamProgress, { type: "delta" }> | TeachingProgress;

/**
  帧 → 阶段。`progress` 剥一层 payload（教学回合走这个形状），
  宏观与练习那两条流直接把阶段名放在 `type` 上——两侧本来就同一套取值，这里只做换算不做判断。
  穷尽守卫在 `default`：shared 的词表加一类而这里没接，编译就不过。
  */function activityOf(event: ProgressFrame): TeachingProgress {
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

/**
  中断那一轮的标题。两种原因必须两句话：预算用完说成「耗时过长」是把一件事伪装成另一件事，
  用户会以为是模型太慢而再点一次重试，然后再撞一次同一道预算闸。
*/
export function interruptText(reason: string): string {
  return reason === "budget" ? "本月预算已用完，已中断" : "执行耗时过长，已中断";
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
    case "loading_skill": return activity.skill ? `正在加载技能 ${activity.skill} …` : "正在加载已装的做法 …";
    case "editing_diagram": return "正在改画布上的图 …";
    case "querying_facts": return "正在查询已有产物 …";
    case "calling_external": return "正在调用外部工具 …";
    case "thinking": return "正在思考…";
  }
}

/**
  过程提示的累积列表：一行一件事，**此刻在做的那件永远排在最后一行**，最多留 6 行。
  - 为什么不能是单行覆盖：读文件与检索都是本机几十毫秒的动作，下一帧「正在思考」立刻盖掉它，
    一整轮肉眼就只剩 thinking——用户看到的不是「它做了什么」，而是「它在等」。
  - 为什么同一件事只留一行、也不报 `×N`：这一格说的是「它做过哪些事、现在在做哪一件」，不是账单。
    次数（含工具轮数）归 journal 的 `loop_round` 与报表去算；把计数摆进进度行，用户读到一个自造的指标，
    读不到他真正想知道的那一句——它到底卡在哪儿。重复做同一件时只把它挪回最后一行。
*/
export function foldProgress(lines: readonly string[], text: string): string[] {
  const index = lines.indexOf(text);
  if (index < 0) return [...lines, text].slice(-6);
  // 已在最后一行 = 此刻正在做的还是它，一个字都不必动
  if (index === lines.length - 1) return [...lines];
  return [...lines.filter((_, at) => at !== index), text].slice(-6);
}
