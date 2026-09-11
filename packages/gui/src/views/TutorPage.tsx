import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { FileSearch, X } from "lucide-react";
import type { FileTreeNode, SuggestedEntry } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import type { TeachingSessionApi } from "../agent/useTeachingSession";
import { EmptyState, Loading, flatten } from "./helpers";
import { ContextLine, MobileSwitcher, useMobilePanes } from "./WorkspaceChrome";
import { ModulesPane, ModuleSectionLabel } from "../modules/ModulesPane";
import { showToast } from "../modules/toast";
import { classifyCourseNodes, loadActiveModule, loadModules, saveActiveModule, saveModules, type KnowledgeModule, type ModuleEntry } from "../modules/store";
import { SourceView, type SourcePayload } from "../source/SourceView";

/**
  教学会话工作区（对齐 prototype `.teaching-workspace`，两栏）：
  - 左 「教学模块」（modules-pane）：模块 chips + 配置 + 推荐入口（课程节点按模块归类）+ 仓库文件（点击打开源码）
  - 右 「实时源码」（source-pane）：只读源码 + 行高亮 + 源码 tabs + ⌘P 文件搜索
  - 语言风格滑块与教学阶段已迁到右侧 Agent 侧栏（prototype 里对话 Agent 与作用域上下文是一体的）
  - chat / composer / 流式订阅由 AgentRail 拥有（共享 useTeachingSession）
  */
