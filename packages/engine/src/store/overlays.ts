import type { CourseNode, CourseTier, CourseTree, ModuleOverlayRecord, RepositoryOverlays } from "@codebase-tutor/shared";
import type { TutorDatabase } from "./database.js";

/**
  服务端覆盖层，存在 repository_state.settings_json 的 overlays 子键里。
  写侧只有一条路（patchOverlays）：Agent 的 `set_module_tier`、浏览器本地旧值的一次性迁移都走这里——
  多条写路径各写一套合并逻辑，迟早有一处把用户的修正清除。

  settings_json 里还住着引擎自己的内部键（refinement 标记等，见 importer）。
  这里永远是读-合并-写：合并完把原对象整个带回去，只碰 overlays 这个节点；
  整体覆盖会让「润色缓存命中」判定失效，重跑一轮本可复用的命名调用。
  旧版本写过的 `overlays.architecture` 不再读也不再写，原样留在库里。
*/

/** 界面与工具的补丁形状：数组是整份替换（界面自己知道全集），字典是按键合并（增量改一个节点）。 */
export interface OverlaysPatch {
  modules?: {
    renamed?: Record<string, string>;
    tier?: Record<string, CourseTier>;
    hidden?: string[];
    custom?: ModuleOverlayRecord["custom"];
  };
}

/** 只认这个节点里的已知键：未知字段一律不写进去（工具拒写与界面防脏同一口径）。 */
const MODULE_KEYS = ["renamed", "hidden", "custom", "tier"] as const;

export function readOverlays(database: TutorDatabase, repositoryId: string): RepositoryOverlays {
  const settings = database.getSettings<Record<string, unknown>>(repositoryId);
  const overlays = settings?.overlays;
  return overlays && typeof overlays === "object" ? overlays as RepositoryOverlays : {};
}

/** 按 key 合并模块覆盖层；未知键不落盘。 */
export function patchOverlays(database: TutorDatabase, repositoryId: string, patch: OverlaysPatch): RepositoryOverlays {
  const settings = database.getSettings<Record<string, unknown>>(repositoryId) ?? {};
  const current = readOverlays(database, repositoryId);
  const next: RepositoryOverlays = { ...current };

  if (patch.modules) {
    const modules: ModuleOverlayRecord = { ...current.modules };
    for (const key of MODULE_KEYS) {
      const incoming = patch.modules[key];
      if (incoming === undefined) continue;
      if (key === "hidden" || key === "custom") (modules as Record<string, unknown>)[key] = incoming;
      else (modules as Record<string, unknown>)[key] = { ...(modules[key] as Record<string, unknown> ?? {}), ...(incoming as Record<string, unknown>) };
    }
    next.modules = modules;
  }

  database.saveSettings(repositoryId, { ...settings, overlays: next });
  return next;
}

/**
  撤掉其中几个模块的覆盖，让它们回到引擎自己的判据。
  不叫调用方发 `{ 模块 id: undefined }`：JSON 带不动 undefined，靠「值为空串」判删除会把空名字写进图里——这里按 key 显式删。
*/
export function removeOverlayKeys(database: TutorDatabase, repositoryId: string, target: { modules?: { tier?: string[]; renamed?: string[] } }): RepositoryOverlays {
  const settings = database.getSettings<Record<string, unknown>>(repositoryId) ?? {};
  const current = readOverlays(database, repositoryId);
  const next: RepositoryOverlays = { ...current };
  if (target.modules && current.modules) {
    const modules: ModuleOverlayRecord = { ...current.modules };
    if (target.modules.tier) modules.tier = Object.fromEntries(Object.entries(modules.tier ?? {}).filter(([id]) => !target.modules?.tier?.includes(id)));
    if (target.modules.renamed) modules.renamed = Object.fromEntries(Object.entries(modules.renamed ?? {}).filter(([id]) => !target.modules?.renamed?.includes(id)));
    next.modules = modules;
  }
  database.saveSettings(repositoryId, { ...settings, overlays: next });
  return next;
}

/** 撤掉这份产物上的全部人工修正（界面「恢复引擎判据」的整份版本）。 */
export function clearOverlays(database: TutorDatabase, repositoryId: string): RepositoryOverlays {
  const settings = database.getSettings<Record<string, unknown>>(repositoryId) ?? {};
  database.saveSettings(repositoryId, { ...settings, overlays: {} });
  return {};
}

/** 覆盖层的可读摘要：给 `/overlays` 响应与审计线用，界面据此显示「已人工调整」。 */
export function overlayCounts(overlays: RepositoryOverlays): { modules: number } {
  return {
    modules: Object.keys(overlays.modules?.tier ?? {}).length + Object.keys(overlays.modules?.renamed ?? {}).length + (overlays.modules?.hidden?.length ?? 0) + (overlays.modules?.custom?.length ?? 0)
  };
}

/**
  把模块覆盖层落到树上（`/course` 与画布的模块现场共用，界面与 Agent 看到同一份）。
  只做三件事：改名（id 不变，缓存与埋点仍按树 id 走）、隐藏、改档；自建模块追加在分支末尾。
  改档时把引擎原判留在 tierGiven：覆盖值与原值都要在响应里，「恢复引擎判据」与准确性读数才有依据。
*/
export function applyRepositoryOverlays(course: CourseTree, overlays: RepositoryOverlays): CourseTree {
  const branch = course.root.children.find((node) => node.id === "modules");
  if (!branch) return course;
  const modules = overlays.modules ?? {};
  const tiers = modules.tier ?? {};
  const renamed = modules.renamed ?? {};
  const hidden = new Set(modules.hidden ?? []);
  const children = branch.children
    .filter((node) => !hidden.has(node.id))
    .map((node) => {
      const override = tiers[node.id];
      return {
        ...node,
        ...(renamed[node.id] ? { title: renamed[node.id] } : {}),
        ...(override ? { tier: override, tierOverridden: true, ...(node.tier ? { tierGiven: node.tier } : {}) } : {})
      } as CourseNode;
    });
  const custom: CourseNode[] = (modules.custom ?? []).map((item) => ({
    id: item.id,
    title: item.label,
    kind: "module",
    summary: item.hint ?? "用户自建模块（引擎不判它的结构角色）",
    anchors: [],
    children: [],
    tier: "periphery",
    tierOverridden: true
  }));
  return { ...course, root: { ...course.root, children: course.root.children.map((node) => (node === branch ? { ...branch, children: [...children, ...custom] } : node)) } };
}
