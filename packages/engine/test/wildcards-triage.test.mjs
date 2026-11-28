import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { createFakeAutopilotAi } from "../dist/testing/index.js";

// The Director's triage of the room (adopted, adapted, rejected, always with the reason; at most a few accepted), the material the accepted ideas become,
// and the estimate of a consultation before it runs.

const { WILDCARD_TRIAGE_TOOL, builtinWildcards, defaultDirector, estimateModelOf, estimateWildcardRoom, pickAiRuntimeConfig, readWildcardReply, triageWildcardIdeas, wildcardIdeasMaterial } = engine;

const target = { kind: "chapter", label: "Chapter 3: The harbour", chapter: 3 };
const subversive = builtinWildcards("en").find((profile) => profile.slug === "subversive");
const ideas = readWildcardReply({ items: ["A", "B", "C", "D"].map((letter) => ({ title: `Idea ${letter}`, idea: `Do ${letter}.`, why: "w", changes: "c", chapters: [3], risk: "r", audacity: 7 })) }, subversive, { target, consultation: "room-test" }).ideas;
const NOW = () => new Date("2026-11-28T10:00:00.000Z");

test("the Director decides every idea with its reason; the accepted ones are at most the cap, the others over it are counted", async () => {
  const ai = createFakeAutopilotAi({ wildcardTriage: (ids) => ({ decisions: ids.map((id, index) => ({ id, verdict: index < 3 ? (index === 1 ? "adapted" : "adopted") : "rejected", reason: `Reason ${index}.`, ...(index === 1 ? { adaptation: "A smaller B." } : {}) })), summary: "Three of four." }) });
  const result = await triageWildcardIdeas({ ai, director: defaultDirector("en"), language: "en", ideas, target, material: "The chapter.", maxAdopted: 2, now: NOW });
  assert.equal(ai.calls.length, 1);
  const [call] = ai.calls;
  assert.equal(call.capability, "director");
  assert.equal(call.label, "wildcards:triage");
  assert.equal(call.json.name, WILDCARD_TRIAGE_TOOL.name);
  assert.match(call.system, /You are the Director of this book/);
  assert.match(call.user, /\[idea-[0-9a-f]{16}\] \(The Subversive, provocateur, audacity 7\) Idea A: Do A\./);
  assert.match(call.user, /Accept \(adopt or adapt\) at most 2/);
  assert.deepEqual(result.ideas.map((idea) => idea.decision.verdict), ["adopted", "adapted", "adopted", "rejected"]);
  assert.ok(result.ideas.every((idea) => idea.decision.by === "director" && idea.decision.at === "2026-11-28T10:00:00.000Z" && idea.decision.reason));
  assert.equal(result.ideas[1].decision.adaptation, "A smaller B.");
  assert.deepEqual(result.accepted.map((idea) => idea.title), ["Idea A", "Idea B"]);
  assert.equal(result.overCap, 1);
  assert.equal(result.undecided, 0);
  assert.equal(result.summary, "Three of four.");
  assert.equal(result.repaired, false);
});

test("a triage that leaves ideas undecided, or decides one without a reason or an adaptation, is asked again once; what is still missing stays undecided", async () => {
  let round = 0;
  const ai = createFakeAutopilotAi({ wildcardTriage: (ids) => {
    round += 1;
    if (round === 1) return { decisions: [{ id: ids[0], verdict: "adopted", reason: "Good." }, { id: ids[1], verdict: "adapted", reason: "Close." }, { id: ids[2], verdict: "maybe", reason: "?" }] };
    return { decisions: [{ id: ids[1], verdict: "adapted", reason: "Close.", adaptation: "Half of B." }, { id: "idea-ffffffffffffffff", verdict: "adopted", reason: "Not an idea of the room." }] };
  } });
  const result = await triageWildcardIdeas({ ai, director: defaultDirector("en"), language: "en", ideas, target, material: "The chapter.", now: NOW });
  assert.equal(ai.calls.length, 2);
  assert.match(ai.calls[1].user, /an adapted idea needs its adaptation written out/);
  assert.match(ai.calls[1].user, /the verdict must be adopted, adapted or rejected/);
  assert.match(ai.calls[1].user, /no decision for/);
  assert.equal(result.repaired, true);
  // The first reply's good decision stays; the second completes the adapted one; two stay undecided.
  assert.equal(result.ideas[0].decision.verdict, "adopted");
  assert.equal(result.ideas[1].decision.adaptation, "Half of B.");
  assert.equal(result.ideas[2].decision, undefined);
  assert.equal(result.undecided, 2);
  assert.equal(result.accepted.length, 2);
  // Nothing to decide: no call.
  const none = await triageWildcardIdeas({ ai: createFakeAutopilotAi(), director: defaultDirector("en"), language: "en", ideas: [], target, material: "" });
  assert.deepEqual(none.ideas, []);
});

