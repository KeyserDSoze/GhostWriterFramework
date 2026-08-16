import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: createMock,
      },
    };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { completeText, completeToolWith } from "@/assistant/llm";
import { runWithCandidateTimeout } from "@/assistant/executionLimits";
import { LLM_DEBUG_REDACTED, useLlmDebugStore } from "@/debug/llmDebugStore";

describe("LLM routed debug metadata", () => {
  beforeEach(() => {
    localStorage.clear();
    useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
    createMock.mockReset().mockResolvedValue({
      choices: [{ message: { tool_calls: [{ function: { arguments: '{"score":8}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
  });

  it("records pseudonymous integration identity and fallback status without prompt or response content", async () => {
    await completeToolWith(
      { id: "private-customer-integration", name: "Private", provider: "openai", apiKey: "secret" },
      "review-model",
      undefined,
      [{ role: "user", content: "unpublished manuscript text" }],
      "review",
      { name: "score", description: "Score", parameters: {} },
      { accountScope: null, routeCandidateIndex: 2, usedFallback: true },
    );

    const entry = useLlmDebugStore.getState().entries[0];
    expect(entry).toMatchObject({ provider: "openai", routeCandidateIndex: 2, usedFallback: true, status: "done" });
    expect(entry.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
    expect(entry.messages?.[0].content).toBe(LLM_DEBUG_REDACTED);
    expect(entry.response).toBe(LLM_DEBUG_REDACTED);
    expect(JSON.stringify(entry)).not.toContain("private-customer-integration");
    expect(JSON.stringify(entry)).not.toContain("unpublished manuscript text");
  });

  it("records converted timeouts and fallback identity without retaining diagnostics", async () => {
    const integration = { id: "secret-integration", name: "Private", provider: "openai" as const, apiKey: "sk-secret-value", requestTimeoutMs: 5 };
    createMock.mockImplementation((_body, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("Bearer sk-secret-value", "AbortError")), { once: true })) as never);

    await expect(runWithCandidateTimeout((signal) => completeText(integration, [{ role: "user", content: "private manuscript" }], "writing", { accountScope: null, signal, modelName: "gpt-4o", routeCandidateIndex: 1, usedFallback: true }), undefined, 5)).rejects.toMatchObject({ name: "CandidateTimeoutError" });
    const entry = useLlmDebugStore.getState().entries[0];
    expect(entry).toMatchObject({ failureKind: "timeout", timeoutMs: 5, routeCandidateIndex: 1, usedFallback: true, provider: "openai" });
    expect(entry.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
    expect(JSON.stringify(entry)).not.toContain("secret-integration");
    expect(JSON.stringify(entry)).not.toContain("sk-secret-value");
    expect(JSON.stringify(entry)).not.toContain("private manuscript");
  });

  it("classifies a provider AbortError as provider failure without an aborted operation signal", async () => {
    const integration = { id: "integration", name: "Private", provider: "openai" as const, apiKey: "key" };
    createMock.mockRejectedValueOnce(new DOMException("provider aborted", "AbortError"));

    await expect(completeText(integration, [{ role: "user", content: "private" }], "writing", { accountScope: null, modelName: "gpt-4o" })).rejects.toMatchObject({ name: "AbortError" });
    expect(useLlmDebugStore.getState().entries[0]).toMatchObject({ failureKind: "provider" });
  });
});
