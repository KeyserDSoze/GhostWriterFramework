import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// A provider that caches the start of a prompt serves what a call has in common with the one before it, from its first token. The review of a chapter is asked again and again about the same text (a round
// for each fix the director accepts), so what stays the same comes first in its prompts and the request, which changes, comes last. Before, the request was first and the common start of two rounds was only the
// instructions and the functions (about a seventh of the prompt of the specialists and a quarter of the director's), under the 1,024 tokens a provider caches: nothing was served. Here two rounds of one chapter whose
// text did not change between them (a fix that returns the scene as it is) are compared as the provider sees them: the functions, the system message and the user message, in tokens of the engine's own estimate.

const { AutopilotSession, defaultDirector, serializeDirector, likelyTextTokens, servedFromCache } = engine;

const reply = (json) => ({ text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.001, currency: "USD" });
const wire = (call) => `${JSON.stringify(call.json ?? null)}\n${call.system}\n${call.user}`;
const commonLength = (left, right) => {
  let at = 0;
  while (at < left.length && at < right.length && left[at] === right[at]) at += 1;
  return at;
};
/** What two consecutive calls have in common from their first character: its tokens, the tokens of the second, and its share. */
function shared(before, after) {
  const common = commonLength(wire(before), wire(after));
  const total = likelyTextTokens(wire(after));
  const prefix = likelyTextTokens(wire(after).slice(0, common));
  return { prefix, total, share: prefix / total };
}

/**
 * A chapter of three scenes of `words` words that the director sends back twice, accepting one fix each time. The fix is applied by a writer that returns the scene exactly as it is, so that the text of the
 * chapter is the same in every round and only the review itself changes: what the rounds have in common is then what the order of the prompt lets them have in common.
 */
async function unchangedRounds(words = 700) {
  const base = createFakeAutopilotAi({ words });
  let rounds = 0;
  const ai = {
    calls: base.calls,
    async complete(request) {
      if (/^autopilot:director-review:\d+$/.test(request.label)) {
        base.calls.push(request);
        rounds += 1;
        const ids = [...request.user.matchAll(/\[([A-Z]\d+-\d+)\]/g)].map((match) => match[1]);
        const revise = rounds < 3;
        return reply({
          verdict: revise ? "revise" : "approve",
          score: revise ? 6 : 8.5,
          summary: "Judged.",
          strengths: [],
          decisions: ids.map((id, index) => ({ findingId: id, action: revise && index === 0 ? "accept" : "reject", rationale: "Because.", remediation: "Open with Mira already running.", sceneNumber: 1 })),
          extraFixes: [],
          guidance: [],
        });
      }
      if (/^autopilot:repair:/.test(request.label)) {
        base.calls.push(request);
        const body = /CURRENT SCENE:\n([\s\S]*?)\n<\/repository_content>/.exec(request.user)[1];
        return { text: body, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }, model: "fake-model", provider: "fake", cost: 0.002, currency: "USD" };
      }
      return base.complete(request);
    },
  };
  const files = { ...seedBookFiles({ chapters: 1 }), "director.md": serializeDirector({ ...defaultDirector("en"), maxReviewRounds: 3 }) };
  const session = new AutopilotSession({ bookId: "book", store: new MemoryBookStore(files), ai, host: "server", hostLabel: "test", retryDelayMs: 0 });
  await session.start({ brief: { idea: "x", targetChapters: 1, scenesPerChapter: 3, wordsPerScene: words }, options: { readers: true, maxReaders: 1, readersOnPlan: false, specialists: true, pauseAfterPlan: false } });
  await session.waitForIdle();
  const state = (await session.snapshot()).state;
  assert.equal(state.status, "completed", state.lastError?.message);
  return ai.calls;
}

