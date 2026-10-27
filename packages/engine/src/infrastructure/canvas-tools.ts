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

/**
  画布这条写路径的装配层：agent 的 `set_diagram` 改图工具与界面拖动共用的那一份上下文。
  「图不存在」那条回复留在路由层（它要 `reply`），这里只放构造上下文与落地修正。
*/

/**
  一次图写入的上下文。`ref` 校验用索引与依赖图（文件/目录/符号），不再依赖课程树；
  写侧与读侧必须用同一份解析器，否则会出现「界面正画着这个节点，工具却说它查无此人」。
*/
export function diagramWriteContextFor(repository: ImportedRepository, database: TutorDatabase, sessionId?: string): DiagramWriteContext {
  return {
    // 端口在存储侧就地绑定（闭包掉库句柄与仓 id）：画图那一侧从此不认识 SQLite
    store: diagramStoreFor(database, repository.index.repositoryId),
    repositoryId: repository.index.repositoryId,
    index: repository.index,
    analysis: repository.analysis,
    // 带上线程 id：审计要能从这次改动回到那一轮对话
    journal: { append: (type, payload) => repository.audit.append(type, payload, sessionId) },
    // 第四张结构表：产物层里的类型关系与运行时绑定（Spring 这类仓里「注入」那条线代码中没有直接调用）
    facts: factsPairChecker({
      typeRelations: () => database.facts.listByKind<TypeRelationFileFact>(repository.index.repositoryId, "typeRelations"),
      registry: () => database.facts.listByKind<RegistryFileFact>(repository.index.repositoryId, "registry")
    }),
    onApplied: (event) => broadcast({ type: "diagram_updated", payload: { repositoryId: event.repositoryId, diagramId: event.diagramId, action: event.action } })
  };
}

/**
  本轮的静态产物查询门（只给 map 作用域，与 `set_diagram` 配对：那边写图，这边给证据）。
  **仓里一行产物都没有时也照开**：绘图技能的第一条取证步就是这扇门，关掉它模型只能从「工具不在清单里」反推没有产物，
  而那一步推出来的结论常是「这轮画不了」。门自己会说实话（`本仓还没有静态产物…`），缺席于是成了一条读数。
  不触发重算——绘图阶段只消费导入时算好的读数。
*/
export function factsToolFor(repository: ImportedRepository, database: TutorDatabase): FactsToolContext {
  return factsQueryTool(database, repository.index.repositoryId);
}

/**
  本轮的改图工具面（只给 map 作用域；教学与练习两张脸永远不给）。
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

