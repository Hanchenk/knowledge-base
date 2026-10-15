import { openComposerMore, openComposerResource } from "./composer-helpers";
import { expect, test, type Page } from "@playwright/test";

type Plugin = {
  id: string;
  name: string;
  description: string;
  source: string;
  marketplace?: string;
  category: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  has_config?: boolean;
};

async function fixture(
  page: Page,
  failInstall = false,
  failConfig = false,
  options: {
    searchPlugin?: boolean;
    webEnabled?: boolean;
    completedTask?: boolean;
    cloudConnected?: boolean;
    role?: "admin" | "member";
  } = {},
) {
  const plugins: Plugin[] = [
    {
      id: "@test/dsh-research",
      name: "研究助手",
      description: "检索公开资料并核对研究来源",
      source: "@test/dsh-research",
      category: "研究",
      version: "1.2.0",
      installed: false,
      enabled: false,
    },
    {
      id: "@test/dsh-documents",
      name: "文档助手",
      description: "读取文档，整理重点与行动清单",
      source: "@test/dsh-documents",
      marketplace: "team-core",
      category: "办公",
      version: "1.0.0",
      installed: true,
      enabled: true,
      has_config: true,
    },
  ];
  if (options.searchPlugin)
    plugins.push({
      id: "@aiwayds/dsh-web-search-anysearch",
      name: "AnySearch 联网搜索",
      description: "通过搜索服务检索公开网页",
      source: "@aiwayds/dsh-web-search-anysearch",
      category: "搜索",
      version: "0.6.0",
      installed: true,
      enabled: true,
    });
  const marketplaces = [
    {
      id: "npm",
      name: "npm 插件市场",
      source: "https://registry.npmjs.org",
      builtin: true,
    },
    {
      id: "team-core",
      name: "团队基础市场",
      source: "https://registry.example.test",
      builtin: false,
    },
  ];
  const tasks: Record<string, any>[] = options.completedTask
    ? [
        {
          id: "task-1",
          title: "旧的知识库任务",
          prompt: "查询企业资料",
          options: {
            runtime: "deepseek-harness",
            allow_web: false,
            plugin_ids: ["@aiwayds/dsh-web-search-anysearch"],
          },
          status: "completed",
          created_at: Date.now(),
          updated_at: Date.now(),
          result: "知识库暂无相关资料。",
          plan: [],
          citations: [],
          web_sources: [],
          attempt: 1,
        },
      ]
    : [];
  const writes: { path: string; method: string; body: any }[] = [];
  const reads: string[] = [];
  const cloud = {
    available: true,
    connected: options.cloudConnected ?? false,
    state: options.cloudConnected ? "running" : "stopped",
    idle_timeout_seconds: 1800,
    last_activity_at: options.cloudConnected ? Date.now() : null,
    expires_at: options.cloudConnected ? Date.now() + 1800000 : null,
    active_tasks: 0,
    pending_tasks: 0,
    persistent: true,
  };
  let installedVersion = "0.2.0-rc.1";
  let rejectInstall = failInstall;
  let rejectConfig = failConfig;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "POST" ? request.postDataJSON() : undefined;
    if (method !== "GET") writes.push({ path, method, body });
    else reads.push(path);
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: "plugin-user",
            tenant_id: "plugin-tenant",
            name: "插件测试成员",
            role: options.role ?? "member",
            active: true,
          },
          tenant: {
            id: "plugin-tenant",
            name: "插件测试企业",
            slug: "plugin-fixture",
          },
        },
      });
    if (path === "/api/stats")
      return route.fulfill({
        json: {
          counts: { documents: 0, chunks: 0, images: 0, pending: 0 },
          capabilities: { models: {} },
          spaces: 0,
        },
      });
    if (path === "/api/documents")
      return route.fulfill({ json: { items: [], total: 0 } });
    if (
      [
        "/api/spaces",
        "/api/conversations",
        "/api/bot/devices",
        "/api/bot/skills",
        "/api/bot/connectors",
      ].includes(path)
    )
      return route.fulfill({ json: [] });
    if (path === "/api/bot/capabilities")
      return route.fulfill({
        json: {
          agent: true,
          model: "fixture",
          web: options.webEnabled ?? true,
          code: true,
          worker: true,
          harness_available: true,
        },
      });
    if (
      path === "/api/bot/cloud" ||
      /^\/api\/bot\/cloud\/(connect|disconnect|heartbeat)$/.test(path)
    ) {
      if (path.endsWith("/connect")) {
        cloud.connected = true;
        cloud.state = "running";
      }
      if (path.endsWith("/disconnect")) {
        cloud.connected = false;
        cloud.state = "stopped";
      }
      return route.fulfill({ json: cloud });
    }
    if (path === "/api/bot/cloud/files")
      return route.fulfill({
        json: {
          files: [
            {
              id: "cloud-file-1",
              task_id: "saved-task",
              task_title: "已保存的会话",
              name: "研究报告.md",
              kind: "markdown",
              size: 128,
              created_at: Date.now(),
              url: "/api/bot/artifacts/cloud-file-1",
              download_url: "/api/bot/artifacts/cloud-file-1",
              preview_url: "/api/bot/artifacts/cloud-file-1/preview",
              previewable: true,
              content_type: "text/markdown",
            },
          ],
          has_more: false,
          offset: 0,
          limit: 100,
          next_offset: null,
        },
      });
    if (path === "/api/models")
      return route.fulfill({
        json: {
          ...Object.fromEntries(
            ["chat", "embedding", "vision"].map((kind) => [
              kind,
              {
                enabled: true,
                base_url: "https://model.example.test",
                model: "fixture",
                dimensions: 8,
                has_api_key: true,
              },
            ]),
          ),
          revision: 1,
          source: "database",
          can_save: true,
          postgres_dimensions: 8,
        },
      });
    if (path === "/api/bot/game/inspiration/leaderboard")
      return route.fulfill({ json: { entries: [], me: null, total: 0 } });
    if (path === "/api/bot/harness" || path === "/api/bot/harness/update") {
      if (method === "POST") installedVersion = "0.2.0-rc.2";
      return route.fulfill({
        json: {
          available: true,
          installed_version: installedVersion,
          latest_version: "0.2.0-rc.2",
          update_available: installedVersion !== "0.2.0-rc.2",
          engine: "deepseek-harness",
          registry: "https://registry.npmjs.org",
          is_admin: true,
          features: { sdk: true, plugins: true, mcp: true, skills: true },
        },
      });
    }
    if (path === "/api/bot/plugins/catalog") {
      const query = (url.searchParams.get("q") || "").toLowerCase();
      return route.fulfill({
        json: {
          plugins: plugins.filter(
            (plugin) =>
              !query ||
              `${plugin.name} ${plugin.id} ${plugin.description}`
                .toLowerCase()
                .includes(query),
          ),
          marketplaces,
        },
      });
    }
    if (path === "/api/bot/plugins/install") {
      if (rejectInstall) {
        rejectInstall = false;
        return route.fulfill({
          status: 400,
          json: { error: "插件版本与云端引擎不兼容" },
        });
      }
      const plugin = plugins.find(
        (item) => item.source === body.source || item.id === body.source,
      )!;
      plugin.installed = true;
      return route.fulfill({ json: plugin });
    }
    if (path === "/api/bot/plugins/marketplaces" && method === "POST") {
      const item = {
        id: "team-market",
        name: body.name || "团队市场",
        source: body.source,
        builtin: false,
      };
      marketplaces.push(item);
      return route.fulfill({ json: item });
    }
    if (
      path.startsWith("/api/bot/plugins/marketplaces/") &&
      method === "DELETE"
    ) {
      const id = decodeURIComponent(path.split("/").at(-1)!);
      marketplaces.splice(
        marketplaces.findIndex((item) => item.id === id),
        1,
      );
      return route.fulfill({ json: { ok: true } });
    }
    if (path.startsWith("/api/bot/plugins/") && path.endsWith("/config")) {
      const id = decodeURIComponent(
        path.slice("/api/bot/plugins/".length).replace(/\/config$/, ""),
      );
      const plugin = plugins.find((item) => item.id === id)!;
      if (method === "POST") {
        if (rejectConfig) {
          rejectConfig = false;
          return route.fulfill({
            status: 400,
            json: { error: "插件服务地址配置无效" },
          });
        }
        plugin.has_config = Object.keys(body.config).length > 0;
        return route.fulfill({
          json: { ok: true, has_config: plugin.has_config },
        });
      }
      return route.fulfill({
        json: {
          has_config: !!plugin.has_config,
          rows: [{ id: "documents", name: "@test/dsh-documents" }],
        },
      });
    }
    if (path.startsWith("/api/bot/plugins/")) {
      const id = decodeURIComponent(
        path.slice("/api/bot/plugins/".length).replace(/\/enable$/, ""),
      );
      const plugin = plugins.find((item) => item.id === id)!;
      if (path.endsWith("/enable")) plugin.enabled = body.enabled;
      if (method === "DELETE") {
        plugin.installed = false;
        plugin.enabled = false;
      }
      return route.fulfill({
        json: method === "DELETE" ? { ok: true } : plugin,
      });
    }
    if (path === "/api/bot/tasks") {
      if (method === "POST") {
        const task = {
          id: `task-${tasks.length + 1}`,
          title: body.prompt,
          prompt: body.prompt,
          options: body.options,
          status: "queued",
          created_at: Date.now(),
          updated_at: Date.now(),
          result: "",
          plan: [],
          citations: [],
          web_sources: [],
          attempt: 1,
        };
        tasks.unshift(task);
        return route.fulfill({ json: { id: task.id } });
      }
      return route.fulfill({ json: tasks });
    }
    if (/^\/api\/bot\/tasks\/task-\d+$/.test(path))
      return route.fulfill({
        json: {
          task: tasks.find((task) => task.id === path.split("/").at(-1)),
          evidence_available: true,
          messages: [],
          events: [],
          actions: [],
          artifacts: [],
        },
      });
    return route.fulfill({ status: 404, json: { error: "Unknown fixture" } });
  });
  await page.goto(
    `/app?view=bot${options.completedTask ? "&task=task-1" : ""}`,
  );
  await expect(page.getByRole("heading", { name: "知小汇 bot" })).toBeVisible();
  await expect(
    page.getByText("你的 AI 工作搭档", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: options.completedTask ? "继续对话" : "开始任务",
      exact: true,
    }),
  ).toBeVisible();
  return { plugins, writes, reads, cloud };
}

