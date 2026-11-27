import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { brief } from "./review-fakes.mjs";

// The targets for the readers (`ReviewPolicy.readersTarget`, `readerTargets`, `readersExcluded`): how the policy keeps them, which are in force, how the readers' votes stand
// against them, which vote of a chapter is the vote of its text as it is, what a state keeps of it, what the estimate says it costs and when a server may be sent them.

const clock = () => new Date("2026-01-01T00:00:00.000Z");

// ─── The policy ─────────────────────────────────────────────────────────────

test("the targets for the readers are read softly: in range, each reader on its own, what cannot be read left out, and `null` takes a field back", () => {
  const { normalizeReviewPolicy, normalizeOptions, DEFAULT_OPTIONS } = engine;
  assert.deepEqual(
    normalizeReviewPolicy({ readersTarget: 12, readerTargets: { a: 12, b: "x", "": 5, c: 7.46, d: "6,5" }, readersExcluded: ["a", "a", 3, "", "  b  ", null] }),
    { readersTarget: 10, readerTargets: { a: 10, c: 7.5, d: 6.5 }, readersExcluded: ["a", "b"] },
    "a vote is brought into 1-10 to a tenth, a reader or a vote that cannot be read is left out, a reader is named once",
  );
  assert.deepEqual(normalizeReviewPolicy({ readersTarget: 0.2 }), { readersTarget: 1 });
  assert.equal(normalizeReviewPolicy({ readersTarget: "high", readerTargets: ["a"], readersExcluded: "a" }), undefined, "nothing usable is no policy");

  const base = { targetScore: 8, readersTarget: 7, readerTargets: { a: 8 }, readersExcluded: ["b"] };
  assert.deepEqual(normalizeReviewPolicy({ readersTarget: "high", readerTargets: ["a"], readersExcluded: "a" }, base), base, "what is not usable leaves what there was");
  assert.deepEqual(normalizeReviewPolicy({}, base), base, "nothing sent keeps it all");
  assert.deepEqual(normalizeReviewPolicy({ readerTargets: { c: 6 }, readersExcluded: ["z"] }, base), { targetScore: 8, readersTarget: 7, readerTargets: { c: 6 }, readersExcluded: ["z"] }, "the targets of the readers and the readers left out are given whole, and replace");
  assert.deepEqual(normalizeReviewPolicy({ readerTargets: {}, readersExcluded: [] }, base), { targetScore: 8, readersTarget: 7 }, "none left: they are taken back");
  assert.deepEqual(normalizeReviewPolicy({ readersTarget: null, readerTargets: null, readersExcluded: null }, base), { targetScore: 8 }, "null takes each field back");
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`reader-${index}`, 7]));
  assert.equal(Object.keys(normalizeReviewPolicy({ readerTargets: many }).readerTargets).length, engine.REVIEW_MAX_READER_ENTRIES, "a policy keeps a hundred readers at the most");

  const options = normalizeOptions({ review: { readersTarget: 7.5, readerTargets: { a: 8 } } }, DEFAULT_OPTIONS);
  assert.deepEqual(options.review, { readersTarget: 7.5, readerTargets: { a: 8 } });
  assert.deepEqual(normalizeOptions({ review: { targetScore: 8 } }, options).review, { targetScore: 8, readersTarget: 7.5, readerTargets: { a: 8 } }, "a field sent changes that field only");
  assert.deepEqual(normalizeOptions({ review: { readersExcluded: ["b"] } }, options).review, { readersTarget: 7.5, readerTargets: { a: 8 }, readersExcluded: ["b"] });
  assert.equal("review" in normalizeOptions({}, DEFAULT_OPTIONS), false, "a book without them has no policy, as before");
});

