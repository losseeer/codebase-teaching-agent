import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import type { FileTreeNode, SuggestedEntry } from "@codebase-tutor/shared/wire";
import { isDocumentationPath } from "@codebase-tutor/shared/wire";
import { api, type Workspace } from "../api/client";
import type { ScopedChatApi } from "../agent/useScopedChat";
import { EmptyState, Loading, flatten } from "./helpers";
import { RepoTree } from "./RepoTree";
import { MobileSwitcher, PageTopbar, useMobilePanes } from "./WorkspaceChrome";
import { ModulesPane, ModuleSectionLabel } from "../modules/ModulesPane";
import { emit } from "../journal";
import { showToast } from "../modules/toast";
import { useEverVisible } from "../ui/useEverVisible";
import { ColumnResizer, layoutVars, useLayout } from "../ui/ColumnResizer";
import { Icon } from "../ui/icons";
import { courseModules, loadActiveModule, loadModuleOverrides, mergeModules, saveActiveModule, saveModuleOverrides, type ModuleEntry, type ModuleOverrides } from "../modules/local-state";
import { migrateLegacyTierOverrides } from "../modules/server-overlays";
import { SourceView, type SourcePayload } from "../source/SourceView";

// 代码教学工作区（两栏）：
// - 左 `.teach-side`：教学模块（主链路 / 基础设施 / 外围三组，档位只读）+ 推荐入口 + 仓库文件树
// - 右 `.teach-main`：源码 tabs（≤5）+ 深色源码岛，点任意一行即定位（见 `pickLine`）
// - 语言风格与线程管理在右侧 Agent 对话栏；chat / composer / 流式订阅由 AgentRail 拥有（共享 useScopedChat）
/** 推荐入口一屏先露这么多条，其余收进「显示更多」。 */
const ENTRY_PAGE = 8;

