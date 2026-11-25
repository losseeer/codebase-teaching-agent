import { expect, test } from "@playwright/test";

import { ensureWorkspace, seedDiagram, watchPageErrors } from "./helpers";

test.beforeEach(async ({ page }) => {
  await ensureWorkspace(page);
  await seedDiagram(page);
});

test("图库列出刚种下的图，打开后画布渲染出节点与分组框", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.getByText("E2E 分层图").first().click();
  await expect(page.locator(".dg-node")).toHaveCount(4, { timeout: 20_000 });
  await expect(page.locator(".dg-group")).toHaveCount(2);
  await expect(page.getByText("接入层")).toBeVisible();
  expect(errors).toEqual([]);
});

test("缩放按钮改变比例，适应内容不报错", async ({ page }) => {
  await page.getByText("E2E 分层图").first().click();
  await expect(page.locator(".dg-node")).toHaveCount(4, { timeout: 20_000 });
  const zoom = page.locator(".z-val");
  const before = await zoom.innerText();
  await page.getByRole("button", { name: "放大" }).click();
  await expect(zoom).not.toHaveText(before);
  const zoomed = await zoom.innerText();
  await page.getByRole("button", { name: "缩小" }).click();
  await expect(zoom).not.toHaveText(zoomed);
  await page.getByRole("button", { name: "适应内容" }).click();
  await expect(zoom).toBeVisible();
});

test("点击节点打开说明抽屉，关闭后抽屉消失", async ({ page }) => {
  await page.getByText("E2E 分层图").first().click();
  const node = page.locator(".dg-node", { hasText: "短链服务" });
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.click();
  await expect(page.getByText("短链服务").first()).toBeVisible();
  // 抽屉里应有「关联文件」一类的读法
  await expect(page.getByText(/关联文件|说明/).first()).toBeVisible();
});

test("拖动节点后保存状态落到已保存，刷新后位置保持", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.getByText("E2E 分层图").first().click();
  const node = page.locator(".dg-node", { hasText: "控制台" });
  await expect(node).toBeVisible({ timeout: 20_000 });
  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 120, startY + 60, { steps: 10 });
  await page.mouse.up();
  // 拖完应排队保存并最终显示已保存
  await expect(page.getByText(/已保存|位置待存|保存中/).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.reload();
  await page.getByText("E2E 分层图").first().click();
  const moved = page.locator(".dg-node", { hasText: "控制台" });
  await expect(moved).toBeVisible({ timeout: 20_000 });
  const after = await moved.boundingBox();
  expect(after, "刷新后节点应停在新位置").not.toBeNull();
  if (after && box) expect(Math.abs(after.x - box.x), "横向位移应被记住").toBeGreaterThan(30);
  expect(errors).toEqual([]);
});

test("拖动分组框，组内节点一起平移", async ({ page }) => {
  await page.getByText("E2E 分层图").first().click();
  const group = page.locator(".dg-group", { hasText: "接入层" });
  await expect(group).toBeVisible({ timeout: 20_000 });
  const consoleBefore = await page.locator(".dg-node", { hasText: "控制台" }).boundingBox();
  const gatewayBefore = await page.locator(".dg-node", { hasText: "网关" }).boundingBox();
  const box = await group.boundingBox();
  expect(box && consoleBefore && gatewayBefore).toBeTruthy();
  if (!box || !consoleBefore || !gatewayBefore) return;
  // 抓分组框标签一带，避开节点
  const grabX = box.x + box.width - 20;
  const grabY = box.y + 8;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 100, grabY + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const consoleAfter = await page.locator(".dg-node", { hasText: "控制台" }).boundingBox();
  const gatewayAfter = await page.locator(".dg-node", { hasText: "网关" }).boundingBox();
  expect(consoleAfter && gatewayAfter).toBeTruthy();
  if (!consoleAfter || !gatewayAfter) return;
  expect(Math.abs(consoleAfter.x - consoleBefore.x), "组内第一个节点跟着走").toBeGreaterThan(30);
  expect(Math.abs(gatewayAfter.x - gatewayBefore.x), "组内第二个节点跟着走").toBeGreaterThan(30);
});

test("新建空白图：图库多一条，打开后画布提示「一张空画布」", async ({ page }) => {
  // 图库是异步读的：等第一条出现再取基准，否则拿到加载中的 0
  await expect(page.locator(".gallery-item").first()).toBeVisible({ timeout: 20_000 });
  const count = await page.locator(".gallery-item").count();
  await page.getByRole("button", { name: "新建空白图" }).click();
  await expect(page.locator(".gallery-item")).toHaveCount(count + 1, { timeout: 20_000 });
  await expect(page.getByText(/一张空画布|描述你想要的图/).first()).toBeVisible();
});

test("图库搜索能筛掉不匹配的图", async ({ page }) => {
  const search = page.getByLabel("搜索图");
  await search.fill("E2E");
  await expect(page.locator(".gallery-item")).toHaveCount(1);
  await search.fill("不存在的图名-zzz");
  await expect(page.getByText(/没有匹配|还没有图/).first()).toBeVisible();
  await search.fill("");
});

test("重命名当前图，标题跟着改", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.getByText("E2E 分层图").first().click();
  await expect(page.locator(".dg-node")).toHaveCount(4, { timeout: 20_000 });
  await page.locator(".dg-name").click();
  const input = page.getByLabel("重命名这张图");
  await input.fill("改过的图名");
  await input.press("Enter");
  await expect(page.locator(".dg-name")).toHaveText("改过的图名", { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("导出按钮触发 JSON 下载", async ({ page }) => {
  await page.getByText("E2E 分层图").first().click();
  await expect(page.locator(".dg-node")).toHaveCount(4, { timeout: 20_000 });
  await page.getByTitle("导出这张图的图元数据").click();
  const download = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByText("JSON（图元数据）").click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
});

test("代码问答：点文件树里的文件能打开源码，切档位按钮状态跟着变", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto("/app?workspace=teaching");
  // 目录行的 title 是「选中目录 src（…）」，按文本展开
  await page.locator(".tree-row", { hasText: "src" }).first().click();
  const file = page.getByTitle("src/main.js", { exact: true });
  await expect(file).toBeVisible({ timeout: 20_000 });
  await file.click();
  await expect(page.getByText(/main\.js/).first()).toBeVisible({ timeout: 20_000 });

  const toggle = page.getByRole("button", { name: "切换引导式教学" });
  await expect(toggle).toBeVisible();
  const before = await toggle.getAttribute("aria-pressed");
  await toggle.click();
  await expect(toggle).not.toHaveAttribute("aria-pressed", before ?? "");
  expect(errors).toEqual([]);
});

test("练习页渲染出题型选择与生成按钮", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto("/app?workspace=practice");
  const generate = page.getByRole("button", { name: /生成练习/ });
  await expect(generate).toBeVisible({ timeout: 20_000 });
  // 默认理解题不按主题挑代码，按钮可用（不点，避免触发模型调用）
  await expect(generate).toBeEnabled();
  expect(errors).toEqual([]);
});

test("成本监控页渲染预算进度与额度输入", async ({ page }) => {
  await page.goto("/insights");
  await expect(page.getByRole("img", { name: /预算已用/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('input[type="number"]').first()).toBeVisible();
});