test("plugin dialog restores focus to its composer or header opener", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  const more = page.getByRole("button", { name: "更多", exact: true });
  const header = page.getByRole("button", { name: "插件市场", exact: true });
  const dialog = page.getByRole("dialog", { name: "插件", exact: true });
  const prompt = page.getByRole("textbox", { name: "任务描述" });
  await prompt.fill("保留草稿，核对插件能力");

  await openComposerResource(page, "插件市场与任务插件");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");

  await header.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(header).toBeFocused();

  await openComposerResource(page, "插件市场与任务插件");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
  await expect(prompt).toHaveValue("保留草稿，核对插件能力");
  expect(writes).toHaveLength(0);
});

test("plugin failures preserve installed state and only enabled selections reach cloud tasks", async ({
  page,
}) => {
  const { writes } = await fixture(page, true);
  await openComposerResource(page, "插件市场与任务插件");
  const dialog = page.getByRole("dialog", { name: "插件" });
  const research = dialog.locator("article").filter({
    has: page.getByRole("heading", { name: "研究助手", exact: true }),
  });
  await research.getByRole("button", { name: "安装", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "插件版本与云端引擎不兼容",
  );
  await expect(
    research.getByRole("button", { name: "安装", exact: true }),
  ).toBeVisible();
  await expect(research.getByRole("button", { name: "加入任务" })).toHaveCount(
    0,
  );
  await research.getByRole("button", { name: "安装", exact: true }).click();
  await expect(
    research.getByRole("button", { name: "加入任务" }),
  ).toBeDisabled();
  await research.getByRole("button", { name: "启用", exact: true }).click();
  await research.getByRole("button", { name: "加入任务" }).click();
  await expect(
    research.getByRole("button", { name: "已加入任务" }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "移除 研究助手" }),
  ).toBeVisible();
  await openComposerResource(page, "云端");
  await page.getByRole("checkbox", { name: /联网检索/ }).check();
  await page.getByRole("checkbox", { name: /代码执行/ }).check();
  await page.getByRole("button", { name: "关闭选择面板" }).click();
  await page
    .getByRole("textbox", { name: "任务描述" })
    .fill("用研究插件整理公开资料");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect
    .poll(
      () =>
        writes.find((write) => write.path === "/api/bot/tasks")?.body.options,
    )
    .toMatchObject({
      runtime: "deepseek-harness",
      plugin_ids: ["@test/dsh-research"],
      allow_web: true,
      allow_code: true,
    });
});

