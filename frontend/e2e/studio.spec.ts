import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

async function login(page: Page, member = false) {
  // Keep workspace identity independent of local demo accounts and real data.
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") {
      return route.fulfill({
        json: {
          user: {
            id: "studio-fixture-user",
            tenant_id: "studio-fixture-tenant",
            name: "创作测试成员",
            email: "studio@example.test",
            role: member ? "member" : "admin",
            department_id: null,
            manager_id: null,
            active: true,
          },
          tenant: {
            id: "studio-fixture-tenant",
            name: "创作测试企业",
            slug: "studio-fixture",
          },
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
    if (path.startsWith("/api/models") || path.startsWith("/api/studio/")) {
      return route.fallback();
    }
    return route.fulfill({ status: 404, json: { error: "Unknown fixture" } });
  });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
}

/** 验证模型选择、失败重试、媒体预览与按轮次展示的创作历史。 */
test("studio discovers models, tracks image/video jobs, restores history and renders private media", async ({
  page,
}) => {
  // Browser fixture isolates all settings and creations from the user's real configuration.
  const provider = (model = "") => ({
    enabled: false,
    base_url: "",
    model,
    dimensions: 3,
    has_api_key: false,
  });
  let settings: Record<string, any> = {
    media_models: [],
    default_image_id: null,
    default_video_id: null,
    revision: 0,
    source: "database",
    can_save: true,
    postgres_dimensions: null,
    chat: { ...provider("fixture-agent"), enabled: true },
    embedding: provider(),
    vision: provider(),
    image: provider(),
    video: provider(),
  };
  const projects: any[] = [],
    messages: any[] = [],
    jobs: any[] = [],
    assets: any[] = [];
  const chatRequests: any[] = [],
    discovery: any[] = [];
  let polls = 0;
  let failReply = true;
  const png = readFileSync(
    fileURLToPath(new URL("../../tests/fixtures/diagram.png", import.meta.url)),
  );
  const mp4 = readFileSync(
    fileURLToPath(
      new URL("../../tests/fixtures/studio-video.mp4", import.meta.url),
    ),
  );
  await page.route("**/api/models**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/models/discover") {
      const input = req.postDataJSON();
      discovery.push(input);
      if (input.config.api_key === "wrong") {
        await route.fulfill({
          status: 400,
          json: { error: "HTTP 401：认证失败，请检查 API Key" },
        });
        return;
      }
      await route.fulfill({
        json: {
          models: [
            "image-fixture",
            "image-alternative",
            "video-fixture",
            "video-alternative",
          ],
        },
      });
      return;
    }
    if (path === "/api/models/test") {
      await route.fulfill({
        json: {
          success: true,
          message: "模型列表可访问；生成接口需在创作台实际验证",
          latency_ms: 10,
          dimensions: null,
        },
      });
      return;
    }
    if (req.method() === "PUT") {
      const input = req.postDataJSON();
      expect(input.revision).toBe(settings.revision);
      settings = { ...settings, revision: settings.revision + 1 };
      for (const kind of ["chat", "embedding", "vision"]) {
        const { api_key, clear_api_key, ...publicFields } = input[kind];
        settings[kind] = {
          ...publicFields,
          has_api_key:
            !clear_api_key && (!!api_key || settings[kind].has_api_key),
        };
      }
      const oldRows = settings.media_models;
      settings.media_models = input.media_models.map((row: any) => {
        const { api_key, clear_api_key, ...publicFields } = row.config;
        return {
          ...row,
          config: {
            ...publicFields,
            has_api_key:
              !clear_api_key &&
              (!!api_key ||
                oldRows.find((old: any) => old.id === row.id)?.config
                  .has_api_key),
          },
        };
      });
      for (const kind of ["image", "video"]) {
        const rows = settings.media_models.filter(
          (row: any) => row.kind === kind,
        );
        settings[`default_${kind}_id`] =
          input[`default_${kind}_id`] || rows[0]?.id || null;
        settings[kind] =
          rows.find((row: any) => row.id === settings[`default_${kind}_id`])
            ?.config || provider();
      }
    }
    await route.fulfill({ json: settings });
  });
  await page.route("**/api/studio/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/capabilities")) {
      await route.fulfill({
        json: {
          agent: true,
          web: true,
          image: settings.image,
          video: settings.video,
          models: settings.media_models
            .filter((row: any) => row.config.enabled)
            .map((row: any) => ({
              id: row.id,
              name: row.name,
              kind: row.kind,
              model: row.config.model,
            })),
          default_image_id: settings.default_image_id,
          default_video_id: settings.default_video_id,
        },
      });
      return;
    }
    if (path === "/api/studio/projects") {
      if (req.method() === "POST") {
        projects.push({
          id: "project-fixture",
          title: req.postDataJSON().title,
        });
        await route.fulfill({ json: projects[0] });
      } else await route.fulfill({ json: projects });
      return;
    }
    if (path === "/api/studio/chat") {
      const input = req.postDataJSON();
      chatRequests.push(input);
      if (!jobs.some((j) => j.request_id === input.request_id)) {
        const key = `${input.kind}-${jobs.length}`;
        messages.push({
          id: `user-${key}`,
          request_id: input.request_id,
          role: "user",
          content: input.prompt,
          citations: [],
        });
        jobs.push({
          id: key,
          request_id: input.request_id,
          kind: input.kind,
          prompt: input.prompt,
          model:
            settings.media_models.find(
              (row: any) => row.id === input[`${input.kind}_model_id`],
            )?.config.model || settings[input.kind].model,
          size: input.kind === "image" ? input.image_size : input.video_size,
          seconds: input.kind === "video" ? input.seconds : 0,
          status: "queued",
          progress: 0,
        });
        polls = 0;
      }
      if (failReply) {
        failReply = false;
        await route.fulfill({ status: 502, json: { error: "Agent 回复中断" } });
        return;
      }
      messages.push({
        id: `assistant-${jobs.length}`,
        request_id: input.request_id,
        role: "assistant",
        content: "已提交任务，作品区将显示进度。",
        citations: [],
        tool_calls: [{ name: `generate_${input.kind}`, success: true }],
      });
      await route.fulfill({
        json: { answer: "任务已提交", engine: "pi-agent-core" },
      });
      return;
    }
    if (path.startsWith("/api/studio/projects/")) {
      polls++;
      for (const job of jobs) {
        if (job.status === "completed") continue;
        if (polls < 3) {
          job.status = "running";
          job.progress = 50;
        } else if (job.status !== "completed") {
          job.status = "completed";
          job.progress = 100;
          assets.push({
            id: `asset-${job.id}`,
            job_id: job.id,
            kind: job.kind,
            mime_type: job.kind === "image" ? "image/png" : "video/mp4",
            size: job.kind === "image" ? png.length : mp4.length,
          });
        }
      }
      await route.fulfill({
        json: { project: projects[0], messages, jobs, assets },
      });
      return;
    }
    if (path.startsWith("/api/studio/assets/")) {
      const video = path.includes("video");
      await route.fulfill({
        contentType: video ? "video/mp4" : "image/png",
        body: video ? mp4 : png,
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "missing fixture" } });
  });
  await login(page);
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI 创作" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "模型配置", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /品牌海报/ }).click();
  await expect(page.getByLabel("创作要求")).toBeFocused();
  await expect(page.getByLabel("创作要求")).toHaveValue(/知识库产品海报/);
  expect(chatRequests.length).toBe(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: /生图与视频/ }).click();
  const dialog = page.getByRole("tabpanel", { name: "生图与视频" });
  for (const [title, model] of [
    ["生图模型", "image-fixture"],
    ["视频模型", "video-fixture"],
  ]) {
    const card = dialog.getByRole("article", { name: title });
    await card
      .getByLabel("服务地址（Base URL）")
      .fill("https://fixture.example/v1");
    await card.getByLabel("API Key", { exact: true }).fill("media-fixture-key");
    await expect(card.getByLabel("模型名称")).toHaveJSProperty(
      "tagName",
      "SELECT",
    );
    await card.getByLabel("模型名称").selectOption(model);
    await card.getByRole("button", { name: "测试连接" }).click();
    await expect(card.getByRole("status")).toContainText("实际验证");
    await card.getByRole("checkbox", { name: "启用", exact: true }).check();
  }
  for (const [kind, title, model, label] of [
    ["image", "生图模型", "image-alternative", "生图 B"],
    ["video", "视频模型", "video-alternative", "视频 B"],
  ]) {
    await dialog.getByRole("button", { name: `添加${title}` }).click();
    const card = dialog.locator(`article[data-kind="${kind}"]`).last();
    await card.getByLabel("配置名称").fill(label);
    await card
      .getByLabel("服务地址（Base URL）")
      .fill("https://alternative.example/v1");
    await card.getByLabel("API Key", { exact: true }).fill("alternative-key");
    await expect(card.getByLabel("模型名称")).toHaveJSProperty(
      "tagName",
      "SELECT",
    );
    await card.getByLabel("模型名称").selectOption(model);
    await card.getByRole("checkbox", { name: "启用", exact: true }).check();
  }
  expect(discovery.some((d) => d.kind === "image")).toBe(true);
  expect(discovery.some((d) => d.kind === "video")).toBe(true);
  await page.getByRole("tab", { name: /问答与检索/ }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "请先保存配置或放弃修改" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /生图与视频/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog.getByText("使用已保存配置")).toBeVisible();
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  const imageAlternative = settings.media_models.find(
    (row: any) => row.name === "生图 B",
  ).id;
  const videoAlternative = settings.media_models.find(
    (row: any) => row.name === "视频 B",
  ).id;
  const initialComposer = (await page
    .locator(".studio-composer")
    .boundingBox())!;
  for (const name of ["视频", "智能选择", "生图"]) {
    await page.getByRole("button", { name, exact: true }).click();
    expect(
      (await page.locator(".studio-composer").boundingBox())!.height,
    ).toBeCloseTo(initialComposer.height);
  }
  await page.getByRole("button", { name: "模型选择", exact: true }).click();
  await page.getByLabel("选择生图模型").selectOption(imageAlternative);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "模型选择", exact: true }),
  ).toBeFocused();
  await page.getByLabel("创作要求").fill("蓝色企业海报");
  await page.getByRole("button", { name: "开始创作" }).click();
  await expect(page.locator(".studio-error")).toContainText("Agent 回复中断");
  await page.getByRole("button", { name: "开始创作" }).click();
  expect(chatRequests[0].request_id).toBe(chatRequests[1].request_id);
  expect(jobs.length).toBe(1);
  expect(chatRequests[0].image_model_id).toBe(imageAlternative);
  expect(jobs[0].model).toBe("image-alternative");
  await expect(page.locator(".studio-dialogue")).toBeVisible();
  const image = page.locator(".studio-asset img");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "放大查看图片" }).click();
  const preview = page.getByRole("dialog", { name: "图片预览" });
  await expect(preview.getByRole("img")).toBeVisible();
  await expect
    .poll(() =>
      preview
        .getByRole("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  const originalWidth = await preview
    .getByRole("img")
    .evaluate((img) => img.getBoundingClientRect().width);
  await preview.getByRole("button", { name: "放大图片", exact: true }).click();
  await expect
    .poll(() =>
      preview
        .getByRole("img")
        .evaluate((img) => img.getBoundingClientRect().width),
    )
    .toBeGreaterThan(originalWidth);
  await preview.getByRole("button", { name: "原始尺寸", exact: true }).click();
  await preview.getByRole("button", { name: "适应窗口", exact: true }).click();
  await page.screenshot({ path: "test-results/image-preview.png" });
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: "视频", exact: true }).click();
  await page.getByRole("button", { name: "模型选择", exact: true }).click();
  await page.getByLabel("选择视频模型").selectOption(videoAlternative);
  await page.getByRole("button", { name: "生成参数", exact: true }).click();
  await page.getByLabel("视频时长").selectOption("8");
  await page.keyboard.press("Escape");
  await page.getByLabel("创作要求").fill("蓝色企业宣传短片");
  await page.getByRole("button", { name: "开始创作" }).click();
  const video = page.locator(".studio-asset video");
  await expect(video).toBeVisible({ timeout: 15000 });
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(chatRequests.at(-1).seconds).toBe(8);
  expect(chatRequests.at(-1).video_model_id).toBe(videoAlternative);
  expect(jobs.at(-1).model).toBe("video-alternative");
  expect(chatRequests.at(-1).allow_web).toBe(false);
  await video.evaluate(async (node: HTMLVideoElement) => {
    await node.play();
  });
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThan(0);
  await video.evaluate((node: HTMLVideoElement) => node.pause());
  await page.getByRole("button", { name: "查看视频详情" }).click();
  const videoPreview = page.getByRole("dialog", { name: "视频预览" });
  const previewVideo = videoPreview.locator("video");
  await expect(previewVideo).toBeVisible();
  await expect
    .poll(() =>
      previewVideo.evaluate((node: HTMLVideoElement) => node.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await expect(
    videoPreview.getByRole("button", { name: "放大图片" }),
  ).toHaveCount(0);
  await expect(
    videoPreview.getByRole("link", { name: "下载视频" }),
  ).toHaveAttribute("download", /\.mp4$/);
  await previewVideo.evaluate(async (node: HTMLVideoElement) => {
    await node.play();
  });
  await expect
    .poll(() =>
      previewVideo.evaluate((node: HTMLVideoElement) => node.currentTime),
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/video-preview.png" });
  await page.keyboard.press("Escape");
  await expect(videoPreview).toHaveCount(0);
  const dialogue = page.locator(".studio-dialogue");
  await expect(dialogue.locator(".studio-message.user").first()).toContainText(
    "蓝色企业海报",
  );
  await expect(
    dialogue.locator(".studio-message.assistant").last(),
  ).toContainText("已提交任务");
  await expect(dialogue.locator(".studio-tools")).toHaveCount(0);
  const firstUser = (await dialogue
    .locator(".studio-message.user .markdown")
    .first()
    .boundingBox())!;
  const firstAssistant = (await dialogue
    .locator(".studio-message.assistant .markdown")
    .first()
    .boundingBox())!;
  expect(firstUser.x).toBeGreaterThan(firstAssistant.x);
  expect((await dialogue.boundingBox())!.x).toBeCloseTo(
    (await page.locator(".studio-compose-wrap").boundingBox())!.x,
  );
  await page.screenshot({
    path: "test-results/studio-dialogue.png",
    fullPage: true,
  });
  await expect(page.getByLabel("创作要求")).toBeEditable();
  await page.screenshot({
    path: "test-results/studio.png",
    fullPage: true,
  });
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /下载视频/ }).click();
  expect((await download).suggestedFilename()).toContain(".mp4");
  await page.reload();
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  await expect(
    page.locator(".studio-recent-gallery .studio-asset img"),
  ).toBeVisible();
  await expect(
    page.locator(".studio-recent-gallery .studio-asset video"),
  ).toBeVisible();
  await page.getByRole("button", { name: "我的作品", exact: true }).click();
  await expect(page.locator(".studio-recent-gallery")).toBeInViewport();
  await page
    .locator(".studio-recent-card")
    .first()
    .getByRole("button", { name: /继续创作/ })
    .click();
  await expect(
    page.locator(".studio-dialogue .studio-asset video"),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开创作记录" }).click();
  await page
    .locator(".studio-history")
    .getByRole("button", { name: "蓝色企业海报" })
    .click();
  await expect(page.locator(".studio-asset video")).toBeVisible();
  await page.getByRole("button", { name: "模型选择", exact: true }).click();
  await expect(page.getByLabel("选择生图模型")).toHaveValue(imageAlternative);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("创作记录", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("创作记录", { exact: true }).selectOption("");
  await expect(page.getByRole("heading", { name: "AI 创作" })).toBeVisible();
  await page
    .getByLabel("创作记录", { exact: true })
    .selectOption("project-fixture");
  await expect(page.locator(".studio-asset video")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((node) => node.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "放大查看图片" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await page.getByRole("button", { name: "查看视频详情" }).click();
  await expect(videoPreview).toBeVisible();
  expect((await previewVideo.boundingBox())!.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "关闭视频预览" }).click();
  await expect(videoPreview).toHaveCount(0);
  await expect(
    dialogue.locator(".studio-message.assistant").last(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/studio-dialogue-mobile.png",
    fullPage: true,
  });
  await page.locator(".studio-dialogue").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/studio-mobile.png",
    fullPage: true,
  });
});

