// Runs one SDK process group inside a persistent user container. The record is
// for cancellation/liveness only and contains no model or bridge credentials.
import { spawn } from "node:child_process";
import { readFile, writeFile, rm, access } from "node:fs/promises";

async function processStamp(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : fields[19];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function readRecord(path, token) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value.token === token && Number.isInteger(value.pid) && value.pid > 1
      ? value
      : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function live(record) {
  return !!record && (await processStamp(record.pid)) === record.started;
}
const signalGroup = (pid, signal) => {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const [operation, path, token, ...args] = process.argv.slice(2);
const cancelledPath = `${path}.cancelled`;
const isCancelled = async () => {
  try {
    await access(cancelledPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
if (operation === "probe") {
  process.stdout.write(
    JSON.stringify({ running: await live(await readRecord(path, token)) }) +
      "\n",
  );
} else if (operation === "stop") {
  // Also fences a cancellation arriving before the new exec writes its PID.
  await writeFile(cancelledPath, "cancelled\n", { mode: 0o600 });
  const record = await readRecord(path, token);
  if (await live(record)) {
    signalGroup(record.pid, "SIGTERM");
    for (let n = 0; n < 20 && (await live(record)); n++)
      await new Promise((done) => setTimeout(done, 100));
    if (await live(record)) signalGroup(record.pid, "SIGKILL");
  }
  if (record) await rm(path, { force: true });
} else if (operation === "run") {
  if (await isCancelled())
    throw new Error("Harness task was cancelled before startup");
  const child = spawn(
    process.execPath,
    ["/engine/node_modules/@deepseek-ai/dsh/lib/bin.js", ...args],
    {
      env: process.env,
      detached: true,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  let stopping, timer;
  const completion = new Promise((done, reject) => {
    child.once("exit", (code) => done(code ?? 1));
    child.once("error", reject);
  });
  // Startup filesystem work may fail before this promise is awaited.
  completion.catch(() => {});
  const stop = () => {
    if (stopping) return;
    stopping = true;
    signalGroup(child.pid, "SIGTERM");
    timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), 2000);
  };
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
  // A crashed Docker CLI closes its pipe. Flush DSH, then stop this group only.
  process.stdin.on("end", () => {
    timer ??= setTimeout(stop, 8000);
  });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const started = await processStamp(child.pid);
    if (!started) throw new Error("Harness task process did not start");
    await writeFile(
      path,
      JSON.stringify({ token, pid: child.pid, started }) + "\n",
      { mode: 0o600 },
    );
    if (await isCancelled()) stop();
    process.exitCode = await completion;
  } finally {
    clearTimeout(timer);
    signalGroup(child.pid, "SIGKILL");
    await rm(path, { force: true });
  }
  process.exit(process.exitCode ?? 1);
} else throw new Error("Invalid Harness exec operation");