export function TutorPage({ workspace, chat: t, visible }: { workspace: Workspace; chat: ScopedChatApi; visible: boolean }): ReactElement {
  const repositoryId = workspace.repositoryId;
  /** 教学模块 = 课程树「模块地图」的节点（业务模块跟着仓库走），这里只存覆盖层：改名 / 隐藏 / 自建。 */
  const [overrides, setOverrides] = useState<ModuleOverrides>(() => loadModuleOverrides(repositoryId));
  const modules = useMemo(() => mergeModules(courseModules(t.course), overrides), [t.course, overrides]);
  const [activeModule, setActiveModule] = useState("");
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [tabs, setTabs] = useState<{ path: string; line: number }[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** palette 的键盘选中行（↑↓ 移动，Enter 打开这一行）。 */
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();
  const layout = useLayout();
  /** 当前打开的源码 tab 路径（与 tabs 同步镜像，含 slice(-5) 淘汰）：判定「新开文件」还是「就地定位」。 */
  const openedPaths = useRef<string[]>([]);
  /** 上一次自动定位的锚点（`path:line`）：常驻挂载 + StrictMode 首挂载双跑会让同一锚点重复拉源码、重复记 journal。
      只挡同一锚点连发，来回切节点仍各记一条。 */
  const lastAutoAnchor = useRef<string | null>(null);
  /** palette 结果列表容器（键盘 ↑↓ 时手动把它滚进可视区）。 */
  const paletteRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { saveModuleOverrides(repositoryId, overrides); }, [repositoryId, overrides]);
  /** 选中项失效才回落（初次挂载取上次停的那个，按仓库记）。
      空串既可能是「还没选」也可能是「刚切到空清单」，不能一律覆盖成第一项。 */
  useEffect(() => {
    if (!modules.length) return;
    setActiveModule((current) => (modules.some((item) => item.id === current) ? current : loadActiveModule("teaching", repositoryId, modules)));
  }, [modules, repositoryId]);
  useEffect(() => { if (activeModule) saveActiveModule("teaching", repositoryId, activeModule); }, [repositoryId, activeModule]);

  /** 文件树与推荐入口都只在「这个 tab 被打开过之后」才取（单向门判据见 ui/useEverVisible.ts）。 */
  const everVisible = useEverVisible(visible);
  useEffect(() => {
    if (!everVisible) return;
    let current = true;
    setFileTree([]);
    api.getIndex(repositoryId).then((index) => { if (current) setFileTree(index.fileTree); }).catch(() => undefined);
    return () => { current = false; };
  }, [repositoryId, everVisible]);

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
  /** 统一的源码加载入口：拉源码 + upsert 源码 tab（上限 5）+ 可选 toast。
      `open.toast` 控制提示（切 tab 与自动定位不弹，视图已经变了），
      `open.trigger` 区分「手动打开 / 切节点自动带过来 / 点已开的 tab」三种来源记进 journal。
      依赖只取 repositoryId：放整个 t 会让本回调每次渲染换引用，自动定位 effect 随输入重发 getSource。 */
  const loadSource = useCallback(async (path: string, line: number, open: { note?: string; toast?: boolean; trigger?: "manual" | "auto" | "tab" } = {}): Promise<void> => {
    try {
      const next = await api.getSource(repositoryId, path, line);
      setSource(next);
      // 新文件记 file_opened，已开过的换行定位记 line_located，两条不混记。
      // 判定用 ref 而非 tabs state：连续两次 loadSource 之间可能还没提交渲染。
      const isNewFile = !openedPaths.current.includes(path);
      setTabs((current) => {
        const tab = { path, line };
        const existing = current.find((item) => item.path === path);
        const nextTabs = (existing ? current.map((item) => (item.path === path ? tab : item)) : [...current, tab]).slice(-5);
        // 在 updater 里同步镜像（幂等），含淘汰：被挤出窗口的文件再打开重新算「新开」
        openedPaths.current = nextTabs.map((item) => item.path);
        return nextTabs;
      });
      const toast = open.toast ?? true;
      const trigger = open.trigger ?? (toast ? "manual" : "auto");
      if (isNewFile) emit(repositoryId, "file_opened", { path, line, trigger });
      else emit(repositoryId, "line_located", { path, line, trigger });
      if (!toast) return;
      showToast(open.note ?? `已打开 · ${path}`);
    } catch { showToast(`读不到 · ${path}`); }
  }, [repositoryId]);
  useEffect(() => {
    if (!anchor) { lastAutoAnchor.current = null; setSource(null); return; }
    const key = `${anchor.path}:${anchor.line}`;
    if (lastAutoAnchor.current === key) return;
    lastAutoAnchor.current = key;
    void loadSource(anchor.path, anchor.line, { toast: false, trigger: "auto" });
  }, [anchor?.path, anchor?.line, loadSource]);

  // ⌘P / Ctrl+P 快速打开。
  // 三个工作区常驻挂载、靠 hidden 切换：本组件在非教学工作区也活着，键盘监听必须按当前视图开关，
  // 否则在宏观设计或练习页按 ⌘P 会被这里 preventDefault 丢弃，还打开一个看不见的面板。
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

  /** 当前模块可当「推荐入口」的文件：去掉文档——代码问答的入口必须是代码（引擎侧同一判据）。
      左侧模块徽标的「N 个文件」数的是完整清单：那是结构事实，不跟着这条产品规则变。 */
  const moduleEntryFiles = useMemo<ModuleEntry[]>(
    () => (modules.find((item) => item.id === activeModule)?.entries ?? []).filter((entry) => !isDocumentationPath(entry.path)),
    [modules, activeModule]
  );

  /** 推荐入口的三态：等 LLM 时不渲染任何入口（避免「先规则、后 LLM」的闪换），落到回退清单时也要记录状态。
      key 带 repositoryId：换仓后同一模块不复用上一仓的结果。 */
  const [entryState, setEntryState] = useState<Record<string, { status: "loading" | "llm" | "files"; entries: SuggestedEntry[]; reason?: string }>>({});
  const requestedEntries = useRef<Set<string>>(new Set());
  const entryKey = `${repositoryId}:${activeModule}`;
  /** 换仓：覆盖层按仓库分键要重读，推荐入口的记账也要清空。 */
  useEffect(() => {
    setOverrides(loadModuleOverrides(repositoryId));
    setEntryState({});
    requestedEntries.current.clear();
    // 存在浏览器里的改档要搬进引擎（幂等，搬完清本地键）
    void migrateLegacyTierOverrides(repositoryId);
  }, [repositoryId]);
  useEffect(() => {
    // 推荐入口是花 token 的请求：闸门由 everVisible 把住。
    // 去重用 ref 而不是 state——entryState 进依赖会让写 loading 触发重跑，永久停在 loading。
    if (!everVisible || !t.course) return;
    const mod = modules.find((item) => item.id === activeModule);
    if (!mod || requestedEntries.current.has(entryKey)) return;
    requestedEntries.current.add(entryKey);
    setEntryState((curr) => (curr[entryKey] ? curr : { ...curr, [entryKey]: { status: "loading", entries: [] } }));
    // 刻意不加卸载标志丢弃结果（StrictMode 双跑同理）。
    api.getModuleEntries(repositoryId, mod.label, mod.hint)
      .then((result) => {
        // engine 未配置 LLM / 预算已达上限 / 判空 / 调用失败都回空列表，一律落到模块自己的文件清单；
        // 为什么回落由引擎的 reason 说明，几种情况的处置不同。
        const entries = result.source === "llm" ? result.entries : [];
        setEntryState((curr) => ({ ...curr, [entryKey]: entries.length ? { status: "llm", entries } : { status: "files", entries: [], reason: result.reason } }));
      })
      .catch(() => {
        setEntryState((curr) => ({ ...curr, [entryKey]: { status: "files", entries: [], reason: "请求失败，按模块结构列出文件" } }));
      });
  }, [t.course, repositoryId, activeModule, entryKey, modules, everVisible]);
  /** 展开态按「仓库:模块」记，切模块与换仓互不残留。 */
  const [expandedEntryLists, setExpandedEntryLists] = useState<Set<string>>(new Set());
  const moduleEntries = entryState[entryKey];
  /** 「tab 打开过但请求还没落地」的那一帧也按等待渲染，避免先闪一下回退清单。 */
  const entryPending = everVisible && !moduleEntries && Boolean(t.course);
  /** 等待态 = 已有 loading 记录，或还没计入审计的那一帧。 */
  const entryWaiting = moduleEntries?.status === "loading" || entryPending;
  const visibleEntries: (ModuleEntry & { reason?: string })[] = moduleEntries?.status === "llm"
    ? moduleEntries.entries
    : entryWaiting || !t.course
      ? []
      : moduleEntryFiles;
  /** 渲染用的截断视图，只影响列表高度；`suggestedPaths` 与改选埋点仍看完整 `visibleEntries`，
      否则被折叠掉的文件被手动打开时会误记成「用户自己换了入口」。 */
  const shownEntries = expandedEntryLists.has(entryKey) || visibleEntries.length <= ENTRY_PAGE ? visibleEntries : visibleEntries.slice(0, ENTRY_PAGE);
  const entryNoteFull = moduleEntries?.status === "llm"
    ? "LLM 推荐 · 点开即问"
    : entryWaiting
      ? "正在挑阅读顺序…"
      : moduleEntries?.reason ?? `按模块结构列出 ${moduleEntryFiles.length} 个文件`;
  /** 正文只留「为什么是这份清单」的第一句，完整理由进悬停。 */
  const entryNote = entryNoteFull.split(/[；，。(（]/)[0].slice(0, 14);

  /** 埋点口径「开文件即改选」：列表展示中，点推荐入口 = `entry_adopted`（真的换绑了选中节点才发），
      手动打开不在清单里的文件 = `entry_overridden`；loading 或空列表不发改选事件。
      `suggested_source` 取 `llm` 或 `module_files`（模块地图给的文件清单）。 */
  const entrySource = moduleEntries?.status === "llm" ? "llm" : "module_files";
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
  /** 选中行滚进可视区：滚动容器是 `.pal-list`。用 rect 差值而不是 `scrollIntoView`——后者会连带滚动祖先，把整页滚到底。 */
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
    void loadSource(path, 1);
    setPaletteOpen(false);
  };
  /** palette 键盘动线：↑↓ 移动选中行（首尾环绕），Enter 打开选中的那一行。 */
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

  /** 本地定位读数：只有「这一行不属于任何课程节点」时才会与绑定行不一致，此时如实说「本页已定位」。 */
  const located = source && source.line !== anchor?.line ? source.line : null;
  /**
    点源码一行 = 换阅读锚点。会话按课程节点建（引擎按节点 id 装配上下文，不收任意 path:line），
    所以先按 path + 行区间回查最具体的节点：查到就换绑（换绑会换线程，必须给一条 toast），
    查不到就只改本地定位读数。
   */
  const pickLine = (line: number): void => {
    if (!source || source.line === line) return;
    emit(repositoryId, "line_located", { path: source.path, line, trigger: "manual" });
    const tree = t.course ? flatten(t.course.root) : [];
    const owner = tree.filter((node) => node.anchors.some((a) => a.path === source.path && a.line <= line && line <= (a.endLine ?? a.line))).pop();
    if (owner && owner.id !== t.selected?.id) {
      t.setSelected(owner);
      showToast(`已换绑到「${owner.title}」`);
      return;
    }
    setSource({ ...source, line });
  };
  /** 传给源码岛的读数：定位行随点行走，内容与路径不变。 */
  const viewSource = source;

  if (t.error && !t.course) return <EmptyState title="代码教学暂不可用" detail={t.error} />;
  if (!t.course || !t.selected) return <Loading />;
  const { selected, course } = t;
  const moduleLabel = modules.find((item) => item.id === activeModule)?.label ?? "未命名模块";

  return (
    <>
      <PageTopbar
        crumb={<>
          <b>{workspace.repositoryPath.split("/").filter(Boolean).pop() ?? repositoryId}</b>
          <span className="faint">/</span>
          <span>代码教学</span>
          <span className="faint">·</span>
          {/* 正文只放文件名 + 行号 + 模块，完整路径与模块名进悬停 */}
          <span className="muted" title={`Agent 绑定：${anchor ? `${anchor.path}:${anchor.line}` : "未定位"} · 模块「${moduleLabel}」`}>
            <b className="mono fs-12">{anchor ? `${anchor.path.split("/").pop() ?? anchor.path}:${anchor.line}` : "未定位"}</b> · {moduleLabel.length > 12 ? `${moduleLabel.slice(0, 12)}…` : moduleLabel}
          </span>
          {located ? <span className="faint">· 本页第 {located} 行</span> : null}
        </>}
        actions={<span className="fs-11 faint mono" title="⌘P 搜文件；点源码行可就地定位">⌘P 快速打开</span>}
        showRailToggle
      />
      <MobileSwitcher labels={["教学模块", "实时源码"]} active={paneActive} onSelect={setPaneActive} />
      <section className="page page-teach" style={layoutVars(layout)}>
        {/* 「文件栏 / 源码岛」边界上的拖宽条：源码栏占剩余宽度 */}
        <ColumnResizer field="filePaneWidth" label="文件栏" growOn="right" />
        <aside className={`teach-side ${paneClass(0)}`}>
          <ModulesPane
            where="teaching"
            header="教学模块"
            modules={modules}
            activeId={activeModule}
            treeDerived
            onSelectModule={setActiveModule}
            onRename={(id, label) => setOverrides((curr) => ({ ...curr, renamed: { ...curr.renamed, [id]: label } }))}
            onAdd={(label) => {
              const id = `custom-${Date.now().toString(36)}`;
              setOverrides((curr) => ({ ...curr, custom: [...curr.custom, { id, label, hint: "自建模块 · 自己挑文件开始" }] }));
              setActiveModule(id);
            }}
            onRemove={(id) => setOverrides((curr) => (curr.custom.some((item) => item.id === id)
              ? { ...curr, custom: curr.custom.filter((item) => item.id !== id) }
              : { ...curr, hidden: [...curr.hidden, id] }))}
            onReset={() => setOverrides({ renamed: {}, hidden: [], custom: [] })}
          >
            <p className="field-note" title="模块职责来自课程树节点摘要；名称与取舍可在齿轮里的「模块配置」改">{modules.find((item) => item.id === activeModule)?.hint ?? ""}</p>

            <div className="tier-group">
              <ModuleSectionLabel label="推荐入口" note={entryNote} tip={`${entryNoteFull.replace(/。+$/, "")}。点一下即换阅读起点；清单由 LLM 按模块职责挑，每个模块首次展开时请求一次`} />
              {visibleEntries.length ? (
                <div className="col gap-2">
                  {shownEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`entry-card ${selected.id === entry.id ? "selected" : ""}`}
                      title={`${entry.path}:${entry.line}`}
                      onClick={() => {
                        const found = flatten(course.root).find((node) => node.id === entry.id);
                        if (!found) return;
                        t.setSelected(found);
                        emit(repositoryId, "entry_adopted", { module: activeModule, entry_id: entry.id, path: entry.path, source: entrySource });
                      }}
                    >
                      <span className="e-title"><Icon name="zap" size={12} />{entry.title}</span>
                      {entry.reason ? <span className="e-reason">{entry.reason}</span> : null}
                      <span className="e-path">{entry.path}:{entry.line}</span>
                    </button>
                  ))}
                  {shownEntries.length < visibleEntries.length ? (
                    <button
                      type="button"
                      className="entry-more"
                      onClick={() => setExpandedEntryLists((curr) => new Set(curr).add(entryKey))}
                    >
                      显示更多（还有 {visibleEntries.length - shownEntries.length} 条）
                    </button>
                  ) : null}
                </div>
              ) : moduleEntries?.status === "loading" ? (
                <p className="entry-empty">正在挑推荐入口…</p>
              ) : (
                <p className="entry-empty">这个模块没有推荐入口</p>
              )}
            </div>

            <div className="tier-group grow">
              <ModuleSectionLabel label="仓库文件" note={`${filePaths.length} 个`} tip="上面是推荐入口，这里是全仓文件树，任意文件都能点开" />
              <RepoTree nodes={fileTree} onOpenFile={openFile} activePath={source?.path} />
            </div>
          </ModulesPane>
        </aside>

        <div className={`teach-main ${paneClass(1)}`}>
          <div className="source-tabs-bar">
            <div className="tabs" role="tablist" aria-label="打开的文件">
              {tabs.map((tab) => (
                <button
                  key={tab.path}
                  type="button"
                  role="tab"
                  aria-selected={source?.path === tab.path}
                  className={`tab ${source?.path === tab.path ? "active" : ""}`}
                  title={tab.path}
                  onClick={() => void loadSource(tab.path, tab.line, { toast: false, trigger: "tab" })}
                >
                  <span className="mono fs-11">{tab.path.split("/").pop()}</span>
                  <span
                    className="tab-close"
                    role="button"
                    aria-label={`关闭 ${tab.path}`}
                    title={`关闭 ${tab.path}`}
                    onClick={(event) => { event.stopPropagation(); closeTab(tab.path); }}
                  >
                    <Icon name="x" size={11} />
                  </span>
                </button>
              ))}
            </div>
            <span className="tab-count">{tabs.length}/5 个标签</span>
          </div>
          <SourceView
            source={viewSource}
            onLineClick={pickLine}
            emptyHint="点左侧推荐入口或文件开始阅读"
          />
        </div>
      </section>
      {paletteOpen && (
        <div className="palette-mask" onClick={() => setPaletteOpen(false)}>
          <div className="palette" role="dialog" aria-label="搜索仓库文件" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              value={query}
              placeholder="输入文件名…（↑↓ 选择 · Enter 打开 · Esc 关闭）"
              aria-label="搜索仓库文件"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onPaletteKey}
            />
            <div className="pal-list" ref={paletteRef} role="listbox" aria-label={`匹配 ${paletteMatches.length} 个文件`}>
              {paletteMatches.map((path, index) => (
                <button key={path} type="button" role="option" aria-selected={index === paletteIndex} className={`pal-item ${index === paletteIndex ? "sel" : ""}`} onClick={() => openFile(path)}>
                  <Icon name="file" size={14} />
                  <span className="mono fs-12">{path.split("/").pop()}</span>
                  <span className="pal-path">{path}</span>
                </button>
              ))}
              {!paletteMatches.length ? <p className="empty">没有匹配的文件</p> : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
