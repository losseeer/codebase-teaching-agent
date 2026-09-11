import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryAnalysis } from "@codebase-tutor/shared";
import { buildDependencyGraph, serializeGraph } from "../depgraph/graph.js";
import { indexRepository } from "../indexer/indexer.js";
import { readJournal } from "../store/journal.js";
import { CompanionService, type CompanionRepository } from "./service.js";
import { evaluateTeachMoment, type CompanionTimingContext } from "./timing.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("M2.2 companion timing", () => {
  it("creates an impact-review moment for a relevant PostToolUse edit", async () => {
    const repository = testRepository();
    const result = await evaluateTeachMoment({ hookEventName: "PostToolUse", toolName: "Edit", cwd: repository.path, toolInput: { file_path: join(repository.path, "src/config.js") } }, timingContext(repository));
    expect(result).toMatchObject({ accepted: true, discarded: false, flow: "transition", path: "src/config.js" });
    expect(result.impactedPaths).toContain("src/main.js");
    expect(result.latencyMs).toBeLessThan(500);
  });

  it("does not interrupt focused, unrelated tool use", async () => {
    const repository = testRepository();
    const result = await evaluateTeachMoment({ hookEventName: "PostToolUse", toolName: "Read", cwd: repository.path, toolInput: { file_path: "/tmp/unrelated.txt" } }, timingContext(repository));
    expect(result).toMatchObject({ accepted: false, discarded: false, flow: "focused", relevance: 0 });
    expect(result.latencyMs).toBeLessThan(500);
  });

  it("discards a late relevance result at the latency boundary", async () => {
    const repository = testRepository();
    const result = await evaluateTeachMoment({ hookEventName: "PostToolUse", toolName: "Edit", cwd: repository.path, path: "src/config.js" }, timingContext(repository), {
      timeoutMs: 5,
      assessRelevance: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { relevance: 1, path: "src/config.js", impactedPaths: ["src/config.js"], reason: "late" };
      }
    });
    expect(result).toMatchObject({ accepted: false, discarded: true });
    expect(result.latencyMs).toBeLessThan(500);
  });
});

describe("M2.2 companion suggestions", () => {
  it("stores a suggestion separately and journals every learner action", async () => {
    const repository = testRepository();
    const service = new CompanionService();
    const received = await service.receivePostToolUse(repository, { hookEventName: "PostToolUse", toolName: "Edit", cwd: repository.path, path: "src/config.js" });
    expect(received.suggestion?.kind).toBe("impact_review");
    expect(service.list(repository)).toHaveLength(1);

    const accepted = service.act(repository, received.suggestion!.id, "accepted");
    expect(accepted.status).toBe("accepted");
    const dismissed = await service.receivePostToolUse(repository, { hookEventName: "PostToolUse", toolName: "Edit", cwd: repository.path, path: "src/config.js" });
    expect(service.act(repository, dismissed.suggestion!.id, "dismissed").status).toBe("dismissed");
    const later = await service.receivePostToolUse(repository, { hookEventName: "PostToolUse", toolName: "Edit", cwd: repository.path, path: "src/config.js" });
    expect(service.act(repository, later.suggestion!.id, "later").status).toBe("later");
    expect(service.list(repository)).toHaveLength(0);
    expect(service.summary(repository)).toMatchObject({ pendingCount: 0, actionCount: 3, acceptanceRate: 1 / 3 });
    const action = readJournal(repository.path).find((event) => event.type === "teach_moment" && event.payload.phase === "action" && event.payload.action === "accepted");
    expect(action?.payload).toMatchObject({ action: "accepted", accepted: true, suggestion_id: received.suggestion!.id });
  });
});

function testRepository(): CompanionRepository {
  const directory = mkdtempSync(join(tmpdir(), "codebase-tutor-companion-"));
  temporaryDirectories.push(directory);
  const repositoryPath = join(directory, "fixture");
  cpSync(fixture, repositoryPath, { recursive: true, filter: (source) => !source.endsWith("/.tutor") && !source.includes("/.tutor/") });
  const index = indexRepository(repositoryPath);
  const graph = buildDependencyGraph(repositoryPath, index.files);
  const analysis: RepositoryAnalysis = {
    repositoryId: index.repositoryId,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: serializeGraph(graph),
    decisions: [],
    implementations: [],
    quality: { generatedAt: "2026-01-01T00:00:00.000Z", micro: [], macro: [] },
    versionStamp: "content-v1"
  };
  return { path: repositoryPath, index, analysis };
}

function timingContext(repository: CompanionRepository): CompanionTimingContext {
  return { repositoryPath: repository.path, index: repository.index, analysis: repository.analysis };
}
