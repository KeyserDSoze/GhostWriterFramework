import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mocks.create } };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { completeText, completeToolWith } from "@/assistant/llm";

const integration = { id: "provider", name: "Provider", provider: "openai" as const, apiKey: "key" };

describe("provider output limits", () => {
  beforeEach(() => mocks.create.mockReset());

  it("sends the configured output limit for text completions", async () => {
    mocks.create.mockResolvedValue({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
    await completeText(integration, [{ role: "user", content: "write" }], "writing", { accountScope: null, modelName: "model", maxOutputTokens: 321 });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ max_tokens: 321 });
  });

  it("uses max_completion_tokens for modern reasoning models", async () => {
    mocks.create.mockResolvedValue({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
    await completeText(integration, [{ role: "user", content: "reason" }], "writing", { accountScope: null, modelName: "o3-mini", maxOutputTokens: 222 });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 222 });
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("max_tokens");

    const azure = { ...integration, provider: "azure_openai" as const, endpoint: "https://example.openai.azure.com" };
    await completeText(azure, [{ role: "user", content: "reason" }], "writing", { accountScope: null, modelName: "private-review-deployment", underlyingModel: "o3-mini", maxOutputTokens: 111 });
    expect(mocks.create.mock.calls[1][0]).toMatchObject({ max_completion_tokens: 111 });

    // A deployment that declares no model is recognized by its name when the name says it reasons. One that stays unknown gets
    // max_completion_tokens, which every model accepts from API 2024-09-01 (the default here), and max_tokens before: the rule of
    // the personal server, which uses the same function.
    await completeText(azure, [{ role: "user", content: "reason" }], "writing", { accountScope: null, modelName: "o3-looking-deployment", maxOutputTokens: 99 });
    expect(mocks.create.mock.calls[2][0]).toMatchObject({ max_completion_tokens: 99 });
    expect(mocks.create.mock.calls[2][0]).not.toHaveProperty("max_tokens");

    await completeText(azure, [{ role: "user", content: "reason" }], "writing", { accountScope: null, modelName: "private-review-deployment", maxOutputTokens: 98 });
    expect(mocks.create.mock.calls[3][0]).toMatchObject({ max_completion_tokens: 98 });
    expect(mocks.create.mock.calls[3][0]).not.toHaveProperty("max_tokens");

    const older = { ...azure, apiVersion: "2024-06-01" };
    await completeText(older, [{ role: "user", content: "reason" }], "writing", { accountScope: null, modelName: "private-review-deployment", maxOutputTokens: 97 });
    expect(mocks.create.mock.calls[4][0]).toMatchObject({ max_tokens: 97 });
    expect(mocks.create.mock.calls[4][0]).not.toHaveProperty("max_completion_tokens");
  });

  it("sends the configured output limit for forced-tool completions", async () => {
    mocks.create.mockResolvedValue({ choices: [{ message: { tool_calls: [{ function: { arguments: "{}" } }] } }] });
    await completeToolWith(integration, "model", undefined, [{ role: "user", content: "score" }], "review", { name: "score", description: "score", parameters: {} }, { accountScope: null, maxOutputTokens: 123 });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ max_tokens: 123 });
  });
});
