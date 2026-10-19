import type { ArchitectureOverrides, CourseNode, CourseTier, CourseTree, ModuleOverlayRecord, RepositoryOverlays } from "@codebase-tutor/shared";
import type { TutorDatabase } from "./database.js";

/**
  服务端覆盖层，存在 repository_state.settings_json 的 overlays 子键里。
  写侧只有一条路（patchOverlays）：GUI 的拖动、Agent 的 set_architecture 工具、浏览器本地旧值的一次性迁移都走这里——
  多条写路径各写一套合并逻辑，迟早有一处把用户的修正清除。

  settings_json 里还住着引擎自己的内部键（refinement 标记等，见 importer）。
  这里永远是读-合并-写：合并完把原对象整个带回去，只碰 overlays 这个节点；
  整体覆盖会让「润色缓存命中」判定失效，重跑一轮本可复用的命名调用。
*/

/** 界面与工具的补丁形状：数组是整份替换（界面自己知道全集），字典是按键合并（增量改一个节点）。 */
export interface OverlaysPatch {
  modules?: {
    renamed?: Record<string, string>;
    tier?: Record<string, CourseTier>;
    hidden?: string[];
    custom?: ModuleOverlayRecord["custom"];
  };
  architecture?: ArchitectureOverrides;
}

/** 只认这个节点里的已知键：未知字段一律不写进去（工具拒写与界面防脏同一口径）。 */
const MODULE_KEYS = ["renamed", "hidden", "custom", "tier"] as const;
export function readOverlays(database: TutorDatabase, repositoryId: string): RepositoryOverlays {
  const settings = database.getSettings<Record<string, unknown>>(repositoryId);
  const overlays = settings?.overlays;
  return overlays && typeof overlays === "object" ? overlays as RepositoryOverlays : {};
}

/**
  改名时把引用旧层名的归层记录一起换掉——留下两套名字，下一次读到的模块会散落在两个层里，
  「恢复模型原判」也找不回原样。这个节点合并在写侧做，读侧（applyOverrides）不必猜。
*/
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
    // 显式改回某档 = 该模块的覆盖保留；`reset` 走 removeKeys，不在这里做隐式删除
    next.modules = modules;
  }

  if (patch.architecture) {
    const architecture: ArchitectureOverrides = { ...current.architecture };
    const renamed = patch.architecture.layerRenames;
    if (renamed) {
      const merged = { ...(architecture.layerRenames ?? {}), ...renamed };
      // 旧名 → 新名：归层表里指着旧名的先改成新名，再合入新的 renames（否则 A→B、B→C 会漏换第二跳）
      const moduleLayer = { ...(architecture.moduleLayer ?? {}) };
      for (const [from, to] of Object.entries(renamed)) {
        for (const [moduleId, layerName] of Object.entries(moduleLayer)) if (layerName === from) moduleLayer[moduleId] = to;
      }
      architecture.moduleLayer = moduleLayer;
      architecture.layerRenames = merged;
    }
    if (patch.architecture.moduleLayer) architecture.moduleLayer = { ...(architecture.moduleLayer ?? {}), ...patch.architecture.moduleLayer };
    next.architecture = architecture;
  }

  database.saveSettings(repositoryId, { ...settings, overlays: next });
  return next;
}

/**
  撤掉其中几个节点的覆盖，让那几个模块/层回到引擎自己的判据。
  不叫调用方发 `{ 模块 id: undefined }`：JSON 带不动 undefined，靠「值为空串」判删除会把空名字写进图里——这里按 key 显式删。

  architecture.layerRenames 收层名，原层名与新层名都认（改名记录存「原判名 → 改成」，模型与界面看得见的是后者）。
  撤掉一条改名时，指着新名字的归层写回旧名字——不写回这些模块下次读就「目标层不存在」（patchOverlays 里正向合并的反向）。
*/
export function removeOverlayKeys(database: TutorDatabase, repositoryId: string, target: { modules?: { tier?: string[]; renamed?: string[] }; architecture?: { moduleLayer?: string[]; layerRenames?: string[] } }): RepositoryOverlays {
  const settings = database.getSettings<Record<string, unknown>>(repositoryId) ?? {};
  const current = readOverlays(database, repositoryId);
  const next: RepositoryOverlays = { ...current };
  if (target.modules && current.modules) {
    const modules: ModuleOverlayRecord = { ...current.modules };
    if (target.modules.tier) modules.tier = Object.fromEntries(Object.entries(modules.tier ?? {}).filter(([id]) => !target.modules?.tier?.includes(id)));
    if (target.modules.renamed) modules.renamed = Object.fromEntries(Object.entries(modules.renamed ?? {}).filter(([id]) => !target.modules?.renamed?.includes(id)));
    next.modules = modules;
  }
  if (current.architecture && (target.architecture?.moduleLayer?.length || target.architecture?.layerRenames?.length)) {
    let architecture: ArchitectureOverrides = current.architecture;
    if (target.architecture.moduleLayer?.length) {
      architecture = { ...architecture, moduleLayer: Object.fromEntries(Object.entries(architecture.moduleLayer ?? {}).filter(([id]) => !target.architecture?.moduleLayer?.includes(id))) };
    }
    if (target.architecture.layerRenames?.length) {
      const wanted = target.architecture.layerRenames;
      const entries = Object.entries(architecture.layerRenames ?? {});
      const dropped = entries.filter(([from, to]) => wanted.includes(from) || wanted.includes(to));
      const moduleLayer = { ...architecture.moduleLayer };
      for (const [from, to] of dropped) for (const [moduleId, name] of Object.entries(moduleLayer)) if (name === to) moduleLayer[moduleId] = from;
      architecture = { ...architecture, layerRenames: Object.fromEntries(entries.filter(([from, to]) => !dropped.some(([dFrom, dTo]) => dFrom === from && dTo === to))), moduleLayer };
    }
    next.architecture = architecture;
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

/** 覆盖层的可读摘要：给 `/course`、`/architecture` 的响应与审计线用，界面据此显示「已人工调整」。 */
export function overlayCounts(overlays: RepositoryOverlays): { modules: number; layers: number } {
  return {
    modules: Object.keys(overlays.modules?.tier ?? {}).length + Object.keys(overlays.modules?.renamed ?? {}).length + (overlays.modules?.hidden?.length ?? 0) + (overlays.modules?.custom?.length ?? 0),
    layers: Object.keys(overlays.architecture?.moduleLayer ?? {}).length + Object.keys(overlays.architecture?.layerRenames ?? {}).length
  };
}

/**
  把模块覆盖层落到树上（/course 与 /architecture 共用，界面与 Agent 看到同一份）。
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
