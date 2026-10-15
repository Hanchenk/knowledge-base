import { openComposerMore, openComposerResource } from "./composer-helpers";
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";

test("animation follows display cadence without frame-by-frame React commits", async ({
  page,
  context,
}, testInfo) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__animationCommits = 0;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onCommitFiberRoot: () => w.__animationCommits++,
      onCommitFiberUnmount: () => {},
    };
  });
  await fixture(page);
  await settleEntrance(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const measure = async (selector: string) => {
    const before = await cdp.send("Performance.getMetrics");
    const result = await page.evaluate(async (selector) => {
      const element = document.querySelector(selector)!;
      const stamps: number[] = [],
        frames: number[] = [];
      const start = performance.now(),
        commits = (window as any).__animationCommits;
      const observer = new MutationObserver(() =>
        stamps.push(performance.now()),
      );
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["transform", "style"],
      });
      let raf = 0;
      const stage = element.closest(".inspiration-stage");
      const bounds = (stage || element.closest("svg")!).getBoundingClientRect();
      const tick = (stamp: number) => {
        frames.push(stamp);
        (stage || window).dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
            isPrimary: true,
            clientX: stage
              ? bounds.left +
                bounds.width * (0.5 + 0.32 * Math.sin(stamp / 400))
              : bounds.left + bounds.width / 2 + 250 * Math.sin(stamp / 400),
            clientY: bounds.top + bounds.height / 2,
          }),
        );
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, 3000));
      cancelAnimationFrame(raf);
      observer.disconnect();
      const elapsed = performance.now() - start;
      const intervals = stamps
        .slice(1)
        .map((s, i) => s - stamps[i])
        .sort((a, b) => a - b);
      return {
        updates: stamps.length,
        renderedFps: (stamps.length * 1000) / elapsed,
        displayFps: (frames.length * 1000) / elapsed,
        p95UpdateMs: intervals[Math.floor(intervals.length * 0.95)],
        reactCommits: (window as any).__animationCommits - commits,
      };
    }, selector);
    const after = await cdp.send("Performance.getMetrics");
    const metrics = Object.fromEntries(
      after.metrics
        .filter((m) =>
          ["TaskDuration", "LayoutDuration", "RecalcStyleDuration"].includes(
            m.name,
          ),
        )
        .map((m) => [
          m.name,
          m.value - before.metrics.find((b) => b.name === m.name)!.value,
        ]),
    );
    return { ...result, ...metrics };
  };
  const avatar = await measure(".bot-companion mask path:nth-child(2)");
  await page.getByRole("button", { name: "和知小汇玩接住灵感小游戏" }).click();
  await settleEntrance(page);
  await page.screenshot({
    path: "../docs/screenshots/bot-inspiration-inline-desktop.png",
  });
  await page.getByRole("button", { name: "开始小游戏", exact: true }).click();
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "playing",
  );
  const game = await measure(".inspiration-catcher");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const throttledGame = await measure(".inspiration-catcher");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const evidence = { avatar, game, throttledGame };
  writeFileSync(
    process.env.MOTION_EVIDENCE ||
      testInfo.outputPath("animation-performance.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
  for (const result of [avatar, game, throttledGame]) {
    expect(result.renderedFps / result.displayFps).toBeGreaterThan(0.8);
    expect(result.reactCommits).toBeLessThan(25);
  }
});

test.beforeEach(async ({ page }) => {
  // Exercise the LAN HTTP path even when the test runs on secure localhost.
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
});

async function expectHeaderAvatarCentered(page: Page) {
  const offset = await page.locator(".bot-avatar").evaluate((element) => {
    const slot = element.getBoundingClientRect();
    const avatar = element.querySelector("svg")!.getBoundingClientRect();
    return Math.max(
      Math.abs(avatar.x + avatar.width / 2 - slot.x - slot.width / 2),
      Math.abs(avatar.y + avatar.height / 2 - slot.y - slot.height / 2),
    );
  });
  expect(offset).toBeLessThanOrEqual(0.5);
}

async function settleEntrance(page: Page) {
  await page.locator(".bot-page").evaluate(async (element) => {
    await Promise.race([
      Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      ),
      new Promise((resolve) => setTimeout(resolve, 800)),
    ]);
  });
}

