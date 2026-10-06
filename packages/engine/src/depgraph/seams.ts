import type { FileEntry, RouteConsumer, RouteProvider, SeamDirection, SeamReport } from "@codebase-tutor/shared";
import { matchRouteSeams, routeEndpointsOfFiles } from "./routes.js";

/**
  跨仓 HTTP 接缝的读侧：把两个仓的「路由清单」配成边。

  为什么是**跨仓**而不是同仓：用户手上的语料每仓都是单语言的（后端全 Java、前端全 Vue），
  同仓配对在真实数据上配不出任何东西；而这条链的价值恰恰是「点这个按钮之后代码在哪」。
  实测可行性（`pnpm tsx src/scripts/route-seam-probe.ts` 跑 dianping 前端×后端）：14 条调用串里
  12 条配上控制器，全部整段相等、0 条歧义。

  两条刻意的取舍：
  - **不落库、不进任何缓存键**：清单是读文件现算 + 内存 memo（键含 `versionStamp`，内容一变自然翻）。
    所以已导入的仓当场就能用，不需要重新导入，也不会有摘要/流程重烧——这条功能是纯加分项，
    一旦哪天要把它变成流程证据的一部分（进 digest），就得先算重烧的账。
  - **按需算，不预先全量**：算一次要读两个仓的源码文件（dianping 前端+后端约 350 个文件，纯 CPU 几十毫秒），
    只在用户显式选了「相关仓」时才算；界面无需第二个加载态，因为它挂在架构视图的一次性动作里。
*/

export interface SeamRepository {
  repositoryId: string;
  path: string;
  files: FileEntry[];
  /** 分析产物的内容戳：清单 memo 的键之一，仓库一变就自然失效 */
  versionStamp: string;
}

const memo = new Map<string, { providers: RouteProvider[]; consumers: RouteConsumer[] }>();
const MEMO_MAX = 8;

function endpointsOf(repository: SeamRepository): { providers: RouteProvider[]; consumers: RouteConsumer[] } {
  const key = `${repository.repositoryId}:${repository.versionStamp}`;
  const hit = memo.get(key);
  if (hit) {
    // 命中即续期：Map 的迭代序就是新近序，先删再放等于把这条推到最新
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const endpoints = routeEndpointsOfFiles(repository.path, repository.files);
  memo.set(key, endpoints);
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
  return endpoints;
}

function directionOf(consumers: RouteConsumer[], providers: RouteProvider[]): SeamDirection {
  const links = matchRouteSeams(providers, consumers);
  const matchedKeys = new Set(links.map((link) => `${link.consumer.path}:${link.consumer.line}`));
  const ambiguousKeys = new Set(links.filter((link) => link.ambiguousWith > 1).map((link) => `${link.consumer.path}:${link.consumer.line}`));
  return { links, scanned: consumers.length, matched: matchedKeys.size, ambiguous: ambiguousKeys.size };
}

/** 双向：本仓调相关仓（outbound）与相关仓调本仓（inbound）。两个方向的学习者问题不同，界面分开列。 */
export function seamReportFor(repository: SeamRepository, other: SeamRepository): SeamReport {
  const mine = endpointsOf(repository);
  const theirs = endpointsOf(other);
  return {
    repositoryId: repository.repositoryId,
    otherRepositoryId: other.repositoryId,
    outbound: directionOf(mine.consumers, theirs.providers),
    inbound: directionOf(theirs.consumers, mine.providers)
  };
}

/** 测试隔离用：清单 memo 是进程级缓存。 */
export function clearSeamMemo(): void {
  memo.clear();
}
