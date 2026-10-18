import type { FlowStage } from "@codebase-tutor/shared";

/**
  请求体与查询串 → 领域值。外部输入形状不可信，所以逐字段核类型、截长、重建对象，
  而不是 `as` 一下就往引擎里传。这里只有守卫，没有任何业务判断。
*/

// ——— 从 server.ts 369-398 搬来 ———
/** 流程视图选中环节（入参守卫）：逐字段核类型并截长后重建——请求体是外部输入，形状不可信；字段不齐即视为没选环节。 */
export function sanitizeChatFocus(value: unknown): FlowStage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const stage = value as { order?: unknown; kind?: unknown; title?: unknown; detail?: unknown; files?: unknown; branches?: unknown; loopsTo?: unknown };
  if (typeof stage.order !== "number" || !Number.isFinite(stage.order)) return undefined;
  if (typeof stage.title !== "string" || !stage.title.trim()) return undefined;
  const kinds = ["entry", "stage", "decision", "loop", "exit"] as const;
  const kind = kinds.find((item) => item === stage.kind) ?? "stage";
  const files = Array.isArray(stage.files)
    ? stage.files.flatMap((item): { path: string; line: number; note?: string }[] => {
        if (typeof item !== "object" || item === null) return [];
        const file = item as { path?: unknown; line?: unknown; note?: unknown };
        if (typeof file.path !== "string" || !file.path.trim() || file.path.length > 400) return [];
        const line = typeof file.line === "number" && Number.isFinite(file.line) ? Math.max(0, Math.trunc(file.line)) : 1;
        return [{ path: file.path.trim(), line, ...(typeof file.note === "string" && file.note.trim() ? { note: file.note.trim().slice(0, 120) } : {}) }];
      }).slice(0, 200)
    : [];
  const branches = Array.isArray(stage.branches)
    ? stage.branches.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 160)).slice(0, 20)
    : [];
  return {
    order: Math.trunc(stage.order),
    kind,
    title: stage.title.trim().slice(0, 120),
    detail: typeof stage.detail === "string" ? stage.detail.trim().slice(0, 600) : "",
    files,
    branches,
    ...(typeof stage.loopsTo === "number" && Number.isFinite(stage.loopsTo) ? { loopsTo: Math.trunc(stage.loopsTo) } : {})
  };
}

// ——— 从 server.ts 316-337 搬来 ———

/** GUI 上送的 scopePaths（架构图 chip 的文件清单）：只留非空字符串、去重封顶。它是提示而非裁决——未知路径由引擎交集丢弃。 */
export function sanitizeScopePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 400))];
  return paths.length ? paths.slice(0, 1_000) : undefined;
}

/** 线程 id 入参守卫：非空字符串、截长；没给就是「无会话线程」（单次提问，不带历史也不落库）。 */
export function sanitizeThreadId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

/**
  「画布上正打开的那张图」入参守卫：它只当**句柄**用（标进上下文、当结构改动的默认落点），
  所以和线程 id 同一档处理——收长度、不做存在性校验。
  指不到一张真图时由写侧回一句「没有这张图，图库现在是…」，比在这里 400 更有指导性；
  而界面刷新间隙里带着一个旧 id 说话是常态，那儿拦一次就把用户的整句话打回去了。
*/
export function sanitizeDiagramId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}
