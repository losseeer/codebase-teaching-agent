import type { RepositoryAnalysis } from "@codebase-tutor/shared";

/**
  影响范围注入（A2，2026-09-22）：把 watcher 增量重分析落盘的 `lastIncrementalUpdate`
  （改动文件 + 依赖图反查波及）转成一段简短参考文本，追加到流程层与推荐入口选择层的 user 消息末尾。
  学习动线里「用户最近在动哪些文件」正是讲解与选材最想要的倾向信号，而它此前只进了练习层。

  **只进上下文、不进缓存键**：变更清单每次保存监听中的仓库都会刷新，进键等于每次保存都把全仓
  已缓存的流程/推荐重烧一遍，而这段只是「当前重心在哪」的倾向提示，不到正确性输入的级别。
  代价是命中缓存的结果可能是变更检测前生成的版本——接受：结构事实（文件/符号/依赖/摘要）已由
  重分析刷新，真正影响答案的变化会让 digest/候选清单自己翻键。
*/
export type RecentChangesInput = Pick<RepositoryAnalysis, "lastIncrementalUpdate">;

/** 超过 72 小时「近期」就是撒谎：那是仓库历史，结构层早已消化，不再注入。 */
const MAX_AGE_MS = 72 * 3_600_000;
/** 两条清单各最多列 8 个路径：真仓 Java 路径平均 60+ 字符，全列会把参考段撑成正文。 */
const MAX_PATHS_SHOWN = 8;

const GUIDANCE = "本段只是倾向提示，不是证据来源：文件落点与选择仍以上文清单为准；证据相当时可优先讲解或推荐这些当前活跃文件。";

export function buildRecentChangesSection(analysis: RecentChangesInput, now: number = Date.now()): string | undefined {
  const update = analysis.lastIncrementalUpdate;
  if (!update || !update.changedPaths.length) return undefined;
  const detectedAt = Date.parse(update.at);
  if (!Number.isFinite(detectedAt)) return undefined;
  const ageMs = Math.max(0, now - detectedAt);
  if (ageMs > MAX_AGE_MS) return undefined;
  const changed = new Set(update.changedPaths);
  // impactRadius 把改动自身也计进 impactedPaths，波及线只列「被牵连的别人」
  const impacted = update.impactedPaths.filter((path) => !changed.has(path));
  const shown = (paths: string[]): string =>
    `${paths.slice(0, MAX_PATHS_SHOWN).join("、")}${paths.length > MAX_PATHS_SHOWN ? `（另有 ${paths.length - MAX_PATHS_SHOWN} 个未列出）` : ""}`;
  return [
    `近期仓库变更（本地文件监听${ageMs < 60_000 ? "刚刚检测到" : `于 ${humanAge(ageMs)}检测到`}）：`,
    `- 改动文件（${update.changedPaths.length}）：${shown(update.changedPaths)}`,
    ...(impacted.length ? [`- 依赖图上被其波及（${impacted.length}，不含改动自身）：${shown(impacted)}`] : []),
    GUIDANCE
  ].join("\n");
}

function humanAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
