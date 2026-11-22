import { vi } from "vitest";
import { createFakeProvider, hang, type FakeProvider, type ProviderCall } from "./fakeProvider";
import type { Fixture } from "./aiFixtures";

// The payloads of LlmProxy's contract (its docs/api-contract.md) with the values of the owner's gateway: the same as the engine's own tests
// (packages/engine/test/catalog-fakes.mjs). Nothing here is a secret: the key belongs to the fixture, and only the guard of the fake provider looks for it.

const KINDS = {
  chat: { surface: "OpenAi", endpoints: ["/v1/chat/completions", "/v1/responses"], input: ["text"], output: ["text"] },
  image: { surface: "ImageGeneration", endpoints: ["/v1/images/generations"], input: ["text"], output: ["image"] },
  speech: { surface: "SpeechSynthesis", endpoints: ["/v1/audio/speech"], input: ["text"], output: ["audio"] },
  transcription: { surface: "AudioTranscription", endpoints: ["/v1/audio/transcriptions", "/v1/audio/translations"], input: ["audio"], output: ["text"] },
  embedding: { surface: "Embedding", endpoints: ["/v1/embeddings"], input: ["text"], output: ["embedding"] },
  realtime: { surface: "Realtime", endpoints: ["/v1/realtime"], input: ["audio", "text"], output: ["audio", "text"] },
  classifier: { surface: "SystemOne", endpoints: ["/v1/systemone"], input: ["text"], output: ["text"] },
} as const;
type Kind = keyof typeof KINDS;

const capabilities = (value: boolean) => ({ streaming: value, tools: value, vision: value, reasoning: value });

/** One entry of `GET /v1/models/details`: `null` for what the administrator has not declared, `false` for every capability that is not declared. */
export function detail(id: string, type: Kind, extra: Record<string, unknown> = {}) {
  const kind = KINDS[type];
  return {
    id, object: "model", created: 0, owned_by: "llmproxy", type, llmproxy_surface: kind.surface,
    context_window: null, max_output_tokens: null, input_modalities: kind.input, output_modalities: kind.output, endpoints: kind.endpoints,
    capabilities: capabilities(false), ...extra,
  };
}

/** `muse-glimmer-30b`: the real values the owner gave. */
export const MUSE = detail("muse-glimmer-30b", "chat", { context_window: 131072, max_output_tokens: 8192, input_modalities: ["text", "image"], capabilities: capabilities(true) });
/** Another model of the same gateway: everything `false` and `null` (not declared). */
export const LEGACY = detail("legacy-8b", "chat");
export const BGE = detail("bge-m3", "embedding", { context_window: 8192 });
export const FLUX = detail("flux-schnell", "image");
export const KOKORO = detail("kokoro", "speech");
export const WHISPER = detail("whisper-large", "transcription");

export const OWNER_ENTRIES = [MUSE, LEGACY, BGE, FLUX, KOKORO, WHISPER];
export const OWNER_IDS = OWNER_ENTRIES.map((entry) => entry.id);
/** `GET /v1/models`. */
export const OWNER_MODELS = { object: "list", data: OWNER_IDS.map((id) => ({ id, object: "model", created: 0, owned_by: "llmproxy" })) };
/** `GET /v1/models/details`. */
export const OWNER_DETAILS = { object: "list", data: OWNER_ENTRIES };
const group = (type: Kind, models: Array<ReturnType<typeof detail>>) => ({
  type, llmproxy_surface: KINDS[type].surface, endpoints: KINDS[type].endpoints, input_modalities: KINDS[type].input, output_modalities: KINDS[type].output,
  model_count: models.length, models: models.map((model) => ({ id: model.id, type, capabilities: model.capabilities })),
});
/** `GET /v1/modalities`: the seven types, always in this order, the ones with nothing running included. */
export const OWNER_MODALITIES = {
  object: "list",
  data: [group("chat", [LEGACY, MUSE]), group("image", [FLUX]), group("speech", [KOKORO]), group("transcription", [WHISPER]), group("embedding", [BGE]), group("realtime", []), group("classifier", [])],
};

/** What a fake gateway does. A payload of `null` is a companion that the gateway does not have (404); `undefined` is the owner's. */
export interface GatewayBehavior {
  models?: unknown;
  details?: unknown;
  modalities?: unknown;
  /** One error status for every path: a wrong key (401, 403), a wrong address (404), a gateway that is busy (429, 503). */
  status?: number;
  /** The connection fails, as a server that is off, or one that CORS does not let through, looks to a browser. */
  unreachable?: boolean;
  /** Never answers: it only ends when the request is aborted. */
  hang?: boolean;
  /** Milliseconds that pass before it answers, on the clock of the test (which must be mocked: `vi.useFakeTimers({ toFake: ["Date"] })`): what the engine measures as the latency. */
  elapse?: number;
}

/**
 * A `fetch` that plays LlmProxy for one integration and records every call: `GET <base>/models`, `/models/details` and `/modalities`. It is also the security guard of
 * `fakeProvider.ts`: the key may be only in the authorization header of a request to this integration. Call `assertProvidersClean()` after the test.
 */
export function gateway(fixture: Fixture, behavior: GatewayBehavior = {}): FakeProvider {
  const reply = (call: ProviderCall): Response | Promise<Response> => {
    if (behavior.unreachable) throw new TypeError("Failed to fetch");
    if (behavior.hang) return hang(call.signal);
    if (behavior.elapse) vi.setSystemTime(new Date(Date.now() + behavior.elapse));
    if (behavior.status) return new Response(JSON.stringify({ error: { message: "refused" } }), { status: behavior.status, headers: { "content-type": "application/json" } });
    const path = call.url.slice(fixture.endpoint.base.length);
    const payload = path === "/models" ? behavior.models ?? OWNER_MODELS
      : path === "/models/details" ? (behavior.details === undefined ? OWNER_DETAILS : behavior.details)
      : path === "/modalities" ? (behavior.modalities === undefined ? OWNER_MODALITIES : behavior.modalities)
      : undefined;
    if (payload === undefined || payload === null) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return Response.json(payload);
  };
  return createFakeProvider([fixture.endpoint], reply);
}

/** The paths a fake gateway was asked, without the base: `["/models", "/models/details", "/modalities"]`. */
export const pathsAsked = (provider: FakeProvider, fixture: Fixture) => provider.calls.map((call) => call.url.slice(fixture.endpoint.base.length));
