import type { FactsToolContext, ModuleTierToolContext, SetDiagramToolContext } from "../source/tool-loop.js";
import type { RegistryFileFact, TypeRelationFileFact } from "@codebase-tutor/shared";
import type { ImportedRepository } from "../importer/importer.js";
import type { TutorDatabase } from "../store/database.js";
import type { DiagramWriteContext } from "../diagram/set-diagram.js";
import { applyDiagramEdit, diagramInventoryFor, parseDiagramEditArguments } from "../diagram/set-diagram.js";
import { factsPairChecker } from "../diagram/facts-verify.js";
import { factsQueryTool } from "../facts/query.js";
import { moduleCourseOf, moduleNodes } from "../coursetree/blockmap.js";
import { commitOverride, parseOverrideArguments, type OverrideIntent, type OverrideVia } from "../coursetree/override-writer.js";
import { readOverlays } from "../store/overlays.js";
import { Journal } from "../store/journal.js";
import { broadcast } from "../events.js";

/**
  画布这条写路径的装配层：agent 的三个写工具（`set_diagram` 改结构、`set_module_tier` 改档）
  与界面拖动共用的那一份上下文。都不是 HTTP 的事。
  「图不存在」那条回复留在路由层（它要 `reply`），这里只放构造上下文与落地修正。
*/

/**
  一次图写入的上下文。`course` 取 `moduleCourseOf` 那份（实时算完 tier、叠过覆盖层之后的树）：
  写侧核 `ref` 用的模块清单必须和读侧画出来的同一份，否则会出现「界面正画着这个节点，
  工具却说它查无此人」。构造口径只留一处。
*/
export function diagramWriteContextFor(repository: ImportedRepository, database: TutorDatabase, sessionId?: string): DiagramWriteContext {
  const overlays = readOverlays(database, repository.index.repositoryId);
  return {
    database,
    repositoryId: repository.index.repositoryId,
    course: moduleCourseOf(repository.course, repository.analysis, repository.index, overlays),
    analysis: repository.analysis,
    // 带上线程 id：审计要能从这次改动回到那一轮对话
    journal: { append: (type, payload) => new Journal(repository.path, repository.index.repositoryId).append(type, payload, sessionId) },
    // 第四张结构表：产物层里的类型关系与运行时绑定（Spring 这类仓里「注入」那条线代码中没有直接调用）
    facts: factsPairChecker({
      typeRelations: () => database.listFileFacts<TypeRelationFileFact>(repository.index.repositoryId, "typeRelations"),
      registry: () => database.listFileFacts<RegistryFileFact>(repository.index.repositoryId, "registry")
    }),
    onApplied: (event) => broadcast({ type: "diagram_updated", payload: { repositoryId: event.repositoryId, diagramId: event.diagramId, action: event.action } })
  };
}

/**
  本轮的静态产物查询门（只给 map 作用域，与 `set_diagram` 配对：那边写图，这边给证据）。
  盘上一行产物都没有时回 `undefined`：那时它每次只会答「不在册」，给了反而让模型去调一扇没有内容的门。
  不触发重算——绘图阶段只消费导入时算好的读数。
*/
export function factsToolFor(repository: ImportedRepository, database: TutorDatabase): FactsToolContext | undefined {
  const repositoryId = repository.index.repositoryId;
  return database.factCoverage(repositoryId).length ? factsQueryTool(database, repositoryId) : undefined;
}

