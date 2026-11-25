import { expect, test, type Page } from "@playwright/test";

import { ensureWorkspace, watchPageErrors } from "./helpers";

async function openUserMenu(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "用户设置" }).click();
  const menu = page.getByRole("menu", { name: "用户设置" });
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu.getByRole("menuitem", { name: item }).click();
}

test.beforeEach(async ({ page }) => {
  await ensureWorkspace(page);
});

test("用户设置菜单能打开画像、MCP、技能三个弹窗，Esc 各自关闭", async ({ page }) => {
  const errors = watchPageErrors(page);
  for (const [item, label] of [["记忆", "用户画像"], ["MCP 服务", "MCP 服务"], ["技能", "技能"]]) {
    await openUserMenu(page, item);
    const dialog = page.getByRole("dialog", { name: label });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  }
  expect(errors).toEqual([]);
});

test("模型配置弹窗能打开，Esc 关闭", async ({ page }) => {
  // 胶囊先展开配置菜单，再从菜单进管理弹窗
  await page.locator(".rail-model-pill").first().click();
  await page.getByText("管理配置…").click();
  const dialog = page.getByRole("dialog", { name: "模型与推理设置" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});

test("嵌套弹窗：删除配置的确认框按 Esc 只关自己，配置弹窗留着", async ({ page }) => {
  // 只有一份配置时删除是禁用的：先用接口另存一份，避免依赖另存为那串 UI 交互
  // 同名另存会被服务端拒（正确行为），用唯一名字保证可重复运行
  const captured = await page.request.post("/api/llm/profiles/capture", { data: { name: `E2E 副本 ${Date.now()}` } });
  expect(captured.ok(), `另存为配置失败：${await captured.text()}`).toBeTruthy();

  await page.locator(".rail-model-pill").first().click();
  await page.getByText("管理配置…").click();
  const dialog = page.getByRole("dialog", { name: "模型与推理设置" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  const drop = dialog.getByLabel("删除当前配置");
  await expect(drop, "有两份配置后删除应可用").toBeEnabled({ timeout: 20_000 });
  await drop.click();

  const confirm = page.getByRole("alertdialog", { name: /删除/ });
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");

  await expect(confirm, "确认框应被 Esc 关掉").toBeHidden({ timeout: 10_000 });
  await expect(dialog, "父级配置弹窗不该被连带关闭").toBeVisible();
});

test("主界面撑满视口，不出现页面级滚动条", async ({ page }) => {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { y: root.scrollHeight - root.clientHeight, x: root.scrollWidth - root.clientWidth };
  });
  expect(overflow.y, "纵向不该有整页滚动").toBe(0);
  expect(overflow.x, "横向不该有整页滚动").toBe(0);
});

test("成本页填入负数预算不会崩，页面仍可读", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto("/insights");
  const input = page.locator('input[type="number"]').first();
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill("-5");
  await input.blur();
  await expect(page.getByRole("img", { name: /预算已用/ })).toBeVisible();
  expect(errors).toEqual([]);
});
