import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyConfirmationRouted, completeTextRouted, completeToolRouted } from "@/assistant/router";
import type { LlmFinishReport } from "@/assistant/llm";
import { assertProvidersClean, data, DONE, eventStream, textReply, USAGE } from "./helpers/fakeProvider";
import { chatModel, compatible, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { either, failure, MESSAGES, provide, resetStores, routeOf, speakCall, target } from "./helpers/copilotHarness";

const tool = { name: "score", description: "Score", parameters: { type: "object", properties: { score: { type: "number" } }, required: ["score"] } };
const piece = (content: string) => data({ choices: [{ delta: { content } }] });
const reasoning = (content: string) => data({ choices: [{ delta: { reasoning_content: content } }] });
const finish = (reason = "stop") => data({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = () => data({ choices: [], usage: USAGE });
const callPiece = (args: string, first = false, name = "score") => data({ choices: [{ delta: { tool_calls: [{ index: 0, ...(first ? { id: "call_1", type: "function" } : {}), function: { ...(first ? { name } : {}), arguments: args } }] } }] });

const local = () => compatible("local", [chatModel("muse")], { name: "LM Studio" });
function azure(apiVersion?: string): Fixture {
  const fixture = compatible("az", [chatModel("dep")], { provider: "azure_openai", endpoint: "https://az.example.test", ...(apiVersion ? { apiVersion } : {}) });
  return { ...fixture, endpoint: { ...fixture.endpoint, base: "https://az.example.test/openai", auth: "api-key" } };
}
const confirmation = (fixture: Fixture, extra = {}) => settingsOf([fixture], { taskRouting: { "simple-tasks": { primary: target(fixture), fallbacks: [] } }, ...extra });

beforeEach(resetStores);
afterEach(() => {
  vi.unstubAllGlobals();
  assertProvidersClean();
});

describe("forced tools that local servers honor", () => {
  it("forces the only tool with tool_choice \"required\", keeping the named form for old Azure API versions", async () => {
    const openai = local();
    const fake = provide([openai], speakCall({ score: 8 }, USAGE, "score"));
    await completeToolRouted(routeOf("copilot", [openai]), MESSAGES, "copilot", tool, { accountScope: null });
    expect(fake.calls[0].body).toMatchObject({ tool_choice: "required" });

    const old = azure("2024-02-15-preview");
    const oldFake = provide([old], speakCall({ score: 8 }, USAGE, "score"));
    await completeToolRouted(routeOf("copilot", [old]), MESSAGES, "copilot", tool, { accountScope: null });
    expect(oldFake.calls[0].body).toMatchObject({ tool_choice: { type: "function", function: { name: "score" } } });

    const current = azure();
    const currentFake = provide([current], speakCall({ score: 8 }, USAGE, "score"));
    await completeToolRouted(routeOf("copilot", [current]), MESSAGES, "copilot", tool, { accountScope: null });
    expect(currentFake.calls[0].body).toMatchObject({ tool_choice: "required" });

    const confirmFake = provide([openai], speakCall({ decision: "yes" }, USAGE, "confirm"));
    await expect(classifyConfirmationRouted(confirmation(openai), "yes please", undefined, null)).resolves.toBe("yes");
    expect(confirmFake.calls[0].body).toMatchObject({ tool_choice: "required" });
  });

  describe("a model that answers in the text of the reply instead of calling the function", () => {
    it("is refused while \"Tools only\" is on, the way the run refuses it: the text of a reply is never read as the answer", async () => {
      const openai = local();
      provide([openai], () => textReply("<think>hmm</think>Here: {\"score\": 7}"));

      const error = await failure(completeToolRouted(routeOf("copilot", [openai]), MESSAGES, "copilot", tool, { accountScope: null }));

      expect(error.message).toContain("answered in text instead of calling the function \"score\"");
      expect(error.message).toContain("turn off \"Tools only\" in the AI Router");
      provide([openai], () => textReply("{\"decision\": \"no\"}"));
      await expect(classifyConfirmationRouted(confirmation(openai), "no", undefined, null), "a confirmation is simply unclear").resolves.toBe("unclear");
    });

    it("is read by the JSON that it wrote when \"Tools only\" is off, also when it called the tool with {}", async () => {
      const openai = local();
      const off = { aiToolsOnly: false };
      provide([openai], () => textReply("<think>hmm</think>Here: {\"score\": 7}"));
      await expect(completeToolRouted(routeOf("copilot", [openai], off), MESSAGES, "copilot", tool, { accountScope: null })).resolves.toMatchObject({ output: { score: 7 } });

      provide([openai], () => Response.json({ choices: [{ message: { content: "{\"score\": 6}", tool_calls: [{ id: "c", type: "function", function: { name: "score", arguments: "{}" } }] }, finish_reason: "stop" }] }));
      await expect(completeToolRouted(routeOf("copilot", [openai], off), MESSAGES, "copilot", tool, { accountScope: null })).resolves.toMatchObject({ output: { score: 6 } });

      provide([openai], () => textReply("I would rather not."));
      const error = await failure(completeToolRouted(routeOf("copilot", [openai], off), MESSAGES, "copilot", tool, { accountScope: null }));
      expect(error.message).not.toBe("");

      provide([openai], () => textReply("{\"decision\": \"no\"}"));
      await expect(classifyConfirmationRouted(confirmation(openai, off), "no", undefined, null)).resolves.toBe("no");
    });
  });

  it("does not take a call with no arguments for an answer: it is a reply that was refused, and the next candidate is asked", async () => {
    const openai = local();
    provide([openai], speakCall({}, USAGE, "score"));

    const error = await failure(completeToolRouted(routeOf("copilot", [openai]), MESSAGES, "copilot", tool, { accountScope: null }));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/score/);
  });

  it("returns what was written of a text that the output limit cut", async () => {
    const openai = local();
    provide([openai], either(() => eventStream([piece("partial"), finish("length"), DONE]), () => textReply("partial", USAGE, "length")));
    await expect(completeTextRouted(routeOf("copilot", [openai]), MESSAGES, "copilot", { accountScope: null })).resolves.toBe("partial");
  });

  it("reports how an attempt ended, counting reasoning without keeping it", async () => {
    const reports: LlmFinishReport[] = [];
    const openai = local();
    const onFinish = (report: LlmFinishReport) => reports.push(report);

    provide([openai], either(
      () => eventStream([reasoning("secret chain of thought"), piece("Once"), finish("length"), usage(), DONE]),
      () => Response.json({ choices: [{ message: { content: "Once", reasoning_content: "secret chain of thought" }, finish_reason: "length" }], usage: USAGE }),
    ));
    await completeTextRouted(routeOf("copilot", [openai]), MESSAGES, "copilot", { accountScope: null, onFinish });
    expect(reports[0]).toMatchObject({ finishReason: "length", replyCharacters: 4, reasoningCharacters: 23, outputTokens: 30, model: "muse" });
    expect(JSON.stringify(reports)).not.toContain("chain of thought");

    provide([openai], either(() => eventStream([reasoning("thinking"), finish("stop"), usage(), DONE]), () => Response.json({ choices: [{ message: { content: "", reasoning: "thinking" }, finish_reason: "stop" }], usage: USAGE })));
    await failure(completeTextRouted(routeOf("copilot", [openai]), MESSAGES, "copilot", { accountScope: null, onFinish }));
    expect(reports[1]).toMatchObject({ finishReason: "stop", replyCharacters: 0, reasoningCharacters: 8 });

    provide([openai], either(
      () => eventStream([reasoning("long"), callPiece("{}", true), finish("length"), usage(), DONE]),
      () => Response.json({ choices: [{ message: { content: null, reasoning_content: "long", tool_calls: [{ id: "c", type: "function", function: { name: "score", arguments: "{}" } }] }, finish_reason: "length" }], usage: USAGE }),
    ));
    await failure(completeToolRouted(routeOf("copilot", [openai]), MESSAGES, "copilot", tool, { accountScope: null, onFinish }));
    expect(reports[2]).toMatchObject({ finishReason: "length", replyCharacters: 0, reasoningCharacters: 4 });

    provide([openai], either(() => eventStream([piece("<think>cut while reason"), finish("length"), DONE]), () => textReply("<think>cut while reason", USAGE, "length")));
    await expect(failure(completeTextRouted(routeOf("copilot", [openai]), MESSAGES, "copilot", { accountScope: null, onFinish })), "a cut that held only reasoning is no reply").resolves.toBeInstanceOf(Error);
    expect(reports[3]).toMatchObject({ finishReason: "length", replyCharacters: 0, reasoningCharacters: "cut while reason".length });
  });
});
