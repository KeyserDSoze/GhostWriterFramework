import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CloudflareTunnelManager, TUNNEL_ERRORS, Vault, buildCloudflaredEnvironment, parseCloudflaredVersion, processAlive, processIdentity, startNarrariumServer } from "../dist/testing.mjs";
import { adminLogin, noRelease, until } from "./helpers.mjs";

const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0LXZhbHVlLTEyMzQ1In0=";
const OTHER_TOKEN = "eyJhIjoib3RoZXIiLCJ0IjoidHVubmVsIiwicyI6Im90aGVyLXNlY3JldC02Nzg5MCJ9";
const posix = process.platform !== "win32";
const testing = new URL("../dist/testing.mjs", import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));

/** The processes of a pretend operating system: who is running (and since when), and who may be stopped. */
function fakeSystem() {
  const table = new Map();
  const kills = [];
  return {
    table,
    kills,
    identify: async (pid) => {
      const entry = table.get(pid);
      return entry?.alive ? { start: entry.start, name: entry.name, command: entry.command ?? "" } : undefined;
    },
    kill: (pid, signal) => {
      kills.push({ pid, signal });
      const entry = table.get(pid);
      if (!entry?.alive) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      if (entry.refuse) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      entry.alive = false;
    },
  };
}

/** A fake `cloudflared`: `--version` prints the version, `tunnel run` stays up until killed. The children are entered in `system`. */
function fakeCloudflared({ system, version = "2025.6.1", firstPid = 40_000 } = {}) {
  const calls = [];
  const running = [];
  let nextPid = firstPid;
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid += 1;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = Object.assign(new EventEmitter(), { resume() {} });
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    child.signals = [];
    child.finish = (code, signal = null) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (signal) child.signalCode = signal;
      else child.exitCode = code ?? 0;
      const entry = system?.table.get(child.pid);
      if (entry) entry.alive = false;
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    };
    child.kill = (signal) => {
      child.signals.push(signal);
      setImmediate(() => child.finish(null, signal));
      return true;
    };
    calls.push({ command, args: [...args], options });
    if (args[0] === "--version") {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`cloudflared version ${version} (built 2025-06-01-1200 UTC)\n`));
        child.finish(0);
      });
    } else {
      running.push(child);
      system?.table.set(child.pid, { start: `boot:${child.pid}`, name: "cloudflared", alive: true });
    }
    return child;
  };
  return { spawn, calls, running };
}

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-tunnel-hardening-"));
  await mkdir(path.join(root, "private"), { recursive: true, mode: 0o700 });
  return root;
}

function newManager(root, fake, system, extra = {}) {
  return new CloudflareTunnelManager({
    root,
    findBinary: () => "/opt/cloudflared/bin/cloudflared",
    spawn: fake.spawn,
    detectOtherConnectors: async () => [],
    ...(system ? { identify: system.identify, kill: system.kill } : {}),
    ...extra,
  });
}

/** One vault for all the tests that do not look at the vault itself: opening one costs a PowerShell run on Windows. */
let sharedVault;
async function theSharedVault() {
  sharedVault ??= (async () => {
    const root = await makeRoot();
    const vault = await Vault.open(root);
    await remove(root);
    return vault;
  })();
  return sharedVault;
}

async function withTunnel(run, options = {}) {
  const root = await makeRoot();
  const system = fakeSystem();
  const fake = fakeCloudflared({ system, ...options });
  const vault = await theSharedVault();
  const managers = [];
  const make = (extra) => {
    const manager = newManager(root, fake, system, { vault, ...extra });
    managers.push(manager);
    return manager;
  };
  try {
    await run({ root, system, fake, make, vault });
  } finally {
    for (const manager of managers) await manager.close().catch(() => undefined);
    await remove(root);
  }
}

/** Every file under a folder, with its text. */
async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else if (entry.isFile()) found.push({ file: full, text: await readFile(full, "latin1") });
  }
  return found;
}

