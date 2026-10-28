import type { SourceAnchor } from "@codebase-tutor/domain";

/** Java/Spring 入口：启动类看 `@SpringBootApplication`，HTTP 路由看 `@Controller`/`@RestController`，锚点在类声明行。 */
export function detectJavaEntrypoints(contents: Map<string, string>): SourceAnchor[] {
  const classDecl = /^\s*(?:(?:public|private|protected|final|abstract|sealed|static)\s+)*(?:class|interface|enum|record)\s+\w+/;
  const boot: SourceAnchor[] = [];
  const controllers: SourceAnchor[] = [];
  for (const [path, content] of contents) {
    if (!path.endsWith(".java")) continue;
    const lines = content.split("\n");
    const classLineOf = (from: number): number => {
      for (let index = from; index < lines.length; index += 1) {
        if (classDecl.test(lines[index])) return index + 1;
      }
      return from + 1;
    };
    const bootIndex = lines.findIndex((line) => /^\s*@SpringBootApplication\b/.test(line));
    if (bootIndex >= 0) {
      boot.push({ path, line: classLineOf(bootIndex), label: "Spring Boot 启动类" });
      continue;
    }
    const controllerIndex = lines.findIndex((line) => /^\s*@(?:Rest)?Controller\b/.test(line));
    if (controllerIndex < 0) continue;
    // 类级 @RequestMapping 前缀从注解行扫到类声明为止
    let prefix = "";
    for (let index = controllerIndex; index < lines.length; index += 1) {
      if (classDecl.test(lines[index])) break;
      const match = lines[index].match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
      if (match) {
        prefix = match[1];
        break;
      }
    }
    controllers.push({ path, line: classLineOf(controllerIndex), label: `HTTP 路由 (Spring MVC)${prefix ? `：${prefix}` : ""}` });
  }
  return [...boot, ...controllers];
}

