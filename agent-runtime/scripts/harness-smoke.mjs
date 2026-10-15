// Real upstream SDK + Docker + npm plugin integration. No live model/API key.
// Run: docker pull node:22-bookworm-slim && npm run test:harness:smoke
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { manage } from "../harness-manager.mjs";
import { manageCloud, cloudPaths } from "../harness-cloud.mjs";

const runtime = dirname(dirname(fileURLToPath(import.meta.url)));
const smokeParent = process.env.HARNESS_SMOKE_ROOT ?? tmpdir();
await mkdir(smokeParent, { recursive: true });
// A fake-clock reaper must never operate on an application's shared root.
const root = await mkdtemp(join(smokeParent, "zxh-harness-smoke-"));
const image = process.env.BOT_HARNESS_IMAGE ?? "node:22-bookworm-slim";
execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
const plugin = "@aiwayds/dsh-web-search-anysearch";
const owner = { root, tenant_id: "smoke-tenant", user_id: "smoke-user" };
console.log("Installing real Harness plugin…");
const installed = await manage({
  ...owner,
  operation: "install",
  source: plugin,
  registry: "https://registry.npmjs.org",
  enabled_names: [],
});
assert.equal(installed.name, plugin);
assert.equal(installed.bundle, true);
await manage({ ...owner, operation: "enable", enabled_names: [] });
await manage({ ...owner, operation: "enable", enabled_names: [plugin] });

let phase = "first",
  step = 0,
  currentWorkspace;
