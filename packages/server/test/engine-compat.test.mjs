import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { remoteBookStore, syncBookStores } from "narrarium-engine";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
// New exports are read through the namespace, so a missing one fails the test that needs it and nothing else.
import * as testing from "../dist/testing.mjs";
import { adminLogin, gatedAi, until, withServer } from "./helpers.mjs";
import { ONE_CHAPTER, aiConfigFor, approve, fakeProvider, finished, seededBook } from "./fake-provider.mjs";

const shape = ({ status, code, message }) => ({ status, code, message });
const remove = (...directories) => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], { encoding: "utf8" });
const GITHUB = { kind: "github", owner: "me", repo: "remote", branch: "main" };

/** The answer of a request that failed, as the typed client reports it. */
const refusal = (error) => ({ status: error.status, code: error.code, message: error.message });
const attempt = (action) => action().then(() => ({ status: 200 }), refusal);

// ---------------------------------------------------------------------------------------------
// S1.2 / S1.3: the engine's typed errors are answered as what they are
// ---------------------------------------------------------------------------------------------

const RULE_STATUS = { rule_empty: 400, rule_too_long: 400, rule_duplicate: 400, rule_not_found: 404, rule_changed: 409 };

test("S1: errorStatus answers every code of AutopilotRuleError with its own status and code, and keeps the engine's message", () => {
  const { errorStatus, AutopilotRuleError } = testing;
  for (const [code, status] of Object.entries(RULE_STATUS)) {
    const message = `The rule says ${code}: something the author must read.`;
    const mapped = errorStatus(new AutopilotRuleError(code, message));
    assert.deepEqual(shape(mapped), { status, code, message }, code);
    assert.equal(mapped.requestId, undefined, "a refusal is not an internal error: no id, nothing hidden");
    assert.equal(mapped.detail, undefined);
  }
  const real = new AutopilotRuleError("rule_too_long", "The rule is 900 characters long: a rule is at most 800 characters.", 800);
  assert.equal(errorStatus(real).message, real.message);
});

test("S1: FrontmatterError and the engine's new AI errors never become a 500, and keep their message", () => {
  const { errorStatus, FrontmatterError, AiPromptTooLargeError, AiRoutingBudgetError, AiFallbackBlockedError } = testing;
  const frontmatter = new FrontmatterError("chapters/001-a/chapter.md", "a tab where spaces are needed", 3);
  assert.deepEqual(shape(errorStatus(frontmatter)), { status: 422, code: "frontmatter_invalid", message: frontmatter.message });
  assert.match(frontmatter.message, /chapters\/001-a\/chapter\.md/, "it still names the file");
  assert.match(frontmatter.message, /line 3/);
  const italian = new FrontmatterError("book.md", "yaml", 2, "it");
  assert.equal(errorStatus(italian).message, italian.message, "in the language of the book");

  const errors = [
    new AiPromptTooLargeError("The prompt (about 9000 tokens) is larger than the context window.", 9000, 4000),
    new AiRoutingBudgetError("The first routing candidate exceeds the configured token-attempt or estimated-cost budget. Nothing was sent."),
    new AiFallbackBlockedError("The fallback \"B\" was not used: it is in another account."),
  ];
  for (const error of errors) {
    const mapped = errorStatus(error);
    assert.notEqual(mapped.status, 500, error.name);
    assert.equal(mapped.code, "ai_provider", error.name);
    assert.equal(mapped.message, error.message, `${error.name} keeps its message`);
    assert.equal(mapped.requestId, undefined, error.name);
  }
});

