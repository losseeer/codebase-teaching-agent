/**
  外部包名 → 类别的确定性词典（图上「系统边界之外」那一栏的唯一判据）。

  三条纪律：
  1. 不许模型参与分类。层名可以让模型判（断言类判断，可错、有人工修正通道）；
     「这个仓连了 Redis」是事实类判断，交给模型就等于让图上的箭头变成编造。
  2. 命中不了的一律 `other`，不按名字里的字眼猜。`org.springframework.web.bind` 里有 `web`，
     它是入站注解不是 HTTP 客户端；`cn.hutool.db` 真的是数据库工具，但 `cn.hutool` 不是——
     靠词根猜两头都会错，所以只按逐项列出的前缀判。
  3. 词典只覆盖真实遇到的包（`pnpm arch:externals` 可复算）。漏一个包只是让它进 `other`（界面折叠起来），
     错一个包会让边界栏指着一个不存在的服务。

  `other` 不等于「外部服务」，它的意思是「词典不认识」：真的三方小库和仓内解析不到的自有包都会落在这里
  （Python 的导入根不在仓根时就会发生）。界面要说「未识别」，不能说「外部依赖」。
*/

/** 档名的类型与中文标签都在 shared（线上形状与界面文案的唯一来源），这里只转发一次。 */
import { EXTERNAL_CATEGORY_LABEL, type ExternalCategory } from "@codebase-tutor/domain";

export { EXTERNAL_CATEGORY_LABEL, type ExternalCategory };

export interface ExternalClass {
  category: ExternalCategory;
  /** 界面上显示的那个名字（命中词典时是条目的名字，没命中时就是原身份）。 */
  display: string;
  /** 命中的词典键；`undefined` 表示没命中，进 `other`。诊断脚本与悬停「依据」靠它说清是哪条规则判的。 */
  matched?: string;
}

/**
  前缀词典：键是按点/斜杠切开的包名前缀，匹配取「段数最长的那条」，
  这样 `org.springframework.data.redis`（缓存）能盖过 `org.springframework`（框架）。
  只放真实遇到的包，见文件头第 3 条。
*/
export const EXTERNAL_CATALOG: Record<string, { category: ExternalCategory; display: string }> = {
  // —— 存储与缓存（Java 侧大多经 Spring Data / 官方客户端出来）——
  "org.springframework.data.redis": { category: "cache", display: "Redis（spring-data-redis）" },
  "org.springframework.data.elasticsearch": { category: "database", display: "Elasticsearch" },
  "org.springframework.jdbc": { category: "database", display: "Spring JDBC" },
  "org.springframework.data": { category: "database", display: "Spring Data" },
  "com.baomidou.mybatisplus": { category: "database", display: "MyBatis-Plus" },
  "org.mybatis": { category: "database", display: "MyBatis" },
  "org.apache.ibatis": { category: "database", display: "MyBatis" },
  "com.zaxxer.hikari": { category: "database", display: "HikariCP（连接池）" },
  "org.redisson": { category: "cache", display: "Redisson（Redis 客户端）" },
  "com.github.benmanes.caffeine": { category: "cache", display: "Caffeine（进程内缓存）" },
  "org.elasticsearch": { category: "database", display: "Elasticsearch" },
  "redis": { category: "cache", display: "redis-py" },
  "ioredis": { category: "cache", display: "ioredis" },
  "better-sqlite3": { category: "database", display: "SQLite（better-sqlite3）" },
  "sqlite3": { category: "database", display: "SQLite（sqlite3）" },
  // —— 队列与消息 ——
  "org.springframework.kafka": { category: "queue", display: "Kafka（spring-kafka）" },
  "org.springframework.amqp": { category: "queue", display: "RabbitMQ" },
  "org.apache.kafka": { category: "queue", display: "Kafka 客户端" },
  "com.rabbitmq": { category: "queue", display: "RabbitMQ" },
  "kafka": { category: "queue", display: "kafka" },
  "celery": { category: "queue", display: "Celery" },
  // —— 模型服务（本仓群没有 SDK 形态的调用，键留着给下一个仓；只按整名命中）——
  "openai": { category: "model", display: "OpenAI SDK" },
  "langchain": { category: "model", display: "LangChain" },
  "langgraph": { category: "model", display: "LangGraph" },
  // —— 出站的 HTTP 客户端：只收「它就是用来打别人接口」的包 ——
  "axios": { category: "http-client", display: "axios" },
  "requests": { category: "http-client", display: "requests" },
  "httpx": { category: "http-client", display: "httpx" },
  "okhttp3": { category: "http-client", display: "OkHttp" },
  // —— 框架与工具库（不是「服务」，但确实站在系统边界之外）——
  "org.springframework": { category: "framework", display: "Spring" },
  "org.aspectj": { category: "framework", display: "AspectJ" },
  "com.fasterxml.jackson": { category: "framework", display: "Jackson（JSON）" },
  "org.slf4j": { category: "framework", display: "SLF4J（日志门面）" },
  "io.micrometer": { category: "framework", display: "Micrometer（指标）" },
  "lombok": { category: "framework", display: "Lombok" },
  "cn.hutool": { category: "framework", display: "Hutool（工具库）" },
  "javax.servlet": { category: "framework", display: "Servlet API" },
  "jakarta.servlet": { category: "framework", display: "Servlet API（jakarta）" },
  "javax.annotation": { category: "framework", display: "公共注解（javax.annotation）" },
  "flask": { category: "framework", display: "Flask" },
  "markupsafe": { category: "framework", display: "MarkupSafe" },
  "uvicorn": { category: "framework", display: "Uvicorn" },
  "werkzeug": { category: "framework", display: "Werkzeug" },
  "jinja2": { category: "framework", display: "Jinja2" },
  "click": { category: "framework", display: "Click" },
  "django": { category: "framework", display: "Django" },
  "fastapi": { category: "framework", display: "FastAPI" },
  "fastify": { category: "framework", display: "Fastify" },
  "@fastify": { category: "framework", display: "Fastify 插件" },
  "vue": { category: "framework", display: "Vue" },
  "vue-router": { category: "framework", display: "Vue Router" },
  "pinia": { category: "framework", display: "Pinia" },
  "element-plus": { category: "framework", display: "Element Plus" },
  "@element-plus": { category: "framework", display: "Element Plus 图标" },
  "react": { category: "framework", display: "React" },
  "react-dom": { category: "framework", display: "React DOM" },
  "react-router-dom": { category: "framework", display: "React Router" },
  "react-markdown": { category: "framework", display: "react-markdown" },
  "remark-gfm": { category: "framework", display: "remark-gfm" },
  "web-tree-sitter": { category: "framework", display: "tree-sitter（WASM 语法解析）" },
  "typescript": { category: "framework", display: "TypeScript 编译器" },
  "dayjs": { category: "framework", display: "Day.js" },
  "tailwindcss": { category: "framework", display: "Tailwind CSS" },
  "vite": { category: "framework", display: "Vite" },
  "@vitejs": { category: "framework", display: "Vite 插件" },
  // —— 测试框架 ——
  "org.junit": { category: "testing", display: "JUnit" },
  "org.mockito": { category: "testing", display: "Mockito" },
  "org.springframework.test": { category: "testing", display: "Spring 测试支持" },
  "pytest": { category: "testing", display: "pytest" },
  "_pytest": { category: "testing", display: "pytest 内部" },
  "vitest": { category: "testing", display: "Vitest" },
  "net.jqwik": { category: "testing", display: "jqwik（属性测试）" },
  "@playwright": { category: "testing", display: "Playwright" },
  "jest": { category: "testing", display: "Jest" }
};

