import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenHits } from "../text/lexical.js";

/**
  「计算机学科模块」的**工程证据表**（方案 A，2026-10-01）。

  问题背景：缺省的三个模块（计算机网络 / 操作系统 / 语言特性）是**学科分类名，不是仓库的原生结构**。
  主题翻译层（P1）做的是「支付 → pay/voucher/order」这种仓内别名映射，它拿不到
  「操作系统 → 线程池/锁/volatile」这层学科知识。于是真仓实测：中文模块名 + 关键词排序送进选择层的
  候选全是业务 controller，模型判「撑不起这个主题」而输出空数组（判空本身是对的），界面只剩规则归类。

  这张表补的就是那层学科知识：把「这个概念在真实工程里长什么样」写成可机检的锚点，
  **跨仓复用、进 git、零 LLM 调用**。两条证据来源：
  - 代码侧：文件名/类名/摘要里的标识符命中（`signatures` 强证据、`hints` 弱证据）；
  - 清单侧：`pom.xml` / `package.json` / `go.mod` 等依赖清单里出现这些库（依赖即主题指纹，最可靠）。

  为什么分强/弱两档：`stream` / `cache` / `error` 这类词在任何 Java 仓里满地都是，
  拿它们判「本仓有没有这个主题」会永远为真；只有 `CountDownLatch` / `lettuce-core` / `@interface`
  这种几乎不会偶然出现的才配当存在性判据。弱锚点只参与排序（方向正确但不足以证明）。
  */
export type DisciplineId = "network" | "os" | "lang";

export interface Discipline {
  id: DisciplineId;
  /** 表内规范名（与 GUI DEFAULT_MODULES 的 label 对齐） */
  label: string;
  /** 别名：用户自建模块常换个说法（并发编程 / 网络编程 / 类型系统…） */
  aliases: string[];
  /** 白话一句：这个主题在真实工程里的形态。进选择层提示词，也供界面 tooltip。 */
  brief: string;
  /** 强证据：几乎不会偶然出现的标识符 / 库名。决定「本仓有没有这个主题」。 */
  signatures: string[];
  /** 弱证据：常见但方向正确的词。只参与排序，不作为存在性判据。 */
  hints: string[];
}

export const DISCIPLINES: Discipline[] = [
  {
    id: "network",
    label: "计算机网络",
    aliases: ["网络", "网络编程", "计算机网络基础", "协议", "分布式调用"],
    brief: "一次请求如何进出这台机器：入站 HTTP 层（servlet / filter / 拦截器）、出站客户端（RestTemplate / WebClient / OkHttp / Feign）、Redis 与消息队列的协议客户端与连接池（Lettuce / Jedis / Redisson / Kafka / AMQP）、超时重试与幂等。",
    signatures: ["resttemplate", "webclient", "feign", "okhttp", "httpclient", "netty", "lettuce", "jedis", "redisson", "kafka", "rabbitmq", "amqp", "rocketmq", "elasticsearch", "opensearch", "hikari", "druid", "datasource", "servlet", "filter", "interceptor", "websocket", "eventsource", "sse", "grpc", "thrift", "cors", "keepalive", "keep-alive", "tomcat", "undertow", "jetty", "axios", "undici", "node-fetch", "socket", "dial", "http.server", "httptest", "reqwest", "hyper", "tonic", "gocql", "sarama"],
    hints: ["http", "https", "request", "response", "timeout", "retry", "header", "payload", "url", "uri", "route", "controller", "endpoint", "gateway", "proxy", "pool", "序列化", "反序列化", "超时", "重试", "幂等", "连接池", "请求头", "状态码", "网关", "限流"]
  },
  {
    id: "os",
    label: "操作系统",
    aliases: ["并发", "并发编程", "多线程", "线程", "io", "io模型", "调度"],
    brief: "进程内的并发与 IO 边界：线程池与执行器（ThreadPoolExecutor / ExecutorService / Scheduled）、锁与同步器（synchronized / ReentrantLock / CountDownLatch / Semaphore / *Atomic*）、阻塞队列、堆外与内存映射缓冲、文件与网络 IO 模型。",
    signatures: ["threadpoolexecutor", "executorservice", "scheduledexecutor", "newfixedthreadpool", "newcachedthreadpool", "reentrantlock", "reentrantreadwritelock", "readwritelock", "countdownlatch", "cyclicbarrier", "semaphore", "threadlocal", "atomicinteger", "atomiclong", "atomicreference", "atomicboolean", "longadder", "blockingqueue", "delayqueue", "disruptor", "jctools", "forkjoin", "completablefuture", "synchronized", "volatile", "notifyall", "availableprocessors", "new thread", "mappedbytebuffer", "directbytebuffer", "filechannel", "nio", "epoll", "goroutine", "waitgroup", "errgroup", "sync.mutex", "go func", "quartz", "xxl-job", "tokio", "async-std"],
    hints: ["thread", "concurren", "lock", "queue", "buffer", "cache", "memory", "heap", "stack", "scheduler", "timer", "stream", "io", "线程", "并发", "队列", "调度", "内存", "缓存", "阻塞", "唤醒"]
  },
  {
    id: "lang",
    label: "语言特性",
    aliases: ["类型系统", "泛型", "注解", "反射", "函数式", "错误处理", "异常"],
    brief: "这门语言怎么表达抽象：泛型与类型收窄（Result<T> / Optional）、注解与编译期处理（Lombok / MapStruct / 自定义 @interface）、动态代理与 AOP、函数式接口与 Stream/Collectors、异常体系与错误传播。",
    signatures: ["@interface", "interface {", "aspectj", "pointcut", "afterreturning", "invocationhandler", "proxy.newproxyinstance", "getdeclaredmethods", "lombok", "mapstruct", "projectreactor", "reactor-core", "rxjava", "vavr", "kotlinx", "zod", "pydantic", "functionalinterface", "consumer<", "supplier<", "predicate<", "function<", "collectors", "comparator.comparing", "optional<", "sealed", "enumset", "extends comparable", "implements serializable", "panic", "defer", "recover()", "unwrap", "trait", "yield"],
    hints: ["annotation", "aspect", "advice", "proxy", "reflection", "generic", "lambda", "stream", "closure", "delegate", "decorator", "type", "interface", "abstract", "enum", "struct", "union", "async", "await", "promise", "exception", "throwable", "error", "catch", "finally", "parse", "序列化", "泛型", "注解", "反射", "代理", "闭包", "函数式", "类型收窄", "异常", "错误处理", "回调"]
  }
];

