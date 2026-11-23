import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyConfirmationRouted, completeTextRouted, completeToolRouted } from "@/assistant/router";
import type { LlmFinishReport, LlmMessage, LlmUsageReport } from "@/assistant/llm";
import { LLM_DEBUG_REDACTED } from "@/debug/llmDebugStore";
import { assertProvidersClean, data, DONE, eventStream, failReply, streamedReply, textReply, toolReply, USAGE } from "./helpers/fakeProvider";
import { chatModel, compatible, PRICE, SCHEMA } from "./helpers/aiFixtures";
import { either, entries, failure, hostsOf, MESSAGES, provide, resetStores, routeOf, speak, speakCall } from "./helpers/copilotHarness";

const piece = (content: string) => data({ choices: [{ delta: { content } }] });
const reasoning = (content: string) => data({ choices: [{ delta: { reasoning_content: content } }] });
const finish = (reason = "stop") => data({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = (value: object = USAGE) => data({ choices: [], usage: value });
const callPiece = (args: string, first = false, name = "result") => data({ choices: [{ delta: { tool_calls: [{ index: 0, ...(first ? { id: "call_1", type: "function" } : {}), function: { ...(first ? { name } : {}), arguments: args } }] } }] });
const stream = (...chunks: string[]) => eventStream([...chunks, DONE]);

beforeEach(resetStores);
afterEach(() => {
  vi.unstubAllGlobals();
  assertProvidersClean();
});

describe("the prose of the Copilot streams, and the listener of the text sees what has arrived so far", () => {
  it("hands the listener the text so far, piece by piece, and returns the whole reply", async () => {
    const fixture = compatible("a");
    const fake = provide([fixture], () => stream(piece("The "), piece("tide "), piece("came in."), finish(), usage()));
    const seen: string[] = [];

    const text = await completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null, onText: (value) => seen.push(value) });

    expect(text).toBe("The tide came in.");
    expect(seen.filter(Boolean)).toEqual(["The ", "The tide ", "The tide came in."]);
    expect(fake.calls[0].body).toMatchObject({
      model: "model-a",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: "You are the Copilot." }, { role: "user", content: [{ type: "text", text: "Write a line." }] }],
    });
  });

  it("streams the request even when nobody listens to the text: no silent connection for a tunnel to cut", async () => {
    const fixture = compatible("a");
    const fake = provide([fixture], () => stream(piece("A whole "), piece("line."), finish(), usage()));

    await expect(completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null })).resolves.toBe("A whole line.");

    expect(fake.calls[0].body.stream).toBe(true);
  });

  it("clears the text that a failed candidate had shown before the next one writes its own", async () => {
    const a = compatible("a");
    const b = compatible("b");
    provide([a, b], (call) => (call.url.includes("a.example.test")
      ? stream(piece("Half a li"), data({ error: { message: "overloaded" } }))
      : streamedReply("A whole line.")));
    const seen: string[] = [];

    const text = await completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, onText: (value) => seen.push(value) });

    expect(text).toBe("A whole line.");
    const half = seen.indexOf("Half a li");
    expect(half, "the first candidate's text was shown").toBeGreaterThanOrEqual(0);
    expect(seen[half + 1], "and taken away when it failed").toBe("");
    expect(seen[seen.length - 1]).toBe("A whole line.");
  });

  it("returns what was written of a reply that the output limit cut, as it always did, and says how it ended", async () => {
    const fixture = compatible("a");
    const cut = { prompt_tokens: 10, completion_tokens: 2_048 };
    provide([fixture], either(() => stream(piece("Once upon "), piece("a tim"), finish("length"), usage(cut)), () => textReply("Once upon a tim", cut, "length")));
    const reports: LlmFinishReport[] = [];

    await expect(completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null, onFinish: (report) => reports.push(report) })).resolves.toBe("Once upon a tim");

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ finishReason: "length", replyCharacters: "Once upon a tim".length, reasoningCharacters: 0, outputTokens: 2_048 });
  });

  it("does not give as a reply a cut that held nothing but the reasoning of the model: the next candidate is asked", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const thought = "Let me think about the scene and think some more";
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test")
      ? either(() => stream(reasoning("Let me think about the scene "), reasoning("and think some more"), finish("length")), () => Response.json({ choices: [{ message: { content: "", reasoning_content: thought }, finish_reason: "length" }] }))(call)
      : speak("The answer.")(call)));
    const reports: LlmFinishReport[] = [];

    await expect(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, onFinish: (report) => reports.push(report) })).resolves.toBe("The answer.");

    expect(hostsOf(fake)).toEqual(["a", "b"]);
    expect(reports[0]).toMatchObject({ finishReason: "length", replyCharacters: 0, reasoningCharacters: "Let me think about the scene and think some more".length });
    expect(JSON.stringify(reports)).not.toContain("Let me think");
  });

  it("returns the text of the reply and not the reasoning that came inside it", async () => {
    const fixture = compatible("a");
    const reports: LlmFinishReport[] = [];
    provide([fixture], () => stream(piece("<think>It should be short.</think>"), piece("The tide came in."), finish(), usage()));

    await expect(completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null, onFinish: (report) => reports.push(report) })).resolves.toBe("The tide came in.");

    expect(reports[0]).toMatchObject({ replyCharacters: "The tide came in.".length, reasoningCharacters: "It should be short.".length });
  });
});