async function fixture(page: Page, withResources = false) {
  let gameBest: number | null = null;
  const gameRequests: any[] = [];
  const gameRuns: string[] = [];
  const gameBoard = () => {
    const members = [
      { user_id: "peer-one", name: "林小满", score: 12, is_me: false },
      { user_id: "peer-two", name: "许星河", score: 8, is_me: false },
      ...(gameBest === null
        ? []
        : [
            {
              user_id: "bot-owner",
              name: "测试成员",
              score: gameBest,
              is_me: true,
            },
          ]),
    ].sort((a, b) => b.score - a.score);
    const entries = members.map((member) => ({
      ...member,
      rank: members.findIndex((m) => m.score === member.score) + 1,
    }));
    return {
      entries,
      me: entries.find((entry) => entry.is_me) || null,
      total: entries.length,
    };
  };
  const tasks: any[] = [],
    requests: any[] = [],
    connectors: any[] = withResources
      ? [
          {
            id: "calendar",
            name: "团队日历",
            description: "查看团队安排",
            method: "GET",
            url: "https://api.example.test/calendar",
            has_token: true,
          },
        ]
      : [];
  const docs = withResources
    ? Array.from({ length: 11 }, (_, index) => ({
        id: `document-${index}`,
        title: `业务报表 ${index + 1}`,
        space_name: "团队资料",
        status: "ready",
      }))
    : [];
  const skills: any[] = [
    {
      id: "research",
      name: "深度研究",
      description: "核对来源并交付研究报告",
      instructions: "检索证据，保存报告",
      builtin: true,
    },
    {
      id: "meeting",
      name: "会议纪要",
      description: "整理决策与行动项",
      instructions: "保留原始决策",
      builtin: true,
    },
    {
      id: "analysis",
      name: "数据分析",
      description: "核对口径与数据",
      instructions: "核对数据",
      builtin: true,
    },
    {
      id: "writing",
      name: "文档写作",
      description: "起草完整文档",
      instructions: "交付文档",
      builtin: true,
    },
  ];
  let phase = "queued",
    approved = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: "bot-owner",
            tenant_id: "bot-tenant",
            name: "测试成员",
            role: "admin",
            active: true,
          },
          tenant: { id: "bot-tenant", name: "测试企业", slug: "fixture" },
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
    if (path === "/api/spaces") return route.fulfill({ json: [] });
    if (path === "/api/documents")
      return route.fulfill({ json: { items: docs, total: docs.length } });
    if (path === "/api/bot/capabilities")
      return route.fulfill({
        json: {
          agent: true,
          model: "fixture-agent",
          web: true,
          code: true,
          code_configured: true,
          connectors_enabled: true,
          connector_hosts: ["api.example.test:443"],
          cross_device: true,
          worker: true,
        },
      });
    if (path === "/api/bot/devices") return route.fulfill({ json: [] });
    if (path === "/api/bot/game/inspiration/leaderboard")
      return route.fulfill({ json: gameBoard() });
    if (path === "/api/bot/game/inspiration/runs") {
      const id = `run-${gameRuns.length + 1}`;
      gameRuns.push(id);
      gameRequests.push({ path, method });
      return route.fulfill({ json: { id, duration_seconds: 15 } });
    }
    if (/\/api\/bot\/game\/inspiration\/runs\/run-\d+\/finish$/.test(path)) {
      const input = request.postDataJSON();
      gameRequests.push({ path, method, ...input });
      gameBest = Math.max(gameBest ?? 0, input.score);
      return route.fulfill({
        json: { ...gameBoard(), submitted_score: input.score },
      });
    }
    if (path === "/api/bot/tasks" && method === "POST") {
      const input = request.postDataJSON();
      requests.push(input);
      const task = {
        ...input,
        id: `task-${tasks.length + 1}`,
        title: input.prompt,
        created_at: Date.now(),
        updated_at: Date.now(),
        attempt: 1,
        status: "queued",
      };
      tasks.unshift(task);
      phase = "queued";
      return route.fulfill({ json: { id: task.id } });
    }
    if (path === "/api/bot/tasks")
      return route.fulfill({
        json: tasks,
      });
    if (/\/api\/bot\/tasks\/task-\d+$/.test(path)) {
      const task = tasks.find((t) => t.id === path.split("/").at(-1));
      if (!task)
        return route.fulfill({ status: 404, json: { error: "任务不存在" } });
      const phase = task.status;
      return route.fulfill({
        json: {
          messages: task.messages || [],
          task: {
            ...task,
            status: phase,
            error: phase === "failed" ? "模型暂时不可用" : null,
            result: ["completed", "waiting"].includes(phase)
              ? task.result || "## 已核对的报告\n\n这是根据授权资料生成的结果。"
              : "",
            citations: [],
            web_sources: [],
            plan:
              phase === "queued"
                ? []
                : [
                    {
                      title: "整理资料",
                      status: phase === "completed" ? "completed" : "running",
                    },
                    {
                      title: "保存成果",
                      status: phase === "completed" ? "completed" : "pending",
                    },
                  ],
          },
          evidence_available: true,
          events: [
            {
              id: "event-one",
              kind: "status",
              content: { message: "开始处理任务" },
              created_at: Date.now(),
            },
            ...(phase !== "queued"
              ? [
                  {
                    id: "event-two",
                    kind: "tool",
                    content: { name: "knowledge_search", success: true },
                    created_at: Date.now(),
                  },
                ]
              : []),
          ],
          artifacts:
            phase === "completed"
              ? [{ id: "artifact-one", name: "研究报告.md", size: 1500 }]
              : [],
          actions:
            phase === "waiting"
              ? [
                  {
                    id: "action-one",
                    name: "项目任务",
                    status: "pending",
                    payload: {
                      method: "POST",
                      url: "https://api.example.test/tasks",
                      input: { title: "用户可以核对的标题" },
                    },
                    result: "",
                  },
                ]
              : [],
        },
      });
    }
    if (path.endsWith("/approve")) {
      approved = true;
      phase = "running";
      tasks[0].status = phase;
      return route.fulfill({ json: { status: "completed" } });
    }
    if (path.endsWith("/cancel")) {
      phase = "cancelled";
      tasks[0].status = phase;
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/retry")) {
      phase = "queued";
      tasks[0].status = phase;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/bot/skills" && method === "POST") {
      const input = request.postDataJSON();
      skills.push({ ...input, id: "skill-imported" });
      return route.fulfill({ json: { id: "skill-imported" } });
    }
    if (path === "/api/bot/skills") return route.fulfill({ json: skills });
    if (path === "/api/bot/connectors" && method === "POST") {
      const input = request.postDataJSON();
      connectors.push({
        ...input,
        token: undefined,
        has_token: !!input.token,
        id: "connector-one",
      });
      return route.fulfill({ json: { id: "connector-one" } });
    }
    if (path === "/api/bot/connectors")
      return route.fulfill({ json: connectors });
    return route.fulfill({
      status: 404,
      json: { error: "Unknown fixture path" },
    });
  });
  await page.goto("/app?view=bot");
  await expect(page.getByRole("heading", { name: "知小汇 bot" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "这次，让我来帮你完成。" }),
  ).toBeVisible();
  return {
    gameRequests,
    tasks,
    requests,
    skills,
    connectors,
    setPhase: (status: string) => {
      phase = status;
      if (tasks[0]) tasks[0].status = status;
    },
    approved: () => approved,
  };
}

test("bot tasks update bloub expressions, restore work and continue conversations", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page);
  const avatar = page.locator(".bot-heading .bloub-avatar");
  await expectHeaderAvatarCentered(page);
  await expect(avatar).toHaveAttribute("data-mood", "idle");
  const path = avatar.locator("mask path").first();
  const before = await path.getAttribute("d");
  await page.getByLabel("任务描述").fill("研究企业知识管理方法，整理报告");
  await expect(avatar).toHaveAttribute("data-mood", "listening");
  await openComposerResource(page, "技能");
  await page
    .locator(".bot-picker label")
    .filter({ hasText: "深度研究" })
    .locator("input")
    .check();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await openComposerResource(page, "云端");
  await page.getByRole("button", { name: "关闭选择面板" }).click();
  await page.getByRole("button", { name: "开始任务" }).click();
  await expect(avatar).toHaveAttribute("data-mood", "thinking");
  expect(f.requests[0].options.skill_ids).toEqual(["research"]);
  expect(f.requests[0].options.allow_web).toBe(false);
  f.setPhase("running");
  await page.getByTitle("刷新任务").click();
  await expect(avatar).toHaveAttribute("data-mood", "working");
  await expect(page.getByRole("heading", { name: "任务步骤" })).toBeHidden();
  await page.locator(".bot-process summary").click();
  await expect(page.getByRole("heading", { name: "任务步骤" })).toBeVisible();
  await page.locator(".bot-process summary").click();
  await expect.poll(() => path.getAttribute("d")).not.toBe(before);
  f.setPhase("waiting");
  await page.getByTitle("刷新任务").click();
  await expect(avatar).toHaveAttribute("data-mood", "waiting");
  await expect(
    page.getByText('"用户可以核对的标题"', { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认执行" }).click();
  expect(f.approved()).toBe(true);
  f.setPhase("completed");
  await page.getByTitle("刷新任务").click();
  await expect(avatar).toHaveAttribute("data-mood", "success");
  await page.getByRole("button", { name: "1 个成果文件" }).click();
  await expect(page.getByRole("link", { name: /研究报告.md/ })).toHaveAttribute(
    "href",
    "/api/bot/artifacts/artifact-one",
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "任务成果" })).toBeVisible();
  await expect(page).toHaveURL(/view=bot&task=task-1/);
  await page
    .getByLabel("继续对话", { exact: true })
    .fill("请再整理一个简短版本");
  await page.getByRole("button", { name: "继续对话", exact: true }).click();
  expect(f.requests[1].options.parent_task_id).toBe("task-1");
  expect(f.requests[1].options.allow_web).toBe(false);
  await expect(page.locator(".bot-chat-user")).toHaveCount(2);
  await expect(page.locator(".bot-chat-reply").first()).toContainText(
    "这是根据授权资料生成的结果。",
  );
  expect(errors).toEqual([]);
});

