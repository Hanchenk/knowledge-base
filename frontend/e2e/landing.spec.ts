import { test, expect, type Page } from "@playwright/test";

async function mockWorkspace(page: Page, signedIn = false) {
  let authenticated = signedIn;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/public-config") {
      return route.fulfill({ json: { demo: true, sso: false } });
    }
    if (path === "/api/auth/login") {
      authenticated = true;
      return route.fulfill({ json: {} });
    }
    if (path === "/api/auth/logout") {
      authenticated = false;
      return route.fulfill({ json: {} });
    }
    if (path === "/api/auth/me") {
      return authenticated
        ? route.fulfill({
            json: {
              user: {
                id: "homepage-user",
                tenant_id: "homepage-tenant",
                name: "首页测试成员",
                email: "homepage@example.test",
                role: "member",
                department_id: null,
                manager_id: null,
                active: true,
              },
              tenant: {
                id: "homepage-tenant",
                name: "首页测试企业",
                slug: "homepage",
              },
            },
          })
        : route.fulfill({ status: 401, json: { error: "请登录" } });
    }
    if (path === "/api/stats") {
      return route.fulfill({
        json: {
          counts: { documents: 0, chunks: 0, images: 0, pending: 0 },
          spaces: 0,
          capabilities: {
            semantic: false,
            vision: false,
            chat: false,
            sso: false,
            database: "fixture",
            storage: "fixture",
            models: { embedding: "", vision: "", chat: "" },
          },
          mcp_url: "/mcp",
        },
      });
    }
    if (path === "/api/documents") {
      return route.fulfill({ json: { items: [], total: 0 } });
    }
    if (path === "/api/studio/capabilities") {
      return route.fulfill({
        json: { image: false, video: false, models: [] },
      });
    }
    if (
      ["/api/spaces", "/api/conversations", "/api/studio/projects"].includes(
        path,
      )
    ) {
      return route.fulfill({ json: [] });
    }
    if (path === "/api/bot/capabilities")
      return route.fulfill({
        json: {
          agent: false,
          model: "",
          web: false,
          code: false,
          code_configured: false,
          connectors_enabled: false,
          connector_hosts: [],
          worker: false,
        },
      });
    if (
      [
        "/api/bot/tasks",
        "/api/bot/skills",
        "/api/bot/connectors",
        "/api/bot/devices",
      ].includes(path)
    )
      return route.fulfill({ json: [] });
    throw new Error(`Unexpected API request in homepage test: ${path}`);
  });
}

async function expectProductBrand(page: Page) {
  await expect(page).toHaveTitle(/^知汇/);
  await expect(page.locator("body")).not.toContainText(/Atlas/i);
  await expect(page.locator(".brand .product-name").first()).toHaveText("知汇");
  expect(
    await page.evaluate(async () => {
      const fonts = await document.fonts.load(
        '600 24px "Zhihui Brand"',
        "知汇",
      );
      return (
        fonts.length > 0 && fonts.every((font) => font.status === "loaded")
      );
    }),
  ).toBe(true);
  await expect(page.locator(".brand .product-name").first()).toHaveCSS(
    "font-family",
    /Zhihui Brand/,
  );
}

test("hero video plays silently and respects motion preferences", async ({
  page,
}) => {
  await page.goto("/");
  const video = page.locator(".hero-background");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0.1);
  expect(
    await video.evaluate((element: HTMLVideoElement) => ({
      muted: element.muted,
      loop: element.loop,
      inline: element.playsInline,
      error: element.error,
    })),
  ).toEqual({ muted: true, loop: true, inline: true, error: null });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(video.locator("source")).toHaveCount(0);
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
    .toBe(true);
  const poster = await video.getAttribute("poster");
  expect((await page.request.get(poster!)).ok()).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0.1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(video.locator("source")).toHaveCount(0);
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.paused),
  ).toBe(true);
});

