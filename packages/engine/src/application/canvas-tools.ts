import type { ArchitectureToolContext, FactsToolContext, SetDiagramToolContext } from "../source/tool-loop.js";
import type { ImportedRepository } from "../importer/importer.js";
import type { TutorDatabase } from "../store/database.js";
import type { DiagramWriteContext } from "../diagram/set-diagram.js";
import { applyDiagramEdit, diagramInventoryFor, parseDiagramEditArguments } from "../diagram/set-diagram.js";
import { factsQueryTool } from "../facts/query.js";
import { architectureInputOf, peekCachedArchitecture } from "../coursetree/architecture.js";
import { commitOverride, parseOverrideArguments, type OverrideIntent, type OverrideVia } from "../coursetree/override-writer.js";
import { findCourseNode } from "../coursetree/projection.js";
import { readOverlays } from "../store/overlays.js";
import { Journal } from "../store/journal.js";
import { broadcast } from "../events.js";
import { lightLlm } from "../services.js";

/**
  画布这条写路径的装配层：agent 的两个写工具（`set_diagram` 改结构、`set_architecture` 改分层）
  与界面拖动共用的那一份上下文。
  它们都不是 HTTP 的事——只是过去长在 `server.ts` 里，于是任何复用都要把路由层一起拖上。
  「图不存在」那条回复留在 `server.ts`（它要 `reply`），这里只放构造上下文与落地修正。
*/

/**
  一次图写入的上下文。`course` 取 `architectureInputOf` 那份（实时算完 tier、叠过覆盖层之后的树）：
  写侧核 `ref` 用的模块清单与方块清单必须和读侧画出来的**同一份**，否则会出现「界面正画着这个节点，
  工具却说它查无此人」——覆盖层那条通道栽过的同一件事（§70），构造口径只留一处。
*/
export function diagramWriteContextFor(repository: ImportedRepository, database: TutorDatabase, sessionId?: string): DiagramWriteContext {
  const overlays = readOverlays(database, repository.index.repositoryId);
  const input = architectureInputOf({ repositoryId: repository.index.repositoryId, repositoryPath: repository.path, course: repository.course, analysis: repository.analysis, index: repository.index, database, overlays });
  return {
    database,
    repositoryId: repository.index.repositoryId,
    course: input.course,
    analysis: repository.analysis,
    // 线程 id 带上去：审计里「这次改动是谁在哪个会话里说的」要能回到那一轮对话（与 set_architecture 那一路同款）
    journal: { append: (type, payload) => new Journal(repository.path, repository.index.repositoryId).append(type, payload, sessionId) },
    onApplied: (event) => broadcast({ type: "diagram_updated", payload: { repositoryId: event.repositoryId, diagramId: event.diagramId, action: event.action } })
  };
}

/**
  本轮的静态产物查询门（**只给 map 作用域**，与 `set_diagram` 配对：那边写图，这边给证据）。

  盘上一行产物都没有时回 `undefined`：那时这个工具每次只会答「不在册」，给了反而让模型去调
  一扇没有内容的门（与 `crossRepoFor`「没有第二个仓就一个工具不多给」同一条纪律）。
  它也**不触发重算**——绘图阶段只消费导入时算好的读数。
*/
export function factsToolFor(repository: ImportedRepository, database: TutorDatabase): FactsToolContext | undefined {
  const repositoryId = repository.index.repositoryId;
  return database.factCoverage(repositoryId).length ? factsQueryTool(database, repositoryId) : undefined;
}

/**
  本轮的改图工具面（**只给 map 作用域**，与 `set_architecture` 同一道闸；教学与练习两张脸永远不给）。
  界面上没有第二条结构写路径，所以这是 agent 唯一能改图的入口：校验、降档、存版、审计、广播全在
  `applyDiagramEdit` 一处，这一层只做「把参数原语翻成请求 + 把回执说回去」。
  与 `set_architecture` 同一条纪律：**没有模型也能用**（它不发消息，只写本地产物），所以这里不卡 `lightLlmProvider`。
  `openDiagramId` 是界面随请求带上来的「画布上现在正打开那张」：用户说「把这条边删掉」时，
  这句话的指代对象是**他眼前那张**，不是图库里最近更新那张——所以它既进上下文（标出哪张是打开的），
  也进写侧（`edit.diagram` 省略时按它落点）。认不出就拒，绝不猜（见 `resolveTarget`）。
*/
export function setDiagramToolFor(repository: ImportedRepository, database: TutorDatabase, sessionId?: string, openDiagramId?: string, onWrite?: (diagram: { id: string; name: string }) => void): SetDiagramToolContext {
  const context = () => diagramWriteContextFor(repository, database, sessionId);
  return {
    inventory: diagramInventoryFor(context(), openDiagramId),
    apply: (argumentsJson: string) => {
      const parsed = parseDiagramEditArguments(argumentsJson);
      const note = parsed.ignored.length ? `（多余字段 ${[...new Set(parsed.ignored)].join(" / ")} 已忽略：这一层只认那九种动作各自的字段，边上「降过档」那一格由引擎写）` : "";
      if (parsed.error) return `没改：${parsed.error}。${note}`;
      const outcome = applyDiagramEdit(context(), parsed.request!, "agent");
      // 真落了盘才回报给路由：界面上那张图卡片要挂在「这句话画出了这张图」上，
      // 拒写的回合也挂一张卡就是替模型撒谎（它可能一次试了三遍才画对）。
      if (outcome.ok && outcome.diagram) onWrite?.({ id: outcome.diagram.id, name: outcome.diagram.name });
      return `${outcome.text}${note}`;
    }
  };
}