test("bot supports mobile, imported skills and real connector request forms", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await expect(page.getByRole("button", { name: "开始任务" })).toBeVisible();
  await expectHeaderAvatarCentered(page);
  await settleEntrance(page);
  await page.screenshot({
    path: "../docs/screenshots/bot-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await openComposerResource(page, "技能");
  await page.getByRole("button", { name: "管理技能", exact: true }).click();
  await page.getByRole("button", { name: "导入 / 创建技能" }).click();
  await page.getByLabel("导入 Markdown / SKILL.md").setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "---\nname: 社区复盘\ndescription: 整理项目复盘\n---\n核对证据，整理行动项。",
    ),
  });
  await expect(page.getByLabel("技能名称")).toHaveValue("社区复盘");
  await page.getByRole("button", { name: "保存技能" }).click();
  await expect(page.getByRole("heading", { name: "社区复盘" })).toBeVisible();
  expect(f.skills.at(-1).instructions).toBe("核对证据，整理行动项。");
  await page
    .getByRole("dialog", { name: "管理技能", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await openComposerResource(page, "应用连接器");
  await page.getByRole("button", { name: "管理连接器", exact: true }).click();
  await page
    .getByRole("button", { name: "自定义连接器", exact: true })
    .first()
    .click();
  await page.getByLabel("连接器名称").fill("企业项目工具");
  await page.getByLabel("固定 API 地址").fill("https://api.example.test/tasks");
  await page.getByLabel("操作方式").selectOption("POST");
  await page.getByLabel("Bearer Token").fill("browser-fixture-secret");
  await page.getByRole("button", { name: "保存连接器" }).click();
  await expect(
    page.getByRole("heading", { name: "企业项目工具" }),
  ).toBeVisible();
  expect(f.connectors[0].method).toBe("POST");
  await page
    .getByRole("dialog", { name: "管理应用连接器", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await settleEntrance(page);
  await page.screenshot({
    path: "../docs/screenshots/bot-desktop.png",
    fullPage: true,
  });
});

test("bloub honors reduced motion and task failure/cancellation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const f = await fixture(page);
  const avatar = page.locator(".bot-heading .bloub-avatar");
  await expect(avatar).toHaveAttribute("data-motion", "reduced");
  expect(
    await page
      .locator(".bot-orbit")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  const eye = avatar.locator("mask path").last();
  const initial = await eye.getAttribute("transform");
  await expect(eye).toHaveAttribute("transform", initial!);
  await page.getByLabel("任务描述").fill("失败恢复测试");
  await page.getByRole("button", { name: "开始任务" }).click();
  f.setPhase("failed");
  await page.getByTitle("刷新任务").click();
  await expect(avatar).toHaveAttribute("data-mood", "error");
  await expect(page.getByText("模型暂时不可用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "从保存进度继续" }).click();
  await expect(avatar).toHaveAttribute("data-mood", "thinking");
  await page.getByRole("button", { name: "取消任务" }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(avatar).toHaveAttribute("data-mood", "sleep");
});

test("composer searches, limits selections and submits the chosen resources", async ({
  page,
}) => {
  const f = await fixture(page, true);
  await expect(page.getByText("从知识到行动", { exact: true })).toHaveCount(0);
  await expect(page.locator(".bot-tabs")).toHaveCount(0);
  await page.getByLabel("任务描述").fill("分析业务报表并核对日历");
  await openComposerResource(page, "资料");
  const documents = page.getByRole("dialog", { name: "选择资料", exact: true });
  await page.getByRole("searchbox", { name: "搜索资料" }).fill("业务报表 11");
  await page.getByRole("searchbox", { name: "搜索资料" }).press("Enter");
  expect(f.requests).toHaveLength(0);
  await expect(documents.getByRole("checkbox")).toHaveCount(1);
  await documents.getByRole("checkbox").check();
  await page.getByRole("searchbox", { name: "搜索资料" }).fill("");
  for (let i = 0; i < 9; i++)
    await documents.getByRole("checkbox").nth(i).check();
  await expect(documents.getByRole("checkbox").nth(9)).toBeDisabled();
  await expect(documents.getByRole("status")).toContainText("已达到选择上限");
  await page.keyboard.press("Escape");
  await expect(documents).toBeHidden();
  await expect(
    page.getByRole("button", { name: "更多", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "移除 业务报表 1", exact: true })
    .click();
  await openComposerResource(page, "应用连接器");
  await page
    .getByRole("dialog", { name: "选择应用连接器" })
    .getByRole("checkbox")
    .check();
  await openComposerResource(page, "技能");
  await page
    .getByRole("dialog", { name: "选择技能", exact: true })
    .getByRole("checkbox")
    .first()
    .check();
  await openComposerResource(page, "云端");
  await page.getByRole("button", { name: "关闭选择面板" }).click();
  await page.getByLabel("任务描述").fill("分析业务报表并核对日历");
  await page.getByRole("button", { name: "开始任务" }).click();
  await expect(page).toHaveURL(/task=task-1/);
  expect(f.requests[0].options.document_ids).toHaveLength(9);
  expect(f.requests[0].options.document_ids).not.toContain("document-0");
  expect(f.requests[0].options.connector_ids).toEqual(["calendar"]);
  expect(f.requests[0].options.skill_ids).toEqual(["research"]);
  expect(f.requests[0].options.allow_code).toBe(false);
  expect(f.requests[0].options.allow_web).toBe(false);
  f.setPhase("completed");
  await page.getByTitle("刷新任务").click();
  await openComposerResource(page, "云端");
  await page.getByRole("button", { name: "关闭选择面板" }).click();
  await page.getByLabel("继续对话", { exact: true }).fill("补充公开来源");
  await page.getByLabel("继续对话", { exact: true }).press("Control+Enter");
  await expect(page).toHaveURL(/task=task-2/);
  expect(f.requests[1].options.parent_task_id).toBe("task-1");
  expect(f.requests[1].options.allow_code).toBe(false);
  expect(f.requests[1].options.allow_web).toBe(false);
});

for (const width of [1440, 390]) {
  test(`composer more combines tools without wrapping at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const f = await fixture(page, true);
    await settleEntrance(page);
    const composer = page.locator(".bot-composer");
    const toolbar = composer.locator(".bot-composer-tools");
    const more = composer.getByRole("button", { name: "更多", exact: true });
    const prompt = page.getByRole("textbox", { name: "任务描述" });
    await prompt.fill("核对资料与公开来源，保留这个草稿");
    await expect(toolbar.locator(".bot-more-trigger, .bot-submit")).toHaveCount(
      2,
    );
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const before = (await toolbar.boundingBox())!;
    const composerBefore = (await composer.boundingBox())!;

    const palette = await openComposerMore(page);
    await expect(more).toHaveAttribute("aria-expanded", "true");
    for (const name of [
      "插件市场与任务插件",
      "技能",
      "资料",
      "项目知识",
      "应用连接器",
      "云端",
    ])
      await expect(
        palette.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    const web = palette.getByRole("switch", {
      name: "联网搜索",
      exact: true,
    });
    await web.click();
    await expect(web).toHaveAttribute("aria-checked", "true");
    await palette.getByRole("switch", { name: "本任务使用个人记忆" }).click();
    await expect(
      palette.getByRole("switch", { name: "本任务使用个人记忆" }),
    ).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(more).toBeFocused();
    const composerAfterWeb = (await composer.boundingBox())!;
    expect(composerAfterWeb.height).toBeCloseTo(composerBefore.height, 0);
    await expect(prompt).toHaveValue("核对资料与公开来源，保留这个草稿");
    expect(f.requests).toHaveLength(0);

    await openComposerResource(page, "资料");
    const documents = page.getByRole("dialog", {
      name: "选择资料",
      exact: true,
    });
    for (let index = 0; index < 3; index++)
      await documents.getByRole("checkbox").nth(index).check();
    await documents
      .getByRole("button", { name: "返回更多功能", exact: true })
      .click();
    await expect(palette).toBeVisible();
    await expect(
      palette.getByRole("button", { name: "资料", exact: true }),
    ).toBeFocused();
    await palette.getByRole("button", { name: "技能", exact: true }).click();
    const skills = page.getByRole("dialog", { name: "选择技能", exact: true });
    await skills.getByRole("checkbox").first().check();
    await page.keyboard.press("Escape");
    await expect(skills).toBeHidden();
    await expect(more).toBeFocused();
    const after = (await toolbar.boundingBox())!;
    expect(after.height).toBeCloseTo(before.height, 0);
    await expect(toolbar.locator(".bot-more-trigger, .bot-submit")).toHaveCount(
      2,
    );

    const layout = await composer.evaluate((element) => {
      const tools = element.querySelector(".bot-composer-tools")!;
      const buttons = Array.from(
        tools.querySelectorAll(".bot-more-trigger, .bot-submit"),
      );
      const centers = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return rect.y + rect.height / 2;
      });
      const selection = element.querySelector(".bot-selection")!;
      const chips = Array.from(selection.children).map((chip) =>
        chip.getBoundingClientRect(),
      );
      return {
        toolbarCenterDifference: Math.max(...centers) - Math.min(...centers),
        chipRowDifference:
          Math.max(...chips.map((chip) => chip.y + chip.height / 2)) -
          Math.min(...chips.map((chip) => chip.y + chip.height / 2)),
        horizontalChipOverflow: selection.scrollWidth > selection.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        composerOverflow: element.scrollWidth > element.clientWidth,
      };
    });
    expect(layout.toolbarCenterDifference).toBeLessThanOrEqual(1);
    expect(layout.chipRowDifference).toBeLessThanOrEqual(1);
    expect(layout.pageOverflow).toBe(false);
    expect(layout.composerOverflow).toBe(false);
    if (width === 390) expect(layout.horizontalChipOverflow).toBe(true);
    await composer.screenshot({
      path: testInfo.outputPath(`composer-more-${width}.png`),
      animations: "disabled",
    });
    await openComposerMore(page);
    await palette.screenshot({
      path: testInfo.outputPath(`composer-more-options-${width}.png`),
      animations: "disabled",
    });
    await page
      .getByRole("heading", { name: "知小汇 bot", exact: true })
      .click();
    await expect(palette).toBeHidden();
    await expect(prompt).toHaveValue("核对资料与公开来源，保留这个草稿");
    await page.getByRole("button", { name: "开始任务", exact: true }).click();
    await expect
      .poll(() => f.requests[0]?.options)
      .toMatchObject({
        document_ids: ["document-0", "document-1", "document-2"],
        skill_ids: ["research"],
        memory_enabled: false,
        allow_web: true,
      });
    expect(errors).toEqual([]);
    writeFileSync(
      testInfo.outputPath(`composer-more-${width}.json`),
      JSON.stringify(
        {
          width,
          before,
          after,
          composerBefore,
          composerAfterWeb,
          layout,
          errors,
        },
        null,
        2,
      ),
    );
  });
}

test("composer panels stay usable on narrow screens with a minimal execution selector", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await fixture(page);
  await page.route("**/api/bot/capabilities", (route) =>
    route.fulfill({
      json: {
        agent: true,
        model: "fixture-agent",
        worker: false,
        web: false,
        code: false,
        connector_hosts: [],
      },
    }),
  );
  await page.reload();
  await openComposerMore(page);
  await expect(
    page.getByRole("switch", { name: "联网搜索", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("代码执行", { exact: true })).toHaveCount(0);
  await openComposerResource(page, "云端");
  const cloudPanel = await page
    .getByRole("dialog", { name: "选择云端" })
    .boundingBox();
  expect(cloudPanel!.x).toBeGreaterThanOrEqual(0);
  expect(cloudPanel!.y).toBeGreaterThanOrEqual(0);
  expect(cloudPanel!.x + cloudPanel!.width).toBeLessThanOrEqual(320);
  await page.getByRole("button", { name: "关闭选择面板" }).click();
  await openComposerResource(page, "技能");
  const skillsPanel = await page
    .getByRole("dialog", { name: "选择技能", exact: true })
    .boundingBox();
  expect(skillsPanel!.y).toBeGreaterThanOrEqual(0);
  await page.getByRole("heading", { name: "知小汇 bot", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "选择技能", exact: true }),
  ).toBeHidden();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: "test-results/bot-cloud-shell-320.png",
    animations: "disabled",
  });
});

test("capture the redesigned composer and picker at desktop and mobile sizes", async ({
  page,
}) => {
  await fixture(page, true);
  await settleEntrance(page);
  await page
    .locator(".bot-page")
    .screenshot({ path: "../docs/screenshots/bot-redesign-desktop.png" });
  await openComposerResource(page, "技能");
  await settleEntrance(page);
  expect(
    await page
      .getByRole("searchbox", { name: "搜索技能" })
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe("none");
  await page
    .locator(".bot-page")
    .screenshot({ path: "../docs/screenshots/bot-redesign-picker.png" });
  await page.getByRole("button", { name: "关闭选择面板" }).click();
  await page.getByRole("button", { name: "收起工作区" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await settleEntrance(page);
  await page.screenshot({
    path: "../docs/screenshots/bot-redesign-mobile.png",
    fullPage: true,
  });
});

test("real SSE streams text before completion, restores output and survives closing the workspace", async ({
  page,
}) => {
  const f = await fixture(page);
  let client: ServerResponse | undefined;
  let detail: any;
  const send = (event: string, payload: unknown) =>
    client!.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const server = createServer((_request, response) => {
    client = response;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "access-control-allow-origin": "*",
      "cache-control": "no-cache",
    });
    response.flushHeaders();
    send("snapshot", detail);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  await page.route("**/api/bot/tasks/*/stream", (route) =>
    route.continue({ url: `http://127.0.0.1:${address.port}/stream` }),
  );
  try {
    await page.getByLabel("任务描述").fill("流式整理研究报告");
    // Start the stream with its snapshot, then write increments only after UI assertions.
    detail = {
      task: {
        id: "task-1",
        title: "流式整理研究报告",
        prompt: "流式整理研究报告",
        status: "running",
        created_at: Date.now(),
        updated_at: Date.now(),
        plan: [{ title: "读取资料", status: "running" }],
        options: {},
        result: "",
        citations: [],
        web_sources: [],
      },
      messages: [],
      evidence_available: true,
      artifacts: [],
      actions: [],
      events: Array.from({ length: 300 }, (_, i) => ({
        id: `long-${i}`,
        kind: "tool",
        content: { name: "knowledge_read", success: true },
        created_at: Date.now(),
      })),
    };
    await page.getByRole("button", { name: "开始任务" }).click();
    await expect(page.locator(".bot-process > summary > small")).toContainText(
      "300 条记录",
    );
    expect(await page.locator(".bot-process").getAttribute("open")).toBeNull();
    await expect(page.getByRole("heading", { name: "执行记录" })).toBeHidden();
    send("output", {
      id: "message-1",
      text: "第一段已经生成",
      replace: true,
      status: "streaming",
      created_at: Date.now(),
    });
    await expect(page.locator(".bot-chat-reply")).toContainText(
      "第一段已经生成",
    );
    await expect(page.locator(".bot-chat-reply")).toContainText("正在输出");
    await expect(
      page.getByRole("button", { name: "任务执行中" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "收起工作区" }).click();
    await expect(
      page.getByRole("complementary", { name: "bot 工作区" }),
    ).toHaveCount(0);
    send("output", {
      id: "message-1",
      text: "，第二段继续到达。",
      replace: false,
      status: "streaming",
      created_at: Date.now(),
    });
    await expect(page.locator(".bot-chat-reply")).toContainText(
      "第一段已经生成，第二段继续到达。",
    );
    await page.getByRole("button", { name: "展开工作区" }).click();
    await expect(page.locator(".bot-workspace-pane .markdown")).toContainText(
      "第一段已经生成，第二段继续到达。",
    );
    const liveClient = client;
    await page
      .getByRole("button", { name: "收起系统侧边栏", exact: true })
      .click();
    await expect(page.locator(".bot-chat-reply")).toContainText(
      "第一段已经生成，第二段继续到达。",
    );
    expect(client).toBe(liveClient);
    await page
      .getByRole("button", { name: "展开系统侧边栏", exact: true })
      .click();
    detail.messages = [
      {
        id: "message-1",
        content: "第一段已经生成，第二段继续到达。",
        status: "streaming",
        created_at: Date.now(),
      },
    ];
    f.tasks[0].messages = detail.messages;
    f.setPhase("running");
    const previous = client;
    await page.reload();
    await expect.poll(() => client !== previous).toBe(true);
    await expect(page.locator(".bot-chat-reply")).toContainText(
      "第一段已经生成，第二段继续到达。",
    );
    await expect(page.getByRole("heading", { name: "任务步骤" })).toBeHidden();
    await page.locator(".bot-process summary").click();
    await expect(page.getByRole("heading", { name: "执行记录" })).toBeVisible();
    const height = await page
      .locator(".bot-process-body")
      .evaluate((e) => e.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(320.5);
    await page.locator(".bot-process summary").click();
    detail.task.status = "completed";
    detail.task.result =
      "## 让团队知识更容易被使用\n\n已整理出三个实施重点，可以从小范围试点开始。\n\n### 01 · 统一资料入口\n把常用制度、项目文档和会议记录整理到同一空间，保留原始来源与更新日期。\n\n### 02 · 建立可追溯的回答\n每个关键结论附上资料引用。信息缺失时标明待确认，方便团队继续补充。\n\n### 03 · 把结论变成行动\n从一份会议纪要或研究报告开始，明确负责人、下一步和交付时间。\n\n> 下一步建议：选择一个团队，用两周验证检索效率和资料复用情况。";
    f.tasks[0].result = detail.task.result;
    detail.messages[0].status = "completed";
    f.setPhase("completed");
    send("snapshot", detail);
    send("end", {});
    await expect(
      page.locator(".bot-chat-reply .bot-stream-cursor"),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "任务成果" })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settleEntrance(page);
    await page
      .locator(".bot-page")
      .screenshot({ path: "../docs/screenshots/bot-conversation-desktop.png" });
    await page.getByRole("button", { name: "收起工作区" }).click();
    await settleEntrance(page);
    await page.locator(".bot-page").screenshot({
      path: "../docs/screenshots/bot-conversation-collapsed.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await settleEntrance(page);
    await page.screenshot({
      path: "../docs/screenshots/bot-conversation-mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "展开工作区" }).click();
    await expect(page.getByRole("heading", { name: "任务成果" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "收起工作区" }).click();
    await expect(page.getByLabel("继续对话", { exact: true })).toBeVisible();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("system sidebar follows the handle, snaps once, remembers its state and supports keyboard cancellation", async ({
  page,
}) => {
  await fixture(page);
  const panel = page.getByRole("complementary", {
    name: "系统导航",
    includeHidden: true,
  });
  const handle = page.locator(".sidebar-handle");
  const mainLeft = () =>
    page
      .locator(".main-column")
      .evaluate((e) => e.getBoundingClientRect().left);
  const fullWidth = await panel.evaluate(
    (e) => e.getBoundingClientRect().width,
  );
  const center = async () => {
    const box = (await handle.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  let point = await center();
  await page.mouse.move(point.x, point.y);
  await expect(handle.locator(".sidebar-handle-hint")).toContainText(
    "向左拖动收起",
  );
  await page.mouse.down();
  await page.mouse.move(point.x - 70, point.y, { steps: 8 });
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-dragging/);
  await expect.poll(mainLeft).toBeCloseTo(fullWidth - 70, 0);
  await expect(handle.locator(".sidebar-handle-hint")).toContainText(
    "松开收起",
  );
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(mainLeft).toBeCloseTo(0, 0);
  await expect(panel).toHaveAttribute("inert", "");
  await expect(page.getByLabel("任务描述")).toBeVisible();
  await page.reload();
  await expect(handle).toHaveAttribute("aria-label", "展开系统侧边栏");
  expect(await mainLeft()).toBe(0);
  point = await center();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 90, point.y, { steps: 8 });
  await expect.poll(mainLeft).toBeCloseTo(90, 0);
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(mainLeft).toBeCloseTo(fullWidth, 0);
  point = await center();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x - 80, point.y, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(mainLeft).toBeCloseTo(fullWidth, 0);
  await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-dragging/);
  await handle.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(mainLeft).toBeCloseTo(0, 0);
  await handle.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(mainLeft).toBeCloseTo(fullWidth, 0);
  await handle.press("Space");
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(mainLeft).toBeCloseTo(0, 0);
  await handle.click();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(mainLeft).toBeCloseTo(fullWidth, 0);
  await page.screenshot({ path: "../docs/screenshots/sidebar-expanded.png" });
  await handle.click();
  await expect.poll(mainLeft).toBeCloseTo(0, 0);
  await page.screenshot({ path: "../docs/screenshots/sidebar-collapsed.png" });
});

test("sidebar touch gestures work on mobile, keep content in place and honor reduced motion", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  const handle = page.locator(".sidebar-handle");
  const panel = page.locator(".sidebar");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  const touch = (type: string, x = 0) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y: 422 }],
    });
  await touch("touchStart", 12);
  for (let x = 32; x <= 112; x += 20) await touch("touchMove", x);
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-dragging/);
  await expect
    .poll(() => panel.evaluate((e) => e.getBoundingClientRect().right))
    .toBeCloseTo(100, 0);
  expect(
    await page
      .locator(".main-column")
      .evaluate((e) => e.getBoundingClientRect().left),
  ).toBe(0);
  await touch("touchEnd");
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "关闭导航", exact: true }),
  ).toBeVisible();
  expect(
    await panel.evaluate((e) => getComputedStyle(e).transitionDuration),
  ).toBe("0s");
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  await touch("touchStart", x);
  for (let delta = 20; delta <= 100; delta += 20)
    await touch("touchMove", x - delta);
  await touch("touchCancel");
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await touch("touchStart", x);
  for (let delta = 20; delta <= 100; delta += 20)
    await touch("touchMove", x - delta);
  await touch("touchEnd");
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "关闭导航", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "知小汇 bot", exact: true }).click();
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await handle.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  expect(
    await page.evaluate(() => localStorage.getItem("zhihui.sidebar.collapsed")),
  ).toBe("1");
});

test("welcome companion follows pointer and transitions to an inline game while preserving drafts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture(page);
  await settleEntrance(page);
  const companion = page.getByRole("button", {
    name: "和知小汇玩接住灵感小游戏",
  });
  const eye = companion.locator("mask path").nth(1);
  const centerX = async () =>
    eye.evaluate((element) => {
      const paths = Array.from(element.parentElement!.querySelectorAll("path"))
        .slice(1)
        .filter((path) => path.getAttribute("display") !== "none");
      return (
        paths.reduce(
          (sum, path) =>
            sum +
            (path as SVGGraphicsElement).transform.baseVal.consolidate()!.matrix
              .e,
          0,
        ) / paths.length
      );
    });
  const box = (await companion.boundingBox())!;
  await page.mouse.move(box.x - 220, box.y + box.height / 2);
  await expect.poll(centerX).toBeLessThan(-15);
  await page.mouse.move(box.x + box.width + 220, box.y + box.height / 2);
  await expect.poll(centerX).toBeGreaterThan(15);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(centerX).toBeGreaterThan(-15);
  await expect.poll(centerX).toBeLessThan(15);
  await page
    .getByRole("button", { name: "收起系统侧边栏", exact: true })
    .click();
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const movedBox = (await companion.boundingBox())!;
  await page.mouse.move(
    movedBox.x + movedBox.width / 2,
    movedBox.y + movedBox.height / 2,
  );
  await expect.poll(centerX).toBeGreaterThan(-15);
  await expect.poll(centerX).toBeLessThan(15);
  await page.getByLabel("任务描述").fill("先保留我的草稿");
  await companion.focus();
  await companion.press("Enter");
  await expect(
    page.getByRole("region", { name: "接住灵感", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "接住灵感", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".bot-chat-main")).toHaveClass(/is-gaming/);
  await expect(page.locator(".bot-chat-composer")).toHaveAttribute("inert", "");
  const coverage = await page
    .locator(".inspiration-stage")
    .evaluate((element) => {
      const stage = element.getBoundingClientRect();
      const main = element.closest(".bot-chat-main")!.getBoundingClientRect();
      return {
        width: stage.width / main.width,
        height: stage.height / main.height,
      };
    });
  expect(coverage.width).toBeGreaterThan(0.98);
  expect(coverage.height).toBeGreaterThan(0.98);
  await page.getByRole("button", { name: "开始小游戏", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "灵感星光游戏区域" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "暂停小游戏" }).click();
  await expect(
    page.getByRole("button", { name: "继续小游戏", exact: true }),
  ).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "接住灵感", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "接住灵感", exact: true }),
  ).toHaveCount(0);
  await expect(companion).toBeFocused();
  await expect(page.getByLabel("任务描述")).toHaveValue("先保留我的草稿");
  await page.getByLabel("任务描述").fill("小游戏退出后继续工作");
  await expect(
    page.getByRole("button", { name: "开始任务", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});

test("inspiration game catches stars, pauses, supports touch and opens enterprise standings", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const f = await fixture(page);
  const companion = page.getByRole("button", {
    name: "和知小汇玩接住灵感小游戏",
  });
  await page.mouse.move(350, 250);
  await expect
    .poll(() => companion.locator("mask path").nth(1).getAttribute("transform"))
    .not.toContain("NaN");
  await companion.click();
  await page.screenshot({
    path: "../docs/screenshots/bot-inspiration-inline-mobile.png",
  });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.getByRole("button", { name: "开始小游戏", exact: true }).click();
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "playing",
  );
  await page.clock.runFor(2600);
  const score = page.getByLabel("已接住的星光");
  await expect
    .poll(async () => Number(await score.textContent()))
    .toBeGreaterThan(0);
  const stage = page.getByRole("group", { name: "灵感星光游戏区域" });
  const position = () =>
    page
      .locator(".inspiration-catcher")
      .evaluate((element) => element.getBoundingClientRect().x);
  const initial = await position();
  await page.keyboard.down("ArrowRight");
  await page.clock.runFor(200);
  await page.keyboard.up("ArrowRight");
  expect(await position()).toBeGreaterThan(initial + 20);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  const box = (await stage.boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + 30, y: box.y + box.height / 2 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.clock.runFor(50);
  expect(await position()).toBeLessThan(initial);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "paused",
  );
  const pausedTime = await page.getByLabel("剩余时间").textContent();
  await page.clock.runFor(4000);
  await expect(page.getByLabel("剩余时间")).toHaveText(pausedTime!);
  await page.getByRole("button", { name: "继续小游戏", exact: true }).click();
  await page.clock.runFor(16000);
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "finished",
  );
  const finalScore = Number(await score.textContent());
  expect(finalScore).toBeGreaterThan(0);
  const ranking = page.getByRole("dialog", { name: "企业灵感榜" });
  await expect(ranking).toBeVisible();
  await expect(
    ranking.getByRole("list", { name: "企业成员排行榜" }),
  ).toBeVisible();
  await expect(ranking.locator("li.is-me")).toContainText("测试成员");
  await expect(ranking.locator("li.is-me strong")).toHaveText(
    String(finalScore),
  );
  await expect(ranking.locator(".inspiration-ranking-result")).toContainText(
    `第 ${1 + Number(12 > finalScore) + Number(8 > finalScore)} 名`,
  );
  await expect(
    ranking.getByRole("button", { name: "收起排行榜" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ranking).toHaveCount(0);
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "finished",
  );
  await expect(
    page.getByRole("button", { name: "再玩一次", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "查看企业排行榜" }).click();
  await expect(ranking).toBeVisible();
  await ranking.getByRole("button", { name: "再玩一次", exact: true }).click();
  await expect(ranking).toHaveCount(0);
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "playing",
  );
  await expect(score).toHaveText("0");
  await page.getByRole("button", { name: /回到对话/ }).click();
  await companion.click();
  await expect(page.locator(".inspiration-best")).toHaveText(
    `最佳 ${finalScore}`,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(f.requests).toHaveLength(0);
  expect(f.gameRequests.filter((r) => r.path.endsWith("/finish"))).toEqual([
    {
      path: "/api/bot/game/inspiration/runs/run-1/finish",
      method: "POST",
      score: finalScore,
    },
  ]);
});

test("enterprise standings retain the score for retry and return to the preserved draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const f = await fixture(page);
  await page.getByLabel("任务描述").fill("排行榜之后继续这份草稿");
  let attempts = 0;
  await page.route(
    "**/api/bot/game/inspiration/runs/*/finish",
    async (route) => {
      attempts++;
      if (attempts === 1)
        return route.fulfill({
          status: 503,
          json: { error: "成绩服务暂时不可用" },
        });
      return route.fallback();
    },
  );
  await page.getByRole("button", { name: "和知小汇玩接住灵感小游戏" }).click();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.getByRole("button", { name: "开始小游戏", exact: true }).click();
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "playing",
  );
  await page.clock.runFor(16000);
  const ranking = page.getByRole("dialog", { name: "企业灵感榜" });
  await expect(ranking.getByRole("alert")).toContainText("成绩尚未确认保存");
  await expect(
    ranking.getByRole("button", { name: "再玩一次", exact: true }),
  ).toBeDisabled();
  await ranking.getByRole("button", { name: "重试保存成绩" }).click();
  await expect(ranking.locator("li.is-me")).toBeVisible();
  expect(attempts).toBe(2);
  expect(f.gameRequests.filter((r) => r.path.endsWith("/finish"))).toHaveLength(
    1,
  );
  const overflow = await ranking.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: "../docs/screenshots/bot-leaderboard-mobile.png",
  });
  await ranking.getByRole("button", { name: "回到对话", exact: true }).click();
  await expect(ranking).toHaveCount(0);
  await expect(page.getByLabel("任务描述")).toHaveValue(
    "排行榜之后继续这份草稿",
  );
  expect(f.requests).toHaveLength(0);
});