test("market sources, enabled selection removal and uninstall stay synchronized", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "插件" });
  await dialog.screenshot({
    path: "test-results/harness-market-desktop.png",
    animations: "disabled",
  });
  await dialog.getByRole("tab", { name: "已安装" }).click();
  const documents = dialog.locator("article").filter({
    has: page.getByRole("heading", { name: "文档助手", exact: true }),
  });
  await documents.getByRole("button", { name: "更新 文档助手" }).click();
  await expect
    .poll(
      () =>
        writes.find((write) => write.path === "/api/bot/plugins/install")?.body,
    )
    .toMatchObject({ source: "@test/dsh-documents", marketplace: "team-core" });
  await documents.getByRole("button", { name: "加入任务" }).click();
  await documents.getByRole("button", { name: "停用", exact: true }).click();
  await expect(
    documents.getByRole("button", { name: "加入任务" }),
  ).toBeDisabled();
  await expect(dialog.getByText("本任务已选 0 个插件")).toBeVisible();
  await documents.getByRole("button", { name: "卸载 文档助手" }).click();
  await documents.getByRole("button", { name: "卸载", exact: true }).click();
  await expect(dialog.getByText("还没有安装插件")).toBeVisible();
  await dialog.getByRole("tab", { name: "市场来源" }).click();
  await dialog.getByRole("button", { name: "添加市场", exact: true }).click();
  await dialog.getByLabel("市场名称").fill("团队测试市场");
  await dialog.getByLabel("注册源地址").fill("https://registry.example.test");
  await dialog
    .locator("form")
    .getByRole("button", { name: "添加市场", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "团队测试市场" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "移除市场 团队测试市场" }).click();
  await expect(
    dialog.getByRole("heading", { name: "团队测试市场" }),
  ).toHaveCount(0);
  expect(
    writes.some(
      (write) =>
        write.path.includes("%40test%2Fdsh-documents") &&
        write.method === "DELETE",
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await page
    .getByRole("textbox", { name: "任务描述" })
    .fill("使用云端整理资料");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect
    .poll(
      () =>
        writes.find((write) => write.path === "/api/bot/tasks")?.body.options,
    )
    .toMatchObject({ runtime: "deepseek-harness", plugin_ids: [] });
});

