import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const png = readFileSync(
  new URL("../../tests/fixtures/diagram.png", import.meta.url),
);

/** 隔离真实账号和付费模型，分别控制会话创建、对话回复与图片生成的完成时机。 */
async function conversationFixture(page: Page) {
  const requests: any[] = [];
  const messages: any[] = [];
  let jobs: any[] = [];
  let assets: any[] = [];
  let created = false;
  let releaseProject!: () => void;
  const projectGate = new Promise<void>((resolve) => {
    releaseProject = resolve;
  });
  let releaseReply!: (fail: boolean) => void;
  let replyGate = new Promise<boolean>((resolve) => {
    releaseReply = resolve;
  });
  /** 按独立时机返回会话、消息与作品，验证慢请求期间的界面反馈。 */
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: "conversation-user",
            tenant_id: "fixture",
            name: "测试用户",
            role: "member",
            active: true,
          },
          tenant: { id: "fixture", name: "测试企业", slug: "fixture" },
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
    if (path === "/api/studio/capabilities")
      return route.fulfill({
        json: {
          agent: true,
          web: false,
          image: { enabled: true, model: "image-test" },
          video: { enabled: false },
          models: [
            {
              id: "image-test",
              name: "测试生图",
              kind: "image",
              model: "image-test",
            },
          ],
          default_image_id: "image-test",
        },
      });
    if (path === "/api/studio/projects") {
      if (route.request().method() === "POST") {
        await projectGate;
        created = true;
        return route.fulfill({ json: { id: "conversation", title: "猫咪" } });
      }
      return route.fulfill({
        json: created ? [{ id: "conversation", title: "猫咪" }] : [],
      });
    }
    if (path === "/api/studio/projects/conversation")
      return route.fulfill({
        json: {
          project: { id: "conversation", title: "猫咪" },
          messages,
          jobs,
          assets,
        },
      });
    if (path === "/api/studio/chat") {
      const input = route.request().postDataJSON();
      requests.push(input);
      if (!messages.some((message) => message.request_id === input.request_id))
        messages.push({
          id: `user-${requests.length}`,
          request_id: input.request_id,
          role: "user",
          content: input.prompt,
          citations: [],
        });
      const fail = await replyGate;
      if (fail)
        return route.fulfill({ status: 502, json: { error: "回复暂时中断" } });
      messages.push({
        id: `assistant-${requests.length}`,
        request_id: input.request_id,
        role: "assistant",
        content: jobs.some((job) => job.request_id === input.request_id)
          ? ""
          : "当然可以，我们可以先聊聊你的想法。",
        citations: [],
        tool_calls: [{ name: "generate_image", success: true }],
      });
      return route.fulfill({ json: { answer: messages.at(-1).content } });
    }
    if (path === "/api/studio/assets/cat")
      return route.fulfill({ contentType: "image/png", body: png });
    return route.fulfill({ json: [] });
  });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "打开导航", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  await expect(page.getByLabel("创作要求")).toBeVisible();
  return {
    requests,
    releaseProject,
    /** 让图片进入生成阶段，独立于尚未完成的对话请求。 */
    queueImage() {
      jobs = [
        {
          id: "cat-job",
          request_id: requests[0].request_id,
          kind: "image",
          prompt: requests[0].prompt,
          model: "image-test",
          size: "1024x1024",
          seconds: 0,
          status: "running",
          progress: 0,
        },
      ];
    },
    /** 完成图片任务，以验证圆点占位被真实图片替换。 */
    completeImage() {
      jobs[0].status = "completed";
      assets = [
        {
          id: "cat",
          job_id: "cat-job",
          kind: "image",
          mime_type: "image/png",
          size: png.length,
        },
      ];
    },
    /** 释放当前回复，并为下一次发送创建新的可控等待。 */
    reply(fail = false) {
      releaseReply(fail);
      replyGate = new Promise<boolean>((resolve) => {
        releaseReply = resolve;
      });
    },
  };
}