test("game start failure can be retried without advancing the timer", async ({
  page,
}) => {
  await fixture(page);
  let attempts = 0;
  await page.route("**/api/bot/game/inspiration/runs", async (route) => {
    attempts++;
    if (attempts === 1)
      return route.fulfill({ status: 503, json: { error: "网络暂时不可用" } });
    return route.fallback();
  });
  await page.getByRole("button", { name: "和知小汇玩接住灵感小游戏" }).click();
  await page.getByRole("button", { name: "开始小游戏", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法开始");
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "ready",
  );
  await expect(page.getByLabel("剩余时间")).toContainText("15");
  await page.getByRole("button", { name: "开始小游戏", exact: true }).click();
  await expect(page.locator(".inspiration-game")).toHaveAttribute(
    "data-phase",
    "playing",
  );
});

// Observe both browser actions without invoking the installed desktop app.
async function captureDesktopLaunch(page: Page, popupBlocked = false) {
  await page.evaluate((blocked) => {
    const observed = window as any;
    window.open = ((url: string) => {
      observed.__connectionUrl = url;
      return blocked ? null : {};
    }) as any;
    document.addEventListener(
      "click",
      (event) => {
        const link = (event.target as Element).closest<HTMLAnchorElement>(
          'a[href="dsh://open"]',
        );
        if (link) {
          observed.__desktopUrl = link.href;
          event.preventDefault();
        }
      },
      { capture: true },
    );
  }, popupBlocked);
}

test("local execution opens code-free connection and queues offline tasks without cloud fallback", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.route("**/api/bot/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "local-device",
          name: "我的 Mac",
          workspace_id: "work",
          workspace_title: "研究工作区",
          online: false,
          last_seen: 0,
        },
      ],
    }),
  );
  await captureDesktopLaunch(page);
  await openComposerResource(page, "云端");
  const panel = page.locator(".bot-execution-panel");
  await expect(panel.getByRole("button")).toHaveCount(5);
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel).not.toContainText(/配对码|服务器地址|复制|下载|随时可用/);
  await page.getByRole("button", { name: "连接本地", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__connectionUrl)).toBe(
    "/app?view=bot&connect=local",
  );
  expect(await page.evaluate(() => (window as any).__desktopUrl)).toBe(
    "dsh://open",
  );
  await page.getByRole("button", { name: "本地电脑", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "我的 Mac · 研究工作区", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "本地电脑：我的 Mac · 研究工作区" }),
  ).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page
    .locator(".bot-execution-panel")
    .screenshot({ path: "../docs/screenshots/bot-execution-redesign.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: /任务/ }).fill("在本地研究 Harness");
  await page.getByRole("button", { name: "开始任务", exact: true }).click();
  expect(f.requests.at(-1).options.local_device_id).toBe("local-device");
  expect(f.requests.at(-1).options.allow_web).toBe(false);
  expect(f.requests.at(-1).options.connector_ids).toEqual([]);
});

