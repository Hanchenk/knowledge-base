import { createRequire } from "node:module";
import {
  readFile,
  mkdir,
  cp,
  writeFile,
  rm,
  access,
  rename,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import {
  engine,
  engineModule,
  runtimeRoot,
  profile,
  setBundles,
  readJson,
  atomicJson,
  userHome,
  leafRowId,
  prepareLinux,
} from "./harness-profile.mjs";

async function inspect(input, target, name, anchor) {
  const metadata = await readJson(
    join(target.dir, "node_modules", name, "package.json"),
  );
  if (!metadata.dsh?.bundle)
    return {
      version: metadata.version,
      description: metadata.description ?? "",
      bundle: false,
      config_rows: [{ id: leafRowId(name), name }],
    };
  const { loadOverlayPatches, bundlePatchPaths, resolveBundleDir } =
    await engineModule(input.root, "@deepseek-ai/dsh-app-boot");
  const rows = [];
  const visit = (patches) => {
    for (const patch of patches) {
      if (patch.id && !rows.some((row) => row.id === patch.id))
        rows.push({ id: patch.id, name: patch.name ?? patch.id });
      if (patch.insert)
        visit(Array.isArray(patch.insert) ? patch.insert : [patch.insert]);
    }
  };
  for (const file of bundlePatchPaths(
    resolveBundleDir("dsh", name, anchor, target.dir),
    metadata.dsh.bundle,
  ))
    visit(loadOverlayPatches("dsh", file));
  return {
    version: metadata.version,
    description: metadata.description ?? "",
    bundle: true,
    config_rows: rows,
  };
}

export function validateSpec(source) {
  if (
    typeof source !== "string" ||
    source.length > 2048 ||
    /[\s\x00-\x1f]/.test(source) ||
    source.startsWith("-")
  )
    throw new Error("插件来源无效");
  if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[^\/\s]+)?$/.test(source))
    return source;
  if (
    /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9/_.-]+)?$/.test(
      source,
    )
  )
    return source;
  const url = new URL(source.replace(/^git\+/, ""));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)
  )
    throw new Error("仅支持npm包、GitHub或公开HTTPS归档");
  if (source.startsWith("git+") && url.hostname !== "github.com")
    throw new Error("Git插件请使用GitHub HTTPS来源");
  if (!source.startsWith("git+") && !/\.(tgz|tar\.gz)$/.test(url.pathname))
    throw new Error("归档插件需为.tgz或.tar.gz");
  return source;
}
async function runNode(bin, args, env, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    child.stderr.on(
      "data",
      (chunk) => (output = (output + chunk).slice(-4000)),
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(output || `包管理失败(${code})`)),
    );
  });
}
export async function manage(input) {
  if (input.operation === "status") return manageUnlocked(input);
  const { withFileLock } = await engineModule(
    input.root,
    "@deepseek-ai/dsh-atomic-write",
  );
  const lock =
    input.operation === "update"
      ? join(input.root, "update")
      : join(
          userHome(input.root, input.tenant_id, input.user_id),
          "operations",
        );
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  return withFileLock(lock, () => manageUnlocked(input), { waitMs: 120000 });
}
async function manageUnlocked(input) {
  const current = await engine(input.root);
  const require = createRequire(join(current, "package.json"));
  const installed = await readJson(
    require.resolve("@deepseek-ai/dsh/package.json"),
  );
  if (input.operation === "status")
    return { installed_version: installed.version };
  if (input.operation === "update") {
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.version))
      throw new Error("版本无效");
    // Releases already in use are immutable. Clicking sync twice must never
    // run npm against a directory currently mounted by a task container.
    if (installed.version === input.version)
      return { installed_version: installed.version };
    const release = join(input.root, "releases", input.version);
    let cached = false;
    try {
      await access(join(release, ".ready"));
      cached =
        (
          await readJson(
            join(release, "node_modules/@deepseek-ai/dsh/package.json"),
          )
        ).version === input.version;
    } catch {}
    const staging = join(
      input.root,
      "releases",
      `.${input.version}.${crypto.randomUUID()}.tmp`,
    );
    const candidate = cached ? release : staging;
    try {
      if (!cached) {
        await atomicJson(join(staging, "package.json"), {
          name: "zhixiaohui-harness-runtime",
          private: true,
          type: "module",
        });
        const npmBin = join(
          dirname(
            createRequire(join(runtimeRoot, "package.json")).resolve(
              "npm/package.json",
            ),
          ),
          "bin/npm-cli.js",
        );
        await runNode(
          npmBin,
          [
            "install",
            "--save-exact",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            `@deepseek-ai/dsh@${input.version}`,
            `@deepseek-ai/dsh-sdk-client@${input.version}`,
            "pnpm@11.7.0",
            "typebox@1.3.27",
            "js-yaml@4.2.0",
          ],
          { PATH: process.env.PATH },
          staging,
        );
        for (const name of [
          "harness-plugin.mjs",
          "harness-sdk-server.mjs",
          "harness-exec.mjs",
          "platform-tools.mjs",
        ])
          await cp(join(runtimeRoot, name), join(staging, name));
        await prepareLinux(staging);
      }
      const releaseRequire = createRequire(join(candidate, "package.json"));
      const { HarnessSdkJsonRpcServer } = await import(
        pathToFileURL(
          releaseRequire.resolve("@deepseek-ai/dsh-sdk-jsonrpc-server"),
        ).href
      );
      if (typeof HarnessSdkJsonRpcServer.prototype.createSession !== "function")
        throw new Error("新版本SDK持久会话协议不兼容，保留原运行时");
      if (!cached) {
        await writeFile(join(staging, ".ready"), input.version);
        await rm(release, { recursive: true, force: true });
        await rename(staging, release);
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await atomicJson(join(input.root, "active.json"), {
      version: input.version,
    });
    return { installed_version: input.version };
  }
  const target = await profile(input.root, input.tenant_id, input.user_id);
  // Install optional prebuilt packages for the container as well as the API
  // host. This applies to every third-party dependency, not a fixed addon list.
  await writeFile(
    join(target.dir, "pnpm-workspace.yaml"),
    "supportedArchitectures:\n  os: [current, linux]\n  cpu: [current]\n  libc: [current, glibc]\n",
    { mode: 0o600 },
  );
  const { runPluginCommand, bundleManifest } = await engineModule(
    input.root,
    "@deepseek-ai/dsh-plugin-manager",
    "/operations",
  );
  if (input.operation === "inspect")
    return inspect(
      input,
      target,
      input.name,
      require.resolve("@deepseek-ai/dsh/package.json"),
    );
  if (input.operation === "enable") {
    await setBundles(target, input.enabled_names);
    return { ok: true };
  }
  const source =
    input.operation === "install" ? validateSpec(input.source) : input.name;
  if (
    input.operation === "remove" &&
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(source)
  )
    throw new Error("插件名称无效");
  const before = await readJson(target.file);
  const pnpmBin = join(dirname(require.resolve("pnpm")), "bin/pnpm.mjs");
  const args = [
    input.operation === "remove" ? "remove" : "add",
    source,
    "--config.ignore-scripts=true",
  ];
  if (input.registry) args.push(`--registry=${input.registry}`);
  const result = await runPluginCommand(
    {
      profile: "sdk",
      dir: target.dir,
      home: target.home,
      installAnchor: require.resolve("@deepseek-ai/dsh/package.json"),
      cwd: target.dir,
    },
    args,
    {
      command: process.execPath,
      args: [pnpmBin],
      execution: "service",
      outputBytes: 4000,
      lockWaitMs: 30000,
      idleTimeoutMs: 120000,
      lookupTimeoutMs: 20000,
      activateNewBundles: false,
      env: {
        DSH_HOME: target.home,
        PNPM_HOME: join(target.home, "pnpm"),
        PATH: process.env.PATH,
      },
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      (result.incompatible?.length ? "插件与当前Harness版本不兼容。" : "") +
        (result.output || `安装失败：${result.kind || result.exitCode}`).slice(
          -1600,
        ),
    );
  const after = await readJson(target.file);
  if (input.operation === "remove") {
    await setBundles(
      target,
      input.enabled_names.filter((name) => name !== source),
    );
    return { ok: true };
  }
  const names = Object.keys(after.dependencies ?? {}).filter(
    (name) => before.dependencies?.[name] !== after.dependencies[name],
  );
  const name =
    input.name && after.dependencies[input.name]
      ? input.name
      : (names[0] ??
        Object.keys(after.dependencies ?? {}).find(
          (name) => source === name || source.startsWith(`${name}@`),
        ));
  if (!name) throw new Error("安装来源未产生可识别的插件");
  const packageMetadata = await readJson(
    join(target.dir, "node_modules", name, "package.json"),
  );
  if (
    !packageMetadata.dsh?.bundle &&
    !name.includes("dsh-") &&
    !packageMetadata.peerDependencies?.["@deepseek-ai/cordis"] &&
    !packageMetadata.dependencies?.["@deepseek-ai/cordis"]
  ) {
    await runPluginCommand(
      {
        profile: "sdk",
        dir: target.dir,
        home: target.home,
        installAnchor: require.resolve("@deepseek-ai/dsh/package.json"),
        cwd: target.dir,
      },
      ["remove", name, "--config.ignore-scripts=true"],
      {
        command: process.execPath,
        args: [pnpmBin],
        execution: "service",
        outputBytes: 1000,
      },
    );
    await atomicJson(target.file, before);
    throw new Error("该包没有DeepSeek Harness bundle或Cordis插件声明");
  }
  const metadata = await inspect(
    input,
    target,
    name,
    require.resolve("@deepseek-ai/dsh/package.json"),
  );
  await setBundles(target, [
    ...input.enabled_names.filter((v) => v !== name),
    name,
  ]);
  return {
    id: name,
    name,
    source: input.source,
    ...metadata,
    version: metadata.version ?? "unknown",
    description: metadata.description ?? "",
    installed: true,
    enabled: true,
    category: "扩展",
    homepage: packageMetadata.homepage,
    has_config: false,
  };
}
if (process.argv[1]?.endsWith("harness-manager.mjs")) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    process.stdout.write(
      JSON.stringify({ ok: true, data: await manage(JSON.parse(input)) }) +
        "\n",
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: String(error.message ?? error).slice(0, 2000),
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
