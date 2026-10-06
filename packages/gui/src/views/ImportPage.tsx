import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, FolderGit2, RefreshCw } from "lucide-react";
import type { ImportJob, RepositoryCatalogEntry } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import { emit } from "../journal";
import { phaseLabel } from "./helpers";

/**
 * 导入仓库页：选择被学习的仓库 → 触发引擎异步导入 → 报告预估成本。
 * 完成后通过 `onImported` 把 workspace 抛给 App，再跳转宏观设计。
 *
 * 对应 prototype `design-prototype.html` 的「导入仓库」入口（原 v1 标签 `import`）。
 *
 * 这里**必须**能直接切到地址簿里已导入的仓：侧栏收起时那个全局切换器不在视野内，
 * 而这一页是唯一还能改工作区的地方——只给一个路径输入框等于逼人重新填绝对路径。
 */

interface Props {
  onImported: (workspace: Workspace) => void;
  workspace: Workspace | null;
  /** 引擎地址簿（App 持有，避免这页再拉一次同份清单） */
  catalog: RepositoryCatalogEntry[];
  /** 切到地址簿里的另一个仓（挂载成功由 App 负责换工作区并跳转） */
  onSwitchRepository: (repositoryId: string) => void;
  /** 点的就是当前仓：离开导入页即可 */
  onOpenRepository: () => void;
}

export function ImportPage({ onImported, workspace, catalog, onSwitchRepository, onOpenRepository }: Props): ReactElement {
  const [path, setPath] = useState(workspace?.repositoryPath ?? "");
  const [commentMode, setCommentMode] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Awaited<ReturnType<typeof api.getReport>> | null>(null);
  const navigate = useNavigate();
  /** 工作区切换只记一次：完成态可能被轮询/广播重复渲染，append-only 日志里重复记会造出假轨迹。 */
  const switchLogged = useRef(false);

  // 进度更新主通道 = /api/events 全局 SSE 事件流（引擎每个进度事件都 publish import.progress；EventSource 自带断线自动重连）；
  // 5s 轮询是兜底——事件流断线/丢事件时靠全量 GET 追上终态，轮询本身不再承担实时性。
  const jobId = job?.id;
  const jobActive = Boolean(job && !["completed", "failed"].includes(job.phase));
  useEffect(() => {
    if (!jobActive || !jobId) return;
    const source = new EventSource("/api/events");
    source.onmessage = (event: MessageEvent<string>) => {
      const serverEvent = JSON.parse(event.data) as { type: string; payload: ImportJob };
      if (serverEvent.type === "import.progress" && serverEvent.payload.id === jobId) setJob(serverEvent.payload);
    };
    const interval = window.setInterval(
      () => api.getImport(jobId).then(setJob).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取任务进度")),
      5000
    );
    return () => { window.clearInterval(interval); source.close(); };
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
        <div className="import-mode-row">
          <button type="button" role="switch" aria-checked={commentMode} aria-label="详细导入" className={`mode-switch${commentMode ? " on" : ""}`} onClick={() => setCommentMode((value) => !value)}>
            <i aria-hidden="true" />
          </button>
          <span className="mode-switch-label">详细导入</span>
          {commentMode && <span className="mode-token-hint">会消耗更多 token</span>}
        </div>
        <p className="import-mode-note">{commentMode
          ? "摘要生成时参考代码注释：注释写得多的仓库（面试讲解、课程作业类）中文概念词更容易被摘要带上、进而被搜到；代价是消耗更多 token。"
          : "摘要只看代码结构，更省 token。需要注释里的中文概念词也被摘要带上（面试讲解、课程作业类仓库），请在导入前打开「详细导入」——导入完成后不再提供该开关的修改入口，换口径需要重新导入。"}</p>
        {error && <p className="error-message">{error}</p>}
      </div>
      {catalog.length > 0 && (
        <div className="import-catalog" aria-label="地址簿里已导入的仓库">
          <div className="import-catalog-head">地址簿里已导入的 {catalog.length} 个仓<span>点一下就切过去，不用重填路径，也不会重新烧 token</span></div>
          {catalog.map((item) => {
            const isCurrent = item.repositoryId === workspace?.repositoryId;
            const verdict = item.freshness?.verdict;
            const note = !item.exists ? "目录已不在这里" : item.mounted ? "引擎已挂载" : "未挂载：点开才读它的产物";
            return (
              <button
                key={item.repositoryId}
                type="button"
                className={`import-catalog-row${isCurrent ? " current" : ""}`}
                title={`${item.repositoryPath}\n${note}`}
                onClick={() => (isCurrent ? onOpenRepository() : onSwitchRepository(item.repositoryId))}
              >
                <span className="import-catalog-name">{item.name}</span>
                <span className="import-catalog-path">{item.repositoryPath}</span>
                <span className={`import-catalog-state${item.exists ? "" : " bad"}${verdict === "stale" ? " stale" : ""}`}>
                  {isCurrent ? "当前" : !item.exists ? "目录不存在" : verdict === "stale" ? "产物已过期" : note}
                </span>
                <ChevronRight size={15} />
              </button>
            );
          })}
        </div>
      )}
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