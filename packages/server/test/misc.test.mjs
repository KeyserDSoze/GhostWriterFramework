import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NarrariumServerClient, randomNonce, verifyServerIdentity } from "narrarium-engine";
import {
  Auth,
  GitError,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  Vault,
  autostartStatus,
  configureAutostart,
  defaultDataRoot,
  doctorChecks,
  installOutboundNetwork,
  lockDataRoot,
  npmInvocation,
  parseCommand,
  parseUpdateRequest,
  parseUpdateResult,
  publicAddress,
  readAdminCode,
  readAdminCodeFile,
  renderLaunchAgent,
  renderUserService,
  requestLocalClientToken,
  rotateLocalAdminCode,
  runGit,
  sanitizedNpmEnvironment,
  setLocalAdminCode,
  supervisedChildEnvironment,
  UPDATE_MESSAGES,
} from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";

const posix = process.platform !== "win32";
const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

async function temporary(prefix = "narrarium-misc-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("the vault encrypts with a private key that is never regenerated", async () => {
  const root = await temporary();
  try {
    const vault = await Vault.open(root);
    const secret = vault.encrypt("sk-live-secret");
    assert.equal(JSON.stringify(secret).includes("sk-live-secret"), false);
    const reopened = await Vault.open(root);
    assert.equal(reopened.decrypt(secret), "sk-live-secret");
    const tampered = { ...secret, data: `${secret.data.slice(0, 4)}${secret.data[4] === "A" ? "B" : "A"}${secret.data.slice(5)}` };
    assert.throws(() => reopened.decrypt(tampered), /cannot be decrypted/);
    const keyFile = path.join(root, "private", "master.key");
    if (posix) assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    await writeFile(keyFile, Buffer.alloc(5));
    await assert.rejects(() => Vault.open(root), posix ? /damaged/ : undefined);
    if (posix) {
      const loose = await temporary();
      await mkdir(path.join(loose, "private"));
      await chmod(path.join(loose, "private"), 0o755);
      await assert.rejects(() => Vault.open(loose), /not safe/);
      await rm(loose, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the admin code file can be edited by hand, with or without a final line break", async () => {
  const root = await temporary();
  try {
    const vault = await Vault.open(root);
    const auth = await Auth.open(root, vault);
    const file = path.join(root, "private", "admin-code.txt");
    const original = (await readFile(file, "utf8")).trim();
    await auth.login(original);
    const edited = "a code typed into the file by hand, long enough";
    await writeFile(file, `${edited}\r\n`);
    const reopened = await Auth.open(root, vault);
    await assert.rejects(() => reopened.login(original));
    assert.ok((await reopened.login(edited)).csrf);
    await writeFile(file, edited);
    assert.ok((await (await Auth.open(root, vault)).login(edited)).csrf);
    await writeFile(file, `${edited}\nsecond line\n`);
    await assert.rejects(() => Auth.open(root, vault), /only the admin code/);
    await writeFile(file, "short\n");
    await assert.rejects(() => Auth.open(root, vault), /32-200/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the server identity is a signature over the caller's nonce", async () => {
  await withServer(async (server) => {
    const nonce = randomNonce();
    assert.match(nonce, /^[0-9a-f]{64}$/);
    const info = await (await fetch(`${server.url}/api/v1/info?nonce=${nonce}`)).json();
    assert.equal((await verifyServerIdentity(info, nonce)).verified, true);
    await assert.rejects(() => verifyServerIdentity(info, randomNonce()), /did not prove/);
    const signature = `${info.signature[0] === "A" ? "B" : "A"}${info.signature.slice(1)}`;
    await assert.rejects(() => verifyServerIdentity({ ...info, signature }, nonce), /not valid/);
    await assert.rejects(() => verifyServerIdentity({ ...info, fingerprint: "0".repeat(64) }, nonce), /does not match/);
    const plain = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(plain.signature, undefined);
    assert.equal(plain.supervised, false);
    assert.equal((await fetch(`${server.url}/api/v1/info?nonce=xyz`)).status, 400);
  });
});

test("the CLI's loopback admin client issues tokens and changes the admin code", async () => {
  await withServer(async (server) => {
    const options = { dataRoot: server.data.root, adminPort: server.adminPort };
    const issued = await requestLocalClientToken({ ...options, label: "Terminal", scopes: ["read", "update"] });
    const session = await new NarrariumServerClient({ baseUrl: server.url, token: issued.token }).session();
    assert.deepEqual(session.scopes, ["read", "update"]);
    await assert.rejects(() => requestLocalClientToken({ ...options, label: "Terminal", scopes: ["root"] }), /permissions/);
    const rotated = await rotateLocalAdminCode(options);
    assert.equal(await readAdminCode(server.data.root), rotated);
    await setLocalAdminCode({ ...options, code: "c".repeat(40) });
    assert.equal(await readAdminCode(server.data.root), "c".repeat(40));
    await assert.rejects(() => requestLocalClientToken({ dataRoot: server.data.root, adminPort: 1, label: "x", scopes: ["read"] }), /not running/);
  });
  const root = await temporary();
  try {
    const file = path.join(root, "code.txt");
    await writeFile(file, `${"k".repeat(40)}\n`, { mode: 0o600 });
    assert.equal(await readAdminCodeFile(file), "k".repeat(40));
    if (posix) {
      await chmod(file, 0o644);
      await assert.rejects(() => readAdminCodeFile(file), /private/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public addresses only; the outbound guard reaches approved AI endpoints and never follows redirects", async () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(publicAddress(address), true, address);
  for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "224.0.0.1", "0.0.0.0", "192.0.2.1", "203.0.113.5", "::1", "fe80::1", "fc00::1", "2001:db8::1", "2002::1", "2001:0:1::1", "::ffff:8.8.8.8", "localhost"]) {
    assert.equal(publicAddress(address), false, address);
  }

  const target = http.createServer((request, response) => {
    if (request.url === "/v1/redirect") {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`ok ${request.method} ${request.headers["x-test"] ?? ""}`);
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const port = target.address().port;
  const original = globalThis.fetch;
  const restore = installOutboundNetwork(() => [`http://127.0.0.1:${port}/v1`]);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "x-test": "yes" }, body: "{}" });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "ok POST yes");
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/v1/redirect`), (error) => error.code === "redirect");
    await assert.rejects(() => fetch(`http://localhost:${port}/v1`), (error) => error.code === "not_approved");
    await assert.rejects(() => fetch("https://example.com/"), (error) => error.code === "not_approved");
    await assert.rejects(() => fetch("http://api.github.com/"), (error) => error.code === "not_approved", "GitHub only over HTTPS");
    await assert.rejects(() => fetch(`http://user:pass@127.0.0.1:${port}/v1`), (error) => error.code === "not_approved");
  } finally {
    restore();
    target.close();
  }
  assert.equal(globalThis.fetch, original);
});

test("autostart files run the supervisor of one data folder", async () => {
  const active = { version: "0.2.0", packageRoot: "/srv/narrarium/private/npm-runtime/versions/0.2.0" };
  const unit = renderUserService(active, "/srv/narrarium 100%", "/usr/bin/node");
  if (posix) assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/srv\/narrarium\/private\/npm-runtime\/versions\/0\.2\.0\/dist\/cli\.mjs" start --data-root "\/srv\/narrarium 100%%"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  const agent = renderLaunchAgent(active, "/Users/a/Narrarium & Co", "/usr/local/bin/node");
  assert.match(agent, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  if (posix) assert.match(agent, /<string>\/Users\/a\/Narrarium &amp; Co<\/string>/);
  assert.match(agent, /<key>RunAtLoad<\/key>\s*<true\/>/);

  const home = await temporary();
  try {
    assert.equal(await autostartStatus(home, "linux"), undefined);
    const environment = { HOME: home, USER: "writer", XDG_RUNTIME_DIR: home, PATH: process.env.PATH, NARRARIUM_SYSTEMCTL: process.platform === "linux" ? "true" : "" };
    if (process.platform === "linux" && process.getuid?.() !== 0) {
      const result = await configureAutostart({ ...active, packageRoot: path.join(home, "runtime") }, path.join(home, "data"), environment);
      assert.equal(result.kind, "systemd-user");
      assert.equal(result.servicePath, path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT));
      assert.match(await readFile(result.servicePath, "utf8"), /start --data-root/);
      assert.equal(await autostartStatus(home, "linux"), result.servicePath);
    } else if (process.getuid?.() === 0) {
      await assert.rejects(() => configureAutostart(active, path.join(home, "data"), environment), /root/);
    } else if (process.platform === "win32") {
      await assert.rejects(() => configureAutostart(active, path.join(home, "data"), environment), /Task Scheduler/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("default data folders, npm invocation and the environments of npm and of the server", async () => {
  assert.equal(defaultDataRoot({ NARRARIUM_SERVER_HOME: "/srv/books" }, "linux"), "/srv/books");
  assert.equal(defaultDataRoot({ HOME: "/home/a" }, "linux"), "/home/a/.local/share/narrarium-server");
  assert.equal(defaultDataRoot({ HOME: "/home/a", XDG_DATA_HOME: "/data/xdg" }, "linux"), "/data/xdg/narrarium-server");
  assert.equal(defaultDataRoot({ HOME: "/home/a", XDG_DATA_HOME: "relative" }, "linux"), "/home/a/.local/share/narrarium-server");
  assert.equal(defaultDataRoot({ HOME: "/Users/a" }, "darwin"), "/Users/a/Library/Application Support/Narrarium Server");
  assert.equal(defaultDataRoot({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32"), "C:\\Users\\a\\AppData\\Roaming\\Narrarium\\server");

  assert.deepEqual(npmInvocation("linux", "/usr/bin/node"), { command: "npm", prefix: [] });
  const nodeDir = await temporary();
  try {
    const nodeExe = path.join(nodeDir, "node.exe");
    assert.deepEqual(npmInvocation("win32", nodeExe), { command: "npm.cmd", prefix: [] });
    const npmCli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(npmCli), { recursive: true });
    await writeFile(npmCli, "");
    assert.deepEqual(npmInvocation("win32", nodeExe), { command: nodeExe, prefix: [npmCli] }, "on Windows npm runs through node.exe, without cmd.exe");
  } finally {
    await rm(nodeDir, { recursive: true, force: true });
  }

  const npmEnv = sanitizedNpmEnvironment({ PATH: "/bin", HTTPS_PROXY: "http://proxy:3128", NPM_TOKEN: "npm_x", NODE_AUTH_TOKEN: "y", NODE_OPTIONS: "--require /tmp/evil.js", OPENAI_API_KEY: "sk" });
  assert.deepEqual(Object.keys(npmEnv).sort(), ["HTTPS_PROXY", "NPM_CONFIG_IGNORE_SCRIPTS", "NPM_CONFIG_UPDATE_NOTIFIER", "PATH"]);
  const childEnv = supervisedChildEnvironment({ PATH: "/bin", NARRARIUM_SERVER_HOME: "/srv/books", NODE_OPTIONS: "--require /tmp/evil.js", OPENAI_API_KEY: "sk" });
  assert.equal(childEnv.NARRARIUM_SUPERVISED, "1");
  assert.equal(childEnv.NARRARIUM_SERVER_HOME, "/srv/books");
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
});

test("update control files have an exact shape", () => {
  const request = { schemaVersion: 1, packageName: "narrarium-server", version: "0.2.0", requestedAt: new Date().toISOString(), requestId: "00000000-0000-4000-8000-000000000001", source: "client" };
  assert.deepEqual(parseUpdateRequest(request), request);
  assert.throws(() => parseUpdateRequest({ ...request, command: "rm -rf /" }));
  assert.throws(() => parseUpdateRequest({ ...request, version: "latest" }));
  assert.throws(() => parseUpdateRequest({ ...request, source: "internet" }));
  assert.throws(() => parseUpdateRequest({ ...request, packageName: "other" }));
  const result = { schemaVersion: 1, requestId: request.requestId, state: "failed", outcome: "limited", version: "0.2.0", fromVersion: "0.1.0", at: new Date().toISOString(), message: UPDATE_MESSAGES.limited };
  assert.deepEqual(parseUpdateResult(result), result);
  assert.throws(() => parseUpdateResult({ ...result, message: "<script>" }), "messages are fixed texts");
  assert.throws(() => parseUpdateResult({ ...result, state: "completed" }));
});

test("git failures of the connection are retryable, failures of the repository are not", async () => {
  const unreachable = await runGit(["ls-remote", "https://github.narrarium.invalid/owner/repo.git"], { timeoutMs: 60_000 }).then(() => null, (error) => error);
  assert.ok(unreachable instanceof GitError);
  assert.equal(unreachable.retryable, true, unreachable.stderr);
  const root = await temporary();
  try {
    const broken = await runGit(["rev-parse", "HEAD"], { cwd: root }).then(() => null, (error) => error);
    assert.ok(broken instanceof GitError);
    assert.equal(broken.retryable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command line parsing and doctor checks", () => {
  assert.equal(parseCommand([]).command, "start");
  assert.deepEqual(parseCommand(["--port", "3100", "--admin-port", "3101", "--origin", "https://my.example"]), { command: "start", origins: ["https://my.example"], apiPort: 3100, adminPort: 3101 });
  assert.equal(parseCommand(["start", "--direct", "--verbose"]).direct, true);
  assert.equal(parseCommand(["--version"]).command, "version");
  assert.equal(parseCommand(["help"]).command, "help");
  assert.deepEqual(parseCommand(["client-token", "--label", "Phone", "--scope", "read,update"]).scopes, ["read", "update"]);
  assert.equal(parseCommand(["update", "--to", "1.2.3"]).requestedVersion, "1.2.3");
  assert.throws(() => parseCommand(["update", "--to", "1.2"]), /exact semver/);
  assert.throws(() => parseCommand(["status", "--port", "1"]), /not allowed/);
  assert.throws(() => parseCommand(["start", "--port", "99999"]), /port/);
  assert.throws(() => parseCommand(["start", "--data-root"]), /needs a value/);
  assert.throws(() => parseCommand(["frobnicate"]), /Unknown command/);

  const checks = doctorChecks(os.tmpdir(), "linux", (command) => ({ ok: command !== "flock", output: command === "cloudflared" ? "cloudflared version 2025.5.0 (built 2025-05-01)" : `${command} 1.0.0` }));
  const flock = checks.find((check) => check.name.startsWith("flock"));
  assert.equal(flock.ok, false);
  assert.equal(flock.required, true);
  assert.equal(checks.find((check) => check.name.startsWith("cloudflared")).detail, "2025.5.0");
  assert.equal(checks.find((check) => check.name.startsWith("git")).required, false);
});

test("one server per data folder, also across processes", async () => {
  const root = await temporary();
  try {
    const release = await lockDataRoot(root);
    await assert.rejects(() => lockDataRoot(root), /already using/);
    const testing = new URL("../dist/testing.mjs", import.meta.url).href;
    const other = spawnSync(process.execPath, ["--input-type=module", "-e", `import { lockDataRoot } from ${JSON.stringify(testing)}; try { await lockDataRoot(${JSON.stringify(root)}); process.exit(0); } catch (error) { console.error(error.message); process.exit(3); }`], { encoding: "utf8", timeout: 60_000 });
    assert.equal(other.status, 3, other.stderr);
    await release();
    const again = await lockDataRoot(root);
    await again();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the command line reports its version, rejects unknown options and explains missing state", async () => {
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NARRARIUM_SERVER_HOME: "" } });
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(run("--version").stdout.trim(), pkg.version);
  const help = run("help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npx narrarium-server \[start\]/);
  assert.equal(run("status", "--port", "1").status, 2);
  const root = await temporary();
  try {
    const missing = run("admin-code", "--data-root", root);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /does not exist yet/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
