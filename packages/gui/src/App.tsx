import { useEffect, useRef, useState, type ReactElement } from "react";
import { Navigate, Route, Routes, Link, useLocation, useSearchParams } from "react-router-dom";
import { BarChart3, BrainCircuit, FolderGit2, MessageCircleQuestion, Network, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import type { Workspace as _Workspace } from "./api/client";
import { api, isNotFound } from "./api/client";
import { AgentRail } from "./agent/AgentRail";
import { useScopedChat } from "./agent/useScopedChat";
import { ImportPage } from "./views/ImportPage";
import { CoursePage } from "./views/CoursePage";
import { TutorPage } from "./views/TutorPage";
import { PracticePage } from "./views/PracticePage";
import { InsightsPage } from "./views/InsightsPage";
import { WorkspaceTabs, type WorkspaceId } from "./views/WorkspaceChrome";
import { Loading } from "./views/helpers";
import { showToast, ToastHost } from "./modules/toast";
import { installJournalRetry } from "./journal";

// Re-export so 子组件可统一从 `../App` 取 Workspace 类型（类型已在 api/client 定义）。
export type Workspace = _Workspace;

/**
  工作区校验在「连不上」时的退避重试节奏（毫秒）。引擎重启（`tsx watch` 改文件即重启）约 150ms 起、
  带原生绑定时也就一秒出头，500ms 起步的三趟足够跨过；总等待 ~5s，再长就该让用户看见了。
  */
const WORKSPACE_RETRY_DELAYS = [500, 1500, 3000] as const;

/**
  顶层 Shell（v0.4）：
  - 侧栏：5 项主导航 + 状态指示
  - 主区：/import 与 /insights 保留独立路由；三个学习工作区（map / teaching / practice）合并为
    单一主区组件树（`/app?workspace=`），对齐 prototype `.studio` —— 三个工作区同时挂载、
    `hidden` 切换可见性（切换不丢状态，语义同 prototype 的 `.workspace.active`）
  - URL：`?workspace=map|teaching|practice` 保深链接；旧路径 /course /tutor /practice 301 兼容跳转
  - 右侧栏：持久 Agent 侧栏（AgentRail），三工作区共享单 Agent

  持久化：workspace（localStorage `codebase-tutor.workspace`）；scope（`codebase-tutor.scope`）。
  thread 为内存态（刷新重置 —— 与 prototype `renderThread()` 语义一致）。

  对应 prototype `design-prototype.html` 中的「主导航 + 工作区主区 + Agent 侧栏」。
  */
export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<_Workspace | null>(() => {
    const saved = localStorage.getItem("codebase-tutor.workspace");
    return saved ? JSON.parse(saved) as _Workspace : null;
  });
  // engine 的仓库注册表**是持久的**：启动时 `restorePersisted()` 会把最后一次导入的仓重新挂回来（单槽），
  // 所以引擎重启正常情况下不需要重新导入。这里仍然要校验，因为有两种真失效：
  // ① 引擎后来挂了别的仓（单槽被顶掉）；② 该仓的 `.tutor` 数据不完整，启动恢复直接放弃。
  // 校验失败要分两类处置：**404 才是「仓库真不在」**（清掉本地选择、引到导入页），
  // 连不上 / 5xx 多半是引擎正在重启（tsx watch 改一下文件就重启），只能退避重试，绝不能顺手清 localStorage。
  // 校验响应迟到时若目标已变（如期间刚完成新导入），放弃过期结果，避免把新 workspace 误清。
  const [workspaceReady, setWorkspaceReady] = useState(() => !localStorage.getItem("codebase-tutor.workspace"));
  /** 校验放弃（连不上 / 5xx 重试耗尽）：本地选择不删，改说「引擎没连上」，并允许手动或 online 后重验。 */
  const [engineUnreachable, setEngineUnreachable] = useState(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const workspaceIdRef = useRef(workspace?.repositoryId);
  useEffect(() => { workspaceIdRef.current = workspace?.repositoryId; }, [workspace?.repositoryId]);
  // 补发上回积压的 UI 事件（网络失败时进了 localStorage 重试队列），并订阅 online 重连
  useEffect(() => { installJournalRetry(); }, []);
  const updateWorkspace = (value: _Workspace | null): void => {
    setWorkspace(value);
    if (value) localStorage.setItem("codebase-tutor.workspace", JSON.stringify(value));
    else localStorage.removeItem("codebase-tutor.workspace");
  };
  useEffect(() => {
    if (!workspace) { setWorkspaceReady(true); setEngineUnreachable(false); return; }
    let current = true;
    const targetId = workspace.repositoryId;
    setWorkspaceReady(false);
    setEngineUnreachable(false);
    const stale = (): boolean => !current || workspaceIdRef.current !== targetId;
    const probe = async (): Promise<void> => {
      for (let attempt = 0; !stale(); attempt += 1) {
        try {
          await api.getIndex(targetId);
          if (!stale()) setWorkspaceReady(true);
          return;
        } catch (error) {
          if (stale()) return;
          if (isNotFound(error)) {
            // 引擎明说「没这个仓」：本地选择确实失效。失效必须说出来——静默清 localStorage 再把用户甩到
            // 导入页，看起来像「软件自己把我的仓库弄丢了」。
            updateWorkspace(null);
            setWorkspaceReady(true);
            showToast("上次打开的仓库不在引擎的注册表里（只保留最后一次导入的那个仓），请重新导入。");
            return;
          }
          // 其余失败（连不上 / 5xx）多半是引擎正在重启，而不是仓库没了：退避重试，绝不清 localStorage。
          const wait = WORKSPACE_RETRY_DELAYS[attempt];
          if (wait === undefined) {
            setEngineUnreachable(true);
            return;
          }
          await new Promise<void>((resolve) => { window.setTimeout(resolve, wait); });
        }
      }
    };
    void probe();
    return () => { current = false; };
  }, [workspace?.repositoryId, probeNonce]);
  // 校验放弃后浏览器报「回到线上」，就自动再验一趟：让用户少点一次按钮
  useEffect(() => {
    if (!engineUnreachable) return;
    const retry = (): void => { setProbeNonce((value) => value + 1); };
    window.addEventListener("online", retry);
    return () => { window.removeEventListener("online", retry); };
  }, [engineUnreachable]);
  const chat = useScopedChat(workspace?.repositoryId ?? "");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("codebase-tutor.sidebar-collapsed") === "1");
  const toggleSidebar = (): void => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("codebase-tutor.sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  };
  // 校验期间的占位：还在退避=转圈；已放弃=说明「引擎没连上」而绝不是「仓库丢了」
  const pending = engineUnreachable && workspace
    ? <EngineOffline repositoryPath={workspace.repositoryPath} onRetry={() => { setProbeNonce((value) => value + 1); }} />
    : <Loading />;
  return (
    <div className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={17} /></span>
          <span className="nav-label">Codebase Tutor</span>
          <button type="button" className="sidebar-toggle" aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={toggleSidebar}>
            {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>
        <nav aria-label="主导航">
          <NavItem to="/import" icon={<FolderGit2 size={17} />} label="导入仓库" />
          <WorkspaceNavItem id="map" icon={<Network size={17} />} label="宏观设计" disabled={!workspace} />
          <WorkspaceNavItem id="teaching" icon={<MessageCircleQuestion size={17} />} label="代码教学" disabled={!workspace} />
          <WorkspaceNavItem id="practice" icon={<BrainCircuit size={17} />} label="练习评估" disabled={!workspace} />
          <NavItem to="/insights" icon={<BarChart3 size={17} />} label="成本监控" disabled={!workspace} />
        </nav>
        <div className="sidebar-bottom">
          <span className={`status-dot ${workspace && !engineUnreachable ? "online" : ""}`} />
          <span className="nav-label">{!workspace ? "等待导入仓库" : engineUnreachable ? "本地引擎未连接" : "本地引擎已连接"}</span>
        </div>
      </aside>
      <main className="main-content">
        <Routes>
          {/* 根路径固定落导入页（用户口径 09-23）：不带 workspace 记忆直通 /app——导入是每次打开的起点 */}
          <Route path="/" element={<Navigate to="/import" replace />} />
          <Route path="/import" element={<ImportPage onImported={(next) => { updateWorkspace(next); chat.reloadCourseData(); }} workspace={workspace} />} />
          <Route path="/insights" element={guard(workspace, workspaceReady, <InsightsPage workspace={workspace!} />, pending)} />
          <Route path="/app" element={guard(workspace, workspaceReady, <Workbench workspace={workspace!} chat={chat} />, pending)} />
          <Route path="/course" element={<Navigate to="/app?workspace=map" replace />} />
          <Route path="/tutor" element={<Navigate to="/app?workspace=teaching" replace />} />
          <Route path="/practice" element={<Navigate to="/app?workspace=practice" replace />} />
          <Route path="*" element={workspace ? (workspaceReady ? <Navigate to="/app?workspace=map" replace /> : pending) : <Navigate to="/import" replace />} />
        </Routes>
      </main>
      {workspace ? <AgentRail chat={chat} /> : null}
      <ToastHost />
    </div>
  );
}

/** 路由守卫：workspace 恢复自 localStorage 时需等引擎验证完成（workspaceReady）再渲染，避免失效 id 先跳宏观设计。 */
function guard(workspace: _Workspace | null, ready: boolean, content: ReactElement, pending: ReactElement): ReactElement {
  if (!workspace) return <Navigate to="/import" replace />;
  return ready ? content : pending;
}

/** 引擎连不上 ≠ 仓库没了：保留本地选择，说清原因并给一次手动重验。 */
function EngineOffline({ repositoryPath, onRetry }: { repositoryPath: string; onRetry: () => void }): ReactElement {
  return (
    <div className="page empty-state">
      <h1>连不上本地引擎</h1>
      <p>仓库选择已保留（{repositoryPath}）。引擎没起来或正在重启——开发态改一下 engine 里的文件就会重启一次，这属于瞬时而不是仓库丢了。</p>
      <p><button type="button" className="primary" onClick={onRetry}>重新校验</button></p>
    </div>
  );
}

/** 禁用态导航项必须有话可说：灰掉却不解释，看起来像坏了。 */
const DISABLED_NAV_HINT = "先导入仓库：还没有可操作的工作区";

function NavItem({ to, icon, label, disabled }: { to: string; icon: ReactElement; label: string; disabled?: boolean }): ReactElement {
  const location = useLocation();
  const active = location.pathname === to;
  return disabled
    ? <span className="nav-item disabled" title={DISABLED_NAV_HINT}>{icon}<span className="nav-label">{label}</span></span>
    : <Link className={`nav-item ${active ? "active" : ""}`} to={to}>{icon}<span className="nav-label">{label}</span></Link>;
}

/** 三个学习工作区的侧栏入口：active 判定 = /app + ?workspace= 参数。 */
function WorkspaceNavItem({ id, icon, label, disabled }: { id: WorkspaceId; icon: ReactElement; label: string; disabled?: boolean }): ReactElement {
  const [params] = useSearchParams();
  const location = useLocation();
  const active = location.pathname === "/app" && (params.get("workspace") ?? "map") === id;
  if (disabled) return <span className="nav-item disabled" title={DISABLED_NAV_HINT}>{icon}<span className="nav-label">{label}</span></span>;
  return <Link className={`nav-item ${active ? "active" : ""}`} to={`/app?workspace=${id}`}>{icon}<span className="nav-label">{label}</span></Link>;
}

/**
  单一学习主区（prototype `.workbench` + `.workspace`）：
  - WorkspaceTabs 是真 tab（不再走路由），切换只改 `?workspace=`
  - 三个工作区始终挂载，`hidden` 控制可见 —— 切换不重新请求数据（prototype 同语义）
  - 作用域跟随工作区（prototype `activate(view) → setScope(view)`）
  */
function Workbench({ workspace, chat }: { workspace: _Workspace; chat: ReturnType<typeof useScopedChat> }): ReactElement {
  const [params, setParams] = useSearchParams();
  const raw = params.get("workspace");
  const active: WorkspaceId = raw === "teaching" || raw === "practice" ? raw : "map";
  useEffect(() => { chat.setScope(active); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active]);
  return (
    <div className="workbench-root">
      <WorkspaceTabs active={active} onChange={(id) => setParams(id === "map" ? { workspace: "map" } : { workspace: id })} />
      <div className="workbench-view" hidden={active !== "map"}><CoursePage workspace={workspace} chat={chat} /></div>
      <div className="workbench-view" hidden={active !== "teaching"}><TutorPage workspace={workspace} chat={chat} /></div>
      <div className="workbench-view" hidden={active !== "practice"}><PracticePage workspace={workspace} chat={chat} /></div>
    </div>
  );
}
