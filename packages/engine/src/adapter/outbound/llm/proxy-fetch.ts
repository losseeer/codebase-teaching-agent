/** 出站 fetch：按 HTTPS_PROXY / HTTP_PROXY 走代理，NO_PROXY 命中则直连。 */
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";

/** 返回适用于该地址的代理串；不该走代理（或没配）返回 undefined。 */
export function proxyFor(target: string): string | undefined {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return undefined;
  let host = "";
  try {
    host = new URL(target).hostname;
  } catch {
    return undefined;
  }
  const rules = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const bypass = rules.some((rule) => rule === "*" || host === rule || host.endsWith(`.${rule}`) || host.endsWith(rule));
  return bypass ? undefined : raw;
}

/** 每次都新建 ProxyAgent 会漏连接池：按代理地址复用。 */
const agents = new Map<string, ProxyAgent>();

/** 包一层 fetch；没有代理时返回 undefined，调用方回落全局 fetch。 */
export function proxyFetchFor(target: string): typeof fetch | undefined {
  // 测试用注入的 fetchImpl 打桩，别把真实网络与代理带进来
  if (process.env.VITEST) return undefined;
  const proxy = proxyFor(target);
  if (!proxy) return undefined;
  let dispatcher = agents.get(proxy);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxy);
    agents.set(proxy, dispatcher);
  }
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as string, { ...(init as UndiciInit), dispatcher })) as typeof fetch;
}
