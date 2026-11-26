/**
  打 @live 的用例会真调模型、真跑沙箱：默认不纳入 `pnpm test:e2e`（config 里 testIgnore），
  需要时 `E2E_LIVE=1 pnpm test:e2e`。跑完整组会覆盖掉 e2e 的伪端点，所以 afterEach 复原。
*/
import { expect, test } from "@playwright/test";

import { ensureWorkspace, sandboxNestedUsable, useFakeLlm, useLiveLlm } from "./helpers";

test.describe("@live 真实模型与沙箱", () => {
  test.afterEach(async ({ page }) => {
    await useFakeLlm(page);
  });

  test("@live 代码问答：真实发送一条，回复能上屏", async ({ page }) => {
    test.setTimeout(180_000);
    await ensureWorkspace(page);
    await useLiveLlm(page);

    await page.goto("/app?workspace=teaching");
    await page.locator(".tree-row", { hasText: "src" }).first().click();
    await page.getByTitle("src/main.js", { exact: true }).click();

    const input = page.getByRole("textbox", { name: /与 Codebase Agent 对话/ });
    await input.fill("用一句话说明这个文件做什么。");
    await page.getByRole("button", { name: "发送消息" }).click();

    await expect(page.locator(".msg-user .msg-bubble").last(), "用户消息先上屏").toContainText("用一句话", { timeout: 20_000 });
    await expect(page.locator(".msg-agent .msg-bubble").last(), "真实模型的回复应非空").toHaveText(/\S{2,}/, { timeout: 150_000 });
  });

  test("@live 练习：真实出题并在答题区展示题目", async ({ page }) => {
    // 代码题判分要真起沙箱。某些 agent 的执行环境不允许嵌套 sandbox-exec，这属于环境差异，跳过而不是判失败
    test.skip(!sandboxNestedUsable(), "本环境不能嵌套 sandbox-exec，代码题判分测不了");
    test.setTimeout(300_000);
    await ensureWorkspace(page);
    await useLiveLlm(page);

    await page.goto("/app?workspace=practice");
    // 设计题按主题挑代码：先建一个自定义主题并选中
    const themeName = `e2e 主题 ${Date.now()}`;
    await page.getByRole("button", { name: "管理主题" }).click();
    await page.getByLabel("新增主题名称").fill(themeName);
    await page.getByRole("button", { name: "添加" }).click();
    await page.getByRole("button", { name: "完成" }).click();
    await page.getByRole("tab", { name: themeName }).click();

    await page.getByRole("tab", { name: "程序设计" }).click();
    await page.getByRole("button", { name: "改代码" }).click();

    const generate = page.getByRole("button", { name: /生成练习/ });
    await expect(generate, "选了主题后应可生成").toBeEnabled({ timeout: 20_000 });
    await generate.click();

    await expect(page.locator(".exercise-title"), "真实出题应产出题目").toBeVisible({ timeout: 240_000 });
    await expect(page.getByText(/难度/).first()).toBeVisible();
  });
});
