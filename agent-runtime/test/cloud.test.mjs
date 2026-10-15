import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  manageCloud,
  acquireTask,
  renewTask,
  releaseTask,
  cloudPaths,
  taskDirectories,
  IDLE_TIMEOUT_SECONDS,
} from "../harness-cloud.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zxh-cloud-test-"));
  const installation = join(root, "releases/test");
  await mkdir(join(installation, "node_modules/@deepseek-ai/dsh"), {
    recursive: true,
  });
  await writeFile(
    join(installation, "node_modules/@deepseek-ai/dsh/package.json"),
    JSON.stringify({ version: "test" }),
  );
  let clock = 1_000_000,
    creates = 0;
  const containers = new Map(),
    alive = new Set(),
    stopped = [];
  const driver = {
    async inspect(name) {
      return containers.get(name) ?? null;
    },
    async create(paths, spec) {
      creates++;
      containers.set(paths.name, {
        Id: `container-${creates}`,
        State: { Running: true },
        Config: {
          Labels: {
            "zxh.cloud.managed": "true",
            "zxh.cloud.owner": paths.id,
            "zxh.cloud.root": paths.rootId,
          },
        },
      });
    },
    async remove(name) {
      containers.delete(name);
    },
    async probe(name, lease) {
      return alive.has(lease.process_token);
    },
    async stop(name, lease) {
      stopped.push(lease.process_token);
      alive.delete(lease.process_token);
    },
  };
  const owner = {
    root,
    tenant_id: "tenant",
    user_id: "user",
    image: "fixture-image",
  };
  const options = { installation, driver, now: () => clock };
  return {
    root,
    owner,
    options,
    containers,
    alive,
    stopped,
    get creates() {
      return creates;
    },
    advance(ms) {
      clock += ms;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("reconnect and concurrent connect reuse one user container, retaining profile and session files", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        manageCloud({ ...f.owner, operation: "connect" }, f.options),
      ),
    );
    assert.equal(f.creates, 1);
    assert(results.every((r) => r.connected && r.id === results[0].id));
    const paths = cloudPaths(f.owner),
      task = await taskDirectories({ ...f.owner, task_id: "task-one" });
    await writeFile(join(task.home, "session.json"), "persisted session");
    await writeFile(join(task.workspace, "report.md"), "persisted file");
    await writeFile(
      join(paths.installed, "plugin-sentinel"),
      "persisted plugin",
    );
    await manageCloud({ ...f.owner, operation: "disconnect" }, f.options);
    assert.equal(f.containers.size, 0);
    await manageCloud({ ...f.owner, operation: "connect" }, f.options);
    assert.equal(f.creates, 2);
    assert.equal(
      await readFile(join(task.home, "session.json"), "utf8"),
      "persisted session",
    );
    assert.equal(
      await readFile(join(task.workspace, "report.md"), "utf8"),
      "persisted file",
    );
    assert.equal(
      await readFile(join(paths.installed, "plugin-sentinel"), "utf8"),
      "persisted plugin",
    );
    const other = await manageCloud(
      { ...f.owner, user_id: "other", operation: "connect" },
      f.options,
    );
    assert.notEqual(other.container_name, results[0].container_name);
    assert.notEqual(
      cloudPaths({ ...f.owner, tenant_id: "other" }).owner,
      paths.owner,
    );
  } finally {
    await f.cleanup();
  }
});
test("idle reclaim fires at thirty minutes and heartbeat extends it without recreating a missing container", async () => {
  const f = await fixture();
  try {
    const first = await manageCloud(
      { ...f.owner, operation: "connect" },
      f.options,
    );
    assert.equal(first.idle_timeout_seconds, IDLE_TIMEOUT_SECONDS);
    f.advance(1800_000 - 1);
    assert.deepEqual(
      (await manageCloud({ root: f.root, operation: "reap" }, f.options))
        .reaped,
      [],
    );
    const heartbeat = await manageCloud(
      { ...f.owner, operation: "heartbeat" },
      f.options,
    );
    assert(heartbeat.expires_at > first.expires_at);
    f.advance(1800_000);
    assert.deepEqual(
      (await manageCloud({ root: f.root, operation: "reap" }, f.options))
        .reaped,
      [first.id],
    );
    const offline = await manageCloud(
      { ...f.owner, operation: "heartbeat" },
      f.options,
    );
    assert.equal(offline.connected, false);
    assert.equal(f.creates, 1);
  } finally {
    await f.cleanup();
  }
});
test("live execs and Rust admission leases prevent disconnect, engine rebuild and stale-heartbeat reclaim", async () => {
  const f = await fixture();
  try {
    const task = await acquireTask(
      { ...f.owner, task_id: "task-one", lease_token: "worker-fence" },
      f.options,
    );
    f.alive.add(task.process_token);
    f.advance(2000_000);
    const live_tasks = [
      { ...f.owner, task_id: "task-one", lease_token: task.token },
    ];
    const reaped = await manageCloud(
      { root: f.root, operation: "reap", live_tasks },
      f.options,
    );
    assert.equal(reaped.reaped.length, 0);
    assert.deepEqual(reaped.skipped_active, [task.id]);
    await assert.rejects(
      manageCloud({ ...f.owner, operation: "disconnect" }, f.options),
      { code: "CLOUD_SESSION_BUSY" },
    );
    await assert.rejects(
      manageCloud(
        { ...f.owner, image: "changed", operation: "connect" },
        f.options,
      ),
      { code: "CLOUD_SESSION_BUSY" },
    );
    await renewTask({ ...f.owner, token: task.token }, f.options);
    f.alive.delete(task.process_token);
    await releaseTask({ ...f.owner, token: task.token }, f.options);
    f.advance(1800_000);
    assert.equal(
      (
        await manageCloud(
          { root: f.root, operation: "reap", live_owners: [f.owner] },
          f.options,
        )
      ).reaped.length,
      0,
    );
    await assert.rejects(
      manageCloud(
        { ...f.owner, active_tasks: 1, operation: "disconnect" },
        f.options,
      ),
      { code: "CLOUD_SESSION_BUSY" },
    );
    await manageCloud({ ...f.owner, operation: "disconnect" }, f.options);
    await assert.rejects(
      manageCloud(
        { ...f.owner, active_tasks: 1, operation: "connect" },
        f.options,
      ),
      { code: "CLOUD_SESSION_BUSY" },
    );
  } finally {
    await f.cleanup();
  }
});
test("an expired exec orphan is killed before reclaim, while fresh runtime heartbeat renews its lease", async () => {
  const f = await fixture();
  try {
    const task = await acquireTask(
      { ...f.owner, task_id: "orphan", lease_token: "fence" },
      f.options,
    );
    f.alive.add(task.process_token);
    f.advance(100_000);
    await renewTask({ ...f.owner, token: task.token }, f.options);
    assert.equal(f.stopped.length, 0);
    f.advance(1800_000);
    const report = await manageCloud(
      { root: f.root, operation: "reap" },
      f.options,
    );
    assert.deepEqual(f.stopped, [task.process_token]);
    assert.deepEqual(report.reaped, [task.id]);
  } finally {
    await f.cleanup();
  }
});
test("authoritative reaper revokes a fresh renewed native execution when its SQL worker fence is absent", async () => {
  const f = await fixture();
  try {
    const task = await acquireTask(
      { ...f.owner, task_id: "stale-worker", lease_token: "stale-fence" },
      f.options,
    );
    f.alive.add(task.process_token);
    f.advance(15_000);
    await renewTask({ ...f.owner, token: task.token }, f.options);
    const snapshot = f.options.now();
    await manageCloud(
      { ...f.owner, operation: "status", live_tasks: [] },
      f.options,
    );
    assert.equal(
      f.stopped.length,
      0,
      "status cannot revoke a fresh lease from a racing DB snapshot",
    );
    const report = await manageCloud(
      {
        root: f.root,
        operation: "reap",
        live_tasks: [],
        fence_snapshot_at: snapshot,
      },
      f.options,
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      f.stopped,
      [task.process_token],
      "fresh renewal cannot preserve a stale worker fence",
    );
    await assert.rejects(
      renewTask({ ...f.owner, token: task.token }, f.options),
      { code: "CLOUD_LEASE_LOST" },
    );
    assert.equal(
      (await manageCloud({ ...f.owner, operation: "status" }, f.options))
        .active_tasks,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test("reaper preserves native leases admitted after its SQL fence snapshot and honors the next snapshot", async () => {
  const f = await fixture();
  try {
    const snapshot = f.options.now();
    f.advance(1);
    const task = await acquireTask(
      { ...f.owner, task_id: "new-worker", lease_token: "new-fence" },
      f.options,
    );
    f.alive.add(task.process_token);
    f.advance(100_000);
    await manageCloud(
      {
        root: f.root,
        operation: "reap",
        live_tasks: [],
        fence_snapshot_at: snapshot,
      },
      f.options,
    );
    assert.equal(f.stopped.length, 0);
    assert.equal(
      (
        await manageCloud(
          {
            ...f.owner,
            operation: "status",
            live_tasks: [
              {
                tenant_id: f.owner.tenant_id,
                user_id: f.owner.user_id,
                task_id: "new-worker",
                lease_token: task.token,
              },
            ],
          },
          f.options,
        )
      ).active_tasks,
      1,
    );
    const currentSnapshot = f.options.now();
    await manageCloud(
      {
        root: f.root,
        operation: "reap",
        fence_snapshot_at: currentSnapshot,
        live_tasks: [
          {
            tenant_id: f.owner.tenant_id,
            user_id: f.owner.user_id,
            task_id: "new-worker",
            lease_token: task.token,
          },
        ],
      },
      f.options,
    );
    assert.equal(
      f.stopped.length,
      0,
      "the authoritative SQL fence protects the active attempt",
    );
    await manageCloud(
      {
        root: f.root,
        operation: "reap",
        live_tasks: [],
        fence_snapshot_at: currentSnapshot,
      },
      f.options,
    );
    assert.deepEqual(f.stopped, [task.process_token]);
  } finally {
    await f.cleanup();
  }
});
test("crash recovery clears expired dead execs but delayed cleanup cannot cancel a new worker attempt", async () => {
  const f = await fixture();
  try {
    const old = await acquireTask(
      { ...f.owner, task_id: "task-one", lease_token: "old-fence" },
      f.options,
    );
    await assert.rejects(
      acquireTask(
        { ...f.owner, task_id: "task-one", lease_token: "new-fence" },
        f.options,
      ),
      { code: "CLOUD_TASK_BUSY" },
    );
    f.advance(100_000);
    const current = await acquireTask(
      { ...f.owner, task_id: "task-one", lease_token: "new-fence" },
      f.options,
    );
    f.alive.add(current.process_token);
    await manageCloud(
      {
        ...f.owner,
        operation: "cancel-task",
        task_id: "task-one",
        lease_token: old.token,
      },
      f.options,
    );
    assert.equal(f.stopped.length, 0);
    assert.equal(
      (await manageCloud({ ...f.owner, operation: "status" }, f.options))
        .active_tasks,
      1,
    );
    await assert.rejects(
      manageCloud(
        {
          ...f.owner,
          operation: "release-task",
          task_id: "task-one",
          lease_token: current.token,
        },
        f.options,
      ),
      { code: "CLOUD_TASK_BUSY" },
    );
    await manageCloud(
      {
        ...f.owner,
        operation: "cancel-task",
        task_id: "task-one",
        lease_token: current.token,
      },
      f.options,
    );
    assert.deepEqual(f.stopped, [current.process_token]);
    assert.equal(
      (await manageCloud({ ...f.owner, operation: "status" }, f.options))
        .active_tasks,
      0,
    );
    assert.equal(f.containers.size, 1);
  } finally {
    await f.cleanup();
  }
});
test("one user's simultaneous distinct tasks share the container while preserving separate workspaces", async () => {
  const f = await fixture();
  try {
    const tasks = await Promise.all(
      ["first", "second"].map((task_id) =>
        acquireTask({ ...f.owner, task_id }, f.options),
      ),
    );
    assert.equal(f.creates, 1);
    assert.notEqual(tasks[0].process_token, tasks[1].process_token);
    const dirs = await Promise.all(
      ["first", "second"].map((task_id) =>
        taskDirectories({ ...f.owner, task_id }),
      ),
    );
    assert.notEqual(dirs[0].workspace, dirs[1].workspace);
    assert.equal(
      (await manageCloud({ ...f.owner, operation: "status" }, f.options))
        .active_tasks,
      2,
    );
  } finally {
    await f.cleanup();
  }
});
test("legacy task migration preserves native session ID and refuses traversal/symlink directories", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "tasks", "legacy", "home"), { recursive: true });
    await mkdir(join(f.root, "workspaces", "legacy"), { recursive: true });
    await writeFile(
      join(f.root, "tasks", "legacy", "home", "session.json"),
      "legacy session",
    );
    await writeFile(
      join(f.root, "workspaces", "legacy", "report.md"),
      "legacy artifact",
    );
    const dirs = await taskDirectories({ ...f.owner, task_id: "legacy" });
    assert.equal(
      await readFile(join(dirs.home, "session.json"), "utf8"),
      "legacy session",
    );
    assert.equal(
      await readFile(join(dirs.workspace, "report.md"), "utf8"),
      "legacy artifact",
    );
    assert.match(dirs.containerHome, /\/legacy\/home$/);
    await assert.rejects(taskDirectories({ ...f.owner, task_id: "../other" }), {
      code: "CLOUD_INVALID_TASK",
    });
    await symlink(f.root, join(cloudPaths(f.owner).workspaces, "unsafe"));
    await assert.rejects(taskDirectories({ ...f.owner, task_id: "unsafe" }), {
      code: "CLOUD_INVALID_TASK",
    });
  } finally {
    await f.cleanup();
  }
});
test("persistent task home and owner records cannot direct host writes into another user's files", async () => {
  const f = await fixture();
  try {
    const directories = await taskDirectories({
      ...f.owner,
      task_id: "unsafe-home",
    });
    const outside = join(f.root, "outside-owner");
    await mkdir(outside);
    await rm(directories.home, { recursive: true });
    await symlink(outside, directories.home);
    await assert.rejects(
      taskDirectories({ ...f.owner, task_id: "unsafe-home" }),
      {
        code: "CLOUD_INVALID_TASK",
      },
    );
    await assert.rejects(readFile(join(outside, "owner.json")), {
      code: "ENOENT",
    });
    const record = await taskDirectories({
      ...f.owner,
      task_id: "unsafe-record",
    });
    const victim = join(outside, "victim.json");
    await writeFile(victim, '{"private":"untouched"}');
    await rm(join(record.taskRoot, "owner.json"));
    await symlink(victim, join(record.taskRoot, "owner.json"));
    await assert.rejects(
      taskDirectories({ ...f.owner, task_id: "unsafe-record" }),
    );
    assert.equal(await readFile(victim, "utf8"), '{"private":"untouched"}');
  } finally {
    await f.cleanup();
  }
});
test("revoked task sessions and files are quarantined outside mounts, restored after authorization, and never erase data", async () => {
  const f = await fixture();
  try {
    const task = await taskDirectories({ ...f.owner, task_id: "restricted" });
    await writeFile(join(task.home, "session.json"), "private history");
    await writeFile(join(task.workspace, "report.md"), "private file");
    const connected = await manageCloud(
      { ...f.owner, operation: "connect" },
      f.options,
    );
    const before = connected.last_activity_at;
    const offline = await manageCloud(
      {
        ...f.owner,
        operation: "sync-access",
        authorized_task_ids: [],
        restricted_task_ids: ["restricted"],
      },
      f.options,
    );
    assert.equal(offline.connected, false);
    assert.equal(
      offline.last_activity_at,
      before,
      "permission synchronization is not user activity",
    );
    const quarantine = join(cloudPaths(f.owner).owner, "quarantine");
    assert.equal(
      await readFile(
        join(quarantine, "tasks/restricted/home/session.json"),
        "utf8",
      ),
      "private history",
    );
    assert.equal(
      await readFile(
        join(quarantine, "workspaces/restricted/report.md"),
        "utf8",
      ),
      "private file",
    );
    await assert.rejects(
      acquireTask(
        {
          ...f.owner,
          task_id: "restricted",
          authorized_task_ids: [],
          restricted_task_ids: ["restricted"],
        },
        f.options,
      ),
      { code: "CLOUD_TASK_FORBIDDEN" },
    );
    await manageCloud(
      { ...f.owner, operation: "connect", authorized_task_ids: ["restricted"] },
      f.options,
    );
    assert.equal(
      await readFile(join(task.workspace, "report.md"), "utf8"),
      "private file",
    );
    assert.equal(f.creates, 2);
  } finally {
    await f.cleanup();
  }
});
test("permission changes defer while another valid task runs and targeted cleanup never touches an unrelated expired lease", async () => {
  const f = await fixture();
  try {
    await taskDirectories({ ...f.owner, task_id: "old" });
    const running = await acquireTask(
      { ...f.owner, task_id: "running", lease_token: "current" },
      f.options,
    );
    await assert.rejects(
      manageCloud(
        { ...f.owner, operation: "connect", authorized_task_ids: ["running"] },
        f.options,
      ),
      { code: "CLOUD_SESSION_BUSY" },
    );
    assert.equal(f.containers.size, 1);
    f.alive.add(running.process_token);
    f.advance(100_000);
    await manageCloud(
      {
        ...f.owner,
        operation: "cancel-task",
        task_id: "other",
        lease_token: "old-cleanup",
      },
      f.options,
    );
    assert.equal(f.stopped.length, 0);
    await releaseTask({ ...f.owner, token: "old-cleanup" }, f.options);
    assert.equal(f.stopped.length, 0);
    await renewTask({ ...f.owner, token: running.token }, f.options);
    assert.equal(f.stopped.length, 0);
  } finally {
    await f.cleanup();
  }
});
