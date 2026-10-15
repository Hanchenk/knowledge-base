// User-scoped cloud containers. Lifecycle metadata is deliberately outside the
// directories mounted into untrusted plugins. flock works across API/worker PID
// namespaces and releases automatically after a process crash.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdir, open, readdir, rename, lstat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import { openSafeDirectory } from "./harness-files.mjs";
import {
  atomicJson,
  readJson,
  userHome,
  containerEngine,
  profile,
} from "./harness-profile.mjs";

export const IDLE_TIMEOUT_SECONDS = 1800;
export const TASK_LEASE_MS = 90_000;
const exec = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function cloudPaths(input) {
  const root = resolve(input.root);
  const owner = userHome(root, input.tenant_id, input.user_id);
  const id = basename(owner),
    rootId = digest(root).slice(0, 12);
  return {
    root,
    owner,
    id,
    rootId,
    name: `zxh-cloud-${rootId}-${id.slice(0, 24)}`,
    dir: join(owner, "cloud"),
    file: join(owner, "cloud/state.json"),
    tasks: join(owner, "tasks"),
    workspaces: join(owner, "workspaces"),
    installed: join(owner, "profiles/sdk"),
    home: join(owner, "container-home"),
  };
}
export async function withCloudLock(paths, operation) {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const file = await open(join(paths.dir, "lifecycle.lock"), "a", 0o600);
  const deadline = Date.now() + 15_000;
  try {
    for (;;) {
      try {
        await tryLockExclusive(file.fd);
        break;
      } catch (error) {
        if (!["EAGAIN", "EWOULDBLOCK"].includes(error.code)) throw error;
        if (Date.now() >= deadline)
          throw fail("CLOUD_LOCK_TIMEOUT", "云端会话繁忙，请稍后重试");
        await new Promise((done) => setTimeout(done, 40));
      }
    }
    return await operation();
  } finally {
    await file.close();
  }
}
async function docker(args) {
  try {
    return (
      await exec("docker", args, { timeout: 25_000, maxBuffer: 1_000_000 })
    ).stdout.trim();
  } catch (error) {
    // Docker arguments never carry model/provider credentials here.
    throw fail(
      "CLOUD_DOCKER_ERROR",
      String(error.stderr || error.message).slice(0, 1000),
    );
  }
}
export const dockerDriver = {
  async inspect(name) {
    try {
      return JSON.parse(await docker(["inspect", name]))[0];
    } catch (error) {
      if (/No such (object|container)/i.test(error.message)) return null;
      throw error;
    }
  },
  async create(paths, spec) {
    await docker(["image", "inspect", spec.image]);
    const args = [
      "run",
      "-d",
      "--name",
      paths.name,
      "--init",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=2g",
      "--cpus=2",
      "--user",
      spec.uid,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=128m",
      "--add-host=host.docker.internal:host-gateway",
      "--label",
      "zxh.cloud.managed=true",
      "--label",
      `zxh.cloud.owner=${paths.id}`,
      "--label",
      `zxh.cloud.root=${paths.rootId}`,
    ];
    for (const [source, target, ro] of [
      [spec.engine, "/engine", true],
      [paths.installed, "/installed", true],
      [paths.tasks, "/harness/tasks", false],
      [paths.workspaces, "/workspace/tasks", false],
      [paths.home, "/harness/container-home", false],
    ])
      args.push(
        "--mount",
        `type=bind,src=${source},dst=${target}${ro ? ",readonly" : ""}`,
      );
    args.push(
      "-e",
      "HOME=/harness/container-home",
      "-w",
      "/harness/container-home",
      "--entrypoint",
      "node",
      spec.image,
      "-e",
      "setInterval(()=>{},2147483647)",
    );
    await docker(args);
  },
  async remove(name) {
    await docker(["rm", "-f", name]);
  },
  async probe(name, lease) {
    const value = await docker([
      "exec",
      name,
      "node",
      "/engine/harness-exec.mjs",
      "probe",
      `/harness/tasks/${lease.task_id}/run-${lease.process_token}.json`,
      lease.process_token,
    ]);
    return JSON.parse(value).running === true;
  },
  async stop(name, lease) {
    await docker([
      "exec",
      name,
      "node",
      "/engine/harness-exec.mjs",
      "stop",
      `/harness/tasks/${lease.task_id}/run-${lease.process_token}.json`,
      lease.process_token,
    ]);
  },
};
function assertOwned(container, paths) {
  if (
    container &&
    (container.Config?.Labels?.["zxh.cloud.managed"] !== "true" ||
      container.Config?.Labels?.["zxh.cloud.owner"] !== paths.id ||
      container.Config?.Labels?.["zxh.cloud.root"] !== paths.rootId)
  )
    throw fail("CLOUD_OWNER_MISMATCH", "云端容器归属校验失败");
}
const touch = (state, now) => {
  state.last_activity_at = now;
  state.expires_at = now + IDLE_TIMEOUT_SECONDS * 1000;
};
async function cleanLeases(state, container, driver, now, input, options) {
  state.leases ??= {};
  const snapshot = input.fence_snapshot_at;
  const hasAuthoritativeSnapshot =
    input.operation === "reap" &&
    Array.isArray(input.live_tasks) &&
    Number.isFinite(snapshot);
  for (const [token, lease] of Object.entries(state.leases)) {
    if (options.cleanupTaskId && lease.task_id !== options.cleanupTaskId)
      continue;
    if (!container?.State?.Running) {
      delete state.leases[token];
      continue;
    }
    if (
      hasAuthoritativeSnapshot &&
      Number.isFinite(lease.acquired_at) &&
      lease.acquired_at > snapshot
    )
      continue;
    const protectedTask =
      options.protectToken === token ||
      (input.live_tasks ?? []).some(
        (task) =>
          task.tenant_id === state.tenant_id &&
          task.user_id === state.user_id &&
          task.task_id === lease.task_id &&
          task.lease_token === token,
      );
    // Only the reaper's explicitly timestamped DB snapshot can revoke a fresh
    // host lease. Leases admitted after that query wait for the next snapshot.
    const authoritative =
      hasAuthoritativeSnapshot && Number.isFinite(lease.acquired_at);
    if (lease.expires_at > now && (!authoritative || protectedTask)) continue;
    if (protectedTask) {
      lease.expires_at = now + TASK_LEASE_MS;
      touch(state, now);
    } else {
      // A worker crash can leave an exec alive after its bridge/lease dies.
      // Stop that exact attempt before dropping the lease, never a new attempt.
      if (await driver.probe(state.container_name, lease))
        await driver.stop(state.container_name, lease);
      delete state.leases[token];
    }
  }
}
function result(paths, state, container) {
  const connected = !!container?.State?.Running;
  return {
    ok: true,
    id: paths.id,
    container_name: paths.name,
    status: connected ? "running" : "stopped",
    connected,
    idle_timeout_seconds: IDLE_TIMEOUT_SECONDS,
    last_activity_at: state.last_activity_at ?? null,
    expires_at: state.expires_at ?? null,
    active_tasks: Object.keys(state.leases ?? {}).length,
    engine_version: state.engine_version ?? null,
    image: state.image ?? null,
    storage: { persistent: true },
    persistent: true,
  };
}
async function stateFor(input, options, operation) {
  const paths = cloudPaths(input),
    driver = options.driver ?? dockerDriver;
  return withCloudLock(paths, async () => {
    const now = options.now?.() ?? Date.now();
    const state = await readJson(paths.file, {});
    if (state.id && state.id !== paths.id)
      throw fail("CLOUD_OWNER_MISMATCH", "云端会话归属不一致");
    Object.assign(state, {
      id: paths.id,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      container_name: paths.name,
      leases: state.leases ?? {},
    });
    let container = await driver.inspect(paths.name);
    assertOwned(container, paths);
    if (
      !options.skipCleanup &&
      !["cancel-task", "release-task"].includes(input.operation)
    )
      await cleanLeases(state, container, driver, now, input, options);
    if (
      !options.skipAccess &&
      !["cancel-task", "release-task"].includes(input.operation)
    )
      container = await syncAccessLocked(input, {
        paths,
        state,
        container,
        driver,
      });
    const value = await operation({ paths, state, container, driver, now });
    await atomicJson(paths.file, state);
    return value;
  });
}
async function syncAccessLocked(input, { paths, state, container, driver }) {
  if (!Array.isArray(input.authorized_task_ids)) return container;
  const authorized = new Set(input.authorized_task_ids.map(validateTaskId));
  const restricted = new Set(
    (input.restricted_task_ids ?? []).map(validateTaskId),
  );
  for (const id of restricted) authorized.delete(id);
  const moves = [];
  for (const [sourceRoot, kind] of [
    [paths.tasks, "tasks"],
    [paths.workspaces, "workspaces"],
  ]) {
    const quarantine = join(paths.owner, "quarantine", kind);
    for (const [fromRoot, toRoot, restore] of [
      [sourceRoot, quarantine, false],
      [quarantine, sourceRoot, true],
    ]) {
      let entries;
      try {
        entries = await readdir(fromRoot, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (
          (!entry.isDirectory() && !entry.isSymbolicLink()) ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)
        )
          continue;
        if (restore !== authorized.has(entry.name)) continue;
        const source = join(fromRoot, entry.name),
          target = join(toRoot, entry.name);
        try {
          await lstat(target);
          throw fail(
            "CLOUD_ACCESS_CONFLICT",
            "会话权限同步存在重复目录，请管理员检查",
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        moves.push({ source, target });
      }
    }
  }
  if (!moves.length) return container;
  const busy =
    Object.keys(state.leases ?? {}).length > 0 ||
    (input.active_tasks ?? 0) > 0 ||
    (input.live_tasks ?? []).some(
      (task) =>
        task.tenant_id === input.tenant_id && task.user_id === input.user_id,
    );
  if (busy)
    throw fail(
      "CLOUD_SESSION_BUSY",
      "云端仍有任务执行，完成后才可同步资料权限",
    );
  if (container) {
    await driver.remove(paths.name);
    container = null;
  }
  for (const { source, target } of moves) {
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await rename(source, target);
  }
  state.access_updated_at = Date.now();
  return container;
}
async function connectLocked(input, options, ctx) {
  const { paths, state, driver, now } = ctx;
  let container = ctx.container;
  const engine = options.installation ?? (await containerEngine(paths.root));
  const engineVersion = (
    await readJson(join(engine, "node_modules/@deepseek-ai/dsh/package.json"))
  ).version;
  const spec = {
    engine,
    image: input.image ?? "node:22-bookworm-slim",
    uid: `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
  };
  const signature = digest(JSON.stringify(spec));
  const busy =
    Object.keys(state.leases).length > 0 || (input.active_tasks ?? 0) > 0;
  if (container?.State?.Running && state.signature !== signature && busy)
    throw fail(
      "CLOUD_SESSION_BUSY",
      "云端任务仍在执行，完成后才可更新执行环境",
    );
  if (
    container &&
    (!container.State.Running || state.signature !== signature)
  ) {
    if (busy)
      throw fail("CLOUD_SESSION_BUSY", "云端任务仍在执行，暂不能重建容器");
    await driver.remove(paths.name);
    container = null;
  }
  if (!container) {
    if (busy)
      throw fail("CLOUD_SESSION_BUSY", "仍有云端任务在执行，暂不能重建容器");
    await profile(paths.root, input.tenant_id, input.user_id);
    const owner = await openSafeDirectory(paths.owner, {
      trustedRoot: paths.root,
    });
    try {
      for (const name of ["tasks", "workspaces", "container-home"])
        await (await owner.child(name, { create: true })).close();
    } finally {
      await owner.close();
    }
    // Persist intended ownership/spec before create, allowing recovery after a
    // host process dies between Docker create and state commit.
    Object.assign(state, { ...spec, signature, engine_version: engineVersion });
    await atomicJson(paths.file, state);
    await driver.create(paths, spec);
    container = await driver.inspect(paths.name);
    assertOwned(container, paths);
    if (!container?.State?.Running)
      throw fail("CLOUD_START_FAILED", "云端执行容器未能启动");
    state.created_at = now;
  }
  Object.assign(state, { ...spec, signature, engine_version: engineVersion });
  touch(state, now);
  return { ...ctx, container };
}
export async function manageCloud(input, options = {}) {
  if (input.operation === "reap") {
    const root = resolve(input.root),
      protectedOwners = new Set(
        (input.live_owners ?? []).map((owner) =>
          basename(userHome(root, owner.tenant_id, owner.user_id)),
        ),
      );
    const report = { ok: true, reaped: [], skipped_active: [], errors: [] };
    let users;
    try {
      users = await readdir(join(root, "users"), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return report;
      throw error;
    }
    for (const user of users) {
      if (!user.isDirectory() || !/^[a-f0-9]{64}$/.test(user.name)) continue;
      const saved = await readJson(
        join(root, "users", user.name, "cloud/state.json"),
        null,
      );
      if (!saved) continue;
      try {
        const access = (input.task_access ?? []).find(
          (item) =>
            item.tenant_id === saved.tenant_id &&
            item.user_id === saved.user_id,
        );
        const value = await stateFor(
          {
            root,
            operation: "reap",
            tenant_id: saved.tenant_id,
            user_id: saved.user_id,
            live_tasks: input.live_tasks,
            fence_snapshot_at: input.fence_snapshot_at,
            ...(Array.isArray(input.task_access)
              ? {
                  authorized_task_ids: access?.authorized_task_ids ?? [],
                  restricted_task_ids: access?.restricted_task_ids ?? [],
                }
              : {}),
          },
          options,
          async ({ paths, state, container, driver, now }) => {
            if (paths.id !== user.name)
              throw fail("CLOUD_OWNER_MISMATCH", "云端会话归属校验失败");
            if (
              protectedOwners.has(paths.id) ||
              Object.keys(state.leases).length
            )
              return "active";
            if (container && (state.expires_at ?? 0) <= now) {
              await driver.remove(paths.name);
              state.disconnected_at = now;
              return "reaped";
            }
            return "idle";
          },
        );
        if (value === "active") report.skipped_active.push(user.name);
        if (value === "reaped") report.reaped.push(user.name);
      } catch (error) {
        report.errors.push({
          id: user.name,
          code: error.code ?? "CLOUD_ERROR",
          error: error.message,
        });
      }
    }
    return report;
  }
  if (
    ![
      "status",
      "connect",
      "heartbeat",
      "disconnect",
      "cancel-task",
      "release-task",
      "sync-access",
    ].includes(input.operation)
  )
    throw fail("CLOUD_INVALID_OPERATION", "云端会话操作无效");
  return stateFor(input, options, async (ctx) => {
    let { paths, state, container, driver, now } = ctx;
    if (["cancel-task", "release-task"].includes(input.operation)) {
      validateTaskId(input.task_id);
      const lease = state.leases[input.lease_token];
      if (lease && lease.task_id === input.task_id) {
        if (input.operation === "cancel-task" && container?.State?.Running)
          await driver.stop(paths.name, lease);
        else if (
          container?.State?.Running &&
          (await driver.probe(paths.name, lease))
        )
          throw fail("CLOUD_TASK_BUSY", "任务仍在执行，不能释放租约");
        delete state.leases[input.lease_token];
        touch(state, now);
      }
      return result(paths, state, container);
    }
    if (input.operation === "connect")
      ({ container } = await connectLocked(input, options, ctx));
    if (input.operation === "heartbeat" && container?.State?.Running)
      touch(state, now);
    if (input.operation === "disconnect") {
      if (Object.keys(state.leases).length || (input.active_tasks ?? 0) > 0)
        throw fail("CLOUD_SESSION_BUSY", "云端任务仍在执行，暂不能断开");
      if (container) await driver.remove(paths.name);
      container = null;
      state.disconnected_at = now;
    }
    return result(paths, state, container);
  });
}
export function validateTaskId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
    throw fail("CLOUD_INVALID_TASK", "云端任务标识无效");
  return id;
}
export async function taskDirectories(input) {
  const paths = cloudPaths(input),
    id = validateTaskId(input.task_id);
  const taskRoot = join(paths.tasks, id),
    home = join(taskRoot, "home"),
    workspace = join(paths.workspaces, id);
  await withCloudLock(paths, async () => {
    const ownerDirectory = await openSafeDirectory(paths.owner, {
      trustedRoot: paths.root,
      create: true,
    });
    let taskDirectory;
    try {
      for (const kind of ["tasks", "workspaces"]) {
        const targetParent = await ownerDirectory.child(kind, { create: true });
        try {
          let targetDirectory;
          try {
            targetDirectory = await targetParent.child(id);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            // Only Rust's exact authorized task may leave legacy storage.
            let legacyParent, legacyTask;
            try {
              legacyParent = await openSafeDirectory(join(paths.root, kind), {
                trustedRoot: paths.root,
              });
              legacyTask = await legacyParent.child(id);
              await legacyParent.moveTo(id, targetParent, id);
            } catch (legacyError) {
              if (legacyError.code !== "ENOENT") throw legacyError;
            } finally {
              await legacyTask?.close();
              await legacyParent?.close();
            }
            targetDirectory = await targetParent.child(id, { create: true });
          }
          if (kind === "tasks") taskDirectory = targetDirectory;
          else await targetDirectory.close();
        } finally {
          await targetParent.close();
        }
      }
      const owner = await taskDirectory.readJson("owner.json", {
        fallback: null,
      });
      if (owner && owner.id !== paths.id)
        throw fail("CLOUD_OWNER_MISMATCH", "任务会话归属不一致");
      await (await taskDirectory.child("home", { create: true })).close();
      await taskDirectory.writeJson("owner.json", {
        id: paths.id,
        task_id: id,
      });
    } finally {
      await taskDirectory?.close();
      await ownerDirectory.close();
    }
  }).catch((error) => {
    if (["ELOOP", "ENOTDIR", "HARNESS_UNSAFE_PATH"].includes(error.code))
      throw fail("CLOUD_INVALID_TASK", "任务目录不能是符号链接");
    throw error;
  });
  return {
    taskRoot,
    home,
    workspace,
    containerHome: `/harness/tasks/${id}/home`,
    containerWorkspace: `/workspace/tasks/${id}`,
  };
}
export async function acquireTask(input, options = {}) {
  validateTaskId(input.task_id);
  if (
    Array.isArray(input.authorized_task_ids) &&
    (!input.authorized_task_ids.includes(input.task_id) ||
      input.restricted_task_ids?.includes(input.task_id))
  )
    throw fail(
      "CLOUD_TASK_FORBIDDEN",
      "此任务资料权限已变更，不能恢复云端会话",
    );
  return stateFor(
    input,
    { ...options, cleanupTaskId: input.task_id },
    async (ctx) => {
      const connected = await connectLocked(input, options, ctx),
        { paths, state, now } = connected;
      if (
        Object.values(state.leases).some(
          (lease) => lease.task_id === input.task_id,
        )
      )
        throw fail("CLOUD_TASK_BUSY", "同一任务会话仍在执行，请稍后继续");
      const token = input.lease_token ?? randomUUID(),
        process_token = randomUUID();
      if (typeof token !== "string" || !token || token.length > 256)
        throw fail("CLOUD_INVALID_LEASE", "云端执行租约标识无效");
      if (state.leases[token])
        throw fail("CLOUD_INVALID_LEASE", "云端执行租约已被使用");
      state.leases[token] = {
        task_id: input.task_id,
        process_token,
        acquired_at: now,
        expires_at: now + TASK_LEASE_MS,
      };
      return {
        ...result(paths, state, connected.container),
        token,
        process_token,
        engine: state.engine,
      };
    },
  );
}
export async function renewTask(input, options = {}) {
  return stateFor(
    input,
    { ...options, skipCleanup: true, skipAccess: true },
    async ({ state, now }) => {
      if (!state.leases[input.token])
        throw fail("CLOUD_LEASE_LOST", "云端执行租约已失效");
      state.leases[input.token].expires_at = now + TASK_LEASE_MS;
      touch(state, now);
    },
  );
}
export async function releaseTask(input, options = {}) {
  return stateFor(
    input,
    { ...options, skipCleanup: true, skipAccess: true },
    async ({ state, now }) => {
      if (state.leases[input.token]) {
        delete state.leases[input.token];
        touch(state, now);
      }
    },
  );
}
if (process.argv[1]?.endsWith("harness-cloud.mjs")) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    try {
      process.stdout.write(
        JSON.stringify(await manageCloud(JSON.parse(line))) + "\n",
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          code: error.code ?? "CLOUD_ERROR",
          error: error.message,
        }) + "\n",
      );
    }
    break;
  }
  lines.close();
}
