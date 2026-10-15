import { expect, test, type Page } from "@playwright/test";
import { openComposerMore, openComposerResource } from "./composer-helpers";

// Every API and Feishu page is mocked. These tests never log into Feishu.
const userId = "feishu-user";
const storageKey = `zhihui.bot.feishu-draft.${userId}`;
const official =
  "https://accounts.feishu.cn/oauth/v2/mcp/authorize?client_id=fixture-public-client&state=fixture-state";
const task = {
  id: "original-task",
  title: "原任务",
  prompt: "整理资料",
  status: "completed",
  result: "原任务的结果",
  error: null,
  created_at: Date.now(),
  updated_at: Date.now(),
  attempt: 1,
  options: {
    allow_web: false,
    allow_code: false,
    document_ids: [],
    skill_ids: [],
    connector_ids: [],
    plugin_ids: [],
    memory_enabled: true,
    knowledge_asset_ids: [],
  },
  plan: [],
  citations: [],
  web_sources: [],
};
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    userId,
    createdAt: Date.now(),
    taskId: "original-task",
    prompt: "保留授权前草稿",
    allowWeb: true,
    allowCode: true,
    memoryEnabled: false,
    docIds: ["doc-one"],
    skillIds: ["skill-one"],
    connectorIds: ["generic-one"],
    pluginIds: ["plugin-one"],
    knowledgeAssetIds: ["wiki-one"],
    deviceId: "",
    ...overrides,
  };
}
async function fixture(
  page: Page,
  options: {
    connected?: boolean;
    reconnect?: boolean;
    statusError?: boolean;
    authorizationUrl?: string;
    authorizeError?: boolean;
    returnResult?: string;
    draft?: ReturnType<typeof snapshot>;
    delayTask?: boolean;
    delayAuthorize?: boolean;
  } = {},
) {
  const writes: { path: string; body: any; method: string }[] = [];
  let currentConnected = !!options.connected,
    currentStatusError = !!options.statusError;
  let saved: any;
  let releaseTask!: () => void;
  let releaseAuthorize!: () => void;
  const taskReady = options.delayTask
    ? new Promise<void>((resolve) => (releaseTask = resolve))
    : Promise.resolve();
  const authorizeReady = options.delayAuthorize
    ? new Promise<void>((resolve) => (releaseAuthorize = resolve))
    : Promise.resolve();
  await page.route("https://accounts.feishu.cn/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<title>飞书授权测试替身</title><p>仅测试跳转，不登录飞书。</p>",
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    if (method !== "GET") writes.push({ path, method, body });
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === "/api/auth/me")
      return json({
        user: {
          id: userId,
          tenant_id: "fixture-tenant",
          name: "测试成员",
          role: "member",
          active: true,
        },
        tenant: { id: "fixture-tenant", name: "测试企业", slug: "fixture" },
      });
    if (path === "/api/stats")
      return json({ counts: {}, spaces: 1, capabilities: { models: {} } });
    if (path === "/api/personal/preferences")
      return json({ auto_archive: true, space_id: null });
    if (
      ["/api/spaces", "/api/conversations", "/api/bot/devices"].includes(path)
    )
      return json([]);
    if (path === "/api/documents")
      return json({
        items: [{ id: "doc-one", title: "产品资料", status: "ready" }],
        total: 1,
      });
    if (path === "/api/bot/skills")
      return json([
        { id: "skill-one", name: "核对技能", description: "核对资料" },
      ]);
    if (path === "/api/bot/capabilities")
      return json({
        agent: true,
        model: "fixture",
        web: true,
        code: true,
        code_configured: true,
        worker: true,
        connectors_enabled: true,
        connector_hosts: ["api.example.test:443"],
      });
    if (path === "/api/bot/cloud")
      return json({
        available: true,
        connected: false,
        state: "stopped",
        idle_timeout_seconds: 1800,
        persistent: true,
      });
    if (path === "/api/bot/plugins/catalog")
      return json({
        plugins: [
          {
            id: "plugin-one",
            name: "辅助插件",
            description: "测试插件",
            installed: true,
            enabled: true,
          },
        ],
        marketplaces: [],
      });
    if (path === "/api/bot/knowledge/assets")
      return json([
        { id: "wiki-one", name: "产品 Wiki", kind: "wiki", status: "ready" },
      ]);
    if (path === "/api/bot/connectors/feishu/status") {
      if (currentStatusError)
        return route.fulfill({
          status: 503,
          json: { error: "飞书连接暂不可用，请稍后重试。" },
        });
      return json({
        available: true,
        connected: currentConnected,
        needs_reconnect: !!options.reconnect,
        ...((currentConnected || options.reconnect) && {
          connector_id: "feishu-one",
        }),
      });
    }
    if (path === "/api/bot/connectors/feishu/authorize") {
      saved = await page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) || "null"),
        storageKey,
      );
      await authorizeReady;
      if (options.authorizeError)
        return route.fulfill({
          status: 502,
          json: { error: "暂时无法准备飞书授权，请稍后重试。" },
        });
      return json({ authorization_url: options.authorizationUrl ?? official });
    }
    if (path === "/api/bot/connectors/feishu-one" && method === "DELETE") {
      currentConnected = false;
      return json({ ok: true });
    }
    if (path === "/api/bot/connectors/feishu-one/test")
      return json({ message: "飞书连接正常" });
    if (path === "/api/bot/connectors")
      return json([
        {
          id: "generic-one",
          name: "日历 API",
          description: "团队安排",
          url: "https://api.example.test/calendar",
          method: "GET",
          has_token: true,
        },
        ...(currentConnected || options.reconnect
          ? [
              {
                id: "feishu-one",
                name: "飞书",
                description: "检索与读取飞书文档",
                provider: "feishu",
                status: options.reconnect ? "reconnect_required" : "connected",
                url: "https://mcp.feishu.cn/mcp",
                method: "GET",
                has_token: true,
              },
            ]
          : []),
      ]);
    if (path === "/api/bot/tasks" && method === "POST")
      return json({ id: "submitted-task" });
    if (path === "/api/bot/tasks") return json([task]);
    if (path === "/api/bot/tasks/original-task") {
      await taskReady;
      return json({
        task,
        evidence_available: true,
        events: [],
        artifacts: [],
        actions: [],
      });
    }
    if (path === "/api/bot/tasks/submitted-task")
      return json({
        task: { ...task, id: "submitted-task", status: "queued" },
        evidence_available: true,
        events: [],
        artifacts: [],
        actions: [],
      });
    return route.fulfill({
      status: 404,
      json: { error: "Unused fixture endpoint" },
    });
  });
  if (options.draft)
    await page.addInitScript(
      ({ key, draft }) => sessionStorage.setItem(key, JSON.stringify(draft)),
      { key: storageKey, draft: options.draft },
    );
  await page.goto(
    `/app?view=bot${options.returnResult ? `&feishu=${options.returnResult}` : ""}`,
  );
  await expect(
    page.getByRole("button", { name: "更多", exact: true }),
  ).toBeVisible();
  return {
    writes,
    saved: () => saved,
    connect: () => (currentConnected = true),
    recoverStatus: () => (currentStatusError = false),
    releaseTask: () => releaseTask?.(),
    releaseAuthorize: () => releaseAuthorize?.(),
  };
}

