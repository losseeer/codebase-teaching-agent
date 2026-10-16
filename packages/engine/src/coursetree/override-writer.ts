import type { CourseTree, RepositoryOverlays } from "@codebase-tutor/shared";
import { clearOverlays, patchOverlays, readOverlays, removeOverlayKeys } from "../store/overlays.js";
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

export type OverrideIntent =
  /** 把模块挪到另一层（按层名）。`from` 是引擎/模型当时给的层名，只为把审计写清楚，不做校验依据。 */
  | { kind: "move_module"; module: string; layer: string; from?: string }
  /** 改层名：连带把归层表里指旧名的模块一起换掉（合并逻辑在 `patchOverlays`）。 */
  | { kind: "rename_layer"; from: string; to: string }
  /** 改模块的结构档。 */
  | { kind: "set_tier"; module: string; tier: TierValue; given?: string }
  /** 撤掉人工修正，回到引擎/模型判的样子。不给 target 就撤这一仓的全部修正。 */
  | { kind: "reset"; module?: string; layerRename?: string };

export interface OverrideContext {
  database: TutorDatabase;
  repositoryId: string;
  /** 校验模块 id 用：id 必须真的在课程树的模块地图里。 */
  course: CourseTree;
  /** 校验层名用：来自当前产物（缓存里那份或静态三层），**不会**为此发模型请求。 */
  layers: string[];
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

function moduleTitle(course: CourseTree, moduleId: string): string {
  const branch = course.root.children.find((node) => node.id === "modules");
  return branch?.children.find((node) => node.id === moduleId)?.title ?? moduleId;
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
  const overlays = readOverlays(context.database, context.repositoryId);
  const refuse = (reason: string): OverrideOutcome => ({ ok: false, text: `没改：${reason}。只支持 move_module / rename_layer / set_tier / reset 四种动作，箭头、模块清单与文件路径由程序按 import 算，改不了。` });

  if (intent.kind === "move_module") {
    if (!known.has(intent.module)) return refuse(`模块 id「${intent.module.slice(0, 60)}」不在当前课程树的模块地图里`);
    if (!context.layers.includes(intent.layer)) return refuse(`层名「${intent.layer.slice(0, 40)}」不在现在的图上；现在是：${context.layers.join(" / ") || "（还没分层）"}`);
    const from = currentLayerOf(context, overlays, intent.module) ?? intent.from;
    const next = patchOverlays(context.database, context.repositoryId, { architecture: { moduleLayer: { [intent.module]: intent.layer } } });
    context.journal.append("architecture_layer_overridden", {
      correction_id: id(), module: intent.module, module_title: moduleTitle(context.course, intent.module), from: from ?? null, to: intent.layer, via,
      // 引擎原判一并带上：这一格的差值就是「分层判断错了几次」的唯一读数
      layer_source: context.layers.length ? "plan" : "empty"
    });
    context.onApplied?.({ repositoryId: context.repositoryId, module: intent.module, via });
    return { ok: true, text: `已把「${moduleTitle(context.course, intent.module)}」从${from ? `「${from}」` : "原判层"}挪到「${intent.layer}」。箭头按新归属重算，没有增删。`, overlays: next };
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
    if (!known.has(intent.module)) return refuse(`模块 id「${intent.module.slice(0, 60)}」不在当前课程树的模块地图里`);
    if (!TIER_VALUES.includes(intent.tier)) return refuse(`档只有三档：${TIER_VALUES.join(" / ")}`);
    const given = intent.given ?? overlays.modules?.tier?.[intent.module];
    const next = patchOverlays(context.database, context.repositoryId, { modules: { tier: { [intent.module]: intent.tier } } });
    context.journal.append("module_tier_overridden", {
      correction_id: id(), module: intent.module, module_title: moduleTitle(context.course, intent.module), to: intent.tier,
      // 原判必带：没有它，改档读数就只剩「改成了什么」，问不出「引擎错在哪」
      given: given ?? null, via
    });
    context.onApplied?.({ repositoryId: context.repositoryId, module: intent.module, via });
    return { ok: true, text: `「${moduleTitle(context.course, intent.module)}」的档已改成 ${intent.tier}（引擎原判：${given ?? "未记录"}）。`, overlays: next };
  }

  if (intent.kind === "reset") {
    const next = intent.module
      ? removeOverlayKeys(context.database, context.repositoryId, { modules: { tier: [intent.module] }, architecture: { moduleLayer: [intent.module] } })
      : clearOverlays(context.database, context.repositoryId);
context.journal.append("architecture_layer_overridden", { correction_id: id(), action: "reset", module: intent.module ?? null, layer_rename: intent.layerRename ?? null, via });
    context.onApplied?.({ repositoryId: context.repositoryId, module: intent.module, via });
    return { ok: true, text: intent.module ? `已撤销「${moduleTitle(context.course, intent.module)}」的人工修正，回到引擎与模型的判据。` : "已撤销这份产物上的人工修正。", overlays: next };
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
  if (action === "reset") return { intent: { kind: "reset", ...(text("module") ? { module: text("module") } : {}), ...(text("to") ? { layerRename: text("to") } : {}) }, ignored };
  return { ignored, error: `未知 action「${action.slice(0, 40)}」` };
}
