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

/** 把课程树拍平并按模块归类 → teaching「推荐入口」数据。 */
export function classifyCourseNodes(root: CourseNode, modules: KnowledgeModule[]): ModuleEntry[] {
  const walk = (node: CourseNode): ModuleEntry[] => {
    const own = node.anchors.length
      ? [{
          id: node.id,
          title: node.title,
          path: node.anchors[0].path,
          line: node.anchors[0].line,
          moduleId: classifyModule(`${node.title} ${node.summary} ${node.anchors[0].path}`, modules),
        }]
      : [];
    return [...own, ...node.children.flatMap(walk)];
  };
  return walk(root);
}
