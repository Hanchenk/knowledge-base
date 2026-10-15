import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformTools } from "../platform-tools.mjs";
import { harnessSchema, apply as applyPlatform } from "../harness-plugin.mjs";
import {
  checkpointMessages,
  importWorkspace,
  redactError,
} from "../harness-agent.mjs";
import {
  userHome,
  leafRowId,
  PINNED_VERSION,
  containerEngine,
  runtimeRoot,
} from "../harness-profile.mjs";
import { validateSpec, manage } from "../harness-manager.mjs";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";

test("all authorized platform schemas conform to the real upstream DSL", () => {
  const definitions = createPlatformTools(
    {
      allow_web: true,
      studio_tools: { image: true, video: true },
      bot_tools: { enabled: true, code: true, connectors: [{ id: "fixture" }] },
    },
    (name, description, parameters) => ({ name, description, parameters }),
  );
  assert(definitions.length >= 15);
  for (const definition of definitions)
    assertSupportedJsonSchema(harnessSchema(definition.parameters));
});
test("native web tool names coexist with the audited platform bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "zxh-bridge-test-"));
  const original = process.env.ZXH_TASK_CONFIG;
  try {
    process.env.ZXH_TASK_CONFIG = join(root, "config.json");
    await writeFile(
      process.env.ZXH_TASK_CONFIG,
      JSON.stringify({
        allow_web: true,
        bot_tools: { enabled: true, code: false },
      }),
    );
    const names = [];
    await applyPlatform({
      tools: { register: (tool) => names.push(tool.name) },
    });
    assert(names.includes("knowledge_search") && names.includes("task_plan"));
    assert(
      names.includes("platform_web_search") &&
        names.includes("platform_web_fetch"),
    );
    assert(!names.includes("web_search") && !names.includes("run_python"));
  } finally {
    if (original === undefined) delete process.env.ZXH_TASK_CONFIG;
    else process.env.ZXH_TASK_CONFIG = original;
    await rm(root, { recursive: true, force: true });
  }
});
test("recovery snapshot excludes private reasoning and preserves visible text", () => {
  const messages = checkpointMessages(
    [
      {
        type: "assistant/message",
        data: {
          message: {
            content: [
              { type: "thinking", thinking: "private reasoning" },
              { type: "text", text: "visible answer" },
            ],
          },
        },
      },
    ],
    [{ role: "user", content: "start" }],
  );
  assert.deepEqual(messages, [
    { role: "user", content: "start" },
    { role: "assistant", content: "visible answer" },
  ]);
  assert(!JSON.stringify(messages).includes("private reasoning"));
});
test("provider and plugin errors redact credentials while retaining diagnostics", () => {
  const config = {
    api_key: "model-secret",
    deepseek_harness: {
      plugin_config: {
        plugin: {
          row: {
            apiKey: "plugin-api-key",
            password: "plugin-password",
            nested: { accessToken: "plugin-token" },
            description: "retain this",
          },
        },
      },
    },
  };
  const message = redactError(
    "provider model-secret failed; plugin-api-key plugin-password plugin-token retain this",
    config,
  );
  assert.equal(
    message,
    "provider [redacted] failed; [redacted] [redacted] [redacted] retain this",
  );
});
test("workspace import preserves binary bytes and skips links and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "zxh-import-test-"));
  try {
    await mkdir(join(root, "nested"));
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "node_modules"));
    const binary = Buffer.from([0, 255, 80, 78, 71]);
    await writeFile(join(root, "nested", "output.png"), binary);
    await writeFile(join(root, "report.md"), "report");
    await writeFile(join(root, ".hidden", "secret.md"), "secret");
    await writeFile(join(root, "node_modules", "ignored.md"), "ignored");
    await writeFile(join(root, "huge.pdf"), Buffer.alloc(5_000_001));
    await symlink("/etc/passwd", join(root, "leak.txt"));
    await symlink("/etc", join(root, "outside"));
    const calls = [];
    const result = await importWorkspace(root, async (type, call) => {
      assert.equal(type, "tool_call");
      calls.push(call);
      return { ok: true };
    });
    assert.equal(result.count, 2);
    assert.deepEqual(result.skipped, ["huge.pdf"]);
    assert(
      calls.some(
        (call) =>
          call.args.name === "nested-output.png" &&
          Buffer.from(call.args.content_base64, "base64").equals(binary),
      ),
    );
    assert(
      calls.every(
        (call) =>
          call.name === "write_artifact" && !call.args.name.includes("leak"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("workspace import rejects root symlinks and mismatched owner paths before exporting bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "zxh-root-link-test-"));
  let exported = false;
  const request = async () => {
    exported = true;
    return { ok: true };
  };
  try {
    const owner = join(root, "owner");
    const outside = join(root, "another-owner");
    await mkdir(join(owner, "workspaces"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "private data");
    const workspace = join(owner, "workspaces", "task");
    await symlink(outside, workspace);
    await assert.rejects(
      importWorkspace(workspace, request, {
        ownerRoot: owner,
        task_id: "task",
      }),
    );
    await assert.rejects(
      importWorkspace(outside, request, { ownerRoot: owner, task_id: "task" }),
      /归属/,
    );
    assert.equal(exported, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("workspace import caps exported file count and reports failed storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "zxh-count-test-"));
  try {
    for (let i = 0; i < 31; i++)
      await writeFile(join(root, `${i}.txt`), "data");
    const result = await importWorkspace(root, async () => ({ ok: true }));
    assert.equal(result.count, 30);
    assert.equal(result.skipped.length, 1);
    await assert.rejects(
      importWorkspace(root, async () => ({
        ok: false,
        error: "storage unavailable",
      })),
      /storage unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("owner profile keys and Cordis leaf IDs are deterministic and isolated", () => {
  const home = userHome("/tmp/profiles", "tenant", "../user");
  assert.match(home, /\/users\/[a-f0-9]{64}$/);
  assert.notEqual(home, userHome("/tmp/profiles", "other-tenant", "../user"));
  assert.throws(() => userHome("/tmp/profiles", "", "user"), /owner/);
  assert.equal(leafRowId("@scope/plugin"), leafRowId("@scope/plugin"));
  assert.notEqual(leafRowId("@scope/plugin"), leafRowId("@scope/other"));
});
test("install source validation rejects command options and credential URLs", () => {
  for (const source of [
    "@scope/dsh-plugin@1.2.3",
    "github:owner/repo#main",
    "https://example.org/plugin.tgz",
  ])
    assert.equal(validateSpec(source), source);
  for (const source of [
    "--help",
    "name;rm",
    "https://user:secret@example.org/p.tgz",
    "http://example.org/p.tgz",
    "https://localhost/p.tgz",
    "https://example.org/plain.js",
  ])
    assert.throws(() => validateSpec(source));
});
test("synchronizing the installed version leaves the running release untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "zxh-update-test-"));
  try {
    const result = await manage({
      root,
      operation: "update",
      version: PINNED_VERSION,
    });
    assert.equal(result.installed_version, PINNED_VERSION);
    await assert.rejects(readFile(join(root, "active.json")), {
      code: "ENOENT",
    });
    await assert.rejects(
      readFile(join(root, "releases", PINNED_VERSION, "package.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("an existing active release receives missing and updated application adapters without replacing its engine packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "zxh-active-adapters-test-"));
  const release = join(root, "releases", "0.1.0");
  const packagePath = join(
    release,
    "node_modules/@deepseek-ai/dsh/package.json",
  );
  const enginePackage =
    '{"name":"@deepseek-ai/dsh","version":"0.1.0","engineMarker":"preserve"}';
  const manifest =
    '{"private":true,"dependencies":{"@deepseek-ai/dsh":"0.1.0"}}';
  try {
    await mkdir(join(release, "node_modules/@deepseek-ai/dsh"), {
      recursive: true,
    });
    await writeFile(packagePath, enginePackage);
    await writeFile(join(release, "package.json"), manifest);
    await writeFile(join(release, `.linux-${process.arch}-ready`), "ready");
    await writeFile(join(root, "active.json"), '{"version":"0.1.0"}');
    await writeFile(
      join(release, "harness-plugin.mjs"),
      "// old application adapter\n",
    );
    await assert.rejects(readFile(join(release, "harness-exec.mjs")), {
      code: "ENOENT",
    });
    assert.equal(await containerEngine(root), release);
    for (const name of [
      "harness-plugin.mjs",
      "harness-sdk-server.mjs",
      "harness-exec.mjs",
      "platform-tools.mjs",
    ])
      assert(
        (await readFile(join(release, name))).equals(
          await readFile(join(runtimeRoot, name)),
        ),
      );
    assert.equal(await readFile(packagePath, "utf8"), enginePackage);
    assert.equal(
      await readFile(join(release, "package.json"), "utf8"),
      manifest,
    );
    assert.equal(
      await readFile(join(root, "active.json"), "utf8"),
      '{"version":"0.1.0"}',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