/**
  标准库不逐包列（列不完，也不该列），按形状判：
  - Java/JVM：`java.*` / `javax.*` / `jdk.*` 里 JDK 自带的那些。`javax.servlet` 不是 JDK 自带、是容器给的，
    所以词典先判、形状规则只在词典没命中时兜底，顺序反过来会把容器 API 说成语言自带；
  - Node：`node:` 前缀，以及不带前缀的内置模块名；
  - Python / Go：一份已知的标准库名单，名单外的仍进 `other`，不假装认识。
*/
const NODE_BUILTINS = new Set(["path", "fs", "os", "url", "util", "crypto", "events", "module", "child_process", "sqlite", "http", "https", "zlib", "stream", "buffer", "assert"]);
const PYTHON_STDLIB = new Set([
  "__future__", "abc", "argparse", "asyncio", "base64", "bz2", "calendar", "codecs", "collections", "contextlib", "copy", "csv", "dataclasses",
  "datetime", "enum", "functools", "glob", "hashlib", "heapq", "html", "http", "importlib", "inspect", "io", "json",
  "logging", "math", "operator", "os", "pathlib", "pickle", "pprint", "random", "re", "shutil", "signal", "socket", "ssl", "string", "subprocess",
  "sys", "tempfile", "threading", "time", "tkinter", "traceback", "types", "typing", "unittest", "urllib", "uuid", "warnings", "weakref", "optparse", "py_compile"
]);
/** Go 标准库只有单层包名（`fmt`、`strings`、`net`…），身份的第一段就够判。 */
const GO_STDLIB = new Set(["bytes", "context", "crypto", "encoding", "errors", "fmt", "io", "log", "math", "net", "os", "path", "regexp", "runtime", "sort", "strconv", "strings", "sync", "testing", "time", "unicode", "atomic"]);

