import { expect, test, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";

function taskDetail(content: string, status = "completed") {
  return {
    task: {
      id: "citation-task",
      title: "创建 HTML 动画",
      prompt: "创建 HTML 动画，不使用 skill",
      status,
      result: content,
      error: null,
      attempt: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      options: {
        allow_web: true,
        allow_code: true,
        connector_ids: [],
        skill_ids: [],
        document_ids: [],
      },
      plan: [],
      citations: [1, 7, 3].map((number, index) => ({
        chunk_id: `chunk-${index + 1}`,
        document_id: `document-${index + 1}`,
        space_id: "knowledge-space",
        title: `候选资料 ${index + 1}`,
        text: "检索候选，是否被正文引用需要另外确认。",
        page: index + 1,
        kind: "text",
        version: 1,
        image_url: null,
        source_url: `/api/documents/document-${index + 1}/file`,
        ...(index === 1 ? { citation_number: number } : {}),
        // Metadata may belong to an earlier result during streaming.
        referenced: true,
      })),
      web_sources: [
        { title: "公开资料一", url: "https://public.example.test/one" },
        { title: "公开资料二", url: "https://public.example.test/two" },
        { title: "不安全地址", url: "javascript:alert(1)" },
        {
          title: "带凭据地址",
          url: "https://user:secret@public.example.test/private",
        },
      ],
    },
    messages: [] as {
      id: string;
      content: string;
      status: string;
      created_at: number;
    }[],
    events: [],
    artifacts: [],
    actions: [],
    evidence_available: true,
  };
}

async function fixture(page: Page, detail: ReturnType<typeof taskDetail>) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const replies: Record<string, unknown> = {
      "/api/auth/me": {
        user: {
          id: "citation-owner",
          tenant_id: "citation-tenant",
          name: "测试成员",
          role: "member",
          active: true,
        },
        tenant: { id: "citation-tenant", name: "测试企业", slug: "fixture" },
      },
      "/api/stats": {
        counts: { documents: 0, chunks: 0, images: 0, pending: 0 },
        capabilities: { models: {} },
        spaces: 0,
      },
      "/api/spaces": [],
      "/api/documents": { items: [], total: 0 },
      "/api/bot/capabilities": {
        agent: true,
        model: "fixture",
        web: true,
        code: true,
        worker: true,
      },
      "/api/bot/tasks": [detail.task],
      "/api/bot/tasks/citation-task": detail,
      "/api/bot/skills": [],
      "/api/bot/connectors": [],
      "/api/bot/devices": [],
      "/api/bot/plugins": { plugins: [] },
      "/api/bot/cloud": { enabled: true, connected: false },
    };
    if (path in replies) return route.fulfill({ json: replies[path] });
    return route.fulfill({ status: 404, json: { error: "Fixture endpoint" } });
  });
}

const workspace = (page: Page) => page.locator(".bot-workspace-pane");
const openTask = (page: Page) => page.goto("/app?view=bot&task=citation-task");

test("retrieved candidates are hidden when the answer does not cite them", async ({
  page,
}) => {
  await fixture(
    page,
    taskDetail("我会直接完成一个无需外部依赖的 HTML，用 SVG 绘制骑车动画。"),
  );
  await openTask(page);
  await expect(workspace(page).locator(".markdown")).toContainText("SVG");
  await expect(
    workspace(page).getByRole("heading", { name: "知识来源" }),
  ).toHaveCount(0);
  await expect(
    workspace(page).getByRole("heading", { name: "公开来源" }),
  ).toHaveCount(0);
  await expect(workspace(page).locator(".bot-sources")).toHaveCount(0);
});

test("actual references keep their assigned numbers and reject unsafe web sources", async ({
  page,
}) => {
  await fixture(
    page,
    taskDetail("内部事实依据 [3] 和 [7]。公开事实依据 [W2]。[W3][W4]"),
  );
  await openTask(page);
  const sources = workspace(page).locator(".bot-sources");
  await expect(sources.getByRole("button")).toHaveText([
    "[7] 候选资料 2 · 第 2 页",
    "[3] 候选资料 3 · 第 3 页",
  ]);
  await expect(sources.getByRole("link")).toHaveText("[W2] 公开资料二");
  const link = sources.getByRole("link");
  await expect(link).toHaveAttribute("href", "https://public.example.test/two");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(workspace(page)).not.toContainText("候选资料 1");
  await expect(workspace(page)).not.toContainText("不安全地址");
  await expect(workspace(page)).not.toContainText("带凭据地址");
});

