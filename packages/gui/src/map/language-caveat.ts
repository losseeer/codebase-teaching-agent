import { CAPABILITY_CELL_LABEL, CAPABILITY_LEVEL_LABEL, type CapabilityLevel, type RepositoryAnalysis, type RepositoryLanguageRow } from "@codebase-tutor/shared";

/** 0.93 → 「93%」；小于 1% 的份额不写成 0%，那会被读成「没有」。 */
export function percent(share: number): string {
  if (!Number.isFinite(share)) return "未知";
  const value = Math.round(share * 1000) / 10;
  return value > 0 && value < 1 ? "<1%" : `${value}%`;
}

/**
  画布上的读数提示：仓内**主要语言**的「依赖边」这一档不是「可信」时，给一枚小徽标 + 悬停说明。

  为什么值得占一格图例：各语言的依赖解析强度本来就不均（Java 的整包导入、Go 的整包落点、
  C/C++ 的头文件名回退……），但过去这件事只写在引擎注释里——用户拿到图没法判断
  「这条边是编译器级的、还是按文件名猜的」。近似必须显式。

  数据只取引擎随分析响应下发的 `languageProfile`（共享能力表的自报口径）：
  界面**不自己判语言、也不自己判档**，缺这个字段（旧引擎）就整块不显示。
*/
export function edgeCaveatOf(profile: RepositoryAnalysis["languageProfile"]): { label: string; detail: string } | undefined {
  if (!profile?.languages.length) return undefined;
  const edge = (row: RepositoryLanguageRow): CapabilityLevel => row.capabilities.cells.dependencyEdge;
  const inGraph = profile.languages.filter((row) => row.inDependencyGraph);
  const primary = inGraph[0] ?? profile.languages[0];
  // 一门口规则都没有的语言占大头：这时图上那些边与它无关，得直说
  if (!primary.inDependencyGraph) {
    return {
      label: `${primary.displayName}：未进依赖图`,
      detail: `本仓最多的文件是 ${primary.displayName}（${primary.files} 个，占 ${percent(primary.fileShare)}），但引擎没有这门语言的依赖解析规则——它既不出符号也不出边。图上剩下的边只覆盖 ${percent(profile.graphFileShare)} 的文件。`
    };
  }
  const level = edge(primary);
  if (level === "exact") return undefined;
  const others = inGraph
    .slice(1)
    .filter((row) => row.fileShare >= 0.05 && edge(row) !== "exact")
    .slice(0, 3)
    .map((row) => `${row.displayName}（${percent(row.fileShare)}）：${CAPABILITY_CELL_LABEL.dependencyEdge}=${CAPABILITY_LEVEL_LABEL[edge(row)]}`);
  const lines = [
    `${primary.displayName} 在本仓有 ${primary.files} 个文件，占 ${percent(primary.fileShare)}。`,
    `${CAPABILITY_CELL_LABEL.dependencyEdge}=${CAPABILITY_LEVEL_LABEL[level]}：${primary.capabilities.notes.dependencyEdge}`,
    ...(others.length ? [`同仓其他语言 —— ${others.join("；")}`] : []),
    ...(profile.parseBackend === "regex" ? [`提醒：本次分析的符号抽取没能用上语法树（${profile.parseBackendReason ?? "原因未记录"}），文件里有哪些函数也要按近似读。`] : [])
  ];
  return { label: `${primary.displayName}：${CAPABILITY_CELL_LABEL.dependencyEdge}=${CAPABILITY_LEVEL_LABEL[level]}`, detail: lines.join("\n") };
}
