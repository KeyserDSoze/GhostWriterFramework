import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PACKAGE_NAME, RuntimeInstaller, npmInvocation, sanitizedNpmEnvironment } from "../dist/testing.mjs";
import { npmMetadata } from "./helpers.mjs";

const posix = process.platform !== "win32";
const SYSTEM_VARIABLES = ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"];

const temporary = (prefix = "narrarium-npm-") => mkdtemp(path.join(os.tmpdir(), prefix));
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};
/** An environment variable by name, the way the operating system reads it: Windows ignores the case (`Path` is `PATH`). */
const valueOf = (env, name) => env[name] ?? (posix ? undefined : Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]);
const systemEnvironment = () => Object.fromEntries(SYSTEM_VARIABLES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));

/** npm as the installer sees it, recording what every call was given: arguments, environment, working folder, config files. */
function recordingNpm() {
  const calls = [];
  const runner = async (command, args, options) => {
    const flag = (name) => args[args.indexOf(name) + 1];
    const call = { command, args: [...args], env: { ...options.env }, cwd: options.cwd };
    call.cwdEntries = await readdir(options.cwd).catch(() => null);
    for (const name of ["--userconfig", "--globalconfig"]) call[name] = await stat(String(flag(name))).then((info) => ({ file: info.isFile(), size: info.size }), () => null);
    call.cache = await stat(String(flag("--cache"))).then((info) => info.isDirectory(), () => false);
    calls.push(call);
    const spec = args.find((arg) => arg.startsWith(`${PACKAGE_NAME}@`));
    const version = spec?.slice(PACKAGE_NAME.length + 1);
    if (args[0] === "view" && args[2] === "version") return { code: 0, stdout: JSON.stringify("0.2.0"), stderr: "" };
    if (args[0] === "view") return { code: 0, stdout: JSON.stringify(npmMetadata(version, { attested: version !== "0.1.0" })), stderr: "" };
    if (args[0] === "install") {
      const packageRoot = path.join(flag("--prefix"), "node_modules", PACKAGE_NAME);
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
      await writeFile(path.join(packageRoot, "dist", "cli.mjs"), "// cli\n");
      await writeFile(path.join(packageRoot, "dist", "server.mjs"), `// narrarium-server ${version}\n`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "audit") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected npm command" };
  };
  return { calls, runner };
}

test("C13: every npm call gets empty configuration files, a private cache and home, no npm_config variables and an empty working folder", async () => {
  const dataRoot = await temporary("narrarium-npm-data-");
  const ownerHome = await temporary("narrarium-npm-owner-");
  try {
    const owner = {
      ...systemEnvironment(),
      HOME: ownerHome,
      USERPROFILE: ownerHome,
      APPDATA: ownerHome,
      LOCALAPPDATA: ownerHome,
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\owner",
      XDG_CONFIG_HOME: ownerHome,
      XDG_CACHE_HOME: ownerHome,
      HTTPS_PROXY: "http://proxy.example:3128",
      NODE_EXTRA_CA_CERTS: path.join(ownerHome, "ca.pem"),
      NPM_TOKEN: "npm_the_owners_publish_token",
      NODE_AUTH_TOKEN: "npm_other_token",
      npm_config_registry: "http://owner-registry.invalid/",
      npm_config__authToken: "npm_secret_from_the_environment",
      NPM_CONFIG_USERCONFIG: path.join(ownerHome, ".npmrc"),
      NPM_CONFIG_PREFIX: ownerHome,
      Npm_Config_Cache: path.join(ownerHome, "cache"),
    };
    const npm = recordingNpm();
    const installer = new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner, environment: owner });
    await installer.installVersion();
    assert.deepEqual(npm.calls.map((call) => call.args[0]), ["view", "view", "install", "audit"], "the whole flow ran");

    for (const call of npm.calls) {
      const label = call.args.slice(0, 3).join(" ");
      const flag = (name) => call.args[call.args.indexOf(name) + 1];
      for (const name of ["--userconfig", "--globalconfig"]) {
        assert.ok(inside(dataRoot, String(flag(name))), `${label}: ${name} points inside the data folder (${flag(name)})`);
        assert.deepEqual(call[name], { file: true, size: 0 }, `${label}: ${name} is an empty file`);
      }
      assert.notEqual(flag("--userconfig"), flag("--globalconfig"));
      assert.ok(inside(dataRoot, String(flag("--cache"))), `${label}: a private cache`);
      assert.equal(call.cache, true, `${label}: the cache folder exists`);
      assert.ok(call.args.includes("--ignore-scripts"), `${label}: no install scripts`);
      assert.ok(call.args.includes("--no-update-notifier"), `${label}: no update check`);
      assert.equal(call.args.at(-1), "--registry=https://registry.npmjs.org", `${label}: always the public registry, last on the line`);

      assert.deepEqual(Object.keys(call.env).filter((name) => /^npm_config_/i.test(name)), [], `${label}: no npm_config_* variable, whatever its case`);
      for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) assert.ok(inside(dataRoot, String(call.env[name])), `${label}: ${name} is private (${call.env[name]})`);
      for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) assert.ok(call.env[name] === undefined || inside(dataRoot, call.env[name]), `${label}: ${name} is private or absent`);
      assert.equal(call.env.HOMEDRIVE, undefined, label);
      assert.equal(call.env.HOMEPATH, undefined, label);
      for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN"]) assert.equal(call.env[name], undefined, `${label}: ${name} never reaches npm`);
      for (const name of ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", ...SYSTEM_VARIABLES.filter((variable) => owner[variable] !== undefined)]) assert.equal(valueOf(call.env, name), valueOf(owner, name), `${label}: ${name} is kept`);

      assert.notEqual(path.resolve(call.cwd), path.resolve(dataRoot), `${label}: not the data folder`);
      assert.ok(inside(dataRoot, call.cwd), `${label}: a folder of its own inside the data folder`);
      assert.deepEqual(call.cwdEntries, [], `${label}: the working folder is empty`);
      // npm finds a project by walking up from the working folder: the prefix is pinned, so no parent is ever consulted.
      assert.ok(flag("--prefix"), `${label}: a prefix is always given`);
      if (call.args[0] === "view") assert.equal(path.resolve(flag("--prefix")), path.resolve(call.cwd), `${label}: the empty working folder`);
    }

    const home = path.join(dataRoot, "private", "npm-home");
    assert.deepEqual((await readdir(home)).sort(), ["cache", "home"], "a finished run leaves only the private cache and the empty home: its configuration files and working folder are removed");
    assert.deepEqual(await readdir(path.join(home, "home")), [], "and nothing ever lands in the home");
    if (posix) assert.equal((await stat(home)).mode & 0o077, 0, "private to the server's user");
    assert.equal((await readdir(path.join(dataRoot, "private", "npm-runtime"))).sort().join(), "active.json,versions", "the runtime folder holds only versions, as before");
  } finally {
    await remove(dataRoot, ownerHome);
  }
});