/**
  本轮的改图工具面（只给 map 作用域，与 `set_module_tier` 同一道闸；教学与练习两张脸永远不给）。
  校验、降档、存版、审计、广播全在 `applyDiagramEdit` 一处，这一层只把参数原语翻成请求、把回执说回去。
  `openDiagramId` 是界面随请求带上来的「画布上现在正打开那张」：用户说「把这条边删掉」指的是他眼前那张，
  不是图库里最近更新那张——所以它既进上下文（标出哪张是打开的），也进写侧（`edit.diagram` 省略时按它落点）。
  认不出就拒，绝不猜（见 `resolveTarget`）。
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
      // 真落了盘才回报给路由：图卡片要挂在「这句话画出了这张图」上，拒写的回合也挂一张卡是替模型撒谎
      if (outcome.ok && outcome.diagram) onWrite?.({ id: outcome.diagram.id, name: outcome.diagram.name });
      return `${outcome.text}${note}`;
    }
  };
}

/**
  模块档位工具的装配（map 作用域每一轮都给；practice 与教学作用域永远不给）。
  三条纪律：
  - 只改「结构档」这一个判断题，层、边、文件都不在可改范围内；
  - 落盘走 `commitOverride`，与浏览器旧值迁移同一条写路径：校验、写盘、审计、通知四步一次做完；
  - 清单（`inventory`）进上下文：修正存在引擎里，对话读不到，模型没有「现在有哪几条、节点叫什么 id」
    就只会反问或编一个 id，被写侧白名单拒掉。
*/
export function moduleTierToolFor(repository: ImportedRepository, database: TutorDatabase, sessionId?: string): ModuleTierToolContext {
  const overlays = readOverlays(database, repository.index.repositoryId);
  const course = moduleCourseOf(repository.course, repository.analysis, repository.index, overlays);
  const modules = moduleNodes(course);
  const titleOf = new Map(modules.map((node) => [node.id, node.title]));
  const lines = modules.slice(0, 80).map((node) => `- ${node.title}（id=${node.id}，引擎判=${node.tierGiven ?? node.tier ?? "未分级"}${node.tierOverridden ? `，人工改成 ${node.tier}` : ""}）`);
  const omitted = modules.length > 80 ? `\n…其余 ${modules.length - 80} 个模块未列出。` : "";
  const corrections = Object.entries(overlays.modules?.tier ?? {}).map(([moduleId, tier]) => `- 「${titleOf.get(moduleId) ?? moduleId}」的结构档改成 ${tier}（id=${moduleId}）`);
  return {
    inventory: `模块地图（要改哪个模块就用这里给的 id）：\n${lines.join("\n") || "（这个仓没有模块地图）"}${omitted}\n现有人工改档：${corrections.length ? corrections.join("\n") : "（一条也没有）"}\n撤销：reset 给 module 只撤那个模块的改档；reset 不给 module＝把这个仓所有人工修正一次清空（只有用户明确要全清时才这样）。`,
    apply: (argumentsJson: string) => {
      const parsed = parseOverrideArguments(argumentsJson);
      const note = parsed.ignored.length ? `（多余字段 ${parsed.ignored.join(" / ")} 已忽略：层、边、模块清单与文件路径不在可改范围内）` : "";
      if (parsed.error) return `没改：${parsed.error}。${note}`;
      return `${applyModuleTierIntent(repository, database, parsed.intent as OverrideIntent, "agent", sessionId).text}${note}`;
    }
  };
}

/** 一次档位修正的落地：校验 → 写盘 → 审计 → 通知。Agent 的工具与浏览器旧值迁移都走这一个函数。 */
export function applyModuleTierIntent(repository: ImportedRepository, database: TutorDatabase, intent: OverrideIntent, via: OverrideVia, sessionId?: string) {
  const overlays = readOverlays(database, repository.index.repositoryId);
  const course = moduleCourseOf(repository.course, repository.analysis, repository.index, overlays);
  const outcome = commitOverride({
    database,
    repositoryId: repository.index.repositoryId,
    course,
    journal: { append: (type, payload) => new Journal(repository.path, repository.index.repositoryId).append(type, payload, sessionId) },
    onApplied: (event) => broadcast({ type: "repository.updated", payload: { repositoryId: event.repositoryId, changedPaths: [], impactedPaths: [] } })
  }, intent, via);
  return outcome;
}