describe("the function that the Copilot forces streams too, and its arguments arrive in pieces", () => {
  it("reads the arguments of a call that comes in pieces, and sends the schema as the only tool, forced", async () => {
    const fixture = compatible("a");
    const fake = provide([fixture], () => stream(callPiece("", true), callPiece("{\"sc"), callPiece("ore\":"), callPiece("8}"), finish("tool_calls"), usage()));

    const result = await completeToolRouted<{ score: number }>(routeOf("copilot", [fixture]), MESSAGES, "copilot", { name: "result", description: "A result", parameters: { type: "object", properties: { score: { type: "number" } }, required: ["score"] } }, { accountScope: null });

    expect(result.output).toEqual({ score: 8 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "result", description: "A result", parameters: { type: "object" } } }],
    });
  });

  it("reads a call that comes whole in a JSON body, which is what a provider that does not stream answers", async () => {
    const fixture = compatible("a");
    provide([fixture], () => toolReply({ ok: true }));

    await expect(completeToolRouted<{ ok: boolean }>(routeOf("copilot", [fixture]), MESSAGES, "copilot", SCHEMA, { accountScope: null })).resolves.toMatchObject({ output: { ok: true } });
  });

  it("classifies a confirmation by the function of the confirmation, in a request that is only the utterance, framed", async () => {
    const fixture = compatible("a");
    const fake = provide([fixture], () => stream(callPiece("", true, "confirm"), callPiece("{\"decision\":"), callPiece("\"no\"}"), finish("tool_calls"), usage()));

    await expect(classifyConfirmationRouted(routeOf("simple-tasks", [fixture]), "no, stop", undefined, null)).resolves.toBe("no");

    expect(fake.calls[0].body).toMatchObject({ stream: true, tool_choice: "required", tools: [{ type: "function", function: { name: "confirm" } }] });
    expect(fake.calls[0].body.messages).toHaveLength(1);
    expect(fake.calls[0].body.messages[0]).toMatchObject({ role: "user" });
    expect(String(fake.calls[0].body.messages[0].content)).toContain("no, stop");
  });

  it("goes on to the next candidate when a reply is not a decision, and is unclear when nothing is", async () => {
    const a = compatible("a");
    const b = compatible("b");
    provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "refused") : toolReply({ decision: "maybe" })));

    await expect(classifyConfirmationRouted(routeOf("simple-tasks", [a, b]), "perhaps", undefined, null)).resolves.toBe("unclear");
  });
});