test("studio member cannot open model settings and missing models are explained", async ({
  page,
}) => {
  await page.route("**/api/studio/**", async (route) => {
    await route.fulfill({
      json: route.request().url().endsWith("/capabilities")
        ? {
            agent: false,
            web: false,
            image: { enabled: false, model: "" },
            video: { enabled: false, model: "" },
          }
        : [],
    });
  });
  await login(page, true);
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  await expect(
    page.getByText("请联系管理员配置生图或视频模型。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "模型配置", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("创作要求").fill("测试");
  await expect(page.getByRole("button", { name: "开始创作" })).toBeDisabled();
});

/** 验证宽屏创作台和紧凑导航的布局边界。 */
test("wide workspace uses the full content area beside compact navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2048, height: 1100 });
  await page.route("**/api/studio/**", async (route) => {
    await route.fulfill({
      json: route.request().url().endsWith("/capabilities")
        ? {
            agent: true,
            web: true,
            image: { enabled: false, model: "" },
            video: { enabled: false, model: "" },
          }
        : [],
    });
  });
  await login(page);
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI 创作" })).toBeVisible();
  const nav = (await page.locator(".sidebar").boundingBox())!;
  const studio = (await page.locator(".studio-layout").boundingBox())!;
  const header = (await page.locator(".topbar").boundingBox())!;
  expect(nav.width).toBeLessThanOrEqual(240);
  await expect(page.locator(".studio-history")).toBeHidden();
  expect(studio.x).toBeCloseTo(nav.x + nav.width);
  expect(studio.y).toBeCloseTo(header.y + header.height);
  expect(studio.x + studio.width).toBeCloseTo(2048);
  const composer = (await page.locator(".studio-compose-wrap").boundingBox())!;
  const canvas = (await page.locator(".studio-main").boundingBox())!;
  expect(composer.width).toBeLessThanOrEqual(820);
  expect(composer.x + composer.width / 2).toBeCloseTo(
    canvas.x + canvas.width / 2,
  );
  expect(composer.y + composer.height).toBeLessThanOrEqual(1100);
  await page.getByRole("button", { name: "打开创作记录" }).click();
  expect(
    (await page.locator(".studio-history").boundingBox())!.width,
  ).toBeLessThanOrEqual(200);
  await page.getByRole("button", { name: "收起创作记录" }).click();
  await page.screenshot({
    path: "test-results/studio-wide.png",
    fullPage: true,
    animations: "disabled",
  });
});
