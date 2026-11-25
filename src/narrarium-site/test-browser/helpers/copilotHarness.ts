import { vi } from "vitest";
// The Copilot loads the engine's client with its first call; a test that moves a virtual clock must not wait for a module to be read, so it is already there.
import "@/autopilot/browserAi";
import { setFallbackAcknowledgementAccountScope } from "@/assistant/fallbackDisclosure";
import type { LlmMessage } from "@/assistant/llm";
import { useCostsStore } from "@/costs/costsStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";
import { DEFAULT_SETTINGS, type AppSettings, type ChatCapability, type RoutingTarget } from "@/types/settings";
import { endpointsOf, GITHUB_TOKEN, settingsOf, type Fixture } from "./aiFixtures";
import { createFakeProvider, data, DONE, streamedReply, textReply, toolReply, USAGE, type FakeProvider, type ProviderCall, type ProviderReply } from "./fakeProvider";
import { resetCosts } from "./costs";

/** What the Copilot sends: its system prompt, and the message of the author, which is always parts (text, and the images that were attached). */
export const MESSAGES: LlmMessage[] = [
  { role: "system", content: "You are the Copilot." },
  { role: "user", content: [{ type: "text", text: "Write a line." }] },
];

export const target = (fixture: Fixture, thinking?: RoutingTarget["thinking"]): RoutingTarget => ({ integrationId: fixture.integration.id, model: fixture.integration.chatModels![0].name, ...(thinking ? { thinking } : {}) });

/** The route of a task through these integrations: the first is the primary, the others its fallbacks, in order. */
export function routeOf(capability: ChatCapability, fixtures: Fixture[], extra: Partial<AppSettings> = {}): AppSettings {
  const [primary, ...fallbacks] = fixtures;
  return settingsOf(fixtures, { taskRouting: { [capability]: { primary: target(primary), fallbacks: fallbacks.map((fixture) => target(fixture)) } }, ...extra });
}

/** A `fetch` that plays these providers, in place of the real one, and records every call. */
export function provide(fixtures: Fixture[], reply: ProviderReply): FakeProvider {
  const fake = createFakeProvider(endpointsOf(fixtures), reply, [GITHUB_TOKEN]);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

/** What a provider that serves both ways answers: the events to a request that asks for a stream, and a JSON body to one that does not. */
export const either = (events: () => Response, body: () => Response) => (call: ProviderCall): Response => (call.body?.stream ? events() : body());

/** A text reply, in whichever way the request asks for it. */
export const speak = (text: string, usage: object | null = USAGE) => either(() => streamedReply(text, usage), () => textReply(text, usage));

/** A forced call with these arguments, in whichever way the request asks for it. */
export const speakCall = (value: unknown, usage: object | null = USAGE, name = "result") => either(
  () => {
    const arguments_ = JSON.stringify(value);
    const middle = Math.max(1, Math.floor(arguments_.length / 2));
    return new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
        send(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: arguments_.slice(0, middle) } }] } }] }));
        send(data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: arguments_.slice(middle) } }] } }] }));
        send(data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
        if (usage) send(data({ choices: [], usage }));
        send(DONE);
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  },
  () => (name === "result" ? toolReply(value, usage) : Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }], ...(usage ? { usage } : {}) })),
);

/** The host a request went to: `a` for `https://a.example.test/v1/…`. */
export const hostOf = (url: string) => new URL(url).hostname.replace(".example.test", "");
export const hostsOf = (fake: FakeProvider) => fake.calls.map((call) => hostOf(call.url));

/** The stores that the debug panel and the costs read, empty, and the account of the tests: no account, as a browser that is not signed in. */
export function resetStores(): void {
  localStorage.clear();
  useLlmDebugStore.setState({ entries: [], pending: 0, storageError: null, accountIdentity: null });
  resetCosts({ bookId: "book-1", bookName: "The Glass Harbor" });
  setFallbackAcknowledgementAccountScope(null);
}