test("market search and selection remain usable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "插件" });
  await dialog.getByRole("searchbox", { name: "搜索插件" }).fill("文档");
  await expect(
    dialog.getByRole("heading", { name: "研究助手", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("heading", { name: "文档助手", exact: true }),
  ).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await dialog.screenshot({
    path: "test-results/harness-market-mobile.png",
    animations: "disabled",
  });
});

test("plugin configuration validates row objects, preserves failed input and never echoes saved secrets", async ({
  page,
}) => {
  const { writes } = await fixture(page, false, true);
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const market = page.getByRole("dialog", { name: "插件" });
  await market.getByRole("button", { name: "配置 文档助手" }).click();
  const editor = page.getByRole("dialog", { name: "配置 文档助手" });
  await expect(editor.getByText("已保存配置 · 密钥不回显")).toBeVisible();
  const input = editor.getByRole("textbox", { name: "JSON 配置" });
  await expect(input).toHaveValue("");
  await input.fill("[]");
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("配置需要是 JSON 对象");
  expect(writes.filter((write) => write.path.endsWith("/config"))).toHaveLength(
    0,
  );
  const config = {
    documents: {
      apiKey: "fixture-replacement-key",
      serverUrl: "https://service.example.test",
    },
  };
  await input.fill(JSON.stringify(config, null, 2));
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("插件服务地址配置无效");
  await expect(input).toHaveValue(JSON.stringify(config, null, 2));
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(
    writes.filter((write) => write.path.endsWith("/config")).at(-1)?.body,
  ).toEqual({ config });
  await market.getByRole("button", { name: "配置 文档助手" }).click();
  await expect(input).toHaveValue("");
  await expect(editor.getByText("fixture-replacement-key")).toHaveCount(0);
  await editor.getByRole("button", { name: "清空已保存配置" }).click();
  await editor.getByRole("button", { name: "确认清空" }).click();
  await expect(editor).toHaveCount(0);
  expect(
    writes.filter((write) => write.path.endsWith("/config")).at(-1)?.body,
  ).toEqual({ config: {} });
  await market.getByRole("button", { name: "配置 文档助手" }).click();
  await expect(editor.getByText("尚未保存自定义配置")).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "清空已保存配置" }),
  ).toBeDisabled();
});

