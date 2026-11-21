import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Auth, Vault } from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";

const OWNER = "198.51.100.4";
const ATTACKER = "203.0.113.9";
const PER_SOURCE = 10;
const IN_ALL = 50;
const JSON_HEADERS = { "content-type": "application/json" };

async function withAuth(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-sessions-"));
  try {
    const vault = await Vault.open(root);
    const auth = await Auth.open(root, vault);
    const code = (await readFile(path.join(root, "private", "admin-code.txt"), "utf8")).trim();
    await run(auth, code);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const works = (auth, session) => {
  try {
    auth.adminSession(session.cookie, session.csrf);
    return true;
  } catch {
    return false;
  }
};

/** The clock moves for everybody (sessions read `Date.now`); the original is always put back. */
async function withClock(run) {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try {
    await run((milliseconds) => {
      offset += milliseconds;
    });
  } finally {
    Date.now = real;
  }
}

test("S1: a flood of sign-ins from one source never ends the owner's session (it used to wipe all of them at the 21st)", async () => {
  await withAuth(async (auth, code) => {
    const owner = await auth.login(code, OWNER);
    const flood = [];
    for (let index = 0; index < 40; index += 1) flood.push(await auth.login(code, ATTACKER));
    assert.equal(works(auth, owner), true, "the owner's session from another source is untouched");
    assert.equal(works(auth, flood.at(-1)), true, "the newest session of the flooding source works");
    assert.equal(flood.filter((session) => works(auth, session)).length, PER_SOURCE, "a source keeps at most ten sessions");
    assert.equal(works(auth, flood[0]), false, "and it is its own oldest ones that go");
    assert.deepEqual(flood.slice(-PER_SOURCE).map((session) => works(auth, session)), Array(PER_SOURCE).fill(true), "the newest ten stay");
  });
});

test("S1: the table is bounded in all, and filling it removes only the oldest sessions, not every session", async () => {
  await withAuth(async (auth, code) => {
    const sessions = [];
    for (let index = 0; index < IN_ALL + 12; index += 1) sessions.push(await auth.login(code, `192.0.2.${index + 1}`));
    const alive = sessions.map((session) => works(auth, session));
    assert.equal(alive.filter(Boolean).length, IN_ALL, "fifty sessions in all");
    assert.deepEqual(alive.slice(0, 12), Array(12).fill(false), "the twelve oldest went");
    assert.deepEqual(alive.slice(12), Array(IN_ALL).fill(true), "everybody else is still signed in");
  });
});

test("S1: a session that is in use outlives idle ones when the table is full", async () => {
  await withAuth(async (auth, code) => {
    const owner = await auth.login(code, OWNER);
    const others = [];
    for (let index = 0; index < IN_ALL + 5; index += 1) {
      others.push(await auth.login(code, `192.0.2.${index + 1}`));
      assert.equal(works(auth, owner), true, `the owner's open panel keeps polling (round ${index})`);
    }
    assert.equal(works(auth, owner), true, "the busy session was never the one to leave");
    assert.equal(works(auth, others[0]), false, "an idle one was");
  });
});

test("S1: expired sessions leave first, so a full table of dead sessions costs nobody a live one", async () => {
  await withClock(async (later) => {
    await withAuth(async (auth, code) => {
      const old = [];
      for (let index = 0; index < IN_ALL; index += 1) old.push(await auth.login(code, `192.0.2.${index + 1}`));
      later(31 * 60_000);
      assert.equal(works(auth, old[0]), false, "the sessions are over");
      const fresh = await auth.login(code, OWNER);
      const second = await auth.login(code, ATTACKER);
      assert.equal(works(auth, fresh) && works(auth, second), true);
      for (let index = 0; index < IN_ALL; index += 1) assert.equal(works(auth, old[index]), false);
      assert.equal(auth.sessionCount, 2, "nothing but the live sessions is kept");
    });
  });
});

test("S1: replacing the admin code still ends every admin session, on purpose, and a failed replacement ends none", async () => {
  await withAuth(async (auth, code) => {
    const sessions = [await auth.login(code, OWNER), await auth.login(code, ATTACKER)];
    await assert.rejects(() => auth.replaceAdminCode("too short"));
    assert.deepEqual(sessions.map((session) => works(auth, session)), [true, true]);
    const next = await auth.rotateAdminCode();
    assert.deepEqual(sessions.map((session) => works(auth, session)), [false, false], "a new code ends the sessions that were opened with the old one");
    assert.ok((await auth.login(next, OWNER)).csrf);
  });
});

test("S1: through the panel, a flood of sign-ins from other addresses leaves the owner signed in", async () => {
  await withServer(async (server) => {
    await server.data.updateConfig((config) => {
      config.publicUrl = "https://books.example.com";
      config.adminPublicUrl = "https://admin.example.com";
      config.allowRemoteAdmin = true;
    });
    const code = (await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim();
    const signIn = async (ip) => {
      const response = await fetch(`${server.adminUrl}/admin/api/login`, { method: "POST", headers: { origin: server.adminUrl, ...JSON_HEADERS, "cf-connecting-ip": ip }, body: JSON.stringify({ code }) });
      assert.equal(response.status, 200);
      return { cookie: response.headers.get("set-cookie").split(";")[0] };
    };
    const owner = await signIn(OWNER);
    for (let index = 0; index < 30; index += 1) await signIn(ATTACKER);
    const status = await fetch(`${server.adminUrl}/admin/api/status`, { headers: { origin: server.adminUrl, cookie: owner.cookie } });
    assert.equal(status.status, 200, "the owner's browser tab is still signed in");
  });
});
