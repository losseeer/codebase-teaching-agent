import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRouteFixture } from "../../adapter/inbound/http/controller-test-kit.js";

/** 独立 fixture：临时 registry / learner.db，不与其他测试文件共享 contribution 行数。 */
const fx = createRouteFixture();

// fixture 要启动整个 server（含沙箱探测），本机超过 vitest 默认的 10s hook 上限
beforeAll(async () => { await fx.mount(); }, 60_000);
afterAll(async () => { await fx.teardown(); }, 60_000);

describe("跨仓画像：按地址簿补跑历史判分", () => {
  it("没显式挂载的仓，journal 里的 exercise_result 也会进 contribution", async () => {
    const { Journal } = await import("../../adapter/outbound/persistence/journal.js");
    const { learnerStore } = await import("../../infrastructure/composition-root.js");
    const { backfillContributionsFromCatalog } = await import("./learner.js");

    const before = learnerStore.listContributions({ repositoryId: fx.repositoryId }).length;
    new Journal(fx.repoDir, fx.repositoryId).append("exercise_result", {
      exercise_id: "ex-backfill-1", target_unit_id: "llm:backfill:0",
      passed: true, score: 1, grading_mode: "rubric", attempt_kind: "first"
    });

    // 只往 journal 写了事件，没走 mountRepositoryUseCase —— 这正是原来的死链
    expect(learnerStore.listContributions({ repositoryId: fx.repositoryId })).toHaveLength(before);

    backfillContributionsFromCatalog();
    const rows = learnerStore.listContributions({ repositoryId: fx.repositoryId });
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ exerciseId: "ex-backfill-1", unitId: "llm:backfill:0", passed: true });
  });

  it("重复补跑不翻倍；之后新增的判分会被增量补进来", async () => {
    const { Journal } = await import("../../adapter/outbound/persistence/journal.js");
    const { learnerStore } = await import("../../infrastructure/composition-root.js");
    const { backfillContributionsFromCatalog } = await import("./learner.js");

    backfillContributionsFromCatalog();
    const afterRepeat = learnerStore.listContributions({ repositoryId: fx.repositoryId }).length;

    new Journal(fx.repoDir, fx.repositoryId).append("exercise_result", {
      exercise_id: "ex-backfill-2", target_unit_id: "llm:backfill:1",
      passed: false, score: 0, grading_mode: "rubric", attempt_kind: "first"
    });
    backfillContributionsFromCatalog();
    const rows = learnerStore.listContributions({ repositoryId: fx.repositoryId });
    expect(rows).toHaveLength(afterRepeat + 1);
    expect(rows.at(-1)).toMatchObject({ exerciseId: "ex-backfill-2", passed: false });
  });
});
