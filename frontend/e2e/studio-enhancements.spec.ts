import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const png = readFileSync(
  fileURLToPath(new URL("../../tests/fixtures/diagram.png", import.meta.url)),
);
const policy = {
  enabled: true,
  max_files: 8,
  max_size_bytes: 20 * 1024 * 1024,
  accept: [
    "image/png",
    "image/jpeg",
    "image/webp",
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".pdf",
    ".docx",
    ".pptx",
    ".xlsx",
  ],
};

async function studioFixture(page: Page) {
  const uploads: {
    id: string;
    name: string;
    mime_type: string;
    size: number;
    kind: string;
  }[] = [];
  const requests: Record<string, any>[] = [];
  const deleted: string[] = [];
  let failures = 0;
  let projectCreated = false;
  const reference = {
    id: "asset-reference",
    name: "已有作品.png",
    mime_type: "image/png",
    size: png.length,
    kind: "image",
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: "studio-enhancement-fixture",
            tenant_id: "fixture",
            name: "测试成员",
            email: "studio@test.invalid",
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
          spaces: 0,
          capabilities: { models: {}, database: "fixture", storage: "fixture" },
          mcp_url: "/mcp",
        },
      });
    if (path === "/api/documents")
      return route.fulfill({ json: { items: [], total: 0 } });
    if (path === "/api/studio/capabilities")
      return route.fulfill({
        json: {
          agent: true,
          web: true,
          image_edit: true,
          attachments: policy,
          image: { enabled: true, model: "image-test" },
          video: { enabled: true, model: "video-test" },
          models: [
            {
              id: "image-test",
              name: "测试生图",
              kind: "image",
              model: "image-test",
            },
            {
              id: "video-test",
              name: "测试视频",
              kind: "video",
              model: "video-test",
            },
          ],
          default_image_id: "image-test",
          default_video_id: "video-test",
        },
      });
    if (path === "/api/studio/attachments") {
      const body = request.postDataBuffer()!;
      const filename =
        /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1] || "unknown";
      if (filename === "retry.md" && failures++ === 0)
        return route.fulfill({ status: 503, json: { error: "上传暂时中断" } });
      const image = filename.endsWith(".png");
      const attachment = {
        id: `upload-${uploads.length}`,
        name: filename,
        mime_type: image ? "image/png" : "text/markdown",
        size: image ? png.length : 20,
        kind: image ? "image" : "document",
      };
      uploads.push(attachment);
      return route.fulfill({ json: attachment });
    }
    if (path.startsWith("/api/studio/attachments/")) {
      if (request.method() === "DELETE") {
        deleted.push(path.split("/").at(-1)!);
        return route.fulfill({ json: { success: true } });
      }
      return route.fulfill({ contentType: "image/png", body: png });
    }
    if (path === "/api/studio/assets/original/reference")
      return route.fulfill({ json: reference });
    if (path === "/api/studio/assets/original")
      return route.fulfill({ contentType: "image/png", body: png });
    if (path === "/api/studio/projects") {
      if (request.method() === "POST") {
        projectCreated = true;
        return route.fulfill({
          json: { id: "new-project", title: request.postDataJSON().title },
        });
      }
      return route.fulfill({
        json: [
          { id: "old-project", title: "产品摄影" },
          ...(projectCreated ? [{ id: "new-project", title: "新作品" }] : []),
        ],
      });
    }
    if (path === "/api/studio/projects/old-project")
      return route.fulfill({
        json: {
          project: { id: "old-project", title: "产品摄影" },
          messages: [],
          jobs: [
            {
              id: "original-job",
              kind: "image",
              prompt: "蓝色耳机的产品摄影",
              model: "image-test",
              size: "1024x1024",
              seconds: 0,
              status: "completed",
              progress: 100,
            },
          ],
          assets: [
            {
              id: "original",
              job_id: "original-job",
              kind: "image",
              mime_type: "image/png",
              size: png.length,
            },
          ],
        },
      });
    if (path === "/api/studio/projects/new-project")
      return route.fulfill({
        json: {
          project: { id: "new-project", title: "新作品" },
          messages: requests.flatMap((input, index) => [
            {
              id: `user-${index}`,
              role: "user",
              content: input.prompt,
              citations: [],
              attachments: uploads.filter((row) =>
                input.attachment_ids.includes(row.id),
              ),
            },
            {
              id: `assistant-${index}`,
              role: "assistant",
              content: "已提交作品",
              citations: [],
              tool_calls: [],
            },
          ]),
          jobs: [],
          assets: [],
        },
      });
    if (path === "/api/studio/chat") {
      requests.push(request.postDataJSON());
      return route.fulfill({ json: { answer: "已提交" } });
    }
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
  await expect(page.getByRole("heading", { name: "AI 创作" })).toBeVisible();
  if (page.viewportSize()!.width < 800)
    await expect
      .poll(() =>
        page
          .locator(".sidebar")
          .evaluate((element) => element.getBoundingClientRect().right),
      )
      .toBeLessThanOrEqual(0);
  return { uploads, requests, deleted };
}

