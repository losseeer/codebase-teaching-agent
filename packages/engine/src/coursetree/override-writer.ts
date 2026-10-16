import type { ArchitectureBlockBrief, ArchitectureOverrideIntent, CourseTree, RepositoryOverlays } from "@codebase-tutor/shared";
import { clearOverlays, overlayCounts, patchOverlays, readOverlays, removeOverlayKeys } from "../store/overlays.js";
import type { TutorDatabase } from "../store/database.js";
import { id } from "../lib.js";

/**
  人工修正的**唯一落地处**。GUI 的拖动与 Agent 的 `set_architecture` 工具都走到这里，
  校验、写盘、审计、通知四步一次做完——两条写路径各写一套是这套东西最容易烂掉的地方
  （界面改成功、工具改失败，或反之，用户只会看到「我明明改了」）。

  ⚠️ 这个模块的输入形状是**白名单**：只有下面四种意图能表达出来，
  所以「模型说把这条箭头删掉」「给这个仓加一个模块」这类要求在类型层面就没有落点，
  不是运行时要拦截的漏洞，而是压根写不出这个动作。工具层还要再挡一次（未知字段拒写），
  两层挡的是同一件事：`set_architecture` 是全仓第一个有副作用的工具。
*/

export const TIER_VALUES = ["core", "facility", "periphery"] as const;
export type TierValue = (typeof TIER_VALUES)[number];

/** 形状的权威在 shared（GUI 的拖动与工具走同一个线上形状），这里只是别名。 */
export type OverrideIntent = ArchitectureOverrideIntent;

export interface OverrideContext {
  database: TutorDatabase;
  repositoryId: string;
  /** 校验模块 id 用：id 必须真的在课程树的模块地图里。 */
  course: CourseTree;
  /** 校验层名用：来自当前产物（缓存里那份或静态三层），**不会**为此发模型请求。 */
  layers: string[];
  /**
    校验方块 id 用：图上现在的方块清单（原子块 + 合并块）。
    为什么要带上合并块：agent 读到的架构图就是这些块，`arch:...` 是它手里唯一的 id；
    只认课程树的原子模块 id 会把「把这几个小目录整体挪走」当成非法输入。
  */
  blocks?: ArchitectureBlockBrief[];
  journal: { append: (type: "architecture_layer_overridden" | "module_tier_overridden", payload: Record<string, string | number | boolean | null>) => void };
  /** 落盘成功后通知（SSE 一帧）。 */
  onApplied?: (event: { repositoryId: string; module?: string; via: OverrideVia }) => void;
}

export type OverrideVia = "gui" | "agent";

/** 一句给模型/界面看的话：**实际落盘之后**的状态，不是意图。 */
export interface OverrideOutcome {
  ok: boolean;
  text: string;
  overlays?: RepositoryOverlays;
}

function moduleIdsOf(course: CourseTree): Set<string> {
  const branch = course.root.children.find((node) => node.id === "modules");
  return new Set((branch?.children ?? []).map((node) => node.id));
}

function moduleNode(course: CourseTree, moduleId: string) {
  const branch = course.root.children.find((node) => node.id === "modules");
  return branch?.children.find((node) => node.id === moduleId);
}

function moduleTitle(course: CourseTree, moduleId: string): string {
  return moduleNode(course, moduleId)?.title ?? moduleId;
}

/** 图上这块的名字：合并块用方块标题，原子块用课程树标题，都没有就原样报 id（不编名字）。 */
function titleOf(course: CourseTree, blocks: ArchitectureBlockBrief[] | undefined, id: string): string {
  return blocks?.find((block) => block.id === id)?.title ?? moduleTitle(course, id);
}

/** 从覆盖层与树里找某模块当前所在的层名（写审计的 `from` 用；找不到就如实留空）。 */
function currentLayerOf(context: OverrideContext, overlays: RepositoryOverlays, moduleId: string): string | undefined {
  return overlays.architecture?.moduleLayer?.[moduleId];
}

