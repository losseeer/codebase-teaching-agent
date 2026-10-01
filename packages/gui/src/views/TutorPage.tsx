import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { FileSearch, X } from "lucide-react";
import type { FileTreeNode, SuggestedEntry } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import type { ScopedChatApi } from "../agent/useScopedChat";
import { EmptyState, Loading, flatten } from "./helpers";
import { RepoTree } from "./RepoTree";
import { ContextLine, MobileSwitcher, useMobilePanes } from "./WorkspaceChrome";
import { ModulesPane, ModuleSectionLabel } from "../modules/ModulesPane";
import { emit } from "../journal";
import { showToast } from "../modules/toast";
import { classifyCourseNodes, loadActiveModule, loadModules, saveActiveModule, saveModules, type KnowledgeModule, type ModuleEntry } from "../modules/local-state";
import { SourceView, isLineRendered, MAX_RENDER_LINES, type SourcePayload } from "../source/SourceView";

/**
  代码教学工作区（对齐 prototype `.teaching-workspace`，两栏）：
  - 左 「教学模块」（modules-pane）：模块 chips + 配置 + 推荐入口（课程节点按模块归类）+ 仓库文件（点击打开源码）
  - 右 「实时源码」（source-pane）：只读源码 + 行高亮 + 源码 tabs + ⌘P 文件搜索
  - 语言风格滑块与教学阶段已迁到右侧 Agent 侧栏（prototype 里对话 Agent 与作用域上下文是一体的）
  - chat / composer / 流式订阅由 AgentRail 拥有（共享 useScopedChat）
  */
