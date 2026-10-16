import { describe, expect, it } from "vitest";
import { EXTERNAL_CATALOG, classifyExternal, groupExternals, isBoundaryMember } from "./external-catalog.js";

/**
  边界栏的分类判据。这一层的价值全在「不乱猜」上，所以下面几条钉的都是**不该发生的事**：
  按字面词根归类、把没认出来的东西合并、把标准库当外部服务。
*/
describe("外部包名词典（确定性，无模型）", () => {
  it("命中段数最长的前缀：spring-data-redis 是缓存，不是笼统的 Spring", () => {
    expect(classifyExternal("org.springframework.data.redis")).toMatchObject({ category: "cache", display: "Redis（spring-data-redis）", matched: "org.springframework.data.redis" });
    expect(classifyExternal("org.springframework.stereotype.Component")).toMatchObject({ category: "framework", matched: "org.springframework" });
  });

  it("绝不按字面词根猜：路径里有 web 不等于它是 HTTP 客户端", () => {
    // `org.springframework.web.bind` 是入站注解（Spring MVC 的 @RequestMapping 那一族），不是打别人接口的客户端
    expect(classifyExternal("org.springframework.web.bind").category).toBe("framework");
    expect(classifyExternal("axios").category).toBe("http-client");
  });

  it("前缀粘连要挡住：`fastify` 不能命中 `fastify-plugin` 这种同前缀不同包的写法", () => {
    // 词典里有 `fastify`；一个「fastify 开头但不是它」的名字只能命中自己那条键，否则就是 other
    expect(classifyExternal("fastify-something-else").category).toBe("other");
    expect(classifyExternal("fastify").matched).toBe("fastify");
  });

  it("三族标准库各自认，都不算边界之外", () => {
    expect(classifyExternal("java.util.List").category).toBe("stdlib");
    expect(classifyExternal("node:sqlite").category).toBe("stdlib");
    expect(classifyExternal("path").category).toBe("stdlib");
    expect(classifyExternal("fmt").category).toBe("stdlib");
    expect(classifyExternal("datetime").category).toBe("stdlib");
    for (const name of ["java.util.List", "node:sqlite", "path", "fmt", "datetime"]) expect(isBoundaryMember(classifyExternal(name).category), name).toBe(false);
    expect(isBoundaryMember("cache")).toBe(true);
    expect(isBoundaryMember("other"), "没认出来的东西也不能默认算边界成员").toBe(false);
  });

  it("命中不了的一律 other，且名字原样留着（不合并、不编展示名）", () => {
    const info = classifyExternal("some_obscure_lib");
    expect(info).toEqual({ category: "other", display: "some_obscure_lib" });
  });

  it("groupExternals 按词典条目合行，other 一行一个名字；文件数是「依据」不是装饰", () => {
    const groups = groupExternals({
      "a.java": ["lombok.Data", "lombok.experimental.Accessors", "org.springframework.data.redis.connection"],
      "b.java": ["lombok.extern.slf4j.Slf4j", "org.springframework.data.redis.core"],
      "c.ts": ["some_obscure_lib"],
      "d.ts": ["another_odd_one"]
    });
    const lombok = groups.find((group) => group.matched === "lombok");
    expect(lombok?.identities.sort()).toEqual(["lombok.Data", "lombok.experimental.Accessors", "lombok.extern.slf4j.Slf4j"]);
    expect(lombok?.files.sort()).toEqual(["a.java", "b.java"]);
    // 同一个 Redis 的两条不同深度身份并成一行（这才是「一栏里一个东西」）
    const redis = groups.find((group) => group.matched === "org.springframework.data.redis");
    expect(redis?.identities.sort()).toEqual(["org.springframework.data.redis.connection", "org.springframework.data.redis.core"]);
    // other 不合并：没认出名字，就不知道它们是不是同一个东西
    const unrecognized = groups.filter((group) => group.category === "other");
    expect(unrecognized.map((group) => group.display).sort()).toEqual(["another_odd_one", "some_obscure_lib"]);
    // 存储/缓存排在框架前，未识别垫底
    expect(groups.findIndex((group) => group.category === "cache")).toBeLessThan(groups.findIndex((group) => group.category === "framework"));
    expect(groups[groups.length - 1].category).toBe("other");
  });

  /**
    词典只收真实遇到的包（文件头第 3 条纪律）。这条测试不查内容查**形状**：
    每个键都得是个能当包名前缀用的写法，别把中文、空格、通配符写进键里——那会让匹配静默失效。
  */
  it("词典键的形状：不含空格与中文，段与段都是标识符", () => {
    for (const prefix of Object.keys(EXTERNAL_CATALOG)) {
      expect(prefix, "键里不许有空格或中文").toMatch(/^@?[\w.-]+([./][\w.-]+)*$/);
    }
  });
});
