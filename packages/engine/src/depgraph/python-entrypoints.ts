import type { SourceAnchor } from "@codebase-tutor/domain";

/**
 * Python 的入口证据写在框架约定里，文件名基本不带信息：FastAPI/Flask 的路由常拆在 api/、routers/ 下，
 * Django 的 URL 表在 urls.py，一个都不叫 main/server。
 * 规则表按证据强度排序，且一个文件只取最先命中的那条（与 Spring「启动类优先于 @Controller」同口径）：
 * 一个 main.py 挂着十几条路由装饰器，逐条标会把入口清单变成路由清单，
 * 同一个文件的十几个候选会挤满入口清单。
 * 误判比漏判更贵：只定义函数的库模块被标成入口后，画布会把工具模块当执行起点讲——
 * 所以这里只认框架级语句，不认「看着像在启动进程」的形态
 * （`runner.run(...)`、裸 `main()` 一律不算证据）。
 * 刻意没写的几条：`app.add_url_rule` 命令式登记、Sanic/Starlette/aiohttp 的构造形态、`re_path`/`include`
 * 的二级路由表——test-fixtures/pyframeworkdemo-repo 里没有对应样例，没有 fixture 就不写规则。
 */
export function detectPythonEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const rules: { pattern: RegExp; label: string }[] = [
    // 应用对象：文件里真的在构造服务实例，最强的启动证据
    { pattern: /^[ \t]*\w[\w.]*[ \t]*=[ \t]*(?:FastAPI|Flask)\s*\(/m, label: "HTTP 应用" },
    // Django 的路由表：每个请求都先过 urlpatterns，锚在表那一行而不是表里指向的某个视图
    { pattern: /^[ \t]*urlpatterns[ \t]*[=:]/m, label: "HTTP 路由表" },
    // 路由声明：挂在 app/router/蓝图对象上的 HTTP 动词装饰器。动词表按 Flask/FastAPI 的公开 API 收全——
    // 误报面是「某个库恰好也叫 `@x.get` 的模块级装饰器」，现实中用这批 HTTP 动词做装饰器的只有路由
    { pattern: /^[ \t]*@\w[\w.]*\.(?:route|get|post|put|patch|delete|head|options)[ \t(]/m, label: "HTTP 路由" },
    // 启动语句：app 在别的模块建、这个文件只负责把它跑起来（runner 那一类）。接收者只收 app 与 uvicorn 两个具名，
    // 不收 `\w+\.run(`——那会把 `self.runner.run()`、`db.run()` 这类普通调用全标成入口
    { pattern: /^[ \t]*(?:app\.run|uvicorn\.run)[ \t]*\(/m, label: "HTTP 服务启动" },
    // 脚本守卫：`python x.py` 真会跑起来的最朴素证据，普通脚本仓的入口全靠它
    { pattern: /^[ \t]*if[ \t]+__name__[ \t]+==[ \t]+["']__main__["'][ \t]*:/m, label: "脚本主入口" }
  ];
  const anchors: SourceAnchor[] = [];
  const taken = new Set<string>();
  const pythonFiles = [...contents].filter(([path]) => path.endsWith(".py"));
  // 外层按规则、内层按文件：证据强的先挑走文件，入口清单自然排在前面
  // （默认入口取 entrypoints[0]，所以排序不是外观问题——app 对象排在脚本守卫前面，默认入口才是那个真的服务）
  for (const rule of rules) {
    for (const [path, content] of pythonFiles) {
      if (taken.has(path)) continue;
      const match = content.match(rule.pattern);
      if (!match) continue;
      taken.add(path);
      const framework = pythonFrameworkOf(content);
      anchors.push({
        path,
        line: content.slice(0, match.index ?? 0).split("\n").length,
        label: framework ? `${rule.label} (${framework})` : rule.label
      });
    }
  }
  return anchors;
}

/**
 * 框架名只认行首的 import：装饰器分不出框架（`@x.route` 是 Flask 还是 Sanic 都可能），
 * 而 `\b` 同时挡掉 `flaskshop`、`fastapiapp` 这类同前缀的仓内包名。
 * 认不出就不带框架名——标签宁可少说，别说错。
 */
const pythonFrameworkNames = new Map([["flask", "Flask"], ["fastapi", "FastAPI"], ["django", "Django"]]);
const pythonFrameworkPattern = /^[ \t]*(?:from|import)\s+(flask|fastapi|django)\b/m;
const pythonFrameworkOf = (content: string): string | undefined => pythonFrameworkNames.get(pythonFrameworkPattern.exec(content)?.[1] ?? "");
