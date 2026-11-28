import test from "node:test";
import assert from "node:assert/strict";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import { IDEAS_JOURNAL_FILE, SERVER_FEATURE_AUTOPILOT_WILDCARDS, parseAutopilotState, parseIdeasJournal, serverSupportsWildcards } from "narrarium-engine";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { startOf } from "./hold.mjs";

// The room of the wildcards in the autopilot on the server (`autopilot-wildcards`, #127): the feature is announced, the options keep the room as the engine reads it, the server
// registers the room's plateau breaker while it runs, and a design run whose policy turns the room on asks it before the review of the plan. The engine decides (its tests are the
// proof of how): these tests are about what the server announces, keeps, registers and carries out.

const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

test("`info.features` announces `autopilot-wildcards`, once", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(SERVER_FEATURE_AUTOPILOT_WILDCARDS, "autopilot-wildcards");
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_WILDCARDS));
    assert.equal(serverSupportsWildcards(info), true);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
});

test("the options keep the room as the engine reads it, and `null` takes it back", async () => {
  await withServer(async (_server, client) => {
    await seededBook(client, "b", { chapters: 1 });
    await client.configureAutopilot("b", { options: { review: { targetScore: 8, wildcards: { design: true, plateau: true, voices: 12, rounds: 2 } } } });
    assert.deepEqual((await client.autopilot("b")).state.options.review, { targetScore: 8, wildcards: { design: true, plateau: true, voices: 8, rounds: 2 } });
    await client.configureAutopilot("b", { options: { review: { wildcards: { plateau: true } } } });
    assert.deepEqual((await client.autopilot("b")).state.options.review, { targetScore: 8, wildcards: { plateau: true } }, "given whole");
    await client.configureAutopilot("b", { options: { review: { wildcards: null } } });
    assert.deepEqual((await client.autopilot("b")).state.options.review, { targetScore: 8 }, "null takes it back");
  });
});

test("a design run on the server with the room turned on asks it before the review of the plan, and writes its journal with the director's decisions", async () => {
  await withServer(async (_server, client) => {
    await seededBook(client, "b", { chapters: 0 });
    await client.startAutopilot("b", { brief: { idea: "A harbor town built on glass hides a lie that the tide will tell." }, design: { chapters: 3 }, options: { ...OPTIONS, review: { wildcards: { design: true, voices: 2 } } } });
    const done = await finished(client, "b");
    assert.equal(done.state.status, "paused", done.state.lastError?.message);
    assert.equal(done.state.design.outcome, "target");
    assert.deepEqual(done.activities.map((activity) => activity.task), ["concept", "plan", "wildcards", "plan-review"], "the room between the plan and its review");
    const [journal] = await client.readFiles("b", [IDEAS_JOURNAL_FILE]);
    const [entry] = parseIdeasJournal(journal.content).entries;
    assert.deepEqual([entry.by, entry.target.kind, entry.voices], ["autopilot", "plan", ["devils-advocate", "naive"]]);
    assert.ok(entry.ideas.length > 0 && entry.ideas.every((idea) => idea.decision?.by === "director"), "every idea decided by the director");
  });
});

test("the server takes on the stall of a review with the room when the policy turns it on: the room reads the book, and the corrections of the book read what the director accepted", async () => {
  // A director who approves every chapter at its first round and judges the book 7: a review to 7.5 with a round for the book as a whole stalls after two rounds.
  const ai = createFakeAutopilotAi({ reviewVerdict: () => "approve" });
  await withServer(async (_server, client) => {
    await seededBook(client, "b", { chapters: 1 });
    await client.startAutopilot("b", startOf(1));
    assert.equal((await finished(client, "b")).state.status, "completed");
    await client.configureAutopilot("b", { options: { review: { wildcards: { plateau: true, voices: 1 } } } });
    await client.reviewBook("b", { targetScore: 7.5, bookRound: "apply" });
    await client.startAutopilot("b");
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    const [journal, stateFile] = await client.readFiles("b", [IDEAS_JOURNAL_FILE, "autopilot/state.json"]);
    const entries = parseIdeasJournal(journal.content).entries;
    assert.deepEqual(entries.map((entry) => [entry.by, entry.target.kind, entry.preset, entry.voices]), [["autopilot", "book", "creative-room", ["subversive"]]], "one consultation, at the stall");
    const review = parseAutopilotState(stateFile.content).reviews.at(-1);
    assert.equal(review.outcome, "plateau", "after the rounds the room's ideas made, the stall ends the review");
    assert.ok(review.rounds > 2, "the room took the review on: more rounds than the two of a stall");
    const corrections = ai.calls.filter((call) => call.label === "autopilot:book-corrections");
    assert.equal(corrections.filter((call) => /WHAT THE ROOM FOUND:\nIDEAS ACCEPTED FROM THE ROOM/.test(call.user)).length, 1, "the round the room made reads its accepted ideas");
  }, { ai });
});
