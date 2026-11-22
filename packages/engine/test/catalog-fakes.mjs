// Shared fakes of the catalog tests: the payloads of LlmProxy's contract (/root/projects/LlmProxy/docs/api-contract.md), the values of the
// owner's gateway, and a fake `fetch` that serves them. Nothing here is a secret: the key is the fixture's, and only the tests look for it.

import { integration } from "./transport-fakes.mjs";

export const KEY = "sk-test-SECRET-0123456789";
export { integration };

// ─── What the contract shows ────────────────────────────────────────────────

/** `GET /v1/models`, as the contract shows it. */
export const MODELS_EXAMPLE = {
  object: "list",
  data: [{ id: "agic-code-fast", object: "model", created: 0, owned_by: "llmproxy" }],
};

/** `GET /v1/models/details`, as the contract shows it. (The gateway also sends `type`; the contract's example leaves it out.) */
export const DETAILS_EXAMPLE = {
  object: "list",
  data: [{
    id: "muse",
    object: "model",
    created: 0,
    owned_by: "llmproxy",
    llmproxy_surface: "OpenAi",
    context_window: 131072,
    max_output_tokens: 8192,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    endpoints: ["/v1/chat/completions", "/v1/responses"],
    capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
  }],
};

/** `GET /v1/modalities`, as the contract shows it. */
export const MODALITIES_EXAMPLE = {
  object: "list",
  data: [
    {
      type: "chat",
      llmproxy_surface: "OpenAi",
      endpoints: ["/v1/chat/completions", "/v1/responses"],
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      model_count: 2,
      models: [{ id: "agic-code-fast", type: "chat", capabilities: { streaming: true } }],
    },
    { type: "image", endpoints: ["/v1/images/generations"], model_count: 0, models: [] },
  ],
};

// ─── The owner's gateway, shaped as LlmProxy's `ModelDetails.cs` writes it ───

const KINDS = {
  chat: { surface: "OpenAi", endpoints: ["/v1/chat/completions", "/v1/responses"], input: ["text"], output: ["text"] },
  image: { surface: "ImageGeneration", endpoints: ["/v1/images/generations"], input: ["text"], output: ["image"] },
  speech: { surface: "SpeechSynthesis", endpoints: ["/v1/audio/speech"], input: ["text"], output: ["audio"] },
  transcription: { surface: "AudioTranscription", endpoints: ["/v1/audio/transcriptions", "/v1/audio/translations"], input: ["audio"], output: ["text"] },
  embedding: { surface: "Embedding", endpoints: ["/v1/embeddings"], input: ["text"], output: ["embedding"] },
  realtime: { surface: "Realtime", endpoints: ["/v1/realtime"], input: ["audio", "text"], output: ["audio", "text"] },
  classifier: { surface: "SystemOne", endpoints: ["/v1/systemone"], input: ["text"], output: ["text"] },
};

const capabilities = (value) => ({ streaming: value, tools: value, vision: value, reasoning: value });

/** One entry of `GET /v1/models/details`: `null` for what the administrator has not declared, `false` for every capability that is not declared. */
export function detail(id, type, extra = {}) {
  const kind = KINDS[type];
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "llmproxy",
    type,
    llmproxy_surface: kind.surface,
    context_window: null,
    max_output_tokens: null,
    input_modalities: kind.input,
    output_modalities: kind.output,
    endpoints: kind.endpoints,
    capabilities: capabilities(false),
    ...extra,
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

export const OWNER_IDS = [MUSE, LEGACY, BGE, FLUX, KOKORO, WHISPER].map((entry) => entry.id);
export const OWNER_MODELS = { object: "list", data: OWNER_IDS.map((id) => ({ id, object: "model", created: 0, owned_by: "llmproxy" })) };
export const OWNER_DETAILS = { object: "list", data: [MUSE, LEGACY, BGE, FLUX, KOKORO, WHISPER] };

const group = (type, models) => {
  const kind = KINDS[type];
  return { type, llmproxy_surface: kind.surface, endpoints: kind.endpoints, input_modalities: type === "chat" && models.some((model) => model.capabilities.vision) ? ["text", "image"] : kind.input, output_modalities: kind.output, model_count: models.length, models };
};
/** `GET /v1/modalities`: the seven types, always in this order, the ones with nothing running included. */
export const OWNER_MODALITIES = {
  object: "list",
  data: [
    group("chat", [LEGACY, MUSE]),
    group("image", [FLUX]),
    group("speech", [KOKORO]),
    group("transcription", [WHISPER]),
    group("embedding", [BGE]),
    group("realtime", []),
    group("classifier", []),
  ],
};

// ─── LM Studio: `GET /api/v1/models` ────────────────────────────────────────

export const LMSTUDIO_MODELS = {
  models: [
    {
      type: "llm",
      publisher: "qwen",
      key: "qwen/qwen3-4b",
      display_name: "Qwen3 4B",
      architecture: "qwen3",
      size_bytes: 2497281536,
      loaded_instances: [{ id: "qwen/qwen3-4b", config: { context_length: 8192, flash_attention: true } }],
      max_context_length: 262144,
      format: "gguf",
      capabilities: { vision: false, trained_for_tool_use: true, reasoning: { allowed_options: ["off", "on"], default: "on" } },
    },
    {
      type: "llm",
      publisher: "openai",
      key: "openai/gpt-oss-20b",
      loaded_instances: [],
      max_context_length: 131072,
      capabilities: { vision: false, trained_for_tool_use: true, reasoning: { allowed_options: ["high", "low", "medium"], default: "medium" } },
    },
    { type: "embedding", key: "text-embedding-nomic-embed-text-v1.5", max_context_length: 2048 },
    { type: "llm", key: "plain-model", max_context_length: 4096 },
  ],
};

// ─── A fake gateway ─────────────────────────────────────────────────────────

export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A `fetch` that serves `routes` (the path of the request → a value that is sent as JSON, a `Response`, or a function of the call that returns
 * either) and keeps every call. A path with no route answers 404 in the OpenAI envelope.
 */
export function gateway(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const entry = { url: String(url), path, init, headers: init.headers ?? {} };
    calls.push(entry);
    const route = routes[path];
    if (route === undefined) return json({ error: { message: "No such route.", type: "invalid_request_error", code: "not_found" } }, 404);
    const answer = typeof route === "function" ? await route(entry, calls.length) : route;
    return answer instanceof Response ? answer : json(answer);
  };
  return { fetch, calls };
}

/** The gateway of the owner: the three endpoints, each serving what LlmProxy serves. */
export const ownerGateway = (extra = {}) => gateway({ "/v1/models": OWNER_MODELS, "/v1/models/details": OWNER_DETAILS, "/v1/modalities": OWNER_MODALITIES, ...extra });

/** The integration of the owner's gateway: an OpenAI-compatible endpoint named LlmProxy. */
export const llmProxy = (extra = {}) => integration({ endpoint: "http://llm.test/v1", ...extra });
