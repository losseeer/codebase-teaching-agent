import { useEffect, useState, type ReactElement } from "react";
import { CheckCircle2, Clock3, Code2, X } from "lucide-react";
import type { CompanionAction, CompanionSuggestion } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import { companionKindLabel } from "../views/helpers";

/**
 * 伴侣建议面板（仅 1 张最新建议卡片）。
 * - 通过 WebSocket 订阅 `/ws` 的 `companion.suggestion` 事件
 * - 用户可接受 / 稍后 / 忽略，对应 CompanionAction
 * - 仓库失效时通知上层清空 workspace
 *
 * 对应 prototype `design-prototype.html` 中的「伴侣模式（见设计文档第 9 章 §Hook 事件通道）」
 * 当前 GUI 实现为单卡片，与 prototype 多卡片堆叠的视觉不同；按 companion 一对一推送节奏保留单卡片是更稳的选择。
 */
export function CompanionDock({ workspace, onWorkspaceMissing }: { workspace: Workspace; onWorkspaceMissing: () => void }): ReactElement | null {
  const [suggestions, setSuggestions] = useState<CompanionSuggestion[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const refresh = (): void => {
    api.getCompanionSuggestions(workspace.repositoryId)
      .then((result) => setSuggestions(result.suggestions))
      .catch((reason: unknown) => {
        setSuggestions([]);
        if (reason instanceof Error && reason.message === "仓库不存在") onWorkspaceMissing();
      });
  };
  useEffect(() => {
    refresh();
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socket.onmessage = (event: MessageEvent<string>) => {
      const serverEvent = JSON.parse(event.data) as { type: string; payload: { repositoryId?: string; suggestion?: CompanionSuggestion } };
      if (serverEvent.type !== "companion.suggestion" || serverEvent.payload.repositoryId !== workspace.repositoryId || !serverEvent.payload.suggestion) return;
      setSuggestions((current) => [serverEvent.payload.suggestion!, ...current.filter((item) => item.id !== serverEvent.payload.suggestion!.id)]);
    };
    return () => socket.close();
  }, [workspace.repositoryId]);
  const act = async (suggestion: CompanionSuggestion, action: CompanionAction): Promise<void> => {
    setActing(suggestion.id);
    try { await api.actOnSuggestion(workspace.repositoryId, suggestion.id, action); setSuggestions((current) => current.filter((item) => item.id !== suggestion.id)); }
    finally { setActing(null); }
  };
  const suggestion = suggestions[0];
  if (!suggestion) return null;
  return (
    <aside className="companion-dock" aria-live="polite" aria-label="伴侣建议">
      <article className="companion-card">
        <div className="companion-heading"><span>{companionKindLabel(suggestion.kind)}</span><strong>{suggestion.title}</strong></div>
        <p>{suggestion.body}</p>
        {suggestion.anchors.length ? (
          <div className="companion-anchors">
            {suggestion.anchors.slice(0, 2).map((anchor) => <span key={`${anchor.path}:${anchor.line}`}><Code2 size={12} />{anchor.path}:{anchor.line}</span>)}
          </div>
        ) : null}
        <div className="companion-actions">
          <button className="primary icon-button" aria-label="接受建议" title="接受建议" onClick={() => void act(suggestion, "accepted")} disabled={acting === suggestion.id}><CheckCircle2 size={17} /></button>
          <button className="secondary icon-button" aria-label="稍后处理" title="稍后处理" onClick={() => void act(suggestion, "later")} disabled={acting === suggestion.id}><Clock3 size={17} /></button>
          <button className="secondary icon-button" aria-label="忽略建议" title="忽略建议" onClick={() => void act(suggestion, "dismissed")} disabled={acting === suggestion.id}><X size={17} /></button>
        </div>
      </article>
    </aside>
  );
}