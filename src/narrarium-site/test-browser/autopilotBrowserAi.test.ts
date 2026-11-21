import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, AiReplyRejectedError, AiUnavailableError } from "narrarium-engine";
import type { LlmFinishReport } from "@/assistant/llm";

const mocks = vi.hoisted(() => ({ tool: vi.fn(), text: vi.fn() }));

vi.mock("@/assistant/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/assistant/router")>()),
  completeToolRouted: mocks.tool,
  completeTextRouted: mocks.text,
}));

import { CompletionFallbackError } from "@/assistant/completionFallback";
import { NoCompletionCandidatesError, PromptBudgetExceededError } from "@/assistant/router";
import { createBrowserAi } from "@/autopilot/browserAi";

const schema = { name: "director_review", description: "d", parameters: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } };

function finish(patch: Partial<LlmFinishReport> = {}): LlmFinishReport {
  return { model: "local-model", provider: "openai", integrationId: "lm", inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, cost: 0.01, finishReason: "stop", replyCharacters: 20, reasoningCharacters: 0, ...patch };
}

type RouterOptions = { validate?: (output: unknown) => unknown; onFinish?: (report: LlmFinishReport) => void; onAttempt?: (index: number) => void; overflow?: string };

describe("autopilot AI adapter in the browser", () => {
  beforeEach(() => {
    mocks.tool.mockReset();
    mocks.text.mockReset();
  });

  it("validates structured replies with the engine helper and never lets the router cut the prompt", async () => {
    mocks.tool.mockImplementation(async (_settings: unknown, _messages: unknown, _capability: unknown, _tool: unknown, options: RouterOptions) => {
      expect(options.overflow).toBe("fail");
      expect(() => options.validate!({})).toThrow(AiReplyRejectedError);
      expect(() => options.validate!("not json")).toThrow(/not a JSON object/);
      options.onAttempt?.(0);
      options.onFinish?.(finish({ cost: 0.02 }));
      options.onAttempt?.(1);
      options.onFinish?.(finish());
      const output = options.validate!({ arguments: { verdict: "approve" } });
      return { output, metadata: { requestId: "r", task: "director", provider: "openai", integrationId: "lm", model: "local-model", inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, cost: 0.01, routeCandidateIndex: 1, usedFallback: true } };
    });
    const response = await createBrowserAi().complete({ capability: "director", label: "t", system: "s", user: "u", json: schema });
    expect(response.json).toEqual({ verdict: "approve" });
    expect(response.truncated).toBe(false);
    expect(response.usage).toEqual({ inputTokens: 200, outputTokens: 80, cachedInputTokens: 0 });
    expect(response.cost).toBeCloseTo(0.03);
  });

  it("marks a text reply cut by the output limit as truncated", async () => {
    mocks.text.mockImplementation(async (_settings: unknown, _messages: unknown, _capability: unknown, options: RouterOptions) => {
      expect(options.overflow).toBe("fail");
      options.onAttempt?.(0);
      options.onFinish?.(finish({ finishReason: "length", replyCharacters: 5000 }));
      return "Half a scene";
    });
    const response = await createBrowserAi().complete({ capability: "autopilot", label: "t", system: "s", user: "u", onText: () => undefined });
    expect(response.text).toBe("Half a scene");
    expect(response.truncated).toBe(true);
    expect(response.model).toBe("local-model");
  });

  it("explains reasoning-only and truncated replies, keeping what they cost", async () => {
    mocks.text.mockImplementation(async (_s: unknown, _m: unknown, _c: unknown, options: RouterOptions) => {
      options.onAttempt?.(0);
      options.onFinish?.(finish({ replyCharacters: 0, reasoningCharacters: 900 }));
      throw new CompletionFallbackError(["openai/local-model: empty response"], [{ name: "Error" }]);
    });
    const empty = await createBrowserAi().complete({ capability: "autopilot", label: "t", system: "s", user: "u" }).catch((error: unknown) => error);
    expect(empty).toBeInstanceOf(AiProviderError);
    expect((empty as AiProviderError).retryable).toBe(true);
    expect((empty as AiProviderError).message).toMatch(/finished after reasoning without a reply/);
    expect((empty as AiProviderError).usage?.outputTokens).toBe(40);

    mocks.tool.mockImplementation(async (_s: unknown, _m: unknown, _c: unknown, _t: unknown, options: RouterOptions) => {
      options.onAttempt?.(0);
      options.onFinish?.(finish({ finishReason: "length", replyCharacters: 0, reasoningCharacters: 4000 }));
      throw new SyntaxError("Unexpected end of JSON input");
    });
    const cut = await createBrowserAi().complete({ capability: "director", label: "t", system: "s", user: "u", json: schema }).catch((error: unknown) => error) as AiProviderError;
    expect(cut.retryable).toBe(false);
    expect(cut.truncated).toBe(true);
    expect(cut.message).toMatch(/used its output limit while reasoning, before writing the reply/);
  });

  it("classifies router failures for the shared runner", async () => {
    const cases: Array<[unknown, (error: unknown) => void]> = [
      [new NoCompletionCandidatesError(), (error) => expect(error).toBeInstanceOf(AiUnavailableError)],
      [Object.assign(new Error("429 Rate limit"), { status: 429 }), (error) => expect(error).toMatchObject({ retryable: true, status: 429 })],
      [Object.assign(new Error("401 Incorrect API key"), { status: 401 }), (error) => expect(error).toMatchObject({ retryable: false, status: 401 })],
      [new PromptBudgetExceededError(50_000, 20_000), (error) => expect(error).toMatchObject({ retryable: false, message: expect.stringMatching(/Context window tokens/) })],
      [new CompletionFallbackError(["a: 503"], [{ name: "InternalServerError", status: 503 }]), (error) => expect(error).toMatchObject({ retryable: true, status: 503 })],
      [new CompletionFallbackError(["a: filtered"], [{ name: "ContentFilteredCompletionError" }]), (error) => expect(error).toMatchObject({ retryable: false })],
      [new SyntaxError("Unexpected token"), (error) => expect(error).toBeInstanceOf(AiReplyRejectedError)],
      [new TypeError("Failed to fetch"), (error) => expect(error).toMatchObject({ retryable: true })],
      [new DOMException("Paused by the author.", "AbortError"), (error) => expect(error).toMatchObject({ name: "AbortError" })],
    ];
    for (const [failure, check] of cases) {
      mocks.tool.mockRejectedValueOnce(failure);
      check(await createBrowserAi().complete({ capability: "director", label: "t", system: "s", user: "u", json: schema }).catch((error: unknown) => error));
    }
  });
});