test("the accepted ideas become material for whoever writes next, the adaptation in place of the idea; rejected ones never do", async () => {
  const result = await triageWildcardIdeas({ ai: createFakeAutopilotAi(), director: defaultDirector("en"), language: "en", ideas, target, material: "The chapter.", now: NOW });
  const material = wildcardIdeasMaterial(result.ideas, "en");
  assert.match(material, /^IDEAS ACCEPTED FROM THE ROOM/);
  assert.match(material, /- Idea A \(The Subversive\): Do A\. — because: It lifts the chapter where it sags\./);
  assert.match(material, /- Idea B \(The Subversive\): Keep the idea, in one paragraph only\./);
  assert.doesNotMatch(material, /Idea C|Idea D/);
  assert.equal(wildcardIdeasMaterial(ideas, "en"), "");
});

test("the estimate of a consultation: one to two calls a voice, the shared start served from the cache in the best case, the triage on top; no price, no cost", () => {
  const model = { model: "m", pricing: { inputPerMTok: 2, cachedPerMTok: 0.5, outputPerMTok: 8 } };
  const four = estimateWildcardRoom({ voices: 4, materialChars: 40_000, contextChars: 8_000, model, currency: "USD" });
  assert.deepEqual(four.calls, { min: 4, max: 8 });
  assert.ok(four.inputTokens.min > 4 * 12_000 && four.inputTokens.max === 2 * four.inputTokens.min);
  assert.ok(four.cost.min > 0 && four.cost.min < four.cost.max);
  assert.equal(four.cost.currency, "USD");
  const uncached = estimateWildcardRoom({ voices: 4, materialChars: 40_000, contextChars: 8_000, model: { model: "m", pricing: { inputPerMTok: 2, outputPerMTok: 8 } } });
  assert.ok(uncached.cost.min > four.cost.min, "the cache lowers the least");
  assert.equal(uncached.cost.max, four.cost.max);
  const triaged = estimateWildcardRoom({ voices: 4, materialChars: 40_000, model, triage: { model } });
  assert.deepEqual(triaged.calls, { min: 5, max: 10 });
  assert.equal(estimateWildcardRoom({ voices: 4, materialChars: 1_000, model: { model: "m" } }).cost, null);
  assert.equal(estimateWildcardRoom({ voices: 4, materialChars: 1_000, model, triage: { model: null } }).cost, null);
  assert.deepEqual(estimateWildcardRoom({ voices: 0, materialChars: 1_000 }).cost, { min: 0, max: 0 });
  assert.equal(estimateWildcardRoom({ voices: 40, materialChars: 1_000 }).calls.min, 8, "never more than the most voices a consultation asks");
});

test("the model of the room's task as the estimate reads it: its name and its prices, none without a model", () => {
  const config = pickAiRuntimeConfig({ aiIntegrations: [{ id: "muse", name: "muse", provider: "openai", endpoint: "https://muse.example.test/v1", apiKey: "k", chatModels: [{ id: "wild", name: "wild", capabilities: ["wildcards"], supportsToolCalls: true, pricing: { inputPerMTok: 1, outputPerMTok: 4 } }] }] });
  assert.equal(estimateModelOf(config, "wildcards").model, "wild");
  assert.deepEqual(estimateModelOf(config, "wildcards").pricing, { inputPerMTok: 1, outputPerMTok: 4 });
  assert.equal(estimateModelOf({ aiIntegrations: [] }, "wildcards"), null);
});
