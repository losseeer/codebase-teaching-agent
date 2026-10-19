import type { CourseNode, CourseTier, CourseTierEvidence, CourseTree } from "@codebase-tutor/shared";

/**
  教学模块（业务模块）：模块 = 课程树「仓库模块地图」分支下的一个节点，
  它的文件清单来自树结构本身（节点自己的锚点 + 子孙节点的锚点），不靠关键词猜。
  持久化只存覆盖层（改名 / 隐藏 / 自建），按仓库分键；模块本体每次从课程树实时计算，
  所以重新导入后新增/消失的模块会自动跟上。
  */

export interface ModuleEntry {
  /** 树节点 id：点击时按它回查节点并选中（断链的条目调用方要能跳过） */
  id: string;
  title: string;
  path: string;
  line: number;
}

export interface KnowledgeModule {
  id: string;
  label: string;
  hint: string;
  /** 用户自建模块（教学侧 = 自己圈的主题，没有树结构背书；练习侧 = LLM 出题主题标签） */
  custom?: boolean;
  /** 业务模块的文件清单（口径见 `moduleEntries`）；自建模块与练习主题为空 */
  entries?: ModuleEntry[];
  /** 分级（引擎按模块可见文件的结构角色给出）；缺省 = 引擎未给（如自建主题），界面按扁平渲染 */
  tier?: CourseTier;
  /** 引擎原判：用户手动改过档后仍留着它，界面才能显示「引擎判：设施」并给「恢复引擎判据」 */
  tierGiven?: CourseTier;
  /** 这一档是人工改过的（由 /course 告知）：界面只露一枚「已人工调整」的点，不写解释 */
  tierOverridden?: boolean;
  /** 这一档按哪些数判出来的（悬停可见） */
  tierEvidence?: CourseTierEvidence;
}

export type ModuleWhere = "teaching" | "practice";

/**
  练习侧默认只有一个固定模块「程序理解题」（规则出题三题型，不可删除）；
  用户自建模块 = LLM 出题主题标签。练习侧的列表与教学侧分开存储，互不影响。
  */
export const PRACTICE_DEFAULT_MODULES: KnowledgeModule[] = [
  { id: "comprehension", label: "程序理解题", hint: "规则出题 · 改代码 / 修改定位 / 影响分析，判分确定" }
];

/** 程序理解题固定模块 id（practice 出题分派与删除保护的判据）。 */
export const COMPREHENSION_MODULE_ID = "comprehension";

/** 课程树里业务模块所在分支的固定 id（见 engine `coursetree/build.ts`）。 */
const MODULE_BRANCH_ID = "modules";

const CUSTOM_KEY_PREFIX = "codebase-tutor.modules.";
const HIDDEN_KEY_PREFIX = "codebase-tutor.hidden-modules.";
const RENAMED_KEY_PREFIX = "codebase-tutor.renamed-modules.";
const TIER_KEY_PREFIX = "codebase-tutor.module-tiers.";
const ACTIVE_KEY_PREFIX = "codebase-tutor.module.";

const TIERS: CourseTier[] = ["core", "facility", "periphery"];

/** 自建模块的持久化形状（entries 是派生值，不落盘）。 */
type StoredCustomModule = { id: string; label: string; hint: string };

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown): void => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 持久化失败不回退：本次会话内仍生效 */ }
};

/**
  界面的本地覆盖层：改名、隐藏、自建。三样都是显示偏好，换浏览器丢了也不影响结论。
  手动改档不在这里——它归服务端。
*/
export interface ModuleOverrides {
  renamed: Record<string, string>;
  hidden: string[];
  custom: StoredCustomModule[];
}

export function loadModuleOverrides(repositoryId: string): ModuleOverrides {
  const renamed = readJson<Record<string, string>>(RENAMED_KEY_PREFIX + repositoryId, {});
  const hidden = readJson<string[]>(HIDDEN_KEY_PREFIX + repositoryId, []);
  const custom = readJson<StoredCustomModule[]>(CUSTOM_KEY_PREFIX + repositoryId, []);
  return {
    renamed: renamed && typeof renamed === "object" && !Array.isArray(renamed) ? renamed : {},
    hidden: Array.isArray(hidden) ? hidden.filter((id): id is string => typeof id === "string") : [],
    custom: Array.isArray(custom) ? custom.filter((item) => typeof item?.id === "string" && typeof item?.label === "string") : []
  };
}

