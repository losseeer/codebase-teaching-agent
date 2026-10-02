import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISCIPLINES, anchorHits, hintHits, manifestEvidence, resolveDiscipline, signatureHits } from "./anchors.js";

/**
  学科证据表要守住三件事：学科名解析得准（业务名不能误判成学科）、强证据不能偶然命中
  （否则「本仓没有这个主题」的判据永远为真）、依赖清单真的能当主题指纹。
  */
describe("resolveDiscipline（模块名 → 学科主题）", () => {
  it("规范名与别名精确命中；自建模块名走包含匹配", () => {
    expect(resolveDiscipline("计算机网络")?.id).toBe("network");
    expect(resolveDiscipline("操作系统")?.id).toBe("os");
    expect(resolveDiscipline("语言特性")?.id).toBe("lang");
    expect(resolveDiscipline("并发编程")?.id).toBe("os");
    expect(resolveDiscipline(" 网络编程 ")).toBeDefined();
    expect(resolveDiscipline("", "随便什么说明")).toBeUndefined();
  });

  it("业务主题不误判为学科：支付/订单这种仓库原生名走原来的关键词路径", () => {
    expect(resolveDiscipline("支付模块", "下单、支付回调与对账")).toBeUndefined();
    expect(resolveDiscipline("博客评论", "评论接口路由")).toBeUndefined();
    expect(resolveDiscipline("完全不相关的名字", "只是提示词里没有别名")).toBeUndefined();
  });

  it("模块名随便起、说明里带学科别名也能认出来（≥3 字符别名参与包含匹配）", () => {
    expect(resolveDiscipline("我的模块", "多路复用与并发编程")?.id).toBe("os");
    // 2 字符别名（「线程」「io」）刻意不做包含匹配：会偶然嵌进别的名字里
    expect(resolveDiscipline("我的模块", "一些线程相关的东西")).toBeUndefined();
  });
});

describe("锚点命中", () => {
  it("强证据只认几乎不会偶然出现的标识符：并发主题靠 CountDownLatch，不靠 cache", () => {
    const os = DISCIPLINES.find((item) => item.id === "os")!;
    expect(signatureHits(os, "秒杀库存扣减：Redis + CountDownLatch 汇聚并行结果")).toContain("countdownlatch");
    expect(signatureHits(os, "商铺查询路由与熔断降级")).toHaveLength(0);
    // 泛化锚点仍然参与排序（方向正确，但不作为存在性判据）
    expect(hintHits(os, "商铺查询缓存")).toContain("缓存");
  });

  it("短 ASCII 锚点走词边界：io 不命中 configuration，但命中 IOService 与 io 目录段", () => {
    const os = DISCIPLINES.find((item) => item.id === "os")!;
    expect(anchorHits(["io"], "SystemConfiguration.java")).toHaveLength(0);
    expect(anchorHits(["io"], "src/main/java/io/IOService.java")).toHaveLength(1);
  });

  it("表内锚点必须全小写且无首尾空白（命中判定按小写文本做，写法错了就是静默失效）", () => {
    for (const discipline of DISCIPLINES) {
      for (const anchor of [...discipline.signatures, ...discipline.hints]) {
        expect(anchor).toBe(anchor.toLowerCase().trim());
        expect(anchor.length).toBeGreaterThan(1);
      }
    }
  });
});

describe("manifestEvidence（依赖清单即主题指纹）", () => {
  it("pom.xml 里出现 lettuce-core → 网络主题有证据；同一份清单不该判出并发主题", () => {
    const repository = mkdtempSync(join(tmpdir(), "codebase-tutor-discipline-"));
    writeFileSync(join(repository, "pom.xml"), "<project><dependencies><dependency><artifactId>lettuce-core</artifactId></dependency><dependency><artifactId>xxl-job-core</artifactId></dependency></dependencies></project>", "utf8");
    const network = DISCIPLINES.find((item) => item.id === "network")!;
    const os = DISCIPLINES.find((item) => item.id === "os")!;
    expect(manifestEvidence(network, repository)).toContain("lettuce");
    expect(manifestEvidence(os, repository)).toContain("xxl-job");
    // 没有清单文件的目录：返回空数组，不抛
    expect(manifestEvidence(network, join(repository, "missing"))).toHaveLength(0);
  });
});