for (const words of [700, 1500]) {
  test(`two rounds of the review of a chapter of three scenes of ${words} words whose text did not change share nearly all of their prompt: the specialists' 90% and the director's 85%, far over what a provider caches`, async () => {
    const calls = await unchangedRounds(words);
    const specialists = calls.filter((call) => call.label === "autopilot:specialists:1");
    const directors = calls.filter((call) => call.label === "autopilot:director-review:1");
    assert.equal(specialists.length, 3);
    assert.equal(directors.length, 3);
    for (const [kind, list, least] of [["specialists", specialists, 0.9], ["director", directors, 0.85]]) {
      for (let round = 1; round < list.length; round += 1) {
        const { prefix, total, share } = shared(list[round - 1], list[round]);
        assert.ok(share >= least, `${kind}, round ${round} to ${round + 1}: ${prefix} of ${total} tokens in common (${Math.round(share * 100)}%)`);
        assert.ok(prefix >= 1024, `${kind}: more than the least a provider caches (${prefix})`);
        assert.ok(servedFromCache(prefix, total) >= 0.8 * total, `${kind}: a provider that caches in steps of 128 tokens serves ${servedFromCache(prefix, total)} of ${total}`);
      }
    }
  });
}

test("what a review asks is the last of its prompt: one block of data, then the request, for every kind that is asked again about the same material, and the break says where what stays the same ends", async () => {
  const calls = await unchangedRounds(700);
  const kinds = ["autopilot:specialists:1", "autopilot:director-review:1", "autopilot:repair:1.1", "autopilot:plan-review"];
  for (const label of kinds) {
    const call = calls.find((entry) => entry.label === label);
    assert.ok(call, label);
    const data = call.user.indexOf("<repository_content");
    const asked = call.user.indexOf("<current_request");
    assert.ok(data === 0 && asked > data, `${label}: the data first, the request after`);
    assert.equal(call.user.indexOf("<current_request", asked + 1), -1, `${label}: one request`);
    assert.ok(call.user.endsWith("</current_request>"), `${label}: nothing after the request`);
    assert.ok(call.cacheBreak > 0 && call.cacheBreak <= asked, `${label}: the break is before the request (${call.cacheBreak} of ${asked})`);
    assert.ok(call.cacheBreak > 0.1 * call.user.length || label === "autopilot:repair:1.1", `${label}: and the stable start is most of the prompt (${call.cacheBreak} of ${call.user.length})`);
  }
  // The break of two rounds is the same text: what is said to be stable is.
  const [first, second, third] = calls.filter((entry) => entry.label === "autopilot:director-review:1");
  assert.equal(first.user.slice(0, Math.min(first.cacheBreak, second.cacheBreak)), second.user.slice(0, Math.min(first.cacheBreak, second.cacheBreak)));
  assert.equal(second.user.slice(0, second.cacheBreak), third.user.slice(0, second.cacheBreak));
  // The changing sections are after the text of the chapter, and the text is in the stable start.
  assert.ok(second.user.indexOf("CHAPTER TEXT:") < second.cacheBreak, "the text of the chapter is in what stays the same");
  assert.ok(second.user.indexOf("FINDINGS TO DECIDE:") >= second.cacheBreak - 2, "and the findings of the round are not");
  assert.ok(second.user.indexOf("FIXES APPLIED AFTER THE PREVIOUS ROUND:") >= second.cacheBreak - 2, "nor the fixes of the round before");
});

test("the reviews still carry every section the model reads: the order of a prompt is not what it asks", async () => {
  const calls = await unchangedRounds(700);
  const sections = { "autopilot:specialists:1": ["GHOSTWRITER PROFILE:", "SCENE PLANS:", "CANON:", "CHAPTER TEXT:"], "autopilot:director-review:1": ["SCENE PLANS:", "FINDINGS TO DECIDE:", "CHAPTER TEXT:"] };
  for (const call of calls.filter((entry) => entry.label in sections)) {
    const lines = call.user.split("\n");
    for (const needle of sections[call.label]) assert.ok(lines.some((line) => line.startsWith(needle)), `${call.label}: ${needle}`);
    assert.match(call.user, /review round \d/, `${call.label}: the request says the round`);
    assert.ok(call.system.length > 100, `${call.label}: its system message is its own`);
  }
  const rounds = calls.filter((entry) => entry.label === "autopilot:director-review:1").map((entry) => /review round (\d+) of/.exec(entry.user)?.[1]);
  assert.deepEqual(rounds, ["1", "2", "3"], "each round says which it is, in its request, which is the part that changes");
});
