import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { CourseTier } from "@codebase-tutor/shared";
import { showToast } from "./toast";
import { COMPREHENSION_MODULE_ID, type KnowledgeModule, type ModuleWhere } from "./local-state";
import { Icon } from "../ui/icons";

/**
  左栏模块区（对齐 docs/ui-prototype 的 `.tier-group` / `.chip-list`）：
  - 教学侧：模块按分级分成三组 **主干 / 设施 / 外围**（有自建模块时再加一组），组内一行一个模块，
    选中行 `.tier-node.active`；组标题右侧的 `.tier-tag` 是这组的判据摘要。
  - 练习侧：主题是少量自建项，没有分级，用 `.chip` 列表。
  - 引擎没给分级（旧响应）时退回平铺 chips，不凭空造分级标题。
  - 改名 / 隐藏 / 新增 / 手动改档收在「模块配置」这一小块里（原型没画，但它是有埋点的真实能力，不能丢）
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
const GROUP_LIMIT = 6;

/** 悬停文案：模块职责 + 分级依据。判据露出来，用户才知道该不该手动改。 */
function hoverText(item: KnowledgeModule): string {
  const parts = [
    item.entries?.length ? `${item.entries.length} 个文件` : "",
    item.hint,
    item.tierEvidence ? `${TIER_GROUPS.find((group) => group.tier === item.tier)?.label ?? "未分级"}：${item.tierEvidence.reason}` : "",
    item.tier && item.tierGiven && item.tier !== item.tierGiven ? `（已手动改档，引擎判：${TIER_GROUPS.find((group) => group.tier === item.tierGiven)?.label}）` : ""
  ];
  return parts.filter(Boolean).join(" · ");
}

