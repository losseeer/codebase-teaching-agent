import type { RegistryFileFact, TypeRelationFileFact } from "@codebase-tutor/shared";

/**
  第四张结构表：已算好的静态产物里的**类型关系**与**运行时绑定**。
  为什么要有这一张：`set_diagram` 原先只核 import、调用、类型派发三张表，而 Spring 这类仓里
  「控制器 → 服务实现」这条线**常常三张表都没有**——代码里没有那一行直接调用（容器塞进来的），
  接口与实现之间也没有 import 方向上的重合。于是模型按事实画的边会被降成 `inferred`，
  读起来像「这条线是猜的」。产物层（刀 4、刀 5）正是为这种情况算的。

  档位口径与三张表一致：**只用来确认模型报的那一档，绝不上抬**（`settleEdge` 自己会挑高档）。
  `toFile` 空着的边（仓外类型、标准库、同名多解）在这里一条都不算——反查不到落点就不能当证据。
*/

export interface FactEvidence {
  origin: "static";
  detail: string;
}

export type FactsPairChecker = (fromFiles: string[], toFiles: string[]) => FactEvidence | undefined;

const key = (from: string, to: string): string => `${from}\u0000${to}`;

/**
  取两类产物的通道由装配层给（`application/canvas-tools.ts`）：这一层不认 SQLite，
  分层守卫那条「管线不许直接落 store/」的在册清单也就不会因为多一张表而变长。
*/
export interface FactSources {
  typeRelations: () => Map<string, TypeRelationFileFact>;
  registry: () => Map<string, RegistryFileFact>;
}

export function factsPairChecker(sources: FactSources): FactsPairChecker {
  let pairs: Map<string, string> | undefined;

  const build = (): Map<string, string> => {
    const rows = new Map<string, string>();
    const declared = new Map<string, string[]>();
    for (const [path, fact] of sources.typeRelations()) {
      for (const type of fact.types) {
        declared.set(type.name, [...(declared.get(type.name) ?? []), path]);
        for (const edge of type.relations) {
          if (!edge.toFile) continue;
          rows.set(key(path, edge.toFile), `${type.name} -${edge.kind}-> ${edge.to}（${edge.toFile}:${edge.line}，${edge.via}）`);
        }
      }
    }
    for (const [path, fact] of sources.registry()) {
      for (const entry of fact.entries) {
        if (entry.kind !== "di-binding" || !entry.name) continue;
        // 注入点所在文件 → 声明那个接口/类型的文件；同名多解时每一个都是候选落点，取不到就不写
        for (const target of declared.get(entry.name) ?? []) {
          if (target === path) continue;
          rows.set(key(path, target), `运行时绑定：${path}:${entry.line} 注入 ${entry.name}（${entry.via}）`);
        }
        for (const target of entry.target ? declared.get(entry.target) ?? [] : []) {
          if (target === path) continue;
          rows.set(key(path, target), `注册绑定：${entry.name} → ${entry.target}（${entry.via}，落在 ${target}）`);
        }
      }
    }
    return rows;
  };

  return (fromFiles, toFiles) => {
    pairs ??= build();
    for (const from of fromFiles) {
      for (const to of toFiles) {
        const detail = pairs.get(key(from, to));
        if (detail) return { origin: "static", detail };
      }
    }
    return undefined;
  };
}
