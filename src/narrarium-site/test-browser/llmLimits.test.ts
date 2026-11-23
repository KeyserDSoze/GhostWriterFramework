import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeTextRouted, completeToolRouted } from "@/assistant/router";
import { assertProvidersClean } from "./helpers/fakeProvider";
import { chatModel, compatible, SCHEMA, type Fixture } from "./helpers/aiFixtures";
import { MESSAGES, provide, resetStores, routeOf, speak, speakCall } from "./helpers/copilotHarness";

/** An Azure OpenAI integration, whose requests go to `/openai/deployments/<name>/…` with the key in the `api-key` header. */
function azure(models: Parameters<typeof chatModel>[1], apiVersion?: string, name = "private-review-deployment"): Fixture {
  const fixture = compatible("az", [chatModel(name, models)], { provider: "azure_openai", endpoint: "https://az.example.test", ...(apiVersion ? { apiVersion } : {}) });
  return { ...fixture, endpoint: { ...fixture.endpoint, base: "https://az.example.test/openai", auth: "api-key" } };
}

/** The body the Copilot sends for a text, to the only candidate of a route. */
async function bodyOfText(fixture: Fixture, options: { fallbackMaxOutputTokens?: number } = {}) {
  const fake = provide([fixture], speak("done"));
  await completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null, ...options });
  return fake.calls[fake.calls.length - 1].body;
}

describe("provider output limits", () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.unstubAllGlobals();
    assertProvidersClean();
  });

  it("sends the configured output limit for text completions", async () => {
    expect(await bodyOfText(compatible("provider", [chatModel("model", { maxOutputTokens: 321 })]))).toMatchObject({ max_tokens: 321 });
  });

  it("uses max_completion_tokens for modern reasoning models", async () => {
    const reasoning = await bodyOfText(compatible("provider", [chatModel("o3-mini", { maxOutputTokens: 222 })]));
    expect(reasoning).toMatchObject({ max_completion_tokens: 222 });
    expect(reasoning).not.toHaveProperty("max_tokens");

    const declared = await bodyOfText(azure({ underlyingModel: "o3-mini", maxOutputTokens: 111 }));
    expect(declared).toMatchObject({ max_completion_tokens: 111 });

    // A deployment that declares no model is recognized by its name when the name says it reasons. One that stays unknown gets
    // max_completion_tokens, which every model accepts from API 2024-09-01 (the default here), and max_tokens before: the rule of
    // the personal server, which uses the same function.
    const named = await bodyOfText(azure({ maxOutputTokens: 99 }, undefined, "o3-looking-deployment"));
    expect(named).toMatchObject({ max_completion_tokens: 99 });
    expect(named).not.toHaveProperty("max_tokens");

    const unknown = await bodyOfText(azure({ maxOutputTokens: 98 }));
    expect(unknown).toMatchObject({ max_completion_tokens: 98 });
    expect(unknown).not.toHaveProperty("max_tokens");

    const older = await bodyOfText(azure({ maxOutputTokens: 97 }, "2024-06-01"));
    expect(older).toMatchObject({ max_tokens: 97 });
    expect(older).not.toHaveProperty("max_completion_tokens");
  });

  it("sends the configured output limit for forced-tool completions, which a model cannot be asked to exceed", async () => {
    const fixture = compatible("provider", [chatModel("model", { maxOutputTokens: 123 })]);
    const fake = provide([fixture], speakCall({ ok: true }));
    await completeToolRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", SCHEMA, { accountScope: null });
    expect(fake.calls[0].body).toMatchObject({ max_tokens: 123 });
  });

  it("gives a forced call the floor of the structured replies when the model has no limit of its own, and the reasoning models room to think", async () => {
    const open = compatible("provider", [chatModel("model")]);
    const fake = provide([open], speakCall({ ok: true }));
    await completeToolRouted(routeOf("copilot", [open]), MESSAGES, "copilot", SCHEMA, { accountScope: null, fallbackMaxOutputTokens: 123 });
    expect(fake.calls[0].body.max_tokens, "a call that is cut is no call at all").toBe(4_096);

    expect(await bodyOfText(compatible("thinker", [chatModel("o3-mini")]))).toMatchObject({ max_completion_tokens: 2_048 + 12_000 });
  });
});
