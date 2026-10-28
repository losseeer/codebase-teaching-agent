import type { FactsToolContext, SetDiagramToolContext } from "../source/tool-loop.js";
import type { RegistryFileFact, TypeRelationFileFact } from "@codebase-tutor/domain";

import type { ImportedRepository } from "../importer/importer.js";
import type { TutorDatabase } from "../adapter/outbound/persistence/database.js";
import type { DiagramWriteContext } from "../diagram/set-diagram.js";
import { applyDiagramEdit, diagramInventoryFor, parseDiagramEditArguments } from "../diagram/set-diagram.js";
import { factsPairChecker } from "../diagram/facts-verify.js";
import { factsQueryTool } from "../facts/query.js";
import { diagramStoreFor } from "../adapter/outbound/persistence/diagrams.js";
import { broadcast } from "../events.js";

/** 画布写路径的装配层：构造 `set_diagram` 与界面拖动共用的那一份上下文。 */

/** 一次图写入的上下文：存储、索引、依赖图、审计与产物核验。 */
export function diagramWriteContextFor(repository: ImportedRepository, database: TutorDatabase, sessionId?: string): DiagramWriteContext {
  return {
    store: diagramStoreFor(database, repository.index.repositoryId),
    repositoryId: repository.index.repositoryId,
    index: repository.index,
    analysis: repository.analysis,
    // 审计行带上本轮线程 id。
    journal: { append: (type, payload) => repository.audit.append(type, payload, sessionId) },
    // 核验边用的两类产物：类型关系与注册条目。
    facts: factsPairChecker({
      typeRelations: () => database.facts.listByKind<TypeRelationFileFact>(repository.index.repositoryId, "typeRelations"),
      registry: () => database.facts.listByKind<RegistryFileFact>(repository.index.repositoryId, "registry")
    }),
    onApplied: (event) => broadcast({ type: "diagram_updated", payload: { repositoryId: event.repositoryId, diagramId: event.diagramId, action: event.action } })
  };
}

/** 本轮的静态产物查询门；仓里没有产物时也返回，由门自己说明没有产物。 */
export function factsToolFor(repository: ImportedRepository, database: TutorDatabase): FactsToolContext {
  return factsQueryTool(database, repository.index.repositoryId);
}

/** 本轮的改图工具面；`openDiagramId` 是 `edit.diagram` 省略时的落点，认不出就拒。 */
export function setDiagramToolFor(repository: ImportedRepository, database: TutorDatabase, sessionId?: string, openDiagramId?: string, onWrite?: (diagram: { id: string; name: string }) => void): SetDiagramToolContext {
  const context = () => diagramWriteContextFor(repository, database, sessionId);
  return {
    inventory: diagramInventoryFor(context(), openDiagramId),
    apply: (argumentsJson: string) => {
      const parsed = parseDiagramEditArguments(argumentsJson);
      const note = parsed.ignored.length ? `（多余字段 ${[...new Set(parsed.ignored)].join(" / ")} 已忽略：这一层只认那九种动作各自的字段，边上「降过档」那一格由引擎写）` : "";
      if (parsed.error) return `没改：${parsed.error}。${note}`;
      const outcome = applyDiagramEdit(context(), parsed.request!, "agent");
      if (outcome.ok && outcome.diagram) onWrite?.({ id: outcome.diagram.id, name: outcome.diagram.name });
      return `${outcome.text}${note}`;
    }
  };
}

