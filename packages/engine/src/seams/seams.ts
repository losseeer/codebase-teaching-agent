import type { FileEntry, RouteConsumer, RouteProvider, SeamDirection, SeamReport } from "@codebase-tutor/domain";

import type { LlmTool } from "../application/port/llm-provider.js";
import { matchRouteSeams, routeEndpointsOfFiles } from "@codebase-tutor/analysis";

/**
  跨仓 HTTP 接缝的读侧：把两个仓的路由清单配成边。
  只做跨仓；不落库、不进缓存键，进程内 memo 的键含 `versionStamp`。
*/

export interface SeamRepository {
  repositoryId: string;
  path: string;
  files: FileEntry[];
  /** 分析产物的内容戳；清单 memo 的键之一。 */
  versionStamp: string;
}

const memo = new Map<string, { providers: RouteProvider[]; consumers: RouteConsumer[] }>();
const MEMO_MAX = 8;

function endpointsOf(repository: SeamRepository): { providers: RouteProvider[]; consumers: RouteConsumer[] } {
  const key = `${repository.repositoryId}:${repository.versionStamp}`;
  const hit = memo.get(key);
  if (hit) {
    // Map 的迭代序就是插入序：先删再放等于把这条推到最新。
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

/** 两个方向各配一次：本仓调对端（outbound）与对端调本仓（inbound）。 */
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

/** 清单 memo 是进程级缓存，测试之间需要清空。 */
export function clearSeamMemo(): void {
  memo.clear();
}

/** 一次清单最多回给模型的接缝行数。 */
const MODEL_ROWS = 12;

/** 把配对结果压成给模型看的清单；每行都带「文件:行」。 */
export function formatSeamReport(otherName: string, report: SeamReport, filter = ""): string {
  const needle = filter.trim().toLowerCase();
  const rows = (direction: SeamReport["outbound"], caption: string): string => {
    const hits = direction.links.filter((link) => !needle || `${link.route} ${link.consumer.path} ${link.provider.path}`.toLowerCase().includes(needle));
    if (!hits.length) return `${caption}：没有${needle ? "匹配该片段的" : ""}配对（这一侧读到 ${direction.scanned} 条地址）。`;
    const body = hits.slice(0, MODEL_ROWS).map((link) => `- ${link.route} → ${link.provider.path}:${link.provider.line}｜发起方 ${link.consumer.path}:${link.consumer.line}${link.via === "suffix" ? "（按后缀配上，对端可能有网关前缀）" : ""}${link.ambiguousWith > 1 ? `（这条串在对端有 ${link.ambiguousWith} 个落点，需自行确认）` : ""}`);
    const rest = hits.length > MODEL_ROWS ? `\n（另有 ${hits.length - MODEL_ROWS} 条未列，可用 filter 缩小范围）` : "";
    return `${caption}：配上 ${direction.matched} 处\n${body.join("\n")}${rest}`;
  };
  return [
    `与仓「${otherName}」的 HTTP 接缝（按归一化 URL 实时计算，不消耗 token）：`,
    rows(report.outbound, `本仓调用「${otherName}」`),
    rows(report.inbound, `「${otherName}」调用本仓`)
  ].join("\n");
}

/** `cross_repo_link` 的工具定义。 */
export const CROSS_REPO_LINK_TOOL: LlmTool = {
  name: "cross_repo_link",
  description: "查询当前仓库与另一个仓库之间按 URL 配好的 HTTP 接缝：本仓调用的地址落在对端哪个文件哪一行，以及对端提供了哪些地址被本仓调用。回答跨仓「这个请求打到哪里去」时先调用它拿准确落点，不要靠猜 URL 字符串。",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "对端仓库名" },
      filter: { type: "string", description: "只看包含该片段（路径或 URL 片段）的接缝，可选" }
    },
    required: ["repo"]
  }
};