for (const width of [1440, 390]) {
  /** 验证立即上屏、布局对齐、动效替换与多轮普通对话。 */
  test(`studio immediately opens an aligned conversation and replaces floating dots with images at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const fixture = await conversationFixture(page);
    await page.getByLabel("创作要求").fill("画一只猫，保留我的原话");
    await page.getByRole("button", { name: "开始创作" }).click();
    // 项目创建和回复都未完成时，用户消息也应立即出现。
    await expect(page.locator(".studio-message.user")).toHaveText(
      "画一只猫，保留我的原话",
    );
    await expect(page.getByRole("status")).toContainText("正在回复");
    await expect(page.locator(".send-button .spin")).toHaveCount(0);
    await expect(page.getByLabel("创作要求")).toHaveValue("");
    await expect(page.getByLabel("创作要求")).toBeEditable();
    await page.getByLabel("创作要求").fill("下一条草稿");
    fixture.releaseProject();
    await expect.poll(() => fixture.requests.length).toBe(1);
    expect(fixture.requests[0].prompt).toBe("画一只猫，保留我的原话");
    fixture.queueImage();
    await expect(page.getByRole("status")).toContainText("正在生成图片", {
      timeout: 10000,
    });
    await expect(page.locator(".studio-particle-field i")).toHaveCount(80);
    await expect(page.locator(".studio-message.user")).toHaveCount(1);
    await expect(page.locator(".studio-tools")).toHaveCount(0);
    await expect(page.locator(".studio-content")).not.toContainText(
      /Pi Agent|工具调用|正在整理|提交任务/,
    );
    const dialogue = (await page.locator(".studio-dialogue").boundingBox())!;
    const composer = (await page
      .locator(".studio-compose-wrap")
      .boundingBox())!;
    expect(Math.abs(dialogue.x - composer.x)).toBeLessThan(1);
    expect(Math.abs(dialogue.width - composer.width)).toBeLessThan(1);
    expect(composer.y + composer.height).toBeLessThanOrEqual(
      page.viewportSize()!.height,
    );
    await page.screenshot({
      path: `test-results/studio-generating-${width}.png`,
    });
    fixture.reply();
    await expect(page.getByRole("button", { name: "开始创作" })).toBeEnabled();
    await expect(page.getByLabel("创作要求")).toHaveValue("下一条草稿");
    fixture.completeImage();
    await expect(page.locator(".studio-image-placeholder")).toHaveCount(0, {
      timeout: 10000,
    });
    await expect(
      page.locator(".studio-dialogue .studio-asset img"),
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.screenshot({ path: `test-results/studio-result-${width}.png` });
    // 多轮普通对话不会把上一轮作品挪到最新回复，也不会创建图片占位。
    await page.getByLabel("创作要求").fill("先聊聊，不要生成图片");
    await page.getByRole("button", { name: "开始创作" }).click();
    await expect.poll(() => fixture.requests.length).toBe(2);
    fixture.reply();
    await expect(page.locator(".studio-message.assistant").last()).toHaveText(
      "当然可以，我们可以先聊聊你的想法。",
    );
    await expect(page.locator(".studio-turn")).toHaveCount(2);
    await expect(
      page.locator(".studio-turn").first().locator(".studio-asset img"),
    ).toHaveCount(1);
    await expect(
      page.locator(".studio-turn").last().locator(".studio-turn-result"),
    ).toHaveCount(0);
    await expect(page.locator(".studio-image-placeholder")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

/** 验证回复失败保留新草稿，原请求重试保持幂等。 */
test("studio preserves a new draft on reply failure and retries the original request without duplicate messages", async ({
  page,
}) => {
  const fixture = await conversationFixture(page);
  fixture.releaseProject();
  await page.getByLabel("创作要求").fill("画一只猫");
  await page.getByRole("button", { name: "开始创作" }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  await page.getByLabel("创作要求").fill("不要覆盖这条新草稿");
  fixture.reply(true);
  await expect(page.getByRole("alert")).toContainText("回复暂时中断");
  await expect(page.getByLabel("创作要求")).toHaveValue("不要覆盖这条新草稿");
  await page.getByLabel("创作要求").fill("画一只猫");
  await page.getByRole("button", { name: "开始创作" }).click();
  await expect.poll(() => fixture.requests.length).toBe(2);
  expect(fixture.requests[0].request_id).toBe(fixture.requests[1].request_id);
  await expect(page.getByRole("status")).toContainText("正在回复");
  await expect(page.locator(".studio-message.user")).toHaveCount(1);
  fixture.reply();
  await expect(page.locator(".studio-message.assistant")).toHaveText(
    "当然可以，我们可以先聊聊你的想法。",
  );
  await expect(page.locator(".studio-image-placeholder")).toHaveCount(0);
});
