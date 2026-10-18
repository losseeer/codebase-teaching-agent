import { describe, expect, it } from "vitest";
import type { ArchitectureBlockBrief, ArchitectureLayer } from "@codebase-tutor/shared";
import { verifyArchitectureDraft, type CanvasUnits } from "./redraft.js";

/**
  候选图的核验（`verifyArchitectureDraft`）只做用户定下的那一档：**模块与文件的包含关系**——
  节点是不是真在画布上、有没有一个节点进两层、没画的节点有没有交代理由。
  它**不查**文件级 import、也不查函数级调用：那些是引擎算边时的事，图是模块集粒度的。
*/

const blocks: ArchitectureBlockBrief[] = [
  { id: "module:a", title: "接入", members: ["module:a"], role: "entry" },
  { id: "module:b", title: "编排", members: ["module:b"], role: "core" },
  { id: "arch:x:c", title: "工具、枚举", members: ["module:c", "module:d"], role: "shared" }
];

const canvas: CanvasUnits = {
  blocks,
  units: {
    blocks: new Map(blocks.map((block) => [block.id, block.members])),
    // 树上还有个没人引用的孤立节点：它不画（不在 blocks 里），但 id 是合法的——修正点名它能把它恢复来
    members: new Set(["module:a", "module:b", "module:c", "module:d", "module:ghost"])
  }
};

const draft = (layers: { name: string; duty?: string; nodes: string[] }[], omitted: { node: string; reason?: string }[] = []): Record<string, unknown> => ({
  layers: layers.map((layer) => ({ name: layer.name, duty: layer.duty ?? "一句话职责", nodes: layer.nodes })),
  omitted
});