test("which targets are in force: the review of the book in progress's own, field by field, over the run's; and the readers' gate needs a target, readers, and one that counts", () => {
  const { reviewReaderTargets, readerGate, gateFor, readersGated, readerTargetsFrom } = engine;
  const options = { readers: true, review: { readersTarget: 7, readerTargets: { a: 8 }, readersExcluded: ["z"] } };
  assert.deepEqual(reviewReaderTargets({ options }), { average: 7, each: { a: 8 }, excluded: new Set(["z"]) });
  assert.equal(reviewReaderTargets({ options: { readers: true } }), undefined, "a run without them has none");
  const campaign = { reason: "review-target", review: { readersTarget: 9 } };
  assert.deepEqual(reviewReaderTargets({ options, campaign }), { average: 9, each: { a: 8 }, excluded: new Set(["z"]) }, "the review of the book says its own average, and keeps the rest of the run's");
  const other = { reason: "outline-change", chapters: [] };
  assert.equal(reviewReaderTargets({ options, campaign: other }).average, 7, "another campaign has no policy of its own");
  assert.deepEqual(reviewReaderTargets({ options, campaign: { reason: "review-target", review: { readerTargets: { b: 6 }, readersExcluded: [] } } }), { average: 7, each: { b: 6 }, excluded: new Set() }, "a list the review gives replaces the run's, even an empty one");

  assert.ok(readerGate({ options }), "targets, readers on, no list of the readers that read: any counts");
  assert.equal(readerGate({ options: { ...options, readers: false } }), undefined, "the readers do not read in this run");
  assert.equal(readerGate({ options: { readers: true, review: { readersExcluded: ["z"] } } }), undefined, "leaving readers out asks nothing of the rest");
  assert.equal(readerGate({ options }, ["z"]), undefined, "the only reader that reads does not count");
  assert.ok(readerGate({ options }, ["z", "a"]));
  assert.equal(readerGate({ options }, []), undefined, "nobody reads");
  assert.equal(gateFor({ readers: true }, { readersTarget: 8 }).average, 8, "a review of the book that is not recorded yet");
  assert.equal(readersGated(readerTargetsFrom({ readerTargets: {} })), false);
  assert.equal(readersGated(readerTargetsFrom({ readerTargets: { a: 6 } })), true, "a target for one reader asks something");
});

// ─── The readers' votes against the targets ─────────────────────────────────

test("the readers' standing: the average of those that count, what is under its target, how far the targets are, and a reader that does not count has no say", () => {
  const { readerStanding, countingAverage, blockerText, blockersText } = engine;
  const targets = { average: 7.5, each: { emotional: 8, critical: 9 }, excluded: new Set(["critical"]) };
  const votes = [{ slug: "general", score: 7 }, { slug: "emotional", score: 6 }, { slug: "critical", score: 2 }];
  assert.equal(countingAverage(votes, targets.excluded), 6.5, "the critical reader is left out of the average");
  const standing = readerStanding(votes, targets);
  assert.deepEqual(standing, {
    average: 6.5,
    blockers: [{ subject: "average", vote: 6.5, target: 7.5 }, { subject: "reader", slug: "emotional", vote: 6, target: 8 }],
    shortfall: 30,
  }, "the critical reader's own target (9) is not asked of it: it does not count");
  assert.equal(blockersText(standing.blockers, "en", (slug) => (slug === "emotional" ? "Emotional Reader" : slug)), "the readers' average 6.5/10 is under 7.5/10; Emotional Reader gives 6/10, under the 8/10 asked of this reader");
  assert.equal(blockerText(standing.blockers[0], "it"), "la media dei lettori 6.5/10 è sotto 7.5/10");
  assert.equal(blockerText(standing.blockers[1], "it", () => "Lettore emotivo"), "Lettore emotivo dà 6/10, sotto i 8/10 chiesti a questo lettore");

  const met = readerStanding([{ slug: "general", score: 8 }, { slug: "emotional", score: 8 }], targets);
  assert.deepEqual([met.average, met.blockers, met.shortfall], [8, [], 0]);
  assert.deepEqual(readerStanding([], targets), { average: null, blockers: [], shortfall: 0 }, "with no vote nothing is under a target");
  assert.deepEqual(readerStanding([{ slug: "critical", score: 1 }], { average: 8, each: {}, excluded: new Set(["critical"]) }), { average: null, blockers: [], shortfall: 0 }, "when none counts there is no average to be under");
  assert.equal(readerStanding([{ slug: "a", score: 7.46 }], { average: 7.5, each: { a: 7.5 }, excluded: new Set() }).blockers.length, 0, "a vote is compared as it is shown, to a tenth");
});

