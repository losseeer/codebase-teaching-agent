import { useState, type ReactElement } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { BarChart3, BrainCircuit, FolderGit2, MessageCircleQuestion, Network, Sparkles } from "lucide-react";
import type { Workspace as _Workspace } from "./api/client";
import { CompanionDock } from "./agent/CompanionDock";
import { ImportPage } from "./views/ImportPage";
import { CoursePage } from "./views/CoursePage";
import { TutorPage } from "./views/TutorPage";
import { PracticePage } from "./views/PracticePage";
import { InsightsPage } from "./views/InsightsPage";

// Re-export so 子组件可统一从 `../App` 取 Workspace 类型（类型已在 api/client 定义）。
export type Workspace = _Workspace;

/**
 * 顶层 Shell：
 * - 侧栏：5 项主导航（导入 / 课程地图 / 教学会话 / 练习复习 / 成本与实验）+ 状态指示
 * - 路由：导入页无条件；其他页需 workspace 已就绪，否则重定向到 /import
 * - 伴侣面板：workspace 存在时挂载（agent/CompanionDock）
 *
 * 持久化：workspace 写入 localStorage（key: `codebase-tutor.workspace`），
 * 关闭浏览器后下次打开仍能继续。
 *
 * 对应 prototype `design-prototype.html` 中的「主导航 + 工作区主区 + Agent 侧栏」。
 * 与 prototype 的差异：prototype 是「三工作区共享主区」+「Agent 侧栏始终在右」，
 * 当前 GUI 是「四路由切换」+「伴侣面板另起 aside」——v0.2+ 应按 prototype 重构。
 */
export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<Workspace | null>(() => {
    const saved = localStorage.getItem("codebase-tutor.workspace");
    return saved ? JSON.parse(saved) as Workspace : null;
  });
  const updateWorkspace = (value: Workspace | null): void => {
    setWorkspace(value);
    if (value) localStorage.setItem("codebase-tutor.workspace", JSON.stringify(value));
    else localStorage.removeItem("codebase-tutor.workspace");
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Sparkles size={17} /></span><span>Codebase Tutor</span></div>
        <nav aria-label="主导航">
          <NavItem to="/import" icon={<FolderGit2 size={17} />} label="导入仓库" />
          <NavItem to="/course" icon={<Network size={17} />} label="课程地图" disabled={!workspace} />
          <NavItem to="/tutor" icon={<MessageCircleQuestion size={17} />} label="教学会话" disabled={!workspace} />
          <NavItem to="/practice" icon={<BrainCircuit size={17} />} label="练习复习" disabled={!workspace} />
          <NavItem to="/insights" icon={<BarChart3 size={17} />} label="成本与实验" disabled={!workspace} />
        </nav>
        <div className="sidebar-bottom">
          <span className={`status-dot ${workspace ? "online" : ""}`} />
          <span>{workspace ? "本地引擎已连接" : "等待导入仓库"}</span>
        </div>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/import" element={<ImportPage onImported={updateWorkspace} workspace={workspace} />} />
          <Route path="/course" element={workspace ? <CoursePage workspace={workspace} /> : <Navigate to="/import" replace />} />
          <Route path="/tutor" element={workspace ? <TutorPage workspace={workspace} /> : <Navigate to="/import" replace />} />
          <Route path="/practice" element={workspace ? <PracticePage workspace={workspace} /> : <Navigate to="/import" replace />} />
          <Route path="/insights" element={workspace ? <InsightsPage workspace={workspace} /> : <Navigate to="/import" replace />} />
          <Route path="*" element={<Navigate to="/import" replace />} />
        </Routes>
      </main>
      {workspace ? <CompanionDock workspace={workspace} onWorkspaceMissing={() => updateWorkspace(null)} /> : null}
    </div>
  );
}

function NavItem({ to, icon, label, disabled }: { to: string; icon: ReactElement; label: string; disabled?: boolean }): ReactElement {
  return disabled ? <span className="nav-item disabled">{icon}{label}</span> : <NavLink className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`} to={to}>{icon}{label}</NavLink>;
}