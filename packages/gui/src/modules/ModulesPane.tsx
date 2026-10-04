import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Search, Settings2, X } from "lucide-react";
import { showToast } from "./toast";
import { COMPREHENSION_MODULE_ID, type KnowledgeModule, type ModuleWhere } from "./local-state";

/**
  模块面板（prototype `.modules-pane` 的 GUI 实现）：
  - 模块 chips（可切换）+「＋ 配置」入口（改名 / 隐藏或删除 / 自建 / 恢复）
  - 面板主体（推荐入口 / 仓库文件 / 模块内的练习）由调用方以 children 注入

  两侧语义不同，用 `treeDerived` 区分，**文案必须跟着变**：
  - 教学侧模块来自课程树（`treeDerived`）——「删除」实际是**隐藏**（重新导入或点「恢复」就回来），
    说「删除不可恢复」是假话；
  - 练习侧的自建主题存在浏览器本地，删掉真找不回来。

  模块数量可以很多（真仓 35 个业务模块），所以 chips 容器限高滚动、超过 10 个再给一个过滤框——
  不然 chip 区会把整个左栏撑没。
  */
const CHIP_FILTER_THRESHOLD = 10;

export function ModulesPane({
  where,
  header,
  modules,
  activeId,
  onSelectModule,
  onRename,
  onAdd,
  onRemove,
  onReset,
  children,
  treeDerived = false
}: {
  where: ModuleWhere;
  header: string;
  modules: KnowledgeModule[];
  activeId: string;
  onSelectModule: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onAdd: (label: string) => void;
  onRemove: (id: string) => void;
  onReset: () => void;
  children: ReactNode;
  treeDerived?: boolean;
}): ReactElement {
  const [configOpen, setConfigOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [filter, setFilter] = useState("");
  const isPractice = where === "practice";
  const removable = (item: KnowledgeModule): boolean => (isPractice ? item.custom === true : modules.length > 1);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? modules.filter((item) => item.label.toLowerCase().includes(needle)) : modules;
  }, [modules, filter]);

  const remove = (item: KnowledgeModule): void => {
    if (isPractice && item.id === COMPREHENSION_MODULE_ID) return;
    if (modules.length <= 1) return;
    // 破坏性动作先确认。两种后果分开说：隐藏可恢复，删除自定义项不可恢复
    const warning = treeDerived
      ? `隐藏模块「${item.label}」？只是从 chips 里收起，点「恢复全部模块」或重新导入就会回来。`
      : `删除模块「${item.label}」？模块清单只存浏览器本地，删掉找不回来。`;
    if (!window.confirm(warning)) return;
    onRemove(item.id);
    showToast(treeDerived ? `已隐藏模块「${item.label}」` : `已删除模块「${item.label}」`);
  };

  const add = (): void => {
    const label = draftName.trim();
    if (!label) return;
    onAdd(label);
    setDraftName("");
    showToast(`已新增模块「${label}」`);
  };

  const reset = (): void => {
    const customCount = modules.filter((item) => item.custom).length;
    const lost = treeDerived
      ? `会撤销全部改名、恢复被隐藏的模块，并清掉 ${customCount} 个自建模块`
      : customCount ? `会删掉 ${customCount} 个自定义项，并撤销全部改名` : "会撤销全部改名";
    if (!window.confirm(`恢复缺省模块：${lost}。继续吗？`)) return;
    onReset();
    showToast(isPractice ? "已恢复缺省模块" : "已恢复仓库的模块清单");
  };

  return (
    <aside className={`pane modules-pane modules-pane-${where}`}>
      <div className="pane-header"><h2>{header}</h2><span>{modules.find((item) => item.id === activeId)?.label ?? ""}</span></div>
      <div className="module-body">
        {modules.length > CHIP_FILTER_THRESHOLD && (
          <label className="module-filter">
            <Search size={11} aria-hidden />
            <input value={filter} placeholder={`筛选 ${modules.length} 个模块…`} aria-label="筛选模块" onChange={(event) => setFilter(event.target.value)} />
            {filter ? <button type="button" aria-label="清空筛选" onClick={() => setFilter("")}><X size={11} /></button> : null}
          </label>
        )}
        <div className="module-chips" role="tablist" aria-label={`${header}切换`}>
          {shown.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === activeId}
              className={`module-chip ${item.id === activeId ? "active" : ""}`}
              title={item.entries?.length ? `${item.entries.length} 个文件 · ${item.hint}` : item.hint}
              onClick={() => onSelectModule(item.id)}
            >
              {item.label}
              {item.entries?.length ? <b>{item.entries.length}</b> : null}
            </button>
          ))}
          {!shown.length && filter ? <span className="module-chips-empty">没有匹配的模块</span> : null}
          <button className={`module-chip add ${configOpen ? "on" : ""}`} aria-expanded={configOpen} onClick={() => setConfigOpen((open) => !open)}>
            <Settings2 size={11} /> 配置
          </button>
        </div>
        {configOpen && (
          <div className="module-config">
            <div className="cfg-head">{isPractice ? "自定义出题主题" : "模块配置"}<span>{isPractice ? "缺省为「程序理解题」；新增主题生成练习时由 LLM 出题" : "模块来自本仓库的模块地图；改名只影响显示，隐藏后可一键恢复"}</span></div>
            {modules.map((item) => (
              <div className="cfg-row" key={item.id}>
                <input value={item.label} aria-label="模块名称" onChange={(event) => onRename(item.id, event.target.value)} />
                {removable(item) && <button className="cfg-del" aria-label={`${treeDerived ? "隐藏" : "删除"} ${item.label}`} title={treeDerived ? `隐藏 ${item.label}` : `删除 ${item.label}`} onClick={() => remove(item)}><X size={12} /></button>}
              </div>
            ))}
            <div className="cfg-add">
              <input value={draftName} placeholder={isPractice ? "新增出题主题…" : "新增模块名称…"} aria-label="新增模块名称" onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
              <button className="cfg-add-btn" onClick={add}>添加</button>
            </div>
            <div className="cfg-foot">
              <button className="cfg-reset" onClick={reset}>{isPractice ? "恢复缺省" : "恢复全部模块"}</button>
              <span>改动即时生效并本地保存</span>
            </div>
          </div>
        )}
        {children}
      </div>
    </aside>
  );
}

/** 「推荐入口 / 仓库文件 / 模块内的练习」共用的小节标题（prototype `.module-section-label`）。 */
export function ModuleSectionLabel({ label, note }: { label: string; note?: string }): ReactElement {
  return <div className="module-section-label">{label}{note ? <span>{note}</span> : null}</div>;
}