export function TutorPage({ workspace, session: t }: { workspace: Workspace; session: TeachingSessionApi }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const [modules, setModules] = useState<KnowledgeModule[]>(loadModules);
  const [activeModule, setActiveModule] = useState<string>(() => loadActiveModule("teaching", modules));
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [tabs, setTabs] = useState<{ path: string; line: number }[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();

  useEffect(() => { saveModules(modules); }, [modules]);
  useEffect(() => { saveActiveModule("teaching", activeModule); }, [activeModule]);

  // 切换知识模块 → 往 teaching 线程记一条分隔线（prototype `switchModule` 同语义）
  const previousModule = useRef<string | null>(null);
  useEffect(() => {
    const labelOf = (id: string): string => modules.find((item) => item.id === id)?.label ?? id;
    if (previousModule.current && previousModule.current !== activeModule) t.pushDivider("teaching", `模块 · ${labelOf(previousModule.current)} → ${labelOf(activeModule)}`);
    previousModule.current = activeModule;
  }, [activeModule, modules]);

  useEffect(() => {
    let current = true;
    setFileTree([]);
    api.getIndex(repositoryId).then((index) => { if (current) setFileTree(index.fileTree); }).catch(() => undefined);
    return () => { current = false; };
  }, [repositoryId]);

  const anchor = t.selected?.anchors[0];
  /** 统一的源码加载入口：拉源码 + upsert 源码 tab（上限 5，prototype 同规则）+ 可选往 teaching 线程推分隔线。 */
  const loadSource = useCallback(async (path: string, line: number, note?: string, announce = true): Promise<void> => {
    try {
      const next = await api.getSource(repositoryId, path, line);
      setSource(next);
      setTabs((current) => {
        const tab = { path, line };
        const existing = current.find((item) => item.path === path);
        const nextTabs = existing ? current.map((item) => (item.path === path ? tab : item)) : [...current, tab];
        return nextTabs.slice(-5);
      });
      if (!announce) return;
      if (note) { t.pushDivider("teaching", note); showToast(note); }
      else showToast(`已打开 · ${path}`);
    } catch { showToast(`无法读取 ${path}`); }
  }, [repositoryId, t]);
  useEffect(() => {
    if (!anchor) { setSource(null); return; }
    // 首挂载自动定位不打 toast（三视图常驻挂载，隐藏视图的提示对用户是噪音）
    void loadSource(anchor.path, anchor.line, undefined, false);
  }, [anchor?.path, anchor?.line, loadSource]);

  // ⌘P / Ctrl+P 文件搜索（prototype 源码面板的「⌘ P 搜索文件」）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        setQuery("");
      } else if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const entries = useMemo<ModuleEntry[]>(() => (t.course ? classifyCourseNodes(t.course.root, modules) : []), [t.course, modules]);

  // 推荐入口：优先用 engine 的 LLM 推荐（单轮调用，按模块缓存）；未配置 LLM / 失败时回落关键词分类
  const [suggestedEntries, setSuggestedEntries] = useState<Record<string, SuggestedEntry[]>>({});
  useEffect(() => {
    if (!t.course) return;
    const mod = modules.find((item) => item.id === activeModule);
    if (!mod || suggestedEntries[activeModule]) return;
    let current = true;
    api.getModuleEntries(repositoryId, mod.label, mod.hint)
      .then((result) => { if (current && result.source === "llm" && result.entries.length) setSuggestedEntries((curr) => ({ ...curr, [activeModule]: result.entries })); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [t.course, repositoryId, activeModule, modules, suggestedEntries]);
  const visibleEntries: ModuleEntry[] = suggestedEntries[activeModule]?.length
    ? suggestedEntries[activeModule].map((entry) => ({ id: entry.id, title: entry.title, path: entry.path, line: entry.line, moduleId: activeModule }))
    : entries.filter((entry) => entry.moduleId === activeModule);

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

  if (t.error && !t.course) return <EmptyState title="教学会话暂不可用" detail={t.error} />;
  if (!t.course || !t.selected) return <Loading />;
  const { selected, course } = t;
  const moduleLabel = modules.find((item) => item.id === activeModule)?.label ?? "未命名模块";

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
            <p className="module-hint">{modules.find((item) => item.id === activeModule)?.hint ?? ""} · 模块可在「＋ 配置」里自定义</p>
            <ModuleSectionLabel label="推荐入口" note={suggestedEntries[activeModule]?.length ? "LLM 从课程树推荐 · 可直接提问" : "按关键词归类 · 配置 LLM 后自动升级"} />
            {visibleEntries.length ? (
              <div className="entry-list">
                {visibleEntries.map((entry) => (
                  <button
                    key={entry.id}
                    className={`entry-item ${t.selected?.id === entry.id ? "selected" : ""}`}
                    title={`${entry.path}:${entry.line}`}
                    onClick={() => { const found = flatten(course.root).find((node) => node.id === entry.id); if (found) t.setSelected(found); }}
                  >
                    <span className="entry-dot" />
                    <strong>{entry.title}</strong>
                    <code>{entry.path.split("/").pop()}:{entry.line}</code>
                  </button>
                ))}
              </div>
            ) : (
              <p className="entry-empty">该模块还没有推荐入口。用下面的仓库文件或中栏源码挑一个文件，直接开始提问。</p>
            )}
            <ModuleSectionLabel label="仓库文件" note="主要入口 · 任意目录与文件" />
            <RepoTree nodes={fileTree} onOpenFile={(path) => void loadSource(path, 1, `已打开 · ${path}`)} activePath={source?.path} />
          </ModulesPane>
        </div>
        <div className={paneClass(1)}>
          <section className="pane source-pane">
            <div className="pane-header"><h2>实时源码</h2><span>{source?.path ?? "未选择文件"}{filePaths.length ? ` · ${filePaths.length} 文件 · ⌘P 搜索` : ""}</span></div>
            {tabs.length ? (
              <div className="source-tabs" role="tablist" aria-label="打开的文件">
                {tabs.map((tab) => (
                  <button key={tab.path} role="tab" aria-selected={source?.path === tab.path} className={source?.path === tab.path ? "active" : ""} onClick={() => void loadSource(tab.path, tab.line)}>
                    {tab.path.split("/").pop()}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="source-meta"><span>{source ? `只读 · 已定位第 ${source.line} 行` : "选择左侧仓库文件或推荐入口"}</span><span>⌘ P 搜索文件</span></div>
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
                placeholder="搜索仓库文件（回车打开第一个）"
                aria-label="搜索仓库文件"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && paletteMatches[0]) { void loadSource(paletteMatches[0], 1, `已打开 · ${paletteMatches[0]}`); setPaletteOpen(false); } }}
              />
              <button className="palette-close" aria-label="关闭" onClick={() => setPaletteOpen(false)}><X size={13} /></button>
            </div>
            <div className="palette-list">
              {paletteMatches.map((path) => (
                <button key={path} onClick={() => { void loadSource(path, 1, `已打开 · ${path}`); setPaletteOpen(false); }}>{path}</button>
              ))}
              {!paletteMatches.length && <p className="palette-empty">没有匹配的文件</p>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** 仓库文件树（prototype `.repo-tree`）：目录默认折叠、首层展开，每目录最多展示 8 项 + 「显示其余 N 项」。 */
function RepoTree({ nodes, onOpenFile, activePath }: { nodes: FileTreeNode[]; onOpenFile: (path: string) => void; activePath?: string }): ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [fullyShown, setFullyShown] = useState<Set<string>>(() => new Set());
  if (!nodes.length) return <p className="entry-empty">仓库文件树加载中，或该仓库暂无文件索引。</p>;
  const LIMIT = 8;
  const render = (items: FileTreeNode[], depth: number): ReactElement[] => {
    const rows: ReactElement[] = [];
    items.forEach((node) => {
      if (node.kind === "directory") {
        const open = expanded.has(node.path);
        rows.push(
          <button key={node.path} className={`rt-dir ${open ? "open" : ""}`} style={{ paddingLeft: `${8 + depth * 12}px` }} onClick={() => setExpanded((prev) => { const next = new Set(prev); if (open) next.delete(node.path); else next.add(node.path); return next; })}>
            {open ? "⌄" : "›"} {node.name}<span>{node.children?.length ?? 0} 项</span>
          </button>,
        );
        if (open && node.children) {
          const shown = fullyShown.has(node.path) ? node.children : node.children.slice(0, LIMIT);
          rows.push(...render(shown, depth + 1));
          if (!fullyShown.has(node.path) && node.children.length > LIMIT) {
            rows.push(
              <button key={`${node.path}:more`} className="rt-more" style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }} onClick={() => setFullyShown((prev) => new Set(prev).add(node.path))}>
                显示其余 {node.children.length - LIMIT} 项
              </button>,
            );
          }
        }
      } else {
        rows.push(
          <button key={node.path} className={`rt-file ${activePath === node.path ? "selected" : ""}`} style={{ paddingLeft: `${8 + depth * 12}px` }} onClick={() => onOpenFile(node.path)}>
            ◇ <code>{node.name}</code>
          </button>,
        );
      }
    });
    return rows;
  };
  return <div className="repo-tree">{render(nodes, 0)}</div>;
}
