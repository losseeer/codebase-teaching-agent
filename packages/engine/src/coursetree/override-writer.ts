import type { CourseTier, CourseTree, ModuleTierOverrideIntent } from "@codebase-tutor/shared";
import { clearOverlays, overlayCounts, patchOverlays, readOverlays, removeOverlayKeys } from "../store/overlays.js";
import type { TutorDatabase } from "../store/database.js";
import { id } from "../identity.js";

/**
  模块档位的**唯一落地处**。Agent 的 `set_module_tier` 与浏览器旧值迁移都走到这里，
  校验、写盘、审计、通知四步一次做完——两条写路径各写一套是这套东西最容易失效的地方。

  白名单只有 `set_tier` / `reset`：改图结构不在这一层，改层名也不在（分层视图已退役）。
  `set_tier` 只接受课程树模块地图里的原子模块 id；组合节点没有档位，报错要说出该改谁。
*/

const TIER_VALUES = ["core", "facility", "periphery"] as const;
type TierValue = (typeof TIER_VALUES)[number];

export type OverrideIntent = ModuleTierOverrideIntent;

export interface OverrideContext {
  database: TutorDatabase;
  repositoryId: string;
  /** 校验模块 id 用：id 必须真的在课程树的模块地图里。 */
  course: CourseTree;
  journal: { append: (type: "module_tier_overridden", payload: Record<string, string | number | boolean | null>) => void };
  /** 落盘成功后通知（SSE 一帧）。 */
  onApplied?: (event: { repositoryId: string; module?: string; via: OverrideVia }) => void;
}

export type OverrideVia = "gui" | "agent";

/** 一句给模型/界面看的话：**实际落盘之后**的状态，不是意图。 */
export interface OverrideOutcome {
  ok: boolean;
  text: string;
  /** 落盘后的覆盖层；拒写时是原样。 */
  overlays?: ReturnType<typeof readOverlays>;
}

function moduleNode(course: CourseTree, moduleId: string) {
  const branch = course.root.children.find((node) => node.id === "modules");
  return branch?.children.find((node) => node.id === moduleId);
}

function moduleTitle(course: CourseTree, moduleId: string): string {
  return moduleNode(course, moduleId)?.title ?? moduleId;
}

/**
  执行一次档位修正。任何一步校验不过都**不动盘**，并把原因原样返回调用方
  （工具那条路会把这句话回传给模型，所以句子要能指导下一步）。
*/
export function commitOverride(context: OverrideContext, intent: OverrideIntent, via: OverrideVia): OverrideOutcome {
  const refuse = (reason: string): OverrideOutcome => ({ ok: false, text: `没改：${reason}。只支持 set_tier / reset 两种动作，图结构与层名不在这一层改。` });

  if (intent.kind === "set_tier") {
    if (!moduleNode(context.course, intent.module)) return refuse(`模块 id「${intent.module.slice(0, 60)}」不在当前课程树的模块地图里`);
    if (!TIER_VALUES.includes(intent.tier)) return refuse(`档只有三档：${TIER_VALUES.join(" / ")}`);
    const overlays = readOverlays(context.database, context.repositoryId);
    // 原判取「这次改动之前那一档」：已有覆盖层时就是它，没有时是课程树上引擎算出的那一档
    const given = intent.given ?? overlays.modules?.tier?.[intent.module] ?? moduleNode(context.course, intent.module)?.tier;
    const next = patchOverlays(context.database, context.repositoryId, { modules: { tier: { [intent.module]: intent.tier } } });
    const evidence = moduleNode(context.course, intent.module)?.tierEvidence;
    context.journal.append("module_tier_overridden", {
      correction_id: id(),
      module: intent.module,
      module_title: moduleTitle(context.course, intent.module),
      to: intent.tier,
      // 原判必带：没有它，改档读数就只剩「改成了什么」，问不出「引擎错在哪」
      given: given ?? null,
      via,
      // 判据摘要一起落：这条线是分级层唯一的真值来源，只留「谁被改过」就永远问不出为什么错
      core_share: evidence?.coreShare ?? "",
      visible_files: evidence?.visibleFiles ?? "",
      restored: false
    });
    context.onApplied?.({ repositoryId: context.repositoryId, module: intent.module, via });
    return { ok: true, text: `「${moduleTitle(context.course, intent.module)}」的档已改成 ${intent.tier}（引擎原判：${given ?? "未记录"}）。`, overlays: next };
  }

  if (intent.kind === "reset") {
    const overlays = readOverlays(context.database, context.repositoryId);
    if (intent.module) {
      const clearedTier = overlays.modules?.tier?.[intent.module];
      if (!clearedTier) return refuse(`「${intent.module.slice(0, 60)}」本来就没有改档记录，其他修正一条没动`);
      const next = removeOverlayKeys(context.database, context.repositoryId, { modules: { tier: [intent.module] } });
      const evidence = moduleNode(context.course, intent.module)?.tierEvidence;
      context.journal.append("module_tier_overridden", {
        correction_id: id(),
        module: intent.module,
        module_title: moduleTitle(context.course, intent.module),
        to: "",
        given: clearedTier,
        via,
        restored: true,
        core_share: evidence?.coreShare ?? "",
        visible_files: evidence?.visibleFiles ?? ""
      });
      context.onApplied?.({ repositoryId: context.repositoryId, module: intent.module, via });
      return { ok: true, text: `「${moduleTitle(context.course, intent.module)}」的档已恢复成引擎判据（原改档：${clearedTier}）。`, overlays: next };
    }
    const total = overlayCounts(overlays).modules;
    if (!total) return refuse("这个仓没有人工修正，什么都不用撤");
    const tierCount = Object.keys(overlays.modules?.tier ?? {}).length;
    const next = clearOverlays(context.database, context.repositoryId);
    context.journal.append("module_tier_overridden", { correction_id: id(), action: "reset", module: null, given: null, via, restored: true });
    context.onApplied?.({ repositoryId: context.repositoryId, via });
    return { ok: true, text: `已清空这个仓的全部人工修正（其中 ${tierCount} 处改档，另含模块标题改名与隐藏等界面覆盖）。`, overlays: next };
  }

  return refuse("这个动作不在支持列表里");
}

/**
  把工具传回的参数原语翻成 `OverrideIntent`。**没列出来的字段一律不看**——
  模型在参数里塞 `edges` / `paths` / `layer` 之类时，这里既不报错也不采纳，
  只在回给模型的话里提一句「多余字段已忽略」，让它知道边界在哪。
*/
export function parseOverrideArguments(raw: string): { intent?: OverrideIntent; ignored: string[]; error?: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return { ignored: [], error: "参数不是合法 JSON" };
  }
  const wanted = ["action", "module", "tier", "given"];
  const ignored = Object.keys(parsed).filter((key) => !wanted.includes(key));
  const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
  const text = (key: string): string => (typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "");
  if (action === "set_tier") {
    if (!text("module") || !TIER_VALUES.includes(text("tier") as TierValue)) return { ignored, error: `set_tier 需要 module 与 tier（${TIER_VALUES.join(" / ")}）` };
    return { intent: { kind: "set_tier", module: text("module"), tier: text("tier") as CourseTier, ...(text("given") ? { given: text("given") } : {}) }, ignored };
  }
  if (action === "reset") {
    return { intent: { kind: "reset", ...(text("module") ? { module: text("module") } : {}) }, ignored };
  }
  return { ignored, error: `未知 action「${action.slice(0, 40)}」` };
}
