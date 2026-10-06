import { useEffect, useMemo, useState, type ReactElement } from "react";
import { api } from "../api/client";
import type { RepositoryCatalogEntry, RouteLink, SeamDirection, SeamReport } from "@codebase-tutor/shared";

/**
 * 跨仓 HTTP 接缝面板（架构视图下方）。存在的理由：前后端在用户手上是两个仓，
 * 「点了按钮之后代码落在哪一行」这条链在任何一个仓的依赖图里都不存在——两边唯一的共享标识符是路由字符串。
 *
 * 三条与界面有关的口径：
 * - 两个方向分开列（本仓调它 / 它调本仓），合成一个数会误导；
 * - `via="suffix"`（靠网关前缀整段后缀配上的）单独标出来，它的证据强度低于整段相等；
 * - 配不上也要说清是「对方仓没有可认的路由」还是「有但没配上」，否则用户只会看到一片空白。
 */

function LinkRow({ link, otherLabel }: { link: RouteLink; otherLabel: string }): ReactElement {
  const consumer = link.consumer;
  const provider = link.provider;
  return (
    <li className="seam-row" title={link.ambiguousWith > 1 ? `这条串同时配到 ${link.ambiguousWith} 个落点，逐条列出` : undefined}>
      <code>{consumer.raw}</code>
      <span className="seam-via">{link.via === "exact" ? "整段相等" : "后缀匹配"}</span>
      <span className="seam-end">{otherLabel} · {provider.path}:{provider.line}</span>
    </li>
  );
}

function Direction({ title, links, direction, otherLabel }: { title: string; links: RouteLink[]; direction: SeamDirection; otherLabel: string }): ReactElement | null {
  if (!direction.scanned) return null;
  return (
    <div className="seam-group">
      <h4>{title} <span className="muted">{direction.matched}/{direction.scanned} 配上{direction.ambiguous ? `｜${direction.ambiguous} 条有多落点` : ""}</span></h4>
      {links.length
        ? <ul>{links.slice(0, 20).map((link, index) => <LinkRow key={`${link.consumer.path}:${link.consumer.line}:${link.provider.path}:${index}`} link={link} otherLabel={otherLabel} />)}</ul>
        : <p className="muted">一条也没配上：这一侧有 {direction.scanned} 条可读的地址，但两边字符串没有交集——常见原因是地址拼在变量里、走过配置文件，或两个仓本来就没有调用关系。</p>}
    </div>
  );
}

export function SeamPanel({ repositoryId }: { repositoryId: string }): ReactElement | null {
  const [repositories, setRepositories] = useState<RepositoryCatalogEntry[]>([]);
  const [otherId, setOtherId] = useState("");
  const [report, setReport] = useState<SeamReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.listRepositories().then((body) => {
      if (!cancelled) setRepositories(body.repositories.filter((item) => item.repositoryId !== repositoryId && item.exists));
    }).catch(() => { /* 列不出地址簿就不显示面板，不打扰用户 */ });
    return () => { cancelled = true; };
  }, [repositoryId]);

  useEffect(() => { setReport(null); setError(null); }, [repositoryId]);

  const others = useMemo(() => repositories.filter((item) => item.repositoryId !== repositoryId), [repositories, repositoryId]);
  if (!others.length) return null;
  const otherLabel = others.find((item) => item.repositoryId === otherId)?.name ?? "相关仓";

  const load = async (): Promise<void> => {
    if (!otherId) return;
    setLoading(true);
    setError(null);
    try {
      setReport(await api.getSeams(repositoryId, otherId));
    } catch (reason) {
      setReport(null);
      setError(reason instanceof Error ? reason.message : "配对失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="seam-panel">
      <div className="seam-head">
        <h3>跨仓接口（HTTP 接缝）</h3>
        <label>
          与哪个仓配对
          <select value={otherId} onChange={(event) => setOtherId(event.target.value)}>
            <option value="">选择仓库…</option>
            {others.map((item) => <option key={item.repositoryId} value={item.repositoryId}>{item.name}</option>)}
          </select>
        </label>
        <button type="button" disabled={!otherId || loading} onClick={() => void load()}>{loading ? "配对中…" : "看这条链"}</button>
      </div>
      <p className="muted">两边不共享任何代码依赖，只共享 URL 字符串；这里按归一化后的路由把两端连起来（不花模型 token）。</p>
      {error ? <p className="seam-error">{error}</p> : null}
      {report ? (
        <>
          <Direction title="本仓调用它" links={report.outbound.links} direction={report.outbound} otherLabel={otherLabel} />
          <Direction title="它调用本仓" links={report.inbound.links} direction={report.inbound} otherLabel={otherLabel} />
        </>
      ) : null}
    </section>
  );
}