/** 词典按段数倒序排一次（建表一次、每次调用省一遍比较）；「取最长命中」在 classifyExternal 里按段数判。 */
const catalogEntries = Object.entries(EXTERNAL_CATALOG).sort((left, right) => segmentsOf(right[0]).length - segmentsOf(left[0]).length);

/** 词典键与身份都按各自的形状切段（Go 用斜杠、其余用点），切完只比段，不做字符串前缀粘连。 */
function segmentsOf(name: string): string[] {
  return name.split(name.includes("/") ? "/" : ".").filter(Boolean);
}

/**
  一个包名身份 → 类别。纯函数、无模型、可复算。
  先查词典（命中段数最多的那条前缀），查不到再按标准库形状判，都不中就 `other`。
  比段不比字符串是为了挡住「`fastify` 命中 `fastify-plugin`」这一类粘连。
*/
export function classifyExternal(identity: string): ExternalClass {
  const segments = segmentsOf(identity);
  let best: { prefix: string; entry: (typeof EXTERNAL_CATALOG)[string]; depth: number } | undefined;
  for (const [prefix, entry] of catalogEntries) {
    const parts = segmentsOf(prefix);
    if (parts.length > segments.length) continue;
    if (!parts.every((part, index) => part === segments[index])) continue;
    if (!best || parts.length > best.depth) best = { prefix, entry, depth: parts.length };
  }
  if (best) return { category: best.entry.category, display: best.entry.display, matched: best.prefix };
  const head = segments[0] ?? identity;
  if (head === "java" || head === "javax" || head === "jdk") return { category: "stdlib", display: "JDK 标准库" };
  if (identity.startsWith("node:") || NODE_BUILTINS.has(identity)) return { category: "stdlib", display: "Node 内置模块" };
  // Go 的标准库就是单层包名（`fmt`、`net/http`），没有域名前缀；带点的身份（github.com/…）一定不是标准库
  if (!identity.includes(".") && GO_STDLIB.has(head)) return { category: "stdlib", display: "Go 标准库" };
  if (PYTHON_STDLIB.has(head)) return { category: "stdlib", display: "Python 标准库" };
  return { category: "other", display: identity };
}

/** 一栏里的一行：一个被认出来的东西（或一个没认出来的名字），加上碰到它的文件。 */
export interface ExternalGroup {
  category: ExternalCategory;
  display: string;
  /** 命中的词典键；`other` 档没有。 */
  matched?: string;
  /** 归到这一行的包名身份（`lombok.Data` 与 `lombok.extern.slf4j.Slf4j` 会并成一行，这里留全名当依据）。 */
  identities: string[];
  /** 哪些文件 import 了它：界面上「用到它的文件数」就是这个数组的长度，也是悬停「依据」。 */
  files: string[];
}

/**
  文件 → 外部包名的原始表，聚成边界栏要的那些行。合在这里而不是界面或路由各写一遍：
  `lombok.Data` / `lombok.experimental.Accessors` 是同一个 Lombok，分开列会把一栏挤满。
  排序：先按类别（存储/缓存/队列/模型/接口在前，框架/测试/语言自带居中，未识别垫底），类内按文件数倒序。
*/
export function groupExternals(externals: Record<string, string[]>): ExternalGroup[] {
  const order: ExternalCategory[] = ["database", "cache", "queue", "model", "http-client", "framework", "testing", "stdlib", "other"];
  const byKey = new Map<string, ExternalGroup>();
  for (const [file, identities] of Object.entries(externals)) {
    for (const identity of identities) {
      const info = classifyExternal(identity);
      /**
        行按读者看到的那个名字合，不按词典键合：两条词典键可以有同一个显示名（`org.apache.ibatis.annotations`
        与 `org.mybatis.spring.annotation` 都叫 MyBatis），按键合会在边界栏里长出两枚一模一样的 chip。
        `other` 不能合——没认出名字就不知道它们是不是同一个东西，仍然一个名字一行。
      */
      const key = info.category === "other" ? `other:${identity}` : `${info.category}|${info.display}`;
      const current = byKey.get(key);
      if (current) {
        if (!current.identities.includes(identity)) current.identities.push(identity);
        if (!current.files.includes(file)) current.files.push(file);
        continue;
      }
      byKey.set(key, { category: info.category, display: info.display, ...(info.matched ? { matched: info.matched } : {}), identities: [identity], files: [file] });
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const byCategory = order.indexOf(left.category) - order.indexOf(right.category);
    return byCategory !== 0 ? byCategory : right.files.length - left.files.length || left.display.localeCompare(right.display);
  });
}

/** 边界栏只画「站在系统之外的东西」：`stdlib` 与 `other` 默认不进图（前者不是服务，后者不认识）。 */
export const isBoundaryMember = (category: ExternalCategory): boolean => category !== "stdlib" && category !== "other";
