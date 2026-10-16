import { expect, test } from "@playwright/test";

test("opens the local repository import workflow", async ({ page }) => {
  await page.goto("/import");
  await expect(page.getByRole("heading", { name: "导入一个代码仓库" })).toBeVisible();
  await expect(page.getByLabel("仓库绝对路径")).toBeVisible();
});