test("hero title appears character by character and the bot game is interactive", async ({
  page,
}) => {
  const gameApiCalls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      gameApiCalls.push(request.url());
  });
  await page.addInitScript(() => {
    (window as unknown as { titleLetters: string[] }).titleLetters = [];
    document.addEventListener("animationstart", (event) => {
      const element = event.target as HTMLElement;
      if (element.classList.contains("hero-letter"))
        (window as unknown as { titleLetters: string[] }).titleLetters.push(
          element.textContent || "",
        );
    });
  });
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { titleLetters: string[] }).titleLetters,
      ),
    )
    .toEqual(["这", "里", "是", "知", "汇"]);
  await expect
    .poll(() =>
      page
        .locator(".hero-letter")
        .evaluateAll((elements) =>
          elements.every(
            (element) => getComputedStyle(element).opacity === "1",
          ),
        ),
    )
    .toBe(true);
  const companion = page.getByRole("button", {
    name: "和知小汇玩接住灵感小游戏",
  });
  await companion.click();
  await page.getByRole("button", { name: "开始小游戏", exact: true }).click();
  const stage = page.getByRole("group", { name: "灵感星光游戏区域" });
  const bounds = (await stage.boundingBox())!;
  expect(bounds.height).toBeGreaterThan(350);
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect
    .poll(
      async () => Number(await page.getByLabel("已接住的星光").textContent()),
      { timeout: 8000 },
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "暂停小游戏" }).click();
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "paused",
  );
  await page.keyboard.press("Escape");
  await expect(companion).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator(".hero-letter")).toHaveCount(5);
  expect(
    await page
      .locator(".hero-letter")
      .evaluateAll((elements) =>
        elements.every(
          (element) =>
            getComputedStyle(element).opacity === "1" &&
            element.getAnimations().length === 0,
        ),
      ),
  ).toBe(true);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await companion.click();
    await expect(
      page.getByRole("button", { name: "开始小游戏", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
  }
  expect(gameApiCalls).toEqual([]);
});

test("homepage primary action enters the bot login destination", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/");
  await page
    .getByRole("link", { name: "和知小汇协作", exact: false })
    .first()
    .click();
  await expect(page).toHaveURL(/\/app\?view=bot$/);
  await expect(
    page.getByRole("heading", { name: "登录企业工作空间" }),
  ).toBeVisible();
});

test("public homepage is independent of enterprise APIs and works on mobile", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    apiRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "这里是知汇" }),
  ).toBeVisible();
  await expectProductBrand(page);
  await page.getByRole("button", { name: "研究一个课题", exact: true }).click();
  await expect(page.locator(".lb-result")).toContainText(
    "让团队知识更容易被使用",
  );
  await page.getByRole("button", { name: "整理会议纪要", exact: true }).click();
  await expect(page.locator(".lb-result")).toContainText(
    "产品评审 · 决策与下一步",
  );
  await page.getByRole("button", { name: "文件 1", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载示例文件" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("产品评审会议纪要.md");
  await expect(
    page.getByRole("button", { name: "界面截图", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "互动体验", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".landing-bot")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".landing-bot")).toHaveCSS(
    "border-top-width",
    "0px",
  );
  await page
    .locator("#faq summary")
    .filter({ hasText: "必须先配置 AI 模型" })
    .click();
  await expect(page.locator("#faq details[open]")).toContainText(
    "基础文档管理、权限和关键词检索无需模型密钥",
  );
  await page.locator("img").evaluateAll(async (images) => {
    images.forEach((image) => (image.loading = "eager"));
    await Promise.all(images.map((image) => image.decode()));
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.evaluate(() => window.scrollTo(0, 0));
    const menu = page.getByRole("button", { name: "打开导航菜单" });
    await menu.click();
    await expect(
      page.getByRole("navigation", { name: "主导航" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await menu.click();
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "知识空间" })
      .click();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(page).toHaveURL(/#knowledge$/);
  }
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("homepage entry logs in to the workspace, supports refresh and returns to homepage", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/");
  await page
    .getByRole("link", { name: "进入平台", exact: false })
    .first()
    .click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(
    page.getByRole("heading", { name: "登录企业工作空间" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "填入管理员账号" }).click();
  await page.getByRole("button", { name: "登录工作空间" }).click();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
  await expectProductBrand(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "这里是知汇" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "登录企业工作空间" }),
  ).toBeVisible();
});

test("question and creation links retain their destinations through login", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/");
  await page.getByRole("link", { name: "进入平台向知识库提问" }).click();
  await expect(page).toHaveURL(/\/app\?view=chat$/);
  await page.getByRole("button", { name: "填入管理员账号" }).click();
  await page.getByRole("button", { name: "登录工作空间" }).click();
  await expect(page.locator(".nav-item.active")).toHaveText(/智能问答/);
  await page.reload();
  await expect(page.locator(".nav-item.active")).toHaveText(/智能问答/);
  await page.goto("/");
  await page.getByRole("link", { name: "进入创作台" }).click();
  await expect(page).toHaveURL(/\/app\?view=studio$/);
  await expect(page.locator(".nav-item.active")).toHaveText(/创作台/);
  await expect(page.getByRole("heading", { name: "AI 创作" })).toBeVisible();
  await expect(page.locator(".brand-mark .product-logo").first()).toBeVisible();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
});

test("login provides a working return link to the public homepage", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "登录企业工作空间" }),
  ).toBeVisible();
  await expectProductBrand(page);
  await page.getByRole("link", { name: "返回官网" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "这里是知汇" }),
  ).toBeVisible();
});

