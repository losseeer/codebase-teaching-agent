import type { ChatThread } from "@codebase-tutor/contract";
import type { Exercise, TutorSettings } from "@codebase-tutor/domain";

import type { MapBinding, Scope } from "./chatScope";
import type { MessageExtra, ThreadItem } from "./threadItems";

export interface ScopedChatApi {
  scope: Scope;
  setScope: (next: Scope) => void;

  /** Agent 侧栏消息流：内存态，正文真源在引擎库。 */
  threads: Record<Scope, ThreadItem[]>;
  /**
    text 存原文（不预 escape）；variant：error/hint/ask/warn。
    extra 带提问候选或中断上下文。返回气泡 id。
    */
  pushMessage: (scope: Scope, role: "user" | "agent", text: string, variant?: "error" | "hint" | "ask" | "warn", extra?: MessageExtra) => string;
  /** 最新一句提问的气泡 id；开新回合即失效。 */
  liveAsk: Record<Scope, string | null>;

  /** 会话线程清单（真源在引擎库，updated_at 倒序）；currentThreadId 为当前打开的线程。 */
  chatThreads: Record<Scope, ChatThread[]>;
  currentThreadId: Record<Scope, string | null>;
  /** 只清空当前线程；id 由引擎在第一句落库时发。 */
  newThread: (scope: Scope) => void;
  switchThread: (scope: Scope, threadId: string | null) => void;
  renameThread: (scope: Scope, threadId: string, title: string) => Promise<void>;
  /** 软删；AgentRail 侧有二次确认弹窗。 */
  removeThread: (scope: Scope, threadId: string) => Promise<void>;

  /** 教学作用域：`file:<path>` / `dir:<path>`；null = 还没选。 */
  scopeRef: string | null;
  /** 作用域显示名（文件名 / 目录名 / 仓库根目录）。 */
  scopeLabel: string;
  setScopeRef: (ref: string | null) => void;
  /** 产物数据版本：重导入 / 产物更新时递增。 */
  dataVersion: number;
  /** 强制重发产物相关请求。 */
  reloadRepositoryData: () => void;

  /** map-chat 的作用域提示文件清单；由 DiagramPage 写入。 */
  mapScopePaths: string[];
  setMapScope: (scopePaths: string[]) => void;
  /** 绑定行数据（只读展示）；null = 未绑定 */
  mapBinding: MapBinding | null;
  setMapBinding: (binding: MapBinding | null) => void;
  mapFile: string;
  setMapFile: (path: string) => void;

  /** 画布当前打开的图：绑定行显示，并随 map-chat 上送。 */
  openDiagram: { id: string; name: string } | null;
  setOpenDiagram: (diagram: { id: string; name: string } | null) => void;
  /** 一次性投递：页面取走后清空。 */
  pendingDiagramOpen: { id: string; name: string } | null;
  requestOpenDiagram: (diagram: { id: string; name: string }) => void;
  clearDiagramOpen: () => void;

  /** 练习作用域绑定（练习 #N · 文件）；由 PracticePage 写入 */
  practiceUnit: string;
  setPracticeUnit: (label: string) => void;
  settings: TutorSettings;
  setSettings: (next: TutorSettings | ((prev: TutorSettings) => TutorSettings)) => void;
  content: string;
  setContent: (next: string) => void;
  sending: boolean;
  /** 停止当前在途回合：通知引擎并中止连接；无在途回合时空操作。 */
  stopTurn: () => void;
  /** 过程指示行：最新在末尾、最多 6 行；空数组 = 无进行中任务。 */
  progress: Record<Scope, string[]>;
  liveAnswer: string;
  error: string;
  send: () => Promise<void>;
  /** answer = 提问候选那句短标签（省略则发输入框内容）；resumeAsk = 认领的提问句柄。 */
  sendMap: (answer?: string, resumeAsk?: string) => Promise<void>;
  sendPractice: (answer?: string) => Promise<void>;
  /** 最近一条回复的来源；空串 = 本作用域尚无回复；显式展示 LLM 是否参与。 */
  replySource: Record<Scope, string>;
  /** 当前练习对象（练习评估作用域的对话上下文）；由 PracticePage 写入 */
  practiceExercise: Exercise | null;
  setPracticeExercise: (exercise: Exercise | null) => void;
}
