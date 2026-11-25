import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiRequest } from "narrarium-engine";

import i18n from "@/i18n";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { LlmDebugPanel } from "@/components/debug/LlmDebugPanel";
import { attemptBadges } from "@/debug/attemptBadges";
import { LLM_DEBUG_MAX_BYTES, pruneLlmDebugEntries, redactLlmDebugEntry, useLlmDebugStore, type LlmDebugEntry } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS, type ReasoningParameter } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, data, DONE, eventStream, hang, textReply, toolReply, USAGE, type ProviderReply } from "./helpers/fakeProvider";
import { chatModel, compatible, endpointsOf, GITHUB_TOKEN, routed, SCHEMA, settingsOf, type Fixture } from "./helpers/aiFixtures";
import { resetCosts } from "./helpers/costs";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "The system prompt", user: "The user prompt" };
const STRUCTURED: AiRequest = { ...ASK, json: SCHEMA };
const entries = () => useLlmDebugStore.getState().entries;

/** The forced call of a function as a stream: the arguments arrive in pieces. */
function streamedToolReply(value: unknown): Response {
  const json = JSON.stringify(value);
  const middle = Math.floor(json.length / 2);
  return eventStream([
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "result", arguments: json.slice(0, middle) } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(middle) } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    data({ choices: [], usage: USAGE }),
    DONE,
  ]);
}