test("S1: a rule that is too long or empty is answered 400 with its code and the limit, never a 500, and is never cut", async () => {
  await withServer(async (_server, client) => {
    const bookId = await seededBook(client);
    const intervene = (input) => attempt(() => client.intervene(bookId, input));

    const tooLong = await intervene({ scope: "from_now", text: "r".repeat(900) });
    assert.deepEqual([tooLong.status, tooLong.code], [400, "rule_too_long"]);
    assert.match(tooLong.message, /900 characters/, "it says how long the rule is");
    assert.match(tooLong.message, /800/, "and how long it may be");

    const huge = await intervene({ scope: "from_now", text: "r".repeat(10_000) });
    assert.deepEqual([huge.status, huge.code], [400, "rule_too_long"], "the text is not cut to 8000 characters before the check");
    assert.match(huge.message, /10000 characters/, "so the message tells the truth about what was sent");

    const rewrite = await intervene({ scope: "rewrite", text: "r".repeat(801) });
    assert.deepEqual([rewrite.status, rewrite.code], [400, "rule_too_long"], "a rewrite instruction is kept as a rule too");

    for (const scope of ["from_now", "rewrite"]) {
      const blank = await intervene({ scope, text: "   \n " });
      assert.deepEqual([blank.status, blank.code], [400, "rule_empty"], scope);
      assert.match(blank.message, /empty/i);
    }
    const blankNote = await intervene({ scope: "next_step", text: "  " });
    assert.deepEqual([blankNote.status, blankNote.code], [400, "invalid_request"], "a note that says nothing is a bad request, not an internal error");

    let snapshot = await client.autopilot(bookId);
    assert.deepEqual(snapshot.state?.constraints ?? [], [], "nothing was saved by any refusal");
    assert.deepEqual(snapshot.state?.interventions ?? [], []);

    assert.equal((await intervene({ scope: "from_now", text: `${"r".repeat(799)}.` })).status, 200, "800 characters are a rule");
    assert.equal((await intervene({ scope: "next_step", text: "n".repeat(2000) })).status, 200, "a note may be longer than a rule");
    snapshot = await client.autopilot(bookId);
    assert.equal(snapshot.state.constraints.length, 1);
    assert.equal(snapshot.state.constraints[0].length, 800);
    assert.equal(snapshot.state.interventions.find((entry) => entry.scope === "next_step").text.length, 2000, "the note is kept whole");
  });
});

/** The director's reply asks the author a question: the run then waits for the answer. */
function askingAi() {
  const base = createFakeAutopilotAi();
  return {
    calls: base.calls,
    async complete(request) {
      if (request.json?.name !== "plan_review") return base.complete(request);
      base.calls.push(request);
      const json = { verdict: "approve", score: 8, summary: "Good plan.", strengths: [], changes: [], guidance: [], questionForAuthor: { question: "Should Orrin be redeemed?", options: ["Yes", "No"] } };
      return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" };
    },
  };
}

test("S1: the answer to the director's question reaches the engine as a rule when the author asks (asRule), and the errors are typed", async () => {
  await withServer(async (_server, client) => {
    const waiting = async (bookId) => {
      await seededBook(client, bookId);
      await client.startAutopilot(bookId, ONE_CHAPTER);
      const snapshot = await finished(client, bookId);
      assert.equal(snapshot.state.question.question, "Should Orrin be redeemed?", "the run waits for the author");
      return snapshot.state.question;
    };

    // A rule: kept for every later step, and not also a note.
    const rule = await waiting("as-rule");
    const ruled = await client.answer("as-rule", { questionId: rule.id, answer: "No, never.", asRule: true });
    assert.deepEqual(ruled.state.constraints, ["Answer to the director's question «Should Orrin be redeemed?»: No, never."]);
    assert.equal(ruled.state.question, null);
    assert.deepEqual(ruled.state.interventions.map((entry) => [entry.scope, entry.status]), [["from_now", "applied"]]);

    // By default a one-time note, as before.
    const note = await waiting("as-note");
    const noted = await client.answer("as-note", { questionId: note.id, answer: "No, never." });
    assert.deepEqual(noted.state.constraints, []);
    assert.deepEqual(noted.state.interventions.map((entry) => [entry.scope, entry.status]), [["next_step", "pending"]]);
    const accepted = await waiting("as-accept");
    const kept = await client.answer("as-accept", { questionId: accepted.id, answer: "No, never.", accept: true, asRule: true });
    assert.deepEqual(kept.state.constraints, [], "accepting the work records nothing, whatever asRule says");

    // A rule over the limit is refused, said so, and the question stays open.
    const long = await waiting("as-long");
    const refused = await attempt(() => client.answer("as-long", { questionId: long.id, answer: "n".repeat(900), asRule: true }));
    assert.deepEqual([refused.status, refused.code], [400, "rule_too_long"]);
    assert.match(refused.message, /800/);
    assert.equal((await client.autopilot("as-long")).state.question.id, long.id, "the question is still open");
    const asNote = await client.answer("as-long", { questionId: long.id, answer: "n".repeat(900) });
    assert.equal(asNote.state.question, null, "the same text is fine as a note");

    // A question that is not open any more (an answer from another device) is a conflict, not an internal error.
    const closed = await attempt(() => client.answer("as-rule", { questionId: rule.id, answer: "again", asRule: true }));
    assert.deepEqual([closed.status, closed.code], [409, "question_closed"]);
    assert.match(closed.message, /no longer open/);
  }, { ai: askingAi() });
});

