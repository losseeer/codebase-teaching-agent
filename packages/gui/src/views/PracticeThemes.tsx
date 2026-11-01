import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { Exercise, ExerciseBankEntry, ExerciseType } from "@codebase-tutor/domain";
import { showToast } from "../ui/toast";
import { type PracticeTheme } from "./practiceThemeState";
import { Icon } from "../ui/icons";
import { DangerDialog } from "../ui/DangerDialog";
import { PopMenu } from "../ui/PopMenu";
import { dateText, exerciseKindLabel } from "../ui/labels";

/** 题型三档：题型决定链路，主题只筛目标。 */
const EXERCISE_TYPES: { id: ExerciseType; label: string; hint: string }[] = [
  { id: "comprehension", label: "程序理解", hint: "读懂代码：影响分析 / 修改定位，规则出题、判分确定" },
  { id: "analysis", label: "程序分析", hint: "用自己的话分析，按评分细则判分；需要选一个考察主题" },
  { id: "design", label: "程序设计", hint: "在编辑器里改代码或写代码，跑测试判分；需要选一个考察主题" }
];
const DESIGN_KINDS = [{ id: "patch_edit", label: "改代码" }, { id: "author_function", label: "写代码" }] as const;
/** 主题超过这个数就收成下拉，横向 chips 不再铺满整栏。 */
const THEME_CHIPS_MAX = 8;
/** 题库「其余」默认露几行。 */
const BANK_PREVIEW = 3;