test("the vote of a chapter's text as it is: the last reading, current while it is the last thing that happened and no fix followed it", () => {
  const { chapterReading, chapterStanding } = engine;
  assert.equal(chapterReading(undefined), null);
  assert.equal(chapterReading([{ director: 8 }]), null, "the readers never read it");

  assert.deepEqual(chapterReading([{ director: 8, readers: 6, accepted: 0 }]), { average: 6, current: true }, "no fix after their reading: it is the vote of the text as it is");
  assert.equal(chapterReading([{ director: 8, readers: 6, accepted: 2 }]).current, false, "fixes were applied after they read");
  assert.equal(chapterReading([{ director: 6, readers: 5, accepted: 0 }, { director: 8, accepted: 0 }]).current, false, "a round of the director came after");

  const end = { readers: 8, readerVotes: { a: 8, b: 8 }, round: 2, reading: "end" };
  assert.deepEqual(chapterReading([{ director: 8, readers: 6, accepted: 2 }, end]), { votes: [{ slug: "a", score: 8 }, { slug: "b", score: 8 }], average: 8, round: 2, reading: "end", current: true }, "a reading of their own is the vote of the text as it is");
  assert.equal(chapterReading([end, { director: 8.5, accepted: 0 }]).current, false);

  const targets = { average: 7.5, each: {}, excluded: new Set() };
  assert.deepEqual(chapterStanding([{ director: 8, readers: 6, accepted: 0 }], targets).standing.blockers, [{ subject: "average", vote: 6, target: 7.5 }], "an older round has the average, and that is enough for a target for the average");
  assert.equal(chapterStanding([{ director: 8, readers: 6, accepted: 0 }], targets).needsReading, false);
  assert.equal(chapterStanding([{ director: 8, readers: 6, accepted: 2 }], targets).needsReading, true, "what they said is of the text before the fixes");
  assert.equal(chapterStanding(undefined, targets).needsReading, true);
  assert.equal(chapterStanding([{ director: 8, readers: 6, accepted: 0 }], { ...targets, each: { a: 8 } }).needsReading, true, "a target for one reader needs the vote of each, which an older round does not have");
  assert.equal(chapterStanding([{ director: 8, readers: 6, accepted: 0 }], { ...targets, excluded: new Set(["a"]) }).needsReading, true, "and so does leaving one out of the average");
  const detailed = chapterStanding([{ readers: 7, readerVotes: { a: 9, b: 5 }, round: 1, reading: "check" }], { average: 7.5, each: { b: 6 }, excluded: new Set(["a"]) });
  assert.deepEqual([detailed.needsReading, detailed.standing.average, detailed.standing.blockers.map((blocker) => blocker.subject)], [false, 5, ["average", "reader"]], "the votes of each reader are read with the targets of today");
});

// ─── What a state keeps ─────────────────────────────────────────────────────

const chapterOf = (number, extra = {}) => ({ number, title: `T${number}`, slug: `00${number}-chapter-title-${number}`, summary: "s", goal: "g", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [], ...extra });
const stateWith = (chapters, extra = {}) => ({ ...engine.createAutopilotState(clock()), plan: { chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false }, ...extra });
const roundtrip = (state) => engine.parseAutopilotState(engine.serializeAutopilotState(state));

