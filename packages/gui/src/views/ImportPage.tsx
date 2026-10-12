import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, FolderGit2, RefreshCw } from "lucide-react";
import type { ImportJob, RepositoryCatalogEntry } from "@codebase-tutor/shared";
import { api, subscribeServerEvents, type Workspace } from "../api/client";
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
  /** 预算闸门是否失效（引擎按进程环境给出，地址簿每条都带同一句）——取一条代表即可，与具体仓库无关 */
  const gateNotice = catalog.find((item) => item.budgetGateNotice)?.budgetGateNotice;
  /** 工作区切换只记一次：完成态可能被轮询/广播重复渲染，append-only 日志里重复记会造出假轨迹。 */
  const switchLogged = useRef(false);

  // 进度更新主通道 = /api/events 全局 SSE 事件流（引擎每个进度事件都 publish import.progress）；
  // 读流与重连在 `subscribeServerEvents` 里（原来用 EventSource，但它带不了认证头，闸门一开这条就静默断流）。
  // 5s 轮询是兜底——事件流断线/丢事件时靠全量 GET 追上终态，轮询本身不再承担实时性。
  const jobId = job?.id;
  const jobActive = Boolean(job && !["completed", "failed"].includes(job.phase));
  useEffect(() => {
    if (!jobActive || !jobId) return;
    const stop = subscribeServerEvents((event) => {
      if (event.type !== "import.progress") return;
      const progress = event.payload as unknown as ImportJob;
      if (progress.id === jobId) setJob(progress);
    });
    const interval = window.setInterval(
      () => api.getImport(jobId).then(setJob).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取任务进度")),
      5000
    );
    return () => { window.clearInterval(interval); stop(); };
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
        {/* 一句给结论、一句给「为什么/怎么改」：后者挪进 title，第一屏不该读两段说明书 */}
        <p className="import-mode-note" title={commentMode
          ? "注释写得多的仓库（面试讲解、课程作业类）里的中文概念词会一起进摘要，也因此更费 token。"
          : "想连注释一起摘要，请在导入前切到「详细导入」；换口径需要重新导入。"}>{commentMode
          ? "连注释一起摘要：中文概念词更容易被搜到，也更费 token。"
          : "只看代码结构，最省 token。要连注释一起摘要请切「详细导入」，导入后不可再改。"}</p>
        {error && <p className="error-message">{error}</p>}
      </div>
      {catalog.length > 0 && (
        <div className="import-catalog" aria-label="地址簿里已导入的仓库">
          <div className="import-catalog-head">地址簿里已导入的 {catalog.length} 个仓<span title="切换只是把该仓已有的分析产物挂回内存，不重新分析、不消耗 token">点一下切过去，不用重填路径</span></div>
          {/* 闸门失效是整个进程的事实，与哪条仓无关，所以只说一次。放在这一页是因为它是「花大钱之前」唯一的落点：
              成本监控页要有工作区才进得去，而第一次导入的人还没有工作区。 */}
          {gateNotice && <p className="cost-notice" title={`要配的环境变量：TUTOR_INPUT_USD_PER_MILLION / TUTOR_CACHE_HIT_USD_PER_MILLION / TUTOR_OUTPUT_USD_PER_MILLION（任一档即可，配完重启引擎）`}>{gateNotice}</p>}
          {catalog.map((item) => {
            const isCurrent = item.repositoryId === workspace?.repositoryId;
            const verdict = item.freshness?.verdict;
            // 监听死了要说：这条决定「产物会不会自己跟上」，而挂载项存在时人只会以为它会
            const note = !item.exists
              ? "目录已不在这里"
              : item.mounted
                ? item.watching === false
                  ? `引擎已挂载，但增量监听没起来：${item.watchError ?? "原因未知"}。改完代码不会自动重分析，新鲜度停在挂载那一刻`
                  : "引擎已挂载"
                : "未挂载：点开才读它的产物";
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
                <span className={`import-catalog-state${item.exists ? "" : " bad"}${verdict === "stale" ? " stale" : ""}${item.mounted && item.watching === false ? " stale" : ""}`}>
                  {isCurrent ? "当前" : !item.exists ? "目录不存在" : item.mounted && item.watching === false ? "无增量监听" : verdict === "stale" ? "产物已过期" : note}
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