/** 左栏第一块：选题型（程序设计再选改代码 / 写代码）。 */
export function PracticeTypePicker({ value, onChange, designKind, onDesignKind }: {
  value: ExerciseType;
  onChange: (type: ExerciseType) => void;
  designKind: "patch_edit" | "author_function";
  onDesignKind: (kind: "patch_edit" | "author_function") => void;
}): ReactElement {
  return (
    <section className="chip-block">
      <h3 className="section-title">题型</h3>
      <div className="chip-row" role="tablist" aria-label="题型">
        {EXERCISE_TYPES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === value}
            className={`chip chipped ${item.id === value ? "active" : ""}`}
            title={item.hint}
            onClick={() => onChange(item.id)}
          >{item.label}</button>
        ))}
      </div>
      {value === "design" ? (
        <div className="chip-row sub" role="radiogroup" aria-label="设计题形式">
          {DESIGN_KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={item.id === designKind}
              className={`chip chipped small ${item.id === designKind ? "active" : ""}`}
              onClick={() => onDesignKind(item.id)}
            >{item.label}</button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** 左栏第二块：考察知识（全是自建主题），配置面板由这里开合。 */
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
  const [pending, setPending] = useState<{ remove?: PracticeTheme; reset?: true } | null>(null);

  useEffect(() => {
    // 确认弹窗开着时 Esc 归它管，别把管理面板一起关掉
    if (!configOpen || pending) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") setConfigOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [configOpen, pending]);

  const remove = (item: PracticeTheme): void => {
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
    showToast("已清空主题");
  };

  const customCount = modules.filter((item) => item.custom).length;

  return (
    <div className="side-col">
      <section className="chip-block">
        <div className="row between">
          <h3 className="section-title">{header}</h3>
          <button type="button" className={`icon-btn${configOpen ? " on" : ""}`} aria-expanded={configOpen} aria-haspopup="dialog" aria-label="管理主题" title="管理主题：改名 / 新增 / 删除" onClick={() => setConfigOpen(true)}>
            <Icon name="settings" size={14} />
          </button>
        </div>
        {modules.length > THEME_CHIPS_MAX ? (
          <ThemePicker header={header} modules={modules} activeId={activeId} onSelect={onSelectModule} />
        ) : modules.length ? (
          <div className="chip-row" role="tablist" aria-label={`${header}切换`}>
            {modules.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === activeId}
                className={`chip chipped${item.id === activeId ? " active" : ""}`}
                onClick={() => onSelectModule(item.id)}
              >{item.label}</button>
            ))}
          </div>
        ) : (
          <p className="entry-empty">还没有考察主题，点右上角配置添加。</p>
        )}
      </section>

      {configOpen ? (
        <div className="modal-mask" onClick={() => setConfigOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={`管理${header}`} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>管理{header}</h3>
              <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={() => setConfigOpen(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <p className="field-note">所有仓库共用</p>
              {modules.map((item) => (
                <div className="cfg-row" key={item.id}>
                  <input className="text-input" value={item.label} aria-label="主题名称" onChange={(event) => onRename(item.id, event.target.value)} />
                  <button type="button" className="icon-btn" aria-label={`删除 ${item.label}`} title={`删除 ${item.label}`} onClick={() => setPending({ remove: item })}><Icon name="x" size={13} /></button>
                </div>
              ))}
              <div className="cfg-add">
                <input className="text-input" value={draftName} placeholder="新增考察主题…" aria-label="新增主题名称" onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
                <button type="button" className="btn btn-ghost btn-sm" onClick={add}>添加</button>
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="cfg-reset" onClick={() => setPending({ reset: true })}>清空主题</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfigOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      ) : null}
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
            title="清空主题"
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

/** 左栏第三块：题库。待复习常展开，其余默认收 3 条；点一行看题面预览。 */
export function PracticeBank({ entries, activeId, onOpen, onStart, onDelete }: {
  entries: ExerciseBankEntry[];
  activeId?: string;
  onOpen: (exercise: Exercise) => void;
  onStart: (exercise: Exercise) => void;
  onDelete: (exercise: Exercise) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const now = new Date().toISOString();
  const due = entries.filter((entry) => entry.review && entry.review.dueAt <= now);
  const rest = entries.filter((entry) => !(entry.review && entry.review.dueAt <= now));
  const shown = expanded ? rest : rest.slice(0, BANK_PREVIEW);
  const row = (entry: ExerciseBankEntry, showDate: boolean): ReactElement => (
    <BankRow key={entry.exercise.id} entry={entry} active={entry.exercise.id === activeId} showDate={showDate} onOpen={onOpen} onStart={onStart} onDelete={onDelete} />
  );
  return (
    <section className="chip-block">
      <h3 className="section-title row">题库<span className="faint fs-11">{entries.length} 道</span></h3>
      {entries.length ? (
        <>
          {due.length ? (
            <div className="bank-group">
              <div className="bank-group-head">待复习<span>{due.length}</span></div>
              {due.map((entry) => row(entry, false))}
            </div>
          ) : null}
          {rest.length ? (
            <div className="bank-group">
              {due.length ? <div className="bank-group-head">其余</div> : null}
              {shown.map((entry) => row(entry, true))}
              {rest.length > BANK_PREVIEW ? (
                <button type="button" className="bank-more" onClick={() => setExpanded((open) => !open)}>
                  {expanded ? "收起" : `展开其余 ${rest.length} 道`}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="entry-empty">题库还是空的，生成一道题就会出现在这里。</p>
      )}
    </section>
  );
}

/** 题库里的一行：点题面看预览；开始答题与删除收进末尾的菜单。 */
function BankRow({ entry, active, showDate, onOpen, onStart, onDelete }: {
  entry: ExerciseBankEntry;
  active: boolean;
  showDate: boolean;
  onOpen: (exercise: Exercise) => void;
  onStart: (exercise: Exercise) => void;
  onDelete: (exercise: Exercise) => void;
}): ReactElement {
  const { exercise, review } = entry;
  const [more, setMore] = useState<HTMLElement | null>(null);
  return (
    <div className={`bank-row${active ? " active" : ""}`}>
      <button type="button" className="bank-main" onClick={() => onOpen(exercise)} title={exercise.title}>
        <span className="bank-title">{exercise.title}</span>
        <span className="bank-meta">
          {exerciseKindLabel(exercise.kind)} · {exercise.tag || "不限主题"}
          {showDate && review ? <> · <span title="下次复习">{dateText(review.dueAt)}</span></> : null}
        </span>
      </button>
      <button type="button" className="icon-btn" aria-label={`「${exercise.title}」更多操作`} aria-haspopup="menu" aria-expanded={Boolean(more)} title="更多" onClick={(event) => setMore(event.currentTarget)}><Icon name="more" size={14} /></button>
      {more ? (
        <PopMenu
          anchor={more}
          ariaLabel={`「${exercise.title}」操作`}
          items={[
            { label: "开始答题", onSelect: () => { setMore(null); onStart(exercise); } },
            { label: "删除", danger: true, onSelect: () => { setMore(null); onDelete(exercise); } }
          ]}
          onClose={() => setMore(null)}
        />
      ) : null}
    </div>
  );
}

/** 主题多到一行放不下时收成下拉：触发器显示当前主题。 */
function ThemePicker({ header, modules, activeId, onSelect }: {
  header: string;
  modules: PracticeTheme[];
  activeId: string;
  onSelect: (id: string) => void;
}): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = modules.find((item) => item.id === activeId);
  return (
    <>
      <button type="button" className="chip chipped theme-select" aria-haspopup="menu" aria-expanded={Boolean(anchor)} onClick={(event) => setAnchor(event.currentTarget)}>
        <span className="chip-name">{current?.label ?? "选择主题"}</span>
        <span aria-hidden>▾</span>
      </button>
      {anchor ? (
        <PopMenu
          anchor={anchor}
          ariaLabel={header}
          items={modules.map((item) => ({ label: item.label, onSelect: () => { setAnchor(null); onSelect(item.id); } }))}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </>
  );
}
