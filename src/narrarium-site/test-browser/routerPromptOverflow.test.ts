import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeTextRouted, completeToolRouted, PromptBudgetExceededError } from "@/assistant/router";
import { assertProvidersClean } from "./helpers/fakeProvider";
import { chatModel, compatible, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { failure, hostsOf, provide, resetStores, speak, speakCall, target } from "./helpers/copilotHarness";

/** An integration whose only model serves the Default route and the director, with a context window of `maxInputTokens` (none: not configured) and room for 100 tokens of reply. */
function integration(id: string, maxInputTokens?: number): Fixture {
  return compatible(id, [chatModel(`${id}-model`, { capabilities: ["default", "director"], maxInputTokens, maxOutputTokens: 100 })]);
}

function settings(fixtures: Fixture[]) {
  const [primary, ...fallbacks] = fixtures;
  const route = { primary: target(primary), fallbacks: fallbacks.map((fixture) => target(fixture)) };
  return settingsOf(fixtures, { taskRouting: { default: route, director: route } });
}

const findings = `FINDINGS TO DECIDE:\n${"[S1-1] a finding that must not be lost. ".repeat(200)}\nEND OF FINDINGS`;
const tool = { name: "director_review", description: "d", parameters: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } };
const sent = (fake: ReturnType<typeof provide>, index: number) => JSON.stringify(fake.calls[index].body.messages);

beforeEach(resetStores);
afterEach(() => {
  vi.unstubAllGlobals();
  assertProvidersClean();
});

describe("prompts that must never be cut", () => {
  it("refuses a text prompt that fits no routed model instead of cutting its middle", async () => {
    const small = integration("small", 1_000);
    const fake = provide([small], speak("never"));

    const error = await failure(completeTextRouted(settings([small]), [{ role: "user", content: findings }], "default", { accountScope: null, overflow: "fail" }));

    expect(error).toBeInstanceOf(PromptBudgetExceededError);
    expect(error.message).toMatch(/Nothing was sent/);
    expect(error.message).not.toContain("finding that must not be lost");
    expect(fake.calls).toHaveLength(0);
  });

  it("skips the models a prompt does not fit and sends it whole to one that fits", async () => {
    const small = integration("small", 1_000);
    const big = integration("big", 200_000);
    const fake = provide([small, big], speak("decided"));
    const attempts: number[] = [];

    await expect(completeTextRouted(settings([small, big]), [{ role: "user", content: findings }], "default", { accountScope: null, overflow: "fail", onAttempt: (index) => attempts.push(index) })).resolves.toBe("decided");

    expect(hostsOf(fake)).toEqual(["big"]);
    expect(sent(fake, 0)).toContain("END OF FINDINGS");
    expect(sent(fake, 0)).not.toContain("Context truncated");
    expect(fake.calls[0].body.stream).toBe(true);
    expect(attempts).toEqual([1]);
  });

  it("sends a prompt whole to a model whose context window is not configured", async () => {
    const unknown = integration("unknown");
    const fake = provide([unknown], speak("decided"));
    const long = `${findings}\n${"Earlier chapters, kept whole. ".repeat(4_000)}`;

    await expect(completeTextRouted(settings([unknown]), [{ role: "user", content: long }], "default", { accountScope: null, overflow: "fail" })).resolves.toBe("decided");

    expect(sent(fake, 0)).toContain("END OF FINDINGS");
    expect(sent(fake, 0)).not.toContain("Context truncated");
  });

  it("does the same for forced tools, and keeps truncating for the other features", async () => {
    const small = integration("small", 1_000);
    const big = integration("big", 200_000);
    const none = provide([small], speakCall({ verdict: "approve" }));
    await expect(completeToolRouted(settings([small]), [{ role: "user", content: findings }], "director", tool, { accountScope: null, overflow: "fail" })).rejects.toBeInstanceOf(PromptBudgetExceededError);
    expect(none.calls).toHaveLength(0);

    const whole = provide([small, big], speakCall({ verdict: "approve" }));
    await completeToolRouted(settings([small, big]), [{ role: "user", content: findings }], "director", tool, { accountScope: null, overflow: "fail" });
    expect(hostsOf(whole)).toEqual(["big"]);
    expect(sent(whole, 0)).toContain("END OF FINDINGS");

    const cut = provide([small], speakCall({ verdict: "approve" }));
    await completeToolRouted(settings([small]), [{ role: "user", content: findings }], "director", tool, { accountScope: null });
    expect(sent(cut, 0)).toContain("Context truncated");
  });

  it("holds a prompt to the room that the engine leaves for the reply of a structured call, not the one the Copilot asked for", async () => {
    // A window of 5 000 tokens: a text is asked for 1 250 of them and leaves 3 500 for the prompt, a structured reply has a floor of 4 096 and leaves 654, less its schema.
    const roomy = compatible("roomy", [chatModel("roomy-model", { capabilities: ["default", "director"], maxInputTokens: 5_000 })]);
    const fake = provide([roomy], speakCall({ verdict: "approve" }));
    const prompt = `START ${"word ".repeat(400)} END`;

    await completeToolRouted(settings([roomy]), [{ role: "user", content: prompt }], "director", tool, { accountScope: null });
    const forTool = sent(fake, 0);
    expect(forTool).toContain("Context truncated");

    const text = provide([roomy], speak("decided"));
    await completeTextRouted(settings([roomy]), [{ role: "user", content: prompt }], "default", { accountScope: null });
    expect(sent(text, 0), "the same prompt holds in the room that a text leaves").not.toContain("Context truncated");
  });
});
