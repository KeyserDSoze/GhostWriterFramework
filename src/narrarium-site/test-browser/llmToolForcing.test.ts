import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: mocks.create } };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

import { classifyConfirmationWith, completeText, completeToolWith, type LlmFinishReport } from "@/assistant/llm";

const openai = { id: "local", name: "LM Studio", provider: "openai" as const, apiKey: "", endpoint: "http://localhost:1234/v1" };
const tool = { name: "score", description: "Score", parameters: { type: "object", properties: { score: { type: "number" } }, required: ["score"] } };

function stream(chunks: unknown[]) {
  return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
}

describe("forced tools that local servers honor", () => {
  beforeEach(() => mocks.create.mockReset());

  it("forces the only tool with tool_choice \"required\", keeping the named form for old Azure API versions", async () => {
    mocks.create.mockResolvedValue({ choices: [{ message: { tool_calls: [{ function: { arguments: "{\"score\":8}" } }] }, finish_reason: "tool_calls" }] });
    await completeToolWith(openai, "muse", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ tool_choice: "required" });

    const azure = { ...openai, provider: "azure_openai" as const, endpoint: "https://x.openai.azure.com" };
    await completeToolWith({ ...azure, apiVersion: "2024-02-15-preview" }, "dep", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    expect(mocks.create.mock.calls[1][0]).toMatchObject({ tool_choice: { type: "function", function: { name: "score" } } });
    await completeToolWith(azure, "dep", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null });
    expect(mocks.create.mock.calls[2][0]).toMatchObject({ tool_choice: "required" });

    mocks.create.mockResolvedValue({ choices: [{ message: { tool_calls: [{ function: { arguments: "{\"decision\":\"yes\"}" } }] } }] });
    await expect(classifyConfirmationWith(openai, "muse", undefined, "yes please", { accountScope: null })).resolves.toBe("yes");
    expect(mocks.create.mock.calls[3][0]).toMatchObject({ tool_choice: "required" });
  });

  it("reads the JSON in the content when the model does not call the tool or calls it with {}", async () => {
    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "<think>hmm</think>Here: {\"score\": 7}" }, finish_reason: "stop" }] });
    await expect(completeToolWith(openai, "muse", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null })).resolves.toMatchObject({ output: { score: 7 } });

    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "{\"score\": 6}", tool_calls: [{ function: { arguments: "{}" } }] }, finish_reason: "stop" }] });
    await expect(completeToolWith(openai, "muse", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null })).resolves.toMatchObject({ output: { score: 6 } });

    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "I would rather not." }, finish_reason: "stop" }] });
    await expect(completeToolWith(openai, "muse", undefined, [{ role: "user", content: "score" }], "review", tool, { accountScope: null })).rejects.toThrow(/did not call forced tool score/);

    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "{\"decision\": \"no\"}" } }] });
    await expect(classifyConfirmationWith(openai, "muse", undefined, "no", { accountScope: null })).resolves.toBe("no");
  });

  it("keeps the old result for callers that do not ask for the finish report", async () => {
    mocks.create.mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ function: { arguments: "{}" } }] } }] });
    await expect(completeToolWith(openai, "muse", undefined, [{ role: "user", content: "x" }], "review", tool, { accountScope: null })).resolves.toMatchObject({ output: {} });
    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] });
    await expect(completeText(openai, [{ role: "user", content: "x" }], "writing", { accountScope: null, modelName: "muse" })).resolves.toBe("partial");
  });

  it("reports how an attempt ended, counting reasoning without keeping it", async () => {
    const reports: LlmFinishReport[] = [];
    mocks.create.mockResolvedValueOnce(stream([
      { choices: [{ delta: { reasoning_content: "secret chain of thought" } }] },
      { choices: [{ delta: { content: "Once" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4000 } },
    ]));
    await completeText(openai, [{ role: "user", content: "write" }], "writing", { accountScope: null, modelName: "muse", onText: () => undefined, onFinish: (report) => reports.push(report) });
    expect(reports[0]).toMatchObject({ finishReason: "length", replyCharacters: 4, reasoningCharacters: 23, outputTokens: 4000, model: "muse" });
    expect(JSON.stringify(reports)).not.toContain("chain of thought");

    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "", reasoning: "thinking" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 9 } });
    await completeText(openai, [{ role: "user", content: "write" }], "writing", { accountScope: null, modelName: "muse", onFinish: (report) => reports.push(report) });
    expect(reports[1]).toMatchObject({ finishReason: "stop", replyCharacters: 0, reasoningCharacters: 8 });

    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: null, reasoning_content: "long", tool_calls: [{ function: { arguments: "{}" } }] }, finish_reason: "length" }], usage: { prompt_tokens: 3, completion_tokens: 9 } });
    await expect(completeToolWith(openai, "muse", undefined, [{ role: "user", content: "x" }], "review", tool, { accountScope: null, onFinish: (report) => reports.push(report), validate: (output) => { if (!output || !Object.keys(output as object).length) throw new Error("empty"); return output; } })).rejects.toThrow("empty");
    expect(reports[2]).toMatchObject({ finishReason: "length", replyCharacters: 0, reasoningCharacters: 4 });

    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: "<think>cut while reason" }, finish_reason: "length" }] });
    await expect(completeText(openai, [{ role: "user", content: "write" }], "writing", { accountScope: null, modelName: "muse", onFinish: (report) => reports.push(report) })).resolves.toBe("<think>cut while reason");
    expect(reports[3]).toMatchObject({ finishReason: "length", replyCharacters: 0, reasoningCharacters: "cut while reason".length });
  });
});