export function saveModuleOverrides(repositoryId: string, overrides: ModuleOverrides): void {
  writeJson(RENAMED_KEY_PREFIX + repositoryId, overrides.renamed);
  writeJson(HIDDEN_KEY_PREFIX + repositoryId, overrides.hidden);
  writeJson(CUSTOM_KEY_PREFIX + repositoryId, overrides.custom);
}

/** 浏览器里遗留的手动改档：只读一次，交给服务端后删本地键（不双写）。 */
export function readLegacyTierOverrides(repositoryId: string): Record<string, CourseTier> {
  const storedTier = readJson<Record<string, CourseTier>>(TIER_KEY_PREFIX + repositoryId, {});
  if (!storedTier || typeof storedTier !== "object" || Array.isArray(storedTier)) return {};
  const tier: Record<string, CourseTier> = {};
  for (const [id, value] of Object.entries(storedTier)) if (TIERS.includes(value)) tier[id] = value;
  return tier;
}

export function clearLegacyTierOverrides(repositoryId: string): void {
  try { localStorage.removeItem(TIER_KEY_PREFIX + repositoryId); } catch { /* 清不掉不阻塞：下次再迁，服务端合并是幂等的 */ }
}

/**
  一个模块节点的文件清单：本节点与子孙节点的全部锚点，按 path 去重（先到先得，顺序是深度优先访问序）。
  与引擎的 `collectCandidates`（推荐入口候选池）刻意不是同一判据：那边一个节点只取第一条锚点，
  这边要的是文件集合。
  */
function moduleEntries(node: CourseNode): ModuleEntry[] {
  const byPath = new Map<string, ModuleEntry>();
  const walk = (current: CourseNode): void => {
    for (const anchor of current.anchors) {
      if (!byPath.has(anchor.path)) byPath.set(anchor.path, { id: current.id, title: current.title, path: anchor.path, line: anchor.line });
    }
    current.children.forEach(walk);
  };
  walk(node);
  return [...byPath.values()];
}

/** 课程树 → 业务模块清单（未套覆盖层的原样）。分支缺失（空仓/未导入完）时给空数组。 */
export function courseModules(tree: CourseTree | null | undefined): KnowledgeModule[] {
  const branch = tree?.root?.children?.find((node) => node.id === MODULE_BRANCH_ID);
  if (!branch) return [];
  // 档位与「引擎原判」都由 /course 给出（服务端覆盖层已叠好），界面不自己判谁改过
  return branch.children.map((node) => ({ id: node.id, label: node.title, hint: node.summary, tier: node.tier, tierGiven: node.tierGiven ?? node.tier, tierOverridden: node.tierOverridden, tierEvidence: node.tierEvidence, entries: moduleEntries(node) }));
}

/** 业务模块 + 覆盖层 → 界面看到的清单。改名只影响显示，id 仍是树节点 id（缓存与埋点按它走）。 */
export function mergeModules(treeModules: KnowledgeModule[], overrides: ModuleOverrides): KnowledgeModule[] {
  const visible = treeModules
    .filter((item) => !overrides.hidden.includes(item.id))
    .map((item) => ({ ...item, label: overrides.renamed[item.id] ?? item.label }));
  return [...visible, ...overrides.custom.map((item) => ({ id: item.id, label: item.label, hint: item.hint, custom: true }))];
}

export function loadPracticeModules(): KnowledgeModule[] {
  const stored = readJson<KnowledgeModule[]>("codebase-tutor.practice-modules", []);
  const custom = Array.isArray(stored) ? stored.filter((item) => item?.custom === true && typeof item.id === "string" && typeof item.label === "string") : [];
  return [...PRACTICE_DEFAULT_MODULES.map((item) => ({ ...item })), ...custom];
}

export function savePracticeModules(modules: KnowledgeModule[]): void {
  writeJson("codebase-tutor.practice-modules", modules.filter((item) => item.custom === true));
}

/** 上次停在哪个模块；模块已不存在（被隐藏/树里没了）时回落第一个。 */
export function loadActiveModule(where: ModuleWhere, repositoryId: string, modules: KnowledgeModule[]): string {
  const saved = readJson<string | null>(ACTIVE_KEY_PREFIX + where + "." + repositoryId, null);
  if (saved && modules.some((item) => item.id === saved)) return saved;
  return modules[0]?.id ?? "";
}

export function saveActiveModule(where: ModuleWhere, repositoryId: string, id: string): void {
  writeJson(ACTIVE_KEY_PREFIX + where + "." + repositoryId, id);
}
