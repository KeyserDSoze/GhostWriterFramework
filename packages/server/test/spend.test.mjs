import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NarrariumServerClient } from "narrarium-engine";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
// New exports are read through the namespace, so a missing one fails the test that needs it and nothing else.
import * as testing from "../dist/testing.mjs";
import { adminLogin, noRelease, until, withServer } from "./helpers.mjs";
import { ONE_CHAPTER, aiConfigFor, approve, fakeProvider, finished, seededBook } from "./fake-provider.mjs";

const DAY = "2026-11-22";
const NEXT_DAY = "2026-11-23";
const noTunnel = { findBinary: () => undefined, detectOtherConnectors: async () => [] };
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const temporary = () => mkdtemp(path.join(os.tmpdir(), "narrarium-spend-"));
const refusal = (error) => ({ status: error.status, code: error.code, message: error.message });
const attempt = (action) => action().then(() => ({ status: 200 }), refusal);

const NO_LIMITS = { paused: false, maxTokensPerDay: 0, maxCostPerDay: 0, maxTokensPerRun: 0, maxCostPerRun: 0 };
const limits = (override = {}) => ({ ...NO_LIMITS, ...override });
/** What `createFetchAi`'s `onAttemptEnd` hook says about an attempt that worked: 100 + 50 tokens, priced at 0.15. */
const ended = (override = {}) => ({ outcome: "ok", usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, usageKnown: true, cost: 0.15, costKnown: true, currency: "USD", ...override });

const spendFile = (root) => path.join(root, "private", "spend.json");
const readSpend = async (server) => {
  await server.spend.flush();
  return JSON.parse(await readFile(spendFile(server.data.root), "utf8"));
};
/** What the record says of the latest run of a book (the runs are a list: a book id is never a key of the file). */
const runOf = (stored, bookId) => stored.runs.find((run) => run.bookId === bookId);

/** The ledgers opened by the test that is running: what they still have to write goes to disk before the folder is removed. */
const opened = new Set();

/** A ledger in a folder of its own, with the clock in the test's hands. */
async function ledgerIn(directory, { day = DAY, log } = {}) {
  const clock = { now: new Date(`${day}T10:00:00.000Z`) };
  const ledger = await testing.SpendLedger.open({ file: path.join(directory, "spend.json"), now: () => clock.now, ...(log ? { log } : {}) });
  opened.add(ledger);
  return { ledger, clock };
}

async function withFolder(run) {
  const directory = await temporary();
  try {
    await run(directory);
  } finally {
    // A write that is still pending would make the folder again after it was removed.
    for (const ledger of opened) await ledger.flush();
    opened.clear();
    await remove(directory);
  }
}

/** A server whose AI is a fake provider (approved and configured), with the clock in the test's hands. */
async function withProvider(run, { provider: providerOptions, pricing, serverOptions } = {}) {
  const provider = await fakeProvider(providerOptions);
  const clock = { now: new Date(`${DAY}T10:00:00.000Z`) };
  try {
    await withServer(async (server, client, dataDir) => {
      const admin = await adminLogin(server);
      await approve(admin, provider.origin);
      await client.putAiConfig(aiConfigFor(provider, { pricing }));
      const bookId = await seededBook(client);
      await run({ server, client, admin, provider, clock, bookId, dataDir });
    }, { ai: undefined, now: () => clock.now, ...serverOptions });
  } finally {
    await provider.close();
  }
}

const setSpend = (admin, changes) => admin.call("POST", "/admin/api/spend", changes);
const PRICED = { inputPerMTok: 1000, outputPerMTok: 1000 };

// ---------------------------------------------------------------------------------------------
// The settings: tolerant when read, strict when the owner changes them
// ---------------------------------------------------------------------------------------------

test("S3: the settings read from a file are tolerant: whatever is not a valid value is no limit, and the switch is on by default", () => {
  const { parseSpendSettings } = testing;
  for (const nothing of [undefined, null, "x", 7, [], {}]) assert.deepEqual(parseSpendSettings(nothing), NO_LIMITS, String(nothing));
  const set = { paused: true, maxTokensPerDay: 5000, maxCostPerDay: 2.5, maxTokensPerRun: 100, maxCostPerRun: 0.5 };
  assert.deepEqual(parseSpendSettings(set), set);
  const junk = { paused: "yes", maxTokensPerDay: -1, maxCostPerDay: "5", maxTokensPerRun: 1.5, maxCostPerRun: Number.POSITIVE_INFINITY, extra: "ignored" };
  assert.deepEqual(parseSpendSettings(junk), NO_LIMITS);
  assert.deepEqual(parseSpendSettings({ maxTokensPerDay: 1e15, maxCostPerDay: 1e9, maxTokensPerRun: Number.NaN }), NO_LIMITS, "values over the ceilings are not believed either");
  assert.deepEqual(parseSpendSettings({ maxTokensPerDay: 100, maxCostPerRun: "x" }), limits({ maxTokensPerDay: 100 }), "one bad value does not take the others with it");
  assert.deepEqual(Object.keys(parseSpendSettings({ ...set, unknown: 1 })).sort(), Object.keys(NO_LIMITS).sort());
});