export const entries = () => useLlmDebugStore.getState().entries;
export const ledger = () => useCostsStore.getState().file.books["book-1"];
export const failure = (promise: Promise<unknown>): Promise<any> => promise.then(() => undefined, (error: unknown) => error);

export { DEFAULT_SETTINGS };

// ─── Replies that take time, on the clock of the test (`vi.useFakeTimers()`) ───────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export interface DripOptions {
  /** The request's signal: a real `fetch` fails its body when it aborts, and so does this. */
  signal: AbortSignal | null;
  /** How many pieces the reply has, and the time between two of them. The first comes at once, the last stream event after `pieces * everyMs`. */
  pieces: number;
  everyMs: number;
  /** What each piece is: a piece of the text of the reply, or a piece of the arguments of the function that the model calls (`args` is cut into `pieces`). */
  as?: "text" | "call";
  piece?: (index: number) => string;
  args?: string;
  /** The name of the function that the model calls (`result`). */
  name?: string;
  finish?: string;
  usage?: object | null;
}

/** A streamed reply that begins at once and goes on for as long as `pieces * everyMs` says: a model that is alive and slow. */
export function drip(options: DripOptions): Response {
  const { pieces, everyMs, as = "text" } = options;
  const parts = as === "call" ? split(options.args ?? "{\"ok\":true}", pieces) : [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => { if (!closed) controller.enqueue(encoder.encode(chunk)); };
      const stop = () => { closed = true; if (timer !== undefined) clearTimeout(timer); };
      const end = () => {
        send(data({ choices: [{ delta: {}, finish_reason: options.finish ?? (as === "call" ? "tool_calls" : "stop") }] }));
        if (options.usage !== null) send(data({ choices: [], usage: options.usage ?? USAGE }));
        send(DONE);
        stop();
        controller.close();
      };
      const emit = (index: number) => {
        if (as === "call") {
          const first = index === 0;
          send(data({ choices: [{ delta: { tool_calls: [{ index: 0, ...(first ? { id: "call_1", type: "function" } : {}), function: { ...(first ? { name: options.name ?? "result" } : {}), arguments: parts[index] } }] } }] }));
        } else {
          send(data({ choices: [{ delta: { content: options.piece ? options.piece(index) : `piece ${index + 1}. ` } }] }));
        }
      };
      let index = 0;
      const tick = () => {
        if (closed) return;
        if (index < pieces) {
          emit(index);
          index += 1;
          timer = setTimeout(tick, everyMs);
        } else {
          end();
        }
      };
      options.signal?.addEventListener("abort", () => { stop(); try { controller.error(options.signal?.reason); } catch { /* already closed */ } }, { once: true });
      tick();
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function split(text: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / count));
  const parts = Array.from({ length: count }, (_, index) => text.slice(index * size, (index + 1) * size));
  return parts;
}

/** A stream that delivers these events and then loses the connection, as a flaky node or a tunnel cuts it: the events are read, and the next read fails. */
export function cutsAfter(...events: string[]): Response {
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < events.length) controller.enqueue(encoder.encode(events[next++]));
      else controller.error(new TypeError("network error"));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A reply that begins with one piece of text and then loses the connection. */
export const cutsOff = (piece = "Half a li"): Response => cutsAfter(data({ choices: [{ delta: { content: piece } }] }));

/** A reply that begins with one piece of text and then sends nothing at all, for as long as the request lives. */
export function goesSilent(signal: AbortSignal | null, piece = "A beginning. "): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(data({ choices: [{ delta: { content: piece } }] })));
      signal?.addEventListener("abort", () => { try { controller.error(signal.reason); } catch { /* already closed */ } }, { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A whole reply (not streamed) that comes after `ms`, and a request that is abandoned before then does not get it. */
export function after(ms: number, make: () => Response, signal: AbortSignal | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(make()), ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** A failure that comes after `ms`: a provider that took its time and then said no. */
export const failAfter = (ms: number, make: () => Response, signal: AbortSignal | null) => after(ms, make, signal);
