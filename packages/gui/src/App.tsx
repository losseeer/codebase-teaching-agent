import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Navigate, Route, Routes, Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { RepositoryCatalogEntry, RepositoryFreshness, Workspace as _Workspace } from "./api/client";
import { ApiError, api, isNotFound } from "./api/client";
import { AgentRail } from "./agent/AgentRail";
import { useScopedChat } from "./agent/useScopedChat";
import { ImportPage } from "./views/ImportPage";
import { DiagramPage } from "./views/DiagramPage";
import { TutorPage } from "./views/TutorPage";
import { PracticePage } from "./views/PracticePage";
import { InsightsPage } from "./views/InsightsPage";
import type { WorkspaceId } from "./views/WorkspaceChrome";
import { Loading } from "./ui/Loading";
import { Icon, type IconName } from "./ui/icons";
import { DangerDialog } from "./ui/DangerDialog";
import { layoutVars, useLayout } from "./ui/ColumnResizer";
import { showToast, toastFailure, ToastHost } from "./ui/toast";
import { emit, installJournalRetry } from "./journal";

// 类型定义在 api/client，此处转发给子组件。
export type Workspace = _Workspace;

/** 工作区校验「连不上」时的退避重试（毫秒）；404 不走这条。 */
const WORKSPACE_RETRY_DELAYS = [500, 1500, 3000] as const;

const WORKSPACE_STORAGE_KEY = "codebase-tutor.workspace";
const SIDEBAR_STORAGE_KEY = "codebase-tutor.sidebar-collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(value: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* 存不下不影响本次会话 */
  }
}

/** 读回上次的仓库选择；坏数据按「没有选择」处理并清掉。 */
function readStoredWorkspace(): _Workspace | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null; // 存储不可用：本次会话不落 workspace
  }
  if (!raw) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const { repositoryId, repositoryPath } = (parsed ?? {}) as { repositoryId?: unknown; repositoryPath?: unknown };
  if (typeof repositoryId === "string" && typeof repositoryPath === "string" && repositoryId && repositoryPath) {
    return { repositoryId, repositoryPath };
  }
  try {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    /* 删不掉也只是每次进来都判一趟 */
  }
  return null;
}

