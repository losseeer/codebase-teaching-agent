/**
  外部包名到类别的确定性词典，无模型参与、可复算。
  只按逐项列出的前缀命中，未命中的一律 `other`，不按词根猜。
  `other` 表示词典未识别，不等于外部服务。
*/

/** 档名类型与标签来自 domain，这里转发一次。 */
import { EXTERNAL_CATEGORY_LABEL, type ExternalCategory } from "@codebase-tutor/domain";

export { EXTERNAL_CATEGORY_LABEL, type ExternalCategory };

export interface ExternalClass {
  category: ExternalCategory;
  /** 显示名：命中词典时为条目名，未命中时为原身份。 */
  display: string;
  /** 命中的词典键；未命中为 `undefined`。 */
  matched?: string;
}

/**
  前缀词典：匹配取段数最长的那条，`org.springframework.data.redis` 盖过 `org.springframework`。
  只放真实遇到的包。
*/
export const EXTERNAL_CATALOG: Record<string, { category: ExternalCategory; display: string }> = {
  // —— 存储与缓存 ——
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
  // —— 模型服务 ——
  "openai": { category: "model", display: "OpenAI SDK" },
  "langchain": { category: "model", display: "LangChain" },
  "langgraph": { category: "model", display: "LangGraph" },
  // —— 出站 HTTP 客户端 ——
  "axios": { category: "http-client", display: "axios" },
  "requests": { category: "http-client", display: "requests" },
  "httpx": { category: "http-client", display: "httpx" },
  "okhttp3": { category: "http-client", display: "OkHttp" },
  // —— 框架与工具库 ——
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
  标准库按形状判，不逐包列。
  Java/JVM 看 `java.*`、`javax.*`、`jdk.*`，Node 看 `node:` 前缀与内置名，Python/Go 用已知名单。
  词典优先于形状规则：`javax.servlet` 由容器提供，不是语言自带。
*/
const NODE_BUILTINS = new Set(["path", "fs", "os", "url", "util", "crypto", "events", "module", "child_process", "sqlite", "http", "https", "zlib", "stream", "buffer", "assert"]);
const PYTHON_STDLIB = new Set([
  "__future__", "abc", "argparse", "asyncio", "base64", "bz2", "calendar", "codecs", "collections", "contextlib", "copy", "csv", "dataclasses",
  "datetime", "enum", "functools", "glob", "hashlib", "heapq", "html", "http", "importlib", "inspect", "io", "json",
  "logging", "math", "operator", "os", "pathlib", "pickle", "pprint", "random", "re", "shutil", "signal", "socket", "ssl", "string", "subprocess",
  "sys", "tempfile", "threading", "time", "tkinter", "traceback", "types", "typing", "unittest", "urllib", "uuid", "warnings", "weakref", "optparse", "py_compile"
]);
/** Go 标准库是单层包名，按身份第一段判。 */
const GO_STDLIB = new Set(["bytes", "context", "crypto", "encoding", "errors", "fmt", "io", "log", "math", "net", "os", "path", "regexp", "runtime", "sort", "strconv", "strings", "sync", "testing", "time", "unicode", "atomic"]);

/** 词典按段数倒序排一次；最长命中在 classifyExternal 里判。 */
const catalogEntries = Object.entries(EXTERNAL_CATALOG).sort((left, right) => segmentsOf(right[0]).length - segmentsOf(left[0]).length);

/** 按键自身形状切段：Go 用斜杠，其余用点。 */
function segmentsOf(name: string): string[] {
  return name.split(name.includes("/") ? "/" : ".").filter(Boolean);
}

/** 包名身份到类别，纯函数、无模型参与：最长词典命中 → 标准库形状 → `other`。 */
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
  // Go 标准库为单层包名，带点的身份不是标准库
  if (!identity.includes(".") && GO_STDLIB.has(head)) return { category: "stdlib", display: "Go 标准库" };
  if (PYTHON_STDLIB.has(head)) return { category: "stdlib", display: "Python 标准库" };
  return { category: "other", display: identity };
}

/** 边界栏的一行：一个外部身份及其出现文件。 */
export interface ExternalGroup {
  category: ExternalCategory;
  display: string;
  /** 命中的词典键；`other` 档没有。 */
  matched?: string;
  /** 归到这一行的包名身份全名。 */
  identities: string[];
  /** 引用该身份的文件。 */
  files: string[];
}

/** 外部包名表聚成边界栏的行，按显示名合行，先类别后文件数排序。 */
export function groupExternals(externals: Record<string, string[]>): ExternalGroup[] {
  const order: ExternalCategory[] = ["database", "cache", "queue", "model", "http-client", "framework", "testing", "stdlib", "other"];
  const byKey = new Map<string, ExternalGroup>();
  for (const [file, identities] of Object.entries(externals)) {
    for (const identity of identities) {
      const info = classifyExternal(identity);
      // 行按显示名合：两条词典键可能有同一显示名
      // `other` 按身份各自成行
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