describe("verifyArchitectureDraft", () => {
  it("合格的一份：每个节点都安置、层不空、名字与职责都在", () => {
    const outcome = verifyArchitectureDraft(draft([{ name: "接入", nodes: ["module:a"] }, { name: "能力", nodes: ["module:b", "arch:x:c"] }]), canvas);
    expect(outcome.ok, outcome.reason).toBe(true);
    expect(outcome.draft?.layers.map((layer) => layer.name)).toEqual(["接入", "能力"]);
  });

  it("造一个画布上没有的节点：整份拒，不给「按它说的画一半」", () => {
    const outcome = verifyArchitectureDraft(draft([{ name: "接入", nodes: ["module:a"] }, { name: "缓存", nodes: ["module:redis"] }]), canvas);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("不是画布上现有的节点");
  });

  it("同一个节点进两层：拒", () => {
    const outcome = verifyArchitectureDraft(draft([{ name: "上", nodes: ["module:a", "module:b"] }, { name: "下", nodes: ["module:b"] }]), canvas);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason, "冲突要说清是哪一层，模型才知道改哪一行").toContain("同时进");
  });

  it("漏了一个节点没列进 omitted：拒——静默丢掉节点等于让图上的节点数与实际不符", () => {
    const outcome = verifyArchitectureDraft(draft([{ name: "上", nodes: ["module:a"] }, { name: "下", nodes: ["module:b"] }]), canvas);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("没安置");
  });

  it("列进 omitted 但没给理由：拒；给了理由就算安置", () => {
    const noReason = verifyArchitectureDraft(draft([{ name: "上", nodes: ["module:a"] }, { name: "下", nodes: ["module:b"] }], [{ node: "arch:x:c" }]), canvas);
    expect(noReason.ok).toBe(false);
    expect(noReason.reason).toContain("没给理由");
    const withReason = verifyArchitectureDraft(draft([{ name: "上", nodes: ["module:a"] }, { name: "下", nodes: ["module:b"] }], [{ node: "arch:x:c", reason: "底座与工具，这条主线用不上" }]), canvas);
    expect(withReason.ok, withReason.reason).toBe(true);
    expect(withReason.draft?.omitted[0]?.reason).toContain("底座");
  });

  it("组合节点可以拆成成员分别归层：成员都安置就算过", () => {
    const outcome = verifyArchitectureDraft(draft([{ name: "上", nodes: ["module:a", "module:c"] }, { name: "下", nodes: ["module:b", "module:d"] }]), canvas);
    expect(outcome.ok, outcome.reason).toBe(true);
  });

  it("只给一层不叫分层；八层以上那是清单不是图", () => {
    expect(verifyArchitectureDraft(draft([{ name: "全都在这", nodes: ["module:a", "module:b", "arch:x:c"] }]), canvas).ok).toBe(false);
    // 这一句验的是**重复归层**（同一个节点被塞进两层），不是层数：层数那条在下一句单独钉
    const dup = Array.from({ length: 4 }, (_unused, index) => ({ name: `层${index + 1}`, nodes: index === 0 ? ["module:a", "module:b"] : ["module:a"] }));
    expect(verifyArchitectureDraft(draft(dup), canvas).reason, "同一节点进两层要当场拒掉").toContain("同时进");
    const eight = Array.from({ length: 8 }, (_unused, index) => ({ name: `层${index + 1}`, nodes: index === 0 ? ["module:a"] : [] as string[] }));
    expect(verifyArchitectureDraft({ layers: eight, omitted: [] }, canvas).reason, "超过 7 层先被层数上限挡下").toContain("7 层上限");
  });

  it("反证只标不改判：同层多数是核心链路，那个节点底座就被标出来", () => {
    // 「多数」要真成立：得有两个节点同档，才算得出「这个节点与同伴相反」
    const wide: ArchitectureBlockBrief[] = [...blocks, { id: "module:e", title: "另一条主链路", members: ["module:e"], role: "core" }];
    const wideCanvas: CanvasUnits = {
      blocks: wide,
      units: { blocks: new Map(wide.map((block) => [block.id, block.members])), members: new Set([...canvas.units.members, "module:e"]) }
    };
    const outcome = verifyArchitectureDraft(draft([{ name: "接入", nodes: ["module:a"] }, { name: "能力", nodes: ["module:b", "module:e", "arch:x:c"] }]), wideCanvas);
    expect(outcome.ok).toBe(true);
    expect(outcome.draft?.conflicts.map((item) => item.node)).toEqual(["arch:x:c"]);
    expect(outcome.draft?.conflicts[0]?.evidence).toContain("被多处引用的底座");
  });

  it("同层只有一个节点时没有「多数」可说，不硬造一条反证", () => {
    const outcome = verifyArchitectureDraft(draft([{ name: "接入", nodes: ["module:a", "module:b"] }, { name: "底座", nodes: ["arch:x:c"] }]), canvas);
    expect(outcome.draft?.conflicts ?? [], "底座这层只有那个节点，没有同层多数可比").toEqual([]);
  });
});

/**
  拆块之后画布会怎么画（`conflictsOf` 内部走的就是这套聚合）：这里钉的是「标记落在哪个节点」。
  组合节点整个进同一层 → 标块 id；成员分了两层 → 块解散，标的是成员 id。
*/
describe("冲突标注的粒度与画布一致", () => {
  it("候选里把组合节点拆开，标注跟着落到成员那个节点", () => {
    const outcome = verifyArchitectureDraft(draft([{ name: "上", nodes: ["module:a", "module:c"] }, { name: "下", nodes: ["module:b", "module:d"] }]), canvas);
    expect(outcome.ok).toBe(true);
    // 下层里 module:d（来自 shared 块）与 module:b（core）同层，且 core 只有一个节点 ⇒ 没有多数，不标
    expect(outcome.draft?.conflicts ?? []).toEqual([]);
  });

  it("整个组合节点留在同一层时，可核对的节点 id 是组合节点的 id，而不是成员 id", () => {
    const outcome = verifyArchitectureDraft(draft([{ name: "接入", nodes: ["module:a", "module:b"] }, { name: "底座", nodes: ["arch:x:c", "module:c"] }]), canvas);
    expect(outcome.ok, outcome.reason).toBe(true);
    expect(outcome.draft?.layers[1]?.nodes).toContain("arch:x:c");
  });
});
