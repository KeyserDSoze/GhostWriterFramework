import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_FEATURE_AUTOPILOT_FROZEN, SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY, parseAutopilotState, serverSupportsOutlineApply } from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { startOf } from "./hold.mjs";
import { rawApi } from "./api-helpers.mjs";

// The campaigns of the engine on the server (the Synopsis applied to a book): `POST …/autopilot/campaign` (revise these chapters now, for this reason, in order,
// then go on with the plan) and `DELETE …/autopilot/campaign` (cancel what waits), the refusals of the engine kept as they are, and the feature that says so.
// The engine decides and carries it out; these tests are about what the routes accept, answer and pass on.

const ENTRY = "outline/chapters/001.md";
const campaignRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/campaign`;

/** A book of two chapters that the autopilot wrote (and froze), whose synopsis entry of chapter 1 the author then changed through the server. */
async function changedBook(client, bookId = "b") {
  await seededBook(client, bookId);
  await client.startAutopilot(bookId, startOf(2));
  assert.equal((await finished(client, bookId)).state.status, "completed");
  const [file] = await client.readFiles(bookId, [ENTRY]);
  await client.commitFiles(bookId, [{ path: ENTRY, content: file.content.replace(/\n---\n[^]*$/, "\n---\n\nNEW-ENTRY: Mira never reaches the harbor.\n"), expectedHash: file.hash }], "the author edits the synopsis");
}

test("P2: `info.features` announces `autopilot-outline-apply`, and every code of the engine's campaign errors is a refusal, never a 500", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY), JSON.stringify(info.features));
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_FROZEN), "next to what it announced before");
    assert.equal(serverSupportsOutlineApply(info), true);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
  const expected = { invalid_request: 400, campaign_active: 409, not_changed: 409, stale: 409 };
  for (const [code, status] of Object.entries(expected)) {
    const mapped = testing.errorStatus(new testing.RevisionCampaignError(code, `Message of ${code}.`));
    assert.deepEqual([mapped.status, mapped.code, mapped.message], [status, code, `Message of ${code}.`]);
  }
});

test("P2: a campaign is recorded through the route, refused for what is no campaign or no change, cancelled, and carried out by the next run", async () => {
  await withServer(async (server, client) => {
    await changedBook(client);
    const api = await rawApi(server);
    for (const body of [{}, { reason: "outline-change" }, { reason: "nonsense", chapters: [{ number: 1, mode: "follow" }] }, { reason: "outline-change", chapters: [{ number: 1, mode: "rewrite" }] }, { reason: "outline-change", chapters: [{ number: 0, mode: "follow" }] }, { reason: "outline-change", chapters: [{ number: 1, mode: "follow", note: "misspelt" }] }, { reason: "outline-change", chapters: [{ number: 1, mode: "follow" }], extra: true }]) {
      const answer = await api("POST", campaignRoute(), body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(body));
    }
    const unchanged = await api("POST", campaignRoute(), { reason: "outline-change", chapters: [{ number: 2, mode: "follow" }] });
    assert.deepEqual([unchanged.status, unchanged.json?.code], [409, "not_changed"], "chapter 2's entry did not change");
    const stale = await api("POST", campaignRoute(), { reason: "outline-change", chapters: [{ number: 1, mode: "follow", fingerprint: "0000000000000000" }] });
    assert.deepEqual([stale.status, stale.json?.code], [409, "stale"]);

    const recorded = await client.reviseChapters("b", { reason: "outline-change", note: "Follow the new synopsis.", chapters: [{ number: 1, mode: "follow" }] });
    assert.deepEqual(recorded.campaign.chapters.map((item) => [item.number, item.mode, item.status]), [[1, "follow", "waiting"]]);
    assert.equal(recorded.campaign.note, "Follow the new synopsis.");
    assert.deepEqual(recorded.frozen.changes.map((entry) => [entry.number, entry.pending?.action]), [[1, "rewrite-to-outline"]]);
    const busy = await api("POST", campaignRoute(), { reason: "outline-change", chapters: [{ number: 1, mode: "keep" }] });
    assert.deepEqual([busy.status, busy.json?.code], [409, "campaign_active"]);

    const cancelled = await client.cancelRevisionCampaign("b");
    assert.equal(cancelled.campaign, null);
    assert.deepEqual(cancelled.frozen.changes.map((entry) => [entry.number, Boolean(entry.deferred)]), [[1, true]], "left for the author");

    await client.reviseChapters("b", { reason: "outline-change", chapters: [{ number: 1, mode: "follow" }] });
    await client.startAutopilot("b");
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    const [state] = await client.readFiles("b", ["autopilot/state.json"]);
    assert.equal(parseAutopilotState(state.content).campaign, undefined, "carried out, and gone");
    assert.ok(done.activities.some((activity) => activity.task === "impact"), "chapter 1 was looked at again");
    assert.deepEqual((await client.frozenStatus("b")).changes, [], "nothing left to decide");
  });
});
