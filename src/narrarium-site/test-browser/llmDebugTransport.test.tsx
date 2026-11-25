import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiStreamInterruptedError, type AiRequest } from "narrarium-engine";

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import { createBrowserAi } from "@/autopilot/browserAi";
import { LlmDebugPanel } from "@/components/debug/LlmDebugPanel";
import { attemptBadges } from "@/debug/attemptBadges";
import { redactLlmDebugEntry, useLlmDebugStore, type LlmDebugEntry } from "@/debug/llmDebugStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { assertProvidersClean, createFakeProvider, data, DONE, eventStream, USAGE, type ProviderReply } from "./helpers/fakeProvider";
import { compatible, endpointsOf, GITHUB_TOKEN, settingsOf } from "./helpers/aiFixtures";
import { resetCosts } from "./helpers/costs";

// What the debug history keeps of the transport of a call, and what the panel says of it. The history is saved in the browser and keeps metadata only: it has the figures of
// the response, how the stream ended and the id of the request, and never the end of the stream or the reply that had arrived, which are words of the model.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const ASK: AiRequest = { capability: "autopilot", label: "autopilot:scene", system: "The system prompt", user: "The user prompt" };
const entries = () => useLlmDebugStore.getState().entries;
const encoder = new TextEncoder();

/** A reply that streams two pieces (the words of the scene, and some reasoning) and then breaks: what a connection that is reset looks like to the reader. */
function cutStream(): Response {
  const pieces = [
    encoder.encode(data({ choices: [{ delta: { content: "Half a sc" } }] })),
    encoder.encode(data({ choices: [{ delta: { reasoning_content: "SECRET-THOUGHTS" } }] })),
  ];
  let step = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step < pieces.length) controller.enqueue(pieces[step++]);
      else controller.error(new TypeError("network error"));
    },
  }), { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req-4711" } });
}

async function ask(reply: ProviderReply, request: AiRequest = ASK) {
  const fixture = compatible("a");
  const fake = createFakeProvider(endpointsOf([fixture]), reply, [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  useSettingsStore.setState({ settings: settingsOf([fixture]) });
  const outcome = await createBrowserAi().complete(request).then((response) => ({ response, error: undefined as unknown }), (error: unknown) => ({ response: undefined, error }));
  return { fake, fixture, ...outcome };
}

const everythingStored = () => JSON.stringify(entries()) + JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])));

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
  setFallbackAcknowledgementAccountScope(null);
  useUiStore.setState({ debugOpen: false });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  assertProvidersClean();
  await i18n.changeLanguage("en");
});

describe("the transport of a call, in the history of the debug panel", () => {
  it("keeps the figures of a stream that was cut and how it ended, and not a word of what had arrived", async () => {
    const { error } = await ask(() => cutStream());
    expect(error).toBeInstanceOf(AiStreamInterruptedError);
    expect((error as AiStreamInterruptedError).partialText).toBe("Half a sc");
    expect((error as AiStreamInterruptedError).transport?.tail).toContain("Half a sc");
    const [entry] = entries();
    expect(entry.status).toBe("error");
    expect(entry.transport).toMatchObject({ status: 200, end: "reset", usageReceived: false, usageRequested: true, requestId: "req-4711", events: 2, chunks: 2 });
    expect(entry.transport?.bytes).toBeGreaterThan(40);
    expect(entry.transport?.silentMs).toBeGreaterThanOrEqual(0);
    expect(entry.transport?.lastChunkAfterMs).toBeGreaterThanOrEqual(0);
    expect(entry.transport).not.toHaveProperty("tail");
    expect(entry.transport).not.toHaveProperty("partialText");
    for (const forbidden of ["Half a sc", "SECRET-THOUGHTS", "network error"]) expect(everythingStored()).not.toContain(forbidden);
  });

  it("keeps the figures of a call that worked too, and says that the provider sent no tokens when it did not", async () => {
    const worked = await ask(() => eventStream([data({ choices: [{ delta: { content: "A whole scene." } }] }), data({ choices: [{ delta: {}, finish_reason: "stop" }] }), data({ choices: [], usage: USAGE }), DONE]));
    expect(worked.error).toBeUndefined();
    expect(entries()[0].transport).toMatchObject({ status: 200, end: "done", usageReceived: true, usageRequested: true, finishReason: "stop" });
    useLlmDebugStore.setState({ entries: [], pending: 0 });
    const silent = await ask(() => eventStream([data({ choices: [{ delta: { content: "A whole scene." } }] }), data({ choices: [{ delta: {}, finish_reason: "stop" }] }), DONE]));
    expect(silent.error).toBeUndefined();
    expect(entries()[0].transport).toMatchObject({ end: "done", usageReceived: false });
  });
});

