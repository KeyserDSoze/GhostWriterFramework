import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CloudflareTunnelManager, TUNNEL_ERRORS, buildCloudflaredEnvironment, parseCloudflaredVersion, validTunnelHostname } from "../dist/testing.mjs";

const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";

/** A fake `cloudflared`: `--version` prints the given version, `tunnel run` stays up until killed. */
function fakeCloudflared({ version = "2025.6.1" } = {}) {
  const calls = [];
  const running = [];
  let nextPid = 40_000;
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid += 1;
    child.exitCode = null;
    child.stdout = Object.assign(new EventEmitter(), { resume() {} });
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    child.signals = [];
    child.finish = (code, signal = null) => {
      if (child.exitCode !== null) return;
      child.exitCode = code ?? 0;
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
    } else running.push(child);
    return child;
  };
  return { spawn, calls, running };
}

async function withTunnel(run, { version, findBinary = () => "/opt/cloudflared/bin/cloudflared", others = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-tunnel-test-"));
  await mkdir(path.join(root, "private"), { recursive: true, mode: 0o700 });
  const fake = fakeCloudflared({ version });
  const manager = new CloudflareTunnelManager({ root, findBinary, spawn: fake.spawn, detectOtherConnectors: async () => others });
  try {
    await run(manager, fake, root);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("the connector token is stored encrypted and passed only in the environment of `cloudflared tunnel run`", async () => {
  await withTunnel(async (manager, fake, root) => {
    assert.equal((await manager.start()).enabled, false, "nothing runs before it is configured");
    assert.equal(fake.running.length, 0);
    const configured = await manager.configure({ token: `  ${TOKEN}\n`.trim(), hostname: "https://books.example.com" });
    assert.equal(configured.configured, true);
    const legacyPath = path.join(root, "private", "cloudflare-tunnel-token");
    await assert.rejects(() => stat(legacyPath), { code: "ENOENT" }, "no clear-text token file");
    const secretPath = path.join(root, "private", "cloudflare-tunnel-token.json");
    assert.equal((await readFile(secretPath, "utf8")).includes(TOKEN), false, "the vault's copy is encrypted");
    if (process.platform !== "win32") assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    const saved = await readFile(path.join(root, "private", "cloudflare-tunnel.json"), "utf8");
    assert.equal(saved.includes(TOKEN), false, "the state file never contains the token");

    const status = await manager.start();
    assert.equal(status.process, "running");
    assert.equal(status.hostname, "https://books.example.com");
    assert.equal(status.binaryAvailable, true);
    const run = fake.calls.find((call) => call.args[0] === "tunnel");
    assert.equal(run.command, "/opt/cloudflared/bin/cloudflared");
    assert.deepEqual(run.args, ["tunnel", "--no-autoupdate", "run"]);
    assert.equal(run.options.shell, false);
    assert.equal(JSON.stringify(run.args).includes(TOKEN), false, "the token is not in argv");
    assert.equal(run.options.env.TUNNEL_TOKEN, TOKEN, "it reaches cloudflared through its environment");
    assert.equal(run.options.env.HOME, path.join(root, "private", "cloudflared-home"));
    assert.equal(JSON.parse(await readFile(path.join(root, "private", "cloudflare-tunnel.json"), "utf8")).pid, fake.running[0].pid);

    assert.equal((await manager.restart()).process, "running");
    assert.deepEqual(fake.running[0].signals, ["SIGTERM"]);
    assert.equal(fake.running.length, 2);

    fake.running[1].finish(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const exited = manager.status();
    assert.equal(exited.process, "failed");
    assert.equal(exited.lastErrorCode, "exited");
    assert.equal(exited.lastError, TUNNEL_ERRORS.exited);
    assert.equal(fake.running.length, 2, "a stopped connector is not restarted automatically");

    const removed = await manager.remove();
    assert.equal(removed.enabled, false);
    assert.equal(removed.configured, false);
    await assert.rejects(() => stat(secretPath), { code: "ENOENT" });
    await assert.rejects(() => stat(path.join(root, "private", "cloudflare-tunnel.json")), { code: "ENOENT" });
  });
});

test("an old or missing cloudflared is reported and never started", async () => {
  await withTunnel(async (manager, fake) => {
    await manager.configure({ token: TOKEN });
    const status = await manager.start();
    assert.equal(status.process, "failed");
    assert.equal(status.lastErrorCode, "version");
    assert.equal(fake.running.length, 0);
  }, { version: "2024.12.2" });

  await withTunnel(async (manager, fake) => {
    await manager.configure({ token: TOKEN });
    const status = await manager.start();
    assert.equal(status.lastErrorCode, "missing");
    assert.equal(status.binaryAvailable, false);
    assert.equal(fake.calls.length, 0);
  }, { findBinary: () => undefined });
});

test("other connectors are detected and left alone; a stale process id of a previous start never blocks the connector", async () => {
  await withTunnel(async (manager, fake) => {
    await manager.configure({ token: TOKEN });
    const status = await manager.start();
    assert.equal(status.otherConnectorDetected, true);
    assert.equal(status.process, "running");
    assert.equal(fake.running.length, 1);
  }, { others: [4242] });

  // A process id of an earlier run that now belongs to some other program (here: this very process) is not "a connector still
  // running": it is left alone, forgotten, and the connector starts.
  await withTunnel(async (manager, fake, root) => {
    await writeFile(path.join(root, "private", "cloudflare-tunnel-token"), TOKEN, { mode: 0o600 });
    await writeFile(path.join(root, "private", "cloudflare-tunnel.json"), JSON.stringify({ version: 1, enabled: true, pid: process.pid }));
    const status = await manager.start();
    assert.equal(status.process, "running", JSON.stringify(status));
    assert.equal(status.lastErrorCode, undefined);
    assert.equal(fake.running.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(root, "private", "cloudflare-tunnel.json"), "utf8")).pid, fake.running[0].pid);
  });

  await withTunnel(async (manager, fake, root) => {
    await writeFile(path.join(root, "private", "cloudflare-tunnel.json"), "{\"version\":1,\"enabled\":\"yes\"}");
    const status = await manager.start();
    assert.equal(status.lastErrorCode, "invalid_state");
    assert.equal(fake.running.length, 0);
  });
});

test("tunnel settings and versions are validated", () => {
  assert.throws(() => CloudflareTunnelManager.validateConfiguration({ token: "" }));
  assert.throws(() => CloudflareTunnelManager.validateConfiguration({ token: "abc\ndef" }));
  assert.throws(() => CloudflareTunnelManager.validateConfiguration({ token: "x".repeat(5000) }));
  assert.throws(() => CloudflareTunnelManager.validateConfiguration({ token: TOKEN, hostname: "http://books.example.com" }));
  assert.deepEqual(CloudflareTunnelManager.validateConfiguration({ token: TOKEN, hostname: "" }), { token: TOKEN });
  assert.equal(validTunnelHostname("https://books.example.com"), true);
  assert.equal(validTunnelHostname("https://user:pass@books.example.com"), false);
  assert.deepEqual(parseCloudflaredVersion("cloudflared version 2025.4.0 (built 2025-04-01-1200 UTC)"), [2025, 4, 0]);
  assert.equal(parseCloudflaredVersion("something else 2025.4.0"), undefined);
  const env = buildCloudflaredEnvironment("/data");
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.equal(env.HOME, path.join("/data", "private", "cloudflared-home"));
  assert.equal(Object.keys(env).some((name) => /TOKEN|SECRET|KEY/i.test(name)), false);
});
