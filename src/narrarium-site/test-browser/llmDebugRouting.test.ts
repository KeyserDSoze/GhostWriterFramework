import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { tool_calls: [{ function: { arguments: '{"score":8}' } }] } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
      },
    };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { completeToolWith } from "@/assistant/llm";
import { LLM_DEBUG_REDACTED, useLlmDebugStore } from "@/debug/llmDebugStore";

describe("LLM routed debug metadata", () => {
  beforeEach(() => {
    localStorage.clear();
    useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  });

  it("records pseudonymous integration identity and fallback status without prompt or response content", async () => {
    await completeToolWith(
      { id: "private-customer-integration", name: "Private", provider: "openai", apiKey: "secret" },
      "review-model",
      undefined,
      [{ role: "user", content: "unpublished manuscript text" }],
      "review",
      { name: "score", description: "Score", parameters: {} },
      { routeCandidateIndex: 2, usedFallback: true },
    );

    const entry = useLlmDebugStore.getState().entries[0];
    expect(entry).toMatchObject({ provider: "openai", routeCandidateIndex: 2, usedFallback: true, status: "done" });
    expect(entry.integrationId).toMatch(/^integration:[0-9a-f]{16}$/);
    expect(entry.messages?.[0].content).toBe(LLM_DEBUG_REDACTED);
    expect(entry.response).toBe(LLM_DEBUG_REDACTED);
    expect(JSON.stringify(entry)).not.toContain("private-customer-integration");
    expect(JSON.stringify(entry)).not.toContain("unpublished manuscript text");
  });
});