test("selecting a search provider enables public web access for the submitted task", async ({
  page,
}) => {
  const { writes } = await fixture(page, false, false, { searchPlugin: true });
  await openComposerMore(page);
  const web = page.getByRole("switch", { name: "联网搜索", exact: true });
  await expect(web).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "插件" });
  const search = dialog.locator("article").filter({
    has: page.getByRole("heading", { name: "AnySearch 联网搜索", exact: true }),
  });
  await search.getByRole("button", { name: "加入任务" }).click();
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await openComposerMore(page);
  await expect(web).toHaveAttribute("aria-checked", "true");
  await page.locator(".bot-composer").screenshot({
    path: "test-results/bot-web-switch-desktop.png",
    animations: "disabled",
  });
  await page
    .getByRole("textbox", { name: "任务描述" })
    .fill("查找企业公开信息");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect
    .poll(
      () =>
        writes.find((write) => write.path === "/api/bot/tasks")?.body.options,
    )
    .toMatchObject({
      runtime: "deepseek-harness",
      plugin_ids: ["@aiwayds/dsh-web-search-anysearch"],
      allow_web: true,
    });
});

test("mobile web switch preserves an explicit off choice when adding another plugin", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes } = await fixture(page, false, false, { searchPlugin: true });
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "插件" });
  const search = dialog.locator("article").filter({
    has: page.getByRole("heading", { name: "AnySearch 联网搜索", exact: true }),
  });
  await search.getByRole("button", { name: "加入任务" }).click();
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await openComposerMore(page);
  const web = page.getByRole("switch", { name: "联网搜索", exact: true });
  await expect(web).toHaveAttribute("aria-checked", "true");
  await web.click();
  await expect(web).toHaveAttribute("aria-checked", "false");
  await openComposerResource(page, "云端");
  await expect(
    page.getByRole("checkbox", { name: /联网检索/ }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "关闭选择面板" }).click();
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  await dialog
    .locator("article")
    .filter({
      has: page.getByRole("heading", { name: "文档助手", exact: true }),
    })
    .getByRole("button", { name: "加入任务" })
    .click();
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await openComposerMore(page);
  await expect(web).toHaveAttribute("aria-checked", "false");
  expect(
    await page
      .locator(".bot-composer")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.locator(".bot-composer").screenshot({
    path: "test-results/bot-web-switch-mobile.png",
    animations: "disabled",
  });
  await page.getByRole("textbox", { name: "任务描述" }).fill("只读取授权资料");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect
    .poll(
      () =>
        writes.find((write) => write.path === "/api/bot/tasks")?.body.options,
    )
    .toMatchObject({
      plugin_ids: ["@aiwayds/dsh-web-search-anysearch", "@test/dsh-documents"],
      allow_web: false,
    });
});

test("completed tasks retain their saved web permission until a followup enables it", async ({
  page,
}) => {
  const { writes } = await fixture(page, false, false, {
    searchPlugin: true,
    completedTask: true,
  });
  await openComposerMore(page);
  const web = page.getByRole("switch", { name: "联网搜索", exact: true });
  await expect(page.getByRole("textbox", { name: "继续对话" })).toBeVisible();
  await expect(web).toHaveAttribute("aria-checked", "false");
  await web.click();
  await page
    .getByRole("textbox", { name: "继续对话" })
    .fill("继续查询公开网页");
  await page.getByRole("button", { name: "继续对话", exact: true }).click();
  await expect
    .poll(
      () =>
        writes.find((write) => write.path === "/api/bot/tasks")?.body.options,
    )
    .toMatchObject({
      parent_task_id: "task-1",
      plugin_ids: ["@aiwayds/dsh-web-search-anysearch"],
      allow_web: true,
    });
});

