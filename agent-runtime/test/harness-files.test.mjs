import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSafeDirectory } from "../harness-files.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "harness-files-test-"));
  const owner = join(root, "owner"), victim = join(root, "other-user");
  await mkdir(owner); await mkdir(victim);
  try { await run({ root, owner, victim }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const rejected = (error) => ["ELOOP", "ENOTDIR", "HARNESS_UNSAFE_PATH"].includes(error.code);

test("root, parent, and final symlinks cannot read another account's files", async () => fixture(async ({ owner, victim }) => {
  await writeFile(join(victim, "secret.md"), "other account secret");
  await symlink(victim, join(owner, "workspace"));
  await assert.rejects(openSafeDirectory(join(owner, "workspace"), { trustedRoot: owner }), rejected);
  await assert.rejects(openSafeDirectory(join(owner, "workspace", "new-child"), { trustedRoot: owner, create: true }), rejected);
  await assert.rejects(lstat(join(victim, "new-child")), { code: "ENOENT" });
  const directory = await openSafeDirectory(owner);
  try {
    await symlink(join(victim, "secret.md"), join(owner, "export.md"));
    await assert.rejects(directory.readFile("export.md"), rejected);
    await directory.writeFile("export.md", "own replacement");
    assert.equal(await readFile(join(victim, "secret.md"), "utf8"), "other account secret");
    assert.equal((await directory.readFile("export.md")).toString(), "own replacement");
  } finally { await directory.close(); }
}));

test("swapping a checked parent for a symlink cannot redirect reads or atomic writes", async () => fixture(async ({ owner, victim }) => {
  await mkdir(join(owner, "task"));
  await writeFile(join(owner, "task", "existing.md"), "own data");
  await writeFile(join(victim, "existing.md"), "victim data");
  const parent = await openSafeDirectory(owner);
  const task = await parent.child("task");
  try {
    await rename(join(owner, "task"), join(owner, "pinned-task"));
    await symlink(victim, join(owner, "task"));
    assert.equal((await task.readFile("existing.md")).toString(), "own data");
    await task.writeJson("result.json", { private: "own result" });
    assert.deepEqual(JSON.parse(await readFile(join(owner, "pinned-task", "result.json"), "utf8")), { private: "own result" });
    await assert.rejects(lstat(join(victim, "result.json")), { code: "ENOENT" });
    assert.equal(await readFile(join(victim, "existing.md"), "utf8"), "victim data");
    const entries = await task.entries();
    assert.ok(entries.some((entry) => entry.name === "result.json" && entry.isFile()));
  } finally { await task.close(); await parent.close(); }
}));

test("reads stay bounded and refuse directories and escaping path components", async () => fixture(async ({ owner }) => {
  await writeFile(join(owner, "large.md"), Buffer.alloc(1000));
  await mkdir(join(owner, "directory.md"));
  const directory = await openSafeDirectory(owner);
  try {
    await assert.rejects(directory.readFile("large.md", { limit: 999 }), { code: "EFBIG" });
    assert.equal((await directory.readFile("large.md", { limit: 1000 })).length, 1000);
    await assert.rejects(directory.readFile("directory.md"));
    for (const name of ["..", "../secret.md", "nested/secret.md", "bad\0name"]) {
      await assert.rejects(directory.readFile(name), { code: "HARNESS_UNSAFE_PATH" });
      await assert.rejects(directory.writeFile(name, "must not write"), { code: "HARNESS_UNSAFE_PATH" });
    }
    assert.deepEqual(await directory.readJson("missing.json", { fallback: { empty: true } }), { empty: true });
  } finally { await directory.close(); }
}));

test("migration and deletion stay bound to pinned directories after a parent swap", async () => fixture(async ({ owner, victim }) => {
  await mkdir(join(owner, "source")); await mkdir(join(owner, "destination"));
  await writeFile(join(owner, "source", "saved.md"), "persistent history");
  await writeFile(join(victim, "saved.md"), "victim history");
  const directory = await openSafeDirectory(owner);
  const source = await directory.child("source"), destination = await directory.child("destination");
  try {
    await rename(join(owner, "source"), join(owner, "pinned-source"));
    await symlink(victim, join(owner, "source"));
    await source.moveTo("saved.md", destination, "saved.md");
    assert.equal((await destination.readFile("saved.md")).toString(), "persistent history");
    assert.equal(await readFile(join(victim, "saved.md"), "utf8"), "victim history");
    await destination.remove("saved.md"); await destination.remove("saved.md");
    assert.equal(await readFile(join(victim, "saved.md"), "utf8"), "victim history");
    await destination.symlink("node_modules", "/installed/node_modules");
    await destination.symlink("node_modules", "/installed/node_modules");
    await assert.rejects(destination.symlink("node_modules", "/unexpected"), { code: "EEXIST" });
  } finally { await source.close(); await destination.close(); await directory.close(); }
}));