/**
  架构修正工具的装配（**map 作用域每一轮都给**；practice 与教学作用域永远不给）。
  以前还要「这一轮绑到了模块地图里的节点」才给，于是用户在架构画布上直接说一句「把它挪到编排层」时
  工具压根不在清单里，模型只能嘴上答（2026-10-16 用户指出：画布是只读的，改图只有 agent 这一条路，
  那就不能要求说话前先在左栏点进某个模块）。
  三条纪律：
  - 校验层名用的是「现在图上的层」，从缓存产物读，**绝不为了校验去发一发模型**——
    用户说一句「把它挪到编排层」不该变成一笔重判的钱；
  - 落盘走 `commitOverride`，与 GUI 拖动同一条写路径：校验、写盘、审计、通知四步一次做完；
  - 清单（`inventory`）进上下文：修正存在引擎里，横幅读得到、对话读不到，模型没有「现在有哪几条、节点叫什么 id」
    就只会反问或编一个 id 撞在写侧白名单上。
*/
export function architectureToolFor(repository: ImportedRepository, database: TutorDatabase, sessionId?: string): ArchitectureToolContext | undefined {
  const lightLlmProvider = lightLlm();
  if (!lightLlmProvider) return undefined;
  const overlays = readOverlays(database, repository.index.repositoryId);
  const input = architectureInputOf({ repositoryId: repository.index.repositoryId, repositoryPath: repository.path, course: repository.course, analysis: repository.analysis, index: repository.index, database, overlays });
  const peek = peekCachedArchitecture({ ...input, provider: lightLlmProvider });
  const titleById = new Map(peek.blocks.map((block) => [block.id, block.title]));
  const titleOf = (unitId: string): string => titleById.get(unitId) ?? findCourseNode(input.course.root, unitId)?.title ?? unitId;
  const lost = new Set(peek.lost.map((loss) => (loss.kind === "move_module" ? `move:${loss.module}` : `rename:${loss.from}`)));
  const corrections = [
    ...Object.entries(overlays.architecture?.moduleLayer ?? {}).map(([unitId, layer]) => `- 把「${titleOf(unitId)}」挪进「${layer}」（id=${unitId}）${lost.has(`move:${unitId}`) ? "｜这条这次没接上：现在这份判层里没有这一层，或这个 id 已不在树上" : ""}`),
    ...Object.entries(overlays.architecture?.layerRenames ?? {}).map(([from, to]) => `- 层名「${from}」改成了「${to}」${lost.has(`rename:${from}`) ? "｜这条这次没接上：原判层里没有这个旧层名" : ""}`),
    ...Object.entries(overlays.modules?.tier ?? {}).map(([unitId, tier]) => `- 「${titleOf(unitId)}」的结构档改成 ${tier}（id=${unitId}）`)
  ];
  const layers = peek.layout.length
    ? peek.layout.map((layer) => `${layer.name}：${layer.moduleIds.map((unitId) => `${titleOf(unitId)}（${unitId}）`).join("；") || "（空）"}`).join("\n")
    : "（现在图上没有分层：这份产物还没判过层。要改归属，得先让用户自己点「重新生成分层」，这一发不由你代点。）";
  return {
    // 「画布上这张是被批准替换的那张 / 正压着一张预览」那两段随重绘流水线一起退了（2026-10-18）：
    // 分层判断只有一份，就是缓存里那份判层叠上覆盖层；图是图库里的独立实体，它的现场由 `set_diagram` 那份 inventory 给
    inventory: `架构现场（要动哪个节点就用这里给的 id）：\n${layers}\n现存人工修正（叠在模型原判上，每次读实时叠加）：\n${corrections.length ? corrections.join("\n") : "（一条也没有）"}\n撤销分三种：reset 给 module 只撤那个节点；reset 给 from 或 to 只撤一条改名；reset 两个都不给＝把这个仓所有修正一次清空（只有用户明确要全清时才这样）。`,
    apply: (argumentsJson: string) => {
      const parsed = parseOverrideArguments(argumentsJson);
      const note = parsed.ignored.length ? `（多余字段 ${parsed.ignored.join(" / ")} 已忽略：边、模块清单与文件路径不在可改范围内）` : "";
      if (parsed.error) return `没改：${parsed.error}。${note}`;
      return `${applyOverrideIntent(repository, database, parsed.intent as OverrideIntent, "agent", sessionId).text}${note}`;
    }
  };
}

/** 一次人工修正的落地：校验 → 写盘 → 审计 → 通知。GUI 的拖动与 Agent 的工具都走这一个函数。 */
export function applyOverrideIntent(repository: ImportedRepository, database: TutorDatabase, intent: OverrideIntent, via: OverrideVia, sessionId?: string) {
  const overlays = readOverlays(database, repository.index.repositoryId);
  const lightLlmProvider = lightLlm();
  if (!lightLlmProvider) return { ok: false, text: "没改：这份产物还没配模型，图上没有可改的层。", overlays };
  /** 与两条读出口同一份输入构造（tier 实时计算 + 覆盖层）——这里曾经少叠一档，结果真仓上每次拖动都被自己的层名校验拒掉 */
  const input = architectureInputOf({ repositoryId: repository.index.repositoryId, repositoryPath: repository.path, course: repository.course, analysis: repository.analysis, index: repository.index, database, overlays });
  const peek = peekCachedArchitecture({ ...input, provider: lightLlmProvider });
  const outcome = commitOverride({
    database,
    repositoryId: repository.index.repositoryId,
    course: input.course,
    layers: peek.layers,
    blocks: peek.blocks,
    journal: { append: (type, payload) => new Journal(repository.path, repository.index.repositoryId).append(type, payload, sessionId) },
    onApplied: (event) => broadcast({ type: "architecture_updated", payload: { repositoryId: event.repositoryId, module: event.module ?? null, via: event.via } })
  }, intent, via);
  return { ...outcome, layers: peek.layers };
}
