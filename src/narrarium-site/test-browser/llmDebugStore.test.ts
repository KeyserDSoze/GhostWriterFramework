import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LLM_DEBUG_MAX_BYTES,
  LLM_DEBUG_MAX_ENTRIES,
  LLM_DEBUG_ERROR_REDACTED,
  LLM_DEBUG_REDACTED,
  LLM_DEBUG_RETENTION_MS,
  pruneLlmDebugEntries,
  redactLlmDebugEntry,
  useLlmDebugStore,
  type LlmDebugEntry,
} from "@/debug/llmDebugStore";

function entry(id: string, at = Date.now(), content = "content"): LlmDebugEntry {
  return { id, at, kind: "chat", model: "model", status: "done", messages: [{ role: "user", content }], response: content };
}

describe("LLM debug history privacy", () => {
  beforeEach(() => {
    localStorage.clear();
    useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  });

  it("redacts prompts, responses, credentials, and sensitive errors", () => {
    const redacted = redactLlmDebugEntry({
      ...entry("one", 1, "manuscript secret"),
      label: "token=abc123",
      error: "Bearer sk-secretvalue api_key=hunter2",
      provider: "openai",
      integrationId: "customer-secret-integration-name",
      routeCandidateIndex: 1,
      usedFallback: true,
    });
    expect(redacted.messages?.[0].content).toBe(LLM_DEBUG_REDACTED);
    expect(redacted.response).toBe(LLM_DEBUG_REDACTED);
    expect(redacted.error).toBe(LLM_DEBUG_ERROR_REDACTED);
    expect(JSON.stringify(redacted)).not.toContain("manuscript secret");
    expect(JSON.stringify(redacted)).not.toContain("abc123");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(JSON.stringify(redacted)).not.toContain("sk-secretvalue");
    expect(redacted).toMatchObject({ provider: "openai", routeCandidateIndex: 1, usedFallback: true });
    expect(redacted.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
    expect(redacted.integrationId).toBe(redactLlmDebugEntry(redacted).integrationId);
    expect(JSON.stringify(redacted)).not.toContain("customer-secret-integration-name");
  });

  it("drops unrecognized provider metadata instead of persisting sensitive values", () => {
    const redacted = redactLlmDebugEntry({ ...entry("provider"), provider: "https://private.example.test?token=secret", integrationId: "raw-id" });
    expect(redacted.provider).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain("private.example.test");
    expect(JSON.stringify(redacted)).not.toContain("raw-id");
  });

  it("bounds history by age, count, and serialized UTF-8 bytes", () => {
    const now = Date.now();
    const many = Array.from({ length: LLM_DEBUG_MAX_ENTRIES + 20 }, (_, index) => entry(String(index), now - index));
    many.push(entry("expired", now - LLM_DEBUG_RETENTION_MS - 1));
    const pruned = pruneLlmDebugEntries(many, now);
    expect(pruned).toHaveLength(LLM_DEBUG_MAX_ENTRIES);
    expect(pruned.some((item) => item.id === "expired")).toBe(false);

    const large = Array.from({ length: 10 }, (_, index) => entry(String(index), now, "x".repeat(LLM_DEBUG_MAX_BYTES / 2)));
    expect(new TextEncoder().encode(JSON.stringify(pruneLlmDebugEntries(large, now))).byteLength).toBeLessThanOrEqual(LLM_DEBUG_MAX_BYTES);
  });

  it("deletes legacy data and isolates and clears account histories", () => {
    localStorage.setItem("narrarium-llm-debug-v1", JSON.stringify([entry("legacy")]));
    useLlmDebugStore.getState().setAccount("google:first@example.com");
    expect(localStorage.getItem("narrarium-llm-debug-v1")).toBeNull();
    useLlmDebugStore.getState().begin({ id: "first", kind: "chat", model: "m", messages: [{ role: "user", content: "private" }] });
    expect(Object.keys(localStorage)).toHaveLength(1);
    expect(Object.keys(localStorage)[0]).not.toContain("first@example.com");
    expect(Object.values(localStorage).join(" ")).not.toContain("private");

    useLlmDebugStore.getState().setAccount("google:second@example.com", "google:first@example.com", true);
    expect(useLlmDebugStore.getState().entries).toEqual([]);
    expect(Object.keys(localStorage)).toHaveLength(0);
    useLlmDebugStore.getState().begin({ id: "second", kind: "chat", model: "m", messages: [{ role: "user", content: "private" }] });
    useLlmDebugStore.getState().setAccount(null, "google:second@example.com", true);
    expect(useLlmDebugStore.getState().entries).toEqual([]);
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it("surfaces quota failures without throwing from request tracking", () => {
    useLlmDebugStore.getState().setAccount("google:first@example.com");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
    expect(() => useLlmDebugStore.getState().begin({ kind: "chat", model: "m", messages: [{ role: "user", content: "private" }] })).not.toThrow();
    expect(useLlmDebugStore.getState().storageError).toContain("Quota exceeded");
    expect(useLlmDebugStore.getState().entries).toHaveLength(1);
  });
});