test("Desktop approval binds the displayed workspace without showing a pairing code", async ({
  page,
}) => {
  await fixture(page);
  let approvals = 0;
  await page.route("**/api/bot/connections/browser-request", (route) =>
    route.fulfill({
      json: {
        name: "Windows 工作电脑",
        workspace_title: "产品研究",
        expires_at: Date.now() + 600000,
        connected: false,
      },
    }),
  );
  await page.route(
    "**/api/bot/connections/browser-request/approve",
    (route) => {
      approvals++;
      return route.fulfill({ json: { id: "new-device" } });
    },
  );
  await page.goto("/app?view=bot&connect=browser-request");
  await expect(
    page.getByRole("heading", { name: "让工作区与网页相连" }),
  ).toBeVisible();
  await expect(page.getByText("Windows 工作电脑")).toBeVisible();
  await expect(page.getByText("产品研究", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({
    path: "../docs/screenshots/desktop-connection-approval.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../docs/screenshots/desktop-connection-mobile.png",
  });
  await page.getByRole("button", { name: "确认连接", exact: true }).click();
  await expect(page.getByRole("heading", { name: "连接已确认" })).toBeVisible();
  expect(approvals).toBe(1);
});

test("web connection discovers the local client and carries the server address automatically", async ({
  page,
}) => {
  await fixture(page);
  const platformOrigin = new URL(page.url()).origin;
  await page.route(/^http:\/\/127\.0\.0\.1:1876[5-9]\/health$/, (route) =>
    route.fulfill({
      json: {
        service: route.request().url().includes(":18765")
          ? "zhixiaohui-desktop"
          : "unrelated",
      },
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.route("http://127.0.0.1:18765/connect?**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<html><h1>选择连接的工作区</h1><p>产品研究</p></html>",
    }),
  );
  await page.goto("/app?view=bot&connect=local");
  await expect(
    page.getByRole("heading", { name: "选择连接的工作区" }),
  ).toBeVisible();
  const url = new URL(page.url());
  expect(url.port).toBe("18765");
  expect(url.searchParams.get("server")).toBe(platformOrigin);
});

test("an expired Desktop connection cannot present an approval button", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/bot/connections/expired", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "连接请求已过期，请从客户端重新连接" },
    }),
  );
  await page.goto("/app?view=bot&connect=expired");
  await expect(page.getByRole("alert")).toContainText("连接请求已过期");
  await expect(
    page.getByRole("button", { name: "确认连接", exact: true }),
  ).toHaveCount(0);
});

