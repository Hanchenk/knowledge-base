import { test, expect } from "@playwright/test";
test("uploaded documents delete from detail and list; personal preference survives refresh", async ({
  page,
}) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "填入管理员账号" }).click();
  await page.getByRole("button", { name: "登录工作空间" }).click();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const spaces = await (await page.request.get("/api/spaces")).json();
  const space = spaces.find(
    (s: { permissions: { can_create: boolean } }) => s.permissions.can_create,
  );
  for (const detail of [true, false]) {
    const title = `删除验证-${Date.now()}-${detail}`;
    const upload = await page.request.post("/api/documents/upload", {
      headers: { Origin: origin },
      multipart: {
        space_id: space.id,
        title,
        file: {
          name: `${title}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from("可删除的验证文档"),
        },
      },
    });
    expect(upload.ok()).toBeTruthy();
    const doc = await upload.json();
    await page.getByRole("button", { name: "文档管理", exact: true }).click();
    await page.getByLabel("搜索文档标题").last().fill(title);
    await expect(
      page.getByRole("button", { name: new RegExp(title) }).first(),
    ).toBeVisible();
    if (detail) {
      await page.locator(".document-name").filter({ hasText: title }).click();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await dialog.getByTitle("删除文档").click();
    } else {
      await page
        .getByRole("button", { name: `删除 ${title}`, exact: true })
        .click();
    }
    const confirmation = page.getByRole("dialog", {
      name: "请确认",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "确定", exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    await expect(
      page.locator(".document-name").filter({ hasText: title }),
    ).toHaveCount(0);
    expect((await page.request.get(`/api/documents/${doc.id}`)).status()).toBe(
      404,
    );
    expect(
      (await page.request.get(`/api/documents/${doc.id}/file`)).status(),
    ).toBe(404);
  }
  await page.request.put("/api/personal/preferences", {
    headers: { Origin: origin },
    data: { auto_archive: false },
  });
  await page.getByRole("button", { name: /账号菜单/ }).click();
  await page.getByRole("menuitem", { name: "个人中心" }).click();
  const profile = page.getByRole("dialog", { name: "个人中心" });
  const toggle = profile.getByRole("switch", { name: "创作内容自动入库" });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await profile.getByRole("button", { name: "完成" }).click();
  await page.reload();
  await page.getByRole("button", { name: /账号菜单/ }).click();
  await page.getByRole("menuitem", { name: "个人中心" }).click();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await profile.getByRole("button", { name: "完成" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: /对象存储/ }).click();
  await expect(
    page.getByRole("region", { name: "对象存储配置" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBeTruthy();
});
