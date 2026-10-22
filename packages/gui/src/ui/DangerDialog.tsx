import { useEffect, useRef, type ReactElement } from "react";

/**
  破坏性动作的确认弹窗：一条说明加出路——取消、可选的「不删也能办的另一条出路」、要点名才点的删除。
  删除做成独立按钮，默认焦点落在非破坏的那一颗：回车不许直接删。
  弹窗里写明删的是哪一份东西，删除不可恢复这句话固定在按钮上方。
  */
export function DangerDialog({ title, body, keepLabel, deleteLabel, onKeep, onDelete, onClose }: {
  title: string;
  body: string;
  /** 只在「保留另一份东西」确实是一种出路时给；没有就只出取消与删除两颗。 */
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