test("code literals and link labels do not become citations, but explicit safe URLs do", async ({
  page,
}) => {
  await fixture(
    page,
    taskDetail(
      [
        "```js",
        "const item = array[1]; // [W1] https://public.example.test/one",
        "```",
        "代码示例 `[3]`，以及 `https://public.example.test/one`。",
        "[[7]](https://unlisted.example.test)。",
        "[[1]](https://public.example.test/two)。",
        "避免前缀误匹配：https://public.example.test/one.evil。",
      ].join("\n\n"),
    ),
  );
  await openTask(page);
  const sources = workspace(page).locator(".bot-sources");
  await expect(
    workspace(page).getByRole("heading", { name: "公开来源" }),
  ).toBeVisible();
  await expect(
    workspace(page).getByRole("heading", { name: "知识来源" }),
  ).toHaveCount(0);
  await expect(sources.getByRole("link")).toHaveText("[W2] 公开资料二");
});

test("bare URLs and Markdown reference links identify only their exact public sources", async ({
  page,
}) => {
  await fixture(
    page,
    taskDetail(
      "查看 https://public.example.test/one。以及 [公开网页][public]。\n\n[public]: https://public.example.test/two",
    ),
  );
  await openTask(page);
  await expect(workspace(page).locator(".bot-sources a")).toHaveText([
    "[W1] 公开资料一",
    "[W2] 公开资料二",
  ]);
  await expect(
    workspace(page).getByRole("heading", { name: "知识来源" }),
  ).toHaveCount(0);
});

test("streaming sources follow the displayed message and clear when access becomes unavailable", async ({
  page,
}) => {
  const detail = taskDetail("上一轮答案引用了资料 [1]。", "running");
  detail.messages = [
    {
      id: "live-message",
      content: "我正在绘制 SVG 动画。",
      status: "streaming",
      created_at: Date.now(),
    },
  ];
  await fixture(page, detail);
  let client: ServerResponse | undefined;
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
  const { port } = server.address() as { port: number };
  await page.route("**/api/bot/tasks/*/stream", (route) =>
    route.continue({ url: `http://127.0.0.1:${port}/stream` }),
  );
  try {
    await openTask(page);
    await expect(workspace(page).locator(".markdown")).toContainText(
      "正在绘制",
    );
    await expect(workspace(page).locator(".bot-sources")).toHaveCount(0);
    const output = (text: string) =>
      send("output", {
        id: "live-message",
        text,
        replace: false,
        status: "streaming",
        created_at: detail.messages[0].created_at,
      });
    output("需要引用 [");
    await expect(workspace(page).locator(".markdown")).toContainText(
      "需要引用 [",
    );
    await expect(workspace(page).locator(".bot-sources")).toHaveCount(0);
    output("3]");
    await expect(workspace(page).locator(".bot-sources button")).toHaveText(
      "[3] 候选资料 3 · 第 3 页",
    );
    send("unavailable", {});
    await expect(workspace(page).locator(".markdown")).toContainText(
      "权限已变化",
    );
    await expect(workspace(page).locator(".bot-sources")).toHaveCount(0);
  } finally {
    client?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a completed result uses its own references rather than the latest intermediate message", async ({
  page,
}) => {
  const detail = taskDetail("最终成果依据资料 [7]。");
  detail.messages = [
    {
      id: "intermediate-message",
      content: "我还在检查资料 [1]。",
      status: "completed",
      created_at: Date.now(),
    },
  ];
  await fixture(page, detail);
  await openTask(page);
  await expect(workspace(page).locator(".markdown")).toContainText("最终成果");
  await expect(workspace(page).locator(".bot-sources button")).toHaveText(
    "[7] 候选资料 2 · 第 2 页",
  );
  await page.reload();
  await expect(workspace(page).locator(".bot-sources button")).toHaveText(
    "[7] 候选资料 2 · 第 2 页",
  );
});