test("a state keeps the rounds with the votes of each reader, a reading of its own, and the review that waits for the readers; what cannot be read is dropped", () => {
  const rounds = [
    { director: 6, readers: 6.5, readerVotes: { general: 7, emotional: 6 }, round: 1, verdict: "revise", accepted: 1, rejected: 0 },
    { readers: 8, readerVotes: { general: 8, emotional: 8 }, round: 1, reading: "end" },
    { readers: 5, readerVotes: { general: 5 }, round: 2, reading: "check" },
  ];
  const state = stateWith([chapterOf(1, { rounds })]);
  assert.deepEqual(roundtrip(state).plan.chapters[0].rounds, rounds, "they survive every save");

  const odd = roundtrip(stateWith([chapterOf(1, { rounds: [
    { readerVotes: { a: "x", b: 12, "": 3, c: 7.26 }, round: 0, reading: "bogus" },
    { director: 7, readerVotes: ["a"], reading: "end", round: "2" },
    { director: 7, readerVotes: { a: "nine" } },
  ] })])).plan.chapters[0].rounds;
  assert.deepEqual(odd, [{ readerVotes: { b: 10, c: 7.3 } }, { director: 7, reading: "end", round: 2 }, { director: 7 }], "votes in range, what is not a vote or a reader left out, a round told by a number, a reading that is none dropped");
  assert.deepEqual(roundtrip(stateWith([chapterOf(1, { rounds: [{ readerVotes: { a: 7 }, reading: "end" }, { readerVotes: {} }, { reading: "end" }] })])).plan.chapters[0].rounds, [{ readerVotes: { a: 7 }, reading: "end" }], "the votes of a reader are enough for a round; a mark with no number is none");

  const review = { chapterNumber: 1, round: 2, readersPending: ["a"], readerScores: [], readersSummaryDone: false, findings: [], specialistsDone: true, directorDone: true, verdict: "approve", decisions: [], repairQueue: [], previousFixes: [], history: [], repairs: 3, readText: 2, reading: "end", readRecorded: true, reads: [25, 10], gateStop: "plateau" };
  const waiting = ({ repairs, readText, reading, readRecorded, reads, gateStop }) => ({ repairs, readText, reading, readRecorded, reads, gateStop });
  assert.deepEqual(waiting(roundtrip({ ...stateWith([chapterOf(1, { status: "review" })]), review }).review), waiting(review), "a review that waits for the readers is kept as it is, so that a restart goes on from it");
  const odder = roundtrip({ ...stateWith([chapterOf(1, { status: "review" })]), review: { ...review, repairs: "many", readText: -4, reading: "now", readRecorded: "yes", reads: ["a", 12, -1], gateStop: "never" } }).review;
  assert.deepEqual([odder.repairs, odder.readText, odder.reading, odder.readRecorded, odder.reads, odder.gateStop], [undefined, 0, undefined, undefined, [12, 0], undefined]);

  const reviewCampaign = { id: "review_1", reason: "review-target", createdAt: "2026-01-01T00:00:00.000Z", chapters: [{ number: 1, mode: "follow", status: "waiting" }], review: { targetScore: 8, readersTarget: 7.5, readerTargets: { a: 8 }, readersExcluded: ["b"], scope: [1], round: 1, windowStart: 1, phase: "chapters", start: { lowest: 8, book: 8, below: 1, readers: 7 }, history: [{ round: 1, chapters: [1], lowest: 8, book: 8, below: 1, readers: null, endedAt: "2026-01-01T00:00:00.000Z" }], stalled: 0 } };
  const kept = roundtrip({ ...stateWith([chapterOf(1)]), campaign: reviewCampaign }).campaign;
  assert.deepEqual(kept, reviewCampaign, "a review of the book keeps its targets for the readers and their lowest average");
  const softly = roundtrip({ ...stateWith([chapterOf(1)]), campaign: { ...reviewCampaign, review: { ...reviewCampaign.review, readersTarget: "high", readerTargets: { a: 20, b: "x" }, readersExcluded: [1, "c"] } } }).campaign.review;
  assert.deepEqual([softly.readersTarget, softly.readerTargets, softly.readersExcluded], [undefined, { a: 10 }, ["c"]], "its targets are read as softly as the policy's");
});

// ─── A review of the book asked with them ───────────────────────────────────

