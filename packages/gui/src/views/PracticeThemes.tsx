import { useState, type ReactElement, type ReactNode } from "react";
import type { Exercise, ExerciseType, ReviewSchedule } from "@codebase-tutor/domain";
import { showToast } from "../ui/toast";
import { type PracticeTheme } from "./practiceThemeState";
import { Icon } from "../ui/icons";
import { DangerDialog } from "../ui/DangerDialog";
import { dateText, exerciseKindLabel } from "../ui/labels";

/** 题型三档：题型决定链路，主题只筛目标。 */
const EXERCISE_TYPES: { id: ExerciseType; label: string; hint: string }[] = [
  { id: "comprehension", label: "程序理解", hint: "读懂代码：影响分析 / 修改定位，规则出题、判分确定" },
  { id: "analysis", label: "程序分析", hint: "用自己的话分析，按评分细则判分；需要选一个考察主题" },
  { id: "design", label: "程序设计", hint: "在编辑器里改代码或写代码，跑测试判分；需要选一个考察主题" }
];
const DESIGN_KINDS = [{ id: "patch_edit", label: "改代码" }, { id: "author_function", label: "写代码" }] as const;

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

/** 左栏第二块：考察知识（「全仓」+ 自建主题），配置面板由这里开合。 */
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
          <div className="cfg-head">考察知识<span>新主题由 LLM 出题 · 所有仓库共用</span></div>
          {modules.filter((item) => item.custom).map((item) => (
            <div className="cfg-row" key={item.id}>
              <input className="text-input" value={item.label} aria-label="主题名称" onChange={(event) => onRename(item.id, event.target.value)} />
              <button type="button" className="icon-btn" aria-label={`删除 ${item.label}`} title={`删除 ${item.label}`} onClick={() => setPending({ remove: item })}><Icon name="x" size={13} /></button>
            </div>
          ))}
          <div className="cfg-add">
            <input className="text-input" value={draftName} placeholder="新增考察主题…" aria-label="新增主题名称" onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
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

/** 左栏第三块：题库。点一行就把那道题摆到右栏，不重新出题。 */
export function PracticeBank({ entries, activeId, onOpen, onDelete }: {
  entries: { exercise: Exercise; review?: ReviewSchedule }[];
  activeId?: string;
  onOpen: (exercise: Exercise) => void;
  onDelete: (exercise: Exercise) => void;
}): ReactElement {
  return (
    <section className="chip-block">
      <h3 className="section-title row">题库<span className="faint fs-11">{entries.length} 道</span></h3>
      {entries.length ? (
        <div className="col bank-list">
          {entries.map(({ exercise, review }) => (
            <div key={exercise.id} className={`bank-row${exercise.id === activeId ? " active" : ""}`}>
              <button type="button" className="bank-main" onClick={() => onOpen(exercise)} title={review ? `下次复习 ${dateText(review.dueAt)}` : "还没判过分"}>
                <span className="bank-title">{exercise.title}</span>
                <span className="bank-meta">{exerciseKindLabel(exercise.kind)} · {exercise.tag || "全仓"}{review ? ` · 下次 ${dateText(review.dueAt)}` : ""}</span>
              </button>
              <button type="button" className="icon-btn" aria-label={`删除「${exercise.title}」`} title="从题库删除" onClick={() => onDelete(exercise)}><Icon name="x" size={13} /></button>
            </div>
          ))}
        </div>
      ) : (
        <p className="entry-empty">题库还是空的，生成一道题就会出现在这里。</p>
      )}
    </section>
  );
}