/** 顶层 Shell：侧栏导航 + 持久 Agent 对话栏 + 路由守卫。 */
export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<_Workspace | null>(readStoredWorkspace);
  // 待移出的目标：弹窗开着时记着它，删不删文件由弹窗决定
  const [forgetTarget, setForgetTarget] = useState<{ repositoryId: string; name: string } | null>(null);
  // 地址簿不预挂载：校验 = 一次挂载请求，顺带带回新鲜度判定
  const [workspaceReady, setWorkspaceReady] = useState(() => workspace === null);
  /** 校验放弃（连不上/5xx 耗尽）：本地选择不删。 */
  const [engineUnreachable, setEngineUnreachable] = useState(false);
  /** 挂载失败原因文本；workspace 保留。 */
  const [mountBlocked, setMountBlocked] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<RepositoryFreshness | null>(null);
  const [catalog, setCatalog] = useState<RepositoryCatalogEntry[]>([]);
  const [probeNonce, setProbeNonce] = useState(0);
  const navigate = useNavigate();
  const workspaceIdRef = useRef(workspace?.repositoryId);
  useEffect(() => { workspaceIdRef.current = workspace?.repositoryId; }, [workspace?.repositoryId]);
  // 补发离线期间积压的 journal 事件
  useEffect(() => { installJournalRetry(); }, []);
  const updateWorkspace = (value: _Workspace | null): void => {
    setWorkspace(value);
    // 存储不可用时照常工作
    try {
      if (value) localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(value));
      else localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    } catch { /* 落不下盘，下次进来重新选 */ }
  };
  const refreshCatalog = useCallback(async (): Promise<void> => {
    try {
      setCatalog((await api.listRepositories()).repositories);
    } catch {
      // 连不上时清单留空，不用旧清单充数
      setCatalog([]);
    }
  }, []);
  useEffect(() => { void refreshCatalog(); }, [refreshCatalog, probeNonce, workspace?.repositoryId]);
  useEffect(() => {
    if (!workspace) { setWorkspaceReady(true); setEngineUnreachable(false); setMountBlocked(null); setFreshness(null); return; }
    let current = true;
    const targetId = workspace.repositoryId;
    setWorkspaceReady(false);
    setEngineUnreachable(false);
    setMountBlocked(null);
    const stale = (): boolean => !current || workspaceIdRef.current !== targetId;
    const probe = async (): Promise<void> => {
      for (let attempt = 0; !stale(); attempt += 1) {
        try {
          const mounted = await api.mountRepository(targetId);
          if (!stale()) { setFreshness(mounted.freshness); setWorkspaceReady(true); }
          return;
        } catch (error) {
          if (stale()) return;
          if (isNotFound(error)) {
            if (error instanceof ApiError && error.reason === "not_in_catalog") {
              // 仓不在清单 = 本地选择真失效：清掉并明示
              updateWorkspace(null);
              setWorkspaceReady(true);
              showToast("仓不在已导入清单 · 需重新导入");
              return;
            }
            // 目录挪走/产物不全：仓库没丢，保留 workspace 交用户处置
            setMountBlocked(error instanceof Error ? error.message : "该仓库暂时挂不起来");
            return;
          }
          // 连不上/5xx：多半是引擎重启，退避重试，不清 localStorage
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
  // online 事件后自动重验
  useEffect(() => {
    if (!engineUnreachable) return;
    const retry = (): void => { setProbeNonce((value) => value + 1); };
    window.addEventListener("online", retry);
    return () => { window.removeEventListener("online", retry); };
  }, [engineUnreachable]);
  const chat = useScopedChat(workspace?.repositoryId ?? "");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const toggleSidebar = (): void => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  };
  /** 点的正是当前仓：不重挂，只离开导入页。 */
  const openRepository = (): void => { navigate("/app?workspace=map"); };

  /** 切到另一个仓：挂载成功才换，失败不改本地选择。 */
  const switchRepository = (repositoryId: string): void => {
    const entry = catalog.find((item) => item.repositoryId === repositoryId);
    if (!entry || repositoryId === workspace?.repositoryId) return;
    void (async () => {
      try {
        const mounted = await api.mountRepository(repositoryId);
        updateWorkspace({ repositoryId, repositoryPath: mounted.repositoryPath });
        setFreshness(mounted.freshness);
        setMountBlocked(null);
        // 切仓后重取仓内数据（首次 404 后不会自动重试）
        chat.reloadRepositoryData();
        emit(repositoryId, "repository_switched", { repository_path: mounted.repositoryPath, trigger: "catalog" });
        await refreshCatalog();
        navigate("/app?workspace=map");
      } catch (error) {
        toastFailure("打开仓库失败", error);
        await refreshCatalog();
      }
    })();
  };

  /** 移出清单入口：弹窗确认，删不删文件由弹窗决定。 */
  const forgetRepository = (repositoryId: string, name: string): void => { setForgetTarget({ repositoryId, name }); };

  /** 弹窗落点：移出清单，按需连产物、对话记录与运行日志一起删。 */
  const runForget = (repositoryId: string, name: string, deleteArtifacts: boolean): void => {
    setForgetTarget(null);
    void (async () => {
      try {
        const result = await api.forgetRepository(repositoryId, deleteArtifacts);
        if (repositoryId === workspace?.repositoryId) updateWorkspace(null);
        await refreshCatalog();
        if (deleteArtifacts && result.artifacts === "refused") toastFailure("已移出，文件没删掉", new Error(`${name} 的 .tutor 没删成：位置不合规则，或这台机器没权限`));
        else if (deleteArtifacts && result.artifacts === "absent") showToast(`已把「${name}」移出清单（没有发现产物）`);
        else showToast(deleteArtifacts ? `已移出并删掉「${name}」的文件` : `已把「${name}」移出清单`);
      } catch (error) {
        toastFailure("移出失败", error);
      }
    })();
  };

  // 校验占位：退避中=Loading；挂不起来=MountBlocked；连不上=EngineOffline
  const pending = mountBlocked && workspace
    ? <MountBlocked message={mountBlocked} repositoryPath={workspace.repositoryPath} onRetry={() => { setProbeNonce((value) => value + 1); }} onForget={() => forgetRepository(workspace.repositoryId, workspace.repositoryPath.split("/").pop() ?? workspace.repositoryPath)} />
    : engineUnreachable && workspace
      ? <EngineOffline repositoryPath={workspace.repositoryPath} onRetry={() => { setProbeNonce((value) => value + 1); }} />
      : <Loading />;
  const banner = workspace && freshness && (freshness.verdict === "stale" || freshness.verdict === "drifted") && !acknowledged(freshness, workspace.repositoryId)
    ? <FreshnessBanner repositoryPath={workspace.repositoryPath} freshness={freshness} onAcknowledge={() => { acknowledge(freshness, workspace.repositoryId); setFreshness(null); }} onReanalyze={() => navigate("/import")} />
    : null;
  // 对话栏只挂在有对话可谈的路由；导入页与成本页不显示
  const location = useLocation();
  const railRoute = !!workspace && !["/import", "/insights"].includes(location.pathname);
  const layout = useLayout();
  const showRail = railRoute && !layout.railCollapsed;
  return (
    <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${showRail ? "" : " rail-hidden"}`} style={layoutVars(layout)}>
      {forgetTarget ? (
        <DangerDialog
          title={`移出「${forgetTarget.name}」`}
          body="移出后引擎不再跟踪这个仓库的改动，要再用需重新导入。是否需要将已生成的相关分析产物、对话记录、运行日志删除？"
          keepLabel="只移出，保留文件"
          deleteLabel="移出并删除"
          onKeep={() => runForget(forgetTarget.repositoryId, forgetTarget.name, false)}
          onDelete={() => runForget(forgetTarget.repositoryId, forgetTarget.name, true)}
          onClose={() => setForgetTarget(null)}
        />
      ) : null}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">码</span>
          <span className="brand-titles">
            <span className="brand-name">Codebase Tutor</span>
            <span className="brand-sub">本地优先 · 代码教学 Agent</span>
          </span>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          <NavItem to="/import" icon="import" label="导入仓库" />
          <WorkspaceNavItem id="map" icon="map" label="宏观设计" disabled={!workspace} />
          <WorkspaceNavItem id="teaching" icon="book" label="代码教学" disabled={!workspace} />
          <WorkspaceNavItem id="practice" icon="practice" label="练习评估" disabled={!workspace} />
          <NavItem to="/insights" icon="gauge" label="成本监控" disabled={!workspace} />
        </nav>
        {/* 切仓入口只在导入页，侧栏不放仓库切换器 */}
        <div className="sidebar-footer">
          <button type="button" className="nav-item" aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={toggleSidebar}>
            <Icon name="panelLeft" />
            <span className="nav-label">{sidebarCollapsed ? "展开侧栏" : "收起侧栏"}</span>
          </button>
          <div className="nav-item static">
            <span className={`status-dot ${workspace && !engineUnreachable ? "online" : ""}`} />
            <span className="nav-label">{!workspace ? "等待导入仓库" : engineUnreachable ? "本地引擎未连接" : "本地引擎已连接"}</span>
          </div>
        </div>
      </aside>
      <main className="main">
        {banner}
        <div className="route-content">
          <Routes>
            {/* 根路径固定落导入页 */}
            <Route path="/" element={<Navigate to="/import" replace />} />
            <Route path="/import" element={<ImportPage onImported={(next) => { updateWorkspace(next); chat.reloadRepositoryData(); }} workspace={workspace} catalog={catalog} onSwitchRepository={switchRepository} onOpenRepository={openRepository} onForget={forgetRepository} />} />
            <Route path="/insights" element={guard(workspace, workspaceReady, <InsightsPage workspace={workspace!} />, pending)} />
            <Route path="/app" element={guard(workspace, workspaceReady, <Workbench workspace={workspace!} chat={chat} />, pending)} />
            <Route path="/course" element={<Navigate to="/app?workspace=map" replace />} />
            <Route path="/tutor" element={<Navigate to="/app?workspace=teaching" replace />} />
            <Route path="/practice" element={<Navigate to="/app?workspace=practice" replace />} />
            <Route path="*" element={workspace ? (workspaceReady ? <Navigate to="/app?workspace=map" replace /> : pending) : <Navigate to="/import" replace />} />
          </Routes>
        </div>
      </main>
      {railRoute ? <AgentRail chat={chat} /> : null}
      <ToastHost />
    </div>
  );
}

/** 路由守卫：引擎验证完成（workspaceReady）前渲染占位。 */
function guard(workspace: _Workspace | null, ready: boolean, content: ReactElement, pending: ReactElement): ReactElement {
  if (!workspace) return <Navigate to="/import" replace />;
  return ready ? content : pending;
}

/** 引擎连不上 ≠ 仓库没了：保留本地选择，给手动重验入口。 */
function EngineOffline({ repositoryPath, onRetry }: { repositoryPath: string; onRetry: () => void }): ReactElement {
  return (
    <div className="page page-import">
      <div className="import-wrap">
        <div className="import-hero">
          <h1>连不上本地引擎</h1>
          <p>仓库已保留（{repositoryPath}）。本地服务没起来或正在重启，稍后可点重新校验。</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onRetry}>重新校验</button>
      </div>
    </div>
  );
}

/** 清单里有这条但挂不起来：目录放回原位即可继续，不自动重新导入。 */
function MountBlocked({ message, repositoryPath, onRetry, onForget }: { message: string; repositoryPath: string; onRetry: () => void; onForget: () => void }): ReactElement {
  return (
    <div className="page page-import">
      <div className="import-wrap">
        <div className="import-hero">
          <h1>这个仓库暂时挂不起来</h1>
          <p>{message}</p>
          <p>路径：{repositoryPath}。把目录放回原处再试一次即可；引擎不会替你重新导入——重新分析要花钱。</p>
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={onRetry}>再试一次</button>
          <button type="button" className="btn btn-danger-ghost" onClick={onForget}>移出清单</button>
        </div>
      </div>
    </div>
  );
}

/** 过期产物横幅：只转述结论，不做自动重分析。stale=内容变了；drifted=仅提交移动、产物仍可用。 */
function FreshnessBanner({ repositoryPath, freshness, onAcknowledge, onReanalyze }: { repositoryPath: string; freshness: RepositoryFreshness; onAcknowledge: () => void; onReanalyze: () => void }): ReactElement {
  const stale = freshness.verdict === "stale";
  return (
    <div className="banner banner-warn" role="status">
      <Icon name="alert" />
      {/* 路径与哈希细节进 title 悬停 */}
      <span className="banner-text" title={`${repositoryPath}｜${stale
        ? `${freshness.changedFiles > 0 ? freshness.changedFiles : "若干"} 个文件的当前内容与上次分析时不一致`
        : `HEAD 从 ${short(freshness.headAtAnalysis)} 挪到 ${short(freshness.headNow)}${!freshness.headAtAnalysis ? "（这个仓没有可用的 git HEAD 记录，引擎只比对了文件内容）" : ""}`}`}>
        <b>{stale ? "分析已过期" : "提交已移动，内容与分析时一致"}</b>{" "}
        {stale
          ? `${ageOf(freshness.analyzedAt)}跑的分析，${freshness.changedFiles > 0 ? `${freshness.changedFiles} 个文件` : "有些文件"}已经变了 · 看到的是旧结论`
          : `代码内容没变，产物照常可用`}
      </span>
      <span className="banner-actions">
        <button type="button" onClick={onReanalyze}>去重新分析</button>
        <button type="button" className="ghost" onClick={onAcknowledge}>知道，先用旧的</button>
      </span>
    </div>
  );
}

function ageOf(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "不知何时";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

const short = (sha: string | undefined): string => (sha ? sha.slice(0, 7) : "未知");

/** 确认状态按仓 + 判定令牌存：内容或 HEAD 再变即重新提醒。 */
function ackKey(repositoryId: string): string {
  return `codebase-tutor.stale-ack.${repositoryId}`;
}

function ackToken(freshness: RepositoryFreshness): string {
  return `${freshness.verdict}:${freshness.headNow ?? freshness.versionStamp}`;
}

function acknowledged(freshness: RepositoryFreshness, repositoryId: string): boolean {
  try {
    return localStorage.getItem(ackKey(repositoryId)) === ackToken(freshness);
  } catch {
    return false;
  }
}

function acknowledge(freshness: RepositoryFreshness, repositoryId: string): void {
  try {
    localStorage.setItem(ackKey(repositoryId), ackToken(freshness));
  } catch {
    /* 存不下则下次再提醒 */
  }
}

const DISABLED_NAV_HINT = "先导入仓库：还没有可操作的工作区";

function NavItem({ to, icon, label, disabled }: { to: string; icon: IconName; label: string; disabled?: boolean }): ReactElement {
  const location = useLocation();
  const active = location.pathname === to;
  return disabled
    ? <span className="nav-item disabled" title={DISABLED_NAV_HINT}><Icon name={icon} /><span className="nav-label">{label}</span></span>
    : <Link className={`nav-item ${active ? "active" : ""}`} to={to}><Icon name={icon} /><span className="nav-label">{label}</span></Link>;
}

/** 三个学习工作区的侧栏入口：active 判定 = /app + ?workspace= 参数。 */
function WorkspaceNavItem({ id, icon, label, disabled }: { id: WorkspaceId; icon: IconName; label: string; disabled?: boolean }): ReactElement {
  const [params] = useSearchParams();
  const location = useLocation();
  const active = location.pathname === "/app" && (params.get("workspace") ?? "map") === id;
  if (disabled) return <span className="nav-item disabled" title={DISABLED_NAV_HINT}><Icon name={icon} /><span className="nav-label">{label}</span></span>;
  return <Link className={`nav-item ${active ? "active" : ""}`} to={`/app?workspace=${id}`}><Icon name={icon} /><span className="nav-label">{label}</span></Link>;
}

/** 单一学习主区：三工作区常驻挂载，hidden 切可见性。 */
function Workbench({ workspace, chat }: { workspace: _Workspace; chat: ReturnType<typeof useScopedChat> }): ReactElement {
  const [params] = useSearchParams();
  const raw = params.get("workspace");
  const active: WorkspaceId = raw === "teaching" || raw === "practice" ? raw : "map";
  useEffect(() => { chat.setScope(active); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active]);
  return (
    <div className="workbench-root">
      {/* 数据只在视图可见时拉取 */}
      <div className="workbench-view" hidden={active !== "map"}><DiagramPage workspace={workspace} chat={chat} visible={active === "map"} /></div>
      <div className="workbench-view" hidden={active !== "teaching"}><TutorPage workspace={workspace} chat={chat} visible={active === "teaching"} /></div>
      <div className="workbench-view" hidden={active !== "practice"}><PracticePage workspace={workspace} chat={chat} visible={active === "practice"} /></div>
    </div>
  );
}
