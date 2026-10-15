import { expect, test, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

const html = `<!doctype html><html><body><h1>鹈鹕骑自行车</h1><svg width="160" height="90"><circle id="wheel" cx="30" cy="40" r="12"/></svg><button id="animate">播放动画</button><button id="escape">离开预览</button><output id="count">0</output><script>
  window.previewSecurity = {};
  try { parent.document.body.dataset.previewEscaped = 'yes'; window.previewSecurity.parent = 'allowed'; } catch { window.previewSecurity.parent = 'blocked'; }
  try { window.previewSecurity.cookie = document.cookie.includes('preview-session='); } catch { window.previewSecurity.cookie = 'blocked'; }
  try { localStorage.setItem('preview-secret', 'yes'); window.previewSecurity.storage = 'allowed'; } catch { window.previewSecurity.storage = 'blocked'; }
  fetch('/api/auth/me').then(() => window.previewSecurity.network = 'allowed').catch(() => window.previewSecurity.network = 'blocked');
  document.querySelector('#animate').onclick = () => { document.querySelector('#count').textContent = '1'; document.querySelector('#wheel').setAttribute('cx', '70'); };
  document.querySelector('#escape').onclick = () => { try { top.location.href = 'https://escape.example.test/'; } catch { window.previewSecurity.navigation = 'blocked'; } };
</script></body></html>`;
const artifacts = [
  { id: "animation", name: "pelican-bike.html", size: html.length },
  { id: "report", name: "report.md", size: 120 },
  { id: "data", name: "data.json", size: 16 },
  { id: "config", name: "settings.yaml", size: 16 },
  { id: "image", name: "preview.png", size: 68 },
  { id: "pdf", name: "report.pdf", size: 200 },
  { id: "zip", name: "archive.zip", size: 200 },
  { id: "same-one", name: "one/same.txt", size: 20 },
  { id: "same-two", name: "two/same.txt", size: 20 },
];
const renderCsp =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const mainCsp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' http://127.0.0.1:18765 http://127.0.0.1:18766 http://127.0.0.1:18767 http://127.0.0.1:18768 http://127.0.0.1:18769; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
function taskDetail(status = "completed") {
  return {
    task: {
      id: "preview-task",
      title: "动画与报告",
      prompt: "创建一个 HTML 动画",
      status,
      result:
        "[动画文件](pelican-bike.html) · [沙盒文件](sandbox:/mnt/data/pelican-bike.html) · [接口文件](/api/bot/artifacts/animation/preview) · [未保存文件](missing.html) · [同名文件](same.txt) · [不属于任务](/api/bot/artifacts/unknown) · [公开网页](https://public.example.test/)",
      error: null,
      attempt: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      options: {
        allow_web: false,
        allow_code: true,
        connector_ids: [],
        skill_ids: [],
        document_ids: [],
        parent_task_id: undefined as string | undefined,
      },
      plan: [],
      citations: [],
      web_sources: [],
    },
    messages: [],
    events: [],
    actions: [],
    artifacts,
    evidence_available: true,
  };
}

async function fixture(
  page: Page,
  detail = taskDetail(),
  ancestor?: ReturnType<typeof taskDetail>,
) {
  const previews: string[] = [];
  const renders: string[] = [];
  const renderCookies: string[] = [];
  const pdf = await page.pdf();
  let failed = false;
  let wrongType = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const replies: Record<string, unknown> = {
      "/api/auth/me": {
        user: {
          id: "preview-owner",
          tenant_id: "preview-tenant",
          name: "测试成员",
          role: "member",
          active: true,
        },
        tenant: { id: "preview-tenant", name: "测试企业", slug: "fixture" },
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
      "/api/bot/tasks/preview-task": detail,
      "/api/bot/skills": [],
      "/api/bot/connectors": [],
      "/api/bot/devices": [],
      "/api/bot/plugins": { plugins: [] },
      "/api/bot/cloud": { enabled: true, connected: false },
      ...(ancestor ? { [`/api/bot/tasks/${ancestor.task.id}`]: ancestor } : {}),
    };
    if (path in replies) return route.fulfill({ json: replies[path] });
    if (path.endsWith("/render")) {
      const id = path.split("/").at(-2)!;
      renders.push(route.request().url());
      renderCookies.push((await route.request().allHeaders()).cookie || "");
      if (!["animation", "old-animation"].includes(id))
        return route.fulfill({
          status: 415,
          body: "Unsupported artifact render",
        });
      return route.fulfill({
        body: html,
        contentType: "text/html; charset=utf-8",
        headers: {
          "Content-Security-Policy": renderCsp,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    if (path.endsWith("/preview")) {
      const id = path.split("/").at(-2)!;
      previews.push(id);
      if (failed)
        return route.fulfill({
          status: 403,
          json: { error: "该文件无访问权限" },
        });
      if (["animation", "old-animation"].includes(id))
        return route.fulfill({
          contentType: "text/plain; charset=utf-8",
          body: html,
        });
      if (["report", "old-report"].includes(id))
        return route.fulfill({
          contentType: "text/plain; charset=utf-8",
          body: "# 已完成报告\n\n[打开动画](pelican-bike.html)\n\n<script>parent.document.body.dataset.reportEscaped='yes'</script>",
        });
      if (["data", "config"].includes(id))
        return route.fulfill({
          contentType: "text/plain; charset=utf-8",
          body: id === "data" ? '{"value": 42}' : "name: preview\nvalue: 42",
        });
      if (id === "image")
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZsAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      if (id === "pdf")
        return route.fulfill({
          contentType: "application/pdf",
          body: wrongType ? html : pdf,
        });
    }
    return route.fulfill({ status: 404, json: { error: "Fixture endpoint" } });
  });
  return {
    previews,
    renders,
    renderCookies,
    setFailed: (value: boolean) => {
      failed = value;
    },
    setWrongType: (value: boolean) => {
      wrongType = value;
    },
  };
}
const workspace = (page: Page) => page.locator(".bot-workspace-pane");
const open = (page: Page) => page.goto("/app?view=bot&task=preview-task");

test("generated file links open an interactive isolated preview without leaving the task", async ({
  page,
}) => {
  await fixture(page);
  await open(page);
  const thread = page.locator(".bot-chat-reply");
  await thread.getByRole("button", { name: "动画文件", exact: true }).click();
  await expect(
    workspace(page).getByRole("tab", { name: "文件" }),
  ).toHaveAttribute("aria-selected", "true");
  const frame = page.frameLocator('iframe[title="预览 pelican-bike.html"]');
  await expect(
    frame.getByRole("heading", { name: "鹈鹕骑自行车" }),
  ).toBeVisible();
  await expect(
    page.locator('iframe[title="预览 pelican-bike.html"]'),
  ).toHaveAttribute("sandbox", "allow-scripts");
  await frame.getByRole("button", { name: "播放动画" }).click();
  await expect(frame.locator("#count")).toHaveText("1");
  await expect(frame.locator("#wheel")).toHaveAttribute("cx", "70");
  await workspace(page)
    .getByRole("button", { name: "刷新预览", exact: true })
    .click();
  await expect(frame.locator("#count")).toHaveText("0");
  await expect
    .poll(() =>
      frame.locator("body").evaluate(() => (window as any).previewSecurity),
    )
    .toEqual({
      parent: "blocked",
      cookie: "blocked",
      storage: "blocked",
      network: "blocked",
    });
  await frame.getByRole("button", { name: "离开预览" }).click();
  await expect(frame.locator("body")).toHaveCount(1);
  await expect(page).toHaveURL(/\/app\?view=bot&task=preview-task$/);
  expect(
    await page.locator("body").getAttribute("data-preview-escaped"),
  ).toBeNull();
  expect(
    await page.evaluate(() => localStorage.getItem("preview-secret")),
  ).toBeNull();
  await workspace(page)
    .getByRole("button", { name: "源码", exact: true })
    .click();
  await expect(workspace(page).locator(".bot-artifact-text")).toContainText(
    "window.previewSecurity",
  );
  await workspace(page)
    .getByRole("button", { name: "预览", exact: true })
    .click();
  await expect(
    frame.getByRole("heading", { name: "鹈鹕骑自行车" }),
  ).toBeVisible();
  for (const name of ["沙盒文件", "接口文件"]) {
    await workspace(page).getByRole("tab", { name: "成果" }).click();
    await thread.getByRole("button", { name, exact: true }).click();
    await expect(
      frame.getByRole("heading", { name: "鹈鹕骑自行车" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/task=preview-task$/);
  }
  for (const name of ["未保存文件", "同名文件", "不属于任务"]) {
    await expect(thread.getByRole("link", { name, exact: true })).toHaveCount(
      0,
    );
    await expect(thread.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  }
  await expect(thread.getByRole("link", { name: "公开网页" })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(
    workspace(page).locator(
      '.bot-artifact-card a[aria-label="下载 pelican-bike.html"]',
    ),
  ).toHaveAttribute("href", "/api/bot/artifacts/animation");
  await expect(
    workspace(page).locator(
      '.bot-artifact-card a[aria-label="下载 pelican-bike.html"]',
    ),
  ).toHaveAttribute("download", "pelican-bike.html");
});

test("production document CSP allows isolated artifact animations without granting application access", async ({
  page,
  context,
}) => {
  // Serve the compiled application: the Vite development preamble requires
  // inline scripts and would not exercise the production policy faithfully.
  const dist = resolve(import.meta.dirname, "../dist");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://fixture.test").pathname;
    const target = path.startsWith("/assets/")
      ? resolve(dist, `.${path}`)
      : resolve(dist, "index.html");
    try {
      const body = await readFile(target);
      const contentTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".png": "image/png",
        ".jpg": "image/jpeg",
      };
      response.writeHead(200, {
        "content-type":
          contentTypes[extname(target)] || "application/octet-stream",
        "Content-Security-Policy": mainCsp,
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  const state = await fixture(page);
  await context.addCookies([
    {
      name: "preview-session",
      value: "fixture-session",
      url: origin,
      httpOnly: false,
      sameSite: "Lax",
    },
  ]);
  try {
    const mainResponse = await page.goto(
      `${origin}/app?view=bot&task=preview-task`,
    );
    expect(mainResponse!.headers()["content-security-policy"]).toBe(mainCsp);
    await page
      .locator(".bot-chat-reply")
      .getByRole("button", { name: "动画文件", exact: true })
      .click();
    const iframe = page.locator('iframe[title="预览 pelican-bike.html"]');
    await expect(iframe).toHaveAttribute(
      "src",
      /^\/api\/bot\/artifacts\/animation\/render\?revision=/,
    );
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    await expect(iframe).not.toHaveAttribute("srcdoc", /.+/);
    const frame = page.frameLocator('iframe[title="预览 pelican-bike.html"]');
    await frame.getByRole("button", { name: "播放动画" }).click();
    await expect(frame.locator("#count")).toHaveText("1");
    await expect
      .poll(() =>
        frame.locator("body").evaluate(() => (window as any).previewSecurity),
      )
      .toEqual({
        parent: "blocked",
        cookie: "blocked",
        storage: "blocked",
        network: "blocked",
      });
    expect(state.renderCookies.at(-1)).toContain(
      "preview-session=fixture-session",
    );
    await frame.getByRole("button", { name: "离开预览" }).click();
    await expect(page).toHaveURL(`${origin}/app?view=bot&task=preview-task`);
    expect(
      await page.locator("body").getAttribute("data-preview-escaped"),
    ).toBeNull();
    await workspace(page)
      .getByRole("button", { name: "刷新预览", exact: true })
      .click();
    await expect(frame.locator("#count")).toHaveText("0");
    expect(new Set(state.renders).size).toBeGreaterThan(1);
    await workspace(page)
      .getByRole("button", { name: "源码", exact: true })
      .click();
    await expect(workspace(page).locator(".bot-artifact-text")).toContainText(
      "window.previewSecurity",
    );
    await expect(iframe).toHaveCount(0);
    await workspace(page)
      .getByRole("button", { name: "预览 report.pdf", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .frames()
          .some((item) => item.url().startsWith("chrome-extension://")),
      )
      .toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("Markdown, code, images and PDF preview alongside unsupported downloads", async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page);
  await page
    .locator(".bot-chat-reply")
    .getByRole("button", { name: "动画文件", exact: true })
    .click();
  const files = workspace(page).locator(".bot-artifact-list");
  await files
    .getByRole("button", { name: "预览 report.md", exact: true })
    .click();
  await expect(
    workspace(page).getByRole("heading", { name: "已完成报告" }),
  ).toBeVisible();
  expect(
    await page.locator("body").getAttribute("data-report-escaped"),
  ).toBeNull();
  await workspace(page)
    .getByRole("button", { name: "打开动画", exact: true })
    .click();
  await expect(
    page
      .frameLocator('iframe[title="预览 pelican-bike.html"]')
      .getByRole("heading"),
  ).toContainText("鹈鹕");
  await files
    .getByRole("button", { name: "预览 data.json", exact: true })
    .click();
  await expect(workspace(page).locator(".bot-artifact-text")).toHaveText(
    '{"value": 42}',
  );
  await files
    .getByRole("button", { name: "预览 settings.yaml", exact: true })
    .click();
  await expect(workspace(page).locator(".bot-artifact-text")).toContainText(
    "name: preview",
  );
  await files
    .getByRole("button", { name: "预览 preview.png", exact: true })
    .click();
  await expect(
    workspace(page).getByRole("img", { name: "preview.png" }),
  ).toBeVisible();
  expect(
    await workspace(page)
      .getByRole("img", { name: "preview.png" })
      .evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBe(1);
  await files
    .getByRole("button", { name: "预览 report.pdf", exact: true })
    .click();
  await expect(
    workspace(page).locator('iframe[title="预览 report.pdf"]'),
  ).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() =>
      page
        .frames()
        .some((frame) => frame.url().startsWith("chrome-extension://")),
    )
    .toBe(true);
  expect(
    page
      .frames()
      .some((frame) => frame.url() === "chrome-error://chromewebdata/"),
  ).toBe(false);
  await files
    .getByRole("button", { name: "预览 archive.zip", exact: true })
    .click();
  await expect(workspace(page)).toContainText(
    "此格式暂不支持在线预览，可下载后查看。",
  );
  expect(state.previews).not.toContain("zip");
  await expect(
    workspace(page).locator(
      '.bot-artifact-preview a[aria-label="下载 archive.zip"]',
    ),
  ).toHaveAttribute("download", "archive.zip");
});

test("denied previews reload safely and HTML cannot enter the native PDF viewer", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setFailed(true);
  await open(page);
  await page
    .locator(".bot-chat-reply")
    .getByRole("button", { name: "动画文件", exact: true })
    .click();
  await expect(workspace(page).getByRole("alert")).toHaveText(
    /该文件无访问权限/,
  );
  await expect(workspace(page).locator("iframe")).toHaveCount(0);
  state.setFailed(false);
  await workspace(page)
    .getByRole("button", { name: "重新加载", exact: true })
    .click();
  await expect(
    page
      .frameLocator('iframe[title="预览 pelican-bike.html"]')
      .getByRole("heading"),
  ).toContainText("鹈鹕");
  state.setWrongType(true);
  await workspace(page)
    .getByRole("button", { name: "预览 report.pdf", exact: true })
    .click();
  await expect(workspace(page).getByRole("alert")).toContainText(
    "文件内容与预览格式不一致",
  );
  await expect(workspace(page).locator("iframe")).toHaveCount(0);
});

test("ancestor reports resolve their own files and access revocation removes the preview", async ({
  page,
}) => {
  const detail = taskDetail("running");
  const ancestor = taskDetail();
  ancestor.task.id = "preview-ancestor";
  ancestor.task.result = "[此前报告](report.md)";
  ancestor.artifacts = [
    { id: "old-report", name: "report.md", size: 120 },
    { id: "old-animation", name: "pelican-bike.html", size: html.length },
  ];
  detail.task.options.parent_task_id = ancestor.task.id;
  const state = await fixture(page, detail, ancestor);
  let client: ServerResponse | undefined;
  const server = createServer((_request, response) => {
    client = response;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "access-control-allow-origin": "*",
      "cache-control": "no-cache",
    });
    response.flushHeaders();
    response.write(`event: snapshot\ndata: ${JSON.stringify(detail)}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await page.route("**/api/bot/tasks/*/stream", (route) =>
    route.continue({ url: `http://127.0.0.1:${port}/stream` }),
  );
  try {
    await open(page);
    await page.getByRole("button", { name: "此前报告", exact: true }).click();
    await expect(
      workspace(page).getByRole("heading", { name: "已完成报告" }),
    ).toBeVisible();
    await workspace(page)
      .getByRole("button", { name: "打开动画", exact: true })
      .click();
    await expect(
      page
        .frameLocator('iframe[title="预览 pelican-bike.html"]')
        .getByRole("heading"),
    ).toContainText("鹈鹕");
    expect(state.previews).toContain("old-animation");
    expect(state.previews).not.toContain("animation");
    client!.write("event: unavailable\ndata: {}\n\n");
    await expect(workspace(page).locator("iframe")).toHaveCount(0);
    await expect(workspace(page)).toContainText("文件会保存在这里");
  } finally {
    client?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
