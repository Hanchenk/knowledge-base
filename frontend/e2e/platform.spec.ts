import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
async function login(page: import("@playwright/test").Page, member = false) {
  await page.goto("/app");
  await page
    .getByRole("button", {
      name: member ? "填入产品成员账号" : "填入管理员账号",
    })
    .click();
  await page.getByRole("button", { name: "登录工作空间" }).click();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
}

test("admin configures and probes all RAG models through the page", async ({
  page,
}) => {
  await login(page);
  const original = await (await page.request.get("/api/models")).json();
  test.skip(
    ["chat", "embedding", "vision"].some(
      (kind) => original[kind].enabled || original[kind].has_api_key,
    ),
    "Use an unconfigured demo environment to avoid overwriting real model credentials",
  );
  const calls: string[] = [];
  const provider = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: "Fixture uses manual model names" }),
      );
      return;
    }
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const input = JSON.parse(bytes);
    const kind = input.model.replace("test-", "");
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${kind}-secret`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "invalid key" }));
      return;
    }
    calls.push(kind);
    if (request.url === "/v1/embeddings")
      response.end(
        JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
      );
    else if (
      kind === "vision" &&
      !input.messages[0].content[1].image_url.url.startsWith(
        "data:image/png;base64,",
      )
    ) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "image missing" }));
    } else
      response.end(
        JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }),
      );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address() as { port: number };
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const panel = page.getByRole("region", { name: "RAG 模型配置" });
    await expect(
      panel.getByRole("heading", { name: "RAG 模型配置" }),
    ).toBeVisible();
    for (const [kind, title] of [
      ["chat", "问答模型"],
      ["embedding", "向量模型"],
      ["vision", "视觉模型"],
    ]) {
      const card = panel.getByRole("article", { name: title });
      await card
        .getByLabel("服务地址（Base URL）")
        .fill(`http://127.0.0.1:${address.port}/v1`);
      await card.getByLabel("模型名称").fill(`test-${kind}`);
      await expect(card.getByText(/已填写配置，尚未启用/)).toBeVisible();
      await card.getByLabel("API Key", { exact: true }).fill(`${kind}-secret`);
      if (kind === "embedding") {
        await card.getByLabel("向量维度").fill("2");
        await card.getByRole("button", { name: "测试连接" }).click();
        await expect(card.locator(".model-test-result")).toContainText(
          "实际返回 3",
        );
        await card.getByLabel("向量维度").fill("3");
      }
      await card.getByRole("button", { name: "测试连接" }).click();
      await expect(card.locator(".model-test-result")).toContainText(
        "测试通过",
      );
      await expect(card.locator(".model-test-result")).toContainText(
        "测试通过不会自动启用",
      );
      await card.getByRole("checkbox", { name: "启用", exact: true }).check();
      await expect(card.getByText(/已填写配置，尚未启用/)).toHaveCount(0);
    }
    expect(calls).toContain("chat");
    expect(calls).toContain("embedding");
    expect(calls).toContain("vision");
    await expect(panel.getByText("有未保存的修改")).toBeVisible();
    expect(
      (await (await page.request.get("/api/models")).json()).revision,
    ).toBe(original.revision);
    await panel.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(panel.getByText("使用已保存配置")).toBeVisible();
    await expect(
      page.getByText("模型配置已保存并生效", { exact: true }),
    ).toBeVisible();
    const saved = await (await page.request.get("/api/models")).json();
    expect(saved.chat.has_api_key).toBe(true);
    expect(saved.chat.api_key).toBeUndefined();
    const capabilities = await (await page.request.get("/api/stats")).json();
    expect(capabilities.capabilities.models.chat).toBe("test-chat");
    await page.reload();
    await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const chat = panel.getByRole("article", { name: "问答模型" });
    await expect(chat.getByLabel("模型名称")).toHaveValue("test-chat");
    await expect(chat.getByLabel("API Key", { exact: true })).toHaveValue("");
    await chat.getByRole("button", { name: "测试连接" }).click();
    await expect(chat.locator(".model-test-result")).toContainText("测试通过");
    await chat.getByLabel("API Key", { exact: true }).fill("wrong-key");
    await expect(chat.locator(".model-test-result")).toHaveCount(0);
    await chat.getByRole("button", { name: "测试连接" }).click();
    await expect(chat.locator(".model-test-result")).toContainText("HTTP 401");
    expect(
      (await (await page.request.get("/api/models")).json()).revision,
    ).toBe(saved.revision);
    await panel.getByRole("button", { name: "放弃修改" }).click();
    await expect(panel.getByText("使用已保存配置")).toBeVisible();
    await expect(chat.getByLabel("模型名称")).toHaveValue("test-chat");
    await expect(chat.locator(".model-test-result")).toHaveCount(0);
    await page.screenshot({
      path: "../docs/screenshots/model-settings.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  } finally {
    const current = await (await page.request.get("/api/models")).json();
    const restore = Object.fromEntries(
      ["chat", "embedding", "vision"].map((kind) => [
        kind,
        {
          enabled: original[kind].enabled,
          model: original[kind].model,
          base_url: original[kind].base_url,
          dimensions: original[kind].dimensions,
          clear_api_key: true,
        },
      ]),
    );
    const response = await page.request.put("/api/models", {
      data: { ...restore, revision: current.revision },
      headers: { Origin: new URL(page.url()).origin },
    });
    await new Promise<void>((resolve, reject) =>
      provider.close((e) => (e ? reject(e) : resolve())),
    );
    expect(response.ok()).toBe(true);
  }
});

