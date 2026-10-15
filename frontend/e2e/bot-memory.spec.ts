import { openComposerMore, openComposerResource } from "./composer-helpers";
import { expect, test, type Page } from "@playwright/test";

// Client/API contract tests with mocked endpoints. These do not verify a live
// MemoryCore or Memory-Knowledge deployment; backend/provider tests do that.
type Write = { path: string; method: string; body: any };
async function fixture(
  page: Page,
  options: {
    configured?: boolean;
    task?: boolean;
    queued?: boolean;
    invalid?: boolean;
    failSearch?: boolean;
  } = {},
) {
  const now = Date.now(),
    configured = options.configured !== false;
  const writes: Write[] = [],
    skills: any[] = [];
  const settings = { enabled: true, capture: true, skill_capture: true };
  const memories: any[] = [
    {
      id: "m-1",
      content: "报告先写结论",
      kind: "preference",
      status: "pending",
      source_task_id: "task-1",
      created_at: now,
      updated_at: now,
    },
  ];
  const candidates: any[] = [
    {
      id: "candidate-1",
      task_id: "task-1",
      name: "核对研究来源",
      description: "研究资料时核对来源",
      instructions: options.queued ? "" : "1. 阅读来源资料\n2. 逐条核对引用",
      status: "pending",
      source_valid: !options.invalid,
      extraction_state: options.queued ? "queued" : "ready",
      version: 1,
      created_at: now,
      updated_at: now,
    },
  ];
  const assets: any[] = [
    {
      id: "wiki-1",
      kind: "wiki",
      name: "产品 Wiki",
      status: "ready",
      document_ids: ["doc-1"],
      created_at: now,
      updated_at: now,
    },
    {
      id: "graph-1",
      kind: "code_graph",
      name: "知小汇 CodeGraph",
      status: "ready",
      document_ids: [],
      repository_url: "https://github.com/example/knowledge.git",
      created_at: now,
      updated_at: now,
    },
  ];
  const docs = [
    {
      id: "doc-1",
      title: "产品说明",
      space_name: "研发资料",
      status: "ready",
      updated_at: now,
      version: 1,
      tags: "",
      mime_type: "text/plain",
      size: 100,
    },
  ];
  const tasks: any[] = [
    {
      id: "task-1",
      title: "已完成研究任务",
      prompt: "研究产品",
      result: "任务已完成，来源已核对。",
      error: null,
      status: "completed",
      created_at: now,
      updated_at: now,
      attempt: 1,
      options: {
        memory_enabled: false,
        knowledge_asset_ids: ["wiki-1"],
        document_ids: [],
        skill_ids: [],
        connector_ids: [],
        plugin_ids: [],
      },
      plan: [],
      citations: [],
      web_sources: [],
    },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    if (method !== "GET") writes.push({ path, method, body });
    const json = (data: unknown) => route.fulfill({ json: data });
    if (path === "/api/auth/me")
      return json({
        user: {
          id: "user-1",
          tenant_id: "tenant-1",
          name: "经验测试成员",
          role: "member",
          active: true,
        },
        tenant: { id: "tenant-1", name: "测试企业", slug: "test" },
      });
    if (path === "/api/stats")
      return json({
        counts: { documents: 1, chunks: 1, images: 0, pending: 0 },
        spaces: 1,
        capabilities: { models: {} },
      });
    if (path === "/api/personal/preferences")
      return json({ auto_archive: true, space_id: null });
    if (path === "/api/documents") return json({ items: docs, total: 1 });
    if (
      [
        "/api/spaces",
        "/api/conversations",
        "/api/bot/devices",
        "/api/bot/connectors",
      ].includes(path)
    )
      return json([]);
    if (path === "/api/bot/skills") return json(skills);
    if (path === "/api/bot/capabilities")
      return json({
        agent: true,
        web: false,
        code: false,
        worker: true,
        model: "fixture",
      });
    if (path === "/api/bot/cloud")
      return json({
        available: false,
        connected: false,
        state: "unavailable",
        idle_timeout_seconds: 1800,
        active_tasks: 0,
        pending_tasks: 0,
        persistent: true,
      });
    if (path === "/api/bot/plugins/catalog")
      return json({ plugins: [], marketplaces: [] });
    if (path === "/api/bot/game/inspiration/leaderboard")
      return json({ entries: [], me: null, total: 0 });
    if (path === "/api/bot/memory/providers")
      return json({ core: { configured }, knowledge: { configured } });
    if (path === "/api/bot/memory/settings") {
      if (method === "PUT") Object.assign(settings, body);
      return json(settings);
    }
    if (path === "/api/bot/memories") {
      if (method === "GET")
        return json({ items: memories, settings, provider: { configured } });
      if (method === "POST") {
        const memory = {
          id: `m-${memories.length + 1}`,
          ...body,
          status: "active",
          created_at: now,
          updated_at: now,
        };
        memories.push(memory);
        return json(memory);
      }
      memories.length = 0;
      return json({ ok: true });
    }
    if (path.startsWith("/api/bot/memories/")) {
      if (path.endsWith("/forget")) {
        memories.length = 0;
        settings.capture = false;
        return json({ ok: true });
      }
      const memory = memories.find((item) => item.id === path.split("/")[4]);
      if (path.endsWith("/review"))
        memory.status = body.decision === "approve" ? "active" : "deleted";
      else if (method === "PUT") Object.assign(memory, body);
      else if (method === "DELETE")
        memories.splice(memories.indexOf(memory), 1);
      return json(memory || { ok: true });
    }
    if (path === "/api/bot/skill-candidates") {
      if (method === "GET") return json(candidates);
      const candidate = {
        id: `candidate-${candidates.length + 1}`,
        ...body,
        name: body.name || "从任务提炼的技能",
        description: body.description || "完成任务的方法",
        instructions: body.instructions || "1. 分析任务结果\n2. 核对资料来源",
        status: "pending",
        source_valid: true,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      candidates.push(candidate);
      return json(candidate);
    }
    if (path.startsWith("/api/bot/skill-candidates/")) {
      const candidate = candidates.find(
        (item) => item.id === path.split("/")[4],
      );
      if (path.endsWith("/review")) {
        candidate.status =
          body.decision === "approve" ? "approved" : "rejected";
        candidate.review_note = body.note;
        if (body.decision === "approve") {
          candidate.skill_id = "skill-1";
          skills.push({
            id: "skill-1",
            name: candidate.name,
            description: candidate.description,
            instructions: candidate.instructions,
          });
        }
      } else if (method === "PUT")
        Object.assign(candidate, body, {
          version: candidate.version + 1,
          extraction_state: "ready",
        });
      else if (method === "DELETE") {
        candidates.splice(candidates.indexOf(candidate), 1);
        const index = skills.findIndex(
          (skill) => skill.id === candidate.skill_id,
        );
        if (index >= 0) skills.splice(index, 1);
      }
      return json(candidate || { ok: true });
    }
    if (path === "/api/bot/knowledge/assets") {
      if (method === "GET") return json({ items: assets });
      const asset = {
        id: `asset-${assets.length + 1}`,
        ...body,
        document_ids: body.document_ids || [],
        status: "queued",
        created_at: now,
        updated_at: now,
      };
      assets.push(asset);
      return json(asset);
    }
    if (path.startsWith("/api/bot/knowledge/assets/")) {
      const asset = assets.find((item) => item.id === path.split("/")[5]);
      if (path.endsWith("/search") || path.endsWith("/tools")) {
        if (options.failSearch)
          return route.fulfill({
            status: 503,
            json: { error: "知识服务暂不可用" },
          });
        return json({
          asset_id: asset.id,
          kind: asset.kind,
          result: {
            text: "已找到：系统概述，页面引用 wiki://product/overview",
          },
          sources:
            asset.kind === "wiki"
              ? [{ document_id: "doc-1", version: 1, title: "产品说明" }]
              : [],
          repository_url: asset.repository_url,
        });
      }
      if (method === "DELETE") {
        assets.splice(assets.indexOf(asset), 1);
        return json({ ok: true });
      }
      if (path.endsWith("/sync")) asset.status = "queued";
      return json({
        ...asset,
        metadata: { page_count: asset.kind === "wiki" ? 2 : undefined },
      });
    }
    if (path === "/api/bot/tasks") {
      if (method === "GET") return json(tasks);
      const task = {
        ...tasks[0],
        id: `task-${tasks.length + 1}`,
        title: body.prompt,
        prompt: body.prompt,
        options: body.options,
        status: "queued",
        result: "",
      };
      tasks.unshift(task);
      return json({ id: task.id });
    }
    if (path.endsWith("/stream"))
      return route.fulfill({
        status: 503,
        json: { error: "Fixture does not stream" },
      });
    if (path.startsWith("/api/bot/tasks/"))
      return json({
        task: tasks.find((task) => task.id === path.split("/")[4]),
        evidence_available: true,
        messages: [],
        events: [],
        actions: [],
        artifacts: [],
      });
    return route.fulfill({
      status: 404,
      json: { error: "Unknown API fixture" },
    });
  });
  await page.goto(`/app?view=bot${options.task ? "&task=task-1" : ""}`);
  await expect(page.getByRole("heading", { name: "知小汇 bot" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "更多", exact: true }),
  ).toBeVisible();
  return { writes, candidates, assets, memories };
}
async function openLibrary(page: Page) {
  const account = page.getByRole("button", { name: "账号菜单" });
  await page.locator(".account-trigger").waitFor({ state: "attached" });
  if (!(await account.isVisible()))
    await page.getByRole("button", { name: "展开系统侧边栏" }).click();
  await account.click();
  await page.getByRole("menuitem", { name: "个人中心" }).click();
  await page.getByRole("button", { name: "管理记忆与经验" }).click();
  const dialog = page.getByRole("dialog", { name: "记忆与经验", exact: true });
  await expect(dialog.getByText("报告先写结论", { exact: true })).toBeVisible();
  return dialog;
}