test("a review of the book is asked with targets for the readers as it is asked with the rest: what is not a vote or a list of readers is refused", async () => {
  const { RevisionCampaignError, createReviewCampaign, createAutopilotState } = engine;
  const finished = { ...stateWith([chapterOf(1, { score: 6, rounds: [{ director: 6, readers: 7, accepted: 0 }] })]), concept: { done: true }, finalDone: true, finalReview: { verdict: "approve", score: 7, text: "ok", at: "2026-01-01T00:00:00.000Z" }, options: { ...createAutopilotState(clock()).options, readers: true } };
  const snapshot = { chapters: [], files: new Map() };
  const refused = (input, pattern) => assert.throws(() => createReviewCampaign({ targetScore: 5, ...input }, finished, snapshot, clock()), (error) => error instanceof RevisionCampaignError && error.code === "invalid_request" && pattern.test(error.message), JSON.stringify(input));
  refused({ readersTarget: 11 }, /readers' target is a vote from 1 to 10/);
  refused({ readersTarget: "7" }, /readers' target/);
  refused({ readerTargets: { a: 0 } }, /target of each reader/);
  refused({ readerTargets: [7] }, /target of each reader/);
  refused({ readerTargets: null }, /target of each reader/);
  refused({ readersExcluded: [1] }, /do not count/);
  refused({ readersExcluded: "a" }, /do not count/);

  const average = createReviewCampaign({ targetScore: 5, readersTarget: 7.46 }, finished, snapshot, clock(), "review_1");
  assert.deepEqual(average.chapters.map((item) => item.number), [1], "the director is content with the chapter (6 over the target 5), the readers' 7 are under 7.5: it is reviewed");
  assert.deepEqual([average.review.readersTarget, average.review.start.readers], [7.5, 7], "the target as the policy keeps it, and the lowest average of the readers is among the votes it began with");
  const detailed = createReviewCampaign({ targetScore: 5, readersTarget: 7.46, readerTargets: { a: 8 }, readersExcluded: ["b", "b"] }, finished, snapshot, clock(), "review_2");
  assert.deepEqual([detailed.review.readersTarget, detailed.review.readerTargets, detailed.review.readersExcluded], [7.5, { a: 8 }, ["b"]], "kept as the policy keeps them");
  assert.deepEqual([detailed.chapters.map((item) => item.number), detailed.review.start.readers], [[1], null], "a round of an older engine has no vote of each reader: the chapter has to be read, and there is no average to begin with");
  assert.throws(() => createReviewCampaign({ targetScore: 5, readersTarget: 6 }, finished, snapshot, clock()), (error) => error.code === "nothing_to_review" && /readers' targets are met/.test(error.message), "met: nothing is under a target");
  assert.throws(() => createReviewCampaign({ targetScore: 5 }, finished, snapshot, clock()), (error) => error.code === "nothing_to_review" && !/readers/.test(error.message), "without them the message is the one it was");
  const off = { ...finished, options: { ...finished.options, readers: false } };
  assert.throws(() => createReviewCampaign({ targetScore: 5, readersTarget: 9 }, off, snapshot, clock()), (error) => error.code === "nothing_to_review", "the readers do not read in this run: their targets ask nothing");
});

// ─── The estimate ───────────────────────────────────────────────────────────

test("the estimate counts the closing reading when the readers have targets, the chapters only read in a review of the book, and nothing when they have none", () => {
  const { estimateAutopilotRun } = engine;
  const calls = (result, kind) => result.steps[kind]?.calls ?? { min: 0, max: 0 };
  const base = { brief: brief(4), options: { readers: true, maxReaders: 2, specialists: true }, maxReviewRounds: 2, progress: { chaptersDone: 0, planned: 4, conceptDone: true } };
  const plain = estimateAutopilotRun(base);
  assert.deepEqual([calls(plain, "reader"), calls(plain, "readers-summary")], [{ min: 8, max: 8 }, { min: 4, max: 4 }]);

  const aimed = estimateAutopilotRun({ ...base, options: { ...base.options, review: { readersTarget: 7.5 } } });
  assert.deepEqual(calls(aimed, "reader"), { min: 8, max: 24 }, "a chapter approved at once is read once; one that is corrected in both its rounds is read after each");
  assert.deepEqual(calls(aimed, "readers-summary"), { min: 4, max: 12 });
  assert.deepEqual(calls(aimed, "director-review"), calls(plain, "director-review"), "the rest is the review it was");
  const forOne = estimateAutopilotRun({ ...base, options: { ...base.options, review: { readerTargets: { "standard-general": 8 } } } });
  assert.deepEqual(calls(forOne, "reader"), { min: 8, max: 24 }, "a target for one reader is a target");
  assert.ok(aimed.calls.max > plain.calls.max, "it costs more calls at the most");
  assert.equal(aimed.calls.min, plain.calls.min, "and the least it costs is the same");

  const leftOut = estimateAutopilotRun({ ...base, options: { ...base.options, review: { readersExcluded: ["standard-critical"] } } });
  assert.deepEqual(leftOut.steps, plain.steps, "leaving readers out asks nothing more of them");
  assert.deepEqual(leftOut.calls, plain.calls);
  const off = estimateAutopilotRun({ ...base, options: { ...base.options, readers: false, review: { readersTarget: 7.5 } } });
  assert.deepEqual(calls(off, "reader"), { min: 0, max: 0 }, "readers that do not read have no targets to meet");

  const review = { ...base, options: { ...base.options, review: { readersTarget: 7.5 } }, progress: { chaptersDone: 2, planned: 4, conceptDone: true, finalDone: false, reviewOnly: true } };
  const whole = estimateAutopilotRun(review);
  const checked = estimateAutopilotRun({ ...review, progress: { ...review.progress, checkOnly: 2 } });
  assert.deepEqual(calls(whole, "director-review"), { min: 2, max: 4 });
  assert.deepEqual(calls(checked, "director-review"), { min: 0, max: 4 }, "two chapters that only need their readers' vote: in the least, no review of them");
  assert.deepEqual([calls(checked, "reader").min, calls(checked, "readers-summary").min, calls(checked, "consolidate").min], [4, 2, 0], "they are read once, and summarized");
  const pin = { rounds: 1, repairs: 0, planRevisions: 0 };
  assert.deepEqual(calls(estimateAutopilotRun({ ...review, scenario: pin }), "director-review"), { min: 2, max: 2 }, "the reviews pinned: a point");
  assert.deepEqual(calls(estimateAutopilotRun({ ...review, progress: { ...review.progress, checkOnly: 2 }, scenario: pin }), "director-review"), { min: 0, max: 2 }, "with chapters only read it stays an interval: nobody knows which will need more");
  assert.deepEqual(estimateAutopilotRun({ ...base, options: base.options, progress: { ...review.progress, checkOnly: 2 } }).steps, estimateAutopilotRun({ ...base, progress: review.progress }).steps, "without targets for the readers nothing is only read");
});

// ─── The personal server ────────────────────────────────────────────────────

test("a personal server is sent the targets for the readers only if it announces them", async () => {
  const log = [];
  const makeClient = (features) => new engine.NarrariumServerClient({
    baseUrl: "http://127.0.0.1:24242",
    token: "nrs_me",
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/info") return Response.json({ serverId: "s", name: "Home", version: "0.1.20", protocol: 1, features });
      log.push({ method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json(url.pathname.endsWith("/review") ? { campaign: null, frozen: { mode: "ask", changes: [], pending: [], warnings: [] } } : { state: null });
    },
  });
  const known = ["autopilot", "autopilot-outline-brief", engine.SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY, engine.SERVER_FEATURE_AUTOPILOT_REVIEW_BOOK, engine.SERVER_FEATURE_AUTOPILOT_REVIEW_POLICY];
  const all = [...known, engine.SERVER_FEATURE_AUTOPILOT_REVIEW_TARGETS];
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_REVIEW_TARGETS, "autopilot-review-targets");
  assert.deepEqual([engine.serverSupportsReviewTargets({ features: all }), engine.serverSupportsReviewTargets(all), engine.serverSupportsReviewTargets({ features: known }), engine.serverSupportsReviewTargets(null)], [true, true, false, false]);
  assert.deepEqual(
    [engine.asksReviewTargets({ readersTarget: 7 }), engine.asksReviewTargets({ readerTargets: { a: 8 } }), engine.asksReviewTargets({ readersExcluded: ["a"] }), engine.asksReviewTargets({ readersTarget: null, readerTargets: null, readersExcluded: [] }), engine.asksReviewTargets({ readerTargets: {} }), engine.asksReviewTargets({ targetScore: 8 }), engine.asksReviewTargets(undefined)],
    [true, true, true, false, false, false, false],
    "a value asks; taking one back (null, an empty list) is sent anywhere: an older server has nothing of it to take back",
  );

  const newer = makeClient(all);
  await newer.startAutopilot("my book", { options: { review: { targetScore: 8, readersTarget: 7.5, readerTargets: { a: 8 }, readersExcluded: ["b"] } } });
  await newer.configureAutopilot("my book", { options: { review: { readersExcluded: ["b"] } } });
  await newer.reviewBook("my book", { targetScore: 8, readersTarget: 7.5 });
  assert.deepEqual(log.map((entry) => entry.path), ["/api/v1/books/my%20book/autopilot/start", "/api/v1/books/my%20book/autopilot/configure", "/api/v1/books/my%20book/autopilot/review"]);
  assert.deepEqual(log[0].body.options.review, { targetScore: 8, readersTarget: 7.5, readerTargets: { a: 8 }, readersExcluded: ["b"] });

  const older = makeClient(known);
  await older.startAutopilot("my book", { options: { review: { targetScore: 8, maxRounds: 3 } } });
  await older.configureAutopilot("my book", { options: { review: { targetScore: 8, readersTarget: null, readerTargets: null, readersExcluded: null } } });
  await older.reviewBook("my book", { targetScore: 8, maxRounds: 3 });
  const sent = log.length;
  const refusal = (error) => error.code === "feature_unavailable" && error.status === 501 && /autopilot-review-targets/.test(error.message) && /update the server/i.test(error.message);
  await assert.rejects(older.startAutopilot("my book", { options: { review: { readersTarget: 7 } } }), refusal);
  await assert.rejects(older.configureAutopilot("my book", { options: { review: { readerTargets: { a: 8 } } } }), refusal);
  await assert.rejects(older.reviewBook("my book", { targetScore: 8, readersExcluded: ["a"] }), refusal);
  assert.equal(log.length, sent, "nothing was sent to the server that does not know them");
});