test("search plugin selection respects administrator-disabled web access", async ({
  page,
}) => {
  const { writes } = await fixture(page, false, false, {
    searchPlugin: true,
    webEnabled: false,
  });
  await openComposerMore(page);
  const web = page.getByRole("switch", { name: "联网搜索", exact: true });
  await expect(web).toBeDisabled();
  await expect(web).toHaveAttribute("title", "管理员暂未启用联网能力");
  await expect(web).toContainText("未启用");
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "插件" });
  await dialog
    .locator("article")
    .filter({
      has: page.getByRole("heading", {
        name: "AnySearch 联网搜索",
        exact: true,
      }),
    })
    .getByRole("button", { name: "加入任务" })
    .click();
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await openComposerMore(page);
  await expect(web).toHaveAttribute("aria-checked", "false");
  await page
    .getByRole("textbox", { name: "任务描述" })
    .fill("只查询知识库资料");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  await expect
    .poll(
      () =>
        writes.find((write) => write.path === "/api/bot/tasks")?.body.options,
    )
    .toMatchObject({ allow_web: false });
});

test("members manage cloud connections and persistent files without seeing runtime controls", async ({
  page,
}) => {
  const { reads, writes } = await fixture(page);
  await expect(
    page.getByRole("button", { name: "插件市场", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "插件市场", exact: true }).click();
  const plugins = page.getByRole("dialog", { name: "插件", exact: true });
  await expect(
    plugins.getByText("DeepSeek Harness", { exact: true }),
  ).toHaveCount(0);
  await expect(
    plugins.getByRole("button", { name: "同步最新版本" }),
  ).toHaveCount(0);
  await expect(
    plugins.getByRole("checkbox", { name: /本任务使用/ }),
  ).toHaveCount(0);
  await plugins.getByRole("button", { name: "完成", exact: true }).click();
  expect(reads).not.toContain("/api/bot/harness");
  await page.getByRole("button", { name: "云端电脑", exact: true }).click();
  const computer = page.getByRole("dialog", { name: "云端电脑", exact: true });
  await expect(
    computer.getByRole("heading", { name: "云端电脑未连接", exact: true }),
  ).toBeVisible();
  await expect(
    computer.getByRole("link", { name: "查看 研究报告.md" }),
  ).toHaveAttribute("href", "/api/bot/artifacts/cloud-file-1/preview");
  await expect(
    computer.getByRole("link", { name: "下载 研究报告.md" }),
  ).toHaveAttribute("href", "/api/bot/artifacts/cloud-file-1");
  await computer
    .getByRole("button", { name: "连接云端电脑", exact: true })
    .click();
  await expect(
    computer.getByRole("heading", { name: "云端电脑已连接", exact: true }),
  ).toBeVisible();
  await computer.getByRole("button", { name: "断开连接", exact: true }).click();
  await expect(
    computer.getByRole("heading", { name: "云端电脑未连接", exact: true }),
  ).toBeVisible();
  await expect(
    computer.getByText("研究报告.md", { exact: true }),
  ).toBeVisible();
  await computer
    .getByRole("button", { name: "连接云端电脑", exact: true })
    .click();
  await expect(
    computer.getByText("研究报告.md", { exact: true }),
  ).toBeVisible();
  await computer.screenshot({
    path: "test-results/bot-cloud-desktop.png",
    animations: "disabled",
  });
  expect(
    writes.filter((write) => write.path.endsWith("/connect")),
  ).toHaveLength(2);
  await computer.getByRole("button", { name: "查看会话" }).click();
  await expect(page.getByRole("dialog", { name: "任务历史" })).toBeVisible();
});

test("cloud lease renewal follows trusted user activity and an idle tab never sends heartbeats", async ({
  page,
}) => {
  await page.clock.install();
  const { writes, cloud } = await fixture(page, false, false, {
    cloudConnected: true,
  });
  await page.clock.fastForward(31 * 60 * 1000);
  expect(
    writes.filter((write) => write.path.endsWith("/heartbeat")),
  ).toHaveLength(0);
  await page.getByRole("textbox", { name: "任务描述" }).click();
  await expect
    .poll(
      () => writes.filter((write) => write.path.endsWith("/heartbeat")).length,
    )
    .toBe(1);
  await page.getByRole("textbox", { name: "任务描述" }).press("A");
  expect(
    writes.filter((write) => write.path.endsWith("/heartbeat")),
  ).toHaveLength(1);
  await page.clock.fastForward(61000);
  expect(
    writes.filter((write) => write.path.endsWith("/heartbeat")),
  ).toHaveLength(1);
  await page.getByRole("textbox", { name: "任务描述" }).press("B");
  await expect
    .poll(
      () => writes.filter((write) => write.path.endsWith("/heartbeat")).length,
    )
    .toBe(2);
  cloud.connected = false;
  cloud.state = "stopped";
  await page.clock.fastForward(31000);
  await page.getByRole("button", { name: "云端电脑", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "云端电脑未连接", exact: true }),
  ).toBeVisible();
  expect(
    writes.filter((write) => write.path.endsWith("/heartbeat")),
  ).toHaveLength(2);
});

