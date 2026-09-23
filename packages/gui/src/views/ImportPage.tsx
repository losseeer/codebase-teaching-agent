import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, FolderGit2, RefreshCw } from "lucide-react";
import type { ImportJob } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import { emit } from "../journal";
import { phaseLabel } from "./helpers";

/**
 * 导入仓库页：选择被学习的仓库 → 触发引擎异步导入 → 报告预估成本。
 * 完成后通过 `onImported` 把 workspace 抛给 App，再跳转宏观设计。
 *
 * 对应 prototype `design-prototype.html` 的「导入仓库」入口（原 v1 标签 `import`）。
 */

interface Props {
  onImported: (workspace: Workspace) => void;
  workspace: Workspace | null;
}

export function ImportPage({ onImported, workspace }: Props): ReactElement {
  const [path, setPath] = useState(workspace?.repositoryPath ?? "");
  const [commentMode, setCommentMode] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Awaited<ReturnType<typeof api.getReport>> | null>(null);
  const navigate = useNavigate();
  /** 工作区切换只记一次：完成态可能被轮询/广播重复渲染，append-only 日志里重复记会造出假轨迹。 */
  const switchLogged = useRef(false);

  // 进度更新主通道 = /ws 广播（引擎每个进度事件都 publish import.progress）；
  // 5s 轮询是兜底——WS 断线/丢事件时靠全量 GET 追上终态，轮询本身不再承担实时性。
  const jobId = job?.id;
  const jobActive = Boolean(job && !["completed", "failed"].includes(job.phase));
  useEffect(() => {
    if (!jobActive || !jobId) return;
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socket.onmessage = (event: MessageEvent<string>) => {
      const serverEvent = JSON.parse(event.data) as { type: string; payload: ImportJob };
      if (serverEvent.type === "import.progress" && serverEvent.payload.id === jobId) setJob(serverEvent.payload);
    };
    const interval = window.setInterval(
      () => api.getImport(jobId).then(setJob).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取任务进度")),
      5000
    );
    return () => { window.clearInterval(interval); socket.close(); };
  }, [jobActive, jobId]);
  useEffect(() => {
    if (job?.phase !== "completed" || !job.repositoryId) return;
    onImported({ repositoryId: job.repositoryId, repositoryPath: job.repositoryPath });
    api.getReport(job.repositoryId).then(setReport).catch(() => undefined);
    if (!switchLogged.current) {
      switchLogged.current = true;
      emit(job.repositoryId, "repository_switched", { repository_path: job.repositoryPath, trigger: "import" });
    }
  }, [job?.phase, job?.repositoryId]);

  const submit = async (): Promise<void> => {
    setError(""); setReport(null);
    try { setJob(await api.submitImport(path.trim(), commentMode)); } catch (reason) { setError(reason instanceof Error ? reason.message : "导入失败"); }
  };
  return (
    <section className="page import-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">本地代码库</p>
          <h1>从一个真实仓库开始</h1>
          <p>索引、摘要、课程树和学习日志只写入所选仓库的 <code>.tutor/</code>。</p>
        </div>
      </div>
      <div className="import-form" aria-label="导入仓库">
        <label htmlFor="repo-path">仓库绝对路径</label>
        <div className="path-row">
          <input id="repo-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/name/Projects/example" />
          <button className="primary" onClick={submit} disabled={!path.trim() || Boolean(job && !["completed", "failed"].includes(job.phase))}>
            <FolderGit2 size={17} />导入
          </button>
        </div>
        <div className="import-mode-row" role="radiogroup" aria-label="摘要口径">
          <span>摘要口径</span>
          <button type="button" role="radio" aria-checked={!commentMode} className={commentMode ? "" : "selected"} onClick={() => setCommentMode(false)}>普通导入</button>
          <button type="button" role="radio" aria-checked={commentMode} className={commentMode ? "selected" : ""} onClick={() => setCommentMode(true)}>参考注释导入</button>
        </div>
        <p className="import-mode-note">{commentMode
          ? "摘要生成时参考代码注释：注释写得多的仓库（面试讲解、课程作业类）中文概念词更容易被摘要带上、进而被搜到，成本略高。"
          : "摘要只看代码结构，更省；注释里独有的概念可由导入后在成本监控页开启「摘要参考注释」并重新生成摘要补齐。"}</p>
        {error && <p className="error-message">{error}</p>}
      </div>
      {job && (
        <div className="import-progress" aria-live="polite">
          <div className="progress-top"><span>{job.message}</span><strong>{job.progress}%</strong></div>
          <div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div>
          <p>{phaseLabel(job.phase)}</p>
          {job.error && <p className="error-message">失败原因：{job.error}</p>}
        </div>
      )}
      {report && (
        <div className="report-grid">
          <div className="report-stat"><span>可分析文件</span><strong>{report.index.totalFiles}</strong><small>{report.index.totalLines.toLocaleString()} 行源码</small></div>
          <div className="report-stat"><span>摘要缓存</span><strong>{report.estimate.cachedFiles}</strong><small>本次新建 {report.estimate.summarizedFiles} 条</small></div>
          <div className="report-stat"><span>预估输入</span><strong>{report.estimate.estimatedInputTokens.toLocaleString()}</strong><small>{report.estimate.provider}</small></div>
          <div className="report-actions"><button className="secondary" onClick={() => navigate("/course")}>查看宏观设计 <ChevronRight size={16} /></button></div>
        </div>
      )}
    </section>
  );
}