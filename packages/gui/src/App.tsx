import { useEffect, useState, type ReactElement } from "react";
import { Navigate, Route, Routes, Link, useLocation, useSearchParams } from "react-router-dom";
import { BarChart3, BrainCircuit, FolderGit2, MessageCircleQuestion, Network, Sparkles } from "lucide-react";
import type { Workspace as _Workspace } from "./api/client";
import { AgentRail } from "./agent/AgentRail";
import { useTeachingSession } from "./agent/useTeachingSession";
import { ImportPage } from "./views/ImportPage";
import { CoursePage } from "./views/CoursePage";
import { TutorPage } from "./views/TutorPage";
import { PracticePage } from "./views/PracticePage";
import { InsightsPage } from "./views/InsightsPage";
import { WorkspaceTabs, type WorkspaceId } from "./views/WorkspaceChrome";
import { ToastHost } from "./modules/toast";

// Re-export so 子组件可统一从 `../App` 取 Workspace 类型（类型已在 api/client 定义）。
export type Workspace = _Workspace;

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
  const updateWorkspace = (value: _Workspace | null): void => {
    setWorkspace(value);
    if (value) localStorage.setItem("codebase-tutor.workspace", JSON.stringify(value));
    else localStorage.removeItem("codebase-tutor.workspace");
  };
  const session = useTeachingSession(workspace?.repositoryId ?? "");
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Sparkles size={17} /></span><span>Codebase Tutor</span></div>
        <nav aria-label="主导航">
          <NavItem to="/import" icon={<FolderGit2 size={17} />} label="导入仓库" />
          <WorkspaceNavItem id="map" icon={<Network size={17} />} label="课程地图" disabled={!workspace} />
          <WorkspaceNavItem id="teaching" icon={<MessageCircleQuestion size={17} />} label="教学会话" disabled={!workspace} />
          <WorkspaceNavItem id="practice" icon={<BrainCircuit size={17} />} label="练习复习" disabled={!workspace} />
          <NavItem to="/insights" icon={<BarChart3 size={17} />} label="成本监控" disabled={!workspace} />
        </nav>
        <div className="sidebar-bottom">
          <span className={`status-dot ${workspace ? "online" : ""}`} />
          <span>{workspace ? "本地引擎已连接" : "等待导入仓库"}</span>
        </div>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/import" element={<ImportPage onImported={updateWorkspace} workspace={workspace} />} />
          <Route path="/insights" element={workspace ? <InsightsPage workspace={workspace} /> : <Navigate to="/import" replace />} />
          <Route path="/app" element={workspace ? <Workbench workspace={workspace} session={session} /> : <Navigate to="/import" replace />} />
          <Route path="/course" element={<Navigate to="/app?workspace=map" replace />} />
          <Route path="/tutor" element={<Navigate to="/app?workspace=teaching" replace />} />
          <Route path="/practice" element={<Navigate to="/app?workspace=practice" replace />} />
          <Route path="*" element={workspace ? <Navigate to="/app?workspace=map" replace /> : <Navigate to="/import" replace />} />
        </Routes>
      </main>
      {workspace ? <AgentRail session={session} /> : null}
      <ToastHost />
    </div>
  );
}

function NavItem({ to, icon, label, disabled }: { to: string; icon: ReactElement; label: string; disabled?: boolean }): ReactElement {
  const location = useLocation();
  const active = location.pathname === to;
  return disabled ? <span className="nav-item disabled">{icon}{label}</span> : <Link className={`nav-item ${active ? "active" : ""}`} to={to}>{icon}{label}</Link>;
}

/** 三个学习工作区的侧栏入口：active 判定 = /app + ?workspace= 参数。 */
function WorkspaceNavItem({ id, icon, label, disabled }: { id: WorkspaceId; icon: ReactElement; label: string; disabled?: boolean }): ReactElement {
  const [params] = useSearchParams();
  const location = useLocation();
  const active = location.pathname === "/app" && (params.get("workspace") ?? "map") === id;
  if (disabled) return <span className="nav-item disabled">{icon}{label}</span>;
  return <Link className={`nav-item ${active ? "active" : ""}`} to={`/app?workspace=${id}`}>{icon}{label}</Link>;
}

/**
  单一学习主区（prototype `.workbench` + `.workspace`）：
  - WorkspaceTabs 是真 tab（不再走路由），切换只改 `?workspace=`
  - 三个工作区始终挂载，`hidden` 控制可见 —— 切换不重新请求数据（prototype 同语义）
  - 作用域跟随工作区（prototype `activate(view) → setScope(view)`）
  */
function Workbench({ workspace, session }: { workspace: _Workspace; session: ReturnType<typeof useTeachingSession> }): ReactElement {
  const [params, setParams] = useSearchParams();
  const raw = params.get("workspace");
  const active: WorkspaceId = raw === "teaching" || raw === "practice" ? raw : "map";
  useEffect(() => { session.setScope(active); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active]);
  return (
    <div className="workbench-root">
      <WorkspaceTabs active={active} onChange={(id) => setParams(id === "map" ? { workspace: "map" } : { workspace: id })} />
      <div className="workbench-view" hidden={active !== "map"}><CoursePage workspace={workspace} session={session} /></div>
      <div className="workbench-view" hidden={active !== "teaching"}><TutorPage workspace={workspace} session={session} /></div>
      <div className="workbench-view" hidden={active !== "practice"}><PracticePage workspace={workspace} session={session} /></div>
    </div>
  );
}