const forms = (token) => [token, Buffer.from(token).toString("base64"), JSON.stringify(token).slice(1, -1), Buffer.from(token).toString("hex")];

const run = (fake) => fake.calls.find((call) => call.args[0] === "tunnel");

// ---------------------------------------------------------------------------------------------
// C17c: the connector token lives in the vault, never in clear text
// ---------------------------------------------------------------------------------------------

test("C17: the connector token is stored encrypted in the vault, and no file of the data folder holds it in clear", async () => {
  await withTunnel(async ({ root, make, fake, vault }) => {
    const manager = make();
    await manager.configure({ token: TOKEN, hostname: "https://books.example.com" });
    await manager.start();
    assert.equal((await manager.status()).process, "running");
    for (const { file, text } of await filesUnder(root)) {
      for (const form of forms(TOKEN)) assert.equal(text.includes(form), false, `${path.relative(root, file)} holds the token`);
    }
    await assert.rejects(() => stat(path.join(root, "private", "cloudflare-tunnel-token")), { code: "ENOENT" }, "no clear-text token file");
    const secret = path.join(root, "private", "cloudflare-tunnel-token.json");
    const stored = JSON.parse(await readFile(secret, "utf8"));
    assert.equal(stored.version, 1);
    assert.deepEqual(Object.keys(stored.encrypted).sort(), ["data", "iv"], "the vault's own format");
    if (posix) assert.equal((await stat(secret)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(manager.status()).includes(TOKEN), false);
    // Only the vault decrypts it.
    assert.equal(vault.decrypt(stored.encrypted), TOKEN);
    assert.ok(run(fake));
  });
});

test("C17: cloudflared gets the token in its environment, never on its command line, and nothing else secret of ours", async () => {
  const saved = { TUNNEL_TOKEN: process.env.TUNNEL_TOKEN, TUNNEL_TOKEN_FILE: process.env.TUNNEL_TOKEN_FILE, OPENAI_API_KEY: process.env.OPENAI_API_KEY, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  Object.assign(process.env, { TUNNEL_TOKEN: "from-the-owners-shell", TUNNEL_TOKEN_FILE: "/from/the/owners/shell", OPENAI_API_KEY: "sk-owner", GITHUB_TOKEN: "ghp_owner" });
  try {
    await withTunnel(async ({ root, make, fake }) => {
      const manager = make();
      await manager.configure({ token: TOKEN });
      await manager.start();
      const started = run(fake);
      assert.deepEqual(started.args, ["tunnel", "--no-autoupdate", "run"], "no token and no token file on the command line; the flags of `tunnel` come before `run`, where cloudflared reads them");
      assert.equal(started.options.env.TUNNEL_TOKEN, TOKEN, "the connector token, not the one of the owner's shell");
      assert.equal(started.options.env.TUNNEL_TOKEN_FILE, undefined);
      assert.equal(started.options.env.OPENAI_API_KEY, undefined);
      assert.equal(started.options.env.GITHUB_TOKEN, undefined);
      assert.equal(started.options.shell, false);
      assert.equal(started.options.env.HOME, path.join(root, "private", "cloudflared-home"));
      for (const probe of fake.calls.filter((call) => call.args[0] === "--version")) {
        assert.equal(JSON.stringify(probe.options.env).includes(TOKEN), false, "the version probe never sees it");
        assert.equal(probe.options.env.TUNNEL_TOKEN, undefined);
      }
      assert.equal(JSON.stringify(fake.calls.map((call) => call.args)).includes(TOKEN), false);
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("C17: a clear-text token file written by an earlier version is moved into the vault when it is loaded, and keeps working", async () => {
  await withTunnel(async ({ root, make, fake }) => {
    const legacy = path.join(root, "private", "cloudflare-tunnel-token");
    await writeFile(legacy, TOKEN, { mode: 0o600 });
    await writeFile(path.join(root, "private", "cloudflare-tunnel.json"), JSON.stringify({ version: 1, enabled: true, hostname: "https://books.example.com" }));
    const first = make();
    const status = await first.start();
    assert.equal(status.process, "running", JSON.stringify(status));
    assert.equal(status.configured, true);
    assert.equal(run(fake).options.env.TUNNEL_TOKEN, TOKEN, "the migrated token is the one that runs");
    await assert.rejects(() => stat(legacy), { code: "ENOENT" }, "the clear-text file is gone");
    for (const { file, text } of await filesUnder(root)) for (const form of forms(TOKEN)) assert.equal(text.includes(form), false, `${path.relative(root, file)} holds the token`);
    await first.close();
    // The next start of the server finds only the vault's copy, and it works.
    const second = make();
    assert.equal((await second.start()).process, "running");
    assert.equal(fake.calls.filter((call) => call.args[0] === "tunnel").at(-1).options.env.TUNNEL_TOKEN, TOKEN);
  });
});

test("C17: when both a clear file and the vault's copy exist, the clear one is the newer (an older server wrote it) and replaces it", async () => {
  await withTunnel(async ({ root, make, fake }) => {
    const first = make();
    await first.configure({ token: TOKEN });
    await first.close();
    await writeFile(path.join(root, "private", "cloudflare-tunnel-token"), OTHER_TOKEN, { mode: 0o600 });
    const second = make();
    assert.equal((await second.start()).process, "running");
    assert.equal(run(fake).options.env.TUNNEL_TOKEN, OTHER_TOKEN);
    await assert.rejects(() => stat(path.join(root, "private", "cloudflare-tunnel-token")), { code: "ENOENT" });
    await second.close();
    assert.equal((await make().start()).process, "running");
    assert.equal(fake.calls.filter((call) => call.args[0] === "tunnel").at(-1).options.env.TUNNEL_TOKEN, OTHER_TOKEN, "and the vault keeps the newer one");
  });
});

test("C17: a clear file that is not private or not a regular file is refused, and left where it is (nothing is migrated or deleted)", async (t) => {
  if (!posix) return t.skip("modes and links are checked on POSIX systems");
  await withTunnel(async ({ root, make, fake }) => {
    const legacy = path.join(root, "private", "cloudflare-tunnel-token");
    await writeFile(path.join(root, "private", "cloudflare-tunnel.json"), JSON.stringify({ version: 1, enabled: true }));
    await writeFile(legacy, TOKEN, { mode: 0o644 });
    await chmod(legacy, 0o644);
    const loose = await make().start();
    assert.equal(loose.lastErrorCode, "invalid_token");
    assert.equal(fake.running.length, 0);
    assert.equal(await readFile(legacy, "utf8"), TOKEN, "not touched");
    await assert.rejects(() => stat(path.join(root, "private", "cloudflare-tunnel-token.json")), { code: "ENOENT" }, "and not copied");
    await rm(legacy);
    const target = path.join(root, "elsewhere");
    await writeFile(target, TOKEN, { mode: 0o600 });
    await symlink(target, legacy);
    const linked = await make().start();
    assert.equal(linked.lastErrorCode, "invalid_token");
    assert.equal((await lstat(legacy)).isSymbolicLink(), true);
    assert.equal(fake.running.length, 0);
  });
});

test("C17: a vault copy that cannot be decrypted stops the connector with an invalid-token error and is never destroyed", async () => {
  await withTunnel(async ({ root, make, fake }) => {
    const first = make();
    await first.configure({ token: TOKEN });
    await first.close();
    const secret = path.join(root, "private", "cloudflare-tunnel-token.json");
    const stored = JSON.parse(await readFile(secret, "utf8"));
    stored.encrypted.data = `${stored.encrypted.data.slice(0, 4)}${stored.encrypted.data[4] === "A" ? "B" : "A"}${stored.encrypted.data.slice(5)}`;
    await writeFile(secret, JSON.stringify(stored));
    const status = await make().start();
    assert.equal(status.process, "failed");
    assert.equal(status.lastErrorCode, "invalid_token");
    assert.equal(status.lastError, TUNNEL_ERRORS.invalid_token);
    assert.equal(fake.running.length, 0);
    assert.equal(JSON.parse(await readFile(secret, "utf8")).encrypted.data, stored.encrypted.data, "the file is as it was");
  });
});

test("C17: removing the connector removes the vault copy, and a token that is refused is never echoed in an error", async () => {
  await withTunnel(async ({ root, make }) => {
    const manager = make();
    await manager.configure({ token: TOKEN });
    await manager.remove();
    for (const name of ["cloudflare-tunnel-token", "cloudflare-tunnel-token.json", "cloudflare-tunnel.json", "cloudflared-process.json"]) await assert.rejects(() => stat(path.join(root, "private", name)), { code: "ENOENT" }, name);
    const bad = `${TOKEN}\nsecond line`;
    await assert.rejects(() => manager.configure({ token: bad }), (error) => !error.message.includes(TOKEN) && !error.message.includes("second line"));
    for (const message of Object.values(TUNNEL_ERRORS)) assert.equal(message.includes(TOKEN), false);
  });
});

test("C17: the environment built for cloudflared is made from scratch (it is not the parent's)", () => {
  const saved = process.env.TUNNEL_TOKEN;
  process.env.TUNNEL_TOKEN = "parent-value";
  try {
    const env = buildCloudflaredEnvironment("/data");
    assert.equal(env.TUNNEL_TOKEN, undefined);
    assert.equal(Object.keys(env).some((name) => /^TUNNEL_/i.test(name)), false);
  } finally {
    if (saved === undefined) delete process.env.TUNNEL_TOKEN;
    else process.env.TUNNEL_TOKEN = saved;
  }
});

/** The real `cloudflared`, if this machine has one new enough (the tests below never give it a real token, so it never reaches the network). */
async function realCloudflared() {
  const candidates = process.platform === "win32" ? ["cloudflared.exe"] : ["cloudflared"];
  for (const candidate of candidates) {
    const text = await new Promise((resolve) => {
      execFile(candidate, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : String(stdout)));
    });
    const version = parseCloudflaredVersion(text);
    if (version && (version[0] > 2025 || (version[0] === 2025 && version[1] >= 4))) return candidate;
  }
  return undefined;
}

test("C17: the command line is one the real cloudflared accepts (it refused `tunnel run --no-autoupdate`), and it reads the token from its environment", async (t) => {
  const binary = await realCloudflared();
  if (!binary) return t.skip("cloudflared 2025.4.0 or newer is not installed here");
  await withTunnel(async ({ root, vault }) => {
    const output = [];
    const manager = new CloudflareTunnelManager({
      root,
      vault,
      findBinary: () => binary,
      detectOtherConnectors: async () => [],
      spawn: (command, args, options) => {
        const child = nodeSpawn(command, [...args], options);
        child.stdout?.on("data", (chunk) => output.push(String(chunk)));
        child.stderr?.on("data", (chunk) => output.push(String(chunk)));
        return child;
      },
    });
    try {
      // Not a token: cloudflared says so before it does anything on the network.
      await manager.configure({ token: "not-a-valid-token" });
      const started = await manager.start();
      assert.equal(started.binaryAvailable, true, JSON.stringify(started));
      await until(() => manager.status().process === "failed", 30_000);
      await until(() => /token/i.test(output.join("")), 10_000);
      const text = output.join("");
      assert.doesNotMatch(text, /flag provided but not defined|incorrect usage|unknown command/i, text);
      assert.match(text, /Provided Tunnel token is not valid/i, "it got the token from TUNNEL_TOKEN and looked at it");
    } finally {
      await manager.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// C17d / R10: cloudflared does not outlive the server, and a leftover is recognised by what it is, not by its number
// ---------------------------------------------------------------------------------------------

/** A server that started a connector and then died without cleaning up: its files remain, its connector may be running. */
async function crashedServer({ root, make, system, fake }) {
  const manager = make();
  await manager.configure({ token: TOKEN });
  await manager.start();
  const orphan = fake.running.at(-1).pid;
  assert.ok(system.table.get(orphan).alive);
  return { manager, orphan };
}

test("R10: a connector left running by a previous server is stopped before a new one starts (it used to ask the owner to do it by hand)", async () => {
  await withTunnel(async ({ root, make, system, fake }) => {
    const { orphan } = await crashedServer({ root, make, system, fake });
    const next = make();
    const status = await next.start();
    assert.equal(status.process, "running", JSON.stringify(status));
    assert.equal(status.lastErrorCode, undefined);
    assert.deepEqual(system.kills, [{ pid: orphan, signal: "SIGTERM" }], "the leftover was asked to stop");
    assert.equal(system.table.get(orphan).alive, false);
    assert.equal(fake.running.length, 2, "and exactly one new connector runs");
    const state = JSON.parse(await readFile(path.join(root, "private", "cloudflare-tunnel.json"), "utf8"));
    assert.equal(state.pid, fake.running[1].pid, "the files name the connector that runs now");
  });
});

test("R10: a recorded process id that now belongs to another program is left alone (no false 'previous connector' error)", async () => {
  for (const reused of [
    { start: "boot:someone-else", name: "cloudflared", command: "cloudflared tunnel run" },
    { start: "boot:40001", name: "postgres", command: "postgres -D /data" },
    { start: "other-boot:40001", name: "cloudflared", command: "cloudflared access tcp" },
  ]) {
    await withTunnel(async ({ root, make, system, fake }) => {
      const { orphan } = await crashedServer({ root, make, system, fake });
      system.table.set(orphan, { ...reused, alive: true });
      const status = await make().start();
      assert.equal(status.process, "running", `${reused.name}: ${JSON.stringify(status)}`);
      assert.equal(status.lastErrorCode, undefined);
      assert.deepEqual(system.kills, [], "nothing was stopped: it is not ours");
      assert.equal(system.table.get(orphan).alive, true);
      assert.equal(fake.running.length, 2, "the connector started");
    });
  }
});

test("R10: a recorded process id that does not exist any more is forgotten, and a leftover that cannot be stopped is reported", async () => {
  await withTunnel(async ({ root, make, system, fake }) => {
    const { orphan } = await crashedServer({ root, make, system, fake });
    system.table.get(orphan).alive = false;
    assert.equal((await make().start()).process, "running");
    assert.deepEqual(system.kills, []);
  });
  await withTunnel(async ({ root, make, system, fake }) => {
    const { orphan } = await crashedServer({ root, make, system, fake });
    system.table.get(orphan).refuse = true;
    const status = await make().start();
    assert.equal(status.process, "failed");
    assert.equal(status.lastErrorCode, "previous");
    assert.equal(status.lastError, TUNNEL_ERRORS.previous);
    assert.equal(fake.running.length, 1, "no second connector next to a leftover that stays");
  });
});

test("R10: a process id from an earlier version's state file (no process record) is stopped only if it is a cloudflared started with this folder's token file", async () => {
  for (const [command, stopped] of [
    ["PATH-TO/cloudflared tunnel run --no-autoupdate --token-file TOKEN-FILE", true],
    ["cloudflared tunnel run --token-file /somewhere/else", false],
    ["cloudflared tunnel run", false],
  ]) {
    await withTunnel(async ({ root, make, system, fake }) => {
      const legacy = path.join(root, "private", "cloudflare-tunnel-token");
      await writeFile(legacy, TOKEN, { mode: 0o600 });
      await writeFile(path.join(root, "private", "cloudflare-tunnel.json"), JSON.stringify({ version: 1, enabled: true, pid: 777 }));
      system.table.set(777, { start: "boot:777", name: "cloudflared", alive: true, command: command.replace("TOKEN-FILE", legacy) });
      const status = await make().start();
      assert.equal(status.process, "running", JSON.stringify(status));
      assert.equal(system.table.get(777).alive, !stopped, command);
    });
  }
});

test("R10: configuring or removing the connector also stops a leftover of an earlier run", async () => {
  await withTunnel(async ({ root, make, system, fake }) => {
    const { orphan } = await crashedServer({ root, make, system, fake });
    await make().configure({ token: OTHER_TOKEN });
    assert.equal(system.table.get(orphan).alive, false, "configure");
  });
  await withTunnel(async ({ root, make, system, fake }) => {
    const { orphan } = await crashedServer({ root, make, system, fake });
    await make().remove();
    assert.equal(system.table.get(orphan).alive, false, "remove");
  });
});

test("R10: when the connector exits by itself its process record goes", async () => {
  await withTunnel(async ({ root, make, fake }) => {
    const manager = make();
    await manager.configure({ token: TOKEN });
    await manager.start();
    assert.ok(await stat(path.join(root, "private", "cloudflared-process.json")), "recorded while it runs");
    fake.running[0].finish(1);
    await until(() => manager.status().process === "failed", 2_000);
    await until(async () => stat(path.join(root, "private", "cloudflared-process.json")).then(() => false, () => true), 2_000);
    // The record goes first and the state is written right after it: a slow disk (Windows) lets a reader in between.
    const state = path.join(root, "private", "cloudflare-tunnel.json");
    const namesNoProcess = async () => readFile(state, "utf8").then((text) => JSON.parse(text).pid === undefined, () => false);
    await until(namesNoProcess, 5_000).catch(() => assert.fail("and the state file names no process"));
  });
});

test("R10: stopping does not wait for a connector that was already killed from outside (it used to wait six seconds for an exit event that had passed)", async () => {
  await withTunnel(async ({ make, fake }) => {
    const manager = make();
    await manager.configure({ token: TOKEN });
    await manager.start();
    // Ended by a signal, and the manager has not heard of it: `exitCode` is null, `signalCode` is not.
    fake.running[0].signalCode = "SIGKILL";
    const started = Date.now();
    await manager.close();
    assert.ok(Date.now() - started < 1_500, `closing took ${Date.now() - started} ms`);
  });
});

test("R10: a connector that was started is recorded with the identity of its process", async () => {
  await withTunnel(async ({ root, make, fake, system }) => {
    const manager = make();
    await manager.configure({ token: TOKEN });
    await manager.start();
    const recorded = JSON.parse(await readFile(path.join(root, "private", "cloudflared-process.json"), "utf8"));
    assert.equal(recorded.pid, fake.running[0].pid);
    assert.equal(recorded.identity.start, system.table.get(recorded.pid).start);
    assert.equal(recorded.identity.name, "cloudflared");
    assert.equal(JSON.stringify(recorded).includes(TOKEN), false);
    await manager.close();
    await assert.rejects(() => stat(path.join(root, "private", "cloudflared-process.json")), { code: "ENOENT" }, "a stopped connector leaves no record");
  });
});

test("C17: through the server: the token goes into the server's vault, the connector runs, and closing the server stops it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-tunnel-server-"));
  const system = fakeSystem();
  const fake = fakeCloudflared({ system });
  const server = await startNarrariumServer({
    dataDir,
    port: 0,
    adminPort: 0,
    supervised: false,
    checkRelease: noRelease,
    tunnel: { findBinary: () => "/opt/cloudflared/bin/cloudflared", spawn: fake.spawn, detectOtherConnectors: async () => [], identify: system.identify, kill: system.kill },
  });
  try {
    const admin = await adminLogin(server);
    const configured = await admin.call("POST", "/admin/api/tunnel/configure", { token: TOKEN, hostname: "https://books.example.com" });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(configured.body.process, "running");
    assert.equal(run(fake).options.env.TUNNEL_TOKEN, TOKEN);
    const stored = JSON.parse(await readFile(path.join(dataDir, "private", "cloudflare-tunnel-token.json"), "utf8"));
    assert.equal(server.data.vault.decrypt(stored.encrypted), TOKEN, "encrypted with the key of the server's own vault");
    assert.equal(fake.running[0].signals.length, 0);
    await server.close();
    assert.deepEqual(fake.running[0].signals, ["SIGTERM"], "the connector was stopped with the server");
    assert.equal(system.table.get(fake.running[0].pid).alive, false);
    await assert.rejects(() => stat(path.join(dataDir, "private", "cloudflared-process.json")), { code: "ENOENT" });
  } finally {
    await server.close().catch(() => undefined);
    await remove(dataDir);
  }
});

// ---------------------------------------------------------------------------------------------
// With real processes: what is true of the operating system, not of a model of it
// ---------------------------------------------------------------------------------------------

test("R10: processIdentity tells a running process, its program and its start apart from another and from none", async (t) => {
  if (process.platform === "win32") return t.skip("covered by the injected identities; PowerShell is slow here");
  const mine = await processIdentity(process.pid);
  assert.ok(mine, "this process");
  assert.match(mine.name, /node/i);
  assert.deepEqual(await processIdentity(process.pid), mine, "stable for one process");
  const child = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await until(() => processIdentity(child.pid), 5_000);
    const other = await processIdentity(child.pid);
    assert.notEqual(other.start, mine.start, "another process, another start");
    assert.ok(other.command.includes("setInterval"), `the arguments are there: ${other.command}`);
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await until(async () => (await processIdentity(child.pid)) === undefined, 5_000);
  assert.equal(await processIdentity(0), undefined);
  assert.equal(await processIdentity(-5), undefined);
  assert.equal(processAlive(child.pid), false);
  assert.equal(processAlive(process.pid), true);
});

/** A directory with a program called `cloudflared` (a link to node) so that the real operating system calls the process by that name. */
async function realBinaries() {
  const bin = await mkdtemp(path.join(os.tmpdir(), "narrarium-fake-cloudflared-"));
  const program = path.join(bin, "cloudflared");
  await symlink(process.execPath, program);
  return { bin, program };
}

/** A harness process that runs a manager over real (node) children and says what they are. */
function harness(root, program, { stay = true } = {}) {
  const source = `
    import { CloudflareTunnelManager } from ${JSON.stringify(testing)};
    import { spawn } from "node:child_process";
    const manager = new CloudflareTunnelManager({
      root: ${JSON.stringify(root)},
      findBinary: () => ${JSON.stringify(program)},
      detectOtherConnectors: async () => [],
      spawn: (command, args, options) => args[0] === "--version"
        ? spawn(process.execPath, ["-e", "console.log('cloudflared version 2025.6.1 (built 2025-06-01)')"], options)
        : spawn(${JSON.stringify(program)}, ["-e", "setInterval(() => {}, 1000)"], options),
    });
    await manager.configure({ token: ${JSON.stringify(TOKEN)} });
    const status = await manager.start();
    process.stdout.write("STARTED " + JSON.stringify(status) + "\\n");
    process.stdin.on("data", (chunk) => { if (String(chunk).includes("exit")) process.exit(0); });
    ${stay ? "setInterval(() => {}, 1000);" : ""}
  `;
  const child = nodeSpawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    started: () => until(() => (/STARTED (.*)\n/.exec(stdout) ? JSON.parse(/STARTED (.*)\n/.exec(stdout)[1]) : undefined), 30_000).catch((error) => {
      throw new Error(`${error.message}: ${stdout}\n${stderr}`);
    }),
    exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
  };
}

test("C17: when the server process exits, the connector goes with it (a real process, process.exit without a clean stop)", async (t) => {
  // A link to node is called `cloudflared` by Linux's /proc; other systems may report the program it points to.
  if (process.platform !== "linux") return t.skip("needs a program that the operating system names cloudflared (checked on Linux)");
  const root = await makeRoot();
  const { bin, program } = await realBinaries();
  const proc = harness(root, program);
  try {
    const status = await proc.started();
    assert.equal(status.process, "running", JSON.stringify(status));
    const { pid } = JSON.parse(await readFile(path.join(root, "private", "cloudflared-process.json"), "utf8"));
    assert.equal(processAlive(pid), true, "the connector is up");
    assert.match((await processIdentity(pid)).name, /cloudflared/, "and the system calls it by that name");
    proc.child.stdin.write("exit\n");
    await proc.exited;
    await until(() => !processAlive(pid), 10_000);
  } finally {
    proc.child.kill("SIGKILL");
    await remove(root, bin);
  }
});

test("R10: a connector orphaned by a server that was killed outright is found by its identity and stopped by the next server (a real process)", async (t) => {
  if (process.platform !== "linux") return t.skip("needs a program that the operating system names cloudflared (checked on Linux)");
  const root = await makeRoot();
  const { bin, program } = await realBinaries();
  const proc = harness(root, program);
  let orphan;
  try {
    assert.equal((await proc.started()).process, "running");
    orphan = JSON.parse(await readFile(path.join(root, "private", "cloudflared-process.json"), "utf8")).pid;
    proc.child.kill("SIGKILL");
    await proc.exited;
    assert.equal(processAlive(orphan), true, "nothing could clean up after a SIGKILL: the connector is an orphan now");

    const spawned = [];
    const next = new CloudflareTunnelManager({
      root,
      findBinary: () => program,
      detectOtherConnectors: async () => [],
      spawn: (command, args, options) => {
        const child = nodeSpawn(args[0] === "--version" ? process.execPath : program, args[0] === "--version" ? ["-e", "console.log('cloudflared version 2025.6.1 (built 2025-06-01)')"] : ["-e", "setInterval(() => {}, 1000)"], options);
        if (args[0] !== "--version") spawned.push(child);
        return child;
      },
    });
    try {
      const status = await next.start();
      assert.equal(status.process, "running", JSON.stringify(status));
      await until(() => !processAlive(orphan), 10_000);
      assert.equal(spawned.length, 1);
      assert.notEqual(spawned[0].pid, orphan);
    } finally {
      await next.close();
    }
  } finally {
    if (orphan && processAlive(orphan)) process.kill(orphan, "SIGKILL");
    proc.child.kill("SIGKILL");
    await remove(root, bin);
  }
});

test("R10: an unrelated process that was given the recorded id is never touched (a real process)", async (t) => {
  if (!posix) return t.skip("needs real process ids");
  const root = await makeRoot();
  const innocent = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await until(() => processIdentity(innocent.pid), 5_000);
    const fake = fakeCloudflared({});
    const manager = newManager(root, fake, undefined);
    await manager.configure({ token: TOKEN });
    // An earlier server recorded this id for a connector of its own; the connector is long gone and the number was reused.
    await writeFile(path.join(root, "private", "cloudflare-tunnel.json"), JSON.stringify({ version: 1, enabled: true, pid: innocent.pid }));
    await writeFile(path.join(root, "private", "cloudflared-process.json"), JSON.stringify({ version: 1, pid: innocent.pid, identity: { start: "boot:1", name: "cloudflared" } }));
    const status = await manager.start();
    assert.equal(status.process, "running", JSON.stringify(status));
    assert.equal(processAlive(innocent.pid), true, "still running");
    assert.equal(innocent.exitCode, null);
    await manager.close();
  } finally {
    innocent.kill("SIGKILL");
    await remove(root);
  }
});
