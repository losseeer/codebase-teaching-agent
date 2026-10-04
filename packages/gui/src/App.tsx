import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Navigate, Route, Routes, Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { BarChart3, BrainCircuit, FolderGit2, MessageCircleQuestion, Network, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import type { RepositoryCatalogEntry, RepositoryFreshness, Workspace as _Workspace } from "./api/client";
import { ApiError, api, isNotFound } from "./api/client";
import { AgentRail } from "./agent/AgentRail";
import { useScopedChat } from "./agent/useScopedChat";
import { ImportPage } from "./views/ImportPage";
import { CoursePage } from "./views/CoursePage";
import { TutorPage } from "./views/TutorPage";
import { PracticePage } from "./views/PracticePage";
import { InsightsPage } from "./views/InsightsPage";
import { WorkspaceTabs, type WorkspaceId } from "./views/WorkspaceChrome";
import { Loading } from "./views/helpers";
import { OptionDropdown } from "./ui/OptionDropdown";
import { showToast, ToastHost } from "./modules/toast";
import { emit, installJournalRetry } from "./journal";

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
  // 引擎的**地址簿**是持久的（N 条路径），但启动一条都不挂载：GUI 恢复 workspace 后第一次访问该仓，
  // 引擎才读它的 `.tutor` 产物挂进内存（超上限的最久未用项被驱逐）。所以这里的校验 = 一次挂载请求，
  // 顺带把新鲜度判定带回来，好在横幅上如实说「这是 X 天前的分析」。
  // 失败分三类处置：**not_in_catalog 才是「本地选择真失效」**（清掉、引到导入页）；
  // directory_missing / artifacts_incomplete 要**留着 workspace**——仓库没丢，是引擎挂不起来，
  // 静默清掉等于把用户的路径弄丢。连不上 / 5xx 多半是引擎正在重启，只退避重试，绝不清 localStorage。
  const [workspaceReady, setWorkspaceReady] = useState(() => !localStorage.getItem("codebase-tutor.workspace"));
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
    if (value) localStorage.setItem("codebase-tutor.workspace", JSON.stringify(value));
    else localStorage.removeItem("codebase-tutor.workspace");
  };
  const refreshCatalog = useCallback(async (): Promise<void> => {
    try {
      setCatalog((await api.listRepositories()).repositories);
    } catch {
      // 引擎没连上就空着：拿旧清单冒充「你的地址簿就这些」是假话
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
              // 引擎明说「地址簿里没这个仓」：本地选择确实失效。失效必须说出来——静默清 localStorage 再把用户甩到
              // 导入页，看起来像「软件自己把我的仓库弄丢了」。
              updateWorkspace(null);
              setWorkspaceReady(true);
              showToast("上次打开的仓库不在引擎的地址簿里（地址簿只记你导入过的仓），请重新导入。");
              return;
            }
            // 目录挪走 / 产物不全：仓库没丢，是挂不起来。留着 workspace 说清原因（pending 会渲染 MountBlocked），
            // 让用户选「放回原处再来」还是「移出地址簿」——绝不静默清掉，也绝不自动重新导入。
            setMountBlocked(error instanceof Error ? error.message : "该仓库暂时挂不起来");
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
  const [repoOpen, setRepoOpen] = useState(false);
  const toggleSidebar = (): void => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("codebase-tutor.sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  };
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
        // 切仓后课程树必须重取：它按 repositoryId 拉，但首次 404 后不会自己重试（同导入完成后的处理）
        chat.reloadCourseData();
        emit(repositoryId, "repository_switched", { repository_path: mounted.repositoryPath, trigger: "catalog" });
        await refreshCatalog();
        navigate("/app?workspace=map");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "挂载失败");
        await refreshCatalog();
      }
    })();
  };

  /** 移出地址簿是破坏性动作（产物还在仓库自己的 .tutor 里，但引擎不再记得这个仓），先确认。 */
  const forgetRepository = (repositoryId: string, name: string): void => {
    if (!window.confirm(`把「${name}」移出地址簿？引擎会停掉它的监听并忘掉这个路径，仓库里的 .tutor/ 产物原样不动；要再用它得重新导入。`)) return;
    void (async () => {
      try {
        await api.forgetRepository(repositoryId);
        if (repositoryId === workspace?.repositoryId) updateWorkspace(null);
        await refreshCatalog();
        showToast(`已把「${name}」移出地址簿`);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "移出失败");
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
  // Agent 侧栏只属于有对话可谈的路由：导入页还没有工作区语义，挂着它既没绑定对象又挤扁导入表单
  const location = useLocation();
  const showRail = !!workspace && location.pathname !== "/import";
  return (
    <div className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${showRail ? "" : " no-rail"}`}>
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
        {!sidebarCollapsed && workspace ? (
          <div className="sidebar-repo">
            <OptionDropdown
              label="仓库"
              tone="custom"
              placeholder={catalog.length > 1 ? `地址簿里还有 ${catalog.length - 1} 个仓` : "地址簿里只有这一个仓"}
              ariaLabel="切换引擎地址簿里的仓库"
              value={workspace.repositoryId}
              open={repoOpen}
              onOpenChange={setRepoOpen}
              onSelect={switchRepository}
              options={catalog.map((item) => ({
                value: item.repositoryId,
                label: item.exists ? item.name : `${item.name}（目录不存在）`,
                detail: item.repositoryPath,
                note: `${item.repositoryPath}\n${item.mounted ? "已挂载在引擎里" : "未挂载：点开才读它的 .tutor 产物"}${item.freshness ? ` · 产物${item.freshness.verdict === "stale" ? "已过期" : item.freshness.verdict === "drifted" ? "提交已移动、内容一致" : item.freshness.verdict === "fresh" ? "对得上" : "内容对得上（没有 HEAD 可比）"}` : ""}`
              }))}
            />
          </div>
        ) : null}
        <div className="sidebar-bottom">
          <span className={`status-dot ${workspace && !engineUnreachable ? "online" : ""}`} />
          <span className="nav-label">{!workspace ? "等待导入仓库" : engineUnreachable ? "本地引擎未连接" : "本地引擎已连接"}</span>
        </div>
      </aside>
      <main className="main-content">
        {banner}
        <div className="route-content">
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
        </div>
      </main>
      {showRail ? <AgentRail chat={chat} /> : null}
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

/**
  地址簿里有这条、但引擎挂不起来（目录被挪走 / `.tutor` 产物不全）。
  这与「不在地址簿」不同：仓库没丢，用户把目录放回原处就能继续用，所以两条路都摆出来，
  也**绝不自动重新导入**——重跑是花钱的动作。
  */
function MountBlocked({ message, repositoryPath, onRetry, onForget }: { message: string; repositoryPath: string; onRetry: () => void; onForget: () => void }): ReactElement {
  return (
    <div className="page empty-state">
      <h1>这个仓库暂时挂不起来</h1>
      <p>{message}</p>
      <p>路径：{repositoryPath}。把目录放回原处再试一次即可；引擎不会替你重新导入——重新分析要花钱。</p>
      <p>
        <button type="button" className="primary" onClick={onRetry}>再试一次</button>{" "}
        <button type="button" onClick={onForget}>移出地址簿</button>
      </p>
    </div>
  );
}

/**
  过期产物横幅：引擎在挂载时算出「当前文件内容哈希 vs 产物记录的哈希」「当前 HEAD vs 分析时 HEAD」，
  这里只负责把结论说人话，并把两个动作交回用户——**没有第三条自动路径**。
  - stale：内容真的变了，明说几天前的分析、多少个文件对不上；
  - drifted：内容一模一样只是提交挪了（切分支/空提交），产物照常可用，也照样告知，避免「它是不是最新的」被猜。
  */
function FreshnessBanner({ repositoryPath, freshness, onAcknowledge, onReanalyze }: { repositoryPath: string; freshness: RepositoryFreshness; onAcknowledge: () => void; onReanalyze: () => void }): ReactElement {
  const stale = freshness.verdict === "stale";
  return (
    <div className="freshness-banner" role="status">
      <strong>{stale ? "产物已过期" : "提交已移动，内容与分析时一致"}</strong>
      <span>
        {stale
          ? `${repositoryPath} 这份分析是 ${ageOf(freshness.analyzedAt)}跑的，期间有 ${freshness.changedFiles > 0 ? `${freshness.changedFiles} 个` : "一些"}文件的内容和它记录的哈希对不上。继续看的是旧结论。`
          : `${repositoryPath} 的文件内容跟 ${ageOf(freshness.analyzedAt)}那次分析完全对得上，只是 HEAD 从 ${short(freshness.headAtAnalysis)} 挪到了 ${short(freshness.headNow)}，产物照常可用。`}
        {!stale && !freshness.headAtAnalysis ? "（这个仓没有可用的 git HEAD 记录，引擎只比对了文件内容。）" : ""}
      </span>
      <button type="button" onClick={onReanalyze}>去重新分析</button>
      <button type="button" className="ghost" onClick={onAcknowledge}>知道，先用旧的</button>
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
      {/* 三个视图常驻挂载（切 tab 不丢状态），所以「可见性」必须传进去：
          推荐入口与流程生成都是花钱的 LLM 调用，用户停在宏观设计时不该由隐藏面板替他点一次。 */}
      <div className="workbench-view" hidden={active !== "map"}><CoursePage workspace={workspace} chat={chat} visible={active === "map"} /></div>
      <div className="workbench-view" hidden={active !== "teaching"}><TutorPage workspace={workspace} chat={chat} visible={active === "teaching"} /></div>
      <div className="workbench-view" hidden={active !== "practice"}><PracticePage workspace={workspace} chat={chat} visible={active === "practice"} /></div>
    </div>
  );
}
