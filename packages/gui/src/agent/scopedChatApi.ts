import type { ChatThread, Exercise, TutorSettings } from "@codebase-tutor/shared/wire";
import type { MapBinding, Scope } from "./chatScope";
import type { MessageExtra, ThreadItem } from "./threadItems";

export interface ScopedChatApi {
  scope: Scope;
  setScope: (next: Scope) => void;

  /** Agent 侧栏 thread 状态：3 作用域各独立，内存态（跨路由共享；正文真源在引擎库）。写入器只有 `pushMessage`——清空由线程边界负责。 */
  threads: Record<Scope, ThreadItem[]>;
  /** `text` 存原文（不预 escape）；agent 消息可选 variant（"error" 错误 / "hint" 本地提示 / "ask" 向用户提问 / "warn" 这一轮被中断）。
      `extra`：提问的候选与认领句柄、图卡片，或中断那条上的「重试要重发的原句 + 中断前做过的几件事」。返回落这条气泡的 id。 */
  pushMessage: (scope: Scope, role: "user" | "agent", text: string, variant?: "error" | "hint" | "ask" | "warn", extra?: MessageExtra) => string;
  /** 还亮着的那排提问按钮属于哪条气泡（一开新回合就换人）；旧提问的按钮不再按得动。 */
  liveAsk: Record<Scope, string | null>;

  /**
    会话线程（三作用域各一份独立列表，真源在引擎库里）：
    `chatThreads` 按 updated_at 倒序，`currentThreadId` 是当前打开的线程。
    新建 / 切换 / 重命名 / 删除四个动作都在这里；软删口径见 api/client.ts 的 `listThreads` 注释。
    */
  chatThreads: Record<Scope, ChatThread[]>;
  currentThreadId: Record<Scope, string | null>;
  /** 「＋」只清空当前线程：线程 id 由引擎在第一句话落库时才发，没人发言的线程不该躺在库里。 */
  newThread: (scope: Scope) => void;
  switchThread: (scope: Scope, threadId: string | null) => void;
  renameThread: (scope: Scope, threadId: string, title: string) => Promise<void>;
  /** 软删线程：GUI 侧二次确认在 AgentRail（文案要让用户看见「审计日志仍保留脱敏摘要」）。 */
  removeThread: (scope: Scope, threadId: string) => Promise<void>;

  /** 教学作用域：`file:<path>` / `dir:<path>`；null = 还没选。 */
  scopeRef: string | null;
  /** 作用域的人话标签（文件名 / 目录名 / 仓库根目录）。 */
  scopeLabel: string;
  setScopeRef: (ref: string | null) => void;
  /** 数据代数：重新导入 / 产物更新时递增，画布与源码树据此重取。 */
  dataVersion: number;
  /** 强制重发产物相关请求（导入完成或收到 repository.updated 后调用）。 */
  reloadRepositoryData: () => void;

  /** 宏观设计作用域的文件清单：由 DiagramPage 选中画布节点时写入，map-chat 只把它当作用域提示。 */
  mapScopePaths: string[];
  setMapScope: (scopePaths: string[]) => void;
  /** 绑定行数据（AgentRail 的「绑定」只读展示）；null = 未绑定，不再默认拼根节点 */
  mapBinding: MapBinding | null;
  setMapBinding: (binding: MapBinding | null) => void;
  mapFile: string;
  setMapFile: (path: string) => void;

  /**
    画布上正打开的那张图（宏观设计 = 画图工作区）。两件事靠它：绑定行显示「当前图：X」，
    以及 map-chat 把它当作用域上送——「把这条边删掉」得有个所指。
  */
  openDiagram: { id: string; name: string } | null;
  setOpenDiagram: (diagram: { id: string; name: string } | null) => void;
  /** 对话里的图卡片点开 → 页面取走这一格去开图（取完清空）。 */
  pendingDiagramOpen: { id: string; name: string } | null;
  requestOpenDiagram: (diagram: { id: string; name: string }) => void;
  clearDiagramOpen: () => void;

  /** 练习作用域绑定（练习 #N · 文件）：由 PracticePage 写入 */
  practiceUnit: string;
  setPracticeUnit: (label: string) => void;
  settings: TutorSettings;
  setSettings: (next: TutorSettings | ((prev: TutorSettings) => TutorSettings)) => void;
  content: string;
  setContent: (next: string) => void;
  sending: boolean;
  /** 停止当前在途回合：既告诉引擎别算了（省 token），也中止自己的连接。没有在途回合时为空操作。 */
  stopTurn: () => void;
  /** 回复生成过程指示（按作用域，一行一件事，最新在末尾、最多 6 行）：如「正在读取 src/app.ts …」「正在检索代码：限流 …」；空数组 = 无进行中任务。三作用域都走各自请求的 SSE 事件——引擎发事件、GUI 定文案 */
  progress: Record<Scope, string[]>;
  liveAnswer: string;
  error: string;
  send: () => Promise<void>;
  /** 作用域对话：宏观设计 / 练习评估的单轮 LLM 讨论。`answer` = 用户点了某条提问候选时那句短标签（省略就发输入框里那句）；`resumeAsk` = 它在认领哪一句提问。 */
  sendMap: (answer?: string, resumeAsk?: string) => Promise<void>;
  sendPractice: (answer?: string) => Promise<void>;
  /** 最近一条回复的来源（按作用域记录；"local-heuristic-v1" = 启发式回落；空串 = 本作用域尚无回复）。显式展示 LLM 是否参与，不静默回落 */
  replySource: Record<Scope, string>;
  /** 当前练习对象（练习评估作用域的对话上下文；由 PracticePage 写入） */
  practiceExercise: Exercise | null;
  setPracticeExercise: (exercise: Exercise | null) => void;
}
