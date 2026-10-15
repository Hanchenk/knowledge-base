// Container-writable directories are never trusted host paths. Linux pins each
// parent inode through /proc/self/fd; Darwin uses openat through Python for the
// operations Node cannot express and verifies O_NOFOLLOW_ANY before use.
import { constants } from "node:fs";
import {
  open, realpath, lstat, mkdir, readdir, rename, unlink, symlink, readlink,
  mkdtemp, rm,
} from "node:fs/promises";
import { dirname, basename, join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const DARWIN_NOFOLLOW_ANY = 0x20000000;
const DEFAULT_LIMIT = 1_048_576;
const unsupported = () => Object.assign(new Error("Safe Harness filesystem operations are unavailable"), { code: "HARNESS_SAFE_FS_UNAVAILABLE" });
const unsafe = (message) => Object.assign(new Error(message), { code: "HARNESS_UNSAFE_PATH" });
function leaf(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0"))
    throw unsafe("Harness filesystem entries must be single path components");
  return name;
}
function limitValue(limit = DEFAULT_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 30_000_000)
    throw unsafe("Harness file read limit is invalid");
  return limit;
}
let darwinVerification;
async function verifyPlatform() {
  if (process.platform === "linux") return;
  if (process.platform !== "darwin") throw unsupported();
  darwinVerification ??= (async () => {
    const path = await mkdtemp(join(await realpath(tmpdir()), "harness-nofollow-"));
    try {
      await mkdir(join(path, "real"));
      await mkdir(join(path, "real", "leaf"));
      await symlink("real", join(path, "alias"));
      let handle;
      try {
        handle = await open(join(path, "alias", "leaf"), constants.O_RDONLY | constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY);
      } catch (error) {
        if (error.code === "ELOOP") return;
        throw unsupported();
      } finally { await handle?.close(); }
      throw unsupported();
    } finally { await rm(path, { recursive: true, force: true }); }
  })();
  return darwinVerification;
}
const flags = (value) => value | (process.platform === "darwin" ? DARWIN_NOFOLLOW_ANY : constants.O_NOFOLLOW);
const PYTHON = String.raw`
import os, sys, json, stat, base64, errno
try:
    p=json.load(sys.stdin); op=p['operation']; name=p.get('name'); fd=3
    def info(name):
        s=os.stat(name,dir_fd=fd,follow_symlinks=False)
        return {'dev':str(s.st_dev),'ino':str(s.st_ino),'size':s.st_size,'directory':stat.S_ISDIR(s.st_mode),'file':stat.S_ISREG(s.st_mode),'symlink':stat.S_ISLNK(s.st_mode)}
    result=None
    if op=='mkdir':
        try: os.mkdir(name,p.get('mode',448),dir_fd=fd)
        except FileExistsError: pass
        result=info(name)
    elif op=='stat': result=info(name)
    elif op=='entries':
        result=[{'name':e.name,'directory':e.is_dir(follow_symlinks=False),'file':e.is_file(follow_symlinks=False),'symlink':e.is_symlink()} for e in os.scandir(fd)]
    elif op=='read':
        f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            s=os.fstat(f)
            if not stat.S_ISREG(s.st_mode): raise OSError(errno.EINVAL,'Expected a regular file')
            if s.st_size>p['limit']: raise OSError(errno.EFBIG,'Harness file exceeds the read limit')
            data=b''
            while len(data)<=p['limit']:
                chunk=os.read(f,min(65536,p['limit']+1-len(data)))
                if not chunk: break
                data+=chunk
            if len(data)>p['limit']: raise OSError(errno.EFBIG,'Harness file exceeds the read limit')
            result=base64.b64encode(data).decode('ascii')
        finally: os.close(f)
    elif op=='write':
        temp=p['temporary']; f=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,p.get('mode',384),dir_fd=fd)
        try:
            data=base64.b64decode(p['data']); position=0
            while position<len(data): position+=os.write(f,data[position:])
            os.fsync(f)
        finally: os.close(f)
        try: os.rename(temp,name,src_dir_fd=fd,dst_dir_fd=fd)
        finally:
            try: os.unlink(temp,dir_fd=fd)
            except FileNotFoundError: pass
    elif op=='symlink':
        try: os.symlink(p['target'],name,dir_fd=fd)
        except FileExistsError:
            if os.readlink(name,dir_fd=fd)!=p['target']: raise OSError(errno.EEXIST,'Unexpected existing symlink')
    elif op=='remove':
        try: os.unlink(name,dir_fd=fd)
        except FileNotFoundError: pass
    elif op=='move':
        if not p.get('replace',False):
            try: os.stat(p['target'],dir_fd=4,follow_symlinks=False)
            except FileNotFoundError: pass
            else: raise OSError(errno.EEXIST,'Destination exists')
        os.rename(name,p['target'],src_dir_fd=fd,dst_dir_fd=4)
    else: raise OSError(errno.EINVAL,'Unknown safe filesystem operation')
    print(json.dumps({'ok':True,'value':result}))
except OSError as e:
    print(json.dumps({'ok':False,'code':errno.errorcode.get(e.errno,'EIO'),'error':str(e)}))
except Exception:
    print(json.dumps({'ok':False,'code':'HARNESS_SAFE_FS_UNAVAILABLE','error':'Safe filesystem helper failed'}))
`;
async function darwin(directory, operation, input = {}, destination) {
  const child = spawn("/usr/bin/python3", ["-c", PYTHON], {
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["pipe", "pipe", "pipe", directory.handle.fd, ...(destination ? [destination.handle.fd] : [])],
  });
  const cap = operation === "read" ? Math.ceil(input.limit * 1.4) + 4096 : 4_000_000;
  let output = [], length = 0;
  child.stdout.on("data", (chunk) => {
    length += chunk.length;
    if (length > cap) child.kill("SIGKILL");
    else output.push(chunk);
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ operation, ...input }));
  let timer;
  const code = await new Promise((done, reject) => {
    timer = setTimeout(() => { child.kill("SIGKILL"); reject(unsupported()); }, 30_000);
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  if (code !== 0 || length > cap) throw unsupported();
  let result;
  try { result = JSON.parse(Buffer.concat(output).toString("utf8")); }
  catch { throw unsupported(); }
  if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
  return result.value;
}

export class SafeDirectory {
  constructor(path, handle) {
    this.path = path;
    this.canonicalPath = path;
    this.handle = handle;
    this.closed = false;
  }
  anchor(name) {
    if (this.closed) throw unsafe("Harness directory handle is closed");
    return join(`/proc/self/fd/${this.handle.fd}`, leaf(name));
  }
  async child(name, { create = false, mode = 0o700 } = {}) {
    leaf(name);
    if (this.closed) throw unsafe("Harness directory handle is closed");
    const path = join(this.path, name);
    if (process.platform === "linux") {
      const anchor = this.anchor(name);
      if (create) {
        try { await mkdir(anchor, { mode }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      return new SafeDirectory(path, await open(anchor, flags(constants.O_RDONLY | constants.O_DIRECTORY)));
    }
    const expected = await darwin(this, create ? "mkdir" : "stat", { name, mode });
    if (!expected.directory || expected.symlink) throw unsafe("Harness directory is a symbolic link or is not a directory");
    const handle = await open(path, flags(constants.O_RDONLY | constants.O_DIRECTORY));
    const actual = await handle.stat({ bigint: true });
    if (actual.dev.toString() !== expected.dev || actual.ino.toString() !== expected.ino) {
      await handle.close();
      throw unsafe("Harness directory changed while being opened");
    }
    return new SafeDirectory(path, handle);
  }
  async entries() {
    if (this.closed) throw unsafe("Harness directory handle is closed");
    if (process.platform === "linux") return readdir(`/proc/self/fd/${this.handle.fd}`, { withFileTypes: true });
    return (await darwin(this, "entries")).map((entry) => ({
      name: entry.name,
      isDirectory: () => entry.directory,
      isFile: () => entry.file,
      isSymbolicLink: () => entry.symlink,
    }));
  }
  async readFile(name, { limit = DEFAULT_LIMIT } = {}) {
    leaf(name); limit = limitValue(limit);
    if (this.closed) throw unsafe("Harness directory handle is closed");
    if (process.platform === "darwin") return Buffer.from(await darwin(this, "read", { name, limit }), "base64");
    const file = await open(this.anchor(name), flags(constants.O_RDONLY | constants.O_NONBLOCK));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw unsafe("Harness input must be a regular file");
      if (info.size > limit) throw Object.assign(new Error("Harness file exceeds the read limit"), { code: "EFBIG" });
      const chunks = []; let total = 0;
      while (total <= limit) {
        const buffer = Buffer.alloc(Math.min(65_536, limit + 1 - total));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        chunks.push(buffer.subarray(0, bytesRead)); total += bytesRead;
      }
      if (total > limit) throw Object.assign(new Error("Harness file exceeds the read limit"), { code: "EFBIG" });
      return Buffer.concat(chunks, total);
    } finally { await file.close(); }
  }
  async readJson(name, { fallback, limit = DEFAULT_LIMIT } = {}) {
    try { return JSON.parse((await this.readFile(name, { limit })).toString("utf8")); }
    catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
  }
  async writeFile(name, data, { mode = 0o600 } = {}) {
    leaf(name);
    if (this.closed) throw unsafe("Harness directory handle is closed");
    const temporary = `.${name}.${randomUUID()}.tmp`;
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    if (process.platform === "darwin") return darwin(this, "write", { name, temporary, data: bytes.toString("base64"), mode });
    const file = await open(this.anchor(temporary), flags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL), mode);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    try { await rename(this.anchor(temporary), this.anchor(name)); }
    finally { await unlink(this.anchor(temporary)).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  async writeJson(name, value) { return this.writeFile(name, JSON.stringify(value, null, 2) + "\n"); }
  async symlink(name, target) {
    leaf(name);
    if (typeof target !== "string" || target.includes("\0")) throw unsafe("Harness symlink target is invalid");
    if (this.closed) throw unsafe("Harness directory handle is closed");
    if (process.platform === "darwin") return darwin(this, "symlink", { name, target });
    try { await symlink(target, this.anchor(name)); }
    catch (error) {
      if (error.code !== "EEXIST" || await readlink(this.anchor(name)) !== target) throw error;
    }
  }
  async remove(name) {
    leaf(name);
    if (this.closed) throw unsafe("Harness directory handle is closed");
    if (process.platform === "darwin") return darwin(this, "remove", { name });
    try { await unlink(this.anchor(name)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  async moveTo(name, destination, target = name, { replace = false } = {}) {
    leaf(name); leaf(target);
    if (!(destination instanceof SafeDirectory) || this.closed || destination.closed) throw unsafe("Harness move requires open safe directory handles");
    if (process.platform === "darwin") return darwin(this, "move", { name, target, replace }, destination);
    if (!replace) {
      try { await lstat(destination.anchor(target)); }
      catch (error) { if (error.code === "ENOENT") return rename(this.anchor(name), destination.anchor(target)); throw error; }
      throw Object.assign(new Error("Harness move destination already exists"), { code: "EEXIST" });
    }
    return rename(this.anchor(name), destination.anchor(target));
  }
  async close() {
    if (!this.closed) { this.closed = true; await this.handle.close(); }
  }
}

export async function openSafeDirectory(path, { create = false, trustedRoot } = {}) {
  await verifyPlatform();
  const absolute = resolve(path);
  if (trustedRoot !== undefined) {
    const root = resolve(trustedRoot), part = relative(root, absolute);
    if (isAbsolute(part) || part === ".." || part.startsWith("../")) throw unsafe("Harness directory escapes its trusted owner root");
    let directory = await openSafeDirectory(root);
    try {
      for (const name of part.split("/").filter(Boolean)) {
        const child = await directory.child(name, { create });
        await directory.close(); directory = child;
      }
      return directory;
    } catch (error) { await directory.close(); throw error; }
  }
  // The caller supplies a trusted root that is outside the container's mounts.
  // Resolve OS-owned aliases such as /var -> /private/var, never a final symlink.
  const canonical = join(await realpath(dirname(absolute)), basename(absolute));
  if (create) {
    try { await mkdir(canonical, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const handle = await open(canonical, flags(constants.O_RDONLY | constants.O_DIRECTORY));
  return new SafeDirectory(canonical, handle);
}