for (const width of [1440, 390]) {
  test(`official authorization preserves draft and single row at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const f = await fixture(page);
    await page.locator(".bot-composer textarea").fill("授权前的输入不会丢失");
    const before = await page.locator(".bot-composer-tools").boundingBox();
    const more = await openComposerMore(page);
    await more.getByRole("switch", { name: "联网搜索", exact: true }).click();
    await page.keyboard.press("Escape");
    const after = await page.locator(".bot-composer-tools").boundingBox();
    expect(after!.height).toBe(before!.height);
    await openComposerResource(page, "应用连接器");
    await expect(
      page.getByRole("button", { name: "连接飞书", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Bearer Token")).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/zxh-feishu-ui/feishu-picker-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "连接飞书", exact: true }).click();
    await expect(page).toHaveURL(official);
    expect(f.saved()).toMatchObject({
      userId,
      prompt: "授权前的输入不会丢失",
      allowWeb: true,
      taskId: "",
    });
    expect(f.saved()).not.toHaveProperty("token");
    expect(f.writes).toEqual([
      {
        path: "/api/bot/connectors/feishu/authorize",
        method: "POST",
        body: {},
      },
    ]);
    f.connect();
    await page.goto("/app?view=bot&feishu=connected");
    const dialog = page.getByRole("dialog", { name: "管理应用连接器" });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByText("飞书已连接。请在应用连接器中选择飞书供当前任务使用。", {
        exact: true,
      }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator(".bot-composer textarea")).toHaveValue(
      "授权前的输入不会丢失",
    );
    await openComposerResource(page, "应用连接器");
    await expect(
      page.getByRole("checkbox", { name: /^飞书/ }),
    ).not.toBeChecked();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(f.writes).toHaveLength(1);
  });
}
for (const result of ["connected", "cancelled", "error"]) {
  test(`${result} return restores task and all choices after delayed options`, async ({
    page,
  }) => {
    const f = await fixture(page, {
      connected: result === "connected",
      returnResult: result,
      draft: snapshot(),
      delayTask: true,
    });
    await expect(page.locator(".bot-composer textarea")).toHaveValue(
      "保留授权前草稿",
    );
    f.releaseTask();
    if (result === "connected")
      await page
        .getByRole("dialog", { name: "管理应用连接器" })
        .getByRole("button", { name: "关闭", exact: true })
        .click();
    await expect(page).toHaveURL(/task=original-task/);
    expect(new URL(page.url()).searchParams.has("feishu")).toBe(false);
    await expect(page.locator(".bot-selection")).toContainText("产品资料");
    await expect(page.locator(".bot-selection")).toContainText("产品 Wiki");
    await expect(
      page.getByRole("button", { name: "继续对话", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "继续对话", exact: true }).click();
    await expect
      .poll(
        () =>
          f.writes.filter((write) => write.path === "/api/bot/tasks").length,
      )
      .toBe(1);
    const submitted = f.writes.find((write) => write.path === "/api/bot/tasks");
    expect(submitted!.body.prompt).toBe("保留授权前草稿");
    expect(submitted!.body.options).toMatchObject({
      parent_task_id: "original-task",
      allow_web: true,
      allow_code: true,
      memory_enabled: false,
      document_ids: ["doc-one"],
      skill_ids: ["skill-one"],
      connector_ids: ["generic-one"],
      plugin_ids: ["plugin-one"],
      knowledge_asset_ids: ["wiki-one"],
    });
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
    ).toBeNull();
  });
}
for (const bad of [
  "http://accounts.feishu.cn/oauth/v2/mcp/authorize",
  "https://accounts.feishu.cn.attacker.test/oauth/v2/mcp/authorize",
  "https://accounts.feishu.cn/oauth/v2/other",
  "https://attacker.test/oauth/v2/mcp/authorize",
]) {
  test(`rejects forged authorization URL ${bad}`, async ({ page }) => {
    const f = await fixture(page, { authorizationUrl: bad });
    await page.locator(".bot-composer textarea").fill("保持输入");
    await openComposerResource(page, "应用连接器");
    await page.getByRole("button", { name: "连接飞书", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "飞书授权地址未通过校验",
    );
    await expect(page.locator(".bot-composer textarea")).toHaveValue(
      "保持输入",
    );
    await expect(page).toHaveURL(/\/app\?view=bot$/);
    expect(f.writes).toHaveLength(1);
  });
}
test("storage refusal prevents authorization without losing input", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zhihui.bot.feishu-draft."))
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  const f = await fixture(page);
  await page.locator(".bot-composer textarea").fill("不能丢失的草稿");
  await openComposerResource(page, "应用连接器");
  await page.getByRole("button", { name: "连接飞书", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "浏览器无法暂存当前输入，尚未跳转飞书",
  );
  await expect(page.locator(".bot-composer textarea")).toHaveValue(
    "不能丢失的草稿",
  );
  expect(f.writes).toEqual([]);
});
test("authorize failure is recoverable and preserves input", async ({
  page,
}) => {
  await fixture(page, { authorizeError: true });
  await page.locator(".bot-composer textarea").fill("服务器拒绝时仍保留草稿");
  await openComposerResource(page, "应用连接器");
  await page.getByRole("button", { name: "连接飞书", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法准备飞书授权");
  await expect(page.locator(".bot-composer textarea")).toHaveValue(
    "服务器拒绝时仍保留草稿",
  );
  await expect(
    page.getByRole("button", { name: "重试飞书连接" }),
  ).toBeEnabled();
});
test("callback query alone cannot report success", async ({ page }) => {
  const f = await fixture(page, { returnResult: "connected" });
  await expect(
    page.getByText(
      "尚未确认飞书连接，请重试或重新授权。当前任务未自动使用飞书。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("飞书已连接。请在应用连接器中选择飞书供当前任务使用。", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("feishu")).toBe(false);
  expect(f.writes).toEqual([]);
});
for (const reason of ["expired", "other-user"]) {
  test(`rejects ${reason} draft`, async ({ page }) => {
    const draft = snapshot(
      reason === "expired"
        ? { createdAt: Date.now() - 11 * 60 * 1000 }
        : { userId: "someone-else" },
    );
    await fixture(page, { returnResult: "cancelled", draft });
    await expect(page.locator(".bot-composer textarea")).toHaveValue("");
    await expect(
      page.getByText(
        /授权前的输入暂存已过期或无法读取，请核对当前任务后继续。/,
      ),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.has("task")).toBe(false);
  });
}
test("expired connection offers reauthorization and blocks new selection", async ({
  page,
}) => {
  const f = await fixture(page, { connected: true, reconnect: true });
  await openComposerResource(page, "应用连接器");
  await expect(
    page.getByRole("button", { name: "重新授权飞书" }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^飞书/ })).toBeDisabled();
  await expect(
    page.getByText("需要重新授权后使用", { exact: true }),
  ).toBeVisible();
  expect(f.writes).toEqual([]);
});
test("status outage leaves generic selection usable and can be retried", async ({
  page,
}) => {
  const f = await fixture(page, { statusError: true });
  await openComposerResource(page, "应用连接器");
  await expect(
    page.getByRole("button", { name: "重试飞书连接" }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /^日历 API/ }).check();
  f.recoverStatus();
  await page.getByRole("button", { name: "重试飞书连接" }).click();
  await expect(
    page.getByRole("button", { name: "连接飞书", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: /^日历 API/ })).toBeChecked();
  expect(f.writes).toEqual([]);
});
test("connected management hides credentials and retains generic form", async ({
  page,
}) => {
  await fixture(page, { connected: true });
  await openComposerResource(page, "应用连接器");
  await page.getByRole("button", { name: "管理连接器", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "管理应用连接器" });
  await expect(
    dialog.getByRole("button", { name: "测试连接", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "断开飞书", exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toContainText("mcp.feishu.cn");
  await expect(dialog).not.toContainText("钉钉");
  await expect(dialog).not.toContainText("GitHub");
  await page.screenshot({
    path: "/tmp/zxh-feishu-ui/feishu-connected-management.png",
    fullPage: true,
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "自定义连接器", exact: true })
    .click();
  await expect(page.getByLabel("固定 API 地址")).toBeVisible();
  await expect(page.getByLabel("Bearer Token")).toBeVisible();
});

test("edits made during slow authorization preparation survive the return", async ({
  page,
}) => {
  const f = await fixture(page, { delayAuthorize: true });
  await page.locator(".bot-composer textarea").fill("最初输入");
  await openComposerResource(page, "应用连接器");
  await page.getByRole("button", { name: "连接飞书", exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  await page.locator(".bot-composer textarea").fill("请求等待时继续编辑的输入");
  await openComposerResource(page, "资料");
  await page.getByRole("checkbox", { name: /^产品资料/ }).check();
  f.releaseAuthorize();
  await expect(page).toHaveURL(official);
  await page.goto("/app?view=bot&feishu=cancelled");
  await expect(page.locator(".bot-composer textarea")).toHaveValue(
    "请求等待时继续编辑的输入",
  );
  await expect(page.locator(".bot-selection")).toContainText("产品资料");
  expect(f.writes).toHaveLength(1);
});
