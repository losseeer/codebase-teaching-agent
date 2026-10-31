export type Pedagogy = "socratic" | "explanatory" | "practice";
export type DecompositionDepth = "macro" | "micro";

/**
  教学回合是纯问答：不推进阶段、不记 fallbackCount，也不产生提示阶梯那一类事件。
  库里与 journal 的历史行仍带着阶段与阶梯的取值，读侧不再解释它们（字段留在 SQLite 列里不迁移）。
*/
export interface TeachingPolicy {
  constraints: string[];
  pedagogy: Pedagogy;
  depth: DecompositionDepth;
}

export interface TutorSettings {
  pedagogy: Pedagogy;
  depth: DecompositionDepth;
}

export interface TutorMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface TutorSession {
  id: string;
  repositoryId: string;
  /** 教学作用域：`file:<仓内路径>` 或 `dir:<仓内目录>`。 */
  scopeRef: string;
  settings: TutorSettings;
  messages: TutorMessage[];
  createdAt: string;
}