test("S3: the owner's changes are validated (whole tokens, costs of 0 or more, a reasonable ceiling), applied one by one and refused with the field's name", () => {
  const { applySpendChanges, HttpError, MAX_SPEND_TOKENS, MAX_SPEND_COST } = testing;
  const current = limits({ maxTokensPerDay: 1000, maxCostPerRun: 2 });
  assert.deepEqual(applySpendChanges(current, {}), current, "nothing asked, nothing changed");
  assert.deepEqual(applySpendChanges(current, { maxTokensPerRun: 10 }), { ...current, maxTokensPerRun: 10 }, "the rest is kept");
  assert.deepEqual(applySpendChanges(current, { paused: true, maxTokensPerDay: 0, maxCostPerDay: 1.25 }), { ...current, paused: true, maxTokensPerDay: 0, maxCostPerDay: 1.25 });
  assert.deepEqual(applySpendChanges(current, { paused: false, somethingElse: "ignored" }), current);
  assert.equal(applySpendChanges(limits(), { maxTokensPerDay: MAX_SPEND_TOKENS }).maxTokensPerDay, MAX_SPEND_TOKENS);
  assert.equal(applySpendChanges(limits(), { maxCostPerDay: MAX_SPEND_COST }).maxCostPerDay, MAX_SPEND_COST);
  const wrong = [
    ["maxTokensPerDay", -1], ["maxTokensPerDay", 1.5], ["maxTokensPerDay", "10"], ["maxTokensPerDay", null], ["maxTokensPerDay", Number.NaN], ["maxTokensPerDay", MAX_SPEND_TOKENS + 1],
    ["maxCostPerDay", -0.01], ["maxCostPerDay", "1"], ["maxCostPerDay", Number.POSITIVE_INFINITY], ["maxCostPerDay", MAX_SPEND_COST + 1],
    ["maxTokensPerRun", -5], ["maxCostPerRun", true], ["paused", "yes"], ["paused", 1], ["paused", null],
  ];
  for (const [field, value] of wrong) {
    assert.throws(() => applySpendChanges(current, { [field]: value }), (error) => error instanceof HttpError && error.status === 422 && error.code === "invalid_spend" && error.message.includes(field), `${field}: ${value}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

test("S3: every attempt is counted as the hook reports it: tokens (estimated ones too), known and unknown costs, failed attempts that used tokens", async () => {
  await withFolder(async (directory) => {
    const { ledger } = await ledgerIn(directory);
    ledger.record(ended());
    ledger.record(ended({ outcome: "failed", usage: { inputTokens: 40, outputTokens: 0, cachedInputTokens: 0 }, cost: 0.01 }));
    ledger.record(ended({ outcome: "failed", usage: undefined, usageKnown: false, cost: undefined, costKnown: false }));
    ledger.record(ended({ usageKnown: false, costKnown: false, usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, cost: 0.02 }));
    ledger.record(ended({ cost: undefined, costKnown: false, usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 3 } }));
    ledger.record(ended({ outcome: "cancelled", usage: undefined, usageKnown: false, cost: undefined, costKnown: false }));
    const { today } = ledger.status(limits());
    assert.equal(today.day, DAY);
    assert.equal(today.calls, 6, "every attempt that was sent is a call");
    assert.equal(today.tokens, 150 + 40 + 20 + 10, "tokens that were reported or estimated; cached tokens are part of the input, not more");
    assert.ok(Math.abs(today.cost - 0.18) < 1e-9, `costs the hook gave: ${today.cost}`);
    assert.equal(today.currency, "USD");
    assert.equal(today.costUnknownCalls, 2, "the calls that used tokens whose cost is a guess or has no price; a call that used nothing has no cost to know");
  });
});

test("S3: a day with no known cost says no cost, and a day with one says it and its currency", async () => {
  await withFolder(async (directory) => {
    const { ledger } = await ledgerIn(directory);
    assert.deepEqual(ledger.status(limits()).today, { day: DAY, tokens: 0, calls: 0 });
    ledger.record(ended({ cost: undefined, costKnown: false }));
    const unknown = ledger.status(limits()).today;
    assert.equal(unknown.cost, undefined);
    assert.equal(unknown.currency, undefined);
    assert.equal(unknown.costUnknownCalls, 1);
    ledger.record(ended());
    assert.deepEqual(ledger.status(limits()).today, { day: DAY, tokens: 300, calls: 2, cost: 0.15, currency: "USD", costUnknownCalls: 1 });
  });
});

test("S3: the day is the UTC day of the clock: a new day starts from zero, and only the last 31 days are kept", async () => {
  await withFolder(async (directory) => {
    const { ledger, clock } = await ledgerIn(directory);
    ledger.record(ended());
    clock.now = new Date(`${DAY}T23:59:59.999Z`);
    assert.equal(ledger.status(limits()).today.tokens, 150, "still the same UTC day a millisecond before midnight");
    clock.now = new Date(`${NEXT_DAY}T00:00:00.000Z`);
    assert.deepEqual(ledger.status(limits()).today, { day: NEXT_DAY, tokens: 0, calls: 0 });
    ledger.record(ended({ cost: undefined, costKnown: false }));
    assert.equal(ledger.status(limits()).today.tokens, 150);
    // Forty days on.
    for (let offset = 2; offset < 42; offset += 1) {
      clock.now = new Date(Date.UTC(2026, 10, 22 + offset, 12));
      ledger.record(ended());
    }
    await ledger.flush();
    const stored = JSON.parse(await readFile(path.join(directory, "spend.json"), "utf8"));
    const days = Object.keys(stored.days).sort();
    assert.equal(days.length, 31);
    assert.equal(days.at(-1), clock.now.toISOString().slice(0, 10));
    assert.ok(!days.includes(DAY), "the oldest are gone");
  });
});

test("S3: the record is written atomically in private/ (0600), survives a restart, and holds numbers and ids only", async () => {
  await withFolder(async (directory) => {
    const { ledger } = await ledgerIn(directory);
    ledger.beginRun("book-1", "run-1");
    ledger.record({ ...ended(), text: "THE PROMPT AND THE REPLY", error: "sk-secret-key leaked in an error", apiKey: "sk-secret-key" }, { bookId: "book-1", runId: "run-1" });
    await ledger.flush();
    const file = path.join(directory, "spend.json");
    const text = await readFile(file, "utf8");
    const stored = JSON.parse(text);
    assert.equal(stored.version, 1);
    assert.equal(stored.days[DAY].tokens, 150);
    assert.equal(runOf(stored, "book-1").runId, "run-1");
    assert.equal(runOf(stored, "book-1").tokens, 150);
    assert.equal(/sk-secret|PROMPT|REPLY/.test(text), false, "nothing but what was measured");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(directory)).filter((name) => name !== "spend.json"), [], "no temporary file is left");

    const reopened = (await ledgerIn(directory)).ledger;
    assert.deepEqual(reopened.status(limits()).today, ledger.status(limits()).today);
    assert.equal(reopened.warning, undefined);
  });
});

test("S3: a book id that looks like an object key (constructor, __proto__, prototype) is no reason to lose the totals: the record is read back whole", async () => {
  await withFolder(async (directory) => {
    const { ledger } = await ledgerIn(directory);
    for (const book of ["constructor", "__proto__", "prototype", "toString"]) {
      ledger.beginRun(book, `run-of-${book}`);
      ledger.record(ended(), { bookId: book, runId: `run-of-${book}` });
    }
    await ledger.flush();
    const reopened = (await ledgerIn(directory)).ledger;
    assert.equal(reopened.warning, undefined, "the file is readable: it is not taken for a damaged one, which would give the day's allowance back");
    assert.equal(reopened.status(limits()).today.tokens, 600);
    for (const book of ["constructor", "__proto__", "prototype", "toString"]) assert.equal(reopened.run(book)?.tokens, 150, book);
  });
});

test("S3: a record that is damaged does not stop anything: it starts from zero, says so, and keeps the damaged copy aside", async () => {
  const wrong = { garbage: "{ this is not json", array: "[]", version: '{"version": 7, "days": {}}', empty: "" };
  for (const [name, content] of Object.entries(wrong)) {
    await withFolder(async (directory) => {
      await writeFile(path.join(directory, "spend.json"), content);
      const lines = [];
      const { ledger } = await ledgerIn(directory, { log: (line) => lines.push(line) });
      assert.equal(ledger.status(limits()).today.tokens, 0, name);
      assert.match(ledger.warning ?? "", /spend\.json/, name);
      assert.match(ledger.warning ?? "", /zero/i, name);
      assert.ok(lines.some((line) => /^Spend/.test(line) && /spend\.json/.test(line)), `${name}: ${lines.join(" | ")}`);
      assert.equal(await readFile(path.join(directory, "spend.json.damaged"), "utf8"), content, "the owner's file is not lost");
      ledger.record(ended());
      await ledger.flush();
      assert.equal(JSON.parse(await readFile(path.join(directory, "spend.json"), "utf8")).days[DAY].tokens, 150, "and the next record is written whole");
    });
  }
  await withFolder(async (directory) => {
    await writeFile(path.join(directory, "spend.json"), `{"version":1,"days":{"${DAY}":{"tokens":${"9".repeat(400000)}}}}`);
    assert.match((await ledgerIn(directory)).ledger.warning ?? "", /too large|spend\.json/, "a record far over its size is not read");
  });
  await withFolder(async (directory) => {
    await writeFile(path.join(directory, "spend.json"), JSON.stringify({ version: 1, days: { [DAY]: { tokens: -5, calls: "many", cost: "x" }, "not-a-day": { tokens: 1 } }, runs: [{ bookId: "book-1", runId: 7 }, { bookId: "", runId: "r" }, "not a record", { runId: "no book" }] }));
    const { ledger } = await ledgerIn(directory);
    assert.equal(ledger.warning, undefined, "a file that parses is read tolerantly, field by field, without alarm");
    assert.deepEqual(ledger.status(limits()).today, { day: DAY, tokens: 0, calls: 0 });
  });
});

test("S3: the record stays small whatever happens: 31 days and 200 books at most", async () => {
  await withFolder(async (directory) => {
    const { ledger, clock } = await ledgerIn(directory);
    for (let book = 0; book < 260; book += 1) {
      clock.now = new Date(Date.UTC(2026, 0, 1 + (book % 90), 12));
      ledger.beginRun(`book-${book}`, `run-${book}`);
      ledger.record(ended(), { bookId: `book-${book}`, runId: `run-${book}` });
      if (book < 259) ledger.endRun(`book-${book}`, `run-${book}`);
    }
    await ledger.flush();
    const text = await readFile(path.join(directory, "spend.json"), "utf8");
    const stored = JSON.parse(text);
    assert.ok(Object.keys(stored.days).length <= 31);
    assert.ok(stored.runs.length <= 200);
    assert.ok(text.length < 100 * 1024, `${text.length} bytes`);
    assert.equal(ledger.activeRun("book-259"), "run-259", "the run that is active is never the one dropped");
    assert.equal(runOf(stored, "book-259").runId, "run-259");
  });
});

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

test("S3: nothing is allowed while the switch is off; each cap refuses the call once reached, with a message that says which and why", async () => {
  await withFolder(async (directory) => {
    const { SpendLimitError } = testing;
    const { ledger } = await ledgerIn(directory);
    ledger.beginRun("b", "r1");
    const scope = { bookId: "b", runId: "r1" };
    const refused = (settings, who = scope) => {
      try {
        ledger.assertAllowed(settings, who);
      } catch (error) {
        assert.ok(error instanceof SpendLimitError, "a typed error");
        assert.equal(error.retryable, false, "that the engine does not retry");
        assert.equal(error.name, "SpendLimitError");
        return error;
      }
      return null;
    };
    assert.equal(refused(limits()), null, "no limit, nothing refused");
    const paused = refused(limits({ paused: true }));
    assert.equal(paused.reason, "paused");
    assert.match(paused.message, /paused/i);
    assert.match(paused.message, /owner/i);

    ledger.record(ended(), scope);
    ledger.record(ended(), scope);
    assert.equal(refused(limits({ maxTokensPerDay: 301 })), null, "300 used, 301 allowed: the next call may go");
    const day = refused(limits({ maxTokensPerDay: 300 }));
    assert.equal(day.reason, "tokens-per-day");
    assert.match(day.message, /spending cap/i);
    assert.match(day.message, /300 tokens/);
    assert.match(day.message, /today/i);
    assert.match(day.message, /UTC/);
    const costDay = refused(limits({ maxCostPerDay: 0.3 }));
    assert.equal(costDay.reason, "cost-per-day");
    assert.match(costDay.message, /0\.3 USD/);
    const run = refused(limits({ maxTokensPerRun: 250 }));
    assert.equal(run.reason, "tokens-per-run");
    assert.match(run.message, /this run/i);
    assert.match(run.message, /300 tokens/);
    const costRun = refused(limits({ maxCostPerRun: 0.2 }));
    assert.equal(costRun.reason, "cost-per-run");
    assert.equal(refused(limits({ maxTokensPerRun: 250 }), null), null, "a call outside a run (the director) has no run cap");
    assert.equal(refused(limits({ maxTokensPerRun: 250 }), { bookId: "b", runId: "an-older-run" }), null, "nor does one of a run that is not the current");
    assert.equal(refused(limits({ maxTokensPerDay: 300 }), null).reason, "tokens-per-day", "the day's caps apply to every call");
    assert.equal(refused(limits({ paused: true, maxTokensPerDay: 1 })).reason, "paused", "the switch is told first");
  });
});

test("S3: a cost cap applies only to costs that are known: unpriced calls count in tokens, not in the cost", async () => {
  await withFolder(async (directory) => {
    const { ledger } = await ledgerIn(directory);
    for (let call = 0; call < 5; call += 1) ledger.record(ended({ cost: undefined, costKnown: false }));
    assert.doesNotThrow(() => ledger.assertAllowed(limits({ maxCostPerDay: 0.01 })), "750 tokens and no known cost: the cost cap has nothing to count");
    assert.throws(() => ledger.assertAllowed(limits({ maxTokensPerDay: 700 })), /spending cap/i, "the token cap does");
    assert.equal(ledger.status(limits()).today.cost, undefined);
  });
});

test("S3: a run has its own totals, reset when a new run starts; a late attempt of an old run counts in the day only", async () => {
  await withFolder(async (directory) => {
    const { ledger } = await ledgerIn(directory);
    ledger.beginRun("b", "r1");
    ledger.record(ended(), { bookId: "b", runId: "r1" });
    ledger.record(ended(), { bookId: "b", runId: "r1" });
    assert.equal(ledger.run("b").tokens, 300);
    assert.equal(ledger.activeRun("b"), "r1");
    ledger.beginRun("b", "r2");
    assert.equal(ledger.activeRun("b"), "r2");
    assert.deepEqual([ledger.run("b").runId, ledger.run("b").tokens], ["r2", 0], "a new run starts from zero");
    ledger.record(ended(), { bookId: "b", runId: "r1" });
    assert.equal(ledger.run("b").tokens, 0, "an attempt that ends after its run was replaced is not this run's");
    assert.equal(ledger.status(limits()).today.tokens, 450, "but it is spent all the same");
    ledger.record(ended(), { bookId: "b", runId: "r2" });
    ledger.endRun("b", "r2");
    assert.equal(ledger.activeRun("b"), undefined);
    assert.equal(ledger.run("b").tokens, 150, "what the run spent stays after it ended");
    ledger.endRun("b", "r1");
    ledger.beginRun("b", "r3");
    ledger.endRun("b", "r2");
    assert.equal(ledger.activeRun("b"), "r3", "the end of an older run does not end the current one");
    ledger.forgetBook("b");
    assert.equal(ledger.run("b"), undefined);
    assert.equal(ledger.activeRun("b"), undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the server: what is shown, who may change it
// ---------------------------------------------------------------------------------------------

test("S3: GET /api/v1/ai carries the spending status for a client that can only read, in one shape wherever it is read", async () => {
  await withServer(async (server, _client) => {
    const reader = new NarrariumServerClient({ baseUrl: server.url, token: (await server.auth.issue("reader", ["read"])).token });
    const status = await reader.aiStatus();
    assert.deepEqual(Object.keys(status.spend).sort(), ["limits", "paused", "today"]);
    assert.deepEqual(status.spend, { paused: false, today: { day: DAY, tokens: 0, calls: 0 }, limits: { maxTokensPerDay: 0, maxCostPerDay: 0, maxTokensPerRun: 0, maxCostPerRun: 0 } });
    assert.equal(JSON.stringify(status).includes("warning"), false);
    // The same status from the other doors.
    const admin = await adminLogin(server);
    const fromAdmin = (await admin.call("GET", "/admin/api/spend")).body;
    assert.deepEqual(fromAdmin, status.spend, "the panel's reading has the shape of the API's");
    assert.deepEqual((await admin.call("GET", "/admin/api/status")).body.spend, status.spend);
    const writer = new NarrariumServerClient({ baseUrl: server.url, token: (await server.auth.issue("writer", ["read", "write"])).token });
    assert.deepEqual((await writer.putAiConfig({ aiIntegrations: [] })).spend, status.spend, "and so is the answer to a configuration that was sent");
  }, { now: () => new Date(`${DAY}T10:00:00.000Z`) });
});

test("S3: the owner sets the caps and the switch in the panel's API; they are saved in config.json, shown to every client and survive a restart", async () => {
  await withServer(async (server, client, dataDir) => {
    const admin = await adminLogin(server);
    const saved = await setSpend(admin, { maxTokensPerDay: 50_000, maxCostPerDay: 2.5, maxTokensPerRun: 10_000, maxCostPerRun: 0.5 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const expected = { maxTokensPerDay: 50_000, maxCostPerDay: 2.5, maxTokensPerRun: 10_000, maxCostPerRun: 0.5 };
    assert.deepEqual(saved.body.limits, expected);
    assert.equal(saved.body.paused, false);
    assert.deepEqual((await client.aiStatus()).spend.limits, expected, "the devices see them");
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")).spend, { paused: false, ...expected }, "in config.json, no secret");

    assert.equal((await setSpend(admin, { paused: true })).body.paused, true);
    assert.deepEqual((await client.aiStatus()).spend.limits, expected, "switching off keeps the caps");
    assert.equal((await client.aiStatus()).spend.paused, true);

    for (const bad of [{ maxTokensPerDay: -1 }, { maxTokensPerDay: 1.5 }, { maxCostPerRun: "1" }, { paused: "yes" }, { maxCostPerDay: 1e12 }]) {
      const refused = await setSpend(admin, bad);
      assert.equal(refused.status, 422, JSON.stringify(bad));
      assert.equal(refused.body.code, "invalid_spend");
    }
    assert.deepEqual((await client.aiStatus()).spend.limits, expected, "a refusal changes nothing");

    await server.close();
    const again = await testing.startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: noTunnel });
    try {
      const token = (await again.auth.issue("later", ["read"])).token;
      const later = new NarrariumServerClient({ baseUrl: again.url, token });
      const { spend } = await later.aiStatus();
      assert.equal(spend.paused, true, "the switch is where the owner left it");
      assert.deepEqual(spend.limits, expected);
      assert.equal(spend.today.tokens, 0);
    } finally {
      await again.close();
    }
  });
});

test("S3: with nothing set, config.json says nothing about spending (the setting is optional), and clearing everything removes it again", async () => {
  await withServer(async (server, _client, dataDir) => {
    assert.equal("spend" in JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")), false);
    const admin = await adminLogin(server);
    await setSpend(admin, { maxTokensPerDay: 10 });
    assert.equal(JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")).spend.maxTokensPerDay, 10);
    await setSpend(admin, { maxTokensPerDay: 0 });
    assert.equal("spend" in JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8")), false, "back to the defaults, back to the file of before");
  });
  // An older configuration file is read as it is: no limits, the switch on.
  await withFolder(async (directory) => {
    await writeFile(path.join(directory, "config.json"), JSON.stringify({ version: 2, apiPort: 0, adminPort: 0, allowRemoteAdmin: false, spend: { maxTokensPerDay: "lots", paused: "maybe" } }), { mode: 0o600 });
    const config = await testing.loadServerConfig(directory);
    assert.equal(config.spend, undefined);
  });
});

test("S3: only the owner changes the caps: the devices' API has nothing for it, whatever their permissions, and the panel's rules apply to the panel", async () => {
  await withServer(async (server, _client) => {
    const everything = await server.auth.issue("everything", ["read", "write", "run", "update"]);
    const bearer = { authorization: `Bearer ${everything.token}`, "content-type": "application/json" };
    const call = async (method, route, body) => {
      const response = await fetch(`${server.url}${route}`, { method, headers: bearer, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const change = { paused: true, maxTokensPerDay: 1, maxCostPerDay: 1, maxTokensPerRun: 1, maxCostPerRun: 1 };
    for (const [method, route] of [["PUT", "/api/v1/spend"], ["POST", "/api/v1/spend"], ["POST", "/api/v1/ai/spend"], ["PUT", "/api/v1/ai/spend"], ["POST", "/admin/api/spend"], ["GET", "/admin/api/spend"]]) {
      assert.equal((await call(method, route, change)).status, 404, `${method} ${route}: a client token reaches nothing of the sort`);
    }
    // Sending the configuration with spending fields in it changes the AI configuration and nothing else.
    const sent = await call("PUT", "/api/v1/ai", { config: { aiIntegrations: [] }, spend: change, paused: true, limits: change, maxTokensPerDay: 1 });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.spend.limits, { maxTokensPerDay: 0, maxCostPerDay: 0, maxTokensPerRun: 0, maxCostPerRun: 0 });
    assert.equal(sent.body.spend.paused, false);
    assert.equal(server.data.config.spend, undefined, "the configuration file was not touched");

    // The panel: a session, a CSRF token and the panel's own origin, like every other action there.
    const origin = server.adminUrl;
    const post = (headers, body = change) => fetch(`${origin}/admin/api/spend`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ origin })).status, 401, "no session");
    assert.equal((await fetch(`${origin}/admin/api/spend`, { headers: { origin } })).status, 401, "no session to read either");
    assert.equal((await post({ origin, authorization: `Bearer ${everything.token}` })).status, 401, "a client token is not a session");
    const admin = await adminLogin(server);
    assert.equal((await post({ origin: "https://evil.example", cookie: admin.cookie, "x-csrf-token": admin.csrf })).status, 403, "a page of another origin cannot ask the panel");
    assert.equal((await post({ origin, cookie: admin.cookie })).status, 403, "without the CSRF token");
    assert.equal((await post({ origin, cookie: admin.cookie, "x-csrf-token": "wrong" })).status, 403, "with a wrong one");
    assert.equal(server.data.config.spend, undefined, "none of those changed anything");
    assert.equal((await post({ origin, cookie: admin.cookie, "x-csrf-token": admin.csrf })).status, 200);
    assert.equal(server.data.config.spend.paused, true);
  });
});

// ---------------------------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------------------------

test("S3: with the switch off no AI call is made, for any AI port: a run is not started, the director is refused, and the message names the owner's switch", async () => {
  const fake = createFakeAutopilotAi();
  await withServer(async (server, client) => {
    const bookId = await seededBook(client);
    const admin = await adminLogin(server);
    await setSpend(admin, { paused: true });
    const start = await attempt(() => client.startAutopilot(bookId, ONE_CHAPTER));
    assert.deepEqual([start.status, start.code], [429, "spend_limit"]);
    assert.match(start.message, /paused/i);
    assert.match(start.message, /spend --resume|admin panel/i, "and how the owner turns it on");
    assert.equal((await client.autopilot(bookId)).state, null, "a run that could not make its first call leaves no trace in the book");
    const ask = await attempt(() => client.askDirector(bookId, { target: { kind: "book" } }));
    assert.deepEqual([ask.status, ask.code], [429, "spend_limit"]);
    assert.equal(fake.calls.length, 0, "nothing reached the AI");

    await setSpend(admin, { paused: false });
    await client.startAutopilot(bookId, ONE_CHAPTER);
    assert.equal((await finished(client, bookId)).state.status, "completed", "switched on again, it works");
    assert.ok(fake.calls.length > 0);
  }, { ai: fake });
});

/** An AI whose first call is held until its request is abandoned (as a real request is when the run stops): the rest answer at once. */
function holdFirstCall() {
  const inner = createFakeAutopilotAi();
  let held = false;
  let entered = () => undefined;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  return {
    started,
    ai: {
      async complete(request) {
        if (!held) {
          held = true;
          entered();
          await new Promise((_, reject) => {
            request.signal?.addEventListener("abort", () => reject(request.signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        return inner.complete(request);
      },
    },
  };
}

test("S3: switching off while a run works stops it at once: the call in flight is abandoned, the run is paused (not failed), and it resumes when switched on", async () => {
  const hold = holdFirstCall();
  await withServer(async (server, client) => {
    const bookId = await seededBook(client);
    const admin = await adminLogin(server);
    await client.startAutopilot(bookId, ONE_CHAPTER);
    await hold.started;
    assert.equal(server.books.runningCount(), 1);
    const answer = await setSpend(admin, { paused: true });
    assert.equal(answer.status, 200);
    await until(async () => !(await client.autopilot(bookId)).running, 10_000);
    const snapshot = await client.autopilot(bookId);
    assert.equal(snapshot.state.status, "paused", "a stop the owner asked for is a pause");
    assert.equal(snapshot.state.stats.failures, 0, "and not a failure");
    assert.equal(snapshot.state.message ?? null, null);
    assert.equal((await attempt(() => client.startAutopilot(bookId))).code, "spend_limit", "it cannot be resumed while the switch is off");
    await setSpend(admin, { paused: false });
    await client.startAutopilot(bookId);
    assert.equal((await finished(client, bookId)).state.status, "completed", "switched on again, it resumes where it stopped");
  }, { ai: hold.ai });
});

test("S3: switching off also abandons a director question that is in flight, and the answer is the switch's refusal", async () => {
  let release = () => undefined;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => undefined;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  try {
    await withProvider(async ({ client, admin, provider, bookId }) => {
      const asking = client.askDirector(bookId, { target: { kind: "book" } }).then(() => ({ answered: true }), (error) => ({ refused: refusal(error) }));
      await reached;
      assert.equal((await setSpend(admin, { paused: true })).status, 200);
      const outcome = await Promise.race([asking, new Promise((resolve) => setTimeout(() => resolve({ stuck: true }), 8000))]);
      release();
      assert.equal(outcome.stuck, undefined, "the question was abandoned at once, not left to cost what it costs");
      assert.deepEqual([outcome.refused?.status, outcome.refused?.code], [429, "spend_limit"]);
      assert.match(outcome.refused.message, /paused/i);
      assert.equal(provider.requests.length, 1, "and nothing more was asked");
    }, { provider: { respond: async (number) => {
      if (number === 1) {
        entered();
        await held;
      }
      return undefined;
    } } });
  } finally {
    release();
  }
});

// ---------------------------------------------------------------------------------------------
// The caps, with a provider that reports what it used
// ---------------------------------------------------------------------------------------------

test("S3: the daily token cap stops a run before the call that would go over it; the author reads why, and the run resumes when the owner raises the cap", async () => {
  await withProvider(async ({ client, admin, provider, bookId, server }) => {
    await setSpend(admin, { maxTokensPerDay: 400 });
    await client.startAutopilot(bookId, ONE_CHAPTER);
    const stopped = await finished(client, bookId);
    assert.equal(stopped.state.status, "error", "the run stops");
    assert.match(stopped.state.message, /spending cap/i);
    assert.match(stopped.state.message, /450 tokens/);
    assert.match(stopped.state.message, /400/);
    assert.equal(provider.requests.length, 3, "three calls of 150 tokens: the fourth would start at 450, over the cap of 400");
    assert.doesNotMatch(stopped.state.message, /retry/i, "and it is not retried");
    assert.equal(stopped.state.stats.failures, 1);
    const { spend } = await client.aiStatus();
    assert.equal(spend.today.tokens, 450);
    assert.equal(spend.today.calls, 3);
    assert.equal(spend.limits.maxTokensPerDay, 400);

    // Resuming today is refused, with the same message, and costs nothing.
    const refused = await attempt(() => client.startAutopilot(bookId));
    assert.deepEqual([refused.status, refused.code], [429, "spend_limit"]);
    assert.match(refused.message, /450 tokens/);
    assert.equal(provider.requests.length, 3);

    await setSpend(admin, { maxTokensPerDay: 1000 });
    await client.startAutopilot(bookId);
    const resumed = await finished(client, bookId);
    assert.equal(provider.requests.length, 7, "4 more calls: 450, 600, 750 and 900 were under 1000; 1050 is not");
    assert.equal(resumed.state.status, "error");
    assert.equal((await client.aiStatus()).spend.today.tokens, 1050);

    await setSpend(admin, { maxTokensPerDay: 0 });
    await client.startAutopilot(bookId);
    assert.equal((await finished(client, bookId)).state.status, "completed", "no cap, the book is finished");
    const stored = await readSpend(server);
    assert.equal(stored.days[DAY].tokens, provider.requests.length * 150, "the record agrees with what the provider was asked");
  });
});

test("S3: a new UTC day starts from zero: the run that stopped on the day's cap resumes the next day, and the record keeps both days", async () => {
  await withProvider(async ({ client, admin, provider, clock, bookId, server }) => {
    await setSpend(admin, { maxTokensPerDay: 400 });
    await client.startAutopilot(bookId, ONE_CHAPTER);
    assert.equal((await finished(client, bookId)).state.status, "error");
    assert.equal(provider.requests.length, 3);
    assert.equal((await attempt(() => client.startAutopilot(bookId))).code, "spend_limit");

    clock.now = new Date(`${NEXT_DAY}T00:00:05.000Z`);
    const { spend } = await client.aiStatus();
    assert.deepEqual(spend.today, { day: NEXT_DAY, tokens: 0, calls: 0 });
    await client.startAutopilot(bookId);
    assert.equal((await finished(client, bookId)).state.status, "error", "and meets the cap again, three calls later");
    assert.equal(provider.requests.length, 6);
    const stored = await readSpend(server);
    assert.equal(stored.days[DAY].tokens, 450);
    assert.equal(stored.days[NEXT_DAY].tokens, 450);
  });
});

test("S3: the per-run cap stops a run, and a new run (Resume) starts its count again; the day's total keeps growing", async () => {
  await withProvider(async ({ client, admin, provider, bookId, server }) => {
    await setSpend(admin, { maxTokensPerRun: 400 });
    await client.startAutopilot(bookId, ONE_CHAPTER);
    const first = await finished(client, bookId);
    assert.equal(first.state.status, "error");
    assert.match(first.state.message, /spending cap/i);
    assert.match(first.state.message, /this run/i);
    assert.equal(provider.requests.length, 3);
    const firstRun = runOf(await readSpend(server), bookId);
    assert.equal(firstRun.tokens, 450);

    await client.startAutopilot(bookId);
    const second = await finished(client, bookId);
    assert.equal(second.state.status, "error");
    assert.equal(provider.requests.length, 6, "the second run had its own allowance of three calls");
    const secondRun = runOf(await readSpend(server), bookId);
    assert.notEqual(secondRun.runId, firstRun.runId);
    assert.equal(secondRun.tokens, 450, "its own count, from zero");
    assert.equal((await client.aiStatus()).spend.today.tokens, 900);

    await setSpend(admin, { maxTokensPerRun: 0 });
    await client.startAutopilot(bookId);
    assert.equal((await finished(client, bookId)).state.status, "completed");
  });
});

test("S3: a call outside a run (the director) is counted in the day but has no per-run cap, and a day's cap refuses it", async () => {
  await withProvider(async ({ client, admin, provider, bookId }) => {
    await setSpend(admin, { maxTokensPerRun: 10, maxTokensPerDay: 400 });
    assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise");
    assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise");
    assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise", "450 tokens after the third: over the per-run cap of 10, which is not for this");
    const refused = await attempt(() => client.askDirector(bookId, { target: { kind: "book" } }));
    assert.deepEqual([refused.status, refused.code], [429, "spend_limit"]);
    assert.match(refused.message, /450 tokens/);
    assert.equal(provider.requests.length, 3);
  });
});

test("S3: the cost cap counts the costs the models' prices give, in the currency of the AI settings", async () => {
  await withProvider(async ({ client, admin, provider, bookId, server }) => {
    await setSpend(admin, { maxCostPerDay: 0.25 });
    await client.startAutopilot(bookId, ONE_CHAPTER);
    const stopped = await finished(client, bookId);
    assert.equal(stopped.state.status, "error");
    assert.match(stopped.state.message, /spending cap/i);
    assert.match(stopped.state.message, /USD/);
    assert.equal(provider.requests.length, 2, "0.15 per call: 0.30 after two calls is over the cap of 0.25");
    const { today } = (await client.aiStatus()).spend;
    assert.equal(today.currency, "USD");
    assert.ok(Math.abs(today.cost - 0.3) < 1e-6, `${today.cost}`);
    assert.equal(today.costUnknownCalls, undefined, "every cost was known");
    assert.equal((await readSpend(server)).days[DAY].calls, 2);
  }, { pricing: PRICED });
});

test("S3: a model without a price has no known cost: a cost cap does not stop it (the token caps do), and the unknown cost is said", async () => {
  await withProvider(async ({ client, admin, provider, bookId }) => {
    await setSpend(admin, { maxCostPerDay: 0.0001, maxCostPerRun: 0.0001 });
    await client.startAutopilot(bookId, ONE_CHAPTER);
    assert.equal((await finished(client, bookId)).state.status, "completed", "the cost cap cannot apply to what has no price");
    const { today } = (await client.aiStatus()).spend;
    assert.equal(today.tokens, provider.requests.length * 150);
    assert.equal(today.cost, undefined, "no cost is claimed");
    assert.equal(today.currency, undefined);
    assert.equal(today.costUnknownCalls, provider.requests.length);

    await setSpend(admin, { maxTokensPerDay: 1 });
    const refused = await attempt(() => client.askDirector(bookId, { target: { kind: "book" } }));
    assert.equal(refused.code, "spend_limit", "tokens count for every model");
  });
});

test("S3: failed attempts count when they used tokens: a reply cut by the limit is billed, one that failed before answering is only a call", async () => {
  await withProvider(async ({ client, provider, bookId }) => {
    const first = await attempt(() => client.askDirector(bookId, { target: { kind: "book" } }));
    assert.equal(first.status, 502, "the reply was cut by the output limit");
    assert.match(first.message, /output token limit|cut/i);
    let { today } = (await client.aiStatus()).spend;
    assert.deepEqual([today.tokens, today.calls], [150, 1], "the provider billed the tokens it used, answer or not");
    const second = await attempt(() => client.askDirector(bookId, { target: { kind: "book" } }));
    assert.equal(second.status, 502);
    assert.match(second.message, /500/);
    ({ today } = (await client.aiStatus()).spend);
    assert.deepEqual([today.tokens, today.calls], [150, 2], "an error answer used no tokens, but it was a call");
    const third = await client.askDirector(bookId, { target: { kind: "book" } });
    assert.equal(third.opinion.verdict, "revise");
    ({ today } = (await client.aiStatus()).spend);
    assert.deepEqual([today.tokens, today.calls], [300, 3]);
    assert.equal(provider.requests.length, 3);
  }, { provider: { respond: (number) => (number === 1 ? "truncate" : number === 2 ? { status: 500, body: { error: { message: "internal failure" } } } : undefined) } });
});

test("S3: it is every attempt that counts, not every call: a primary that failed and the fallback that answered are two calls of one question", async () => {
  const primary = await fakeProvider({ respond: () => ({ status: 500, body: { error: { message: "primary down" } } }) });
  const backup = await fakeProvider();
  try {
    await withServer(async (server, client) => {
      const admin = await adminLogin(server);
      await approve(admin, primary.origin, backup.origin);
      const config = aiConfigFor(primary);
      config.aiIntegrations.push({ id: "b", name: "Backup", provider: "openai", endpoint: backup.url, apiKey: "sk-backup", chatModels: [{ id: "m", name: "gpt-test", capabilities: ["default"] }] });
      config.taskRouting = { director: { primary: { integrationId: "p", model: "gpt-test" }, fallbacks: [{ integrationId: "b", model: "gpt-test" }] } };
      await client.putAiConfig(config);
      const bookId = await seededBook(client);
      assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise", "the fallback answered");
      const { today } = (await client.aiStatus()).spend;
      assert.deepEqual([today.calls, today.tokens], [2, 150], "two attempts were sent; only the one that was answered used tokens");
      assert.equal(primary.requests.length + backup.requests.length, 2);
    }, { ai: undefined });
  } finally {
    await primary.close();
    await backup.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Restart, damage, secrets
// ---------------------------------------------------------------------------------------------

test("S3: the totals survive a restart of the server, the day's and the run's", async () => {
  await withProvider(async ({ client, admin, provider, bookId, clock, server, dataDir }) => {
    await setSpend(admin, { maxTokensPerRun: 400 });
    await client.startAutopilot(bookId, ONE_CHAPTER);
    await finished(client, bookId);
    assert.equal((await client.aiStatus()).spend.today.tokens, 450);
    const runBefore = runOf(await readSpend(server), bookId);
    await server.close();

    const again = await testing.startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: noTunnel, now: () => clock.now });
    try {
      const later = new NarrariumServerClient({ baseUrl: again.url, token: (await again.auth.issue("later", ["read", "write", "run"])).token });
      const { spend } = await later.aiStatus();
      assert.equal(spend.today.tokens, 450, "the day is not forgotten");
      assert.equal(spend.limits.maxTokensPerRun, 400, "nor the caps");
      assert.deepEqual(runOf(await readSpend(again), bookId), runBefore, "nor what the run spent");
      // And the cap still applies after the restart: the same day, a new run, three more calls.
      await later.startAutopilot(bookId);
      await until(async () => !(await later.autopilot(bookId)).running, 30_000);
      assert.equal(provider.requests.length, 6);
      assert.equal((await later.aiStatus()).spend.today.tokens, 900);
    } finally {
      await again.close();
    }
  });
});

test("S3: a damaged spend.json does not stop the server from starting: it starts from zero, logs a warning, and shows it to the owner", async () => {
  await withFolder(async (dataDir) => {
    await mkdir(path.join(dataDir, "private"), { recursive: true });
    await writeFile(spendFile(dataDir), "{ definitely not json", { mode: 0o600 });
    const lines = [];
    const server = await testing.startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: noTunnel, log: (line) => lines.push(line), now: () => new Date(`${DAY}T10:00:00.000Z`) });
    try {
      const token = (await server.auth.issue("t", ["read"])).token;
      const client = new NarrariumServerClient({ baseUrl: server.url, token });
      const { spend } = await client.aiStatus();
      assert.deepEqual(spend.today, { day: DAY, tokens: 0, calls: 0 }, "from zero");
      assert.equal(JSON.stringify(spend).includes("spend.json"), false, "the devices are not told about the owner's files");
      assert.ok(lines.some((line) => /^Spend/.test(line) && /spend\.json/.test(line)), lines.join(" | "));
      const admin = await adminLogin(server);
      const shown = (await admin.call("GET", "/admin/api/spend")).body;
      assert.match(shown.warning ?? "", /spend\.json/);
      assert.match((await admin.call("GET", "/admin/api/status")).body.spend.warning ?? "", /spend\.json/);
      assert.equal(await readFile(`${spendFile(dataDir)}.damaged`, "utf8"), "{ definitely not json");
    } finally {
      await server.close();
    }
  });
});

test("S3: nothing secret is in the record: no key, no address, no prompt, no reply, whatever the calls were", async () => {
  await withProvider(async ({ client, provider, bookId, server }) => {
    await client.startAutopilot(bookId, ONE_CHAPTER);
    await finished(client, bookId);
    await attempt(() => client.askDirector(bookId, { target: { kind: "book" }, question: "A SECRET QUESTION ABOUT THE HARBOR" }));
    const text = await (async () => {
      await server.spend.flush();
      return readFile(spendFile(server.data.root), "utf8");
    })();
    for (const forbidden of ["sk-test-key", "127.0.0.1", String(provider.port), "harbor", "Harbor", "SECRET QUESTION", "Authorization", "Bearer", "gpt-test", "Local provider", "Glass"]) assert.equal(text.includes(forbidden), false, forbidden);
    const stored = JSON.parse(text);
    assert.deepEqual(Object.keys(stored).sort(), ["days", "runs", "updatedAt", "version"]);
    const admin = await adminLogin(server);
    const shown = JSON.stringify([(await client.aiStatus()).spend, (await admin.call("GET", "/admin/api/spend")).body]);
    for (const forbidden of ["sk-test-key", "127.0.0.1", "harbor"]) assert.equal(shown.includes(forbidden), false, forbidden);
  });
});

test("S3: the record is read before the first call after a restart: a day that was already over its cap stays over it", async () => {
  await withFolder(async (dataDir) => {
    await mkdir(path.join(dataDir, "private"), { recursive: true });
    await writeFile(spendFile(dataDir), JSON.stringify({ version: 1, updatedAt: `${DAY}T09:00:00.000Z`, days: { [DAY]: { tokens: 1000, calls: 7, costUnknownCalls: 0 } }, runs: [] }), { mode: 0o600 });
    await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ version: 2, apiPort: 0, adminPort: 0, spend: { paused: false, maxTokensPerDay: 1000, maxCostPerDay: 0, maxTokensPerRun: 0, maxCostPerRun: 0 } }), { mode: 0o600 });
    const fake = createFakeAutopilotAi();
    const server = await testing.startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: noTunnel, ai: fake, now: () => new Date(`${DAY}T10:00:00.000Z`) });
    try {
      const client = new NarrariumServerClient({ baseUrl: server.url, token: (await server.auth.issue("t", ["read", "write", "run"])).token });
      assert.equal((await client.aiStatus()).spend.today.tokens, 1000);
      const bookId = await seededBook(client);
      const refused = await attempt(() => client.askDirector(bookId, { target: { kind: "book" } }));
      assert.deepEqual([refused.status, refused.code], [429, "spend_limit"]);
      assert.equal(fake.calls.length, 0);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The command line and the panel
// ---------------------------------------------------------------------------------------------

test("S3: the spend command reads and sets the same things as the panel, through the admin session of the running server", async () => {
  const { parseCommand, readLocalSpend, updateLocalSpend, cliMain } = testing;
  assert.equal(parseCommand(["spend"]).command, "spend");
  assert.equal(parseCommand(["spend"]).spend, undefined, "nothing to change: it reads");
  assert.deepEqual(parseCommand(["spend", "--pause"]).spend, { paused: true });
  assert.deepEqual(parseCommand(["spend", "--resume"]).spend, { paused: false });
  assert.deepEqual(parseCommand(["spend", "--max-tokens-per-day", "5000", "--max-cost-per-day", "2.5", "--max-tokens-per-run", "0", "--max-cost-per-run", "0.5"]).spend, { maxTokensPerDay: 5000, maxCostPerDay: 2.5, maxTokensPerRun: 0, maxCostPerRun: 0.5 });
  assert.throws(() => parseCommand(["spend", "--pause", "--resume"]), /either/i);
  assert.throws(() => parseCommand(["spend", "--max-tokens-per-day", "-1"]), /max-tokens-per-day/);
  assert.throws(() => parseCommand(["spend", "--max-tokens-per-day", "1.5"]), /whole/);
  assert.throws(() => parseCommand(["spend", "--max-cost-per-day", "lots"]), /max-cost-per-day/);
  assert.throws(() => parseCommand(["spend", "--max-tokens-per-day"]), /needs a value/);
  assert.throws(() => parseCommand(["status", "--pause"]), /not allowed/, "the options are the spend command's alone");
  assert.deepEqual(parseCommand(["start", "--port", "3100"]), { command: "start", origins: [], apiPort: 3100 }, "no other command grows a field");

  await withServer(async (server, client) => {
    const options = { dataRoot: server.data.root, adminPort: server.adminPort };
    const before = await readLocalSpend(options);
    assert.deepEqual(before, (await client.aiStatus()).spend);
    const changed = await updateLocalSpend(options, { maxTokensPerDay: 5000, paused: true });
    assert.equal(changed.paused, true);
    assert.equal(changed.limits.maxTokensPerDay, 5000);
    assert.equal(server.data.config.spend.maxTokensPerDay, 5000, "the running server has it");
    await assert.rejects(() => updateLocalSpend(options, { maxTokensPerDay: -4 }), /maxTokensPerDay/, "the server refuses what it cannot keep, and the command says why");

    // The whole command: the admin port is read from config.json, as for every command that talks to the server.
    await server.data.updateConfig((config) => {
      config.adminPort = server.adminPort;
    });
    const out = [];
    const err = [];
    const run = (...argv) => cliMain(["spend", "--data-root", server.data.root, ...argv], {}, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
    assert.equal(await run(), 0, err.join(""));
    const shown = out.join("");
    assert.match(shown, /paused/i);
    assert.match(shown, /5000 tokens/);
    assert.match(shown, new RegExp(DAY.replace(/-/g, "-")));
    out.length = 0;
    assert.equal(await run("--resume", "--max-cost-per-run", "1.5", "--max-tokens-per-day", "0"), 0, err.join(""));
    assert.match(out.join(""), /allowed/i);
    assert.match(out.join(""), /1\.5/);
    assert.equal(server.data.config.spend.paused, false);
    assert.equal(server.data.config.spend.maxCostPerRun, 1.5);
    assert.equal(server.data.config.spend.maxTokensPerDay, 0);
    assert.equal(server.auth.sessionCount, 0, "each command signs out when it is done");
    assert.equal(await cliMain(["spend", "--data-root", server.data.root, "--max-tokens-per-day", "x"], {}, { stdout: () => undefined, stderr: (text) => err.push(text) }), 2, "a bad option is a usage error");
  }, { now: () => new Date(`${DAY}T10:00:00.000Z`) });
});
