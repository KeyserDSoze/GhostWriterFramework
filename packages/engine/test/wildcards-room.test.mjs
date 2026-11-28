import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The room: the voices asked in parallel up to a cap, each prompt starting the same way (the book and the material) and saying who the voice is only after
// it; a reply that cannot be read asked again once; nothing cut in silence; a money cap; and the secrets told to each voice by its access.

const { AiReplyRejectedError, WILDCARDS_CAPABILITY, WILDCARD_MAX_VOICES, builtinWildcards, runWildcardRoom, wildcardSecretsBlock } = engine;

const panel = builtinWildcards("en");
const voice = (slug) => panel.find((profile) => profile.slug === slug);
const target = { kind: "chapter", label: "Chapter 3: The harbour", chapter: 3 };
const context = { title: "The Glass Harbor", language: "en", synopsis: "Mira uncovers the harbor's oldest lie.", canon: "- Character: Mira Vale" };
const reply = (name, count = 2) => ({ items: Array.from({ length: count }, (_, index) => ({ title: `${name} ${index + 1}`, idea: `Idea ${index + 1} of ${name}`, why: "w", changes: "c", chapters: [3], risk: "r", audacity: 6 })) });

/** A fake port: answers by the persona's name, records every request, and counts how many calls run at once. */
function fakeAi(answer = (name) => reply(name), { cost = 0.01, delayMs = 5 } = {}) {
  const calls = [];
  let running = 0;
  let peak = 0;
  return {
    calls,
    get peak() { return peak; },
    async complete(request) {
      calls.push(request);
      running += 1;
      peak = Math.max(peak, running);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const name = /You are «([^»]+)»/.exec(request.user)?.[1];
        const json = answer(name, request, calls.length);
        if (json instanceof Error) throw json;
        return { text: JSON.stringify(json), json, usage: { inputTokens: 100, outputTokens: 50 }, cost, currency: "USD", model: "fake", provider: "fake" };
      } finally {
        running -= 1;
      }
    },
  };
}

test("every voice is asked with the room's task, in parallel up to the cap; every prompt starts the same way and says who the voice is only after the shared part", async () => {
  const ai = fakeAi();
  const voices = ["subversive", "cliche-hunter", "twist-engineer", "poet", "naive", "antagonist"].map(voice);
  const result = await runWildcardRoom({ ai, voices, target, material: "=== SCENE 1: Arrival ===\nThe tide came in.", context, parallel: 2, cacheKey: "book/wildcards" });
  assert.equal(ai.calls.length, 6);
  assert.equal(ai.peak, 2);
  assert.ok(ai.calls.every((call) => call.capability === WILDCARDS_CAPABILITY && call.json.name === "wildcard_ideas" && call.cacheKey === "book/wildcards"));
  assert.deepEqual(ai.calls.map((call) => call.label).sort(), voices.map((profile) => `wildcards:${profile.slug}`).sort());
  // The same system and the same start of the user prompt for every voice, up to where the cache may end.
  const [first, ...others] = ai.calls;
  for (const call of others) {
    assert.equal(call.system, first.system);
    assert.equal(call.cacheBreak, first.cacheBreak);
    assert.equal(call.user.slice(0, call.cacheBreak), first.user.slice(0, first.cacheBreak));
  }
  assert.ok(first.user.indexOf("The tide came in.") < first.cacheBreak, "the material is in the shared part");
  assert.ok(first.user.indexOf("You are «") > first.cacheBreak, "the persona comes after it");
  // The result: every voice in the order given, every record advisory and without a score.
  assert.deepEqual(result.voices.map((entry) => entry.persona.slug), voices.map((profile) => profile.slug));
  assert.ok(result.voices.every((entry) => entry.status === "ok" && entry.ideas.length === 2));
  assert.equal(result.ideas.length, 12);
  assert.ok(result.ideas.every((idea) => idea.advisory === true && !("score" in idea)));
  assert.ok(Math.abs(result.cost - 0.06) < 1e-9);
  assert.equal(result.voicesOmitted, 0);
  assert.match(result.consultation, /^room-[0-9a-f-]{36}$/);
});

test("a reply that cannot be read is asked again once, with the reason after the shared part; a voice that fails says why and the others go on", async () => {
  let poetCalls = 0;
  let antagonistCalls = 0;
  const ai = fakeAi((name) => {
    if (name === "The Poet") {
      poetCalls += 1;
      return poetCalls === 1 ? { items: [{ title: "no idea in it" }] } : reply(name, 1);
    }
    if (name === "The Naive") return new Error("The provider is down.");
    if (name === "The Antagonist") {
      antagonistCalls += 1;
      return antagonistCalls === 1 ? new AiReplyRejectedError("not JSON") : reply(name);
    }
    return reply(name);
  });
  const result = await runWildcardRoom({ ai, voices: ["poet", "naive", "antagonist"].map(voice), target, material: "Text.", context });
  const [poet, naive, antagonist] = result.voices;
  assert.equal(poet.status, "ok");
  assert.equal(poet.repaired, true);
  assert.equal(poet.ideas.length, 1);
  const poetRequests = ai.calls.filter((call) => call.label === "wildcards:poet");
  assert.equal(poetRequests.length, 2);
  assert.match(poetRequests[1].user, /could not be read/);
  assert.equal(poetRequests[1].user.slice(0, poetRequests[1].cacheBreak), poetRequests[0].user.slice(0, poetRequests[0].cacheBreak));
  assert.equal(naive.status, "failed");
  assert.match(naive.reason, /provider is down/);
  // A rejected reply is asked again too; here the second answer is the antagonist's ideas.
  assert.equal(antagonist.status, "ok");
  assert.equal(antagonist.repaired, true);
});

