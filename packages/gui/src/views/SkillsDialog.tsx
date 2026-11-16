import { useEffect, useRef, useState, type ReactElement } from "react";

import { api, type SkillItem } from "../api/client";
import { failureText, showToast, toastFailure } from "../ui/toast";
import { DangerDialog } from "../ui/DangerDialog";
import { Icon } from "../ui/icons";

/** 用户技能：出厂技能也可直接编辑，写前由引擎留 .bak；支持 .md / .zip 上传与 LLM 润色。 */
export function SkillsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [active, setActive] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [ask, setAsk] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const upload = useRef<HTMLInputElement>(null);

  const load = async (select?: string): Promise<void> => {
    const next = await api.getSkills();
    setSkills(next.skills);
    const target = select ?? (active || next.skills[0]?.name) ?? "";
    setActive(target);
    if (target) {
      const skill = await api.readSkill(target);
      setText(skill.text);
      setFiles(skill.files);
    } else {
      setText("");
      setFiles([]);
    }
  };

  useEffect(() => {
    void load().catch((reason: unknown) => setError(failureText("读取技能失败", reason)));
  }, []);

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError("");
    try { await task(); } catch (reason) { setError(failureText("操作失败", reason)); toastFailure("操作失败", reason); }
    finally { setBusy(false); }
  };

  const select = (skill: SkillItem): void => { void run(async () => { setActive(skill.name); await load(skill.name); }); };
  const save = (): void => { void run(async () => { await api.writeSkill(active, text); showToast("技能已保存"); await load(active); }); };
  const create = (): void => { void run(async () => {
    const created = await api.createSkill(name.trim());
    setName("");
    showToast("已新建技能");
    await load(name.trim());
  }); };
  const drop = (): void => { void run(async () => { await api.deleteSkill(active); showToast("已删除技能"); await load(); }); };
  const restore = (): void => { void run(async () => { await api.restoreSkills(); showToast("已恢复出厂技能"); await load(); }); };

  const polish = (instruction?: string): void => { void run(async () => {
    const next = await api.polishText(text, `技能 ${active}`, instruction);
    setText(next.text);
    setAsk("");
    showToast(instruction ? "已按指令改写，确认后保存" : "已润色，确认后保存");
  }); };

  const onUpload = (file: File): void => { void run(async () => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("读文件失败"));
      reader.readAsDataURL(file);
    });
    const skillName = file.name.replace(/\.(md|zip)$/i, "").toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "uploaded-skill";
    await api.uploadSkill(skillName, file.name, base64);
    showToast("已上传技能");
    await load(skillName);
  }); };

  return (
    <div className="modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal xwide" role="dialog" aria-modal="true" aria-label="技能">
        <div className="modal-head"><h3>技能</h3><button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}><span aria-hidden>×</span></button></div>
        <div className="modal-body">
          <div className="skills-layout">
            <aside className="skills-list">
              <div className="skills-new">
                <input className="text-input" value={name} placeholder="新技能名" aria-label="新技能名" spellCheck={false} onChange={(event) => setName(event.target.value)} />
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !name.trim()} onClick={create}>新建</button>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => upload.current?.click()}>上传 .md / .zip</button>
              <input ref={upload} type="file" accept=".md,.zip" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ""; }} />
              <div className="skills-items">
                {skills.map((skill) => (
                  <button key={skill.name} type="button" className={`skills-item${skill.name === active ? " active" : ""}`} onClick={() => select(skill)}>
                    <b>{skill.name}</b>
                    <span className="fs-11 faint">{skill.description || "（无描述）"}</span>
                    <span className="fs-11 faint">{skill.bundled ? "出厂" : "自定义"}</span>
                  </button>
                ))}
                {!skills.length ? <p className="field-note">还没有技能</p> : null}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={restore}>恢复出厂</button>
            </aside>
            <section className="skills-editor">
              <textarea className="text-input profile-editor" value={text} spellCheck={false} aria-label="SKILL.md 正文" onChange={(event) => setText(event.target.value)} />
              <p className="field-note">附属文件：{files.filter((item) => item !== "SKILL.md").join("、") || "无"}</p>
              <div className="profile-ask">
                <input className="text-input" value={ask} placeholder="让 agent 改，例如：把步骤精简成 3 步" aria-label="对技能说一句话" onChange={(event) => setAsk(event.target.value)} />
                {/* 一个发送口：空输入 = 润色全文，有输入 = 按指令改 */}
                <button type="button" className="send-btn" aria-label="发送" title="发送" disabled={busy || !text.trim()} onClick={() => polish(ask.trim() || undefined)}>
                  <Icon name="send" />
                </button>
              </div>
              {error ? <div className="banner banner-danger"><span className="banner-text">{error}</span></div> : null}
            </section>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-danger-ghost btn-sm" disabled={!active} onClick={() => setConfirmDelete(true)}>删除</button>
          <span className="modal-note">{active ? `编辑中：${active}` : ""}</span>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="button" className="btn btn-primary" disabled={busy || !active} onClick={save}>保存</button>
        </div>
      </div>
      {confirmDelete ? (
        <DangerDialog title={`删除技能「${active}」？`} body="目录会被删除；写过的 .bak 版本与恢复出厂不受影响。" deleteLabel="删除" onDelete={() => { setConfirmDelete(false); drop(); }} onClose={() => setConfirmDelete(false)} />
      ) : null}
    </div>
  );
}