/** 分组后的一区：`key` 决定它属于哪一档（`all` = 未分级的平铺 chips）。 */
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
  onTierChange,
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
  /** 手动改档（null = 恢复引擎判据）。只有课程树派生的模块才有档位可改，练习侧不传。 */
  onTierChange?: (id: string, tier: CourseTier | null) => void;
  children: ReactNode;
  treeDerived?: boolean;
}): ReactElement {
  const [configOpen, setConfigOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  /** 首屏只露主干与设施（引擎在 CourseTierEvidence 的注释里就是这么写的）：外围默认折起，组头可展开。 */
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(() => new Set(["periphery"]));
  /** 组内超过这个行数就先截一段，剩下的点「展开其余 N 项」——否则 20 行模块把推荐入口推出首屏。 */
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const isPractice = where === "practice";
  const removable = (item: KnowledgeModule): boolean => (isPractice ? item.custom === true : modules.length > 1);
  const tiered = treeDerived && modules.some((item) => item.tier);
  const sections: ModuleSection[] = useMemo(() => {
    if (!tiered) return [{ key: "all", label: header, note: "", items: modules }];
    const list: ModuleSection[] = TIER_GROUPS.map((group) => ({
      key: group.tier,
      label: group.label,
      note: group.note,
      // 组内按文件数从多到少：模块名一样长时，大模块更容易被看见
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

  return (
    <div className="side-col">
      <section className={tiered ? "tier-groups" : "chip-block"}>
        <div className="row between">
          <h3 className="section-title">{header}</h3>
          <button type="button" className={`icon-btn${configOpen ? " on" : ""}`} aria-expanded={configOpen} aria-label="模块配置" title="模块配置：改名 / 隐藏 / 新增 / 手动改档" onClick={() => setConfigOpen((open) => !open)}>
            <Icon name="settings" size={14} />
          </button>
        </div>
        {tiered ? sections.map((section) => {
          const folded = foldedGroups.has(section.key);
          const truncated = !folded && section.items.length > GROUP_LIMIT && !openGroups.has(section.key);
          const window = truncated ? section.items.slice(0, GROUP_LIMIT) : section.items;
          // 当前在学的模块必须看得见：它落在窗口外时把它顶到第一行
          const activeItem = section.items.find((item) => item.id === activeId);
          const rows = truncated && activeItem && !window.includes(activeItem) ? [activeItem, ...window.slice(1)] : window;
          return (
          <div className="tier-group" key={section.key}>
            <div className="tier-head">
              {section.label}
              <span className={`tier-tag tag-${section.key}`} title={section.note}>{section.items.length}</span>
              <button
                type="button"
                className="tier-fold"
                aria-expanded={!folded}
                title={folded ? `展开这一组 ${section.items.length} 个模块` : "收起这一组，首屏只留主干与设施"}
                onClick={() => setFoldedGroups((curr) => { const next = new Set(curr); if (next.has(section.key)) next.delete(section.key); else next.add(section.key); return next; })}
              >{folded ? `展开 ${section.items.length} 项` : "收起"}</button>
            </div>
            {folded ? null : rows.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === activeId}
                className={`tier-node ${item.id === activeId ? "active" : ""}`}
                title={hoverText(item)}
                onClick={() => onSelectModule(item.id)}
              >
                <Icon name="file" size={13} />
                <span className="tier-name">{item.label}</span>
                {item.entries?.length ? <span className="tier-count">{item.entries.length}</span> : null}
              </button>
            ))}
            {truncated ? (
              <button type="button" className="tree-row more" onClick={() => setOpenGroups((curr) => new Set(curr).add(section.key))}>
                {`展开其余 ${section.items.length - rows.length} 项`}
              </button>
            ) : null}
            {!truncated && !folded && openGroups.has(section.key) && section.items.length > GROUP_LIMIT ? (
              <button type="button" className="tree-row more" onClick={() => setOpenGroups((curr) => { const next = new Set(curr); next.delete(section.key); return next; })}>
                收起列表
              </button>
            ) : null}
          </div>
          );
        }) : (
          <div className="chip-list" role="tablist" aria-label={`${header}切换`}>
            {sections[0].items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === activeId}
                className={`chip ${item.id === activeId ? "active" : ""}`}
                title={hoverText(item)}
                onClick={() => onSelectModule(item.id)}
              >
                <span className="chip-name">{item.label}</span>
                {item.custom ? <span className="chip-count">自建</span> : item.entries?.length ? <span className="chip-count">{item.entries.length}</span> : null}
              </button>
            ))}
          </div>
        )}
      </section>

      {configOpen && (
        <div className="side-block module-config">
          <div className="cfg-head">{isPractice ? "自定义出题主题" : "模块配置"}<span title={isPractice ? "缺省是「程序理解题」；自定义主题由 LLM 出题" : "模块来自本仓库的模块地图；改名只影响显示，隐藏后可一键恢复"}>{isPractice ? "新主题由 LLM 出题" : "改名只影响显示"}</span></div>
          {modules.map((item) => (
            <div className="cfg-row" key={item.id}>
              <input className="text-input" value={item.label} aria-label="模块名称" onChange={(event) => onRename(item.id, event.target.value)} />
              {removable(item) && <button type="button" className="icon-btn" aria-label={`${treeDerived ? "隐藏" : "删除"} ${item.label}`} title={treeDerived ? `隐藏 ${item.label}` : `删除 ${item.label}`} onClick={() => remove(item)}><Icon name="x" size={13} /></button>}
            </div>
          ))}
          {treeDerived && onTierChange && modules.some((item) => item.tier) && (
            <div className="cfg-tiers">
              <div className="cfg-head">分级依据<span title="档位由引擎按文件的结构角色算出（确定、可复现）。改档只影响这里的分组，并给审计线留一条记录——攒起来就是判据的真值。">改档只影响这里的分组</span></div>
              {modules.filter((item) => item.tier).map((item) => (
                <div className="cfg-tier-row" key={item.id}>
                  <span className="cfg-tier-name" title={hoverText(item)}>{item.label}</span>
                  <span className="cfg-tier-buttons" role="group" aria-label={`${item.label} 的档位`}>
                    {TIER_GROUPS.map((group) => (
                      <button
                        key={group.tier}
                        type="button"
                        className={item.tier === group.tier ? "on" : ""}
                        aria-pressed={item.tier === group.tier}
                        title={`${group.note}${item.tierEvidence ? ` · 引擎判据：${item.tierEvidence.reason}` : ""}`}
                        onClick={() => onTierChange(item.id, item.tier === group.tier ? null : group.tier)}
                      >{group.label}</button>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="cfg-add">
            <input className="text-input" value={draftName} placeholder={isPractice ? "新增出题主题…" : "新增模块名称…"} aria-label="新增模块名称" onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={add}>添加</button>
          </div>
          <div className="cfg-foot">
            <button type="button" className="cfg-reset" onClick={reset}>{isPractice ? "恢复缺省" : "恢复全部模块"}</button>
            <span className="faint fs-11">改动即时生效并本地保存</span>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

/** 「推荐入口 / 仓库文件 / 模块内的练习」共用的小节标题：`note` 是跟在标题后的小字（能删就删），
  `tip` 是「机制/口径」那类解释——只在悬停时出现，不占版面。 */
export function ModuleSectionLabel({ label, note, tip }: { label: string; note?: string; tip?: string }): ReactElement {
  return <div className="section-title row">{label}{note ? <span className="faint fs-11" title={tip}>{note}</span> : null}</div>;
}
