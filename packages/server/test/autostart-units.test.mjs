import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { LAUNCHD_LABEL, renderLaunchAgent, renderUserService } from "../dist/testing.mjs";

const posix = process.platform !== "win32";
const node = path.resolve(os.tmpdir(), "node-bin", "bin", "node");
const active = { version: "0.2.0", packageRoot: path.resolve(os.tmpdir(), "narrarium", "private", "npm-runtime", "versions", "0.2.0") };
const dataRoot = path.resolve(os.tmpdir(), "narrarium data");
const SEARCH_PATH = "/usr/local/bin:/usr/bin:/home/writer/.nvm/versions/node/v22.14.0/bin";
const nodeDirectory = path.dirname(node);

/** How systemd wants a word of ExecStart= written: quoted, with \ and " escaped, % doubled and $ doubled. */
const execWord = (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
/** How systemd wants an Environment= assignment written: quoted as a whole, \ and " escaped, % doubled, $ left alone. */
const environmentLine = (value) => `Environment="PATH=${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

const line = (text, name) => text.split("\n").find((entry) => entry.startsWith(`${name}=`));
const section = (text, name) => {
  const start = text.indexOf(`[${name}]`);
  const next = text.indexOf("\n[", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
};

test("C22: the systemd unit refuses a control character in any value, so a newline cannot add a line", () => {
  for (const control of ["\n", "\r", "\r\n", "\0", "\u001b", "\u007f", "\u2028"]) {
    const label = JSON.stringify(control);
    assert.throws(() => renderUserService(active, `${dataRoot}${control}ExecStartPost=/bin/sh -c "id > /tmp/x"`, node, SEARCH_PATH), /control character/i, `data folder ${label}`);
    assert.throws(() => renderUserService({ ...active, packageRoot: `${active.packageRoot}${control}x` }, dataRoot, node, SEARCH_PATH), /control character/i, `runtime folder ${label}`);
    assert.throws(() => renderUserService(active, dataRoot, `${node}${control}x`, SEARCH_PATH), /control character/i, `node binary ${label}`);
    assert.throws(() => renderUserService(active, dataRoot, node, `${SEARCH_PATH}${control}ExecStartPost=/bin/false`), /control character/i, `PATH ${label}`);
  }
  const clean = renderUserService(active, dataRoot, node, SEARCH_PATH);
  assert.equal(clean.split("\n").filter((entry) => entry.startsWith("ExecStart")).length, 1, "one ExecStart and nothing else that executes");
  assert.equal(clean.split("\n").some((entry) => entry.startsWith("ExecStartPost=") || entry.startsWith("ExecStartPre=")), false);
});

test("C22: the systemd unit escapes % and $ in what the manager would expand", () => {
  const folder = path.resolve(os.tmpdir(), "Books $HOME 100% ${USER} %h");
  const unit = renderUserService(active, folder, node, SEARCH_PATH);
  const exec = line(unit, "ExecStart");
  assert.ok(exec.endsWith(` start --data-root ${execWord(folder)}`), exec);
  assert.ok(exec.includes("$$HOME") && exec.includes("$${USER}") && exec.includes("100%% ") && exec.includes("%%h"), exec);
  assert.equal(/\$/.test(exec.replace(/\$\$/g, "")), false, "no single dollar sign is left");
  assert.equal(/%/.test(exec.replace(/%%/g, "")), false, "no single percent sign is left");
  // Quotes and backslashes cannot end the quoted word.
  const quoted = renderUserService(active, path.resolve(os.tmpdir(), 'say "hi" \\ there'), node, SEARCH_PATH);
  assert.ok(line(quoted, "ExecStart").includes('\\"hi\\"'), line(quoted, "ExecStart"));
});

test("C22: the systemd unit has a start limit, so a crash loop ends instead of restarting every five seconds for ever", () => {
  const unit = renderUserService(active, dataRoot, node, SEARCH_PATH);
  const unitSection = section(unit, "Unit");
  assert.match(unitSection, /^StartLimitIntervalSec=300$/m);
  assert.match(unitSection, /^StartLimitBurst=10$/m);
  assert.doesNotMatch(section(unit, "Service"), /StartLimit/, "they belong to [Unit]");
  assert.match(unit, /^Restart=on-failure$/m, "it still restarts after a crash");
  assert.match(unit, /^RestartSec=\d+$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("C22: the systemd unit carries the PATH of the shell that ran setup, so npm, git and cloudflared are found", () => {
  const unit = renderUserService(active, dataRoot, node, SEARCH_PATH);
  assert.equal(line(unit, "Environment"), environmentLine(`${nodeDirectory}:${SEARCH_PATH}`), "the PATH, led by the folder of the node that runs the supervisor");
  assert.match(section(unit, "Service"), /^Environment=/m, "in the [Service] section");

  const odd = renderUserService(active, dataRoot, node, `/opt/My Tools/bin:/opt/100%/bin:/opt/"q"`);
  assert.equal(line(odd, "Environment"), environmentLine(`${nodeDirectory}:/opt/My Tools/bin:/opt/100%/bin:/opt/"q"`), "spaces are quoted, % doubled, a quote escaped");
  const dollars = renderUserService(active, dataRoot, node, "/opt/$HOME/bin");
  assert.match(line(dollars, "Environment"), /\/opt\/\$HOME\/bin"$/, "Environment= does no variable expansion: a dollar sign stays one");

  const empty = renderUserService(active, dataRoot, node, "");
  assert.equal(line(empty, "Environment"), environmentLine(nodeDirectory), "an empty PATH leaves only the folder of node");
  if (posix) {
    // Where PATH entries and the node folder use the same separator, the folder is not added twice.
    const known = renderUserService(active, dataRoot, node, `/usr/bin:${nodeDirectory}:/bin`);
    assert.equal(line(known, "Environment"), environmentLine(`/usr/bin:${nodeDirectory}:/bin`));
  }
});

test("C22: the launch agent refuses a control character in any value", () => {
  for (const control of ["\n", "\r", "\0", "\u001b", "\u007f"]) {
    const label = JSON.stringify(control);
    assert.throws(() => renderLaunchAgent(active, `${dataRoot}${control}x`, node, SEARCH_PATH), /control character/i, `data folder ${label}`);
    assert.throws(() => renderLaunchAgent({ ...active, packageRoot: `${active.packageRoot}${control}x` }, dataRoot, node, SEARCH_PATH), /control character/i, `runtime folder ${label}`);
    assert.throws(() => renderLaunchAgent(active, dataRoot, `${node}${control}x`, SEARCH_PATH), /control character/i, `node binary ${label}`);
    assert.throws(() => renderLaunchAgent(active, dataRoot, node, `${SEARCH_PATH}${control}x`), /control character/i, `PATH ${label}`);
  }
});

test("C22: the launch agent is XML-escaped, throttled, and carries the PATH of the setup shell", () => {
  const folder = path.resolve(os.tmpdir(), `Narrarium & <Co> "quoted" 'single'`);
  const plist = renderLaunchAgent(active, folder, node, `/opt/a&b:/opt/<x>:/opt/"q"`);
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/, "launchd's own restart limit");
  assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>[^<]*<\/string>\s*<\/dict>/);
  const xml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  assert.ok(plist.includes(`<string>${xml(`${nodeDirectory}:/opt/a&b:/opt/<x>:/opt/"q"`)}</string>`), "the PATH is escaped and led by the node folder");
  assert.ok(plist.includes(`<string>${xml(path.resolve(folder))}</string>`), "the data folder argument is escaped");
  assert.ok(plist.includes(`<string>${xml(path.join(path.resolve(folder), "server.log"))}</string>`), "so are the log paths");
  // No raw markup character survives inside any text node.
  const text = [...plist.matchAll(/<string>([^]*?)<\/string>/g)].map((match) => match[1]);
  assert.ok(text.length >= 8);
  for (const value of text) assert.equal(/[<>"']|&(?!(amp|lt|gt|quot|apos);)/.test(value), false, value);
  assert.equal(plist.includes("<Co>"), false);
});

test("C22: the generators stay usable without an explicit PATH (the process's own is used)", () => {
  const unit = renderUserService(active, dataRoot, node);
  assert.match(unit, /^ExecStart="/m);
  assert.match(unit, /^StartLimitBurst=10$/m);
  const plist = renderLaunchAgent(active, dataRoot, node);
  assert.match(plist, /<key>ThrottleInterval<\/key>/);
});

test("C22: the PATH carried into the unit and the agent keeps absolute entries only (a relative one would be looked up in whatever folder the service starts in)", () => {
  const unit = renderUserService(active, dataRoot, node, "/usr/bin:bin:.:./tools:..:/opt/tools:~/bin:$HOME/bin:/usr/local/bin");
  assert.equal(line(unit, "Environment"), environmentLine(`${nodeDirectory}:/usr/bin:/opt/tools:/usr/local/bin`), "only the absolute entries (and the folder of node)");
  const plist = renderLaunchAgent(active, dataRoot, node, "bin:/usr/bin:.:/opt/homebrew/bin");
  assert.ok(plist.includes(`<string>${nodeDirectory}:/usr/bin:/opt/homebrew/bin</string>`), "the same for the launch agent");
  const nothing = renderUserService(active, dataRoot, node, "bin:.:");
  assert.equal(line(nothing, "Environment"), environmentLine(nodeDirectory), "nothing absolute: only the folder of node");
});

test("C22: a character that cannot be written into an XML file (or into a unit) at all is refused up front", () => {
  for (const bad of ["\uFFFE", "\uFFFF", "\uD800", "\uDFFF", "a\uD83Db"]) {
    const label = JSON.stringify(bad);
    assert.throws(() => renderLaunchAgent(active, `${dataRoot}${bad}x`, node, SEARCH_PATH), /control character|cannot be written/i, `data folder ${label}`);
    assert.throws(() => renderUserService(active, `${dataRoot}${bad}x`, node, SEARCH_PATH), /control character|cannot be written/i, `data folder ${label}`);
  }
  // Characters outside the basic plane that are valid are fine, in a pair.
  assert.doesNotThrow(() => renderLaunchAgent(active, `${dataRoot}-\u{1F4D6}`, node, SEARCH_PATH));
});