/**
  执行一次人工修正。任何一步校验不过都**不动盘**，并把原因原样交回调用方
  （工具那条路会把这句话喂回模型，所以句子要能指导下一步：说要什么、不给什么）。
*/
export function commitOverride(context: OverrideContext, intent: OverrideIntent, via: OverrideVia): OverrideOutcome {
  const known = moduleIdsOf(context.course);
  const blocksById = new Map((context.blocks ?? []).map((block) => [block.id, block]));
  const overlays = readOverlays(context.database, context.repositoryId);
  const refuse = (reason: string): OverrideOutcome => ({ ok: false, text: `没改：${reason}。只支持 move_module / rename_layer / set_tier / reset 四种动作，箭头、模块清单与文件路径由程序按 import 算，改不了。` });

  if (intent.kind === "move_module") {
    // 方块 id 与原子模块 id 都收：前者是整块挪，后者由读侧按成员拆块（见 architecture.ts 的 applyOverrides）
    if (!known.has(intent.module) && !blocksById.has(intent.module)) return refuse(`「${intent.module.slice(0, 60)}」既不在模块地图里，也不是现在图上的方块`);
    if (!context.layers.includes(intent.layer)) return refuse(`层名「${intent.layer.slice(0, 40)}」不在现在的图上；现在是：${context.layers.join(" / ") || "（还没分层）"}`);
    const title = titleOf(context.course, context.blocks, intent.module);
    const from = currentLayerOf(context, overlays, intent.module) ?? intent.from;
    const next = patchOverlays(context.database, context.repositoryId, { architecture: { moduleLayer: { [intent.module]: intent.layer } } });
    context.journal.append("architecture_layer_overridden", {
      correction_id: id(), module: intent.module, module_title: title, from: from ?? null, to: intent.layer, via,
      // 引擎原判一并带上：这一格的差值就是「分层判断错了几次」的唯一读数
      layer_source: context.layers.length ? "plan" : "empty"
    });
    context.onApplied?.({ repositoryId: context.repositoryId, module: intent.module, via });
    return { ok: true, text: `已把「${title}」从${from ? `「${from}」` : "原判层"}挪到「${intent.layer}」。箭头按新归属重算，没有增删。`, overlays: next };
  }

  if (intent.kind === "rename_layer") {
    const to = intent.to.trim();
    if (!to || to.length > 24) return refuse("新层名要 1~24 个字");
    if (!context.layers.includes(intent.from)) return refuse(`没有这一层：「${intent.from.slice(0, 40)}」；现在是：${context.layers.join(" / ")}`);
    const next = patchOverlays(context.database, context.repositoryId, { architecture: { layerRenames: { [intent.from]: to } } });
    context.journal.append("architecture_layer_overridden", { correction_id: id(), from: intent.from, to, action: "rename_layer", via });
    context.onApplied?.({ repositoryId: context.repositoryId, via });
    return { ok: true, text: `层「${intent.from}」已改名为「${to}」；这层里的模块跟着新名字走。`, overlays: next };
  }

  if (intent.kind === "set_tier") {
    // 档位是**原子模块**那一格的属性（分级层按模块的文件算），合并块没有档：这里不收 `arch:` id，报错要说出该改谁
    if (blocksById.has(intent.module) && !known.has(intent.module)) return refuse(`「${intent.module.slice(0, 60)}」是合并出来的方块，没有档位：请逐个模块 id 改`);
    if (!known.has(intent.module)) return refuse(`模块 id「${intent.module.slice(0, 60)}」不在当前课程树的模块地图里`);
    if (!TIER_VALUES.includes(intent.tier)) return refuse(`档只有三档：${TIER_VALUES.join(" / ")}`);
    const given = intent.given ?? overlays.modules?.tier?.[intent.module];
    const next = patchOverlays(context.database, context.repositoryId, { modules: { tier: { [intent.module]: intent.tier } } });
    const evidence = moduleNode(context.course, intent.module)?.tierEvidence;
    context.journal.append("module_tier_overridden", {
      correction_id: id(), module: intent.module, module_title: moduleTitle(context.course, intent.module), to: intent.tier,
      // 原判必带：没有它，改档读数就只剩「改成了什么」，问不出「引擎错在哪」
      given: given ?? null, via,
      // 判据摘要一起落：这条线是分级层唯一的真值来源，只留「谁被改过」就永远问不出为什么错
      core_share: evidence?.coreShare ?? "", visible_files: evidence?.visibleFiles ?? "", restored: false
    });
    context.onApplied?.({ repositoryId: context.repositoryId, module: intent.module, via });
    return { ok: true, text: `「${moduleTitle(context.course, intent.module)}」的档已改成 ${intent.tier}（引擎原判：${given ?? "未记录"}）。`, overlays: next };
  }

  if (intent.kind === "reset") {
    /**
      撤法只有三种，写侧必须各自有落点（2026-10-16 补第二种）：
      - 给 `module`：只撤那一格的归层与改档；
      - 给 `layerRename`（原层名或改成的名字都认）：只撤一条层名改名，指着新名字的归层写回旧名字；
      - 两个都不给：把这个仓的修正一次清空。
      以前只有第一与第三种，「带着改名来撤」会因为没有 module 而**掉进第三种**——用户想撤一条改名，结果全清。
      这一格是全仓唯一会一次抹掉多处修正的动作，认不出目标就拒，不退成全清。
      */
    const rename = intent.layerRename?.trim();
    const renames = overlays.architecture?.layerRenames ?? {};
    const matched = rename ? Object.entries(renames).filter(([from, to]) => from === rename || to === rename) : [];
    if (rename && !matched.length) return refuse(`没有「${rename.slice(0, 40)}」这条层名修正，其他修正一条没动；现在的改名是：${Object.entries(renames).map(([from, to]) => `${from}→${to}`).join(" / ") || "（没有）"}`);
    const clearedMove = intent.module ? overlays.architecture?.moduleLayer?.[intent.module] : undefined;
    const clearedTier = intent.module ? overlays.modules?.tier?.[intent.module] : undefined;
    if (intent.module && !clearedMove && !clearedTier && !matched.length) return refuse(`「${(intent.module ?? "").slice(0, 60)}」本来就没有人工修正，其他修正一条没动`);
    const partial = Boolean(intent.module || rename);
    const next = partial
      ? removeOverlayKeys(context.database, context.repositoryId, {
        ...(intent.module ? { modules: { tier: [intent.module] } } : {}),
        ...(intent.module || rename ? { architecture: { ...(intent.module ? { moduleLayer: [intent.module] } : {}), ...(rename ? { layerRenames: [rename!] } : {}) } } : {})
      })
      : clearOverlays(context.database, context.repositoryId);
    context.journal.append("architecture_layer_overridden", { correction_id: id(), action: "reset", module: intent.module ?? null, layer_rename: rename ?? null, via });
    // 撤销顺带撤掉的可能不止归层：旧读数以 `restored:true` 分「改档」与「恢复」，这里只在**真有一处档位被撤掉**时补一行——
    // 没撤也记会让恢复数虚高。
    const clearedTiers = intent.module ? (clearedTier ? [intent.module] : []) : Object.keys(overlays.modules?.tier ?? {});
    for (const moduleId of clearedTiers) {
      const evidence = moduleNode(context.course, moduleId)?.tierEvidence;
      context.journal.append("module_tier_overridden", {
        correction_id: id(), module: moduleId, module_title: moduleTitle(context.course, moduleId), to: "", given: overlays.modules?.tier?.[moduleId] ?? null,
        via, restored: true, core_share: evidence?.coreShare ?? "", visible_files: evidence?.visibleFiles ?? ""
      });
    }
    context.onApplied?.({ repositoryId: context.repositoryId, module: intent.module, via });
    if (!partial) {
      const counts = overlayCounts(overlays);
      return { ok: true, text: `已清空这个仓的全部人工修正（${Object.keys(overlays.architecture?.moduleLayer ?? {}).length} 条归层 / ${Object.keys(renames).length} 条改名 / ${Object.keys(overlays.modules?.tier ?? {}).length} 处改档${counts.modules + counts.layers - Object.keys(overlays.architecture?.moduleLayer ?? {}).length - Object.keys(renames).length - Object.keys(overlays.modules?.tier ?? {}).length ? "，另含模块标题改名与隐藏等界面覆盖" : ""}），图回到模型与引擎的判据。`, overlays: next };
    }
    const what = [
      intent.module ? `「${titleOf(context.course, context.blocks, intent.module!)}」的${[clearedMove ? "归层" : "", clearedTier ? "改档" : ""].filter(Boolean).join("与")}` : "",
      rename ? `改名「${matched[0]![0]}→${matched[0]![1]}」` : ""
    ].filter(Boolean).join("、");
    return { ok: true, text: `已撤销 ${what}，这些格回到模型与引擎的判据。这个仓还剩 ${overlayCounts(next).modules + overlayCounts(next).layers} 条人工修正。`, overlays: next };
  }

  return refuse("这个动作不在支持列表里");
}

