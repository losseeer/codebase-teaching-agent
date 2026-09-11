import { useState, type ReactElement, type ReactNode } from "react";
import { Settings2, X } from "lucide-react";
import { showToast } from "./toast";
import { DEFAULT_MODULES, type KnowledgeModule, type ModuleWhere } from "./store";

/**
  知识模块面板（prototype `.modules-pane` 的 GUI 实现）：
  - 模块 chips（计数）+「＋ 配置」入口
  - 配置面板：重命名 / 删除 / 新增 / 恢复缺省（prototype `.module-config` 的四类操作）
  - 面板主体（推荐入口 / 仓库文件 / 练习列表）由调用方以 children 注入

  对应 prototype `design-prototype.html` L211-260（chips）+ L584-637（config）。
  */

export function ModulesPane({
  where,
  header,
  modules,
  activeId,
  onSelectModule,
  onModulesChange,
  children,
}: {
  where: ModuleWhere;
  header: string;
  modules: KnowledgeModule[];
  activeId: string;
  onSelectModule: (id: string) => void;
  onModulesChange: (next: KnowledgeModule[], nextActiveId: string) => void;
  children: ReactNode;
}): ReactElement {
  const [configOpen, setConfigOpen] = useState(false);
  const [draftName, setDraftName] = useState("");

  const rename = (id: string, label: string): void => {
    onModulesChange(modules.map((item) => (item.id === id ? { ...item, label: label.trim() || "未命名模块" } : item)), activeId);
  };
  const remove = (id: string): void => {
    if (modules.length <= 1) return;
    const removed = modules.find((item) => item.id === id);
    const next = modules.filter((item) => item.id !== id);
    onModulesChange(next, activeId === id ? next[0].id : activeId);
    showToast(`已删除模块「${removed?.label ?? id}」`);
  };
  const add = (): void => {
    const label = draftName.trim();
    if (!label) return;
    const id = `custom-${Date.now().toString(36)}`;
    onModulesChange([...modules, { id, label, hint: "自定义模块 · 还没有推荐入口，先从仓库文件开始" }], id);
    setDraftName("");
    showToast(`已新增模块「${label}」`);
  };
  const reset = (): void => {
    onModulesChange(DEFAULT_MODULES.map((item) => ({ ...item })), DEFAULT_MODULES[0].id);
    showToast("已恢复缺省四模块");
  };

  return (
    <aside className={`pane modules-pane modules-pane-${where}`}>
      <div className="pane-header"><h2>{header}</h2><span>{modules.find((item) => item.id === activeId)?.label ?? ""}</span></div>
      <div className="module-body">
        <div className="module-chips" role="tablist" aria-label={`${header}切换`}>
          {modules.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === activeId}
              className={`module-chip ${item.id === activeId ? "active" : ""}`}
              onClick={() => onSelectModule(item.id)}
            >
              {item.label}
            </button>
          ))}
          <button className={`module-chip add ${configOpen ? "on" : ""}`} aria-expanded={configOpen} onClick={() => setConfigOpen((open) => !open)}>
            <Settings2 size={11} /> 配置
          </button>
        </div>
        {configOpen && (
          <div className="module-config">
            <div className="cfg-head">自定义知识模块<span>缺省为四个计算机知识模块</span></div>
            {modules.map((item) => (
              <div className="cfg-row" key={item.id}>
                <input value={item.label} aria-label="模块名称" onChange={(event) => rename(item.id, event.target.value)} />
                {modules.length > 1 && <button className="cfg-del" aria-label={`删除 ${item.label}`} title={`删除 ${item.label}`} onClick={() => remove(item.id)}><X size={12} /></button>}
              </div>
            ))}
            <div className="cfg-add">
              <input value={draftName} placeholder="新增模块名称…" aria-label="新增模块名称" onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
              <button className="cfg-add-btn" onClick={add}>添加</button>
            </div>
            <div className="cfg-foot">
              <button className="cfg-reset" onClick={reset}>恢复缺省四模块</button>
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