// ---------------------------------------------------------------------------------------------
// S1.1: what the server uses of the engine's AI layer, as the browser does
// ---------------------------------------------------------------------------------------------

test("S1: a fallback in another account is never called when the policy asks to acknowledge it (this host cannot ask: it fails closed), and the error says so", async () => {
  const primary = await fakeProvider({ respond: () => ({ status: 400, body: { error: { message: "primary refuses" } } }) });
  const backup = await fakeProvider();
  try {
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      const admin = await adminLogin(server);
      await approve(admin, primary.origin, backup.origin);
      const config = aiConfigFor(primary);
      config.aiIntegrations.push({ id: "b", name: "Backup account", provider: "openai", endpoint: backup.url, apiKey: "sk-backup", chatModels: [{ id: "m", name: "gpt-test", capabilities: ["default"] }] });
      config.taskRouting = { director: { primary: { integrationId: "p", model: "gpt-test" }, fallbacks: [{ integrationId: "b", model: "gpt-test" }] } };
      config.fallbackDisclosure = { sameBoundaryOnly: false, requireAcknowledgement: true };
      await client.putAiConfig(config);
      const blocked = await attempt(() => client.askDirector(bookId, { target: { kind: "book" } }));
      assert.equal(blocked.status, 502);
      assert.equal(blocked.code, "ai_provider");
      assert.match(blocked.message, /primary refuses/);
      assert.match(blocked.message, /cannot ask/, "the message of the engine names the setting and what to do");
      assert.equal(primary.requests.length, 1);
      assert.equal(backup.requests.length, 0, "the content never left the primary's account");

      config.fallbackDisclosure = { sameBoundaryOnly: false, requireAcknowledgement: false };
      await client.putAiConfig(config);
      assert.equal((await client.askDirector(bookId, { target: { kind: "book" } })).opinion.verdict, "revise", "without the policy the fallback answers");
      assert.equal(backup.requests.length, 1);
    }, { ai: undefined });
  } finally {
    await primary.close();
    await backup.close();
  }
});

test("S1: a run that meets a transient provider failure repeats the step after the wait the engine decides, and goes on", async () => {
  const provider = await fakeProvider({ respond: (number) => (number === 2 ? { status: 429, body: { error: { message: "slow down" } } } : undefined) });
  try {
    await withServer(async (server, client) => {
      const bookId = await seededBook(client);
      await approve(await adminLogin(server), provider.origin);
      await client.putAiConfig(aiConfigFor(provider));
      await client.startAutopilot(bookId, ONE_CHAPTER);
      const snapshot = await finished(client, bookId);
      assert.equal(snapshot.state.status, "completed", snapshot.state.message ?? "");
      assert.equal(snapshot.state.stats.failures, 0, "a retried step is not a failure");
      assert.ok(provider.requests.length >= 17, "the request that failed was made again");
    }, { ai: undefined, autopilot: { retryDelayMs: 0 } });
  } finally {
    await provider.close();
  }
});

// ---------------------------------------------------------------------------------------------
// S1.4: the engine's heartbeat commits are ordinary commits for git and for the sync with the browser
// ---------------------------------------------------------------------------------------------