const requests = [];
const artifacts = [];
const toolCalls = [];
const executions = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const heldRequests = new Map([
  ["keep-alive", deferred()],
  ["retry-fenced", deferred()],
]);
const concurrentSteps = new Map();
async function waitFor(check, message, timeout = 40_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(message);
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=",
  "base64",
);
const server = createServer(async (req, res) => {
  try {
    let data = "";
    for await (const chunk of req) data += chunk;
    assert.equal(
      req.headers.authorization,
      "Bearer fixture-only",
      "provider received credential through host proxy",
    );
    const body = JSON.parse(data);
    const lastUser = JSON.stringify(
      body.messages.filter((message) => message.role === "user").at(-1),
    );
    const marker = ["cancel-target", "keep-alive", "retry-fenced"].find(
      (name) => lastUser.includes(`[${name}]`),
    );
    const requestPhase = marker ?? phase;
    const requestStep = marker
      ? (concurrentSteps.get(marker) ?? 0) + 1
      : ++step;
    if (marker) concurrentSteps.set(marker, requestStep);
    requests.push({ phase: requestPhase, body });
    let delta = { role: "assistant", content: `${requestPhase} completed` };
    const call = (name, args) => ({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `${requestPhase}-${requestStep}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    if (requestPhase === "first" && requestStep === 1)
      delta = call("task_plan", {
        steps: [{ title: "Save native artifacts", status: "running" }],
      });
    if (requestPhase === "first" && requestStep === 2)
      delta = call("write", {
        file_path: `${currentWorkspace}/smoke.md`,
        content: "# Official Harness SDK\nNative file output.",
      });
    if (requestPhase === "first" && requestStep === 3)
      delta = call("bash", {
        command: `node -e 'if(process.env.DSH_API_KEY==="fixture-only")throw Error("Provider key entered container");if(process.env.ZXH_WORKER_TOKEN)throw Error("Worker fence entered container");require("fs").writeFileSync("${currentWorkspace}/smoke.png",Buffer.from("${png.toString("base64")}","base64"))'`,
        description: "Check private credentials and save binary PNG",
      });
    if (marker === "cancel-target" && requestStep === 1)
      delta = call("bash", {
        command:
          'node -e \'require("fs").writeFileSync("cancel-started.json",JSON.stringify({pid:process.pid,started:require("fs").readFileSync("/proc/self/stat","utf8").split(") ")[1].split(" ")[19]}));setTimeout(()=>{},60000)\'',
        description: "Run a native child until its exact task is cancelled",
      });
    if (heldRequests.has(marker)) await heldRequests.get(marker).promise;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason) => ({
      id: "smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }],
    });
    res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    res.end(
      `data: ${JSON.stringify(chunk({}, delta.tool_calls ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
let checkpoint;
async function execute(
  task_id,
  {
    code = true,
    resume,
    query = "Save files and complete task.",
    leaseToken = randomUUID(),
  } = {},
) {
  currentWorkspace = `/workspace/tasks/${task_id}`;
  console.log(`Running ${phase} through the real SDK and Docker…`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(runtime, "harness-agent.mjs")],
      {
        cwd: runtime,
        env: {
          PATH: process.env.PATH,
          ...Object.fromEntries(
            ["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]
              .filter((key) => process.env[key])
              .map((key) => [key, process.env[key]]),
          ),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    executions.push({ task_id, lease_token: leaseToken, child });
    let stderr = "",
      result,
      failure;
    child.stderr.on("data", (bytes) => (stderr += bytes));
    const timer = setTimeout(() => {
      failure = new Error(`SDK smoke timed out: ${stderr}`);
      child.kill();
    }, 110_000);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        failure = new Error(line);
        child.kill();
        return;
      }
      if (event.type === "checkpoint") {
        checkpoint = event.runtime;
        if (process.env.HARNESS_SMOKE_DEBUG)
          console.log("CHECKPOINT", JSON.stringify(checkpoint.messages));
        child.stdin.write(
          JSON.stringify({ type: "checkpoint_ack", id: event.id, ok: true }) +
            "\n",
        );
      }
      if (event.type === "tool_call") {
        toolCalls.push(event);
        if (event.name === "write_artifact") artifacts.push(event.args);
        child.stdin.write(
          JSON.stringify({
            type: "tool_result",
            id: event.id,
            ok: true,
            data: {
              saved: true,
              artifact_id: randomUUID(),
              name: event.args.name,
            },
          }) + "\n",
        );
      }
      if (event.type === "error") {
        failure = new Error(event.error);
        child.stdin.end();
      }
      if (event.type === "result") {
        result = event;
        child.stdin.end();
      }
    });
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      if (process.env.HARNESS_SMOKE_DEBUG) console.log("SDK_STDERR", stderr);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new Error(stderr || "SDK returned no result"));
    });
    child.stdin.write(
      JSON.stringify({
        query,
        model: "fixture-model",
        base_url: `http://127.0.0.1:${server.address().port}/v1`,
        api_key: "fixture-only",
        context_window: 32768,
        max_output_tokens: 2048,
        system_prompt: "Execute the task and save results.",
        bot_tools: { enabled: true, code, connectors: [] },
        allow_web: true,
        history: [],
        artifacts: [],
        read_history: [],
        resume: resume ? { runtime: resume } : undefined,
        deepseek_harness: {
          ...owner,
          task_id,
          lease_token: leaseToken,
          plugin_ids: [plugin],
          plugin_config: {},
          image,
          bridge_host:
            process.env.HARNESS_SMOKE_BRIDGE_HOST ?? "host.docker.internal",
        },
      }) + "\n",
    );
  });
}
try {
  const task = randomUUID();
  const first = await execute(task);
  if (process.env.HARNESS_SMOKE_DEBUG)
    console.log(
      "TOOLS",
      requests[0].body.tools.map((tool) => tool.function.name),
    );
  assert.equal(first.engine, "deepseek-harness");
  assert(
    toolCalls.some((call) => call.name === "task_plan"),
    "platform bridge reached host",
  );
  assert(
    artifacts.some(
      (file) =>
        file.name === "smoke.md" &&
        Buffer.from(file.content_base64, "base64")
          .toString()
          .includes("Official Harness SDK"),
    ),
    "native text imported",
  );
  assert(
    artifacts.some(
      (file) =>
        file.name === "smoke.png" &&
        Buffer.from(file.content_base64, "base64").equals(png),
    ),
    "native binary imported exactly",
  );
  assert.equal(checkpoint.native_session_id, task);
  const cloud = await manageCloud({ ...owner, image, operation: "status" });
  assert.equal(cloud.connected, true, "task completion retains user container");
  assert.equal(cloud.active_tasks, 0, "task completion releases exec lease");
  const firstContainer = JSON.parse(
    execFileSync("docker", ["inspect", cloud.container_name], {
      encoding: "utf8",
    }),
  )[0];
  for (const key of ["DSH_API_KEY", "ZXH_BRIDGE_TOKEN", "ZXH_WORKER_TOKEN"])
    assert(
      !firstContainer.Config.Env.some((value) => value.startsWith(`${key}=`)),
      "persistent container has no task credentials",
    );
  const firstTools = requests[0].body.tools.map((tool) => tool.function.name);
  assert(
    firstTools.includes("bash") && firstTools.includes("web_search"),
    "native shell and plugin-backed web tool loaded",
  );
  phase = "resume";
  step = 0;
  await execute(task, { resume: checkpoint });
  assert.equal(
    JSON.parse(
      execFileSync("docker", ["inspect", cloud.container_name], {
        encoding: "utf8",
      }),
    )[0].Id,
    firstContainer.Id,
    "successive SDK tasks reuse the same user container",
  );
  assert(
    requests
      .filter((r) => r.phase === "resume")
      .at(-1)
      .body.messages.some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message).includes("first completed"),
      ),
    "official persisted native session restored assistant history",
  );
  await manageCloud({ ...owner, operation: "disconnect" });
  phase = "reconnect";
  step = 0;
  await execute(task, { resume: checkpoint });
  assert.notEqual(
    JSON.parse(
      execFileSync("docker", ["inspect", cloud.container_name], {
        encoding: "utf8",
      }),
    )[0].Id,
    firstContainer.Id,
    "reconnect provisions a fresh service over persistent task data",
  );
  assert(
    requests
      .filter((r) => r.phase === phase)
      .at(-1)
      .body.messages.some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message).includes("first completed"),
      ),
    "native session survives container removal",
  );
  const persistedCheckpoint = checkpoint;
  phase = "code-disabled";
  step = 0;
  await execute(randomUUID(), { code: false });
  const disabled = requests
    .filter((r) => r.phase === phase)
    .at(-1)
    .body.tools.map((tool) => tool.function.name);
  for (const name of [
    "bash",
    "pwsh",
    "run_python",
    "job_kill",
    "job_list",
    "job_output",
  ])
    assert(!disabled.includes(name), `${name} must be disabled`);
  const concurrentContainerId = JSON.parse(
    execFileSync("docker", ["inspect", cloud.container_name], {
      encoding: "utf8",
    }),
  )[0].Id;
  const cancelTask = randomUUID(),
    keepTask = randomUUID(),
    oldFence = randomUUID(),
    keepFence = randomUUID();
  const settled = (promise) =>
    promise.then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    );
  console.log("Checking real concurrent task cancellation and fencing…");
  const cancelledRun = settled(
    execute(cancelTask, {
      query: "[cancel-target] Wait for cancellation.",
      leaseToken: oldFence,
    }),
  );
  const keptRun = settled(
    execute(keepTask, {
      query: "[keep-alive] Complete when released.",
      leaseToken: keepFence,
    }),
  );
  await waitFor(
    () => concurrentSteps.has("keep-alive"),
    "second concurrent SDK task did not reach model fixture",
  );
  const childRecord = await waitFor(async () => {
    try {
      return JSON.parse(
        await readFile(
          join(cloudPaths(owner).workspaces, cancelTask, "cancel-started.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "native cancellation target did not start");
  const nativeChildAlive = () =>
    JSON.parse(
      execFileSync(
        "docker",
        [
          "exec",
          cloud.container_name,
          "node",
          "-e",
          'const fs=require("fs");let live=false;try{const f=fs.readFileSync(`/proc/${process.argv[1]}/stat`,"utf8").split(") ")[1].split(" ");live=f[0]!=="Z"&&f[19]===process.argv[2]}catch{};console.log(JSON.stringify(live));',
          String(childRecord.pid),
          childRecord.started,
        ],
        { encoding: "utf8" },
      ),
    );
  assert(nativeChildAlive(), "real native child is active before cancellation");
  const concurrentCloud = await manageCloud({ ...owner, operation: "status" });
  assert.equal(concurrentCloud.active_tasks, 2);
  await manageCloud({
    ...owner,
    operation: "cancel-task",
    task_id: cancelTask,
    lease_token: oldFence,
  });
  const cancelled = await cancelledRun;
  assert.equal(
    cancelled.ok,
    false,
    "cancelled SDK task does not return a completed result",
  );
  await waitFor(
    () => !nativeChildAlive(),
    "cancelled task left its native child running",
    10_000,
  );
  const otherCloud = await manageCloud({ ...owner, operation: "status" });
  assert(otherCloud.connected, "cancellation retains the user's service");
  assert.equal(otherCloud.active_tasks, 1, "another execution keeps its lease");
  const retryFence = randomUUID();
  const retryRun = settled(
    execute(cancelTask, {
      query: "[retry-fenced] Complete this retry when released.",
      leaseToken: retryFence,
    }),
  );
  await waitFor(
    () => concurrentSteps.has("retry-fenced"),
    "retry did not reach fixture",
  );
  await manageCloud({
    ...owner,
    operation: "cancel-task",
    task_id: cancelTask,
    lease_token: oldFence,
  });
  assert.equal(
    (await manageCloud({ ...owner, operation: "status" })).active_tasks,
    2,
    "delayed cancellation of old fence preserves retry and unrelated task",
  );
  heldRequests.get("retry-fenced").resolve();
  heldRequests.get("keep-alive").resolve();
  assert.equal((await retryRun).ok, true, "retry survives old-fence cleanup");
  assert.equal((await keptRun).ok, true, "unrelated SDK task completes");
  assert.equal(
    JSON.parse(
      execFileSync("docker", ["inspect", cloud.container_name], {
        encoding: "utf8",
      }),
    )[0].Id,
    concurrentContainerId,
    "all concurrent executions retain the same user container",
  );
  const idleCloud = await manageCloud({ ...owner, operation: "status" });
  assert.equal(idleCloud.active_tasks, 0);
  const beforeExpiry = await manageCloud(
    { root, operation: "reap", live_tasks: [] },
    { now: () => idleCloud.expires_at - 1 },
  );
  assert.deepEqual(
    beforeExpiry.reaped,
    [],
    "service remains until full 1800 seconds idle",
  );
  const atExpiry = await manageCloud(
    { root, operation: "reap", live_tasks: [] },
    { now: () => idleCloud.expires_at },
  );
  assert.deepEqual(atExpiry.errors, []);
  assert.deepEqual(
    atExpiry.reaped,
    [idleCloud.id],
    "service is removed at exact idle boundary",
  );
  assert.equal(
    (await manageCloud({ ...owner, operation: "status" })).connected,
    false,
  );
  assert.equal(
    await readFile(
      join(cloudPaths(owner).workspaces, task, "smoke.md"),
      "utf8",
    ),
    "# Official Harness SDK\nNative file output.",
    "idle reclamation retains user files",
  );
  phase = "idle-reconnect";
  step = 0;
  await execute(task, { resume: persistedCheckpoint });
  assert(
    requests
      .filter((r) => r.phase === phase)
      .at(-1)
      .body.messages.some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message).includes("first completed"),
      ),
    "idle reclamation preserves native history and enabled plugin",
  );
  assert(
    requests
      .filter((r) => r.phase === phase)
      .at(-1)
      .body.tools.some((tool) => tool.function.name === "web_search"),
  );
  await manage({
    ...owner,
    operation: "remove",
    name: plugin,
    enabled_names: [plugin],
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        version: "0.2.0-rc.2",
        plugin: installed.version,
        native_resume: true,
        platform_bridge: true,
        binary_artifacts: true,
        code_disabled: true,
        persistent_container_reuse: true,
        persistent_session_reconnect: true,
        concurrent_task_cancellation: true,
        native_child_cleanup: true,
        old_fence_retry_protection: true,
        idle_1800_seconds: true,
        idle_preserves_history_files_plugins: true,
        model_requests: requests.length,
        root,
      },
      null,
      2,
    ),
  );
} finally {
  for (const gate of heldRequests.values()) gate.resolve();
  for (const execution of executions.filter(
    ({ child }) => child.exitCode === null,
  )) {
    await manageCloud({
      ...owner,
      operation: "cancel-task",
      task_id: execution.task_id,
      lease_token: execution.lease_token,
    }).catch(() => {});
    execution.child.kill("SIGTERM");
  }
  await new Promise((resolve) => server.close(resolve));
  await manageCloud({ ...owner, operation: "disconnect" }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
