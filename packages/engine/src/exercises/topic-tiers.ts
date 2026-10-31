/**
  主题分解表：从出题技能正文与其附属文件里抽出来，出题那一趟直接当输入用。
  档 id 取附属文件名，可考点取表格第一列原文；代码里不另抄一份。
*/

const TOPIC_SKILL = "exercise-code-concepts";
/** 四档都套不上时模型该填的档标记。 */
export const OFF_TIER = "off";

export interface TopicTier {
  id: string;
  label: string;
  /** 该档的可考点名。 */
  points: string[];
  /** 该档最常出的缺陷形状。 */
  defects: string;
  /** 该档在沙箱里判不出来的性质。 */
  offLimits: string;
}

export interface TopicIndex {
  tiers: TopicTier[];
  /** 并进系统提示词的那段；技能没装就是空串。 */
  prompt: string;
}

export const NO_TOPICS: TopicIndex = { tiers: [], prompt: "" };

/** 表格行拆单元格：丢分隔行，保留表头由调用方裁。 */
function tableRows(text: string): string[][] {
  return text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2 && !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
}

/** 正文那张 `主题 | 附属文件 | 缺陷形状` 表。 */
function tierRows(body: string): { id: string; label: string; file: string; defects: string }[] {
  return tableRows(body).flatMap((cells) => {
    const file = /`?([a-z0-9-]+\.md)`?/.exec(cells[1] ?? "")?.[1];
    if (!file || !cells[0]) return [];
    return [{ id: file.replace(/\.md$/, ""), label: cells[0], file, defects: cells[2] ?? "" }];
  });
}

/** 某一节标题下的正文。 */
function section(text: string, heading: string): string {
  const start = text.split("\n").findIndex((line) => line.trim().startsWith("## ") && line.includes(heading));
  if (start < 0) return "";
  const rest = text.split("\n").slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("## "));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n").trim();
}

/** 第一张表的考点列（表头丢掉）。 */
function pointNames(sectionText: string): string[] {
  const rows = tableRows(sectionText);
  return rows.slice(1).map((cells) => cells[0] ?? "").filter(Boolean);
}

function promptOf(tiers: TopicTier[]): string {
  const lines = tiers.map((tier) => [
    `- ${tier.id}｜${tier.label}：${tier.points.join("、")}`,
    `  这一档最常出的缺陷：${tier.defects}`,
    `  这一档在沙箱里判不出来的性质：${tier.offLimits}（只限制问哪一层，不构成拒题）`
  ].join("\n"));
  return [
    "主题分解表（判据是代码证据：标识符、结构、配置项）：",
    ...lines,
    "",
    "用法：",
    "- 学习者写的主题不必与档名同字（「计算机网络」归 cn），先归档，再按该档的可考点出题。",
    "- 命中可考点就出题：topic_tier 填档 id，exam_point 填那个可考点的原文。",
    `- 四档都套不上时 topic_tier 填 ${OFF_TIER}，且只出「读出声明与前提」型：题面问这段代码或配置声明了什么契约、前提是什么、违反了会怎样；参考答案的每条要点都要能在摘录里读到原文。`,
    "- 拒绝只允许基于「摘录里一个可考点都读不出来」，reason 要点名找过哪几档；不得以「仓里没有协议栈、没有真实网络、没有数据库」这类学科体系缺失为由拒绝。",
    "",
    `出题那份 JSON 再多两个字段："topic_tier":"${tiers.map((tier) => tier.id).join("|")}|${OFF_TIER}","exam_point":"<可考点原文，${OFF_TIER} 时留空>"`
  ].join("\n");
}

/** 技能装了就抽出分解表，没装或抽不出可考点就回空索引。 */
export function topicIndex(bodyOf: (name: string, file?: string) => string | undefined): TopicIndex {
  const body = bodyOf(TOPIC_SKILL);
  if (!body) return NO_TOPICS;
  const tiers = tierRows(body).flatMap((row) => {
    const attached = bodyOf(TOPIC_SKILL, row.file);
    if (!attached) return [];
    const points = pointNames(section(attached, "能摘出来考的"));
    return points.length ? [{ ...row, points, offLimits: section(attached, "不要出成题的") }] : [];
  });
  return tiers.length ? { tiers, prompt: promptOf(tiers) } : NO_TOPICS;
}

/** 模型填的档是否在这张表里；表外的值一律当 `off`。 */
export function validTierOf(index: TopicIndex, raw: string): string {
  const tier = raw.trim().toLowerCase();
  return index.tiers.some((item) => item.id === tier) ? tier : OFF_TIER;
}
