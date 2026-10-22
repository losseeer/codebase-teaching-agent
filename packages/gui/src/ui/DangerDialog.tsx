import { useEffect, useRef, type ReactElement } from "react";

/**
  破坏性动作的确认弹窗：一条说明加两条出路——保留文件的默认动作，和要点名才点的删除动作。
  用原生 `window.confirm` 时「确定」就是那个破坏性分支，回车键会直接删；这里把删除做成独立按钮。
  删除是不可恢复的，所以弹窗里写明删的是哪一份东西、不碰全局的模型调用对账线。
  */
export function DangerDialog({ title, body, keepLabel, deleteLabel, onKeep, onDelete, onClose }: {
  title: string;
  body: string;
  keepLabel: string;
  deleteLabel: string;
  onKeep: () => void;
  onDelete: () => void;
  onClose: () => void;
}): ReactElement {
  const focused = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    focused.current?.focus();
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
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-ghost btn-sm" ref={focused} onClick={onKeep}>{keepLabel}</button>
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={onDelete}>{deleteLabel}</button>
        </div>
      </div>
    </div>
  );
}