describe("what the callers hear of an attempt", () => {
  it("tells onUsage what the provider billed, once, at the price of the model", async () => {
    const fixture = compatible("a", [chatModel("model-a", { pricing: PRICE })]);
    provide([fixture], speak("A line.", { prompt_tokens: 1_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } }));
    const reports: LlmUsageReport[] = [];

    await completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null, onUsage: (report) => reports.push(report) });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ model: "model-a", provider: "openai", integrationId: "a", inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 500 });
    // 800 input at 2, 200 cached at 1 and 500 output at 8, per million tokens.
    expect(reports[0].cost).toBeCloseTo((800 * 2 + 200 * 1 + 500 * 8) / 1_000_000, 10);
  });

  it("tells onFinish how a reply ended, the reasoning counted and never kept", async () => {
    const fixture = compatible("a");
    provide([fixture], either(
      () => stream(reasoning("secret chain of thought"), piece("Once"), finish("stop"), usage()),
      () => Response.json({ choices: [{ message: { content: "Once", reasoning_content: "secret chain of thought" }, finish_reason: "stop" }], usage: USAGE }),
    ));
    const reports: LlmFinishReport[] = [];

    await completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null, onFinish: (report) => reports.push(report) });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ model: "model-a", finishReason: "stop", replyCharacters: 4, reasoningCharacters: 23, inputTokens: 120, outputTokens: 30 });
    expect(JSON.stringify(reports)).not.toContain("chain of thought");
  });

  it("tells onFinish how a forced call ended: the arguments are the reply, and {} is none", async () => {
    const fixture = compatible("a");
    const reports: LlmFinishReport[] = [];
    provide([fixture], speakCall({ ok: true }));
    await completeToolRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", SCHEMA, { accountScope: null, onFinish: (report) => reports.push(report) });
    expect(reports[0]).toMatchObject({ finishReason: "tool_calls", replyCharacters: "{\"ok\":true}".length, reasoningCharacters: 0 });

    provide([fixture], either(
      () => stream(reasoning("long"), callPiece("{}", true), finish("length"), usage()),
      () => Response.json({ choices: [{ message: { content: null, reasoning_content: "long", tool_calls: [{ id: "call_1", type: "function", function: { name: "result", arguments: "{}" } }] }, finish_reason: "length" }], usage: USAGE }),
    ));
    await failure(completeToolRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", SCHEMA, { accountScope: null, onFinish: (report) => reports.push(report) }));
    expect(reports[1]).toMatchObject({ finishReason: "length", replyCharacters: 0, reasoningCharacters: 4 });
  });

  it("tells onAttempt the place of each candidate in the route: the position, which a skipped candidate keeps", async () => {
    const a = compatible("a");
    const b = compatible("b");
    provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "refused") : speak("From b.")(call)));
    const attempts: number[] = [];
    await completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, onAttempt: (index) => attempts.push(index) });
    expect(attempts).toEqual([0, 1]);

    const small = compatible("small", [chatModel("model-small", { maxInputTokens: 1_000, maxOutputTokens: 100 })]);
    const big = compatible("big", [chatModel("model-big", { maxInputTokens: 200_000, maxOutputTokens: 100 })]);
    provide([small, big], speak("From big."));
    const skipped: number[] = [];
    await completeTextRouted(routeOf("copilot", [small, big]), [{ role: "user", content: "x".repeat(20_000) }], "copilot", { accountScope: null, overflow: "fail", onAttempt: (index) => skipped.push(index) });
    expect(skipped).toEqual([1]);
  });

  it("gives the router's own place of the candidate, and whether it is a fallback, to the result of a forced call", async () => {
    const a = compatible("a");
    const b = compatible("b");
    provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "refused") : speakCall({ ok: true })(call)));

    const result = await completeToolRouted<{ ok: boolean }>(routeOf("copilot", [a, b]), MESSAGES, "copilot", SCHEMA, { accountScope: null });

    expect(result.metadata).toMatchObject({ integrationId: "b", model: "model-b", provider: "openai", task: "copilot", routeCandidateIndex: 1, usedFallback: true });
  });
});