test("nothing is cut in silence: material too large for the model is shortened in the middle and said, ideas beyond the cap and voices beyond the cap are counted", async () => {
  const ai = fakeAi((name) => reply(name, 9));
  const material = `${"start ".repeat(10_000)}${"middle ".repeat(60_000)}${"end ".repeat(10_000)}`;
  const result = await runWildcardRoom({ ai, voices: [voice("poet")], target, material, context, windowTokens: 32_000, maxIdeas: 3 });
  assert.ok(result.clipped && result.clipped.from === material.length && result.clipped.to < material.length);
  assert.match(ai.calls[0].user, /shortened in the middle to fit the model/);
  assert.match(ai.calls[0].user, /\[…\]/);
  assert.equal(result.voices[0].ideas.length, 3);
  assert.equal(result.voices[0].omitted, 6);
  const many = await runWildcardRoom({ ai: fakeAi(), voices: [...panel, ...panel].slice(0, WILDCARD_MAX_VOICES + 3), target, material: "Short.", context });
  assert.equal(many.voices.length, WILDCARD_MAX_VOICES);
  assert.equal(many.voicesOmitted, 3);
  assert.equal(many.clipped, undefined);
});

test("a money cap stops starting voices once the answers cost that much; 0 is no cap", async () => {
  const voices = ["subversive", "poet", "naive", "antagonist"].map(voice);
  const capped = await runWildcardRoom({ ai: fakeAi(undefined, { cost: 0.5 }), voices, target, material: "Text.", context, parallel: 1, moneyCap: 1 });
  assert.deepEqual(capped.voices.map((entry) => entry.status), ["ok", "ok", "skipped", "skipped"]);
  assert.equal(capped.voices[2].reason, "cap");
  assert.equal(capped.capped, true);
  assert.equal(capped.cost, 1);
  const free = await runWildcardRoom({ ai: fakeAi(undefined, { cost: 0.5 }), voices, target, material: "Text.", context, parallel: 1, moneyCap: 0 });
  assert.ok(free.voices.every((entry) => entry.status === "ok"));
  assert.equal(free.capped, false);
});

test("the secrets: only a sentinel with the author's access is told the book's secrets; every other voice only what the material may know", async () => {
  const secrets = { threshold: "- The Debt: revealed in chapter 2.\n  Truth: Orrin owes the council.", author: "- The Wall Is Failing: HIDDEN until chapter 9.\n  Truth: The sea wall cracked years ago." };
  assert.match(wildcardSecretsBlock(voice("secrets-guardian"), secrets), /The Wall Is Failing/);
  assert.doesNotMatch(wildcardSecretsBlock(voice("secrets-guardian"), secrets), /The Debt/);
  for (const slug of ["subversive", "continuity-keeper", "domain-expert"]) {
    assert.doesNotMatch(wildcardSecretsBlock(voice(slug), secrets), /Wall/);
    assert.match(wildcardSecretsBlock(voice(slug), secrets), /The Debt/);
  }
  // A provocateur whose file says `secrets: author` was read with the threshold; even forced, the block keeps it out.
  assert.doesNotMatch(wildcardSecretsBlock({ ...voice("subversive"), secrets: "author" }, secrets), /Wall/);
  const ai = fakeAi();
  await runWildcardRoom({ ai, voices: ["subversive", "secrets-guardian"].map(voice), target, material: "Text.", context, secrets });
  const prompt = (slug) => ai.calls.find((call) => call.label === `wildcards:${slug}`).user;
  assert.doesNotMatch(prompt("subversive"), /sea wall cracked/);
  assert.match(prompt("secrets-guardian"), /sea wall cracked/);
  // The secrets are in the voice's own part, after the shared one: the shared part never carries a secret.
  const guardian = ai.calls.find((call) => call.label === "wildcards:secrets-guardian");
  assert.ok(guardian.user.indexOf("sea wall cracked") > guardian.cacheBreak);
});

test("the ideas rejected before are told to every voice, and an aborted consultation stops", async () => {
  const ai = fakeAi();
  await runWildcardRoom({ ai, voices: [voice("poet")], target, material: "Text.", context, rejected: ["Tell it backwards"], question: "Is the ending earned?" });
  assert.match(ai.calls[0].user, /ALREADY REJECTED[\s\S]*Tell it backwards/);
  assert.match(ai.calls[0].user, /The author asks the room: Is the ending earned\?/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runWildcardRoom({ ai: fakeAi(), voices: [voice("poet")], target, material: "Text.", context, signal: controller.signal }));
});
