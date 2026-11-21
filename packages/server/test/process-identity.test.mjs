import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processIdentity, programName } from "../dist/testing.mjs";

const until = async (probe, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("R10: the program of a Linux process is not the name Node 24 gives to the main thread of every process", () => {
  // `comm` is the name a program was started under, except that Node 24 calls its main thread `MainThread`.
  assert.equal(programName({ comm: "MainThread", argv0: "/usr/bin/node", exe: "/usr/bin/node" }), "node");
  assert.equal(programName({ comm: "MainThread", argv0: "node", exe: "/opt/node/bin/node" }), "node");
  assert.equal(programName({ comm: "MainThread", argv0: "/opt/connectors/cloudflared", exe: "/usr/bin/node" }), "cloudflared", "a link to node called cloudflared is cloudflared");
  assert.equal(programName({ comm: "MainThread", argv0: "", exe: "/usr/bin/node (deleted)" }), "node", "a program replaced while it runs");
  assert.equal(programName({ comm: "MainThread", argv0: undefined, exe: undefined }), "MainThread", "nothing better is known");
  // Every other program keeps the name the system gives it.
  assert.equal(programName({ comm: "node", argv0: "node", exe: "/usr/bin/node" }), "node");
  assert.equal(programName({ comm: "cloudflared", argv0: "cloudflared", exe: "/usr/local/bin/cloudflared" }), "cloudflared");
  assert.equal(programName({ comm: "cloudflared", argv0: "/usr/local/bin/cloudflared", exe: "/usr/local/bin/cloudflared" }), "cloudflared");
  assert.equal(programName({ comm: "node", argv0: "node: worker", exe: "/usr/bin/node" }), "node", "a process that changed its title is still its program");
});

test("R10: a real process is known by its program on this system, also when the runtime names its threads", async (t) => {
  if (process.platform === "win32") return t.skip("PowerShell is slow here; the names are checked with the injected identities");
  const mine = await processIdentity(process.pid);
  assert.ok(mine, "this process");
  assert.match(mine.name, /node/i, `this process is ${mine.name}`);

  // A link to node called `cloudflared`: the system calls the process by the name it was started under.
  const directory = await mkdtemp(path.join(os.tmpdir(), "narrarium-identity-"));
  try {
    if (process.platform !== "linux") return;
    const program = path.join(directory, "cloudflared");
    await symlink(process.execPath, program);
    const child = spawn(program, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const identity = await until(() => processIdentity(child.pid));
      assert.match(identity.name, /cloudflared/, `the link is ${identity.name}`);
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