test("C13: every run gets new, empty configuration files; nothing planted in the private folder is read back", async () => {
  const dataRoot = await temporary("narrarium-npm-data-");
  try {
    const npm = recordingNpm();
    const installer = new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner, environment: systemEnvironment() });
    await installer.latestVersion();
    const home = path.join(dataRoot, "private", "npm-home");
    // Somebody plants configuration where a stable name might be expected.
    await writeFile(path.join(home, "userconfig"), "registry=http://evil.invalid/\n//evil.invalid/:_authToken=x\n");
    await writeFile(path.join(home, "globalconfig"), "ignore-scripts=false\n");
    await writeFile(path.join(home, "home", ".npmrc"), "registry=http://evil.invalid/\n");
    await installer.latestVersion();
    const [first, second] = npm.calls;
    const flag = (call, name) => call.args[call.args.indexOf(name) + 1];
    for (const call of [first, second]) {
      assert.deepEqual(call["--userconfig"], { file: true, size: 0 });
      assert.deepEqual(call["--globalconfig"], { file: true, size: 0 });
    }
    assert.notEqual(flag(first, "--userconfig"), flag(second, "--userconfig"), "a run never reuses the files of another");
    assert.notEqual(flag(second, "--userconfig"), path.join(home, "userconfig"));
    assert.notEqual(flag(second, "--globalconfig"), path.join(home, "globalconfig"));
  } finally {
    await remove(dataRoot);
  }
});

test("C13: concurrent npm runs do not share a working folder", async () => {
  const dataRoot = await temporary("narrarium-npm-data-");
  try {
    const npm = recordingNpm();
    const installer = new RuntimeInstaller({ dataRoot, npmBinary: "npm", runner: npm.runner, environment: systemEnvironment() });
    await Promise.all([installer.latestVersion(), installer.latestVersion(), installer.latestVersion()]);
    assert.equal(new Set(npm.calls.map((call) => call.cwd)).size, 3);
    for (const call of npm.calls) assert.deepEqual(call.cwdEntries, []);
  } finally {
    await remove(dataRoot);
  }
});

// ---------------------------------------------------------------------------------------------
// With a real npm
// ---------------------------------------------------------------------------------------------