const normalize = (text: string): string => text.trim().toLowerCase();

/**
  按模块名解析学科主题：先精确匹配规范名与别名，再退一步做「名字里含别名」的包含匹配
  （用户自建模块常叫「并发编程」「网络编程」）。业务主题（如「支付模块」）匹配不到就是 `undefined`
  ——它本来就不该走学科证据这条路。
  */
export function resolveDiscipline(moduleLabel: string, moduleHint = ""): Discipline | undefined {
  const label = normalize(moduleLabel);
  if (!label) return undefined;
  for (const discipline of DISCIPLINES) {
    if (normalize(discipline.label) === label || discipline.aliases.some((alias) => normalize(alias) === label)) return discipline;
  }
  for (const discipline of DISCIPLINES) {
    // 包含匹配只认 ≥3 字符的别名：2 字符（「io」「线程」）会偶然嵌进别的名字里
    if (discipline.aliases.some((alias) => alias.length >= 3 && label.includes(normalize(alias)))) return discipline;
    const hint = normalize(moduleHint);
    if (hint && discipline.aliases.some((alias) => alias.length >= 3 && hint.includes(normalize(alias)))) return discipline;
  }
  return undefined;
}

/** 文本里命中的锚点（去重、保持表内顺序）：用于排序加权，也用于「为什么推荐它」的可解释性。 */
export function anchorHits(anchors: string[], text: string): string[] {
  const haystack = text.toLowerCase();
  return anchors.filter((anchor) => tokenHits(anchor, haystack));
}

/** 强证据命中（签名锚点）：决定「本仓有没有这个主题」。 */
export const signatureHits = (discipline: Discipline, text: string): string[] => anchorHits(discipline.signatures, text);

/** 弱证据命中（泛化锚点）：只参与排序。 */
export const hintHits = (discipline: Discipline, text: string): string[] => anchorHits(discipline.hints, text);

/** 会被当依赖清单读的文件名（读到就读，不存在就跳过）。 */
const MANIFEST_FILES = ["pom.xml", "build.gradle", "build.gradle.kts", "package.json", "go.mod", "requirements.txt", "Cargo.toml", "composer.json"];

/**
  依赖清单证据：清单文本里出现的库名（强证据优先）。
  为什么值得单独读一次文件：依赖即主题指纹——`lettuce-core` 在 pom 里，这个仓就一定有 Redis 协议客户端，
  不需要模型猜，也不受「摘要里没写这个类名」影响。清单都是几 KB 的小文件，一次模块切换读几次无所谓。
  */
export function manifestEvidence(discipline: Discipline, repositoryPath: string): string[] {
  const hits = new Set<string>();
  for (const name of MANIFEST_FILES) {
    const file = join(repositoryPath, name);
    if (!existsSync(file)) continue;
    let text = "";
    try {
      text = readFileSync(file, "utf8").toLowerCase();
    } catch {
      continue; // 读不到就当没有这条证据：清单文件缺失或权限问题不该让推荐整条失败
    }
    for (const anchor of [...discipline.signatures, ...discipline.hints]) {
      const token = anchor.replace(/[(){}<>]/g, "");
      if (token.length >= 4 && text.includes(token)) hits.add(token);
    }
    if (hits.size) break; // 命中即止：一个仓的依赖声明通常只在一类清单里
  }
  return [...hits];
}
