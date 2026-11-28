import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import * as core from "../dist/annotations/index.js";
import { MemoryBookStore } from "../dist/testing/index.js";
import { clock, finishedBook, folder, insights, newSession, run, scene, stateOf, votingAi } from "./review-fakes.mjs";

// The notes of the author as the input of the autopilot (reason `annotations`): the open notes of the chapters it closed are rewritten scene by scene as they ask, the chapters
// are reviewed again, and each note it answered is closed as handled by the autopilot, with what it did. The chapters of the author's are held back unless included.

const { RevisionCampaignError, createAnnotationsCampaign, readAnnotationNotes, annotationInstruction, serverSupportsAnnotations, CAMPAIGN_FEATURES, SERVER_FEATURE_AUTOPILOT_ANNOTATIONS } = engine;

const AT = "2026-01-01T00:00:00.000Z";
const ids = ["a-mi4k2000-aaaaaa", "a-mi4k3000-bbbbbb", "a-mi4k4000-cccccc", "a-mi4k5000-dddddd"];
const slug = (number) => folder(number).slice("chapters/".length);
const path = (number) => `annotations/chapters/${slug(number)}.yml`;

function note(chapter, id, extra = {}) {
  return { id, paragraph: "001-scene-1-title", quote: "the old gate", prefix: "", suffix: "", offset: 0, tag: "rewrite", comment: "Find an image of hers.", status: "open", createdAt: AT, updatedAt: AT, createdOnDevice: "d-1a2b3c4d", ...extra };
}
const fileOf = (chapter, ...notes) => core.serializeChapterAnnotations({ version: 1, chapter: slug(chapter), entries: notes, invalid: [], extra: {} });
const notesOf = (store, chapter) => core.liveAnnotations(core.parseChapterAnnotations(store.files.get(path(chapter)), slug(chapter)).file);

async function bookWithNotes(chapters = 2) {
  const ai = votingAi({ chapters: {}, books: [8] });
  const store = await finishedBook(ai, chapters);
  store.files.set(path(1), fileOf(1, note(1, ids[0]), note(1, ids[1], { tag: "keep", comment: "Perfect." })));
  if (chapters > 1) store.files.set(path(2), fileOf(2, note(2, ids[2], { tag: "expand", comment: "More here." }), note(2, ids[3], { status: "later" })));
  return { ai, store };
}

test("the notes the autopilot reads are the open ones, with their tags, and not the ones that ask to keep a passage", async () => {
  const { store } = await bookWithNotes();
  const { notes, unreadable } = await readAnnotationNotes(store, { language: "en" });
  assert.deepEqual(unreadable, []);
  assert.deepEqual(notes.map((entry) => [entry.id, entry.chapter, entry.paragraph, entry.tag]), [[ids[0], slug(1), "001-scene-1-title", "rewrite"], [ids[2], slug(2), "001-scene-1-title", "expand"]]);
  assert.ok(notes[0].tagName && notes[0].tagDescription);
  assert.deepEqual((await readAnnotationNotes(store, { ids: [ids[2]] })).notes.map((entry) => entry.id), [ids[2]]);
  assert.deepEqual((await readAnnotationNotes(store, { chapters: [slug(1)] })).notes.map((entry) => entry.id), [ids[0]]);
  store.files.set(path(2), "annotations: [broken");
  assert.deepEqual((await readAnnotationNotes(store)).unreadable, [path(2)]);
  const text = annotationInstruction(notes[0], "en");
  assert.match(text, /the old gate/);
  assert.match(text, /Find an image of hers\./);
  assert.match(annotationInstruction(notes[0], "it"), /Nota del lettore/);
});

test("a request is checked: no autopilot or plan, a request that is not one, no note to work, a campaign already going", async () => {
  const { ai, store } = await bookWithNotes();
  const empty = newSession(new MemoryBookStore({}), ai).session;
  await assert.rejects(empty.reviseAnnotations({}), (error) => error instanceof RevisionCampaignError && error.code === "not_finished");
  const { session } = newSession(store, ai);
  for (const input of [{ ids: "x" }, { chapters: [1] }, { include: ["1"] }, { note: 3 }]) {
    await assert.rejects(session.reviseAnnotations(input), (error) => error instanceof RevisionCampaignError && error.code === "invalid_request", JSON.stringify(input));
  }
  await assert.rejects(session.reviseAnnotations({ ids: ["a-nope"] }), (error) => error instanceof RevisionCampaignError && error.code === "nothing_to_review");
  assert.equal(stateOf(store).campaign, undefined, "nothing was saved");
  const result = await session.reviseAnnotations({ note: "Keep the voice." });
  assert.equal(result.campaign.reason, "annotations");
  assert.deepEqual(result.campaign.chapters.map((item) => [item.number, item.mode, item.status]), [[1, "follow", "waiting"], [2, "follow", "waiting"]]);
  assert.deepEqual(result.campaign.annotations.notes.map((entry) => [entry.id, entry.chapterNumber, entry.sceneNumber]), [[ids[0], 1, 1], [ids[2], 2, 1]]);
  assert.equal(result.campaign.note, "Keep the voice.");
  await assert.rejects(session.reviseAnnotations({}), (error) => error instanceof RevisionCampaignError && error.code === "campaign_active");
  const summary = engine.summarizeAutopilotState(stateOf(store)).campaign;
  assert.deepEqual([summary.reason, summary.total, summary.done, summary.annotations], ["annotations", 2, 0, { notes: 2, handled: 0, heldBack: [] }]);
  assert.deepEqual(parseRoundTrip(stateOf(store)).campaign.annotations, result.campaign.annotations, "the campaign survives a restart");
});