function execNpm(invocation, args, options = {}) {
  return new Promise((resolve) => {
    execFile(invocation.command, [...invocation.prefix, ...args], { encoding: "utf8", timeout: 90_000, windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

/** The npm of this machine, or undefined when it cannot be run without a shell (or is not there). */
async function realNpm() {
  const invocation = npmInvocation();
  if (/\.cmd$/i.test(invocation.command)) return undefined;
  const probe = await execNpm(invocation, ["--version"]);
  return probe.status === 0 ? invocation : undefined;
}

test("C13: a real npm does not read the owner's .npmrc, neither as user nor as project configuration", async (t) => {
  const invocation = await realNpm();
  if (!invocation) return t.skip("npm cannot be run here");
  const root = await temporary("narrarium-npm-real-");
  try {
    // The owner's home folder has a node_modules (very common): npm then takes it for a project and reads its .npmrc.
    const ownerHome = path.join(root, "owner");
    await mkdir(path.join(ownerHome, "node_modules"), { recursive: true });
    await writeFile(path.join(ownerHome, ".npmrc"), "init-author-name=OWNER_MARKER\n//registry.npmjs.org/:_authToken=npm_OWNER_SECRET\n");
    const dataRoot = path.join(ownerHome, ".local", "share", "narrarium-server");
    await mkdir(dataRoot, { recursive: true });
    const owner = { ...systemEnvironment(), HOME: ownerHome, USERPROFILE: ownerHome, APPDATA: ownerHome, npm_config_init_author_email: "owner@example.invalid" };

    // The control is what the server did before: the owner's environment and the data folder as working folder.
    const control = await execNpm(invocation, ["config", "list", "--json", "--registry=https://registry.npmjs.org"], { cwd: dataRoot, env: sanitizedNpmEnvironment(owner) });
    assert.equal(control.status, 0, control.stderr);
    assert.match(control.stdout, /OWNER_MARKER/, "the control sees the owner's configuration, so this test can tell");

    let listed;
    const runner = async (command, args, options) => {
      const at = args.indexOf("view");
      // The flags the installer puts after `view <package> version --json`, handed to `npm config list` instead.
      listed = await execNpm({ command, prefix: args.slice(0, at) }, ["config", "list", "--json", ...args.slice(at + 4)], { cwd: options.cwd, env: options.env });
      return { code: 0, stdout: JSON.stringify("0.2.0"), stderr: "" };
    };
    await new RuntimeInstaller({ dataRoot, runner, environment: owner }).latestVersion();
    assert.equal(listed.status, 0, listed.stderr);
    const effective = JSON.parse(listed.stdout);
    assert.notEqual(effective["init-author-name"], "OWNER_MARKER", "the owner's .npmrc was not loaded");
    assert.ok(!/OWNER_MARKER|OWNER_SECRET|owner@example\.invalid/.test(listed.stdout), listed.stdout);
    assert.ok(!Object.keys(effective).some((key) => key.includes("_authToken")), "no credentials in the configuration npm ran with");
    assert.equal(effective["ignore-scripts"], true);
    assert.equal(effective["update-notifier"], false);
    // npm hides some of its own settings in this listing (and which ones varies a little between versions).
    for (const key of ["userconfig", "cache"]) if (effective[key] !== undefined) assert.ok(inside(dataRoot, effective[key]), `${key}: ${effective[key]}`);
  } finally {
    await remove(root);
  }
});

test("C13: a real npm never sends the owner's registry token to whatever answers as the registry", async (t) => {
  const invocation = await realNpm();
  if (!invocation) return t.skip("npm cannot be run here");
  const seen = [];
  const registry = http.createServer((request, response) => {
    seen.push(request.headers.authorization ?? null);
    response.setHeader("content-type", "application/json");
    const { port } = registry.address();
    response.end(JSON.stringify({ name: PACKAGE_NAME, "dist-tags": { latest: "0.2.0" }, versions: { "0.2.0": { name: PACKAGE_NAME, version: "0.2.0", dist: { tarball: `http://127.0.0.1:${port}/x.tgz`, integrity: `sha512-${"A".repeat(86)}==` } } } }));
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const { port } = registry.address();
  const root = await temporary("narrarium-npm-token-");
  try {
    const ownerHome = path.join(root, "owner");
    await mkdir(path.join(ownerHome, "node_modules"), { recursive: true });
    await writeFile(path.join(ownerHome, ".npmrc"), `//127.0.0.1:${port}/:_authToken=npm_OWNER_SECRET\n`);
    const dataRoot = path.join(ownerHome, ".local", "share", "narrarium-server");
    await mkdir(dataRoot, { recursive: true });
    const owner = { ...systemEnvironment(), HOME: ownerHome, USERPROFILE: ownerHome, APPDATA: ownerHome };
    const local = `--registry=http://127.0.0.1:${port}`;

    const control = await execNpm(invocation, ["view", PACKAGE_NAME, "version", "--json", local], { cwd: dataRoot, env: sanitizedNpmEnvironment(owner) });
    assert.equal(control.status, 0, control.stderr);
    assert.ok(seen.includes("Bearer npm_OWNER_SECRET"), "the control run sends the owner's token (this is the leak)");
    seen.length = 0;

    // The installer's own flow against a registry on this computer: its command line, its environment, its working folder.
    const runner = async (command, args, options) => {
      const real = await execNpm({ command, prefix: [] }, args.map((arg) => (arg === "--registry=https://registry.npmjs.org" ? local : arg)), { cwd: options.cwd, env: options.env });
      return { code: real.status, stdout: real.stdout, stderr: real.stderr };
    };
    assert.equal(await new RuntimeInstaller({ dataRoot, runner, environment: owner }).latestVersion(), "0.2.0");
    assert.ok(seen.length > 0, "npm did ask the registry");
    assert.deepEqual(seen.filter((header) => header !== null), [], "and it sent no credentials");
  } finally {
    await new Promise((resolve) => {
      registry.close(() => resolve());
      registry.closeAllConnections();
    });
    await remove(root);
  }
});