describe("what the store lets in of the transport", () => {
  const base: Omit<LlmDebugEntry, "id" | "at" | "status"> = { kind: "chat", model: "gpt-4o" };
  const kept = (transport: unknown) => redactLlmDebugEntry({ ...base, id: "e", at: Date.now(), status: "error", transport } as LlmDebugEntry).transport;

  it("keeps figures, flags, the end of the stream and the id of the request", () => {
    const transport = { status: 200, bytes: 25_088, chunks: 118, events: 120, lastChunkAfterMs: 42_000, silentMs: 98_000, end: "reset", finishReason: "length", usageReceived: false, usageRequested: true, requestId: "0b7f0a52-6f0e-4a9e" };
    expect(kept(transport)).toEqual(transport);
  });

  it("never keeps the end of the stream, the reply or anything it is not asked to: only what it knows, and only when it is valid", () => {
    const stored = kept({ status: 200, tail: "data: {\"content\":\"words of the model\"}", partialText: "Half a sc", extra: "no", bytes: -4, chunks: "7", end: "exploded", finishReason: "<script>", requestId: "bad id with spaces", usageReceived: "yes" });
    expect(stored).toEqual({ status: 200 });
    expect(kept({ tail: "words" })).toBeUndefined();
    expect(kept("nothing")).toBeUndefined();
    expect(kept({ status: 99 })).toBeUndefined();
  });

  it("keeps an entry that an earlier version saved as it was: it has no transport", () => {
    const entry = redactLlmDebugEntry({ ...base, id: "old", at: 1, status: "done" });
    expect(entry).not.toHaveProperty("transport");
  });
});

describe("the badges of the transport", () => {
  const entry = (status: LlmDebugEntry["status"], transport: LlmDebugEntry["transport"]): LlmDebugEntry => ({ id: "e", at: 1, kind: "chat", model: "m", status, transport });
  const ids = (item: LlmDebugEntry) => attemptBadges(item, "en").map((badge) => badge.id);
  const cut = { status: 200, bytes: 25_088, chunks: 118, events: 120, lastChunkAfterMs: 42_000, silentMs: 98_000, end: "reset", finishReason: "length", usageReceived: false, usageRequested: true, requestId: "req-4711" } as const;

  it("says everything of a call that failed: how much came, when the last piece did, how it ended, how the provider ended the reply, the tokens and the request", () => {
    expect(ids(entry("error", cut))).toEqual(["received", "lastChunk", "streamEnd", "finishReason", "usage", "requestId"]);
    const badges = Object.fromEntries(attemptBadges(entry("error", cut), "en").map((badge) => [badge.id, badge]));
    expect(badges.received).toEqual({ id: "received", key: "debug.attempt.received", params: { size: "24.5 KB", chunks: "118", status: "200" } });
    expect(badges.lastChunk.params).toEqual({ after: "42 s", silent: "98 s" });
    expect(badges.streamEnd.key).toBe("debug.attempt.end.reset");
    expect(badges.usage.key).toBe("debug.attempt.usageMissing");
  });

  it("says a response that carried nothing, a provider that was not asked for the tokens, and tokens that it reported", () => {
    expect(attemptBadges(entry("error", { status: 200, bytes: 0, chunks: 0, events: 0, usageReceived: false, usageRequested: true }), "en")[0]).toMatchObject({ key: "debug.attempt.receivedNothing", params: { status: "200" } });
    expect(attemptBadges(entry("error", { ...cut, usageRequested: false }), "en").find((badge) => badge.id === "usage")?.key).toBe("debug.attempt.usageNotAsked");
    expect(attemptBadges(entry("error", { ...cut, usageReceived: true }), "en").find((badge) => badge.id === "usage")?.key).toBe("debug.attempt.usageReported");
  });

  it("says of a call that worked only that the tokens were not reported: its figures are then an estimate", () => {
    expect(ids(entry("done", { status: 200, bytes: 900, chunks: 9, events: 9, end: "done", finishReason: "stop", usageReceived: false, usageRequested: true }))).toEqual(["usage"]);
    expect(ids(entry("done", { status: 200, bytes: 900, chunks: 9, events: 9, end: "done", finishReason: "stop", usageReceived: true, usageRequested: true }))).toEqual([]);
  });

  it("says nothing for an entry without a transport, or for a request that is not a chat", () => {
    expect(ids({ id: "e", at: 1, kind: "chat", model: "m", status: "error" })).toEqual([]);
    expect(attemptBadges({ ...entry("error", cut), kind: "image" }, "en")).toEqual([]);
  });
});

