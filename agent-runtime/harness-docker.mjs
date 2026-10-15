// The SDK expects a Node CLI. A task gets an exec process in its user's
// persistent container; credentials are per-exec env, never Docker Config.Env.
import { spawn } from "node:child_process";
import { renewTask, releaseTask } from "./harness-cloud.mjs";

const settings = JSON.parse(process.env.ZXH_CONTAINER);
const record = `/harness/tasks/${settings.task_id}/run-${settings.process_token}.json`;
const args = ["exec", "-i"];
for (const key of ["DSH_API_KEY", "ZXH_BRIDGE_URL", "ZXH_BRIDGE_TOKEN"])
  args.push("-e", key);
for (const [key, value] of Object.entries({
  DSH_HOME: settings.home,
  HOME: settings.home,
  NARB_NATIVE_CACHE_DIR: `${settings.home}/native-cache`,
  ZXH_TASK_CONFIG: `${settings.home}/task-config.json`,
  ZXH_PROFILE_PATCH: settings.patch,
}))
  args.push("-e", `${key}=${value}`);
const boot =
  'for attempt in 1 2 3 4 5 6 7 8 9 10; do if test -f /engine/harness-exec.mjs && test -f "$ZXH_PROFILE_PATCH" && test -f "$ZXH_TASK_CONFIG"; then exec node /engine/harness-exec.mjs run "$@"; fi; sleep 0.2; done; echo "Harness task profile unavailable in shared volume" >&2; exit 1';
args.push(
  "-w",
  settings.workspace,
  settings.name,
  "sh",
  "-c",
  boot,
  "harness",
  record,
  settings.process_token,
  ...process.argv.slice(2),
);
const child = spawn("docker", args, {
  env: process.env,
  stdio: ["pipe", "inherit", "inherit"],
});
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
let stopping,
  renewing = false;
const heartbeat = setInterval(async () => {
  if (renewing || stopping) return;
  renewing = true;
  try {
    await renewTask(settings);
  } catch (error) {
    process.stderr.write(`Harness lease: ${error.message}\n`);
    void finish(1);
  } finally {
    renewing = false;
  }
}, 15000);
const stopProcess = () =>
  new Promise((done) => {
    const cleanup = spawn(
      "docker",
      [
        "exec",
        settings.name,
        "node",
        "/engine/harness-exec.mjs",
        "stop",
        record,
        settings.process_token,
      ],
      { env: process.env, stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      cleanup.kill("SIGKILL");
      done(false);
    }, 8000);
    cleanup.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
    cleanup.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
const finish = (code) =>
  (stopping ??= (async () => {
    clearInterval(heartbeat);
    const stopped = await stopProcess();
    // Failed cleanup leaves a lease for the reaper's real-process liveness probe.
    if (stopped) await releaseTask(settings).catch(() => {});
    child.kill("SIGTERM");
    process.exit(code);
  })());
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void finish(1);
  });
child.on("error", (error) => {
  process.stderr.write(`Harness sandbox: ${error.message}\n`);
  void finish(1);
});
child.on("exit", (code) => {
  void finish(code ?? 1);
});
