import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";
import { FAST, finishedBook, insights, newSession, run as runReview } from "./review-fakes.mjs";
import { bookRoundAi } from "./book-round-fakes.mjs";

// The room of the wildcards in the autopilot (#127, `ReviewPolicy.wildcards`): consulted once before the review of the plan of a design run (the step `wildcards`, a
// pre-mortem), and when a review of the book stalls (the plateau breaker the host registers). The director triages what the room gives; only the ideas it accepts go on,
// into the review of the design or into the corrections of the whole book, and the journal of the room keeps the consultation with every decision. Off by default.

const {
  AutopilotSession, IDEAS_JOURNAL_FILE, normalizeReviewPolicy, parseAutopilotState, parseIdeasJournal, plateauBreakers, registerWildcardsPlateauBreaker,
  reviewWildcards, wildcardsPlateauBreaker, wildcardsTakePlateau, writeOutlineBrief,
} = engine;

const STATE = "autopilot/state.json";
const clock = () => new Date("2026-11-27T09:00:00.000Z");
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const journalOf = (store) => parseIdeasJournal(store.files.get(IDEAS_JOURNAL_FILE));
const asked = (ai, name) => ai.calls.filter((call) => call.json?.name === name);
const tasksOf = (events) => events.filter((event) => event.type === "task-started").map((event) => event.activity.task);

test("the room in the review policy: off unless turned on, each number in its range, given whole, and `null` takes it back", () => {
  assert.deepEqual(reviewWildcards({ options: {} }), { design: false, plateau: false, voices: 4, rounds: 1, moneyCap: 0 });
  const policy = normalizeReviewPolicy({ targetScore: 8, wildcards: { design: true, plateau: true, voices: 12, rounds: 9, moneyCap: 0.5, extra: "kept out" } });
  assert.deepEqual(policy, { targetScore: 8, wildcards: { design: true, plateau: true, voices: 8, rounds: 3, moneyCap: 0.5 } });
  assert.deepEqual(reviewWildcards({ options: { review: policy } }), { design: true, plateau: true, voices: 8, rounds: 3, moneyCap: 0.5 });
  assert.deepEqual(normalizeReviewPolicy({ wildcards: { voices: 0, rounds: 0, moneyCap: -2, design: "yes" } }), { wildcards: { voices: 1, rounds: 1 } }, "a switch is on only when it is true; a cap of 0 or less is none");
  assert.deepEqual(normalizeReviewPolicy({ wildcards: { plateau: true } }, policy), { targetScore: 8, wildcards: { plateau: true } }, "given whole: it replaces what the policy had");
  assert.deepEqual(normalizeReviewPolicy({ wildcards: "sometimes" }, policy), policy, "what is not a mapping leaves what there was");
  assert.deepEqual(normalizeReviewPolicy({ wildcards: null }, policy), { targetScore: 8 }, "null takes it back");
  assert.equal(normalizeReviewPolicy({ wildcards: {} }), undefined, "an empty room is no room");
});

test("the plan remembers that the room was asked about its design, and what the director accepted, through a save", () => {
  const plan = { chapters: [], approved: false, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false, wildcardsDone: true, wildcardsMaterial: "IDEAS ACCEPTED…" };
  const state = parseAutopilotState(JSON.stringify({ ...engine.createAutopilotState(clock()), plan }));
  assert.equal(state.plan.wildcardsDone, true);
  assert.equal(state.plan.wildcardsMaterial, "IDEAS ACCEPTED…");
  const older = parseAutopilotState(JSON.stringify({ ...engine.createAutopilotState(clock()), plan: { ...plan, wildcardsDone: "yes", wildcardsMaterial: "   " } }));
  assert.deepEqual([older.plan.wildcardsDone, older.plan.wildcardsMaterial], [undefined, undefined]);
});

// ─── Before the review of a design ──────────────────────────────────────────────────────────────

const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";

async function describedBook() {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }) });
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

