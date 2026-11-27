import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_FEATURE_AUTOPILOT_REVIEW_POLICY, SERVER_FEATURE_AUTOPILOT_REVIEW_TARGETS, parseAutopilotState, serverSupportsReviewTargets } from "narrarium-engine";
import { withServer } from "./helpers.mjs";
import { finished, seededBook } from "./fake-provider.mjs";
import { FAST, startOf } from "./hold.mjs";
import { rawApi } from "./api-helpers.mjs";

// The targets for the readers on the server (`autopilot-review-targets`): the feature is announced, the options of `start` and `configure` and a review of the book carry the
// three fields, a request that is not what the fields say is refused, and the run of the server reviews the chapters as the engine does. The engine decides (its tests are
// the proof of how); these tests are about what the server accepts, keeps, announces and carries out.

const reviewRoute = (bookId = "b") => `/api/v1/books/${bookId}/autopilot/review`;
const GENERAL = "standard-general";
const EMOTIONAL = "standard-emotional";

async function finishedBook(client, bookId = "b", chapters = 1) {
  await seededBook(client, bookId, { chapters });
  await client.startAutopilot(bookId, startOf(chapters));
  const done = await finished(client, bookId);
  assert.equal(done.state.status, "completed", done.state.lastError?.message);
  return done;
}

const optionsOf = async (client, bookId = "b") => (await client.autopilot(bookId)).state.options;

test("`info.features` announces `autopilot-review-targets`, after the policy it extends, once", async () => {
  await withServer(async (server) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.equal(SERVER_FEATURE_AUTOPILOT_REVIEW_TARGETS, "autopilot-review-targets");
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_REVIEW_TARGETS));
    assert.ok(info.features.includes(SERVER_FEATURE_AUTOPILOT_REVIEW_POLICY));
    assert.equal(serverSupportsReviewTargets(info), true);
    assert.equal(new Set(info.features).size, info.features.length, "each feature once");
  });
});

test("the options of `start` and `configure` keep the targets for the readers as the engine reads them, field by field, and `null` takes each back", async () => {
  await withServer(async (server, client) => {
    await seededBook(client, "b", { chapters: 1 });
    await client.configureAutopilot("b", { options: { readers: true, maxReaders: 2, review: { targetScore: 8, readersTarget: 11, readerTargets: { [EMOTIONAL]: 8, "": 3, [GENERAL]: "x" }, readersExcluded: [GENERAL, GENERAL, 7] } } });
    assert.deepEqual((await optionsOf(client)).review, { targetScore: 8, readersTarget: 10, readerTargets: { [EMOTIONAL]: 8 }, readersExcluded: [GENERAL] }, "in range, what cannot be read left out");
    await client.configureAutopilot("b", { options: { review: { readersTarget: 7.5 } } });
    assert.deepEqual((await optionsOf(client)).review, { targetScore: 8, readersTarget: 7.5, readerTargets: { [EMOTIONAL]: 8 }, readersExcluded: [GENERAL] }, "a field sent changes that field only");
    await client.configureAutopilot("b", { options: { review: { readerTargets: null, readersExcluded: null } } });
    assert.deepEqual((await optionsOf(client)).review, { targetScore: 8, readersTarget: 7.5 }, "null takes each back");
    await client.startAutopilot("b", startOf(1, { options: { ...FAST, review: { readersTarget: null, readersExcluded: [EMOTIONAL] } } }));
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    assert.deepEqual(done.state.options.review, { targetScore: 8, readersExcluded: [EMOTIONAL] }, "start carries them too");
  });
});

test("a review of the book with targets for the readers: the shape is checked by the route, what it asks by the engine, and what is accepted is recorded as the review's own", async () => {
  await withServer(async (server, client) => {
    await finishedBook(client);
    const api = await rawApi(server);
    for (const body of [
      { targetScore: 7, readersTarget: "8" },
      { targetScore: 7, readerTargets: [8] },
      { targetScore: 7, readerTargets: "all" },
      { targetScore: 7, readersExcluded: "a" },
      { targetScore: 7, readersExcluded: Array.from({ length: 101 }, (_, index) => `r${index}`) },
      { targetScore: 7, readerTargets: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`r${index}`, 7])) },
    ]) {
      const answer = await api("POST", reviewRoute(), body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], JSON.stringify(body).slice(0, 80));
    }
    for (const body of [{ targetScore: 7, readersTarget: 11 }, { targetScore: 7, readerTargets: { [GENERAL]: 0 } }, { targetScore: 7, readersExcluded: [1] }]) {
      const answer = await api("POST", reviewRoute(), body);
      assert.deepEqual([answer.status, answer.json?.code], [400, "invalid_request"], `the engine refuses ${JSON.stringify(body)}`);
    }
    assert.equal((await client.autopilot("b")).state.campaign, undefined, "nothing was recorded");

    // The readers do not read in this book (the run was FAST): their targets ask nothing, and the chapter is at the director's target (the fake director closes it at 6).
    const nothing = await api("POST", reviewRoute(), { targetScore: 6, readersTarget: 9 });
    assert.deepEqual([nothing.status, nothing.json?.code], [409, "nothing_to_review"]);

    await client.configureAutopilot("b", { options: { readers: true, maxReaders: 2 } });
    const recorded = await client.reviewBook("b", { targetScore: 7, maxRounds: 1, readersTarget: 7.46, readerTargets: { [EMOTIONAL]: 8 }, readersExcluded: [GENERAL] });
    assert.deepEqual([recorded.campaign.review.readersTarget, recorded.campaign.review.readerTargets, recorded.campaign.review.readersExcluded], [7.5, { [EMOTIONAL]: 8 }, [GENERAL]]);
    assert.deepEqual(recorded.campaign.chapters.map((item) => item.number), [1], "no chapter has the vote of its readers yet: they have to be asked");
    assert.equal((await optionsOf(client)).review, undefined, "the review's own targets are not the run's");
    assert.deepEqual((await client.autopilot("b")).summary.campaign.review.readersTarget, 7.5, "and the summary says the target");
  });
});

test("the run of the server reads the chapters again as the targets say, and a review that cannot reach them stops on a plateau that names the readers", async () => {
  await withServer(async (server, client) => {
    await finishedBook(client);
    // With the engine's fake AI the readers always give 7: a review that asks 9 of their average is never satisfied, and one round of corrections of a chapter is all it has.
    await client.configureAutopilot("b", { options: { readers: true, maxReaders: 2 } });
    await client.reviewBook("b", { targetScore: 7, maxRounds: 1, readersTarget: 9 });
    await client.startAutopilot("b");
    const done = await finished(client, "b");
    assert.equal(done.state.status, "completed", done.state.lastError?.message);
    const [file] = await client.readFiles("b", ["autopilot/state.json"]);
    const state = parseAutopilotState(file.content);
    assert.equal(state.campaign, undefined, "over, and gone");
    assert.equal(state.reviews[0].outcome, "plateau");
    assert.equal(state.reviews[0].to.readers, 7, "the lowest average of the readers is in the record");
    const chapter = state.plan.chapters[0];
    assert.equal(chapter.rounds.at(-1).reading, "end", "the last thing that happened to the chapter is the readers reading it as it is");
    assert.deepEqual(Object.keys(chapter.rounds.at(-1).readerVotes).sort(), [EMOTIONAL, GENERAL]);
    const stops = done.activities.filter((activity) => activity.task === "reader").length;
    assert.ok(stops >= 6, `the readers read the chapter again: ${stops} readings`);
  });
});
