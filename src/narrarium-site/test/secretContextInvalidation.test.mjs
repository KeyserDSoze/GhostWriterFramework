import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyAssistantSession, invalidateAssistantSecretContext } from "../src/assistant/store.ts";

test("leaving an explicit secret route clears every secret-bearing prompt source", () => {
  const session = createEmptyAssistantSession("Secret");
  session.sensitiveSecretPaths = ["secrets/truth.md"];
  session.messages = [{ id: "visible", role: "assistant", text: "The hidden truth" }];
  session.attachments = [{ id: "attachment", name: "secret.txt", mimeType: "text/plain", kind: "text", sizeBytes: 6, textContent: "secret" }];
  session.archive = { summary: "Secret summary", messageCount: 1, actions: [], attachments: [] };
  session.compactSummary = "Secret summary";
  session.losslessSegments = [{ format: "narrarium-assistant-chat-segment", version: 1, id: "segment", createdAt: new Date().toISOString(), messages: [{ id: "old", role: "assistant", text: "Old secret" }], attachments: [] }];
  const cleared = invalidateAssistantSecretContext(session, null);
  assert.equal(cleared.messages.some((message) => message.text.includes("hidden truth")), false);
  assert.equal(cleared.compactSummary, "");
  assert.equal(cleared.archive.summary, "");
  assert.deepEqual(cleared.losslessSegments, []);
  assert.deepEqual(cleared.attachments, []);
  assert.deepEqual(cleared.sensitiveSecretPaths, []);
});

test("the exact explicit author route retains its secret context", () => {
  const session = createEmptyAssistantSession("Secret");
  session.sensitiveSecretPaths = ["secrets/truth.md"];
  session.messages = [{ id: "visible", role: "assistant", text: "The hidden truth" }];
  assert.equal(invalidateAssistantSecretContext(session, "secrets/truth.md"), session);
  assert.notEqual(invalidateAssistantSecretContext(session, "secrets/other.md"), session);
});
