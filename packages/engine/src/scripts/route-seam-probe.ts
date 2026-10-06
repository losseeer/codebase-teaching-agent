import { resolve } from "node:path";
import type { RouteConsumer, RouteProvider } from "@codebase-tutor/shared";
import { indexRepository } from "../indexer/indexer.js";
import { matchRouteSeams, routeEndpointsOfFiles } from "../depgraph/routes.js";

/**
  跨语言接缝值不值做产品功能？先量再决定（这一整轮的前提）。
  用户手上的仓**都是单语言的**（dianping-backend 全 Java、dianping-frontend 全 Vue/TS、agent2 全 Python），
  所以「同一仓内前后端配对」这条路在真实语料里配不出东西，只有**跨仓配对**才有价值——
  而跨仓要给产品加的是全新的概念（哪个仓和哪个仓配、数据落在谁的 `.tutor`、缓存键怎么带仓对），
  这个决定得拿数去请用户拍板，不能凭感觉实现。

  用法：npx tsx src/scripts/route-seam-probe.ts <消费方仓（前端）> <提供方仓（后端）>
*/

const [consumerRootArg, providerRootArg] = process.argv.slice(2).filter((value) => !value.startsWith("-"));
if (!consumerRootArg || !providerRootArg) {
  console.log("用法：npx tsx src/scripts/route-seam-probe.ts <前端仓路径> <后端仓路径>");
  process.exit(1);
}
const consumerRoot = resolve(consumerRootArg);
const providerRoot = resolve(providerRootArg);

const endpointsOf = (root: string) => routeEndpointsOfFiles(root, indexRepository(root).files);
const consumerSide = endpointsOf(consumerRoot);
const providerSide = endpointsOf(providerRoot);

// 归一化与配对逻辑住在 depgraph/routes.ts（产品要用的那份实现），这里只做跨仓拼接与统计
const links = matchRouteSeams(providerSide.providers, consumerSide.consumers);
const shortKey = (list: RouteProvider | RouteConsumer): string => `${list.path}:${list.line}`;

const exact = links.filter((link) => link.via === "exact");
const suffix = links.filter((link) => link.via === "suffix");
const ambiguous = links.filter((link) => link.ambiguousWith > 1);
const matchedConsumers = new Set(links.map((link) => `${link.consumer.path}:${link.consumer.line}`));
const unmatched = consumerSide.consumers.filter((consumer) => !matchedConsumers.has(`${consumer.path}:${consumer.line}`));

console.log(`# 跨仓 HTTP 接缝可行性（零 token）`);
console.log(`- 消费方 ${consumerRoot}：路由字符串 ${consumerSide.consumers.length} 条（提供方 ${providerSide.providers.length} 条）`);
console.log(`- 配上：${links.length} 条边，覆盖 ${matchedConsumers.size}/${consumerSide.consumers.length} 条消费方字符串｜整段相等 ${exact.length}、后缀 ${suffix.length}`);
console.log(`- 歧义（一条消费方串配到多个提供方）：${ambiguous.length} 条，例：${ambiguous.slice(0, 3).map((link) => `${link.route}→${shortKey(link.provider)}`).join("、") || "—"}`);
console.log(`- 样例：${links.slice(0, 6).map((link) => `${link.consumer.raw}(${shortKey(link.consumer)})→${shortKey(link.provider)}[${link.via}]`).join("、") || "—"}`);
console.log(`- **配不上的消费方** ${unmatched.length} 条，例：${unmatched.slice(0, 10).map((consumer) => consumer.raw).join("、") || "—"}`);
console.log(`- 提供方里没被任何消费方用到的：${providerSide.providers.length - new Set(links.map((link) => shortKey(link.provider))).size} 条（正常，接口不一定被本前端调用）`);
