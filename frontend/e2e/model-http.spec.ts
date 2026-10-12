import { test, expect } from "@playwright/test";

test("media models can be discovered, tested and saved without crypto.randomUUID", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const provider = {
    enabled: false,
    base_url: "",
    model: "",
    dimensions: 0,
    has_api_key: false,
  };
  type MediaModel = {
    id: string;
    kind: string;
    name: string;
    config: typeof provider & { api_key?: string; clear_api_key?: boolean };
  };
  let settings = {
    revision: 0,
    can_save: true,
    source: "database",
    chat: provider,
    embedding: provider,
    vision: provider,
    media_models: [] as MediaModel[],
    default_image_id: null as string | null,
    default_video_id: null as string | null,
  };
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  let saves = 0;
  const tested: string[] = [];
  // All API requests stay in the fixture, including when testing the LAN URL.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") {
      await route.fulfill({
        json: {
          user: {
            id: "http-fixture-user",
            tenant_id: "http-fixture-tenant",
            name: "HTTP 验证",
            email: "fixture@example.com",
            role: "admin",
            active: true,
            department_id: null,
            manager_id: null,
          },
          tenant: { id: "http-fixture-tenant", name: "HTTP", slug: "HTTP" },
        },
      });
    } else if (path === "/api/models/discover") {
      const input = request.postDataJSON();
      expect(input.config_id).toMatch(uuid);
      await route.fulfill({ json: { models: [`${input.kind}-fixture`] } });
    } else if (path === "/api/models/test") {
      const input = request.postDataJSON();
      expect(input.config_id).toMatch(uuid);
      tested.push(input.kind);
      await route.fulfill({
        json: { success: true, message: "模型列表连接成功", latency_ms: 1 },
      });
    } else if (path === "/api/models") {
      if (request.method() === "PUT") {
        const input = request.postDataJSON();
        expect(input.revision).toBe(settings.revision);
        expect(input.media_models).toHaveLength(4);
        const ids = input.media_models.map((row: MediaModel) => row.id);
        expect(new Set(ids).size).toBe(4);
        for (const id of ids) expect(id).toMatch(uuid);
        settings = {
          ...settings,
          ...input,
          revision: settings.revision + 1,
          media_models: input.media_models.map((row: MediaModel) => {
            const { api_key, clear_api_key: _, ...config } = row.config;
            return {
              ...row,
              config: { ...config, has_api_key: !!api_key },
            };
          }),
        };
        saves++;
      }
      await route.fulfill({ json: settings });
    } else if (path === "/api/spaces") {
      await route.fulfill({ json: [] });
    } else if (path === "/api/documents") {
      await route.fulfill({ json: { items: [] } });
    } else if (path === "/api/stats") {
      await route.fulfill({
        json: {
          counts: { documents: 0, chunks: 0, images: 0, pending: 0 },
          spaces: 0,
          capabilities: { models: {}, database: "postgres", storage: "s3" },
          mcp_url: "/mcp",
        },
      });
    } else {
      await route.fulfill({ status: 404, json: { error: "Unknown fixture" } });
    }
  });

  await page.goto("/app");
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: /生图与视频/ }).click();
  const panel = page.getByRole("tabpanel", { name: "生图与视频" });
  await expect(panel.getByRole("article")).toHaveCount(2);
  await panel.getByRole("button", { name: "添加生图模型" }).click();
  await panel.getByRole("button", { name: "添加视频模型" }).click();
  await expect(panel.getByRole("article")).toHaveCount(4);
  for (const kind of ["image", "video"]) {
    const cards = panel.locator(`article[data-kind="${kind}"]`);
    for (let index = 0; index < 2; index++) {
      const card = cards.nth(index);
      await card.getByLabel("配置名称").fill(`${kind} ${index + 1}`);
      await card
        .getByLabel("服务地址（Base URL）")
        .fill("https://fixture.example/v1");
      await card.getByLabel("API Key", { exact: true }).fill("fixture-key");
      await expect(card.getByLabel("模型名称")).toHaveJSProperty(
        "tagName",
        "SELECT",
      );
      await card.getByLabel("模型名称").selectOption(`${kind}-fixture`);
      await card.getByRole("checkbox", { name: "启用", exact: true }).check();
      await card.getByRole("button", { name: "测试连接" }).click();
      await expect(card.getByRole("status")).toContainText("模型列表连接成功");
    }
  }
  await panel.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(panel.getByText("使用已保存配置")).toBeVisible();
  expect(saves).toBe(1);
  expect(tested).toEqual(["image", "image", "video", "video"]);
  const ids = settings.media_models.map((row) => row.id);
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: /生图与视频/ }).click();
  await expect(panel.getByRole("article")).toHaveCount(4);
  expect(settings.media_models.map((row) => row.id)).toEqual(ids);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});
