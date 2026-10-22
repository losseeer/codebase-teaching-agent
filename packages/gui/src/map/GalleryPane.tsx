import { useRef, useState, type ReactElement } from "react";
import type { DiagramSummary } from "@codebase-tutor/shared/wire";
import { Icon } from "../ui/icons";
import { InlineName, MenuButton, PopMenu, type MenuItem } from "./PopMenu";
import { relativeTime } from "./diagramView";

/**
  左栏「图库」那一面：搜索 + 新建 + 一张图一行。
  这里只列摘要（`DiagramSummary`）：整张结构是点开才取的，左栏不承担画布。
  条目上那颗 ⋯ 才有重命名 / 版本历史 / 删除——三个动作都不碰结构，删除连版本历史一起没。
*/
export function GalleryPane({ diagrams, openId, loading, error, query, onQueryChange, onOpen, onCreate, onRename, onVersions, onDelete }: {
  diagrams: DiagramSummary[];
  openId: string | null;
  loading: boolean;
  error: string;
  query: string;
  onQueryChange: (value: string) => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onVersions: (diagram: DiagramSummary) => void;
  onDelete: (diagram: DiagramSummary) => void;
}): ReactElement {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const toggleMenu = (id: string) => (element: HTMLElement): void => {
    anchor.current = element;
    setMenuFor((current) => (current === id ? null : id));
  };
  const needle = query.trim().toLowerCase();
  const shown = needle ? diagrams.filter((item) => item.name.toLowerCase().includes(needle)) : diagrams;

  return (
    <div className="gallery">
      <div className="gallery-tools">
        <input
          className="text-input"
          value={query}
          placeholder="搜索图…"
          aria-label="搜索图"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <button type="button" className="icon-btn" title="新建空白图" aria-label="新建空白图" onClick={onCreate}><Icon name="plus" size={14} /></button>
      </div>

      {error ? <p className="gallery-error" title={error}>图库没读到</p> : null}
      {!error && loading && !diagrams.length ? <p className="gallery-empty">图库读取中…</p> : null}
      {!error && !loading && !diagrams.length ? (
        <p className="gallery-empty">
          <span>还没有图。</span>
          <span>点上面的 ＋ 建一张空白画布。</span>
        </p>
      ) : null}
      {!error && !loading && diagrams.length && !shown.length ? <p className="gallery-empty">没有匹配的图</p> : null}

      <div className="gallery-list">
        {shown.map((item) => {
          const menuItems: MenuItem[] = [
            { label: "重命名", onSelect: () => setRenaming(item.id) },
            { label: `版本历史${item.versions ? `（${item.versions}）` : ""}`, title: "每次结构改动存一版", disabled: !item.versions, onSelect: () => onVersions(item) },
            { label: "删除", danger: true, onSelect: () => onDelete(item) }
          ];
          return (
            <div key={item.id} className={`gallery-item ${openId === item.id ? "current" : ""}`} onClick={() => onOpen(item.id)}>
              {renaming === item.id ? (
                <InlineName value={item.name} ariaLabel="重命名这张图" onCommit={(name) => onRename(item.id, name)} onClose={() => setRenaming(null)} />
              ) : (
                <div className="g-name" title={item.name}>{item.name}</div>
              )}
              <div className="g-meta">
                <span className={`g-src ${item.source}`} title={item.source === "agent" ? "结构由对话里的 agent 写" : "这张图由你新建"}>
                  {item.source === "agent" ? "agent" : "我"}
                </span>
                <span title={`最后改动（ISO）：${item.updatedAt}`}>{relativeTime(item.updatedAt)}</span>
                <span className="g-count" title="节点、边与版本数">{`${item.nodes} 节点 · ${item.edges} 边${item.versions ? ` · ${item.versions} 版` : ""}`}</span>
              </div>
              <MenuButton label="更多操作" open={menuFor === item.id} onToggle={toggleMenu(item.id)} className="g-menu-btn" />
              {menuFor === item.id ? <PopMenu anchor={anchor.current} items={menuItems} onClose={() => setMenuFor(null)} ariaLabel={`图「${item.name}」的操作`} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
