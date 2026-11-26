import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY, SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK, SERVER_FEATURE_AUTOPILOT_REVIEW_POLICY, parseAutopilotState, serverSupportsReviewBook, serverSupportsReviewPolicy } from "narrarium-engine";
import * as testing from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { startOf } from "./hold.mjs";
import { rawApi } from "./api-helpers.mjs";

// The review of a finished book on the server (`review-target`): `POST …/autopilot/review` records it, the engine's refusals are kept as they are, the next start carries
// it out to its end, and the server announces the two features that say so. With the engine's fake AI the director never votes a chapter over 8 and judges the book 7:
// a review to 9 ends on a plateau. The engine decides and carries it out; these tests are about what the route accepts and answers.

const reviewRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/review`;

async function finishedBook(client, bookId = "b") {
  await seededBook(client, bookId, { chapters: 2 });
  await client.startAutopilot(bookId, startOf(2));
  const done = await finished(client, bookId);
  assert.equal(done.state.status, "completed", done.state.lastError?.message);
  return done;
}

test("#107: `info.features` announces `autopilot-review-book` and `autopilot-review-policy`, and the new refusals of the engine are 409s", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    for (const feature of [SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK, SERVER_FEATURE_AUTOPILOT_REVIEW_POLICY, SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY]) assert.ok(info.features.includes(feature), feature);
    assert.deepEqual([serverSupportsReviewBook(info), serverSupportsReviewPolicy(info)], [true, true]);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
  for (const code of ["not_finished", "nothing_to_review"]) {
    const mapped = testing.errorStatus(new testing.RevisionCampaignError(code, `Message of ${code}.`));
    assert.deepEqual([mapped.status, mapped.code], [409, code]);
  }
});

test("#107: a review is refused for what is no review and for a book that is not finished, recorded with its caps, carried out by the next run, and remembered", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 2 });
    const api = await rawApi(server);
    const early = await api("POST", reviewRoute(), { targetScore: 8 });
    assert.deepEqual([early.status, early.json?.code], [409, "not_finished"]);

    await client.startAutopilot("b", startOf(2));
    assert.equal((await finished(client, "b")).state.status, "completed");
    for (const body of [{}, { targetScore: "9" }, { targetScore: 9, rounds: 2 }, { targetScore: 9, maxRounds: "2" }, { targetScore: 9, include: "1" }, { targetScore: 9, note: 4 }, { targetScore: 11 }, { targetScore: 9, maxRounds: 11 }]) {
      const answer = await api("POST", reviewRoute(), body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(body));
    }
    const nothing = await api("POST", reviewRoute(), { targetScore: 1 });
    assert.deepEqual([nothing.status, nothing.json?.code], [409, "nothing_to_review"], "every chapter has 1 or more");

    const recorded = await client.reviewBook("b", { targetScore: 9, maxRounds: 2, readerRounds: 0, budgetLimit: 50, note: "Sharper." });
    assert.equal(recorded.campaign.reason, "review-target");
    assert.deepEqual(recorded.campaign.chapters.map((item) => [item.number, item.status]), [[1, "waiting"], [2, "waiting"]]);
    assert.equal(recorded.campaign.review.targetScore, 9);
    const busy = await api("POST", reviewRoute(), { targetScore: 9.5 });
    assert.deepEqual([busy.status, busy.json?.code], [409, "campaign_active"]);
    const snapshot = await client.autopilot("b");
    assert.equal(snapshot.state.options.budgetLimit, 50, "the money cap is the options' own");
    assert.equal(snapshot.summary.campaign.review.targetScore, 9);

    await client.startAutopilot("b");
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    const [file] = await client.readFiles("b", ["autopilot/state.json"]);
    const state = parseAutopilotState(file.content);
    assert.equal(state.campaign, undefined, "over, and gone");
    assert.deepEqual([state.reviews.length, state.reviews[0].outcome], [1, "plateau"], "the last two rounds raised nothing");
    assert.ok(state.reviews[0].rounds >= 2);
    assert.equal(done.activities.filter((activity) => activity.task === "final").length, 1 + state.reviews[0].rounds, "the book judged when it was finished and after each round");
  });
});

test("#107: the review policy of a run travels in the options of `start` and `configure`, and a review held by its rounds waits for a start", async () => {
  await withServer(async (server, client) => {
    await finishedBook(client);
    await client.configureAutopilot("b", { options: { review: { targetScore: 8.5, maxRounds: 4, campaignMaxRounds: 1 } } });
    assert.deepEqual((await client.autopilot("b")).state.options.review, { targetScore: 8.5, maxRounds: 4, campaignMaxRounds: 1 });
    await client.reviewBook("b", { targetScore: 9 });
    await client.startAutopilot("b");
    let done = await finished(client, "b");
    assert.equal(done.state.status, "paused", "held after the one round allowed");
    assert.equal(done.summary.limitReached.kind, "review-rounds");
    assert.deepEqual([done.summary.campaign.held, done.summary.campaign.review.roundsThisRun, done.summary.campaign.review.maxRounds], [true, 1, 1]);
    await client.startAutopilot("b");
    done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    assert.equal(done.summary.limitReached, undefined);
  });
});
