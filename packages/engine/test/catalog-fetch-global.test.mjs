import test from "node:test";
import assert from "node:assert/strict";
import { fetchModelCatalog } from "../dist/index.js";

// A browser's fetch refuses to run as a method of another object ("Illegal invocation"); the default must call it on its own.
test("the default fetch of the model catalog is called on its own, as a browser requires", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = function strictFetch(input) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    seen.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ object: "list", data: [{ id: "model-a", object: "model" }] }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  try {
    const catalog = await fetchModelCatalog({ id: "p", name: "P", provider: "openai", endpoint: "http://127.0.0.1:9/v1", apiKey: "sk-test-key-0123456789", chatModels: [] });
    assert.ok(catalog.models.some((model) => model.id === "model-a"));
    assert.ok(seen.some((url) => url.endsWith("/models")), "the catalog was asked with the global fetch");
  } finally {
    globalThis.fetch = original;
  }
});
