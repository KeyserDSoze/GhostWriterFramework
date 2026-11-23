import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeTextRouted, completeToolRouted } from "@/assistant/router";
import { LLM_DEBUG_REDACTED } from "@/debug/llmDebugStore";
import { assertProvidersClean, failReply, hang } from "./helpers/fakeProvider";
import { chatModel, compatible, SCHEMA } from "./helpers/aiFixtures";
import { entries, failure, MESSAGES, provide, resetStores, routeOf, speakCall } from "./helpers/copilotHarness";

describe("LLM routed debug metadata", () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    assertProvidersClean();
  });

  it("records pseudonymous integration identity and fallback status without prompt or response content", async () => {
    const first = compatible("first", [chatModel("review-model")], { name: "Private" });
    const second = compatible("second", [chatModel("review-model-2")], { name: "Private too" });
    const third = compatible("private-customer-integration", [chatModel("review-model-3")], { name: "Private three" });
    provide([first, second, third], (call) => (call.url.includes("private-customer-integration") ? speakCall({ ok: true }, { prompt_tokens: 12, completion_tokens: 3 })(call) : failReply(400, "refused")));

    await completeToolRouted(routeOf("copilot", [first, second, third]), [{ role: "user", content: "unpublished manuscript text" }], "copilot", SCHEMA, { accountScope: null });

    const entry = entries()[0];
    expect(entry).toMatchObject({ provider: "openai", routeCandidateIndex: 2, usedFallback: true, status: "done" });
    expect(entry.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
    expect(entry.messages?.[0].content).toBe(LLM_DEBUG_REDACTED);
    expect(entry.response).toBe(LLM_DEBUG_REDACTED);
    expect(JSON.stringify(entries())).not.toContain("private-customer-integration");
    expect(JSON.stringify(entries())).not.toContain("unpublished manuscript text");
  });

  it("records converted timeouts and fallback identity without retaining diagnostics", async () => {
    vi.useFakeTimers();
    const slow = compatible("secret-integration", [chatModel("gpt-4o")], { name: "Private", requestTimeoutMs: 30_000 });
    const fallback = compatible("fallback", [chatModel("gpt-4o-mini")], { name: "Fallback", requestTimeoutMs: 30_000 });
    provide([slow, fallback], (call) => hang(call.signal));
    // The route is the fallback first, then the slow one, so that the slow one is the candidate that is a fallback.
    const pending = failure(completeTextRouted(routeOf("copilot", [fallback, slow]), [{ role: "user", content: "private manuscript" }], "copilot", { accountScope: null }));

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    const entry = entries()[0];
    expect(entry).toMatchObject({ failureKind: "timeout", timeoutMs: 30_000, timeoutPhase: "start", routeCandidateIndex: 1, usedFallback: true, provider: "openai" });
    expect(entry.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
    expect(JSON.stringify(entries())).not.toContain("secret-integration");
    expect(JSON.stringify(entries())).not.toContain(slow.endpoint.apiKey);
    expect(JSON.stringify(entries())).not.toContain("private manuscript");
  });

  it("classifies a provider AbortError as provider failure without an aborted operation signal", async () => {
    const only = compatible("integration", [chatModel("gpt-4o")], { name: "Private" });
    provide([only], () => Promise.reject(new DOMException("provider aborted", "AbortError")));

    await failure(completeTextRouted(routeOf("copilot", [only]), [{ role: "user", content: "private" }], "copilot", { accountScope: null }));

    expect(entries()[0]).toMatchObject({ failureKind: "provider" });
  });

  it("keeps the messages of the Copilot out of the panel too: the roles and nothing else", async () => {
    const only = compatible("integration", [chatModel("gpt-4o")], { name: "Private" });
    provide([only], speakCall({ ok: true }));

    await completeToolRouted(routeOf("copilot", [only]), MESSAGES, "copilot", SCHEMA, { accountScope: null });

    expect(entries()[0].messages?.map((message) => message.role)).toEqual(["system", "user"]);
    expect(entries()[0].messages?.map((message) => message.content)).toEqual([LLM_DEBUG_REDACTED, LLM_DEBUG_REDACTED]);
  });
});