/** 验证参考资料上传、失败重试及风格质量参数。 */
test("studio accepts pasted images and dragged documents, retries failures and sends references with style/quality", async ({
  page,
}) => {
  const fixture = await studioFixture(page);
  await page.getByLabel("创作要求").fill("根据参考资料设计海报");
  await page.getByLabel("创作要求").evaluate((element, base64) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))],
        "pasted.png",
        { type: "image/png" },
      ),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, clipboardData: data }),
    );
  }, png.toString("base64"));
  await expect(
    page.getByLabel("pasted.png · 已就绪", { exact: true }),
  ).toBeVisible();
  const dragged = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File(["# 海报要求\n蓝白配色"], "brief.md", { type: "text/markdown" }),
    );
    return data;
  });
  await page
    .locator(".studio-composer")
    .dispatchEvent("dragenter", { dataTransfer: dragged });
  await expect(page.getByText("松开以添加参考文件")).toBeVisible();
  await page
    .locator(".studio-composer")
    .dispatchEvent("drop", { dataTransfer: dragged });
  await expect(
    page.getByLabel("brief.md · 已就绪", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("上传创作参考文件").setInputFiles({
    name: "retry.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("请保留企业品牌色"),
  });
  await expect(
    page.getByLabel("retry.md · 上传失败", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始创作", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "重试上传 retry.md", exact: true })
    .click();
  await expect(
    page.getByLabel("retry.md · 已就绪", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "移除参考文件 brief.md", exact: true })
    .click();
  await expect.poll(() => fixture.deleted).toContain("upload-1");
  await page.getByRole("button", { name: "创作风格", exact: true }).click();
  await page.getByRole("button", { name: "水彩画", exact: true }).click();
  await page.getByRole("button", { name: "生成参数", exact: true }).click();
  await page.getByLabel("图片质量", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "关闭生成参数", exact: true }).click();
  await page.screenshot({
    path: "test-results/studio-enhanced-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "开始创作", exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  expect(fixture.requests[0]).toMatchObject({
    prompt: "根据参考资料设计海报",
    operation: "generate",
    style: "watercolor",
    image_quality: "high",
    attachment_ids: ["upload-0", "upload-2"],
  });
  await expect(page.getByLabel("参考文件", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("本轮参考文件")).toContainText("retry.md");
});

test("studio reuses private artwork, marks an erase region and submits its PNG mask", async ({
  page,
}) => {
  const fixture = await studioFixture(page);
  await page.getByLabel("搜索创作作品").fill("没有此作品");
  await expect(
    page.getByText("没有符合条件的作品。试试其他关键词或筛选条件。"),
  ).toBeVisible();
  await page.getByLabel("搜索创作作品").fill("耳机");
  await expect(
    page.getByRole("button", { name: "用作参考图", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "用作参考图", exact: true }).click();
  await expect(
    page.getByLabel("已有作品.png · 已就绪", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "擦除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开始创作", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "标记区域", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "标记要修改的区域" });
  const canvas = dialog.getByLabel("涂抹编辑区域画布");
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.4,
    bounds.y + bounds.height * 0.4,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.6,
    bounds.y + bounds.height * 0.6,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(
    dialog.getByRole("button", { name: "保存标记", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "保存标记", exact: true }),
  ).toBeDisabled();
  await page.mouse.move(
    bounds.x + bounds.width * 0.5,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.up();
  await dialog.getByRole("button", { name: "保存标记", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "修改标记", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始创作", exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  expect(fixture.uploads[0].name).toBe("edit-mask.png");
  expect(fixture.requests[0]).toMatchObject({
    operation: "erase",
    attachment_ids: ["asset-reference"],
    mask_attachment_id: "upload-0",
    kind: "image",
  });
  expect(fixture.requests[0].prompt).toContain("擦除");
});

/** 验证移动端草稿恢复与横向布局。 */
test("studio preserves text drafts and remains usable at mobile width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await studioFixture(page);
  await page.getByLabel("创作要求").fill("待完成的创作草稿");
  await page.getByRole("button", { name: "提示词模板", exact: true }).click();
  await expect(page.getByLabel("创作要求")).toHaveValue(
    /待完成的创作草稿[\s\S]*构图/,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("atlas:studio:draft:studio-enhancement-fixture"),
      ),
    )
    .toContain("待完成的创作草稿");
  await page.reload();
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "创作台", exact: true }).click();
  await expect(page.getByLabel("创作要求")).toHaveValue(/待完成的创作草稿/);
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(width.content).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({
    path: "test-results/studio-enhanced-mobile.png",
    fullPage: true,
  });
});
