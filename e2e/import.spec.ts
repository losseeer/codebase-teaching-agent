import { expect, test } from "@playwright/test";

import { ensureWorkspace, FIXTURE, watchPageErrors } from "./helpers";

test("导入页渲染出标题与路径输入，空路径时不能提交", async ({ page }) => {
  await page.goto("/import");
  await expect(page.getByRole("heading", { name: "导入一个代码仓库" })).toBeVisible();
  await expect(page.getByLabel("仓库绝对路径")).toBeVisible();
  await expect(page.getByRole("button", { name: /开始导入/ })).toBeDisabled();
});

test("未导入任何仓库时，工作区入口与成本监控不可点", async ({ page }) => {
  await page.goto("/import");
  // 未导入时这四项渲染成不可点的 span，而不是链接
  await expect(page.locator(".nav-item.disabled")).toHaveCount(4);
  await expect(page.locator(".nav-item.disabled", { hasText: "架构全景" })).toBeVisible();
});

test("填了不存在的路径会给出错误，不卡在导入中", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto("/import");
  await page.locator("#repo-path").fill("/tmp/definitely-not-a-repository-9f3a");
  await page.getByRole("button", { name: /开始导入/ }).click();
  await expect(page.getByText("分析发起失败")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /开始导入/ })).toBeEnabled({ timeout: 30_000 });
  // 预期的 400 会被浏览器记一条 "Failed to load resource"，那不是产品缺陷
  expect(errors.filter((text) => !text.includes("Failed to load resource")), "普通输入错误不该产生其它 console 报错").toEqual([]);
});

test("导入夹具仓：出现完成报告，并能进入架构全景", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto("/import");
  await page.locator("#repo-path").fill(FIXTURE);
  await page.getByRole("button", { name: /开始导入|重新分析/ }).click();
  await expect(page.getByText("导入完成报告")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/可分析文件/)).toBeVisible();
  await page.getByRole("button", { name: /进入架构全景/ }).click();
  await expect(page).toHaveURL(/workspace=map/);
  expect(errors).toEqual([]);
});

test("侧栏四个入口可切换，旧路由重定向到对应工作区", async ({ page }) => {
  await ensureWorkspace(page);
  await page.getByRole("link", { name: "代码问答" }).click();
  await expect(page).toHaveURL(/workspace=teaching/);
  await page.getByRole("link", { name: "练习" }).click();
  await expect(page).toHaveURL(/workspace=practice/);
  await page.getByRole("link", { name: "成本监控" }).click();
  await expect(page).toHaveURL(/\/insights$/);

  await page.goto("/course");
  await expect(page).toHaveURL(/workspace=map/);
  await page.goto("/tutor");
  await expect(page).toHaveURL(/workspace=teaching/);
});
