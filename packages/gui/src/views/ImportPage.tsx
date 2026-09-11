import { useEffect, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, FolderGit2, RefreshCw } from "lucide-react";
import type { ImportJob } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import { phaseLabel } from "./helpers";

/**
 * 导入仓库页：选择被学习的仓库 → 触发引擎异步导入 → 报告预估成本。
 * 完成后通过 `onImported` 把 workspace 抛给 App，再跳转课程地图。
 *
 * 对应 prototype `design-prototype.html` 的「导入仓库」入口（原 v1 标签 `import`）。
 */

interface Props {
  onImported: (workspace: Workspace) => void;
  workspace: Workspace | null;
}

export function ImportPage({ onImported, workspace }: Props): ReactElement {
  const [path, setPath] = useState(workspace?.repositoryPath ?? "");
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Awaited<ReturnType<typeof api.getReport>> | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!job || ["completed", "failed"].includes(job.phase)) return;
    const interval = window.setInterval(
      () => api.getImport(job.id).then(setJob).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取任务进度")),
      700
    );
    return () => window.clearInterval(interval);
  }, [job]);
  useEffect(() => {
    if (job?.phase !== "completed" || !job.repositoryId) return;
    onImported({ repositoryId: job.repositoryId, repositoryPath: job.repositoryPath });
    api.getReport(job.repositoryId).then(setReport).catch(() => undefined);
  }, [job?.phase, job?.repositoryId]);

  const submit = async (): Promise<void> => {
    setError(""); setReport(null);
    try { setJob(await api.submitImport(path)); } catch (reason) { setError(reason instanceof Error ? reason.message : "导入失败"); }
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
        {error && <p className="error-message">{error}</p>}
      </div>
      {job && (
        <div className="import-progress" aria-live="polite">
          <div className="progress-top"><span>{job.message}</span><strong>{job.progress}%</strong></div>
          <div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div>
          <p>{phaseLabel(job.phase)}</p>
        </div>
      )}
      {report && (
        <div className="report-grid">
          <div className="report-stat"><span>可分析文件</span><strong>{report.index.totalFiles}</strong><small>{report.index.totalLines.toLocaleString()} 行源码</small></div>
          <div className="report-stat"><span>摘要缓存</span><strong>{report.estimate.cachedFiles}</strong><small>本次新建 {report.estimate.summarizedFiles} 条</small></div>
          <div className="report-stat"><span>预估输入</span><strong>{report.estimate.estimatedInputTokens.toLocaleString()}</strong><small>{report.estimate.provider}</small></div>
          <div className="report-actions"><button className="secondary" onClick={() => navigate("/course")}>查看课程地图 <ChevronRight size={16} /></button></div>
        </div>
      )}
    </section>
  );
}