function ask(fixtures: Fixture[], settings = settingsOf(fixtures), request: AiRequest = STRUCTURED, reply: ProviderReply = () => streamedToolReply({ ok: true })) {
  const fake = createFakeProvider(endpointsOf(fixtures), reply, [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  useSettingsStore.setState({ settings });
  return { fake, done: createBrowserAi().complete(request) };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  resetCosts({ bookId: "book-1", bookName: "The Glass Harbor" });
  setFallbackAcknowledgementAccountScope(localWorkspaceScope());
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setFallbackAcknowledgementAccountScope(null);
  useUiStore.setState({ debugOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  assertProvidersClean();
  await i18n.changeLanguage("en");
});

describe("what the debug history keeps of how an attempt was asked", () => {
  it("is what the engine says of the attempt when it is sent: how the answer was asked for, whether it streams, the level of thinking, «Tools only» and the models left out", async () => {
    const lame = compatible("a", [chatModel("lame", { supportsToolCalls: false })]);
    const fine = compatible("b", [chatModel("fine")], { thinking: "high" });
    const { done } = ask([lame, fine], routed([lame, fine]));
    await done;
    const [entry] = entries();
    expect(entry).toMatchObject({
      model: "fine", routeCandidateIndex: 1, usedFallback: true, task: "autopilot", label: "autopilot:scene",
      structured: true, tools: true, stream: true, streamMode: "auto", toolsOnly: true, thinking: "high",
      skipped: [{ model: "lame", reason: "no-tool-calls" }],
    });
    expect(entry.timeouts).toEqual({ startMs: 600_000, idleMs: 600_000, capMs: 14_400_000 });
  });

  it("is what came back, at the end: whether it was read as a stream, how long the first byte took and whether the model called the function", async () => {
    const fixture = compatible("a");
    await ask([fixture]).done;
    const [entry] = entries();
    expect(entry).toMatchObject({ status: "done", streamed: true, toolCalled: true });
    expect(typeof entry.firstByteMs).toBe("number");
    expect(entry.firstByteMs).toBeGreaterThanOrEqual(0);
  });

  it("says a reply that came whole, to a request that asked to stream, was not read as a stream", async () => {
    const fixture = compatible("a");
    await ask([fixture], settingsOf([fixture]), STRUCTURED, () => toolReply({ ok: true })).done;
    expect(entries()[0]).toMatchObject({ stream: true, streamed: false, toolCalled: true });
  });

  it("says that a prose request is not a structured one, and has no function to call", async () => {
    const fixture = compatible("a");
    await ask([fixture], settingsOf([fixture]), ASK, () => textReply("The scene.")).done;
    const [entry] = entries();
    expect(entry).toMatchObject({ structured: false, status: "done" });
    expect(entry.toolCalled).toBeUndefined();
  });

  it("says JSON in the message, and that «Tools only» is off, for a model without tool calls that the author chose to keep", async () => {
    const lame = compatible("a", [chatModel("lame", { supportsToolCalls: false })]);
    await ask([lame], settingsOf([lame], { aiToolsOnly: false }), STRUCTURED, () => textReply(JSON.stringify({ ok: true }))).done;
    expect(entries()[0]).toMatchObject({ structured: true, tools: false, toolsOnly: false, toolCalled: false });
  });

  it("says the model was not asked to stream when the integration says «off»", async () => {
    const whole = compatible("a", undefined, { streamMode: "off" });
    await ask([whole], settingsOf([whole]), STRUCTURED, () => toolReply({ ok: true })).done;
    expect(entries()[0]).toMatchObject({ stream: false, streamMode: "off", streamed: false });
  });

  it("says the level of thinking that was sent, and nothing when none was: «automatic» sends nothing", async () => {
    const low = compatible("a", undefined, { thinking: "low" });
    await ask([low]).done;
    expect(entries()[0].thinking).toBe("low");
    useLlmDebugStore.setState({ entries: [], pending: 0 });
    const automatic = compatible("b", undefined, { thinking: "automatic" });
    await ask([automatic]).done;
    expect(entries()[0].thinking).toBeUndefined();
  });

  it("says that the level went as the argument of the chat template, only when it did: the model says so, and a level is asked for", async () => {
    const TEMPLATE = "chat_template_kwargs.reasoning_strength";
    const muse = compatible("a", [chatModel("muse-glimmer-30b", { reasoningParameter: TEMPLATE })], { thinking: "high" });
    await ask([muse]).done;
    expect(entries()[0]).toMatchObject({ thinking: "high", reasoningParameter: TEMPLATE });
    // The other ways of sending a level, and no level at all, say nothing of it: the engine does not report them.
    for (const [parameter, thinking] of [[undefined, "high"], ["reasoning_effort", "high"], ["none", "high"], [TEMPLATE, "automatic"]] as Array<[ReasoningParameter | undefined, "high" | "automatic"]>) {
      useLlmDebugStore.setState({ entries: [], pending: 0 });
      await ask([compatible("b", [chatModel("m", parameter ? { reasoningParameter: parameter } : {})], { thinking })]).done;
      expect(entries()[0], `${parameter} with ${thinking}`).not.toHaveProperty("reasoningParameter");
    }
  });

  it("says that the provider timeout was raised to the minimum when it was", async () => {
    const quick = compatible("a", undefined, { requestTimeoutMs: 6_000 });
    await ask([quick]).done;
    expect(entries()[0].timeouts).toEqual({ startMs: 30_000, idleMs: 600_000, capMs: 14_400_000, raisedFrom: 6_000 });
  });

  it("says which deadline ran out, for a request that timed out", async () => {
    vi.useFakeTimers();
    const slow = compatible("a", undefined, { requestTimeoutMs: 30_000 });
    const { done } = ask([slow], settingsOf([slow]), STRUCTURED, (call) => hang(call.signal));
    const failure = done.then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(entries()[0]).toMatchObject({ status: "error", failureKind: "timeout", timeoutMs: 30_000, timeoutPhase: "start" });
  });

  it("keeps metadata only: no word of the prompt, the reply or the models' answer is in what it kept, and the new fields hold numbers, flags and a few words of the engine", async () => {
    const fixture = compatible("a");
    await ask([fixture], settingsOf([fixture]), { ...STRUCTURED, system: "THE-SECRET-MANUSCRIPT", user: "THE-SECRET-INSTRUCTION" }, () => streamedToolReply({ ok: "THE-SECRET-ANSWER" })).done;
    const stored = JSON.stringify(entries());
    for (const forbidden of ["THE-SECRET-MANUSCRIPT", "THE-SECRET-INSTRUCTION", "THE-SECRET-ANSWER", fixture.endpoint.apiKey, "example.test"]) expect(stored).not.toContain(forbidden);
  });
});

describe("the fields are facultative, and nothing but metadata gets in", () => {
  const base: Omit<LlmDebugEntry, "id" | "at" | "status"> = { kind: "chat", model: "gpt-4o" };
  const kept = (extra: Record<string, unknown>) => redactLlmDebugEntry({ ...base, id: "e", at: Date.now(), status: "done", ...extra } as LlmDebugEntry);

  it("keeps an entry that an earlier version saved, as it was: it has none of them", () => {
    const old = kept({});
    for (const field of ["task", "structured", "tools", "stream", "streamMode", "thinking", "reasoningParameter", "toolsOnly", "skipped", "timeouts", "streamed", "firstByteMs", "toolCalled", "timeoutPhase"]) expect(old, field).not.toHaveProperty(field);
    expect(old).toMatchObject({ model: "gpt-4o", status: "done" });
  });

  it("loads again, with none of the fields, the history it saved without them: nothing is added to an entry on the way out of the storage", () => {
    const identity = "google:sub-writer";
    useLlmDebugStore.getState().setAccount(identity);
    useLlmDebugStore.getState().begin({ kind: "chat", model: "gpt-4o", label: "copilot" });
    expect(localStorage.length).toBe(1);
    useLlmDebugStore.setState({ entries: [] });
    useLlmDebugStore.getState().setAccount(identity);
    expect(entries().map((entry) => entry.label)).toEqual(["copilot"]);
    for (const field of ["structured", "tools", "toolsOnly", "skipped", "timeouts", "toolCalled"]) expect(entries()[0], field).not.toHaveProperty(field);
  });

  it.each([
    ["a word that is not a flag", { tools: "yes", stream: "true", structured: 1, toolsOnly: "on", toolCalled: null, streamed: "no" }],
    ["a level that does not exist", { thinking: "extreme" }],
    ["automatic, which sends nothing and is never a level that was sent", { thinking: "automatic" }],
    ["a mode that does not exist", { streamMode: "sometimes" }],
    ["a phase that does not exist", { timeoutPhase: "later" }],
    ["a time that is no time", { firstByteMs: -4 }],
    ["a time that is not a number", { firstByteMs: "soon" }],
    ["the OpenAI field, which is what is not said: only the chat-template form is", { reasoningParameter: "reasoning_effort" }],
    ["none, which sends no level and so has nothing to say", { reasoningParameter: "none" }],
    ["a way of sending the level that this version does not know", { reasoningParameter: "chat_template_kwargs.enable_thinking" }],
    ["a way of sending the level that is not a word", { reasoningParameter: 3 }],
    ["a task that is no task of the router", { task: "copilot:brainstorming" }],
    ["a task that is not a word", { task: { name: "brainstorming" } }],
  ])("drops %s", (_name, extra) => {
    const entry = kept(extra);
    for (const field of Object.keys(extra)) expect(entry, field).not.toHaveProperty(field);
  });

  it("keeps the flags, the level, the mode, the phase and the times that are what the engine says", () => {
    const entry = kept({ structured: true, tools: false, stream: true, streamMode: "off", thinking: "xhigh", reasoningParameter: "chat_template_kwargs.reasoning_strength", toolsOnly: false, streamed: false, toolCalled: false, firstByteMs: 0, timeoutPhase: "idle", timeouts: { startMs: 30_000, idleMs: 45_000, capMs: 14_400_000, raisedFrom: 6_000 } });
    expect(entry).toMatchObject({ structured: true, tools: false, stream: true, streamMode: "off", thinking: "xhigh", reasoningParameter: "chat_template_kwargs.reasoning_strength", toolsOnly: false, streamed: false, toolCalled: false, firstByteMs: 0, timeoutPhase: "idle", timeouts: { startMs: 30_000, idleMs: 45_000, capMs: 14_400_000, raisedFrom: 6_000 } });
  });

  it("keeps the task of the router the request was made for, Brainstorming's among them", () => {
    for (const task of ["brainstorming", "copilot", "autopilot", "default"]) expect(kept({ task }).task).toBe(task);
  });

  it("keeps only the numbers of the deadlines, and drops a deadline that is not one", () => {
    expect(kept({ timeouts: { startMs: 30_000, idleMs: "soon", capMs: 14_400_000 } })).not.toHaveProperty("timeouts");
    expect(kept({ timeouts: { startMs: 30_000, idleMs: 600_000, capMs: 14_400_000, content: "THE PROMPT" } }).timeouts).toEqual({ startMs: 30_000, idleMs: 600_000, capMs: 14_400_000 });
  });

  it("keeps the models that were left out by their name, takes a key out of a name, and keeps a few: it is a list of models and not a place for anything else", () => {
    const entry = kept({ skipped: [{ model: "sk-abcdefghijklmnop0123", reason: "no-tool-calls" }, { model: "lame", reason: "no-tool-calls" }, { model: "odd", reason: "because" }, { reason: "no-tool-calls" }, "lame"] });
    expect(entry.skipped).toEqual([{ model: "[REDACTED]", reason: "no-tool-calls" }, { model: "lame", reason: "no-tool-calls" }]);
    const many = kept({ skipped: Array.from({ length: 30 }, (_, index) => ({ model: `m${index}`, reason: "no-tool-calls" })) });
    expect(many.skipped).toHaveLength(8);
    const long = kept({ skipped: [{ model: "x".repeat(500), reason: "no-tool-calls" }] });
    expect(long.skipped?.[0].model.length).toBeLessThanOrEqual(120);
  });

  it("still fits the limit of the history when every entry has all of them: the oldest go first", () => {
    const rich = (index: number): LlmDebugEntry => ({
      ...base, id: `e${index}`, at: Date.now() - index, status: "done", label: "autopilot:scene", model: "model-with-a-long-name-0123456789", provider: "openai", integrationId: "integration:0123456789abcdef",
      structured: true, tools: true, stream: true, streamMode: "auto", thinking: "high", reasoningParameter: "chat_template_kwargs.reasoning_strength", toolsOnly: true, streamed: true, toolCalled: true, firstByteMs: 1234,
      skipped: Array.from({ length: 8 }, (_, skip) => ({ model: `skipped-model-${skip}-0123456789`, reason: "no-tool-calls" as const })),
      timeouts: { startMs: 600_000, idleMs: 600_000, capMs: 14_400_000 },
      messages: [{ role: "system", content: "x".repeat(600) }, { role: "user", content: "x".repeat(600) }],
    });
    const pruned = pruneLlmDebugEntries(Array.from({ length: 200 }, (_, index) => rich(index)));
    expect(new TextEncoder().encode(JSON.stringify(pruned)).byteLength).toBeLessThanOrEqual(LLM_DEBUG_MAX_BYTES);
    expect(pruned.length).toBeGreaterThan(0);
    expect(pruned[0].id).toBe("e0");
  });
});

describe("the badges of an attempt", () => {
  const entry = (extra: Partial<LlmDebugEntry>): LlmDebugEntry => ({ id: "e", at: 1, kind: "chat", model: "m", status: "done", ...extra });
  const ids = (extra: Partial<LlmDebugEntry>) => attemptBadges(entry(extra), "en").map((badge) => badge.id);

  it("is nothing for an entry that has none of the fields: an earlier version saved it, or it is not a chat request", () => {
    expect(attemptBadges(entry({}), "en")).toEqual([]);
    expect(attemptBadges(entry({ kind: "image" }), "en")).toEqual([]);
  });

  it("says how a structured answer was asked for: as a function, or as JSON in the message; and nothing of the kind for prose", () => {
    expect(attemptBadges(entry({ structured: true, tools: true }), "en")[0]).toMatchObject({ id: "request", key: "debug.attempt.tools" });
    expect(attemptBadges(entry({ structured: true, tools: false }), "en")[0]).toMatchObject({ id: "request", key: "debug.attempt.json" });
    expect(ids({ structured: false, tools: false })).not.toContain("request");
    expect(ids({ structured: true })).not.toContain("request");
  });

  it("says whether it streams: what was read once the reply is in, what was asked until then", () => {
    expect(attemptBadges(entry({ stream: true, status: "pending" }), "en")[0]).toMatchObject({ id: "stream", key: "debug.attempt.streaming" });
    expect(attemptBadges(entry({ stream: true, streamed: false }), "en")[0]).toMatchObject({ id: "stream", key: "debug.attempt.notStreaming" });
    expect(attemptBadges(entry({ stream: false }), "en")[0]).toMatchObject({ id: "stream", key: "debug.attempt.notStreaming" });
    expect(attemptBadges(entry({ stream: true, streamed: true }), "en")[0]).toMatchObject({ id: "stream", key: "debug.attempt.streaming" });
  });

  it("says the level of thinking, and whether the function was called, for a structured request that got an answer", () => {
    expect(attemptBadges(entry({ thinking: "high" }), "en")[0]).toMatchObject({ id: "thinking", params: { level: "high" } });
    expect(attemptBadges(entry({ structured: true, toolCalled: true }), "en").find((badge) => badge.id === "called")).toMatchObject({ key: "debug.attempt.calledYes" });
    expect(attemptBadges(entry({ structured: true, toolCalled: false }), "en").find((badge) => badge.id === "called")).toMatchObject({ key: "debug.attempt.calledNo" });
    expect(ids({ structured: true })).not.toContain("called");
    expect(ids({ structured: false, toolCalled: true })).not.toContain("called");
  });

  it("says how the level was sent right after the level, when it went as the argument of the chat template, and says nothing of it otherwise", () => {
    const TEMPLATE = "chat_template_kwargs.reasoning_strength";
    const order = ids({ structured: true, tools: true, stream: true, thinking: "high", reasoningParameter: TEMPLATE, toolCalled: true });
    expect(order.indexOf("reasoningParameter")).toBe(order.indexOf("thinking") + 1);
    expect(attemptBadges(entry({ thinking: "high", reasoningParameter: TEMPLATE }), "en").find((badge) => badge.id === "reasoningParameter")).toEqual({ id: "reasoningParameter", key: "debug.attempt.reasoningParameter", params: { parameter: TEMPLATE } });
    expect(ids({ thinking: "high" })).not.toContain("reasoningParameter");
  });

  it("names the models that were left out, and the first byte in a figure a person reads", () => {
    const badges = attemptBadges(entry({ skipped: [{ model: "lame", reason: "no-tool-calls" }, { model: "meh", reason: "no-tool-calls" }], firstByteMs: 1234 }), "en");
    expect(badges.find((badge) => badge.id === "skipped")).toMatchObject({ key: "debug.attempt.skipped", params: { models: "lame, meh" } });
    expect(badges.find((badge) => badge.id === "firstByte")).toMatchObject({ params: { time: "1.2 s" } });
    expect(attemptBadges(entry({ firstByteMs: 85 }), "it").find((badge) => badge.id === "firstByte")?.params).toEqual({ time: "85 ms" });
    expect(attemptBadges(entry({ firstByteMs: 1234 }), "it").find((badge) => badge.id === "firstByte")?.params).toEqual({ time: "1,2 s" });
  });

  it("says the state of «Tools only» for a structured request, and the deadlines it ran with", () => {
    expect(attemptBadges(entry({ structured: true, toolsOnly: true }), "en").find((badge) => badge.id === "toolsOnly")).toMatchObject({ key: "debug.attempt.toolsOnlyOn" });
    expect(attemptBadges(entry({ structured: true, toolsOnly: false }), "en").find((badge) => badge.id === "toolsOnly")).toMatchObject({ key: "debug.attempt.toolsOnlyOff" });
    expect(ids({ structured: false, toolsOnly: true })).not.toContain("toolsOnly");
    const limits = attemptBadges(entry({ timeouts: { startMs: 30_000, idleMs: 600_000, capMs: 14_400_000, raisedFrom: 6_000 } }), "en").find((badge) => badge.id === "limits");
    expect(limits).toMatchObject({ key: "debug.attempt.limitsRaised", params: { start: "30 s", idle: "600 s", from: "6 s" } });
    expect(attemptBadges(entry({ timeouts: { startMs: 600_000, idleMs: 600_000, capMs: 14_400_000 } }), "en").find((badge) => badge.id === "limits")).toMatchObject({ key: "debug.attempt.limits" });
  });
});

describe("the panel", () => {
  const rich: LlmDebugEntry = {
    id: "e1", at: Date.now(), endedAt: Date.now() + 1500, kind: "chat", label: "autopilot:scene", model: "fine", provider: "openai", status: "done",
    structured: true, tools: true, stream: true, streamMode: "auto", thinking: "high", reasoningParameter: "chat_template_kwargs.reasoning_strength", toolsOnly: true, streamed: true, toolCalled: true, firstByteMs: 1234,
    skipped: [{ model: "lame", reason: "no-tool-calls" }], timeouts: { startMs: 600_000, idleMs: 600_000, capMs: 14_400_000 },
  };
  const open = (entry: LlmDebugEntry) => {
    useLlmDebugStore.setState({ entries: [entry], pending: 0 });
    useUiStore.setState({ debugOpen: true });
    return render(<LlmDebugPanel />);
  };
  const details = () => screen.getByRole("list", { name: t("debug.attempt.title") });

  it.each([
    ["en", ["Asked as a function call", "Streaming", "Thinking: high", "Level sent as chat_template_kwargs.reasoning_strength", "Function called: yes", "Skipped: lame (no tool calls)", "First byte: 1.2 s", "Tools only: on"]],
    ["it", ["Richiesta come chiamata di funzione", "In streaming", "Thinking: high", "Livello inviato come chat_template_kwargs.reasoning_strength", "Funzione chiamata: sì", "Saltati: lame (senza tool call)", "Primo byte: 1,2 s", "Solo tool: attivo"]],
  ] as const)("shows, for a request, how it was asked and what came back, in words (%s)", async (language, words) => {
    await i18n.changeLanguage(language);
    open(rich);
    const list = within(details());
    for (const text of words) expect(list.getByText(text)).toBeInTheDocument();
  });

  it.each([
    ["en", "Task", { brainstorming: "Brainstorming", copilot: "Copilot", autopilot: "Autopilot" }],
    ["it", "Attività", { brainstorming: "Brainstorming", copilot: "Copilot", autopilot: "Autopilot" }],
  ] as const)("says in words which task of the router the request was for, Brainstorming's included (%s)", async (language, title, names) => {
    await i18n.changeLanguage(language);
    expect(t("debug.task")).toBe(title);
    for (const [task, name] of Object.entries(names)) {
      const view = open({ ...rich, label: task, task: task as LlmDebugEntry["task"] });
      expect(screen.getByText(title).parentElement).toHaveTextContent(`${title}${name}`);
      view.unmount();
    }
    open({ ...rich, task: undefined });
    expect(screen.getByText(title).parentElement).toHaveTextContent(`${title}—`);
  });

  it("says JSON in the message and that the function was not called, for a model that cannot", async () => {
    open({ ...rich, tools: false, toolCalled: false, toolsOnly: false, skipped: undefined, thinking: undefined, streamed: false, stream: false });
    const list = within(details());
    for (const text of ["JSON in the message", "Function called: no", "Not streaming", "Tools only: off"]) expect(list.getByText(text)).toBeInTheDocument();
    expect(list.queryByText(/Thinking/)).not.toBeInTheDocument();
    expect(list.queryByText(/Skipped/)).not.toBeInTheDocument();
  });

  it("shows nothing of it for an entry that has none of the fields, and no empty list", () => {
    open({ id: "old", at: Date.now(), kind: "chat", model: "gpt-4o", status: "done" });
    expect(screen.queryByRole("list", { name: t("debug.attempt.title") })).not.toBeInTheDocument();
    expect(screen.getAllByText(/gpt-4o/).length).toBeGreaterThan(0);
  });

  it("tells each badge in words, never by a colour: every item has its own text and none is only an icon or a dot", () => {
    open(rich);
    for (const item of within(details()).getAllByRole("listitem")) {
      expect(item.textContent?.trim().length ?? 0).toBeGreaterThan(3);
      expect(item.className).toMatch(/\btext-xs\b/);
    }
  });

  it("follows the entry that is selected in the list, and not the first", () => {
    useLlmDebugStore.setState({ entries: [{ ...rich, id: "e1", model: "fine" }, { id: "e2", at: Date.now() - 10, kind: "chat", model: "second", status: "done", structured: true, tools: false, toolsOnly: false }], pending: 0 });
    useUiStore.setState({ debugOpen: true });
    render(<LlmDebugPanel />);
    expect(within(details()).getByText("Asked as a function call")).toBeInTheDocument();
    fireEvent.click(screen.getByText("second", { exact: false }).closest("button") as HTMLElement);
    expect(within(details()).getByText("JSON in the message")).toBeInTheDocument();
    expect(within(details()).queryByText("Asked as a function call")).not.toBeInTheDocument();
  });
});
