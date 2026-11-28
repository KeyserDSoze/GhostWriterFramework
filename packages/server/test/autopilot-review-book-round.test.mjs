import test from "node:test";
import assert from "node:assert/strict";
import { createFakeAutopilotAi } from "narrarium-engine/testing";
import { SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK_ROUND, SERVER_FEATURE_AUTOPILOT_REVIEW_TARGETS, parseAutopilotState, serverSupportsReviewBookRound } from "narrarium-engine";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { startOf } from "./hold.mjs";
import { rawApi } from "./api-helpers.mjs";

// The book-level round of a review on the server (`autopilot-review-book-round`): the feature is announced, the options and a review of the book carry `bookRound`, the decision about
// the corrections that wait for the author has its route, and the run of the server asks the director, carries the corrections out and records what it did. The engine decides (its tests
// are the proof of how); these tests are about what the server accepts, keeps, announces and carries out. The director here approves every chapter at 8 and judges the book 7.

/** The server's own AI: the engine's fake, with a director who approves a chapter at its first round. */
const approving = () => ({ ai: createFakeAutopilotAi({ reviewVerdict: () => "approve" }) });

const reviewRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/review`;
const correctionsRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/review/corrections`;

async function finishedBook(client, bookId = "b", chapters = 1) {
  await seededBook(client, bookId, { chapters });
  await client.startAutopilot(bookId, startOf(chapters));
  const done = await finished(client, bookId);
  assert.equal(done.state.status, "completed", done.state.lastError?.message);
  return done;
}

const stateOf = async (client, bookId = "b") => parseAutopilotState((await client.readFiles(bookId, ["autopilot/state.json"]))[0].content);

test("`info.features` announces `autopilot-review-book-round`, once", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK_ROUND, "autopilot-review-book-round");
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK_ROUND));
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_REVIEW_TARGETS));
    assert.equal(serverSupportsReviewBookRound(info), true);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
});

test("the options keep the book-level round as the engine reads it, and `null` takes it back", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 1 });
    await client.configureAutopilot("b", { options: { review: { targetScore: 8, bookRound: "ask" } } });
    assert.deepEqual((await client.autopilot("b")).state.options.review, { targetScore: 8, bookRound: "ask" });
    await client.configureAutopilot("b", { options: { review: { bookRound: "apply" } } });
    assert.deepEqual((await client.autopilot("b")).state.options.review, { targetScore: 8, bookRound: "apply" }, "a field sent changes that field only");
    await client.configureAutopilot("b", { options: { review: { bookRound: "sometimes" } } });
    assert.deepEqual((await client.autopilot("b")).state.options.review, { targetScore: 8, bookRound: "apply" }, "what is not a mode leaves what there was");
    await client.configureAutopilot("b", { options: { review: { bookRound: null } } });
    assert.deepEqual((await client.autopilot("b")).state.options.review, { targetScore: 8 }, "null takes it back");
  }, approving());
});

test("a review of the book with a book-level round: the shape is checked by the route, and a book whose chapters have the target begins with the director's corrections", async () => {
  await withServer(async (server, client) => {
    await finishedBook(client);
    const api = await rawApi(server);
    for (const body of [{ targetScore: 7.5, bookRound: "sometimes" }, { targetScore: 7.5, bookRound: 1 }, { targetScore: 7.5, bookRound: true }]) {
      const answer = await api("POST", reviewRoute(), body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(body));
    }
    // Every chapter has 7.5, the book 7: with no book-level round there is nothing under a target; with one, the review begins in it.
    const without = await api("POST", reviewRoute(), { targetScore: 7.5 });
    assert.deepEqual([without.status, without.json?.code], [409, "nothing_to_review"]);
    assert.match(without.json.message, /book-level round/);
    const off = await api("POST", reviewRoute(), { targetScore: 7.5, bookRound: "off" });
    assert.deepEqual([off.status, off.json?.code], [409, "nothing_to_review"]);
    const recorded = await client.reviewBook("b", { targetScore: 7.5, bookRound: "ask" });
    assert.deepEqual([recorded.campaign.review.phase, recorded.campaign.review.bookRound, recorded.campaign.review.book.status, recorded.campaign.chapters], ["book", "ask", "asking", []]);
    assert.equal((await client.autopilot("b")).summary.campaign.review.phase, "book");
    assert.equal((await client.autopilot("b")).state.options.review, undefined, "the review's own mode is not the run's");
  }, approving());
});

