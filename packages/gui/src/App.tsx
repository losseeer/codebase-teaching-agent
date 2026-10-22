import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Navigate, Route, Routes, Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { RepositoryCatalogEntry, RepositoryFreshness, Workspace as _Workspace } from "./api/client";
import { ApiError, api, isNotFound } from "./api/client";
import { AgentRail } from "./agent/AgentRail";
import { useScopedChat } from "./agent/useScopedChat";
import { ImportPage } from "./views/ImportPage";
import { CoursePage } from "./views/CoursePage";
import { TutorPage } from "./views/TutorPage";
import { PracticePage } from "./views/PracticePage";
import { InsightsPage } from "./views/InsightsPage";
import type { WorkspaceId } from "./views/WorkspaceChrome";
import { Loading } from "./views/helpers";
import { Icon, type IconName } from "./ui/icons";
import { DangerDialog } from "./ui/DangerDialog";
import { layoutVars, useLayout } from "./ui/ColumnResizer";
import { showToast, toastFailure, ToastHost } from "./modules/toast";
import { emit, installJournalRetry } from "./journal";

// 类型已在 api/client 定义，这里转发一次，子组件统一从 `../App` 取 Workspace。
export type Workspace = _Workspace;

/**
  工作区校验在「连不上」时的退避重试节奏（毫秒）：三趟总等待 ~5s，足够跨过引擎重启的一秒出头；再长就该让用户看见。
  */
const WORKSPACE_RETRY_DELAYS = [500, 1500, 3000] as const;

const WORKSPACE_STORAGE_KEY = "codebase-tutor.workspace";
const SIDEBAR_STORAGE_KEY = "codebase-tutor.sidebar-collapsed";

/**
  侧栏折叠态的读写。读必须包 try/catch 并走 useState 初始化器：存储不可用（隐私模式 / 被禁）时
  初始化器里一抛就白屏。写也兜住：它挂在事件处理器里，抛错会连累同一处理器里紧随其后的状态更新。
  */
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
    /* 存不下只是下次进来不记得折叠态，不影响本次会话 */
  }
}

/**
  读回上次的仓库选择。坏数据按「没有选择」处理并清掉，让用户回到导入页那条活路（地址簿还在，点一下就能选回来）。
  这条路径必须包 try/catch：它在 useState 初始化器里，一抛就白屏。
  */
function readStoredWorkspace(): _Workspace | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null; // 存储本身不可用（隐私模式 / 被禁）：本次会话内不落 workspace，功能照常
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

/**
  顶层 Shell：侧栏 = 品牌行 + 五项主导航 + 页脚（收起侧栏 / 引擎状态），
  右侧 = 持久 Agent 对话栏（三工作区共享一套结构，作用域跟随工作区）。工作区切换由侧栏导航承担，页内不再有 tab 条。
  /import 与 /insights 保留独立路由；三个学习工作区合并为单一主区组件树（`/app?workspace=`），旧路径 /course /tutor /practice 仍兼容跳转。
  持久化：workspace（localStorage `codebase-tutor.workspace`）、scope（`codebase-tutor.scope`）；
  线程正文与清单的真源在引擎库（chat_session / chat_message），GUI 只记「当前停在哪条」。
  */