describe("the panel", () => {
  const failed: LlmDebugEntry = {
    id: "e1", at: Date.now(), endedAt: Date.now() + 1500, kind: "chat", label: "autopilot:scene", model: "fine", provider: "openai", status: "error",
    transport: { status: 200, bytes: 25_088, chunks: 118, events: 120, lastChunkAfterMs: 42_000, silentMs: 98_000, end: "reset", finishReason: "length", usageReceived: false, usageRequested: true, requestId: "req-4711" },
  };
  const open = (entry: LlmDebugEntry) => {
    useLlmDebugStore.setState({ entries: [entry], pending: 0 });
    useUiStore.setState({ debugOpen: true });
    return render(<LlmDebugPanel />);
  };

  it.each([
    ["en", ["Received 24.5 KB in 118 chunks (HTTP 200)", "Last chunk 42 s into the call, 98 s before it ended", "Stream: the connection was lost", "Finish reason: length", "Tokens: the provider sent none (estimated)", "Request id: req-4711"]],
    ["it", ["Ricevuti 24,5 KB in 118 pezzi (HTTP 200)", "Ultimo pezzo 42 s dopo l'inizio, 98 s prima della fine", "Stream: connessione persa", "Motivo di fine: length", "Token: il provider non li ha comunicati (stimati)", "ID richiesta: req-4711"]],
  ] as const)("tells what the transport saw of a call that failed, in words (%s)", async (language, words) => {
    await i18n.changeLanguage(language);
    open(failed);
    const list = within(screen.getByRole("list", { name: t("debug.attempt.title") }));
    for (const text of words) expect(list.getByText(text)).toBeInTheDocument();
  });
});

describe("the two catalogues of the transport facts", () => {
  const KEYS = ["received", "receivedNothing", "lastChunk", "end.done", "end.closed", "end.reset", "end.error", "end.timeout", "finishReason", "usageReported", "usageMissing", "usageNotAsked", "requestId"];
  const params = { size: "1 KB", chunks: 3, status: 200, after: "1 s", silent: "2 s", reason: "stop", id: "r1" };

  it.each(["en", "it"] as const)("say the same words, so that the debug panel and the error panel of the autopilot never disagree (%s)", async (language) => {
    await loadAutopilotTranslations();
    await i18n.changeLanguage(language);
    for (const key of KEYS) {
      const debug = t(`debug.attempt.${key}`, params);
      expect(debug, key).not.toBe(`debug.attempt.${key}`);
      expect(t(`autopilot.failure.transport.${key}`, params), key).toBe(debug);
    }
  });
});