export function TutorPage({ workspace, chat: t }: { workspace: Workspace; chat: ScopedChatApi }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const [modules, setModules] = useState<KnowledgeModule[]>(loadModules);
  const [activeModule, setActiveModule] = useState<string>(() => loadActiveModule("teaching", modules));
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [tabs, setTabs] = useState<{ path: string; line: number }[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** palette 的键盘选中行（↑↓ 移动，Enter 打开这一行而不是第一条）。 */
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();
  /** 当前打开的源码 tab 路径（与 tabs 同步镜像，含 slice(-5) 淘汰）：判定「新开文件」还是「就地定位」。 */
  const openedPaths = useRef<string[]>([]);
  /** 上一次自动定位过的锚点（`path:line`）。三视图常驻挂载 + StrictMode 下 effect 会在首挂载双跑，
      没有这道闸就会对同一锚点重复拉源码、并把同一个 UI 动作记成两条 journal 事件
      （`openedPaths` 在 setTabs 的 updater 里才更新，两次调用之间它还是空的，所以两边都会判成「新开文件」）。
      只挡「同一锚点连发」，用户来回切节点仍会各记一条。 */
  const lastAutoAnchor = useRef<string | null>(null);
  /** palette 结果列表容器（键盘 ↑↓ 时手动把它滚进可视区）。 */
  const paletteRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { saveModules(modules); }, [modules]);
  useEffect(() => { saveActiveModule("teaching", activeModule); }, [activeModule]);

  useEffect(() => {
    let current = true;
    setFileTree([]);
    api.getIndex(repositoryId).then((index) => { if (current) setFileTree(index.fileTree); }).catch(() => undefined);
    return () => { current = false; };
  }, [repositoryId]);

  /** 关闭一个源码 tab；关的是当前文件就把视图切到相邻 tab（没有就清空）。 */
  const closeTab = (path: string): void => {
    const remaining = tabs.filter((item) => item.path !== path);
    setTabs((current) => {
      const next = current.filter((item) => item.path !== path);
      openedPaths.current = next.map((item) => item.path);
      return next;
    });
    if (source?.path !== path) return;
    const neighbor = remaining[remaining.length - 1];
    if (neighbor) void loadSource(neighbor.path, neighbor.line);
    else setSource(null);
  };

  const anchor = t.selected?.anchors[0];
  /** 统一的源码加载入口：拉源码 + upsert 源码 tab（上限 5，prototype 同规则）+ 可选 toast 提示。
      `open.toast` 控制是否弹提示（切 tab、自动定位都不该弹——用户已经看见视图变了，再 toast 是噪音），
      `open.trigger` 把「手动打开 / 切节点自动带过来 / 点已开的 tab」三种来源分开记进 journal。
      依赖只取 repositoryId——放整个 t（或任何每次渲染换引用的值）会让本回调每渲染换引用，
      连带下方自动定位 effect 在 composer 每敲一个字符时重发一次 getSource（v0.6.1 修）。 */
  const loadSource = useCallback(async (path: string, line: number, open: { note?: string; toast?: boolean; trigger?: "manual" | "auto" | "tab" } = {}): Promise<void> => {
    try {
      const next = await api.getSource(repositoryId, path, line);
      setSource(next);
      // 新文件 = file_opened；已开过的文件只是换行定位 = line_located。两件事不能混记成一条。
      // 判定用 ref 而非 tabs state：连续两次 loadSource 之间可能还没提交渲染，用 state 会重复判成「新文件」。
      const isNewFile = !openedPaths.current.includes(path);
      setTabs((current) => {
        const tab = { path, line };
        const existing = current.find((item) => item.path === path);
        const nextTabs = (existing ? current.map((item) => (item.path === path ? tab : item)) : [...current, tab]).slice(-5);
        // 在 updater 里同步镜像（同一 current 重复执行是幂等的），含淘汰——被挤出窗口的文件再打开应重新算「新开」
        openedPaths.current = nextTabs.map((item) => item.path);
        return nextTabs;
      });
      const toast = open.toast ?? true;
      const trigger = open.trigger ?? (toast ? "manual" : "auto");
      if (isNewFile) emit(repositoryId, "file_opened", { path, line, trigger });
      else emit(repositoryId, "line_located", { path, line, trigger });
      if (!toast) return;
      showToast(open.note ?? `已打开 · ${path}`);
    } catch { showToast(`无法读取 ${path}`); }
  }, [repositoryId]);
  useEffect(() => {
    if (!anchor) { lastAutoAnchor.current = null; setSource(null); return; }
    const key = `${anchor.path}:${anchor.line}`;
    if (lastAutoAnchor.current === key) return;
    lastAutoAnchor.current = key;
    // 首挂载自动定位不打 toast（三视图常驻挂载，隐藏视图的提示对用户是噪音）
    void loadSource(anchor.path, anchor.line, { toast: false, trigger: "auto" });
  }, [anchor?.path, anchor?.line, loadSource]);

  // ⌘P / Ctrl+P 文件搜索（prototype 源码面板的「⌘ P 搜索文件」）。
  // 三视图常驻挂载：本组件在非教学工作区也活着，监听器必须按当前视图开关——
  // 否则在宏观设计/练习页按 ⌘P 会被这里 preventDefault 吞掉，还打开一个看不见的面板（切回教学页才发现它开着）。
  const [searchParams] = useSearchParams();
  const isActiveWorkspace = (searchParams.get("workspace") ?? "map") === "teaching";
  useEffect(() => {
    if (!isActiveWorkspace) { setPaletteOpen(false); return; }
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        setQuery("");
      } else if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActiveWorkspace]);

  const heuristicEntries = useMemo<ModuleEntry[]>(() => (t.course ? classifyCourseNodes(t.course.root, modules) : []), [t.course, modules]);

  /** 推荐入口的三态：等 LLM 时不渲染任何入口（避免「先规则、后 LLM」的闪换），
      只有 LLM 不可用 / 预算熔断 / 调用失败 / 返回空时才落到关键词分类。
      两个坑（都实测踩过）：
      ① `heuristic` 也必须记录状态，否则失败的模块会反复重试同一请求（engine 只缓存非空结果）；
      ② 去重必须用 ref 而不是 state —— 把 entryState 放进 effect 依赖的话，写入 loading 会让 effect 重跑，
         cleanup 把 current 置 false，唯一那次请求的结果被丢弃，界面永久停在 loading。
      ③ 因此 effect 里**不要**用 current/unmount 标志丢弃结果：StrictMode 下 mount→unmount→mount 会判死第一次的请求，
         而第二次 mount 被 ref 去重挡住不再发，同样永久 loading。
      key 带 repositoryId：换仓库后同一 moduleId 不会复用上一仓库的结果。 */
  const [entryState, setEntryState] = useState<Record<string, { status: "loading" | "llm" | "heuristic"; entries: SuggestedEntry[]; reason?: string }>>({});
  const requestedEntries = useRef<Set<string>>(new Set());
  const entryKey = `${repositoryId}:${activeModule}`;
  useEffect(() => {
    if (!t.course) return;
    const mod = modules.find((item) => item.id === activeModule);
    if (!mod || requestedEntries.current.has(entryKey)) return;
    requestedEntries.current.add(entryKey);
    setEntryState((curr) => (curr[entryKey] ? curr : { ...curr, [entryKey]: { status: "loading", entries: [] } }));
    // 刻意不用 current 标志丢弃结果：StrictMode 下 effect 会 mount→unmount→mount，
    // 第一次发的请求会被第一次 cleanup 判死，而第二次 mount 又被 ref 去重挡住不再发 —— 结果是永久 loading。
    // 去重已由 ref 保证（每个 key 只请求一次），卸载后 setState 是安全的 no-op。
    api.getModuleEntries(repositoryId, mod.label, mod.hint)
      .then((result) => {
        // engine 在未配置 LLM / 预算触顶 / 主动判空 / 调用失败时都回空列表 —— 一律回落到关键词归类，
        // 但**为什么**回落由引擎的 reason 说明（四种情况的用户处置完全不同）
        const entries = result.source === "llm" ? result.entries : [];
        setEntryState((curr) => ({ ...curr, [entryKey]: entries.length ? { status: "llm", entries } : { status: "heuristic", entries: [], reason: result.reason } }));
      })
      .catch(() => {
        setEntryState((curr) => ({ ...curr, [entryKey]: { status: "heuristic", entries: [], reason: "推荐入口请求失败；以下按关键词归类。" } }));
      });
  }, [t.course, repositoryId, activeModule, entryKey, modules]);
  const moduleEntries = entryState[entryKey];
  const visibleEntries: ModuleEntry[] = moduleEntries?.status === "llm"
    ? moduleEntries.entries.map((entry) => ({ id: entry.id, title: entry.title, path: entry.path, line: entry.line, moduleId: activeModule }))
    : moduleEntries?.status === "loading" || !t.course
      ? []
      : heuristicEntries.filter((entry) => entry.moduleId === activeModule);
  const entryNote = moduleEntries?.status === "llm"
    ? "LLM 从课程树推荐 · 可直接提问"
    : moduleEntries?.status === "loading"
      ? "正在从课程树挑选入口…"
      : moduleEntries?.reason ?? "按关键词归类 · 配置 LLM 后自动升级";

  /** 推荐配对埋点（2026-09-21 定口径「开文件即改选」）：推荐列表展示中——
      点推荐入口 = `entry_adopted`；手动打开不在清单里的文件 = `entry_overridden`。
      loading（列表还没出现）或空列表不发改选事件；adopted 只在真的换绑了选中节点时发（断链点击不充分子）。 */
  const entrySource = moduleEntries?.status === "llm" ? "llm" : "heuristic";
  const suggestedPaths = useMemo(() => new Set(visibleEntries.map((entry) => entry.path)), [visibleEntries]);
  const maybeEmitOverride = (path: string): void => {
    if (!visibleEntries.length || suggestedPaths.has(path)) return;
    emit(repositoryId, "entry_overridden", {
      module: activeModule,
      picked_path: path,
      suggested_source: entrySource,
      suggested: visibleEntries.map((entry) => entry.path).join("、").slice(0, 1_800)
    });
  };

  const filePaths = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: FileTreeNode[]): void => { nodes.forEach((node) => { if (node.kind === "directory") walk(node.children ?? []); else out.push(node.path); }); };
    walk(fileTree);
    return out;
  }, [fileTree]);
  const paletteMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle ? filePaths.filter((path) => path.toLowerCase().includes(needle)) : filePaths;
    return pool.slice(0, 12);
  }, [filePaths, query]);
  useEffect(() => { setPaletteIndex(0); }, [query]);
  /** 选中行变化时把它滚进可视区：`.palette-list` 自己有 max-height + overflow，是真正的滚动容器。
      用 rect 差值而不是 `scrollIntoView`——后者会连带滚动祖先，在零视口的应用内浏览器里会把整页滚到底（§6.1 同族坑）。 */
  useEffect(() => {
    const list = paletteRef.current;
    const item = list?.children[paletteIndex] as HTMLElement | undefined;
    if (!list || !item) return;
    const listBox = list.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    if (itemBox.top < listBox.top) list.scrollTop += itemBox.top - listBox.top;
    else if (itemBox.bottom > listBox.bottom) list.scrollTop += itemBox.bottom - listBox.bottom;
  }, [paletteIndex]);
  const openFile = (path: string): void => {
    maybeEmitOverride(path);
    void loadSource(path, 1, { note: `已打开 · ${path}` });
    setPaletteOpen(false);
  };
  /** palette 键盘动线：↑↓ 移动选中行（首尾环绕），Enter 打开选中的那一行——不再只能「回车 = 第一条」。 */
  const onPaletteKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!paletteMatches.length) return;
      setPaletteIndex((index) => (index + (event.key === "ArrowDown" ? 1 : paletteMatches.length - 1)) % paletteMatches.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = paletteMatches[paletteIndex] ?? paletteMatches[0];
      if (picked) openFile(picked);
    }
  };

  if (t.error && !t.course) return <EmptyState title="代码教学暂不可用" detail={t.error} />;
  if (!t.course || !t.selected) return <Loading />;
  const { selected, course } = t;
  const moduleLabel = modules.find((item) => item.id === activeModule)?.label ?? "未命名模块";
  /** 面板只渲染前 MAX_RENDER_LINES 行：锚点行落在范围外时，源码区根本没有那一行，
      文案不能再说「已定位」（渲染与滚动都在 SourceView 里，这里只负责说实话）。 */
  const lineRenderable = source ? isLineRendered(source.line) : true;
  const sourceMeta = !source
    ? "选择左侧仓库文件或推荐入口"
    : lineRenderable
      ? `只读 · 已定位第 ${source.line} 行`
      : `只读 · 第 ${source.line} 行超出预览上限`;
  const sourceMetaNote = source && !lineRenderable ? `面板渲染前 ${MAX_RENDER_LINES} 行，该锚点在渲染范围之外` : undefined;

  return (
    <section className="page tutor-page">
      {/*
        紧凑单行 header：原型没有大标题区，节点选择已由左栏「推荐入口」承担
        （v0.1 的 <select> 是模块面板出现前的遗留，已删除）。
        */}
      <header className="tutor-header-compact">
        <p className="eyebrow">苏格拉底教学</p>
        <h1>{selected.title}</h1>
      </header>
      <ContextLine strong="代码教学" detail={`${anchor ? `${anchor.path}:${anchor.line}` : "未定位"} · 模块「${moduleLabel}」`} />
      <MobileSwitcher labels={["教学模块", "实时源码"]} active={paneActive} onSelect={setPaneActive} />
      <div className="workspace teaching-workspace">
        <div className={paneClass(0)}>
          <ModulesPane
            where="teaching"
            header="教学模块"
            modules={modules}
            activeId={activeModule}
            onSelectModule={setActiveModule}
            onModulesChange={(next, nextActive) => { setModules(next); setActiveModule(nextActive); }}
          >
            <p className="module-hint" title="模块可在「＋ 配置」里自定义">{modules.find((item) => item.id === activeModule)?.hint ?? ""}</p>
            <ModuleSectionLabel label="推荐入口" note={entryNote} />
            {visibleEntries.length ? (
              <div className="entry-list">
                {visibleEntries.map((entry) => (
                  <button
                    key={entry.id}
                    className={`entry-item ${t.selected?.id === entry.id ? "selected" : ""}`}
                    title={`${entry.path}:${entry.line}`}
                    onClick={() => {
                      const found = flatten(course.root).find((node) => node.id === entry.id);
                      if (!found) return;
                      t.setSelected(found);
                      emit(repositoryId, "entry_adopted", { module: activeModule, entry_id: entry.id, path: entry.path, source: entrySource });
                    }}
                  >
                    <span className="entry-dot" />
                    <strong>{entry.title}</strong>
                    <code>{entry.path.split("/").pop()}:{entry.line}</code>
                  </button>
                ))}
              </div>
            ) : moduleEntries?.status === "loading" ? (
              <p className="entry-empty">正在从课程树挑选推荐入口…</p>
            ) : (
              <p className="entry-empty">该模块还没有推荐入口。用下面的仓库文件或右侧源码挑一个文件，直接开始提问。</p>
            )}
            <ModuleSectionLabel label="仓库文件" note="主要入口 · 任意目录与文件" />
            <RepoTree nodes={fileTree} onOpenFile={openFile} activePath={source?.path} />
          </ModulesPane>
        </div>
        <div className={paneClass(1)}>
          <section className="pane source-pane">
            <div className="pane-header"><h2>实时源码</h2><span>{source?.path ?? "未选择文件"}{filePaths.length ? ` · ${filePaths.length} 文件` : ""}</span></div>
            {tabs.length ? (
              <div className="source-tabs" role="tablist" aria-label="打开的文件">
                {tabs.map((tab) => (
                  <button key={tab.path} role="tab" aria-selected={source?.path === tab.path} className={source?.path === tab.path ? "active" : ""} onClick={() => void loadSource(tab.path, tab.line, { toast: false, trigger: "tab" })}>
                    {tab.path.split("/").pop()}
                    <span
                      className="source-tab-close"
                      role="button"
                      aria-label={`关闭 ${tab.path}`}
                      title={`关闭 ${tab.path}`}
                      onClick={(event) => { event.stopPropagation(); closeTab(tab.path); }}
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="source-meta"><span title={sourceMetaNote}>{sourceMeta}</span><span title="按 ⌘P（Windows/Linux 为 Ctrl+P）打开文件搜索面板">⌘ P 搜索文件</span></div>
            <SourceView source={source} />
          </section>
        </div>
      </div>
      {paletteOpen && (
        <div className="palette-overlay" onClick={() => setPaletteOpen(false)}>
          <div className="palette" role="dialog" aria-label="搜索仓库文件" onClick={(event) => event.stopPropagation()}>
            <div className="palette-head">
              <FileSearch size={14} />
              <input
                autoFocus
                value={query}
                placeholder="搜索仓库文件（↑↓ 选择 · 回车打开）"
                aria-label="搜索仓库文件"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onPaletteKey}
              />
              <span className="palette-count">{paletteMatches.length ? `${paletteIndex + 1}/${paletteMatches.length}` : "0 匹配"}</span>
              <button className="palette-close" aria-label="关闭" onClick={() => setPaletteOpen(false)}><X size={13} /></button>
            </div>
            <div className="palette-list" ref={paletteRef} role="listbox" aria-label="匹配的文件">
              {paletteMatches.map((path, index) => (
                <button key={path} role="option" aria-selected={index === paletteIndex} className={index === paletteIndex ? "active" : ""} onClick={() => openFile(path)}>{path}</button>
              ))}
              {!paletteMatches.length && <p className="palette-empty">没有匹配的文件</p>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

