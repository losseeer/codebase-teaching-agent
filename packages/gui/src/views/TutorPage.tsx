import {useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import type { FileTreeNode } from "@codebase-tutor/domain";

import { api, type Workspace } from "../api/client";
import type { ScopedChatApi } from "../agent/scopedChatApi";
import { Loading } from "../ui/Loading";
import { RepoTree } from "../source/RepoTree";
import { MobileSwitcher, PageTopbar, useMobilePanes } from "./WorkspaceChrome";
import { ColumnResizer, layoutVars, useLayout } from "../ui/ColumnResizer";
import { useEverVisible } from "../ui/useEverVisible";
import { Icon } from "../ui/icons";
import { emit } from "../journal";
import { showToast } from "../ui/toast";
import { SourceView, type SourcePayload } from "../source/SourceView";

/** 代码教学工作区：左栏项目目录，右栏源码 tabs。 */
export function TutorPage({ workspace, chat: t, visible }: { workspace: Workspace; chat: ScopedChatApi; visible: boolean }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [fileTreeError, setFileTreeError] = useState("");
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [tabs, setTabs] = useState<{ path: string; line: number }[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();
  const layout = useLayout();
  const openedPaths = useRef<string[]>([]);
  const sourceSeq = useRef(0);
  const lastAutoAnchor = useRef<string | null>(null);
  const paletteRef = useRef<HTMLDivElement | null>(null);

  const everVisible = useEverVisible(visible);
  useEffect(() => {
    if (!everVisible) return;
    let current = true;
    setFileTreeError("");
    api.getIndex(repositoryId).then((index) => { if (current) setFileTree(index.fileTree); }).catch((reason: unknown) => { if (current) setFileTreeError(reason instanceof Error ? reason.message : "文件树读取失败"); });
    return () => { current = false; };
  }, [repositoryId, everVisible, t.dataVersion]);

  const loadSource = useCallback(async (path: string, line: number, open: { toast?: boolean; trigger?: "manual" | "auto" | "tab" } = {}): Promise<void> => {
    const seq = ++sourceSeq.current;
    try {
      const next = await api.getSource(repositoryId, path, line);
      // 迟到的响应不落格：右栏与作用域跟随最后一次点击
      if (seq !== sourceSeq.current) return;
      setSource(next);
      const isNewFile = !openedPaths.current.includes(path);
      setTabs((current) => {
        const tab = { path, line };
        const existing = current.find((item) => item.path === path);
        const nextTabs = (existing ? current.map((item) => (item.path === path ? tab : item)) : [...current, tab]).slice(-5);
        openedPaths.current = nextTabs.map((item) => item.path);
        return nextTabs;
      });
      t.setScopeRef(`file:${path}`);
      if (isNewFile) emit(repositoryId, "file_opened", { path, line, trigger: open.trigger ?? "manual" });
      else emit(repositoryId, "line_located", { path, line, trigger: open.trigger ?? "manual" });
      if (open.toast !== false) showToast(`已打开 · ${path}`);
    } catch { showToast(`读不到 · ${path}`); }
  }, [repositoryId, t]);

  /** 目录也可作教学作用域。 */
  const openDir = (path: string): void => {
    t.setScopeRef(path ? `dir:${path}` : "dir:.");
    setSource(null);
    setTabs([]);
    openedPaths.current = [];
    emit(repositoryId, "file_anchored", { path: path || ".", source: "directory" });
    showToast(path ? `已选中目录 · ${path}` : "已选中仓库根目录");
  };

  const closeTab = (path: string): void => {
    const remaining = tabs.filter((item) => item.path !== path);
    setTabs((current) => {
      const next = current.filter((item) => item.path !== path);
      openedPaths.current = next.map((item) => item.path);
      return next;
    });
    if (source?.path !== path) return;
    const neighbor = remaining[remaining.length - 1];
    if (neighbor) void loadSource(neighbor.path, neighbor.line, { toast: false, trigger: "tab" });
    else { setSource(null); t.setScopeRef(null); }
  };

  const pickLine = (line: number): void => {
    if (!source || source.line === line) return;
    emit(repositoryId, "line_located", { path: source.path, line, trigger: "manual" });
    setSource({ ...source, line });
  };

  // 外部改了作用域：文件打开、目录清空源码视图；同一锚点不重复拉
  useEffect(() => {
    if (!t.scopeRef) { lastAutoAnchor.current = null; return; }
    if (!t.scopeRef.startsWith("file:")) { setSource(null); return; }
    const path = t.scopeRef.slice(5);
    const key = `${path}:1`;
    if (lastAutoAnchor.current === key) return;
    lastAutoAnchor.current = key;
    void loadSource(path, 1, { toast: false, trigger: "auto" });
  }, [t.scopeRef, loadSource]);

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
  useEffect(() => {
    const list = paletteRef.current;
    const item = list?.children[paletteIndex] as HTMLElement | undefined;
    if (!list || !item) return;
    const listBox = list.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    if (itemBox.top < listBox.top) list.scrollTop += itemBox.top - listBox.top;
    else if (itemBox.bottom > listBox.bottom) list.scrollTop += itemBox.bottom - listBox.bottom;
  }, [paletteIndex]);
  const openFile = (path: string): void => { void loadSource(path, 1); setPaletteOpen(false); };
  const onPaletteKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!paletteMatches.length) return;
      setPaletteIndex((index) => (index + (event.key === "ArrowDown" ? 1 : paletteMatches.length - 1)) % paletteMatches.length);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const picked = paletteMatches[paletteIndex] ?? paletteMatches[0];
      if (picked) openFile(picked);
    }
  };

  if (!everVisible && !fileTree.length) return <Loading />;
  const repositoryName = workspace.repositoryPath.split("/").filter(Boolean).pop() ?? repositoryId;
  const activeDir = t.scopeRef?.startsWith("dir:") ? t.scopeRef.slice(4) : undefined;

  return (
    <>
      <PageTopbar
        crumb={<>
          <b>{repositoryName}</b>
          <span className="faint">/</span>
          <span>代码教学</span>
          <span className="faint">·</span>
          <span className="muted" title={t.scopeRef ? t.scopeLabel : "还没选文件"}>
            {t.scopeRef ? t.scopeLabel : "还没选文件"}
          </span>
        </>}
        actions={<span className="fs-11 faint mono" title="⌘P 搜文件；点目录可按整个目录教学">⌘P 快速打开</span>}
        showRailToggle
      />
      <MobileSwitcher labels={["项目目录", "实时源码"]} active={paneActive} onSelect={setPaneActive} />
      <section className="page page-teach" style={layoutVars(layout)}>
        <ColumnResizer field="filePaneWidth" label="文件栏" growOn="right" />
        <aside className={`teach-side ${paneClass(0)}`}>
          <div className="row between">
            <h3 className="section-title">项目目录</h3>
          </div>
          {fileTreeError ? <p className="entry-empty">{fileTreeError}</p> : <RepoTree nodes={fileTree} onOpenFile={openFile} onOpenDir={openDir} activePath={source?.path} activeDir={activeDir} />}
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
          {source ? <SourceView source={source} onLineClick={pickLine} emptyHint="点左侧文件开始阅读" /> : (
            <div className="empty">
              <div className="empty-icon"><Icon name="folder" size={34} /></div>
              <div>{activeDir !== undefined ? `已选中目录${activeDir ? `「${activeDir}」` : "（仓库根目录）"}，可以直接在右侧提问` : "从左侧选一个文件或目录开始"}</div>
            </div>
          )}
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
