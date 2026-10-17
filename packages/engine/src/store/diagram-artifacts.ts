import type { DiagramDraft, DiagramKind, DiagramReadout, DiagramStatus } from "@codebase-tutor/shared";
import type { TutorDatabase } from "./database.js";

/**
  「agent 重绘的图」的唯一读写口（表在 `store/database.ts` 的 `diagram_artifact`）。

  为什么不复用 `layer_cache`：那张表每次写入都按 `at` 无差别删掉过龄的行（默认 7 天），
  语义是「输入变了就没人再命中的缓存」。而 `committed` 这一行是**用户点头留下的判断**，
  闲置七天后被一次无关的写入清掉，等于系统替用户撤了他的决定。

  状态机只有三个节点，各占一行（主键含 status）：`pending` 等用户确认这一发钱、`preview` 等用户点替换、
  `committed` 就是现在画布上那张。默认那份**不在这张表里**——它仍由 `coursetree/architecture.ts` 实时计算实时叠加，
  所以「恢复默认」= 删掉 `committed`，不可能顺带把模型的判层删了。
*/

interface StoredRow {
  value: DiagramDraft | null;
  purpose: string;
  at: number;
}

/** `pending` 那一行只需要 purpose（还没画），payload 存 null；SQLite 的 NOT NULL 位留个 `null` 比加一列老实。 */
function row(database: TutorDatabase, repositoryId: string, kind: DiagramKind, status: DiagramStatus): StoredRow | undefined {
  const found = database.getDiagramArtifact<DiagramDraft | null>(repositoryId, kind, status);
  return found ? { value: found.value, purpose: found.purpose, at: found.at } : undefined;
}

export function readDiagram(database: TutorDatabase, repositoryId: string, kind: DiagramKind): DiagramReadout & { committed?: StoredRow } {
  const committed = row(database, repositoryId, kind, "committed");
  const pending = row(database, repositoryId, kind, "pending");
  const preview = row(database, repositoryId, kind, "preview");
  return {
    origin: committed ? "agent" : "default",
    ...(committed ? { purpose: committed.purpose, committedAt: new Date(committed.at).toISOString() } : {}),
    ...(pending ? { pending: { purpose: pending.purpose, at: new Date(pending.at).toISOString() } } : {}),
    ...(preview && preview.value ? { preview: { purpose: preview.purpose, at: new Date(preview.at).toISOString(), draft: preview.value } } : {}),
    committed
  };
}

/** agent 提议重绘：只记下「它想按什么目的重绘」，**不发请求**。花钱那一下由用户在横幅上按。 */
export function requestRedraft(database: TutorDatabase, repositoryId: string, kind: DiagramKind, purpose: string): void {
  database.putDiagramArtifact(repositoryId, kind, "pending", null, purpose.slice(0, 120));
}

export function clearRedraft(database: TutorDatabase, repositoryId: string, kind: DiagramKind, status: Exclude<DiagramStatus, "committed">): boolean {
  const existed = Boolean(row(database, repositoryId, kind, status));
  database.dropDiagramArtifact(repositoryId, kind, status);
  return existed;
}

export function storePreview(database: TutorDatabase, repositoryId: string, kind: DiagramKind, purpose: string, draft: DiagramDraft): void {
  database.putDiagramArtifact(repositoryId, kind, "preview", draft, purpose.slice(0, 120));
}

/** 预览 → 已替换。没有预览就返回 false（模型不能跳过预览直接落库，那是它自己给自己批准）。 */
export function commitPreview(database: TutorDatabase, repositoryId: string, kind: DiagramKind): boolean {
  const preview = row(database, repositoryId, kind, "preview");
  if (!preview?.value) return false;
  database.putDiagramArtifact(repositoryId, kind, "committed", preview.value, preview.purpose);
  database.dropDiagramArtifact(repositoryId, kind, "preview");
  database.dropDiagramArtifact(repositoryId, kind, "pending");
  return true;
}

/** 恢复默认：只删这一行，默认那份本来就一直实时计算实时叠加着，没有「重建」这一步。 */
export function resetDiagram(database: TutorDatabase, repositoryId: string, kind: DiagramKind): boolean {
  const existed = Boolean(row(database, repositoryId, kind, "committed"));
  database.dropDiagramArtifact(repositoryId, kind, "committed");
  return existed;
}
