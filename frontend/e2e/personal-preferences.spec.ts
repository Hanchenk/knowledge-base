import { test, expect, type Page } from "@playwright/test";

async function openProfile(page: Page) {
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("menuitem", { name: "个人中心" }).click();
  return page.getByRole("dialog", { name: "个人中心" });
}

test.beforeEach(async ({ page }) => {
  // These tests never read or change real account preferences.
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") {
      return route.fulfill({
        json: {
          user: {
            id: "preferences-user",
            tenant_id: "preferences-tenant",
            name: "企业管理员",
            email: "admin@example.test",
            role: "admin",
            active: true,
            department_id: null,
            manager_id: null,
          },
          tenant: { id: "preferences-tenant", name: "Yemast", slug: "Yemast" },
        },
      });
    }
    if (path === "/api/stats") {
      return route.fulfill({
        json: {
          counts: { documents: 0, chunks: 0, images: 0, pending: 0 },
          spaces: 0,
          capabilities: { models: {}, database: "fixture", storage: "fixture" },
          mcp_url: "/mcp",
        },
      });
    }
    if (path === "/api/documents") {
      return route.fulfill({ json: { items: [], total: 0 } });
    }
    if (["/api/spaces", "/api/conversations"].includes(path)) {
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ status: 404, json: { error: "Unknown fixture" } });
  });
});

test("archive switch waits for saved state, blocks duplicate saves and persists", async ({
  page,
}) => {
  let enabled = false;
  const writes: boolean[] = [];
  let releaseLoad!: () => void;
  const loading = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let releaseSave!: () => void;
  const saving = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/api/personal/preferences", async (route) => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON().auto_archive);
      if (writes.length === 1) await saving;
      enabled = writes.at(-1)!;
    } else {
      await loading;
    }
    await route.fulfill({
      json: { auto_archive: enabled, space_id: "private-space" },
    });
  });
  await page.goto("/app");
  const profile = await openProfile(page);
  const toggle = profile.getByRole("switch", { name: "创作内容自动入库" });
  await expect(toggle).toBeDisabled();
  await expect(profile.getByRole("status")).toHaveText("加载中…");
  releaseLoad();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(profile.getByRole("status")).toHaveText("保存中…");
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await toggle.press("Space");
  expect(writes).toEqual([true]);
  releaseSave();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(profile.getByText("设置已保存")).toBeVisible();
  await profile.screenshot({
    path: "test-results/personal-center-desktop.png",
    animations: "disabled",
  });
  await profile.getByRole("button", { name: "完成" }).click();
  await openProfile(page);
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  expect(writes).toEqual([true, false]);
});

test("failed archive save keeps the persisted value and allows retry", async ({
  page,
}) => {
  let enabled = true;
  let failSave = true;
  await page.route("**/api/personal/preferences", async (route) => {
    if (route.request().method() === "PUT") {
      if (failSave) {
        failSave = false;
        return route.fulfill({ status: 503, json: { error: "服务暂不可用" } });
      }
      enabled = route.request().postDataJSON().auto_archive;
    }
    await route.fulfill({
      json: { auto_archive: enabled, space_id: "private-space" },
    });
  });
  await page.goto("/app");
  const profile = await openProfile(page);
  const toggle = profile.getByRole("switch", { name: "创作内容自动入库" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(profile.getByRole("alert")).toContainText("保存失败");
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(profile.getByRole("alert")).toHaveCount(0);
});

test("failed preferences load can retry and the switch fits narrow screens", async ({
  page,
}) => {
  let failLoad = true;
  await page.route("**/api/personal/preferences", async (route) => {
    if (failLoad) {
      return route.fulfill({ status: 503, json: { error: "设置加载失败" } });
    }
    await route.fulfill({
      json: { auto_archive: true, space_id: "private-space" },
    });
  });
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/app");
  const profile = await openProfile(page);
  const toggle = profile.getByRole("switch", { name: "创作内容自动入库" });
  await expect(toggle).toBeDisabled();
  await expect(profile.getByRole("alert")).toContainText("设置加载失败");
  failLoad = false;
  await profile.getByRole("button", { name: "重新加载" }).click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(profile.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const box = (await toggle.boundingBox())!;
  const dialog = (await profile.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(dialog.x + dialog.width);
  await profile.screenshot({
    path: "test-results/personal-center-mobile.png",
    animations: "disabled",
  });
});