test("homepage input submits to login, retains the draft, and never starts a task automatically", async ({
  page,
}) => {
  await mockWorkspace(page);
  const taskPosts: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith("/api/bot/")
    )
      taskPosts.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "交给知小汇的任务" });
  await input.click();
  await expect(input).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("button", { name: "发送任务并登录" }),
  ).toBeDisabled();
  await input.fill("   ");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  await input.fill("请帮我整理会议纪要");
  await input.press("Shift+Enter");
  await input.pressSequentially("列出行动项");
  const draft = await input.inputValue();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: "发送任务并登录" }).click();
  await expect(page).toHaveURL(/\/login\?view=bot$/);
  expect(new URL(page.url()).searchParams.size).toBe(1);
  await expect(
    page.getByText("你的任务已保留，登录后继续交给知小汇。"),
  ).toBeVisible();
  const background = page.locator(".daylight-background");
  await expect
    .poll(() =>
      background.evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeGreaterThan(0.1);
  await expectProductBrand(page);
  await page.reload();
  await expect(
    page.getByText("你的任务已保留，登录后继续交给知小汇。"),
  ).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      page.getByRole("button", { name: "登录工作空间" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(background.locator("source")).toHaveCount(0);
  await expect
    .poll(() => background.evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "填入管理员账号" }).click();
  await page.getByRole("button", { name: "登录工作空间" }).click();
  await expect(page).toHaveURL(/\/app\?view=bot$/);
  await expect(
    page.getByRole("textbox", { name: "任务描述", exact: true }),
  ).toHaveValue(draft);
  expect(taskPosts).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(() => sessionStorage.getItem("zhihui:homepage-task")),
  ).toBeNull();
});

test("Enter sends the homepage draft and expired drafts are ignored", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "交给知小汇的任务" })
    .fill("整理项目进度");
  await page.getByRole("textbox", { name: "交给知小汇的任务" }).press("Enter");
  await expect(page).toHaveURL(/\/login\?view=bot$/);
  await page.evaluate(() =>
    sessionStorage.setItem(
      "zhihui:homepage-task",
      JSON.stringify({
        text: "过期任务",
        savedAt: Date.now() - 31 * 60 * 1000,
      }),
    ),
  );
  await page.reload();
  await expect(page.getByText("登录后，继续与知小汇协作。")).toBeVisible();
});