const parseRoundTrip = (state) => engine.parseAutopilotState(JSON.stringify(state));

test("the run rewrites each chapter from its notes in the order of the book, reviews it again, closes the notes as handled by the autopilot, and remembers what it did", async () => {
  const { ai, store } = await bookWithNotes();
  const before = [store.files.get(scene(1)), store.files.get(scene(2))];
  const { session } = newSession(store, ai);
  await session.reviseAnnotations({});
  const mark = ai.calls.length;
  const { events, state } = await run(store, ai);
  assert.equal(state.status, "completed", state.lastError?.message);
  const labels = ai.calls.slice(mark).map((call) => call.label);
  assert.ok(labels.some((label) => /revise/.test(label) || /write/.test(label)), labels.join(", "));
  assert.notEqual(store.files.get(scene(1)), before[0], "chapter 1 was rewritten");
  assert.notEqual(store.files.get(scene(2)), before[1], "chapter 2 was rewritten");
  const first = notesOf(store, 1);
  assert.equal(first.find((entry) => entry.id === ids[0]).status, "handled");
  assert.equal(first.find((entry) => entry.id === ids[0]).resolution.by, "autopilot");
  assert.match(first.find((entry) => entry.id === ids[0]).resolution.summary, /Rewritten by the autopilot/);
  assert.equal(first.find((entry) => entry.id === ids[1]).status, "open", "a note that asks to keep a passage is not a change");
  assert.equal(notesOf(store, 2).find((entry) => entry.id === ids[3]).status, "later", "a note put off is left alone");
  assert.equal(notesOf(store, 2).find((entry) => entry.id === ids[2]).status, "handled");
  assert.equal(state.campaign, undefined, "over, and gone");
  assert.equal(state.annotationRuns.length, 1);
  assert.deepEqual({ ...state.annotationRuns[0], startedAt: undefined, endedAt: undefined, campaignId: undefined }, { campaignId: undefined, startedAt: undefined, endedAt: undefined, notes: 2, handled: 2, chapters: [1, 2] });
  assert.equal(insights(events, "campaignChapterDone").length, 2);
  assert.equal(insights(events, "campaignDone").length, 1);
  assert.match(insights(events, "campaignDone")[0].title, /Your notes are answered: 2 chapters rewritten/);
});

test("the chapters of the author's are held back and left alone, unless the request includes them", async () => {
  const { ai, store } = await bookWithNotes();
  const { session } = newSession(store, ai);
  await session.freezeChapter(slug(2));
  const held = await session.reviseAnnotations({});
  assert.deepEqual(held.campaign.chapters.map((item) => item.number), [1], "only the chapter the autopilot closed");
  assert.deepEqual(held.campaign.annotations.heldBack, [2]);
  await session.cancelRevisionCampaign();
  const included = await session.reviseAnnotations({ include: [2] });
  assert.deepEqual(included.campaign.chapters.map((item) => item.number), [1, 2]);
  assert.deepEqual(included.campaign.annotations.include, [2]);
  await session.cancelRevisionCampaign();
  await assert.rejects(session.reviseAnnotations({ chapters: [slug(2)] }), (error) => error instanceof RevisionCampaignError && error.code === "nothing_to_review" && /yours/.test(error.message));
});

test("a note whose scene is no longer in the plan is not worked, and the campaign says how many", async () => {
  const { ai, store } = await bookWithNotes(1);
  store.files.set(path(1), fileOf(1, note(1, ids[0]), note(1, ids[1], { paragraph: "009-gone" })));
  const { session } = newSession(store, ai);
  const result = await session.reviseAnnotations({});
  assert.deepEqual(result.campaign.annotations.notes.map((entry) => entry.id), [ids[0]]);
  assert.equal(result.campaign.annotations.unplaced, 1);
});

test("cancelling ends the chapters that wait and writes nothing about the notes", async () => {
  const { ai, store } = await bookWithNotes();
  const { session } = newSession(store, ai);
  await session.reviseAnnotations({});
  const result = await session.cancelRevisionCampaign();
  assert.equal(result.campaign, null);
  assert.equal(notesOf(store, 1).find((entry) => entry.id === ids[0]).status, "open");
  assert.equal(stateOf(store).annotationRuns, undefined, "a campaign that never began leaves no record");
});

test("a campaign of annotations is also the author's to ask of a personal server that says it can", () => {
  assert.equal(SERVER_FEATURE_AUTOPILOT_ANNOTATIONS, "autopilot-annotations");
  assert.equal(CAMPAIGN_FEATURES.annotations, "autopilot-annotations");
  assert.equal(serverSupportsAnnotations({ features: ["autopilot", "autopilot-annotations"] }), true);
  assert.equal(serverSupportsAnnotations({ features: ["autopilot"] }), false);
  assert.equal(serverSupportsAnnotations(null), false);
  assert.equal(typeof createAnnotationsCampaign, "function");
  void clock;
});