describe("a reply that the caller does not accept goes to the next candidate, as a reply that failed does", () => {
  it("passes a text that validateText rejects to the next candidate, and returns the one it accepts", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b], (call) => speak(call.url.includes("a.example.test") ? "not json" : "{\"title\":\"Valid\"}")(call));

    await expect(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, validateText: (text) => { JSON.parse(text); } })).resolves.toBe("{\"title\":\"Valid\"}");

    expect(hostsOf(fake)).toEqual(["a", "b"]);
  });

  it("fails with the reasons of every candidate when none of them gives a text that is accepted", async () => {
    const a = compatible("a");
    const b = compatible("b");
    provide([a, b], speak("not json"));

    const error = await failure(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, validateText: (text) => { JSON.parse(text); } }));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("All configured completion candidates failed");
    expect(error.message).toContain("openai/model-a");
    expect(error.message).toContain("openai/model-b");
    expect(error.failures).toHaveLength(2);
  });

  it("passes the output that validate rejects to the next candidate, and returns what it accepts, with the cost of the one that was used", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b], (call) => speakCall({ score: call.url.includes("a.example.test") ? -1 : 8 })(call));

    const result = await completeToolRouted<{ score: number }>(routeOf("copilot", [a, b]), MESSAGES, "copilot", { name: "result", description: "A result", parameters: {} }, {
      accountScope: null,
      validate: (value) => {
        const score = (value as { score?: unknown }).score;
        if (typeof score !== "number" || score < 0) throw new Error("invalid score");
        return { score };
      },
    });

    expect(result.output).toEqual({ score: 8 });
    expect(hostsOf(fake)).toEqual(["a", "b"]);
    expect(result.metadata).toMatchObject({ integrationId: "b", routeCandidateIndex: 1, usedFallback: true, inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 });
  });

  it("treats a reply that is empty, or only a notice that it was filtered, as no reply: the next candidate is asked", async () => {
    for (const invalid of ["   ", "[Content filtered]"]) {
      const a = compatible("a");
      const b = compatible("b");
      const fake = provide([a, b], (call) => speak(call.url.includes("a.example.test") ? invalid : "A valid fallback.")(call));
      await expect(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null })).resolves.toBe("A valid fallback.");
      expect(hostsOf(fake)).toEqual(["a", "b"]);
    }
  });

  it("goes on to the next candidate when a provider keeps answering 503: the same one is asked three times, quietly, and then the next", async () => {
    vi.useFakeTimers();
    try {
      const a = compatible("a");
      const b = compatible("b");
      const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(503, "The engine is overloaded") : speak("From b.")(call)));

      const run = completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null });
      const settled = run.then((value) => ({ value }), (error) => ({ error }));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await settled).toEqual({ value: "From b." });
      expect(hostsOf(fake)).toEqual(["a", "a", "a", "b"]);
      expect(entries().map((entry) => [entry.routeCandidateIndex, entry.status])).toEqual([[1, "done"], [0, "error"], [0, "error"], [0, "error"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on to the next candidate at once when a provider refuses the request: a 400 is not a passing moment", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "Refused") : speak("From b.")(call)));

    await expect(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null })).resolves.toBe("From b.");

    expect(hostsOf(fake)).toEqual(["a", "b"]);
    expect(entries().map((entry) => [entry.routeCandidateIndex, entry.status])).toEqual([[1, "done"], [0, "error"]]);
  });
});

describe("a reply that the provider filtered", () => {
  it("is a failure of that candidate: the next one is asked, and onFinish heard how it ended", async () => {
    const a = compatible("a");
    const b = compatible("b");
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test")
      ? either(() => stream(piece("I cannot"), finish("content_filter"), usage()), () => textReply("I cannot", USAGE, "content_filter"))(call)
      : speak("An unfiltered line.")(call)));
    const reports: LlmFinishReport[] = [];

    await expect(completeTextRouted(routeOf("copilot", [a, b]), MESSAGES, "copilot", { accountScope: null, onFinish: (report) => reports.push(report) })).resolves.toBe("An unfiltered line.");

    expect(hostsOf(fake)).toEqual(["a", "b"]);
    expect(reports[0]).toMatchObject({ model: "model-a", finishReason: "content_filter" });
  });

  it("is said to the author when every candidate filtered it", async () => {
    const a = compatible("a");
    provide([a], either(() => stream(piece("I cannot"), finish("content_filter"), usage()), () => textReply("I cannot", USAGE, "content_filter")));

    const error = await failure(completeTextRouted(routeOf("copilot", [a]), MESSAGES, "copilot", { accountScope: null }));

    expect(error.message).toMatch(/filtered/i);
  });
});

