import assert from "node:assert/strict";
import test from "node:test";
import { openAIModelsUrl, parseOpenAIModels } from "../src/ai/openaiModelsCatalog.ts";

test("builds the models URL from an OpenAI-compatible endpoint", () => {
  assert.equal(openAIModelsUrl("https://codex3.opencode.zone/v1/"), "https://codex3.opencode.zone/v1/models");
});

test("parses the standard object/list models response and removes duplicate ids", () => {
  const models = parseOpenAIModels({
    object: "list",
    data: [
      { id: "gpt-5.6-sol", object: "model", created: 0, owned_by: "codex" },
      { id: "gpt-5.6-luna", object: "model", created: 0, owned_by: "codex" },
      { id: "gpt-5.6-sol", object: "model" },
      { object: "model" },
    ],
  });

  assert.deepEqual(models.map((model) => model.id), ["gpt-5.6-sol", "gpt-5.6-luna"]);
  assert.equal(models[0].owned_by, "codex");
});
