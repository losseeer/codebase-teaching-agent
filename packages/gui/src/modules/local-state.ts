import { classifyModuleId } from "@codebase-tutor/shared";
import type { CourseNode } from "@codebase-tutor/shared";

/**
  知识模块（prototype `DEFAULT_MODULES` / `state.modules` 的 GUI 实现）：
  - 缺省四个计算机知识模块，可在「＋ 配置」里重命名 / 新增 / 删除 / 恢复缺省
  - 持久化：localStorage `codebase-tutor.modules` + `codebase-tutor.module.<where>`
  - `classify`：把课程节点 / 仓库文件按关键词归类到模块（teaching 推荐入口 / practice 列表的数据源）

  对应 prototype `design-prototype.html` 中的 DEFAULT_MODULES / NODES / EXERCISES。
  与 prototype 差异：prototype 的推荐入口是静态数据；GUI 用关键词分类从真实课程树推导。
  */

export interface KnowledgeModule {
  id: string;
  label: string;
  hint: string;
  /** 用户自建模块（practice 侧 = LLM 出题主题标签；可删）。缺省模块无此字段。 */
  custom?: boolean;
}

export type ModuleWhere = "teaching" | "practice";

export const DEFAULT_MODULES: KnowledgeModule[] = [
  { id: "network", label: "计算机网络", hint: "HTTP 入口、超时、重试与幂等" },
  { id: "os", label: "操作系统", hint: "进程内状态、IO 边界与并发" },
  { id: "lang", label: "语言特性", hint: "类型收窄、异步编排与错误处理" }
];

/**
  practice 侧缺省只有一个固定模块「程序理解题」（规则出题三题型，不可删除）；
  用户自建模块 = LLM 出题主题标签（family 对用户不可见，出题时分派在引擎侧完成）。
  与 teaching 的模块列表分开存储，互不影响。
  */
export const PRACTICE_DEFAULT_MODULES: KnowledgeModule[] = [
  { id: "comprehension", label: "程序理解题", hint: "规则出题 · 预测输出 / 修改定位 / 影响分析，判分确定" }
];

/** 程序理解题固定模块 id（practice 出题分派与删除保护的判据）。 */
export const COMPREHENSION_MODULE_ID = "comprehension";

const MODULES_KEY = "codebase-tutor.modules";
const PRACTICE_MODULES_KEY = "codebase-tutor.practice-modules";
const ACTIVE_KEY_PREFIX = "codebase-tutor.module.";

export function loadModules(): KnowledgeModule[] {
  try {
    const raw = localStorage.getItem(MODULES_KEY);
    if (!raw) return DEFAULT_MODULES.map((item) => ({ ...item }));
    const parsed = JSON.parse(raw) as KnowledgeModule[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_MODULES.map((item) => ({ ...item }));
    return parsed.filter((item) => item && typeof item.id === "string" && typeof item.label === "string");
  } catch {
    return DEFAULT_MODULES.map((item) => ({ ...item }));
  }
}

export function saveModules(modules: KnowledgeModule[]): void {
  try { localStorage.setItem(MODULES_KEY, JSON.stringify(modules)); } catch { /* 持久化失败不回退 */ }
}

export function loadPracticeModules(): KnowledgeModule[] {
  try {
    const raw = localStorage.getItem(PRACTICE_MODULES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as KnowledgeModule[];
      const custom = Array.isArray(parsed) ? parsed.filter((item) => item?.custom === true && typeof item.id === "string" && typeof item.label === "string") : [];
      return [...PRACTICE_DEFAULT_MODULES.map((item) => ({ ...item })), ...custom];
    }
  } catch { /* 读取失败回落缺省 */ }
  return PRACTICE_DEFAULT_MODULES.map((item) => ({ ...item }));
}

export function savePracticeModules(modules: KnowledgeModule[]): void {
  try { localStorage.setItem(PRACTICE_MODULES_KEY, JSON.stringify(modules.filter((item) => item.custom === true))); } catch { /* 持久化失败不回退 */ }
}

export function loadActiveModule(where: ModuleWhere, modules: KnowledgeModule[]): string {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY_PREFIX + where);
    if (saved && modules.some((item) => item.id === saved)) return saved;
  } catch { /* ignore */ }
  return modules[0]?.id ?? "";
}

export function saveActiveModule(where: ModuleWhere, id: string): void {
  try { localStorage.setItem(ACTIVE_KEY_PREFIX + where, id); } catch { /* ignore */ }
}

/** 关键词分类：返回命中的第一个模块 id；都不命中时不会归到任何模块下（shared 在候选里没有 `other` 时返回空串）。关键词表在 shared（与 engine 练习出题过滤共用）。 */
export function classifyModule(text: string, modules: KnowledgeModule[]): string {
  return classifyModuleId(text, modules.map((item) => item.id));
}

export interface ModuleEntry {
  id: string;
  title: string;
  path: string;
  line: number;
  moduleId: string;
}

/**
  把课程树拍平并按模块归类 → teaching「推荐入口」数据。
  **按文件去重**：同一个文件在树里会出现很多次（每条经过它的流程都挂一个节点、文件节点下还挂着符号节点——
  真仓 dianping 实测 1209 个带锚点节点只对应 168 个文件），逐节点输出会让清单里同一个文件重复十几遍。
  保留树里第一条（DFS 前序 ≈ 最浅层），但**真正归到某模块的那条优先于未归类的**——
  否则先遇到的未归类节点会把能命中的那条顶掉，模块下反而什么都不剩。
  */
export function classifyCourseNodes(root: CourseNode, modules: KnowledgeModule[]): ModuleEntry[] {
  const byPath = new Map<string, ModuleEntry>();
  const walk = (node: CourseNode): void => {
    const anchor = node.anchors[0];
    if (anchor) {
      const entry: ModuleEntry = {
        id: node.id,
        title: node.title,
        path: anchor.path,
        line: anchor.line,
        moduleId: classifyModule(`${node.title} ${node.summary} ${anchor.path}`, modules),
      };
      const kept = byPath.get(anchor.path);
      if (!kept || (!kept.moduleId && entry.moduleId)) byPath.set(anchor.path, entry);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return [...byPath.values()];
}
