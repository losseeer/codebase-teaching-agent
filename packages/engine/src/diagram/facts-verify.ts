import type { RegistryFileFact, TypeRelationFileFact } from "@codebase-tutor/domain";

/**
  证据表：静态产物里的类型关系与运行时绑定。
  只确认、绝不上抬。
*/

export interface FactEvidence {
  origin: "static";
  detail: string;
}

export type FactsPairChecker = (fromFiles: string[], toFiles: string[]) => FactEvidence | undefined;

const key = (from: string, to: string): string => `${from}\u0000${to}`;

/** 取两类产物的通道由装配层给：这一层不认 SQLite。 */
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
        // 注入点文件 → 声明该类型的文件；同名多解时每个都是候选落点。
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
