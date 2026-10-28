import { useEffect, useRef, type ReactElement } from "react";

/** 破坏性动作确认弹窗：默认焦点落在非破坏按钮。 */
export function DangerDialog({ title, body, keepLabel, deleteLabel, onKeep, onDelete, onClose }: {
  title: string;
  body: string;
  /** 「保留不删」出路存在时才给。 */
  keepLabel?: string;
  onKeep?: () => void;
  deleteLabel: string;
  onDelete: () => void;
  onClose: () => void;
}): ReactElement {
  const safe = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    safe.current?.focus();
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" role="alertdialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><h3>{title}</h3></div>
        <div className="modal-body"><p className="field-note">{body}</p></div>
        <div className="modal-foot">
          <span className="modal-note">删除后找不回来</span>
          <button type="button" className="btn btn-ghost btn-sm" ref={onKeep ? undefined : safe} onClick={onClose}>取消</button>
          {onKeep && keepLabel ? <button type="button" className="btn btn-ghost btn-sm" ref={safe} onClick={onKeep}>{keepLabel}</button> : null}
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={onDelete}>{deleteLabel}</button>
        </div>
      </div>
    </div>
  );
}
