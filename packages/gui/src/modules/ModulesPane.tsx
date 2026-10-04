import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Settings2, X } from "lucide-react";
import type { CourseTier } from "@codebase-tutor/shared";
import { showToast } from "./toast";
import { COMPREHENSION_MODULE_ID, type KnowledgeModule, type ModuleWhere } from "./local-state";
import { OptionDropdown } from "../ui/OptionDropdown";

/**
  模块面板（prototype `.modules-pane` 的 GUI 实现）：
  - 教学侧：模块按分级各给一个**下拉**（主干 / 设施 / 外围，有自建模块时再加一栏「自建」）。
    真仓 30 个业务模块平铺成 chips 会把左栏挤满（2026-10-04 先用过「外围折起」，首屏仍占 19 个 chip），
    改下拉后这一区只剩三行；选中的模块名直接写在触发器上，不用展开也知道当前在学哪个。
    引擎没给分级（旧响应）时退回 chips 平铺，不凭空造分级标题。
  - 练习侧：主题是少量自建项，没有分级，仍是 chips 一行。
  - 面板主体（推荐入口 / 仓库文件 / 模块内的练习）由调用方以 children 注入

  两侧语义不同，用 `treeDerived` 区分，**文案必须跟着变**：
  - 教学侧模块来自课程树（`treeDerived`）——「删除」实际是**隐藏**（重新导入或点「恢复」就回来），
    说「删除不可恢复」是假话；
  - 练习侧的自建主题存在浏览器本地，删掉真找不回来。
  */
const TIER_GROUPS: { tier: CourseTier; label: string; note: string }[] = [
  { tier: "core", label: "主干", note: "入口与它直接依赖的代码" },
  { tier: "facility", label: "设施", note: "配置、存储、可观测等支撑代码" },
  { tier: "periphery", label: "外围", note: "看板 / 部署 / 文档 / 测试" }
];
const CUSTOM_SECTION = { key: "custom", label: "自建", note: "你自己圈的主题，没有仓库模块地图背书" };

/** 下拉里的一项：`key` 决定它属于哪一区（`all` = 未分级的平铺 chips）。 */
interface ModuleSection {
  key: string;
  label: string;
  note: string;
  items: KnowledgeModule[];
}

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
  const [openTier, setOpenTier] = useState<string | null>(null);
  const isPractice = where === "practice";
  const removable = (item: KnowledgeModule): boolean => (isPractice ? item.custom === true : modules.length > 1);
  const tiered = treeDerived && modules.some((item) => item.tier);
  const sections: ModuleSection[] = useMemo(() => {
    if (!tiered) return [{ key: "all", label: header, note: "", items: modules }];
    const list: ModuleSection[] = TIER_GROUPS.map((group) => ({
      key: group.tier,
      label: group.label,
      note: group.note,
      // 下拉面板里按文件数从多到少：模块名一样长时，大模块更容易被看见
      items: modules.filter((item) => item.tier === group.tier).sort((a, b) => (b.entries?.length ?? 0) - (a.entries?.length ?? 0))
    })).filter((section) => section.items.length);
    const custom = modules.filter((item) => !item.tier);
    if (custom.length) list.push({ ...CUSTOM_SECTION, items: custom });
    return list;
  }, [modules, tiered, header]);

  const remove = (item: KnowledgeModule): void => {
    if (isPractice && item.id === COMPREHENSION_MODULE_ID) return;
    if (modules.length <= 1) return;
    // 破坏性动作先确认。两种后果分开说：隐藏可恢复，删除自定义项不可恢复
    const warning = treeDerived
      ? `隐藏模块「${item.label}」？只是从模块清单里收起，点「恢复全部模块」或重新导入就会回来。`
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

  const chip = (item: KnowledgeModule): ReactElement => (
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
  );

  return (
    <aside className={`pane modules-pane modules-pane-${where}`}>
      <div className="pane-header"><h2>{header}</h2><span>{modules.find((item) => item.id === activeId)?.label ?? ""}</span></div>
      <div className="module-body">
        {tiered ? (
          <div className="module-tiers">
            {sections.map((section) => (
              <OptionDropdown
                key={section.key}
                label={section.label}
                tone={section.key}
                placeholder={`${section.items.length} 个模块`}
                ariaLabel={`${section.label}模块（${section.note}）`}
                options={section.items.map((item) => ({ value: item.id, label: item.label, count: item.entries?.length ?? 0, note: item.hint }))}
                value={activeId}
                open={openTier === section.key && !configOpen}
                onOpenChange={(next) => setOpenTier(next ? section.key : null)}
                onSelect={onSelectModule}
              />
            ))}
            <button className={`module-chip add ${configOpen ? "on" : ""}`} aria-expanded={configOpen} onClick={() => { setOpenTier(null); setConfigOpen((open) => !open); }}>
              <Settings2 size={11} /> 配置
            </button>
          </div>
        ) : (
          <div className="module-chips" role="tablist" aria-label={`${header}切换`}>
            {modules.map(chip)}
            <button className={`module-chip add ${configOpen ? "on" : ""}`} aria-expanded={configOpen} onClick={() => setConfigOpen((open) => !open)}>
              <Settings2 size={11} /> 配置
            </button>
          </div>
        )}
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