/** A bare repository with one commit on `main`, standing in for GitHub, and a clone to play the author with. */
async function seedOrigin() {
  const origin = await mkdtemp(path.join(os.tmpdir(), "narrarium-origin-"));
  const seed = await mkdtemp(path.join(os.tmpdir(), "narrarium-seed-"));
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
  for (const [file, content] of Object.entries(seedBookFiles())) {
    await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
    await writeFile(path.join(seed, file), content);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", origin, "main");
  return { origin, seed };
}

test("S1: heartbeat commits made during a long step are ordinary commits: git pull and push carry them, and the browser's second sync gets the state they saved", async () => {
  const seeded = await seedOrigin();
  const slow = gatedAi();
  try {
    await withServer(async (server, client) => {
      // The held call is let go whatever happens below, or the server could not stop at the end of a failed test.
      try {
        await client.registerBook("gh", { title: "Remote", storage: GITHUB, githubToken: "ghp_x" });
        const working = server.data.bookDirectory("gh");
        // Read while the server commits: a moment in which git cannot read is no answer yet, not a failure.
      const subjects = () => {
        try {
          return git(working, "log", "--format=%s").split(/\r?\n/).filter(Boolean);
        } catch {
          return [];
        }
      };
        const heartbeats = () => subjects().filter((subject) => subject === "Autopilot: heartbeat").length;

        // The browser's first sync, before the run.
        const local = new MemoryBookStore(seedBookFiles());
        const remote = remoteBookStore(client, "gh");
        const first = await syncBookStores({ local, remote, base: new Map() });
        assert.deepEqual(first.conflicts, []);

        // A long step: the AI call is held while the engine saves its heartbeat again and again (every 150 ms here, every 5 minutes for real).
        await client.startAutopilot("gh", ONE_CHAPTER);
        await slow.started;
        await until(() => heartbeats() >= 2, 15_000);

        // The author writes on GitHub while the run works, and the server syncs with heartbeats among its local commits and more arriving.
        await writeFile(path.join(seeded.seed, "notes-by-the-author.md"), "---\ntype: note\nid: note:author\ntitle: Author\n---\n\nA line written on GitHub.\n");
        git(seeded.seed, "add", "-A");
        git(seeded.seed, "commit", "--quiet", "-m", "author edit");
        git(seeded.seed, "push", "--quiet", seeded.origin, "main");
        const synced = await client.syncGitHub("gh");
        assert.equal(synced.lastSync.ok, true, synced.lastSync.message);
        assert.ok(subjects().includes("author edit"), "the server has the author's commit, with its own heartbeats on top of it");
        const pushed = git(seeded.origin, "log", "--format=%s", "main").split(/\r?\n/).filter(Boolean);
        assert.ok(pushed.includes("Autopilot: heartbeat"), "the heartbeat commits are on GitHub");
        assert.ok(pushed.includes("author edit"), "next to the author's");

        // The run ends (the heartbeats stop), and the browser's second sync agrees with the server.
        await client.pauseAutopilot("gh", "now");
        slow.release();
        await until(async () => !(await client.autopilot("gh")).running);
        assert.equal(git(working, "status", "--porcelain").trim(), "", "nothing is left half done in the working copy");
        const second = await syncBookStores({ local, remote, base: first.base });
        assert.deepEqual(second.conflicts, [], "a heartbeat never makes a conflict");
        assert.deepEqual(second.skipped ?? [], []);
        assert.ok(second.downloaded.includes("autopilot/state.json"), "the browser gets the autopilot state");
        assert.ok(second.downloaded.includes("notes-by-the-author.md"), "and what the author wrote");
        assert.equal(JSON.parse(local.files.get("autopilot/state.json")).status, "paused");
        const third = await syncBookStores({ local, remote, base: second.base });
        assert.deepEqual([third.uploaded, third.downloaded, third.conflicts], [[], [], []], "and then there is nothing left to say");
        assert.equal((await client.syncGitHub("gh")).lastSync.ok, true, "a last sync of the server with GitHub is as quiet");
      } finally {
        slow.release();
      }
    }, { githubRemoteUrl: () => seeded.origin, ai: slow.ai, autopilot: { persistHeartbeatMs: 150 } });
  } finally {
    slow.release();
    await remove(seeded.origin, seeded.seed);
  }
});
