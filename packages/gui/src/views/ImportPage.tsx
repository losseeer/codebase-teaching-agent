import {useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { checkContract, importJobSchema, type ImportJob, type RepositoryCatalogEntry } from "@codebase-tutor/contract";

import { api, isNotFound, subscribeServerEvents, type Workspace } from "../api/client";
import { emit } from "../journal";
import { Icon } from "../ui/icons";
import { dateText } from "../ui/labels";
import { MenuButton, PopMenu, type MenuItem } from "../ui/PopMenu";
import { failureText } from "../ui/toast";
import { PageTopbar } from "./WorkspaceChrome";

// 导入仓库页：路径 → 分相进度 → 成本报告 → 已导入仓库清单。
// 完成后经 onImported 把 workspace 交给 App，再跳宏观设计。
// 本页可直接切换到已导入的仓。

interface Props {
  onImported: (workspace: Workspace) => void;
  workspace: Workspace | null;
  /** 已导入仓库清单（App 持有，这一页不再拉一次同份清单） */
  catalog: RepositoryCatalogEntry[];
  /** 切到清单里的另一个仓（挂载成功由 App 负责换工作区并跳转） */
  onSwitchRepository: (repositoryId: string) => void;
  /** 点的就是当前仓：离开导入页即可 */
  onOpenRepository: () => void;
  onForget: (repositoryId: string, name: string) => void;
}

/** 导入的分相清单：与引擎 ImportJob.phase 同一口径。 */
const PHASES: { key: ImportJob["phase"]; label: string }[] = [
  { key: "queued", label: "排队中" },
  { key: "indexing", label: "索引文件与 Git 历史" },
  { key: "summarizing", label: "摘要缓存与静态分析" },
  { key: "completed", label: "保存分析结果" }
];

export function ImportPage({ onImported, workspace, catalog, onSwitchRepository, onOpenRepository, onForget }: Props): ReactElement {
  const [path, setPath] = useState(workspace?.repositoryPath ?? "");
  const [commentMode, setCommentMode] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState("");
  /** 引擎里已无此任务：停止显示进度，如实报读不到。 */
  const [orphaned, setOrphaned] = useState(false);
  const [report, setReport] = useState<Awaited<ReturnType<typeof api.getReport>> | null>(null);
  /** 开着操作菜单的行（菜单靠锚点按钮定位）。 */
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const navigate = useNavigate();
  /** 预算闸门失效提示；各条文案相同，取第一条。 */
  const gateNotice = catalog.find((item) => item.budgetGateNotice)?.budgetGateNotice;
  /** 工作区切换只记一次：完成态会被轮询与广播重复渲染。 */
  const switchLogged = useRef(false);

  // 进度主通道是 /api/events 的 SSE；5s 轮询只兜底断线，不担实时
  const jobId = job?.id;
  /** 终态判定的唯一出口：轮询与按钮禁用共用。 */
  const isSettled = (phase: ImportJob["phase"]): boolean => phase === "completed" || phase === "failed";
  const jobActive = Boolean(job && !isSettled(job.phase) && !orphaned);
  useEffect(() => {
    if (!jobActive || !jobId) return;
    const stop = subscribeServerEvents((event) => {
      if (event.type !== "import.progress") return;
      // 进度帧先过契约再落地；读不懂就在页面明示
      try {
        const progress = checkContract(importJobSchema, event.payload, "import.progress");
        if (progress.id === jobId) setJob(progress);
      } catch (error) {
        setError(failureText("进度读不到，刷新一下", error));
      }
    });
    const interval = window.setInterval(
      () => api.getImport(jobId).then(setJob).catch((reason: unknown) => {
        // 404 = 引擎里已无此任务，重试读不回来
        if (isNotFound(reason)) setOrphaned(true);
        else setError(failureText("进度读不到", reason));
      }),
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

  /** 发起分析：上方按钮与清单的「重新分析」共用此路径。 */
  const startImport = async (target: string): Promise<void> => {
    const pathToUse = target.trim();
    if (!pathToUse || jobActive) return;
    setPath(pathToUse); // 输入框同步显示正在分析的仓
    setError(""); setReport(null); setOrphaned(false);
    try { setJob(await api.submitImport(pathToUse, commentMode)); } catch (reason) { setError(failureText("分析没开始", reason)); }
  };

  const submit = async (): Promise<void> => startImport(path);

  const activeIndex = job ? PHASES.findIndex((phase) => phase.key === job.phase) : -1;
  const failed = job?.phase === "failed";

  const menuTarget = menu ? catalog.find((item) => item.repositoryId === menu.id) : undefined;
  const menuItems: MenuItem[] = !menuTarget ? [] : [
    {
      label: "重新分析",
      title: menuTarget.exists ? "重扫仓库并重算分析产物" : "目录已不在这里，先放回原处",
      disabled: jobActive || !menuTarget.exists,
      onSelect: () => void startImport(menuTarget.repositoryPath)
    },
    { label: "移出清单", title: "停止跟踪这个仓库", danger: true, onSelect: () => onForget(menuTarget.repositoryId, menuTarget.name) }
  ];

  return (
    <>
      <PageTopbar crumb={<><b>导入仓库</b><span className="faint"></span></>} />
      <section className="page page-import">
        <div className="import-wrap">
          <div className="import-hero">
            <h1>导入一个代码仓库</h1>
            <p title="分析结果写在仓库内的 .tutor/，随仓库走">输入本机仓库的绝对路径，分析结果只写进仓库内的 <code className="mono">.tutor/</code>。</p>
          </div>

          <div className="card card-pad col gap-4">
            <div className="field">
              <label htmlFor="repo-path">仓库绝对路径</label>
              <div className="import-path-row">
                <input id="repo-path" className="text-input" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/absolute/path/to/repo" spellCheck={false} />
                <button type="button" className="btn btn-primary" onClick={submit} disabled={!path.trim() || jobActive}>
                  <Icon name="import" />{jobActive ? "导入中" : "开始导入"}
                </button>
              </div>
            </div>

            <div className="import-opts">
              <label>
                <span className="switch">
                  <input type="checkbox" checked={commentMode} aria-label="详细导入" onChange={(event) => setCommentMode(event.target.checked)} />
                  <span className="track" /><span className="thumb" />
                </span>
                详细导入
                {commentMode ? <span className="badge badge-warn">更费 token</span> : null}
              </label>
            </div>
            {/* 详细解释进悬停 */}
            <p className="field-note" title={commentMode
              ? "注释写得多的仓库里的中文概念词会一起进摘要，也因此更费 token。"
              : "要连注释一起分析请在导入前选「详细导入」；导入后改设置需重新导入。"}>{commentMode
              ? "连注释一起摘要，更费 token。"
              : "只看代码结构，最省 token。"}</p>

            {error ? <div className="banner banner-danger"><Icon name="alert" /><span className="banner-text">{error}</span></div> : null}
            {orphaned ? (
              <div className="banner banner-warn">
                <Icon name="alert" /><span className="banner-text">这一轮分析停了，重新点一次会接着跑。</span>
              </div>
            ) : null}

            {job && !orphaned ? (
              <div className="col gap-3" aria-live="polite">
                <div className="row between fs-12 muted"><span>{job.message}</span><strong className="mono">{job.progress}%</strong></div>
                <div className="progress"><div style={{ width: `${job.progress}%` }} /></div>
                <div className="phase-list">
                  {PHASES.map((phase, index) => {
                    // completed 是终态：四档都算走完，最后一档不再转圈
                    const finished = job.phase === "completed" || index < activeIndex;
                    const state = activeIndex < 0 ? "" : finished ? "done" : index === activeIndex ? "active" : "";
                    return (
                      <div className={`phase ${state}`} key={phase.key}>
                        <span className="phase-dot">
                          {state === "done" ? <Icon name="check" size={14} /> : state === "active" ? <i className="spinner" aria-hidden /> : <i className="phase-idot" aria-hidden />}
                        </span>
                        <span>{phase.label}</span>
                      </div>
                    );
                  })}
                </div>
                {failed ? <div className="banner banner-danger"><Icon name="alert" /><span className="banner-text">这一轮分析没跑完，重新点一次。</span></div> : null}
              </div>
            ) : null}

            {report ? (
              <div className="col gap-3">
                <div className="section-title">导入完成报告</div>
                <div className="report-grid">
                  <div className="card report-cell"><div className="num">{report.index.totalFiles}</div><div className="lbl">可分析文件</div></div>
                  <div className="card report-cell"><div className="num">{report.estimate.cachedFiles}</div><div className="lbl">摘要已缓存</div></div>
                  <div className="card report-cell"><div className="num">{(report.estimate.estimatedInputTokens / 1000).toFixed(1)}k</div><div className="lbl">预估输入 tokens</div></div>
                  {/* 单价未配置时显示未计价，不报 ¥0.00 */}
                  <div className="card report-cell"><div className="num">{report.estimate.estimatedCostUsd > 0 ? `¥${report.estimate.estimatedCostUsd.toFixed(2)}` : "未计价"}</div><div className="lbl">预估本次成本</div></div>
                </div>
                <div className="row">
                  <button type="button" className="btn btn-accent" onClick={() => navigate("/app?workspace=map")}>进入宏观设计 <Icon name="arrowRight" /></button>
                  <span className="fs-12 faint mono">{report.index.repositoryPath}/.tutor/</span>
                </div>
              </div>
            ) : null}
          </div>

          {catalog.length > 0 ? (
            <div className="col gap-3">
              <div className="row between">
                <div className="section-title">已导入仓库 · {catalog.length} 个</div>
                <span className="fs-11 faint" title="切换不重新分析、不产生费用"></span>
              </div>
              {/* 闸门失效是进程级事实 */}
              {gateNotice ? <div className="banner banner-warn"><Icon name="alert" /><span className="banner-text">{gateNotice}</span></div> : null}
              <div className="addr-list">
                {catalog.map((item) => {
                  const isCurrent = item.repositoryId === workspace?.repositoryId;
                  const verdict = item.freshness?.verdict;
                  // 人为挂起与监听失败是两种状态，界面分开显示
                  const paused = item.mounted && item.watchPaused === true;
                  const watching = item.mounted && item.watching === false && !paused;
                  const meta = [
                    item.repositoryPath,
                    paused ? `跟踪已暂停${item.watchPausedUntil ? `至 ${new Date(item.watchPausedUntil).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}` : watching ? `变更跟踪未启动：${item.watchError ?? "原因未知"}` : item.mounted ? "正在跟踪变更" : "未加载",
                    item.freshness?.analyzedAt ? `分析于 ${dateText(item.freshness.analyzedAt)}` : item.artifactsReady === false ? "暂无分析结果" : ""
                  ].filter(Boolean).join(" · ");
                  return (
                    <div className="addr-row" key={item.repositoryId}>
                    <button
                      type="button"
                      className={`card addr-card${isCurrent ? " current" : ""}`}
                      title={item.exists ? meta : `${item.repositoryPath}\n目录已不在这里`}
                      onClick={() => (isCurrent ? onOpenRepository() : onSwitchRepository(item.repositoryId))}
                    >
                      <span className="addr-icon"><Icon name="book" /></span>
                      <span className="col grow">
                        <span className="addr-name">{item.name}</span>
                        <span className="addr-meta">{meta}</span>
                      </span>
                      <span className="addr-badges">
                        {!item.exists ? <span className="badge badge-danger">目录不存在</span>
                          : paused ? <span className="badge badge-info">跟踪已暂停</span>
                            : watching ? <span className="badge badge-warn">无增量监听</span>
                            : item.mounted ? <span className="badge badge-ok">已就绪</span>
                              : <span className="badge badge-neutral">未加载</span>}
                        {verdict === "stale" ? <span className="badge badge-warn">分析已过期</span>
                          : verdict === "drifted" ? <span className="badge badge-info">提交已移动</span>
                            : verdict === "fresh" ? <span className="badge badge-ok">分析未过期</span>
                              : item.artifactsReady === false ? null : <span className="badge badge-neutral">有分析结果</span>}
                        {isCurrent ? <span className="badge badge-neutral">当前</span> : null}
                      </span>
                    </button>
                      <MenuButton
                        label={`「${item.name}」的操作`}
                        open={menu?.id === item.repositoryId}
                        onToggle={(element) => setMenu(menu?.id === item.repositoryId ? null : { id: item.repositoryId, anchor: element })}
                        className="addr-menu"
                      />
                    </div>
                  );
                })}
              </div>
              <PopMenu anchor={menu?.anchor ?? null} items={menuItems} ariaLabel="仓库操作" onClose={() => setMenu(null)} />
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