test("runtime versions and updates are managed through the administrator cloud settings", async ({
  page,
}) => {
  const { writes } = await fixture(page, false, false, { role: "admin" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: /云端服务/ }).click();
  const panel = page.getByRole("tabpanel", { name: "云端服务", exact: true });
  await expect(
    panel.getByText("DeepSeek Harness", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("当前版本：0.2.0-rc.1 · 最新版本：0.2.0-rc.2"),
  ).toBeVisible();
  await panel.getByRole("button", { name: "同步最新版本" }).click();
  await expect(
    panel.getByText("当前版本：0.2.0-rc.2 · 最新版本：0.2.0-rc.2"),
  ).toBeVisible();
  expect(
    writes.filter((write) => write.path === "/api/bot/harness/update"),
  ).toHaveLength(1);
  await panel.screenshot({
    path: "test-results/cloud-settings-admin.png",
    animations: "disabled",
  });
});

test("cloud files and connect controls remain usable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.getByRole("button", { name: "云端电脑", exact: true }).click();
  const computer = page.getByRole("dialog", { name: "云端电脑", exact: true });
  await expect(
    computer.getByRole("button", { name: "连接云端电脑", exact: true }),
  ).toBeVisible();
  await expect(
    computer.getByRole("link", { name: "查看 研究报告.md" }),
  ).toBeVisible();
  expect(
    await computer.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await computer.screenshot({
    path: "test-results/bot-cloud-mobile.png",
    animations: "disabled",
  });
});

for (const legacy of [false, true]) {
  test(`cloud file pagination follows ${legacy ? "raw-page fallback" : "server next offset"} after hidden rows`, async ({
    page,
  }) => {
    await fixture(page);
    const offsets: number[] = [];
    const file = (id: number) => ({
      id: `paged-file-${id}`,
      task_id: "saved-task",
      task_title: "已保存会话",
      name: `报告-${id}.md`,
      kind: "markdown",
      size: 100,
      created_at: Date.now(),
      url: `/api/bot/artifacts/paged-file-${id}`,
      download_url: `/api/bot/artifacts/paged-file-${id}`,
      preview_url: null,
      previewable: false,
      content_type: "text/markdown",
    });
    await page.route("**/api/bot/cloud/files**", (route) => {
      const offset = Number(
        new URL(route.request().url()).searchParams.get("offset"),
      );
      offsets.push(offset);
      return route.fulfill({
        json: {
          // Permission filtering leaves only two visible files in 100 scanned rows.
          files:
            offset === 0
              ? [file(1), file(2)]
              : offset === 100
                ? [file(3)]
                : [file(2)],
          has_more: offset !== 100,
          offset,
          limit: 100,
          ...(!legacy ? { next_offset: offset === 0 ? 100 : null } : {}),
        },
      });
    });
    await page.getByRole("button", { name: "云端电脑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "云端电脑", exact: true });
    await expect(dialog.locator(".bot-cloud-files article")).toHaveCount(2);
    await dialog
      .getByRole("button", { name: "加载更多文件", exact: true })
      .click();
    await expect(dialog.locator(".bot-cloud-files article")).toHaveCount(3);
    expect([...new Set(offsets)]).toEqual([0, 100]);
    await expect(
      dialog.getByRole("link", { name: "下载 报告-3.md" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "加载更多文件", exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: /^查看/ })).toHaveCount(0);
  });
}