describe("the output limit of a request", () => {
  const bodyOf = async (fixture: ReturnType<typeof compatible>, options: { fallbackMaxOutputTokens?: number } = {}) => {
    const fake = provide([fixture], speak("A line."));
    await completeTextRouted(routeOf("copilot", [fixture]), MESSAGES, "copilot", { accountScope: null, ...options });
    return fake.calls[0].body;
  };

  it("sends the output limit of the model", async () => {
    expect(await bodyOf(compatible("a", [chatModel("model-a", { maxOutputTokens: 321 })]))).toMatchObject({ max_tokens: 321 });
  });

  it("sends the limit the caller proposes when the model has none, and 2048 when nobody says", async () => {
    expect(await bodyOf(compatible("a"), { fallbackMaxOutputTokens: 777 })).toMatchObject({ max_tokens: 777 });
    expect(await bodyOf(compatible("b"))).toMatchObject({ max_tokens: 2_048 });
  });

  it("leaves the limit of the model above the one the caller proposes", async () => {
    expect(await bodyOf(compatible("a", [chatModel("model-a", { maxOutputTokens: 400 })]), { fallbackMaxOutputTokens: 9_000 })).toMatchObject({ max_tokens: 400 });
  });

  it("asks each candidate for its own limit, and cuts the prompt of each to its own window", async () => {
    const a = compatible("a", [chatModel("model-a", { maxInputTokens: 120, maxOutputTokens: 17 })]);
    const b = compatible("b", [chatModel("model-b", { maxInputTokens: 500, maxOutputTokens: 29 })]);
    const fake = provide([a, b], (call) => (call.url.includes("a.example.test") ? failReply(400, "refused") : speak("From b.")(call)));
    const messages: LlmMessage[] = [{ role: "user", content: `Long chapter start\n${"x".repeat(8_000)}\nLong chapter end` }];

    await expect(completeTextRouted(routeOf("copilot", [a, b]), messages, "copilot", { accountScope: null })).resolves.toBe("From b.");

    expect(fake.calls[0].body.max_tokens).toBe(17);
    expect(fake.calls[1].body.max_tokens).toBe(29);
    expect(JSON.stringify(fake.calls[0].body.messages)).toContain("Context truncated");
    expect(JSON.stringify(fake.calls[1].body.messages)).toContain("Context truncated");
    expect(JSON.stringify(fake.calls[0].body.messages).length).toBeLessThan(JSON.stringify(fake.calls[1].body.messages).length);
  });
});

describe("the images that the author attached", () => {
  const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const withImage: LlmMessage[] = [
    { role: "system", content: "You are the Copilot." },
    { role: "user", content: [{ type: "text", text: "What is in this picture?" }, { type: "image", dataUrl: IMAGE }] },
  ];

  it("go out as image parts of the message, after its text, with the data URL", async () => {
    const fixture = compatible("a");
    const fake = provide([fixture], speak("A single pixel."));

    await expect(completeTextRouted(routeOf("copilot", [fixture]), withImage, "copilot", { accountScope: null })).resolves.toBe("A single pixel.");

    expect(fake.calls[0].body.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "What is in this picture?" }, { type: "image_url", image_url: { url: IMAGE } }] });
  });

  it("go out in a forced call too, and the debug panel says there was an image without keeping it", async () => {
    const fixture = compatible("a");
    const fake = provide([fixture], speakCall({ ok: true }));

    await completeToolRouted(routeOf("copilot", [fixture]), withImage, "copilot", SCHEMA, { accountScope: null });

    expect(fake.calls[0].body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: IMAGE } });
    expect(entries()[0].contentKinds).toEqual(["text", "image"]);
    expect(entries()[0].messages?.map((message) => message.content)).toEqual([LLM_DEBUG_REDACTED, LLM_DEBUG_REDACTED]);
    expect(JSON.stringify(entries())).not.toContain("iVBORw0KGgo");
  });

  it("are left out, with a notice, of a prompt that has no room for them: the request goes without the image, not failed", async () => {
    const fixture = compatible("a", [chatModel("model-a", { maxInputTokens: 2_000, maxOutputTokens: 100 })]);
    const fake = provide([fixture], speak("No picture."));

    await expect(completeTextRouted(routeOf("copilot", [fixture]), withImage, "copilot", { accountScope: null })).resolves.toBe("No picture.");

    const sent = JSON.stringify(fake.calls[0].body.messages);
    expect(sent).not.toContain("image_url");
    expect(sent).toContain("image attachments were omitted");
    expect(entries()[0].contentKinds).toEqual(["text"]);
  });
});
