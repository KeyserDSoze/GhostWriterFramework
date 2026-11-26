import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// Brainstorming, the Copilot's mode on the Synopsis page of the web app, has a task of its own in the router: `brainstorming`. While it has no route of its own it
// follows the Copilot's route, and without that either it is resolved as the Copilot is (the models tagged for it, then the default writing integration and the
// `default` models), so a setup made before the task existed keeps working with nothing to configure. A model the author allows the Copilot is allowed it too.

const { AI_CAPABILITY_FOLLOWS, BRAINSTORMING_CAPABILITY, COPILOT_CAPABILITY, describeAiRoute, pickAiRuntimeConfig, planAttempts, resolveAiCandidates } = engine;

const model = (name, capabilities) => ({ id: name, name, capabilities, supportsToolCalls: true });
const integration = (id, models, extra = {}) => ({ id, name: id, provider: "openai", endpoint: `https://${id}.example.test/v1`, apiKey: `${id}-key`, chatModels: models, ...extra });
const target = (integrationId, modelName, thinking) => ({ integrationId, model: modelName, ...(thinking ? { thinking } : {}) });
const chosen = (config, capability) => resolveAiCandidates(config, capability).map((candidate) => `${candidate.integration.id}/${candidate.model}${candidate.thinking ? `@${candidate.thinking}` : ""}`);

const INTEGRATIONS = [
  integration("writer", [model("general", ["default"]), model("chatty", ["copilot"])]),
  integration("muse", [model("muse-big", ["brainstorming"]), model("muse-small", ["simple-tasks"])]),
];

test("the task has a stable name, and follows the Copilot's", () => {
  assert.equal(BRAINSTORMING_CAPABILITY, "brainstorming");
  assert.equal(COPILOT_CAPABILITY, "copilot");
  assert.deepEqual({ ...AI_CAPABILITY_FOLLOWS }, { brainstorming: "copilot" });
  assert.ok(Object.isFrozen(AI_CAPABILITY_FOLLOWS));
});

test("its own route comes first, then the Copilot's, then what the Copilot would be given: the routes are never merged", () => {
  const own = pickAiRuntimeConfig({
    aiIntegrations: INTEGRATIONS,
    taskRouting: { brainstorming: { primary: target("muse", "muse-big", "high"), fallbacks: [] }, copilot: { primary: target("writer", "chatty", "low"), fallbacks: [] } },
  });
  assert.deepEqual(chosen(own, "brainstorming"), ["muse/muse-big@high"], "its own route, alone");
  assert.deepEqual(chosen(own, "copilot"), ["writer/chatty@low"], "the Copilot keeps its own");

  const copilotOnly = pickAiRuntimeConfig({ aiIntegrations: INTEGRATIONS, taskRouting: { copilot: { primary: target("writer", "chatty", "low"), fallbacks: [target("writer", "general")] } } });
  assert.deepEqual(chosen(copilotOnly, "brainstorming"), ["writer/chatty@low", "writer/general"], "the Copilot's route, its thinking levels included");
  assert.deepEqual(describeAiRoute(copilotOnly, "brainstorming").map((entry) => entry.position), [0, 1], "the places of the Copilot's route");

  const none = pickAiRuntimeConfig({ aiIntegrations: INTEGRATIONS, taskRouting: { default: { primary: target("writer", "general"), fallbacks: [] } } });
  assert.deepEqual(chosen(none, "brainstorming"), ["muse/muse-big", "writer/chatty"], "the models tagged for it first, then those tagged for the Copilot");
  assert.deepEqual(chosen(none, "copilot"), ["writer/chatty"], "a model tagged only for Brainstorming is no model of the Copilot's");
  const untagged = pickAiRuntimeConfig({ aiIntegrations: [integration("writer", [model("general", ["default"])])], taskRouting: { default: { primary: target("writer", "general"), fallbacks: [] } } });
  assert.deepEqual(chosen(untagged, "brainstorming"), ["writer/general"], "with no tag for either, the default route's model");
});