test("the corrections that wait for the author: the run stops with them, the decision has its own route, and what is chosen is carried out by the next run", async () => {
  await withServer(async (server, client) => {
    await finishedBook(client);
    await client.reviewBook("b", { targetScore: 7.5, bookRound: "ask" });
    await client.startAutopilot("b");
    const stopped = await finished(client, "b");
    assert.equal(stopped.state.status, "paused", stopped.state.lastError?.message);
    assert.match(stopped.state.message, /1 correction/);
    const proposed = (await stateOf(client)).campaign.review.book;
    assert.deepEqual([proposed.status, proposed.corrections.length, proposed.corrections[0].chapter, proposed.corrections[0].status], ["proposed", 1, 1, "waiting"]);
    assert.ok(proposed.verdict.points.length >= 1, "the points of the judgement are there to be cited");

    const api = await rawApi(server);
    for (const body of [{}, { round: "1", action: "apply" }, { round: 1, action: "maybe" }, { round: 1, action: "apply", chosen: "all" }, { round: 1, action: "apply", chosen: [1, "2"] }, { round: 1, action: "apply", other: 1 }]) {
      const answer = await api("POST", correctionsRoute(), body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(body));
    }
    const stale = await api("POST", correctionsRoute(), { round: 9, action: "apply" });
    assert.deepEqual([stale.status, stale.json?.code], [409, "stale"]);
    const outOfRange = await api("POST", correctionsRoute(), { round: 1, action: "apply", chosen: [2] });
    assert.deepEqual([outOfRange.status, outOfRange.json?.code], [400, "invalid_request"], "the engine refuses a number that is not a correction");

    const decided = await client.decideBookCorrections("b", { round: 1, action: "apply", chosen: [1] });
    assert.deepEqual([decided.campaign.review.phase, decided.campaign.review.book.status, decided.campaign.chapters.map((item) => item.number)], ["chapters", "applying", [1]]);
    const again = await api("POST", correctionsRoute(), { round: 1, action: "apply" });
    assert.deepEqual([again.status, again.json?.code], [409, "no_proposal"], "decided once");

    await client.startAutopilot("b");
    // The book stays at 7 with this director: the corrections were carried out, the book is judged again and still under the target, so the second round asks the author again.
    const second = await finished(client, "b");
    assert.equal(second.state.status, "paused", second.state.lastError?.message);
    const next = (await stateOf(client)).campaign.review;
    assert.deepEqual([next.round, next.book.status, next.history.length, next.history[0].bookRound.corrections.map((correction) => correction.status)], [2, "proposed", 1, ["applied"]]);
    await client.decideBookCorrections("b", { round: 2, action: "apply" });
    await client.startAutopilot("b");
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    const state = await stateOf(client);
    assert.equal(state.campaign, undefined, "over, and gone");
    // Two rounds that raise nothing are a plateau.
    assert.deepEqual([state.reviews[0].outcome, state.reviews[0].rounds, state.reviews[0].bookRounds.map((entry) => [entry.round, entry.corrections.map((correction) => correction.status)])], ["plateau", 2, [[1, ["applied"]], [2, ["applied"]]]]);
    assert.ok(done.activities.some((activity) => activity.task === "book-corrections"), "the step is in the journal");
  }, approving());
});

test("a review that applies the corrections by itself runs to its end without stopping, and the author can decline what waits", async () => {
  await withServer(async (server, client) => {
    await finishedBook(client);
    await client.reviewBook("b", { targetScore: 7.5, bookRound: "apply" });
    await client.startAutopilot("b");
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    const state = await stateOf(client);
    assert.equal(state.reviews[0].outcome, "plateau");
    assert.ok(state.reviews[0].bookRounds.length >= 1);
  }, approving());
  await withServer(async (server, client) => {
    await finishedBook(client);
    await client.reviewBook("b", { targetScore: 7.5, bookRound: "ask" });
    await client.startAutopilot("b");
    await finished(client, "b");
    await client.decideBookCorrections("b", { round: 1, action: "decline" });
    await client.startAutopilot("b");
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    const state = await stateOf(client);
    assert.deepEqual([state.reviews[0].outcome, state.reviews[0].bookRounds[0].corrections[0].why], ["chapters", "declined"]);
  }, approving());
});
