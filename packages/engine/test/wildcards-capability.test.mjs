import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The room of the wildcards has its own task in the router, `wildcards`, which follows the review's: its own route, else the review's, else what the
// review would be given with the room's own tags first. A setup made before the task existed keeps working with nothing to configure.

const { AI_CAPABILITY_FOLLOWS, REVIEW_CAPABILITY, WILDCARDS_CAPABILITY, describeAiRoute, estimateModelOf, pickAiRuntimeConfig, resolveAiCandidates } = engine;

const model = (name, capabilities, extra = {}) => ({ id: name, name, capabilities, supportsToolCalls: true, ...extra });
const integration = (id, models, extra = {}) => ({ id, name: id, provider: "openai", endpoint: `https://${id}.example.test/v1`, apiKey: `${id}-key`, chatModels: models, ...extra });
const chosen = (config, capability) => resolveAiCandidates(config, capability).map((candidate) => `${candidate.integration.id}/${candidate.model}`);

test("the room has its own task in the router, which follows the review's: its own route, else the review's, else its own tags, the review's integration and tags", () => {
  assert.equal(WILDCARDS_CAPABILITY, "wildcards");
  assert.equal(AI_CAPABILITY_FOLLOWS[WILDCARDS_CAPABILITY], REVIEW_CAPABILITY);
  const integrations = [
    integration("writer", [model("general", ["default"]), model("critic", ["review"])]),
    integration("legacy", [model("old-review", ["review"])]),
    integration("muse", [model("wild", ["wildcards"], { pricing: { inputPerMTok: 1, outputPerMTok: 4 } })]),
  ];
  const own = pickAiRuntimeConfig({ aiIntegrations: integrations, taskRouting: { wildcards: { primary: { integrationId: "muse", model: "wild" }, fallbacks: [] }, review: { primary: { integrationId: "writer", model: "critic" }, fallbacks: [] } } });
  assert.deepEqual(chosen(own, "wildcards"), ["muse/wild"]);
  const reviewOnly = pickAiRuntimeConfig({ aiIntegrations: integrations, taskRouting: { review: { primary: { integrationId: "writer", model: "critic" }, fallbacks: [] } } });
  assert.deepEqual(chosen(reviewOnly, "wildcards"), ["writer/critic"]);
  assert.deepEqual(describeAiRoute(reviewOnly, "wildcards").map((entry) => entry.position), [0]);
  // No route at all: the models tagged for the room, then the review's integration of an older setup, then the models tagged for the review.
  const unrouted = pickAiRuntimeConfig({ aiIntegrations: integrations, defaultReviewIntegrationId: "legacy" });
  assert.deepEqual(chosen(unrouted, "wildcards"), ["muse/wild", "legacy/old-review", "writer/critic"]);
  assert.deepEqual(chosen(unrouted, "review"), ["legacy/old-review", "writer/critic"], "the review resolves as it always did");
  assert.equal(estimateModelOf(unrouted, "wildcards").model, "wild");
  assert.deepEqual(estimateModelOf(unrouted, "wildcards").pricing, { inputPerMTok: 1, outputPerMTok: 4 });
  assert.equal(estimateModelOf({ aiIntegrations: [] }, "wildcards"), null);
});