/**
  把工具传回的参数原语翻成 `OverrideIntent`。**没列出来的字段一律不看**——
  模型在参数里塞 `edges` / `paths` / `add_module` 之类时，这里既不报错也不采纳，
  只在回给模型的话里提一句「多余字段已忽略」，让它知道边界在哪。
*/
export function parseOverrideArguments(raw: string): { intent?: OverrideIntent; ignored: string[]; error?: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return { ignored: [], error: "参数不是合法 JSON" };
  }
  const wanted = ["action", "module", "layer", "from", "to", "tier"];
  const ignored = Object.keys(parsed).filter((key) => !wanted.includes(key));
  const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
  const text = (key: string): string => (typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "");
  if (action === "move_module") {
    if (!text("module") || !text("layer")) return { ignored, error: "move_module 需要 module 与 layer 两个参数" };
    return { intent: { kind: "move_module", module: text("module"), layer: text("layer"), ...(text("from") ? { from: text("from") } : {}) }, ignored };
  }
  if (action === "rename_layer") {
    if (!text("from") || !text("to")) return { ignored, error: "rename_layer 需要 from 与 to 两个参数" };
    return { intent: { kind: "rename_layer", from: text("from"), to: text("to") }, ignored };
  }
  if (action === "set_tier") {
    if (!text("module") || !TIER_VALUES.includes(text("tier") as TierValue)) return { ignored, error: `set_tier 需要 module 与 tier（${TIER_VALUES.join(" / ")}）` };
    return { intent: { kind: "set_tier", module: text("module"), tier: text("tier") as TierValue }, ignored };
  }
  // reset 的三种撤法：给 module（撤那一格）、给 from 或 to（撤一条改名，原判名与改后的名字都认）、都不给（全撤）
  if (action === "reset") {
    const rename = text("from") || text("to");
    return { intent: { kind: "reset", ...(text("module") ? { module: text("module") } : {}), ...(rename ? { layerRename: rename } : {}) }, ignored };
  }
  return { ignored, error: `未知 action「${action.slice(0, 40)}」` };
}