test("admin can upload knowledge, ask with sources, edit permissions and manage an Agent key", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const documentName = `e2e-team-policy-${Date.now()}`;
  const keyName = `E2E agent-${Date.now()}`;
  await login(page);
  await expect(
    page.getByRole("heading", { name: "团队知识空间" }),
  ).toBeVisible();
  await page.screenshot({
    path: "../docs/screenshots/dashboard.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "文档管理", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "文档管理", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "上传资料", exact: true }).click();
  const upload = page.getByRole("dialog", { name: "上传资料到知识库" });
  await upload.locator("input[type=file]").setInputFiles({
    name: `${documentName}.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# 集成验收资料\n\n跨部门会议预约应提前三天完成，会议室最多容纳十二人。",
    ),
  });
  await upload.getByRole("button", { name: "上传并索引" }).click();
  await expect(upload).not.toBeVisible();
  await page
    .getByRole("textbox", { name: "搜索文档标题", exact: true })
    .last()
    .fill(documentName);
  await expect(
    page.locator(".document-name").filter({ hasText: documentName }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: documentName }).getByText("已索引"),
  ).toBeVisible({ timeout: 20000 });
  await page
    .locator(".document-name")
    .filter({ hasText: documentName })
    .click();
  await expect(page.getByRole("dialog").getByText(/提前三天/)).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "智能问答", exact: true }).click();
  await page
    .getByRole("textbox", { name: "向知识库提问" })
    .fill("跨部门会议预约需要提前几天？");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.locator(".citations")).toBeVisible();
  await expect(page.locator(".message.assistant")).toContainText("提前三天");
  await page.screenshot({
    path: "../docs/screenshots/chat.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "知识空间", exact: true }).click();
  await page
    .locator(".space-card")
    .filter({
      has: page.getByRole("heading", { name: "产品与研发", exact: true }),
    })
    .getByRole("button", { name: "权限设置" })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "产品与研发 · 权限设置" })
      .getByRole("checkbox", { name: "包含下级" }),
  ).toBeChecked();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "Agent 接入", exact: true }).click();
  await page
    .getByRole("button", { name: "创建 API 密钥", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("textbox", { name: "密钥名称" })
    .fill(keyName);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建密钥", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "密钥已创建" })).toBeVisible();
  await expect(page.locator(".secret-key code")).toHaveText(
    /^ak_[a-f0-9]{64}$/,
  );
  await page.getByRole("button", { name: "我已保存，关闭" }).click();
  await expect(
    page.locator("tbody tr").filter({ hasText: keyName }),
  ).toBeVisible();
  await page
    .locator("tbody tr")
    .filter({ hasText: keyName })
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(
    page.locator("tbody tr").filter({ hasText: keyName }),
  ).toContainText("已撤销");
  await page.getByRole("button", { name: "文档管理", exact: true }).click();
  await page
    .getByRole("textbox", { name: "搜索文档标题", exact: true })
    .last()
    .fill(documentName);
  await page
    .locator(".document-name")
    .filter({ hasText: documentName })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除文档" })
    .click();
  await page
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: documentName }),
  ).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("member sees authorized department knowledge and mobile navigation works", async ({
  page,
}) => {
  await login(page, true);
  await expect(
    page.getByRole("heading", { name: "产品与研发", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "人力与行政", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "成员与组织", exact: true }),
  ).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../docs/screenshots/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "智能问答", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "团队的知识，随问随答。" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "向知识库提问" }),
  ).toBeVisible();
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
});

test("Pi Agent page keeps web opt-in and displays tool and public sources", async ({
  page,
}) => {
  const requests: { allow_web: boolean }[] = [];
  let answer = {
    id: "pi-ui-answer",
    role: "assistant",
    content: "根据工具结果完成回答。",
    citations: [
      {
        chunk_id: "unused",
        document_id: "unused",
        space_id: "test",
        title: "未引用的企业资料",
        text: "unused",
        page: 1,
        kind: "text",
        image_url: null,
        source_url: "/api/documents/unused/file",
        version: 1,
        referenced: false,
        citation_number: 1,
      },
      {
        chunk_id: "used",
        document_id: "used",
        space_id: "test",
        title: "实际引用的企业资料",
        text: "used",
        page: 1,
        kind: "text",
        image_url: null,
        source_url: "/api/documents/used/file",
        version: 1,
        referenced: true,
        citation_number: 4,
      },
    ],
    engine: "pi-agent-core",
    web_sources: [] as { title: string; url: string }[],
    tool_calls: [{ name: "knowledge_search", success: true, duration_ms: 120 }],
  };
  await page.route("**/api/stats", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        capabilities: {
          ...body.capabilities,
          chat: true,
          agent: true,
          web: true,
        },
      },
    });
  });
  await page.route("**/api/chat", async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    answer = {
      ...answer,
      web_sources: input.allow_web
        ? [
            {
              title: "PostgreSQL 官方文档",
              url: "https://www.postgresql.org/docs/",
            },
          ]
        : [],
      tool_calls: [
        {
          name: input.allow_web ? "web_search" : "knowledge_search",
          success: true,
          duration_ms: 120,
        },
      ],
    };
    await route.fulfill({
      json: {
        ...answer,
        answer: answer.content,
        conversation_id: "pi-ui-verification",
        warnings: [],
        mode: "hybrid",
      },
    });
  });
  await page.route("**/api/conversations", async (route) =>
    route.fulfill({
      json: requests.length
        ? [
            {
              id: "pi-ui-verification",
              title: "Pi UI 验证",
              created_at: Date.now(),
            },
          ]
        : [],
    }),
  );
  await page.route(
    "**/api/conversations/pi-ui-verification/messages",
    async (route) => route.fulfill({ json: [answer] }),
  );
  await login(page);
  await page.getByRole("button", { name: "智能问答", exact: true }).click();
  const web = page.getByRole("button", { name: "智能搜索", exact: true });
  await expect(web).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Pi Agent + RAG", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "向知识库提问" })
    .fill("差旅报销流程");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(
    page.getByText("根据工具结果完成回答。", { exact: true }),
  ).toBeVisible();
  expect(requests[0].allow_web).toBe(false);
  await expect(page.getByText("未引用的企业资料", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator(".citation-number")).toHaveText("4");
  await page.locator(".tool-trace summary").click();
  await expect(
    page.locator(".tool-trace").getByText("知识库检索", { exact: true }),
  ).toBeVisible();
  await web.click();
  await page
    .getByRole("textbox", { name: "向知识库提问" })
    .fill("联网查找 PostgreSQL 官网");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(
    page.getByRole("link", { name: /PostgreSQL 官方文档/ }),
  ).toHaveAttribute("href", "https://www.postgresql.org/docs/");
  expect(requests[1].allow_web).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "智能问答", exact: true }).click();
  await page.getByRole("button", { name: "Pi UI 验证", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /PostgreSQL 官方文档/ }),
  ).toBeVisible();
  await expect(web).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("question composer uploads attachments, waits for indexing and retains failed questions", async ({
  page,
}) => {
  const uploads: string[] = [];
  const questions: {
    query: string;
    document_ids?: string[];
    allow_web: boolean;
  }[] = [];
  let ready = false;
  let rejectQuestion = true;
  await page.route("**/api/stats", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        capabilities: {
          ...body.capabilities,
          agent: true,
          chat: true,
          web: true,
        },
      },
    });
  });
  await page.route("**/api/conversations", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/documents/upload", async (route) => {
    uploads.push(route.request().postDataBuffer()!.toString());
    await route.fulfill({
      json: {
        id: `question-file-${uploads.length}`,
        status: "queued",
        version: 1,
      },
    });
  });
  await page.route("**/api/documents/question-file-*/status", async (route) => {
    await route.fulfill({
      json: {
        status: route.request().url().includes("question-file-2")
          ? "failed"
          : ready
            ? "ready"
            : "processing",
        error: route.request().url().includes("question-file-2")
          ? "文件解析失败，请检查文件内容"
          : null,
      },
    });
  });
  await page.route("**/api/chat", async (route) => {
    questions.push(route.request().postDataJSON());
    await route.fulfill(
      rejectQuestion
        ? { status: 503, json: { error: "模型暂时不可用" } }
        : {
            json: {
              answer: "已根据附件概括关键要点。",
              citations: [],
              warnings: [],
              conversation_id: "question-composer",
              engine: "pi-agent-core",
              web_sources: [],
              tool_calls: [],
            },
          },
    );
  });
  await login(page);
  await page.getByRole("button", { name: "智能问答", exact: true }).click();
  await expect(page.getByPlaceholder("问点什么，一起探索")).toBeVisible();
  const web = page.getByRole("button", { name: "智能搜索", exact: true });
  await expect(web).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  const menu = page.getByRole("region", { name: "上传问答附件" });
  await expect(menu).toContainText("500 MB");
  await expect(menu).toContainText("空间内有查看权限的成员可访问");
  const destination = await page
    .getByRole("combobox", { name: "附件保存空间" })
    .inputValue();
  await page.getByLabel("选择问答附件").setInputFiles({
    name: "方案说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("知识库附件测试"),
  });
  await expect(page.getByRole("button", { name: "发送问题" })).toBeDisabled();
  await expect(page.getByText(/正在索引/)).toBeVisible();
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain(destination);
  expect(uploads[0]).toContain("方案说明.txt");
  ready = true;
  await expect(page.getByText(/可用于问答/)).toBeVisible();
  await expect(page.getByRole("button", { name: "发送问题" })).toBeEnabled();
  // Upload a second attachment whose indexing fails: it must block submission.
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  await page.getByLabel("选择问答附件").setInputFiles({
    name: "损坏的方案.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from("fixture"),
  });
  await expect(page.getByText("文件解析失败，请检查文件内容")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送问题" })).toBeDisabled();
  await page.getByRole("button", { name: "移除附件 损坏的方案.pptx" }).click();
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("textbox", { name: "向知识库提问" })).toHaveValue(
    "请总结附件内容，提炼关键要点并引用来源",
  );
  await expect(
    page.getByRole("button", { name: "移除附件 方案说明.txt" }),
  ).toBeVisible();
  expect(questions[0].document_ids).toEqual(["question-file-1"]);
  expect(questions[0].allow_web).toBe(false);
  rejectQuestion = false;
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByText("已根据附件概括关键要点。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "移除附件 方案说明.txt" }),
  ).toHaveCount(0);
  expect(uploads).toHaveLength(2); // Question retry does not duplicate the upload.
  await page.getByRole("button", { name: "开启新对话" }).click();
  await web.click();
  const closeToast = page.getByRole("button", { name: "关闭提示" });
  if (await closeToast.isVisible()) await closeToast.click();
  await page.getByRole("textbox", { name: "向知识库提问" }).click();
  const screenshots = fileURLToPath(
    new URL("../../docs/screenshots/", import.meta.url),
  );
  await page.screenshot({
    path: `${screenshots}/question-composer.png`,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${screenshots}/question-composer-mobile.png`,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "上传文件", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "发送问题" })).toBeVisible();
});