async function design(store, ai, options = {}) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  await session.start({ design: { chapters: 3 }, options: { readersOnPlan: false, pauseAfterPlan: false, ...options } });
  await session.waitForIdle();
  return { events, state: stateOf(store) };
}

function designAi(reviews = []) {
  const seen = [];
  const ai = createFakeAutopilotAi({
    designReview: (round, user) => {
      seen.push({ round, user });
      return reviews[Math.min(round - 1, reviews.length - 1)] ?? { verdict: "approve", score: 8, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [] };
    },
  });
  return { ai, seen };
}

test("a design run with the room turned on asks it before the review: a pre-mortem, triaged by the director, whose accepted ideas the review reads", async () => {
  const store = await describedBook();
  await store.commit([{ path: "bible/decisions.md", content: "---\ntype: bible\nid: bible:decisions\ndecisions:\n  - id: d-001\n    date: 2026-11-20\n    decision: The tide never speaks.\n    by: author\n    status: locked\n---\n", expectedHash: null }], "decisions");
  const { ai, seen } = designAi();
  const { events, state } = await design(store, ai, { review: { wildcards: { design: true, voices: 2 } } });
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.design.outcome, "target");
  assert.deepEqual(tasksOf(events).filter((task) => task !== "concept"), ["plan", "wildcards", "plan-review"], "the room comes after the plan and before its review");

  const voices = asked(ai, "wildcard_ideas");
  assert.deepEqual(voices.map((call) => /You are «([^»]+)»/.exec(call.user)?.[1]), ["The Devil's Advocate", "The Naive"], "the voices of the pre-mortem, as many as the policy says");
  for (const call of voices) {
    assert.match(call.user, /The director asks the room: This is the design of the book, before the director's first review/);
    assert.match(call.user, /WHAT THE ROOM READS: plan — The plan of the book/);
    assert.match(call.user, /THE CHAPTER PLAN \(3 chapters\):\n1\. /);
    assert.equal(call.cacheKey, "book/wildcards");
  }
  assert.ok(voices.every((call, index) => index === 0 || ai.calls.indexOf(call) > ai.calls.indexOf(voices[index - 1])), "one voice after the other");
  const triage = asked(ai, "wildcard_triage");
  assert.equal(triage.length, 1, "the director triages once");
  assert.match(triage[0].user, /CANON:/);
  assert.match(triage[0].user, /The author's rules, which bind you[\s\S]*- d-001: The tide never speaks\./, "the decisions the author locked bind the triage");

  assert.equal(seen.length, 1);
  assert.match(seen[0].user, /THE ROOM'S IDEAS YOU ACCEPTED \(before this review\):\nIDEAS ACCEPTED FROM THE ROOM \(Fuori dal coro\)/);
  assert.match(seen[0].user, /The Devil's Advocate: tell it from the tide \(The Devil's Advocate\): Let the tide narrate the night of the flood\./, "the adopted idea as it is");
  assert.match(seen[0].user, /Keep the idea, in one paragraph only\./, "the adapted one in the director's version");
  assert.match(seen[0].user, /fold them into your review/);
  assert.equal(state.plan.wildcardsDone, true);
  assert.equal(state.plan.wildcardsMaterial, undefined, "read once, by the review that follows");

  const journal = journalOf(store);
  assert.equal(journal.entries.length, 1);
  const [entry] = journal.entries;
  assert.deepEqual([entry.by, entry.target.kind, entry.preset, entry.voices], ["autopilot", "plan", "pre-mortem", ["devils-advocate", "naive"]]);
  assert.deepEqual(entry.ideas.map((idea) => [idea.decision?.verdict, idea.decision?.by]), [["adopted", "director"], ["adapted", "director"], ["rejected", "director"], ["rejected", "director"]]);
  assert.ok(entry.ideas.every((idea) => idea.advisory === true && idea.decision.reason));

  const told = insights(events, "wildcardsTriaged");
  assert.equal(told.length, 1);
  assert.deepEqual(told[0].figures, { voices: 2, ideas: 4, accepted: 2 });
  assert.match(told[0].title, /The wildcards: 2 voices, 4 ideas; the director accepts 2/);
  const step = events.find((event) => event.type === "task-finished" && event.activity.task === "wildcards");
  assert.match(step.activity.summary, /2 voices, 4 ideas, 2 accepted by the director/);
});

test("the room looks at a design once: a review that asks changes is followed by the revision and another review, not by another consultation", async () => {
  const store = await describedBook();
  const { ai, seen } = designAi([
    { verdict: "revise", score: 6, summary: "Not yet.", strengths: [], changes: [{ chapterNumber: 2, instruction: "Raise the stakes." }], guidance: [], critical: [] },
    { verdict: "approve", score: 8, summary: "Fine.", strengths: [], changes: [], guidance: [], critical: [] },
  ]);
  const { events, state } = await design(store, ai, { review: { wildcards: { design: true, voices: 1 } } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.equal(seen.length, 2);
  assert.equal(asked(ai, "wildcard_ideas").length, 1, "one consultation for the design");
  assert.equal(tasksOf(events).filter((task) => task === "wildcards").length, 1);
  assert.match(seen[0].user, /THE ROOM'S IDEAS YOU ACCEPTED/);
  assert.doesNotMatch(seen[1].user, /THE ROOM'S IDEAS YOU ACCEPTED/, "the second review has the changes it asked, not the room again");
});

test("without the room in the policy a design run is the one it always was: no consultation, no journal", async () => {
  const store = await describedBook();
  const { ai } = designAi();
  const { events, state } = await design(store, ai, { review: { wildcards: { plateau: true } } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.equal(tasksOf(events).includes("wildcards"), false);
  assert.equal(asked(ai, "wildcard_ideas").length + asked(ai, "wildcard_triage").length, 0);
  assert.equal(store.files.has(IDEAS_JOURNAL_FILE), false);
});

test("a room whose every voice is turned off says so, and the review goes on without it", async () => {
  const store = await describedBook();
  for (const slug of ["devils-advocate", "naive", "antagonist", "ledger-keeper", "subversive", "cliche-hunter", "twist-engineer", "genre-guest", "chaos-maker", "poet", "continuity-keeper", "secrets-guardian", "domain-expert", "moral-stress-test"]) {
    await store.commit([{ path: `wildcards/${slug}.md`, content: `---\ntype: wildcard\nslug: ${slug}\nenabled: false\n---\n`, expectedHash: null }], "off");
  }
  const { ai, seen } = designAi();
  const { events, state } = await design(store, ai, { review: { wildcards: { design: true } } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.equal(asked(ai, "wildcard_ideas").length, 0);
  assert.equal(insights(events, "wildcardsNone").length, 1);
  assert.doesNotMatch(seen[0].user, /THE ROOM'S IDEAS YOU ACCEPTED/);
  assert.equal(stateOf(store).plan.wildcardsDone, true, "asked once all the same: it is not asked again");
});

// ─── At a plateau of a review of the book ──────────────────────────────────────────────────────

const chapterRef = (number) => `chapter:${String(number).padStart(3, "0")}-ch`;
const secretFile = (name, reveal) => `---\ntype: secret\nid: secret:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}\ntitle: ${name}\nreveal_in: ${chapterRef(reveal)}\n---\n\n# ${name}\n\nThe truth of ${name}.\n`;
const chapterFile = (number, title) => `---\ntype: chapter\nid: chapter:${String(number).padStart(3, "0")}-ch\nnumber: ${number}\ntitle: ${title}\nsummary: Summary of ${title}.\n---\n\n# ${title}\n`;
const sceneFile = (title, body) => `---\ntype: paragraph\nnumber: 1\ntitle: ${title}\n---\n\n${body}\n`;

function plateauBook() {
  return new MemoryBookStore({
    ...seedBookFiles({ title: "The Glass Harbor" }),
    "secrets/the-debt.md": secretFile("The Debt", 1),
    "secrets/the-wall.md": secretFile("The Wall Is Failing", 9),
    "chapters/001-ch/chapter.md": chapterFile(1, "Arrival"),
    "chapters/001-ch/001-quay.md": sceneFile("The Quay", "Mira stepped on the quay."),
    "chapters/002-ch/chapter.md": chapterFile(2, "The Harbour"),
    "chapters/002-ch/001-office.md": sceneFile("The Office", "Orrin smiled behind his desk."),
    "bible/decisions.md": "---\ntype: bible\nid: bible:decisions\ndecisions:\n  - id: d-001\n    date: 2026-11-20\n    decision: Orrin never confesses.\n    by: author\n    status: locked\n---\n",
  });
}

const plateau = { campaignId: "campaign-1", round: 2, target: 7.5, votes: { lowest: 8, book: 6, below: 0 }, history: [], kind: "book", broken: 0, language: "en" };

function plateauContext(store, snapshot, review, ai) {
  const told = [];
  return {
    told,
    context: {
      bookId: "book",
      state: { options: { review }, constraints: ["Never kill Mira."], finalReview: { points: ["major: The Wall Is Failing is never paid off", "next step: Tighten the middle chapters"] } },
      store,
      snapshot,
      signal: new AbortController().signal,
      ai: (request) => ai.complete(request),
      insight: (tone, title, detail, extra) => told.push({ tone, title, detail, ...extra }),
      now: clock,
    },
  };
}

test("the plateau breaker of the room: the creative room reads the book and the points of the director it may know, the director triages, and the accepted ideas are the material of the corrections", async () => {
  const store = plateauBook();
  const snapshot = await engine.loadBookSnapshot(store);
  const ai = createFakeAutopilotAi();
  const { context, told } = plateauContext(store, snapshot, { wildcards: { plateau: true, voices: 2 } }, ai);
  const answer = await wildcardsPlateauBreaker(plateau, context);
  assert.equal(answer.action, "continue");
  assert.match(answer.material, /^IDEAS ACCEPTED FROM THE ROOM \(Fuori dal coro\)/);
  const voices = asked(ai, "wildcard_ideas");
  assert.deepEqual(voices.map((call) => /You are «([^»]+)»/.exec(call.user)?.[1]), ["The Subversive", "The Cliché Hunter"], "the creative room");
  for (const call of voices) {
    assert.match(call.user, /The director asks the room: The review of this book has stalled: every chapter has reached its target \(7\.5\/10\), and the book is still at 6\/10/);
    assert.match(call.user, /1\. Arrival — Summary of Arrival\.\n2\. The Harbour — Summary of The Harbour\./);
    assert.match(call.user, /WHAT THE DIRECTOR SAID OF THE WHOLE BOOK[^\n]*\n1\. next step: Tighten the middle chapters/);
    assert.doesNotMatch(call.user, /Wall Is Failing/, "a point that names a secret still hidden at the end of what is written is not told to the voices");
    assert.match(call.user, /The Debt: revealed in chapter 1/, "a secret already revealed is");
  }
  const triage = asked(ai, "wildcard_triage");
  assert.equal(triage.length, 1);
  assert.match(triage[0].user, /The author's rules, which bind you[\s\S]*Never kill Mira\./, "the director weighs the author's rules, as instructions");
  assert.match(triage[0].user, /LOCKED DECISIONS[^\n]*\n- d-001: Orrin never confesses\./, "and the decisions the author locked in the Bible");
  for (const call of voices) assert.doesNotMatch(call.user, /Orrin never confesses/, "the voices propose freely: the director holds them to the decisions");
  assert.equal(answer.changes.length, 1);
  assert.equal(answer.changes[0].path, IDEAS_JOURNAL_FILE);
  assert.equal(answer.changes[0].expectedHash, null);
  const [entry] = parseIdeasJournal(answer.changes[0].content).entries;
  assert.deepEqual([entry.by, entry.target.kind, entry.at, entry.ideas.filter((idea) => idea.decision?.by === "director").length], ["autopilot", "book", clock().toISOString(), 4]);
  assert.deepEqual(told.map((entry) => [entry.code, entry.figures]), [["wildcardsTriaged", { voices: 2, ideas: 4, accepted: 2 }]]);

  // The same step tried again (the corrections failed after the room answered) does not pay the room twice: only the director triages again.
  const before = ai.calls.length;
  const again = await wildcardsPlateauBreaker(plateau, context);
  assert.equal(again.action, "continue");
  assert.deepEqual(ai.calls.slice(before).map((call) => call.json?.name), ["wildcard_triage"]);
});

test("the plateau breaker stops when the director accepts nothing, keeping the rejections in the journal; and it is never asked for a book whose policy leaves the room off", async () => {
  const store = plateauBook();
  const snapshot = await engine.loadBookSnapshot(store);
  const ai = createFakeAutopilotAi({ wildcardTriage: (ids) => ({ decisions: ids.map((id) => ({ id, verdict: "rejected", reason: "Not for this book." })), summary: "Nothing." }) });
  const { context } = plateauContext(store, snapshot, { wildcards: { plateau: true, voices: 1 } }, ai);
  const answer = await wildcardsPlateauBreaker(plateau, context);
  assert.equal(answer.action, "stop");
  assert.deepEqual(parseIdeasJournal(answer.changes[0].content).entries[0].ideas.map((idea) => idea.decision.verdict), ["rejected", "rejected"]);

  const off = plateauContext(store, snapshot, { bookRound: "apply" }, ai);
  const calls = ai.calls.length;
  assert.deepEqual(await wildcardsPlateauBreaker(plateau, off.context), { action: "stop" });
  assert.equal(ai.calls.length, calls, "nothing asked");
  assert.deepEqual(
    [
      wildcardsTakePlateau({ options: { review: { wildcards: { plateau: true } } } }),
      wildcardsTakePlateau({ options: { review: { wildcards: { plateau: true } } }, campaign: { review: { broken: 1 } } }),
      wildcardsTakePlateau({ options: { review: { wildcards: { plateau: true, rounds: 2 } } }, campaign: { review: { broken: 1 } } }),
      wildcardsTakePlateau({ options: { review: { wildcards: { design: true } } } }),
      wildcardsTakePlateau({ options: {} }),
    ],
    [true, false, true, false, false],
    "as many consultations as the policy allows in one review, and none when it is off",
  );
});

test("registered by the host, the room takes on the plateau of a review that turns it on: the corrections of the book read what the director accepted, and the journal is written with them", async () => {
  const off = registerWildcardsPlateauBreaker();
  const twice = registerWildcardsPlateauBreaker();
  try {
    assert.equal(plateauBreakers().length, 1, "once, however many times a host asks");
    const ai = bookRoundAi({ chapters: { 1: [["approve", 8]], 2: [["approve", 8]] }, books: [6] });
    const store = await finishedBook(ai, 2);
    await newSession(store, ai).session.configure({ options: { ...FAST, review: { wildcards: { plateau: true, voices: 2 } } } });
    await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
    const { events, state } = await runReview(store, ai);
    assert.equal(state.status, "completed", state.lastError?.message);
    assert.equal(asked(ai, "wildcard_ideas").length, 2, "one consultation of two voices, at the plateau");
    assert.equal(asked(ai, "wildcard_triage").length, 1);
    const withRoom = ai.asked.filter((entry) => /WHAT THE ROOM FOUND:\nIDEAS ACCEPTED FROM THE ROOM \(Fuori dal coro\)/.test(entry.user));
    assert.equal(withRoom.length, 1, "the corrections of the round the room made read its accepted ideas");
    assert.equal(insights(events, "plateauBroken").length, 1);
    assert.equal(insights(events, "wildcardsTriaged").length, 1);
    const journal = journalOf(store);
    assert.deepEqual(journal.entries.map((entry) => [entry.by, entry.target.kind, entry.preset]), [["autopilot", "book", "creative-room"]]);
    assert.deepEqual([state.reviews.at(-1).outcome, state.campaign], ["plateau", undefined], "one consultation (the policy's), then the plateau ends the review");
  } finally {
    off();
    assert.equal(plateauBreakers().length, 1, "still held by the other host");
    twice();
    off();
  }
  assert.equal(plateauBreakers().length, 0, "let go by every host: taken away");
});

test("registered, the room changes nothing for a review whose policy leaves it off: the plateau ends it as it always did", async () => {
  const off = registerWildcardsPlateauBreaker();
  try {
    const ai = bookRoundAi({ chapters: { 1: [["approve", 8]], 2: [["approve", 8]] }, books: [6] });
    const store = await finishedBook(ai, 2);
    await newSession(store, ai).session.reviewBook({ targetScore: 7.5, bookRound: "apply" });
    const { events, state } = await runReview(store, ai);
    assert.equal(state.status, "completed", state.lastError?.message);
    assert.equal(ai.asked.length, 2, "two rounds, then the stall ends it, as without a breaker");
    assert.equal(asked(ai, "wildcard_ideas").length, 0);
    assert.equal(insights(events, "plateauBroken").length, 0);
    assert.deepEqual([state.reviews.at(-1).outcome, state.reviews.at(-1).rounds], ["plateau", 2]);
    assert.equal(store.files.has(IDEAS_JOURNAL_FILE), false);
  } finally {
    off();
  }
});

// ─── The personal server ────────────────────────────────────────────────────────────────────────

test("a personal server is sent a policy that turns the room on only if it announces `autopilot-wildcards`", async () => {
  const log = [];
  const makeClient = (features) => new engine.NarrariumServerClient({
    baseUrl: "http://127.0.0.1:24242",
    token: "nrs_me",
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/info") return Response.json({ serverId: "s", name: "Home", version: "0.1.23", protocol: 1, features });
      log.push({ path: url.pathname, body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json({ state: null });
    },
  });
  const known = ["autopilot", "autopilot-outline-brief", engine.SERVER_FEATURE_AUTOPILOT_REVIEW_POLICY, engine.SERVER_FEATURE_AUTOPILOT_DESIGN];
  const all = [...known, engine.SERVER_FEATURE_AUTOPILOT_WILDCARDS];
  assert.equal(engine.SERVER_FEATURE_AUTOPILOT_WILDCARDS, "autopilot-wildcards");
  assert.deepEqual([engine.serverSupportsWildcards({ features: all }), engine.serverSupportsWildcards(all), engine.serverSupportsWildcards({ features: known }), engine.serverSupportsWildcards(null)], [true, true, false, false]);
  assert.deepEqual(
    [{ wildcards: { design: true } }, { wildcards: { plateau: true, voices: 3 } }, { wildcards: { voices: 3 } }, { wildcards: null }, {}, undefined].map(engine.asksWildcards),
    [true, true, false, false, false, false],
    "a room turned on asks; one with both off, or `null`, is sent anywhere",
  );
  await makeClient(all).startAutopilot("b", { design: { chapters: 3 }, options: { review: { wildcards: { design: true, voices: 3 } } } });
  assert.deepEqual(log[0].body.options.review, { wildcards: { design: true, voices: 3 } });
  const older = makeClient(known);
  await older.configureAutopilot("b", { options: { review: { wildcards: null } } });
  const sent = log.length;
  const refusal = (error) => error.code === "feature_unavailable" && error.status === 501 && /autopilot-wildcards/.test(error.message);
  await assert.rejects(older.configureAutopilot("b", { options: { review: { wildcards: { plateau: true } } } }), refusal);
  await assert.rejects(older.startAutopilot("b", { design: { chapters: 3 }, options: { review: { wildcards: { design: true } } } }), refusal);
  assert.equal(log.length, sent, "nothing was sent to the server that does not know it");
});