test("execution locations use one aligned dropdown and reveal delete on hover or focus", async ({
  page,
}) => {
  await fixture(page);
  let devices = [
    {
      id: "knowledge",
      name: "我的电脑",
      workspace_title: "knowledge-base",
      online: true,
    },
    { id: "dsh", name: "我的电脑", workspace_title: "dsh", online: false },
  ];
  const deleted: string[] = [];
  await page.route("**/api/bot/devices", (route) =>
    route.fulfill({ json: devices }),
  );
  await page.route("**/api/bot/devices/*", (route) => {
    const id = route.request().url().split("/").at(-1)!;
    deleted.push(id);
    devices = devices.filter((device) => device.id !== id);
    return route.fulfill({ json: { ok: true } });
  });
  await openComposerResource(page, "云端");
  const panel = page.locator(".bot-execution-panel");
  const dropdown = page.getByRole("button", { name: /^本地电脑/ });
  const cloud = page.getByRole("button", { name: "云端执行", exact: true });
  const cloudBox = (await cloud.boundingBox())!;
  const localBox = (await dropdown.boundingBox())!;
  expect(localBox.x).toBeCloseTo(cloudBox.x, 0);
  expect(localBox.width).toBeCloseTo(cloudBox.width, 0);
  expect(localBox.height).toBeCloseTo(cloudBox.height, 0);
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await panel.screenshot({
    path: "../docs/screenshots/bot-execution-compact.png",
  });
  await dropdown.click();
  const knowledge = page.getByRole("menuitemradio", {
    name: "我的电脑 · knowledge-base",
    exact: true,
  });
  const dsh = page.getByRole("menuitemradio", {
    name: "我的电脑 · dsh",
    exact: true,
  });
  const trash = page.getByRole("menuitem", {
    name: "删除连接 我的电脑 · dsh",
    exact: true,
  });
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await page.mouse.move(1, 1);
  await knowledge.focus();
  await expect(trash).toHaveCSS("opacity", "0");
  await dsh.hover();
  await expect(trash).toHaveCSS("opacity", "1");
  await page.mouse.move(1, 1);
  await expect(trash).toHaveCSS("opacity", "0");
  await dsh.focus();
  await expect(trash).toHaveCSS("opacity", "1");
  await dsh.press("Enter");
  await expect(dropdown).toHaveAttribute("aria-expanded", "false");
  await dropdown.click();
  await expect(dsh).toHaveAttribute("aria-checked", "true");
  await expect(knowledge).toHaveAttribute("aria-checked", "false");
  await dsh.focus();
  await dsh.hover();
  await panel.screenshot({
    path: "../docs/screenshots/bot-execution-workspaces.png",
  });
  await trash.click();
  expect(deleted).toEqual(["dsh"]);
  await expect(cloud).toHaveAttribute("aria-pressed", "true");
  await dropdown.click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(1);
  await expect(knowledge).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dropdown).toBeFocused();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("local dropdown supports keyboard selection, long lists and narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await fixture(page);
  await page.route("**/api/bot/devices", (route) =>
    route.fulfill({
      json: Array.from({ length: 12 }, (_, i) => ({
        id: `device-${i}`,
        name: `Windows电脑${i}`,
        workspace_title: "很长的工作区名称用于研究和整理项目资料".repeat(3),
        online: true,
      })),
    }),
  );
  await openComposerResource(page, "云端");
  const dropdown = page.getByRole("button", { name: /^本地电脑/ });
  await dropdown.press("ArrowDown");
  const options = page.getByRole("menuitemradio");
  await expect(options).toHaveCount(12);
  await expect(options.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(options.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(options.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await page.keyboard.press("Tab");
  const deleteButton = page.getByRole("menuitem", {
    name: /^删除连接 Windows电脑1 ·/,
  });
  await expect(deleteButton).toBeFocused();
  await expect(deleteButton).toHaveCSS("opacity", "1");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(dropdown).toHaveAttribute("aria-expanded", "false");
  await dropdown.click();
  const box = (await page.locator(".bot-execution-panel").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y + box.height).toBeLessThanOrEqual(740);
  await expect(
    page.getByRole("button", { name: "连接本地", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".bot-execution-panel")
    .screenshot({ path: "../docs/screenshots/bot-execution-mobile.png" });
  await page.getByRole("button", { name: "云端执行", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("empty local dropdown remains usable and a blocked popup preserves desktop launch", async ({
  page,
}) => {
  await fixture(page);
  await captureDesktopLaunch(page, true);
  await openComposerResource(page, "云端");
  await page.getByRole("button", { name: "本地电脑", exact: true }).click();
  await expect(page.getByRole("menu")).toContainText("暂无已连接电脑");
  await page.getByRole("button", { name: "连接本地", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__desktopUrl)).toBe(
    "dsh://open",
  );
  await expect(page.getByRole("alert")).toContainText("浏览器拦截了连接窗口");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("a newly connected online workspace is selected automatically after browser approval", async ({
  page,
}) => {
  await fixture(page);
  let bound = false;
  await page.route("**/api/bot/devices", (route) =>
    route.fulfill({
      json: bound
        ? [
            {
              id: "new-workspace",
              name: "我的电脑",
              workspace_title: "自动连接的工作区",
              online: true,
            },
          ]
        : [],
    }),
  );
  await captureDesktopLaunch(page);
  await openComposerResource(page, "云端");
  await page.getByRole("button", { name: "连接本地", exact: true }).click();
  bound = true;
  const dropdown = page.getByRole("button", {
    name: "本地电脑：我的电脑 · 自动连接的工作区",
    exact: true,
  });
  await expect(dropdown).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByRole("button", { name: "云端执行", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await dropdown.click();
  await expect(
    page.getByRole("menuitemradio", {
      name: "我的电脑 · 自动连接的工作区",
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("button", { name: "连接本地", exact: true }),
  ).toHaveText("连接本地");
});
