import { expect, test, type Page } from "@playwright/test";

import { ensureWorkspace, watchPageErrors } from "./helpers";

async function openSkills(page: Page): Promise<void> {
  await page.getByRole("button", { name: "用户设置" }).click();
  const menu = page.getByRole("menu", { name: "用户设置" });
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu.getByRole("menuitem", { name: "技能" }).click();
  await expect(page.getByRole("dialog", { name: "技能" })).toBeVisible({ timeout: 20_000 });
}

/** 技能正文必须带 frontmatter（引擎按 `---` 开头校验），这里生成一份最小的。 */
function skillDoc(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: e2e 用例\n---\n\n${body}\n`;
}

test("技能：新建 → 改正文保存 → 删除确认后从列表消失", async ({ page }) => {
  const errors = watchPageErrors(page);
  await ensureWorkspace(page);
  await openSkills(page);

  const dialog = page.getByRole("dialog", { name: "技能" });
  const name = `e2e-skill-${Date.now()}`;
  await page.getByLabel("新技能名").fill(name);
  await dialog.getByRole("button", { name: "新建" }).click();

  const item = dialog.locator(".skills-item", { hasText: name });
  await expect(item, "新建后应出现在列表里").toBeVisible({ timeout: 20_000 });

  await page.getByLabel("SKILL.md 正文").fill(skillDoc(name, "步骤一：只验证读写闭环。"));
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("技能已保存")).toBeVisible({ timeout: 20_000 });

  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.getByRole("button", { name: "删除", exact: true }).click();

  await expect(item, "删除后不该还在列表里").toHaveCount(0, { timeout: 20_000 });
  expect(errors.filter((text) => !text.includes("Failed to load resource"))).toEqual([]);
});

test("技能：保存后关掉重开仍能读到，收尾删掉不残留", async ({ page }) => {
  await ensureWorkspace(page);
  await openSkills(page);
  const dialog = page.getByRole("dialog", { name: "技能" });
  const name = `e2e-keep-${Date.now()}`;
  await page.getByLabel("新技能名").fill(name);
  await dialog.getByRole("button", { name: "新建" }).click();
  await expect(dialog.locator(".skills-item", { hasText: name })).toBeVisible({ timeout: 20_000 });

  const marker = `marker-${Date.now()}`;
  await page.getByLabel("SKILL.md 正文").fill(skillDoc(name, marker));
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("技能已保存")).toBeVisible({ timeout: 20_000 });

  await dialog.getByRole("button", { name: "关闭" }).click();
  await openSkills(page);
  const reopened = page.getByRole("dialog", { name: "技能" });
  await reopened.locator(".skills-item", { hasText: name }).click();
  await expect(page.getByLabel("SKILL.md 正文")).toHaveValue(new RegExp(marker), { timeout: 20_000 });

  await reopened.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(reopened.locator(".skills-item", { hasText: name })).toHaveCount(0, { timeout: 20_000 });
});

test("技能：正文缺 frontmatter 时明确报错，不会静默写坏", async ({ page }) => {
  await ensureWorkspace(page);
  await openSkills(page);
  const dialog = page.getByRole("dialog", { name: "技能" });
  const name = `e2e-bad-${Date.now()}`;
  await page.getByLabel("新技能名").fill(name);
  await dialog.getByRole("button", { name: "新建" }).click();
  await expect(dialog.locator(".skills-item", { hasText: name })).toBeVisible({ timeout: 20_000 });

  await page.getByLabel("SKILL.md 正文").fill("# 没有 frontmatter\n");
  await dialog.getByRole("button", { name: "保存" }).click();
  // 弹窗内 banner 与 toast 都会报同一句，取 toast 避免 strict 冲突
  await expect(page.getByRole("status").filter({ hasText: "操作失败" }), "缺 frontmatter 应当被拒").toBeVisible({ timeout: 20_000 });

  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "删除", exact: true }).click();
});