test("in one integration too, a model tagged for Brainstorming comes before one tagged for the Copilot, and that one before a default one", () => {
  const both = pickAiRuntimeConfig({ aiIntegrations: [integration("one", [model("general", ["default"]), model("chatty", ["copilot"]), model("deep", ["brainstorming"])])] });
  assert.deepEqual(chosen(both, "brainstorming"), ["one/deep", "one/chatty"]);
  assert.deepEqual(chosen(both, "copilot"), ["one/chatty"]);
  const copilotTag = pickAiRuntimeConfig({ aiIntegrations: [integration("one", [model("general", ["default"]), model("chatty", ["copilot"])])] });
  assert.deepEqual(chosen(copilotTag, "brainstorming"), ["one/chatty"]);
  // A task that follows no other is resolved as it always was.
  assert.deepEqual(chosen(both, "simple-tasks"), ["one/general"]);
});

test("a model the author allows only the Copilot is allowed Brainstorming, in the Copilot's route and in its own", () => {
  const config = pickAiRuntimeConfig({ aiIntegrations: [integration("writer", [model("chatty", ["copilot"])])], taskRouting: { copilot: { primary: target("writer", "chatty"), fallbacks: [] } } });
  const [entry] = describeAiRoute(config, "brainstorming");
  assert.equal(entry.unusable, undefined);
  assert.equal(entry.candidate.model, "chatty");
  const ownRoute = pickAiRuntimeConfig({ aiIntegrations: [integration("writer", [model("chatty", ["copilot"])])], taskRouting: { brainstorming: { primary: target("writer", "chatty"), fallbacks: [] } } });
  assert.equal(describeAiRoute(ownRoute, "brainstorming")[0].unusable, undefined);
  // Not the other way round: a model allowed only Brainstorming is no model of the Copilot's.
  const reverse = pickAiRuntimeConfig({ aiIntegrations: [integration("muse", [model("muse-big", ["brainstorming"])])], taskRouting: { copilot: { primary: target("muse", "muse-big"), fallbacks: [] } } });
  assert.equal(describeAiRoute(reverse, "copilot")[0].unusable, "task-not-allowed");
  // And a model of neither stays out of both.
  const other = pickAiRuntimeConfig({ aiIntegrations: [integration("muse", [model("muse-small", ["simple-tasks"])])], taskRouting: { copilot: { primary: target("muse", "muse-small"), fallbacks: [] } } });
  assert.equal(describeAiRoute(other, "brainstorming")[0].unusable, "task-not-allowed");
});

test("an attempt of Brainstorming is planned on the Copilot's route, and a setup made before the task existed still plans one", () => {
  const settings = { aiIntegrations: [integration("writer", [model("chatty", ["default", "copilot"])])], taskRouting: { copilot: { primary: target("writer", "chatty"), fallbacks: [] } } };
  const plan = planAttempts(pickAiRuntimeConfig(JSON.parse(JSON.stringify(settings))), { capability: BRAINSTORMING_CAPABILITY, label: "brainstorming", system: "", user: "" });
  assert.equal(plan.attempts[0].candidate.model, "chatty");
  // A configuration with no route at all, and legacy single-model fields.
  const legacy = pickAiRuntimeConfig({ aiIntegrations: [{ id: "old", name: "Old", provider: "openai", apiKey: "k", modelWriting: "gpt-old" }] });
  assert.deepEqual(chosen(legacy, "brainstorming"), ["old/gpt-old"]);
  assert.deepEqual(chosen(legacy, "brainstorming"), chosen(legacy, "copilot"));
});

test("a route and a tag of the task are kept as they are written, as every task's", () => {
  const config = pickAiRuntimeConfig({
    aiIntegrations: [integration("muse", [model("muse-big", ["brainstorming", "copilot"])])],
    taskRouting: { brainstorming: { primary: target("muse", "muse-big", "xhigh"), fallbacks: [] } },
  });
  assert.deepEqual(config.taskRouting.brainstorming, { primary: { integrationId: "muse", model: "muse-big", thinking: "xhigh" }, fallbacks: [] });
  assert.deepEqual(config.aiIntegrations[0].chatModels[0].capabilities, ["brainstorming", "copilot"]);
  assert.ok(engine.redactAiRuntimeConfig(config).routedTasks.includes("brainstorming"));
});
