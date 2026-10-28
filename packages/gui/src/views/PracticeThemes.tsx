import { useState, type ReactElement, type ReactNode } from "react";
import { showToast } from "../ui/toast";
import { COMPREHENSION_THEME_ID, type PracticeTheme } from "./practiceThemeState";
import { Icon } from "../ui/icons";
import { DangerDialog } from "../ui/DangerDialog";

/** 练习页左栏主题面板：固定「程序理解题」+ 自建主题，本地标签；面板主体由 children 注入。 */
export function PracticeThemes({
  header,
  modules,
  activeId,
  onSelectModule,
  onRename,
  onAdd,
  onRemove,
  onReset,
  children
}: {
  header: string;
  modules: PracticeTheme[];
  activeId: string;
  onSelectModule: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onAdd: (label: string) => void;
  onRemove: (id: string) => void;
  onReset: () => void;
  children: ReactNode;
}): ReactElement {
  const [configOpen, setConfigOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const removable = (item: PracticeTheme): boolean => item.custom === true && item.id !== COMPREHENSION_THEME_ID;
  const [pending, setPending] = useState<{ remove?: PracticeTheme; reset?: true } | null>(null);

  const remove = (item: PracticeTheme): void => {
    if (item.id === COMPREHENSION_THEME_ID) return;
    onRemove(item.id);
    showToast(`已删除主题「${item.label}」`);
  };

  const add = (): void => {
    const label = draftName.trim();
    if (!label) return;
    onAdd(label);
    setDraftName("");
    showToast(`已新增主题「${label}」`);
  };

  const reset = (): void => {
    onReset();
    showToast("已恢复默认主题");
  };

  const customCount = modules.filter((item) => item.custom).length;

  return (
    <div className="side-col">
      <section className="chip-block">
        <div className="row between">
          <h3 className="section-title">{header}</h3>
          <button type="button" className={`icon-btn${configOpen ? " on" : ""}`} aria-expanded={configOpen} aria-label="主题配置" title="主题配置：改名 / 新增 / 删除" onClick={() => setConfigOpen((open) => !open)}>
            <Icon name="settings" size={14} />
          </button>
        </div>
        <div className="chip-list" role="tablist" aria-label={`${header}切换`}>
          {modules.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === activeId}
              className={`chip ${item.id === activeId ? "active" : ""}`}
              title={item.hint}
              onClick={() => onSelectModule(item.id)}
            >
              <span className="chip-name">{item.label}</span>
              {item.custom ? <span className="chip-count">自建</span> : null}
            </button>
          ))}
        </div>
      </section>

      {configOpen && (
        <div className="side-block module-config">
          <div className="cfg-head">自定义出题主题<span>新主题由 LLM 出题</span></div>
          {modules.map((item) => (
            <div className="cfg-row" key={item.id}>
              <input className="text-input" value={item.label} aria-label="主题名称" onChange={(event) => onRename(item.id, event.target.value)} />
              {removable(item) && <button type="button" className="icon-btn" aria-label={`删除 ${item.label}`} title={`删除 ${item.label}`} onClick={() => setPending({ remove: item })}><Icon name="x" size={13} /></button>}
            </div>
          ))}
          <div className="cfg-add">
            <input className="text-input" value={draftName} placeholder="新增出题主题…" aria-label="新增主题名称" onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={add}>添加</button>
          </div>
          <div className="cfg-foot">
            <button type="button" className="cfg-reset" onClick={() => setPending({ reset: true })}>恢复默认</button>
            <span className="faint fs-11">改动即时生效并本地保存</span>
          </div>
        </div>
      )}
      {children}
      {pending ? (
        pending.remove ? (
          <DangerDialog
            title="删除这个主题"
            body={`「${pending.remove.label}」只存这台浏览器里，删掉找不回来。`}
            deleteLabel={`删除「${pending.remove.label}」`}
            onDelete={() => { const item = pending.remove!; setPending(null); remove(item); }}
            onClose={() => setPending(null)}
          />
        ) : (
          <DangerDialog
            title="恢复默认主题"
            body={`会删掉 ${String(customCount)} 个自建主题，找不回来。`}
            deleteLabel={`删掉 ${String(customCount)} 个自建主题`}
            onDelete={() => { setPending(null); reset(); }}
            onClose={() => setPending(null)}
          />
        )
      ) : null}
    </div>
  );
}

/** 「本模块已练 / 练习上下文」共用的小节标题。 */
export function PracticeSectionLabel({ label, note, tip }: { label: string; note?: string; tip?: string }): ReactElement {
  return <div className="section-title row">{label}{note ? <span className="faint fs-11" title={tip}>{note}</span> : null}</div>;
}
