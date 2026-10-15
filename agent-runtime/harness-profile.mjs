import {
  readFile,
  mkdir,
  writeFile,
  rename,
  cp,
  access,
  open,
} from "node:fs/promises";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export const runtimeRoot = dirname(fileURLToPath(import.meta.url));
export const PINNED_VERSION = "0.2.0-rc.2";
export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const content = JSON.stringify(value, null, 2) + "\n";
  try {
    if ((await readFile(path, "utf8")) === content) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}
export function userHome(root, tenant, user) {
  if (!tenant || !user) throw new Error("Missing profile owner");
  const key = createHash("sha256").update(`${tenant}\0${user}`).digest("hex");
  return join(resolve(root), "users", key);
}
export async function engine(root) {
  const active = await readJson(join(root, "active.json"), {});
  if (
    active.version &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(active.version)
  ) {
    const path = join(resolve(root), "releases", active.version);
    await access(join(path, "node_modules/@deepseek-ai/dsh/package.json"));
    return path;
  }
  return runtimeRoot;
}
// Container and daemon share only this runtime volume, never the API checkout.
export async function prepareLinux(installation) {
  if (process.platform === "linux") return;
  const marker = join(installation, `.linux-${process.arch}-ready`);
  try {
    await access(marker);
    return;
  } catch {}
  const require = createRequire(join(runtimeRoot, "package.json"));
  const npmBin = join(
    dirname(require.resolve("npm/package.json")),
    "bin/npm-cli.js",
  );
  const dependencies = [];
  for (const name of [
    "node-addon-require-builtin",
    "@deepseek-ai/node-addon-system",
    "koffi",
    "@vscode/ripgrep",
    "sharp",
  ]) {
    const manifest = await readJson(
      join(installation, "node_modules", name, "package.json"),
      {},
    );
    for (const [optional, version] of Object.entries(
      manifest.optionalDependencies ?? {},
    )) {
      if (
        optional.includes("linux") &&
        optional.includes(process.arch) &&
        !optional.includes("musl")
      )
        dependencies.push(`${optional}@${version}`);
    }
  }
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        npmBin,
        "install",
        "--force",
        "--save-exact",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--os=linux",
        `--cpu=${process.arch}`,
        ...dependencies,
      ],
      { cwd: installation, env: { PATH: process.env.PATH }, stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("无法准备Linux Harness依赖")),
    );
  });
  await writeFile(marker, "ready");
}
export async function containerEngine(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await open(join(root, "prepare-engine.lock"), "a", 0o600);
  const deadline = Date.now() + 120_000;
  try {
    for (;;) {
      try {
        await tryLockExclusive(lock.fd);
        break;
      } catch (error) {
        if (!["EAGAIN", "EWOULDBLOCK"].includes(error.code)) throw error;
        if (Date.now() >= deadline)
          throw new Error("Harness引擎准备繁忙，请稍后重试");
        await new Promise((done) => setTimeout(done, 40));
      }
    }
    return await containerEngineUnlocked(root);
  } finally {
    await lock.close();
  }
}
async function containerEngineUnlocked(root) {
  const current = await engine(root);
  let target = current;
  if (current === runtimeRoot) {
    const manifest = await readJson(
      join(runtimeRoot, "node_modules/@deepseek-ai/dsh/package.json"),
    );
    target = join(resolve(root), "releases", manifest.version);
    try {
      await access(join(target, ".ready"));
    } catch {
      await mkdir(target, { recursive: true, mode: 0o700 });
      await cp(
        join(runtimeRoot, "node_modules"),
        join(target, "node_modules"),
        {
          recursive: true,
          verbatimSymlinks: true,
        },
      );
      for (const name of [
        "package.json",
        "harness-plugin.mjs",
        "harness-sdk-server.mjs",
        "harness-exec.mjs",
        "platform-tools.mjs",
      ]) {
        await cp(join(runtimeRoot, name), join(target, name));
      }
      await prepareLinux(target);
      await writeFile(join(target, ".ready"), manifest.version);
    }
  }
  await prepareLinux(target);
  // Application adapters follow the deployed application; model-loop packages
  // remain pinned. Each replacement is atomic for existing runtime readers.
  for (const name of [
    "harness-plugin.mjs",
    "harness-sdk-server.mjs",
    "harness-exec.mjs",
    "platform-tools.mjs",
  ]) {
    try {
      if (
        (await readFile(join(runtimeRoot, name))).equals(
          await readFile(join(target, name)),
        )
      )
        continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = join(target, `${name}.${crypto.randomUUID()}.tmp`);
    await cp(join(runtimeRoot, name), temporary);
    await rename(temporary, join(target, name));
  }
  return target;
}
export async function engineModule(root, name, suffix = "") {
  const installation = await engine(root);
  const require = createRequire(join(installation, "package.json"));
  return import(pathToFileURL(require.resolve(name + suffix)).href);
}
export async function profile(root, tenant, user) {
  const home = userHome(root, tenant, user);
  const dir = join(home, "profiles/sdk");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "package.json");
  const manifest = await readJson(file, {
    name: "zhixiaohui-cloud-profile",
    private: true,
    type: "module",
    dependencies: {},
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],
      },
    },
  });
  try {
    await writeFile(file, JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  try {
    await access(join(dir, "cordis.patch.yml"));
  } catch {
    await writeFile(join(dir, "cordis.patch.yml"), "[]\n", { mode: 0o600 });
  }
  return { home, dir, file, manifest };
}
export async function setBundles(target, enabled) {
  const manifest = await readJson(target.file);
  const bundles = [];
  for (const name of enabled) {
    const metadata = await readJson(
      join(target.dir, "node_modules", name, "package.json"),
      {},
    );
    if (metadata.dsh?.bundle) bundles.push(name);
  }
  manifest.dsh.profile.bundles = [
    ...new Set([
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-sdk-app",
      ...bundles,
    ]),
  ];
  await atomicJson(target.file, manifest);
}
export const leafRowId = (name) =>
  `plugin-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
