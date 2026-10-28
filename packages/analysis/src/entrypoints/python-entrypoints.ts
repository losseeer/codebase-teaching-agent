import type { SourceAnchor } from "@codebase-tutor/domain";

/** Python 框架入口识别：按证据强度排规则，每个文件只取最先命中的一条。 */
export function detectPythonEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const rules: { pattern: RegExp; label: string }[] = [
    // 构造服务实例，启动证据最强
    { pattern: /^[ \t]*\w[\w.]*[ \t]*=[ \t]*(?:FastAPI|Flask)\s*\(/m, label: "HTTP 应用" },
    // Django 路由表：锚在 urlpatterns 那一行，不锚视图
    { pattern: /^[ \t]*urlpatterns[ \t]*[=:]/m, label: "HTTP 路由表" },
    // 路由声明：挂在 app/router/蓝图上的装饰器，动词按 Flask/FastAPI 公开 API 收全
    { pattern: /^[ \t]*@\w[\w.]*\.(?:route|get|post|put|patch|delete|head|options)[ \t(]/m, label: "HTTP 路由" },
    // 启动语句：接收者只认 app 与 uvicorn
    { pattern: /^[ \t]*(?:app\.run|uvicorn\.run)[ \t]*\(/m, label: "HTTP 服务启动" },
    // 脚本守卫：直接执行脚本时的主入口
    { pattern: /^[ \t]*if[ \t]+__name__[ \t]+==[ \t]+["']__main__["'][ \t]*:/m, label: "脚本主入口" }
  ];
  const anchors: SourceAnchor[] = [];
  const taken = new Set<string>();
  const pythonFiles = [...contents].filter(([path]) => path.endsWith(".py"));
    // 规则在外、文件在内：强证据先挑走文件，排序决定默认入口
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

/** 框架名只认行首 import；`\b` 挡掉 flaskshop 这类同前缀的仓内包名。 */
const pythonFrameworkNames = new Map([["flask", "Flask"], ["fastapi", "FastAPI"], ["django", "Django"]]);
const pythonFrameworkPattern = /^[ \t]*(?:from|import)\s+(flask|fastapi|django)\b/m;
const pythonFrameworkOf = (content: string): string | undefined => pythonFrameworkNames.get(pythonFrameworkPattern.exec(content)?.[1] ?? "");