export function App(): ReactElement {
  const [workspace, setWorkspace] = useState<_Workspace | null>(readStoredWorkspace);
  // 待移出的那条：弹窗开着时记着它，点哪一条按钮决定删不删文件
  const [forgetTarget, setForgetTarget] = useState<{ repositoryId: string; name: string } | null>(null);
  // 引擎的地址簿是持久的（N 条路径），但启动一条都不挂载：GUI 恢复 workspace 后要访问某个仓，
  // 引擎才读它的 `.tutor` 产物挂进内存（超上限的最久未用项被驱逐）。所以这里的校验 = 一次挂载请求，
  // 顺带把新鲜度判定带回来，好在横幅上如实说「这是 X 天前的分析」。
  const [workspaceReady, setWorkspaceReady] = useState(() => workspace === null);
  /** 校验放弃（连不上 / 5xx 重试耗尽）：本地选择不删，改说「引擎没连上」，并允许手动或 online 后重验。 */
  const [engineUnreachable, setEngineUnreachable] = useState(false);
  /** 挂载失败（目录挪走 / 产物不全）：workspace 保留，但要说清原因并给出「移出地址簿」这条路。 */
  const [mountBlocked, setMountBlocked] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<RepositoryFreshness | null>(null);
  const [catalog, setCatalog] = useState<RepositoryCatalogEntry[]>([]);
  const [probeNonce, setProbeNonce] = useState(0);
  const navigate = useNavigate();
  const workspaceIdRef = useRef(workspace?.repositoryId);
  useEffect(() => { workspaceIdRef.current = workspace?.repositoryId; }, [workspace?.repositoryId]);
  // 补发上回积压的 UI 事件（网络失败时进了 localStorage 重试队列），并订阅 online 重连
  useEffect(() => { installJournalRetry(); }, []);
  const updateWorkspace = (value: _Workspace | null): void => {
    setWorkspace(value);
    // 存储不可用时（隐私模式 / 被禁）本次会话照常工作
    try {
      if (value) localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(value));
      else localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    } catch { /* 落不下盘，下次进来重新选 */ }
  };
  const refreshCatalog = useCallback(async (): Promise<void> => {
    try {
      setCatalog((await api.listRepositories()).repositories);
    } catch {
      // 引擎没连上就空着：拿旧清单伪装成「你的地址簿就这些」是假话
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
              // 「地址簿里没这个仓」= 本地选择真失效：清掉并说出来，静默失效看起来像软件把仓库弄丢了
              updateWorkspace(null);
              setWorkspaceReady(true);
              showToast("仓不在地址簿 · 需重新导入");
              return;
            }
            // 目录挪走 / 产物不全：仓库没丢，是挂不起来。留着 workspace 说清原因（pending 会渲染 MountBlocked），
            // 让用户选「放回原处再来」还是「移出地址簿」：不清本地选择，也不自动重新导入
            setMountBlocked(error instanceof Error ? error.message : "该仓库暂时挂不起来");
            return;
          }
          // 其余失败（连不上 / 5xx）多半是引擎正在重启而不是仓库没了：退避重试，不清 localStorage
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const toggleSidebar = (): void => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  };
  /** 地址簿里点的正是当前这个仓：不重挂（懒挂载会自己处理），只是离开导入页。 */
  const openRepository = (): void => { navigate("/app?workspace=map"); };

  /** 切到地址簿里的另一个仓：先让引擎挂载（顺带拿新鲜度），成功才换 workspace。
      挂载失败不改本地选择——上一个仓不该因为这次点错而被弄丢。 */
  const switchRepository = (repositoryId: string): void => {
    const entry = catalog.find((item) => item.repositoryId === repositoryId);
    if (!entry || repositoryId === workspace?.repositoryId) return;
    void (async () => {
      try {
        const mounted = await api.mountRepository(repositoryId);
        updateWorkspace({ repositoryId, repositoryPath: mounted.repositoryPath });
        setFreshness(mounted.freshness);
        setMountBlocked(null);
        // 切仓后仓内数据必须重取：它按 repositoryId 拉，但首次 404 后不会自己重试（同导入完成后的处理）
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

  /** 列表与挂载失败页都走这里：先开弹窗，删不删由弹窗里点的那一条决定。 */
  const forgetRepository = (repositoryId: string, name: string): void => { setForgetTarget({ repositoryId, name }); };

  /** 弹窗的落点：移出地址簿，并按需连该仓 `.tutor/` 里的分析产物、对话记录与运行日志一起删。 */
  const runForget = (repositoryId: string, name: string, deleteArtifacts: boolean): void => {
    setForgetTarget(null);
    void (async () => {
      try {
        const result = await api.forgetRepository(repositoryId, deleteArtifacts);
        if (repositoryId === workspace?.repositoryId) updateWorkspace(null);
        await refreshCatalog();
        if (deleteArtifacts && result.artifacts === "refused") toastFailure("已移出，文件没删掉", new Error(`${name} 的 .tutor 没删成：位置不合规则，或这台机器没权限`));
        else if (deleteArtifacts && result.artifacts === "absent") showToast(`已把「${name}」移出地址簿（没有发现产物）`);
        else showToast(deleteArtifacts ? `已移出并删掉「${name}」的文件` : `已把「${name}」移出地址簿`);
      } catch (error) {
        toastFailure("移出失败", error);
      }
    })();
  };

  // 校验期间的占位：还在退避=转圈；挂不起来=MountBlocked（说清原因，绝不显示成「仓库丢了」）；连不上=EngineOffline
  const pending = mountBlocked && workspace
    ? <MountBlocked message={mountBlocked} repositoryPath={workspace.repositoryPath} onRetry={() => { setProbeNonce((value) => value + 1); }} onForget={() => forgetRepository(workspace.repositoryId, workspace.repositoryPath.split("/").pop() ?? workspace.repositoryPath)} />
    : engineUnreachable && workspace
      ? <EngineOffline repositoryPath={workspace.repositoryPath} onRetry={() => { setProbeNonce((value) => value + 1); }} />
      : <Loading />;
  const banner = workspace && freshness && (freshness.verdict === "stale" || freshness.verdict === "drifted") && !acknowledged(freshness, workspace.repositoryId)
    ? <FreshnessBanner repositoryPath={workspace.repositoryPath} freshness={freshness} onAcknowledge={() => { acknowledge(freshness, workspace.repositoryId); setFreshness(null); }} onReanalyze={() => navigate("/import")} />
    : null;
  // Agent 对话栏只属于「有对话可谈」的路由：导入页还没有工作区语义，成本监控页问的不是代码——
  // 两页挂着它都只会占宽并让人以为能问点什么。收起态由用户偏好（layout.railCollapsed）决定，
  // 页顶栏那枚 panelRight 是唯一的再开入口，所以收起时整栏不再占位。
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
        {/* 侧栏不放仓库切换器：切仓是导入页地址簿那一件事（同一个动作不在两处各摆一份入口），
            当前在哪个仓写在每页顶栏的面包里。 */}
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
            {/* 根路径固定落导入页：导入是每次打开的起点，不带 workspace 记忆直通 /app */}
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

/** 路由守卫：workspace 恢复自 localStorage 时需等引擎验证完成（workspaceReady）再渲染，避免失效 id 先跳宏观设计。 */
function guard(workspace: _Workspace | null, ready: boolean, content: ReactElement, pending: ReactElement): ReactElement {
  if (!workspace) return <Navigate to="/import" replace />;
  return ready ? content : pending;
}

/** 引擎连不上 ≠ 仓库没了：保留本地选择，说清原因并给一次手动重验。 */
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

/**
  地址簿里有这条、但引擎挂不起来（目录被挪走 / `.tutor` 产物不全）。
  这与「不在地址簿」不同：仓库没丢，用户把目录放回原处就能继续用，所以两条路都摆出来，
  也不自动重新导入（重跑是花钱的动作）。
  */
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
          <button type="button" className="btn btn-danger-ghost" onClick={onForget}>移出地址簿</button>
        </div>
      </div>
    </div>
  );
}

/**
  过期产物横幅：引擎在挂载时算出「当前文件内容哈希 vs 产物记录的哈希」「当前 HEAD vs 分析时 HEAD」，
  这里只负责把结论说人话，并把两个动作返回用户——没有第三条自动路径。
  - stale：内容真的变了，明说几天前的分析、多少个文件对不上；
  - drifted：内容一模一样只是提交挪了（切分支/空提交），产物照常可用，也照样告知。
  */
function FreshnessBanner({ repositoryPath, freshness, onAcknowledge, onReanalyze }: { repositoryPath: string; freshness: RepositoryFreshness; onAcknowledge: () => void; onReanalyze: () => void }): ReactElement {
  const stale = freshness.verdict === "stale";
  return (
    <div className="banner banner-warn" role="status">
      <Icon name="alert" />
      {/* 横幅只留「变了没有 / 能不能继续用」这一句；路径、哈希口径、HEAD 记录缺失这些细节进悬停 */}
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

/** 相对时间（带「前」）：横幅要说「这是 3 天前跑的」，只给 ISO 串等于没说话。 */
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

/** 「知道，先用旧的」按仓 + 判定状态存：内容又变了、或 HEAD 又动了，就重新提醒一次。 */
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
    /* 存不下就下次再提醒，不值得为此打断用户 */
  }
}

/** 禁用态导航项必须有话可说：灰掉却不解释，看起来像坏了。 */
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

/**
  单一学习主区：三个工作区常驻挂载、`hidden` 切可见性——切换不重新请求数据、不丢状态，SSE 续接也依赖这份常驻。
  切换只改 `?workspace=` 参数（入口在侧栏导航），作用域跟随工作区（对话栏的绑定上下文按 scope 取）。
  */
function Workbench({ workspace, chat }: { workspace: _Workspace; chat: ReturnType<typeof useScopedChat> }): ReactElement {
  const [params] = useSearchParams();
  const raw = params.get("workspace");
  const active: WorkspaceId = raw === "teaching" || raw === "practice" ? raw : "map";
  useEffect(() => { chat.setScope(active); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active]);
  return (
    <div className="workbench-root">
      {/* 三个视图常驻挂载，所以「可见性」必须传进去：文件树与画布数据只在可见时拉取，
          隐藏面板不该替用户发请求。 */}
      <div className="workbench-view" hidden={active !== "map"}><CoursePage workspace={workspace} chat={chat} visible={active === "map"} /></div>
      <div className="workbench-view" hidden={active !== "teaching"}><TutorPage workspace={workspace} chat={chat} visible={active === "teaching"} /></div>
      <div className="workbench-view" hidden={active !== "practice"}><PracticePage workspace={workspace} chat={chat} visible={active === "practice"} /></div>
    </div>
  );
}