test.describe("memory and experience UI — API fixtures", () => {
  test("personal center manages experience outside Bot and opens source task", async ({
    page,
  }) => {
    await fixture(page);
    await page.goto("/app");
    const dialog = await openLibrary(page);
    await dialog.getByRole("button", { name: /来源：已完成研究任务/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "知小汇 bot" }),
    ).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("task"))
      .toBe("task-1");
    await expect(
      page.getByRole("button", { name: "从本任务提炼技能" }),
    ).toHaveCount(0);
  });
  test("disabling skill extraction blocks an already open form while review stays available", async ({
    page,
  }) => {
    const { writes } = await fixture(page, { task: true });
    const dialog = await openLibrary(page);
    await dialog.getByRole("tab", { name: "技能审核" }).click();
    await dialog
      .getByRole("button", { name: "从任务提炼", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "生成技能草稿", exact: true }),
    ).toBeEnabled();
    await page.route("**/api/bot/memory/settings", (route) =>
      route.fulfill({
        json: { enabled: true, capture: true, skill_capture: false },
      }),
    );
    await dialog.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "生成技能草稿", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "从任务提炼", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "审核并加入技能库", exact: true }),
    ).toBeEnabled();
    expect(
      writes.some((write) => write.path === "/api/bot/skill-candidates"),
    ).toBe(false);
  });
  test("memory CRUD and forgetting use explicit mutations", async ({
    page,
  }, testInfo) => {
    const { writes } = await fixture(page),
      dialog = await openLibrary(page);
    await page.screenshot({
      path: testInfo.outputPath("experience-desktop.png"),
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "添加记忆" }).click();
    await dialog.getByLabel("记忆类型").selectOption("constraint");
    await dialog.getByLabel("记忆内容").fill("报表统一使用人民币口径");
    await dialog.getByRole("button", { name: "保存记忆" }).click();
    const card = dialog
      .locator(".bot-memory-card")
      .filter({ hasText: "报表统一使用人民币口径" });
    await expect(card.getByText("已生效", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog
      .getByLabel("记忆内容")
      .fill("报表使用人民币，金额保留两位小数");
    await dialog.getByRole("button", { name: "保存记忆" }).click();
    await expect(
      dialog.getByText("报表使用人民币，金额保留两位小数", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "忘记全部记忆" }).click();
    const confirmation = page.getByRole("dialog", { name: "请确认" });
    await expect(confirmation).toContainText("已审核和待审核");
    await confirmation
      .getByRole("button", { name: "确定", exact: true })
      .click();
    await expect(
      dialog.getByText("还没有个人记忆", { exact: true }),
    ).toBeVisible();
    expect(
      writes.some(
        (write) =>
          write.method === "PUT" && write.path.includes("/memories/m-"),
      ),
    ).toBeTruthy();
    expect(
      writes.some(
        (write) =>
          write.method === "POST" && write.path === "/api/bot/memories/forget",
      ),
    ).toBeTruthy();
  });
  test("task options preserve memory opt-out and only selected ready assets", async ({
    page,
  }) => {
    const { writes } = await fixture(page, { task: true });
    await openComposerMore(page);
    await expect(
      page.getByRole("switch", { name: "本任务使用个人记忆" }),
    ).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("产品 Wiki", { exact: true })).toBeVisible();
    await openComposerResource(page, "项目知识");
    await page
      .getByRole("dialog", { name: "选择项目知识" })
      .getByLabel("知小汇 CodeGraph")
      .check();
    await page.getByRole("button", { name: "关闭选择面板" }).click();
    await page
      .getByRole("textbox", { name: "继续对话", exact: true })
      .fill("结合代码关系继续研究");
    await page.getByRole("button", { name: "继续对话", exact: true }).click();
    await expect
      .poll(
        () =>
          writes.find((write) => write.path === "/api/bot/tasks")?.body.options,
      )
      .toMatchObject({
        memory_enabled: false,
        knowledge_asset_ids: ["wiki-1", "graph-1"],
        parent_task_id: "task-1",
      });
  });
  test("review publishes skill after versioned edit and revoke removes it", async ({
    page,
  }) => {
    const { writes } = await fixture(page),
      dialog = await openLibrary(page);
    await dialog.getByRole("tab", { name: "技能审核", exact: true }).click();
    await dialog.getByRole("button", { name: "编辑草稿" }).click();
    await dialog
      .getByLabel("候选技能操作步骤")
      .fill("1. 记录资料版本\n2. 核对引用与口径\n3. 标记无法验证的内容");
    await dialog.getByRole("button", { name: "保存草稿" }).click();
    await dialog
      .getByLabel("审核意见 核对研究来源")
      .fill("适用于有明确来源的研究任务");
    await dialog.getByRole("button", { name: "审核并加入技能库" }).click();
    await dialog.getByLabel("技能审核状态").selectOption("approved");
    await expect(dialog.getByText("已入技能库", { exact: true })).toBeVisible();
    expect(
      writes.find((write) => write.path.endsWith("candidate-1/review"))?.body,
    ).toMatchObject({
      decision: "approve",
      version: 2,
      note: "适用于有明确来源的研究任务",
    });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("dialog", { name: "个人中心" })
      .getByRole("button", { name: "完成" })
      .click();
    await openComposerResource(page, "技能");
    await expect(
      page.getByRole("dialog", { name: "选择技能" }).getByLabel("核对研究来源"),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭选择面板" }).click();
    await openLibrary(page);
    await dialog.getByRole("tab", { name: "技能审核" }).click();
    await dialog.getByLabel("技能审核状态").selectOption("approved");
    await dialog.getByRole("button", { name: "撤回技能" }).click();
    await expect(page.getByRole("dialog", { name: "请确认" })).toContainText(
      "新任务将不能再选择",
    );
    await page
      .getByRole("dialog", { name: "请确认" })
      .getByRole("button", { name: "确定", exact: true })
      .click();
    await expect(dialog.getByText("暂无此状态的候选技能")).toBeVisible();
  });
  test("completed task extraction submits a pending draft for human review", async ({
    page,
  }) => {
    const { writes } = await fixture(page, { task: true });
    await expect(
      page.getByRole("button", { name: "从本任务提炼技能" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".bot-heading").getByRole("button", { name: "记忆与经验" }),
    ).toHaveCount(0);
    const dialog = await openLibrary(page);
    await dialog.getByRole("tab", { name: "技能审核" }).click();
    await dialog
      .getByRole("button", { name: "从任务提炼", exact: true })
      .click();
    await expect(dialog.getByLabel("技能来源任务")).toHaveValue("task-1");
    await dialog
      .getByRole("button", { name: "生成技能草稿", exact: true })
      .click();
    await expect
      .poll(
        () =>
          writes.find((write) => write.path === "/api/bot/skill-candidates")
            ?.body,
      )
      .toEqual({ task_id: "task-1" });
    const card = dialog.locator(".bot-memory-card").filter({
      has: page.getByRole("heading", {
        name: "从任务提炼的技能",
        exact: true,
      }),
    });
    await expect(card.getByText("待审核", { exact: true })).toBeVisible();
    expect(writes.some((write) => write.path.endsWith("/review"))).toBeFalsy();
  });
  for (const state of ["queued", "invalid"] as const) {
    test(`${state} candidates cannot be approved`, async ({ page }) => {
      await fixture(page, { [state]: true });
      const dialog = await openLibrary(page);
      await dialog.getByRole("tab", { name: "技能审核" }).click();
      await expect(
        dialog.getByRole("button", { name: "审核并加入技能库" }),
      ).toBeDisabled();
      if (state === "queued")
        await expect(
          dialog.getByText("技能正在提炼中，完成后可审核。"),
        ).toBeVisible();
      else {
        await expect(
          dialog.getByRole("button", { name: "编辑草稿" }),
        ).toBeDisabled();
        await expect(
          dialog.getByText("来源资料已更新或权限已变化", { exact: false }),
        ).toBeVisible();
      }
    });
  }
  test("Wiki uses selected document sources and CodeGraph sends symbol arguments", async ({
    page,
  }) => {
    const { writes } = await fixture(page),
      dialog = await openLibrary(page);
    await dialog.getByRole("tab", { name: "Wiki 与代码" }).click();
    await dialog.getByRole("button", { name: "创建知识资产" }).click();
    await dialog.getByLabel("知识资产名称").fill("研发 Wiki");
    await dialog.getByLabel("产品说明").check();
    await dialog.getByRole("button", { name: "开始构建" }).click();
    await expect
      .poll(
        () =>
          writes.find((write) => write.path === "/api/bot/knowledge/assets")
            ?.body,
      )
      .toEqual({ kind: "wiki", name: "研发 Wiki", document_ids: ["doc-1"] });
    await dialog
      .locator(".bot-memory-card")
      .filter({
        has: page.getByRole("heading", { name: "产品 Wiki", exact: true }),
      })
      .getByRole("button", { name: "查看与检索" })
      .click();
    await dialog.getByLabel("检索知识资产").fill("系统概述");
    await dialog.getByRole("button", { name: "检索", exact: true }).click();
    await expect(dialog.locator(".bot-memory-output")).toContainText(
      "系统概述",
    );
    await expect(
      dialog.getByRole("button", { name: "产品说明 · v1" }),
    ).toBeVisible();
    await dialog
      .locator(".bot-memory-card")
      .filter({
        has: page.getByRole("heading", {
          name: "知小汇 CodeGraph",
          exact: true,
        }),
      })
      .getByRole("button", { name: "查看与检索" })
      .click();
    await dialog.getByLabel("代码图分析方式").selectOption("callers");
    await dialog.getByLabel("代码图分析对象").fill("start_task");
    await dialog.getByRole("button", { name: "分析", exact: true }).click();
    await expect
      .poll(
        () =>
          writes.find(
            (write) => write.path === "/api/bot/knowledge/assets/graph-1/tools",
          )?.body,
      )
      .toEqual({ name: "callers", arguments: { symbol: "start_task" } });
  });
  test("unconfigured service disables knowledge creation and keeps local memory usable", async ({
    page,
  }) => {
    await fixture(page, { configured: false });
    const dialog = await openLibrary(page);
    await expect(
      dialog.getByText("个人记忆保存在知小汇中", { exact: false }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "添加记忆" }),
    ).toBeEnabled();
    await dialog.getByRole("tab", { name: "Wiki 与代码" }).click();
    await expect(
      dialog.getByRole("button", { name: "创建知识资产" }),
    ).toBeDisabled();
    await expect(
      dialog.getByText("Wiki 与代码服务未配置", { exact: false }),
    ).toBeVisible();
  });
  test("mobile shows provider failure without stale results or horizontal overflow", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, { failSearch: true });
    const dialog = await openLibrary(page);
    await dialog.getByRole("tab", { name: "Wiki 与代码" }).click();
    await dialog
      .locator(".bot-memory-card")
      .filter({
        has: page.getByRole("heading", { name: "产品 Wiki", exact: true }),
      })
      .getByRole("button", { name: "查看与检索" })
      .click();
    await dialog.getByLabel("检索知识资产").fill("系统概述");
    await dialog.getByRole("button", { name: "检索", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("知识服务暂不可用");
    await expect(dialog.locator(".bot-memory-output")).toHaveCount(0);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath("experience-mobile.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "个人中心" })).toBeVisible();
  });
});
