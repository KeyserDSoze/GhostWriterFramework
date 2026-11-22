import type { AiChatModelConfig, AiThinking } from "./config.js";

// What an endpoint says of its models, read from the three places a gateway like LlmProxy says it (and from LM Studio's own list). Pure: no I/O, no clock.
// Everything that comes in is data from a server nobody vouches for: it is bounded, validated field by field, never trusted for what it is called, and
// never quoted in an error. The limits are those of BookWriter (`fetchModels` and `tokenLimitsFromDetails`: 2000 models, 256 characters, windows from 256 to
// 10 000 000 tokens) and, for LM Studio's list, those of its `lmstudio-models.ts` (500 models, 200 characters).

/** The most models a list may hold: a longer one is refused (`GET /models`) or cut here (`/models/details`, `/modalities`). */
export const CATALOG_MAX_MODELS = 2_000;
/** The longest id of a model. */
export const CATALOG_MAX_ID_LENGTH = 256;
/** A window or an answer that is declared is a whole number of tokens within these limits; anything else is not declared. */
export const CATALOG_MIN_TOKENS = 256;
export const CATALOG_MAX_TOKENS = 10_000_000;
/** LM Studio's list: how many models and how long a key are read. */
export const LMSTUDIO_MAX_MODELS = 500;
export const LMSTUDIO_MAX_KEY_LENGTH = 200;

const MAX_MODALITY_GROUPS = 32;
const MAX_MODALITIES = 16;
const MAX_MODALITY_LENGTH = 32;
const MAX_ENDPOINTS = 16;
const MAX_ENDPOINT_LENGTH = 120;
const MAX_LOADED_INSTANCES = 16;
const MAX_MODEL_COUNT = 1_000_000;
/** A list that claims more entries than this is read only as far as it is needed: an array this long costs nothing to ask for its length, and a lot to walk. */
const MAX_WALKED = 4 * CATALOG_MAX_MODELS;

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MODALITY_WORD = /^[a-z0-9_-]{1,32}$/;

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Why the models of an endpoint could not be read. `unreachable`: no answer (the server is off, the address is wrong, a redirect was refused, or, in a
 * browser, CORS blocked the request: the browser cannot tell them apart). `timeout`: it did not answer, or stopped answering, in time. `unauthorized`:
 * 401 or 403, the key. `not-found`: 404, no list at this address. `rate-limited`: 429. `server-error`: 5xx. `http-error`: any other status. `invalid`:
 * the answer is not a list of models. `empty`: it is one, and has no model in it. `too-large`: more models, or more bytes, than may be read.
 * `unsupported`: the integration has no list to read (Azure OpenAI, GitHub Models, Microsoft 365).
 */
export type AiCatalogErrorReason = "unreachable" | "timeout" | "unauthorized" | "not-found" | "rate-limited" | "server-error" | "http-error" | "invalid" | "empty" | "too-large" | "unsupported";

/**
 * The models of an endpoint could not be read, or what it sent is not a catalog. The message is in English, says why and what to do, and never quotes
 * what the endpoint sent or the key that was used. `status` is the HTTP status, for the reasons that come from one.
 */
export class AiCatalogError extends Error {
  constructor(message: string, readonly reason: AiCatalogErrorReason, readonly status?: number) {
    super(message);
    this.name = "AiCatalogError";
  }
}

const NOT_A_LIST = "The answer is not a list of models in the OpenAI format ({\"data\": [{\"id\": …}]}). Check that the address is the API base (for example …/v1), or enter the model names by hand.";
const EMPTY_LIST = "The list of models is empty. If this is a gateway, start a model there (a model that is stopped is not listed), or enter the model names by hand.";
const LONG_LIST = `The list has more than ${CATALOG_MAX_MODELS} models: it is too large to be read. Enter the model names by hand.`;
const PAGED_LIST = "The list of models comes in pages and only the first one was sent, so it cannot be read whole. Enter the model names by hand.";

const invalid = (): AiCatalogError => new AiCatalogError(NOT_A_LIST, "invalid");

// ─── Reading what is untrusted ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An id as it is kept: a text with no spaces at its edges, no control character, not too long, and not the name of a prototype. */
function validId(value: unknown, longest = CATALOG_MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= longest && value === value.trim() && !CONTROL.test(value) && !FORBIDDEN.has(value);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= CATALOG_MIN_TOKENS && value <= CATALOG_MAX_TOKENS ? value : undefined;
}

/** The `data` of a list as OpenAI writes it. Anything that is not an object with an array in it is not a list. */
function listOf(payload: unknown): unknown[] {
  if (!isRecord(payload)) throw invalid();
  const data = payload.data;
  if (!Array.isArray(data)) throw invalid();
  return data;
}

/** Runs a parser of one entry: whatever the entry is (a proxy, a getter that throws), the answer is "it is not an entry". */
function guarded<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

// ─── What a model is ────────────────────────────────────────────────────────

/** The kinds of model a gateway tells apart (LlmProxy: `GET /v1/models/details`, `GET /v1/modalities`). */
export const AI_MODEL_TYPES = ["chat", "image", "speech", "transcription", "embedding", "realtime", "classifier"] as const;
/** A kind of model, or `unknown` for one that is not said or is not one of these. */
export type AiModelType = (typeof AI_MODEL_TYPES)[number] | "unknown";

/** What a gateway declares a model can do. A capability that is not said is absent; `false` is what LlmProxy sends for everything its administrator has not declared. */
export interface AiModelCapabilities {
  streaming?: boolean;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

/** One model of an endpoint, as its catalog says it. Every field but `id`, `type` and `capabilities` is absent when it is not declared: never a 0, never a guess. */
export interface AiModelCatalogEntry {
  id: string;
  type: AiModelType;
  /** The longest prompt plus answer one request may use (`context_window`), in tokens. */
  contextWindow?: number;
  /** The largest answer to ask for (`max_output_tokens`), in tokens. */
  maxOutputTokens?: number;
  /** What the model accepts and returns: short words such as `text`, `image`, `audio`, `embedding`. */
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities: AiModelCapabilities;
}

/** The models of one way of use (a type), with what they offer together: one entry of `GET /v1/modalities`. */
export interface AiModalityGroup {
  type: AiModelType;
  /** The paths this kind of model is called at (`/v1/chat/completions`, `/v1/images/generations`…). */
  endpoints: string[];
  /** What the running models of the type accept and return together. */
  inputModalities?: string[];
  outputModalities?: string[];
  /** How many models run for it, as the gateway counts them; a type that is offered and has nothing running has 0 and no models. */
  modelCount: number;
  models: AiModelCatalogEntry[];
}

function typeOf(value: unknown): AiModelType {
  if (typeof value !== "string") return "unknown";
  const word = value.trim().toLowerCase();
  return (AI_MODEL_TYPES as readonly string[]).includes(word) ? word as AiModelType : "unknown";
}

/** A list of modalities: short lower-case words, a few of them, each once. `undefined` when there is none. */
function modalitiesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const words: string[] = [];
  for (let index = 0; index < Math.min(value.length, MAX_WALKED) && words.length < MAX_MODALITIES; index += 1) {
    const raw = value[index];
    if (typeof raw !== "string") continue;
    const word = raw.trim().toLowerCase();
    if (MODALITY_WORD.test(word) && word.length <= MAX_MODALITY_LENGTH && !FORBIDDEN.has(word) && !words.includes(word)) words.push(word);
  }
  return words.length ? words : undefined;
}

/** The paths a type of model is called at: short, starting with a slash, no space or control character, a few of them, each once. */
function endpointsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (let index = 0; index < Math.min(value.length, MAX_WALKED) && paths.length < MAX_ENDPOINTS; index += 1) {
    const raw = value[index];
    if (typeof raw === "string" && raw.startsWith("/") && raw.length <= MAX_ENDPOINT_LENGTH && !/[\s\u0000-\u001f\u007f-\u009f]/.test(raw) && !paths.includes(raw)) paths.push(raw);
  }
  return paths;
}

function capabilitiesOf(value: unknown): AiModelCapabilities {
  if (!isRecord(value)) return {};
  const streaming = value.streaming;
  const tools = value.tools;
  const vision = value.vision;
  const reasoning = value.reasoning;
  return {
    ...(typeof streaming === "boolean" ? { streaming } : {}),
    ...(typeof tools === "boolean" ? { tools } : {}),
    ...(typeof vision === "boolean" ? { vision } : {}),
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
  };
}

/** One entry of `/models/details`, or of a `/modalities` group (whose type a model without one takes). */
function entryOf(raw: unknown, groupType?: AiModelType): AiModelCatalogEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw.id;
  if (!validId(id)) return undefined;
  const own = typeOf(raw.type);
  const type = own === "unknown" && groupType ? groupType : own;
  const contextWindow = tokenCount(raw.context_window);
  const maxOutputTokens = tokenCount(raw.max_output_tokens);
  const inputModalities = modalitiesOf(raw.input_modalities);
  const outputModalities = modalitiesOf(raw.output_modalities);
  return {
    id,
    type,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    capabilities: capabilitiesOf(raw.capabilities),
  };
}

/** The entries of a list, the first of each id, at most `CATALOG_MAX_MODELS` of the entries that were sent. What is no entry is left out. */
function entriesOf(data: unknown, groupType?: AiModelType): AiModelCatalogEntry[] {
  const entries: AiModelCatalogEntry[] = [];
  if (!Array.isArray(data)) return entries;
  const seen = new Set<string>();
  for (let index = 0; index < Math.min(data.length, CATALOG_MAX_MODELS); index += 1) {
    const entry = guarded(() => entryOf(data[index], groupType));
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

// ─── GET /models ────────────────────────────────────────────────────────────

/**
 * The ids of an OpenAI `GET /models` list, sorted and without repeats. It is all or nothing, as BookWriter reads it: a payload that is not a list, an
 * entry that is not an object with a good id, a list with nothing in it or with more than `CATALOG_MAX_MODELS` models is an `AiCatalogError`, so that
 * an answer that is wrong never replaces a catalog that was right. So is a list that says it goes on (`has_more: true`, the pagination of OpenAI-style
 * lists, which Anthropic's `/v1/models` uses: 20 to a page): its first page is not the catalog, and nothing here follows the pages. The error never
 * quotes the payload.
 */
export function parseModelList(payload: unknown): string[] {
  try {
    const data = listOf(payload);
    if ((payload as { has_more?: unknown }).has_more === true) throw new AiCatalogError(PAGED_LIST, "too-large");
    if (data.length === 0) throw new AiCatalogError(EMPTY_LIST, "empty");
    if (data.length > CATALOG_MAX_MODELS) throw new AiCatalogError(LONG_LIST, "too-large");
    const ids = new Set<string>();
    for (const entry of data) {
      const id = isRecord(entry) ? entry.id : undefined;
      if (!validId(id)) throw invalid();
      ids.add(id);
    }
    return [...ids].sort();
  } catch (error) {
    throw error instanceof AiCatalogError ? error : invalid();
  }
}

// ─── GET /models/details ────────────────────────────────────────────────────

/**
 * The models of LlmProxy's `GET /models/details`, in the order received: for each, its kind, the window and the answer it declares, what it accepts
 * and returns, and what it can do. What is `null`, out of scale, or not what it should be is absent; an entry that cannot be one is left out; at most
 * `CATALOG_MAX_MODELS` entries are read. A payload that is not a list is an `AiCatalogError`; a list with nothing in it is a list with nothing in it.
 */
export function parseModelDetails(payload: unknown): AiModelCatalogEntry[] {
  let data: unknown[];
  try {
    data = listOf(payload);
  } catch {
    throw invalid();
  }
  return entriesOf(data);
}

// ─── GET /modalities ────────────────────────────────────────────────────────

/**
 * What LlmProxy's `GET /modalities` says: for each way of use, in the order the gateway lists them, the paths it is called at, what its models
 * accept and return together, and the models that run for it. A model with no kind of its own is of the kind of its group. At most 32 groups, and
 * `CATALOG_MAX_MODELS` models in each, are read. A payload that is not a list is an `AiCatalogError`.
 */
export function parseModalities(payload: unknown): AiModalityGroup[] {
  let data: unknown[];
  try {
    data = listOf(payload);
  } catch {
    throw invalid();
  }
  const groups: AiModalityGroup[] = [];
  for (let index = 0; index < Math.min(data.length, MAX_WALKED) && groups.length < MAX_MODALITY_GROUPS; index += 1) {
    const group = guarded((): AiModalityGroup | undefined => {
      const raw = data[index];
      if (!isRecord(raw)) return undefined;
      const type = typeOf(raw.type);
      const models = entriesOf(raw.models, type);
      const count = raw.model_count;
      const modelCount = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= MAX_MODEL_COUNT ? count : models.length;
      const inputModalities = modalitiesOf(raw.input_modalities);
      const outputModalities = modalitiesOf(raw.output_modalities);
      return {
        type,
        endpoints: endpointsOf(raw.endpoints),
        ...(inputModalities ? { inputModalities } : {}),
        ...(outputModalities ? { outputModalities } : {}),
        modelCount,
        models,
      };
    });
    if (group) groups.push(group);
  }
  return groups;
}

// ─── What the numbers mean for the engine ───────────────────────────────────

/** The limits of a model as BookWriter keeps them: `inputTokens` is the window minus the answer, and `outputTokens` the answer. */
export interface AiTokenLimits {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * BookWriter's formula (`tokenLimitsFromDetails`): the input is the window minus the answer the model declares, or, when it declares none, minus a
 * quarter of the window up to 4096; an answer with no window is only the answer; an answer that is not smaller than its window is not believed; and an
 * input that is not a usable number of tokens (it would be 0 or negative, or under 256) is not said.
 *
 * Mind what it is: BookWriter's `inputTokens` is what is left for the prompt once the answer is taken off. The engine's `maxInputTokens` is the window
 * itself (the engine takes the answer and a safety margin off it when it judges a prompt), so it is the declared `contextWindow` that goes there,
 * never this number: use `modelFieldsFromCatalogEntry`, which does.
 */
export function tokenLimitsFromDetails(entry: Pick<AiModelCatalogEntry, "contextWindow" | "maxOutputTokens"> | null | undefined): AiTokenLimits {
  const source: Record<string, unknown> = isRecord(entry) ? entry : {};
  const window = tokenCount(source.contextWindow);
  const answer = tokenCount(source.maxOutputTokens);
  const output = answer !== undefined && (window === undefined || answer < window) ? answer : undefined;
  const input = window === undefined ? undefined : window - (output ?? Math.min(4096, Math.floor(window / 4)));
  return {
    ...(input !== undefined && tokenCount(input) !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

/** What a catalog entry can fill in a model of the configuration. */
export type AiCatalogModelFields = Partial<Pick<AiChatModelConfig, "maxInputTokens" | "maxOutputTokens" | "supportsToolCalls" | "supportsStreaming" | "supportsReasoning" | "supportsVision">>;

/**
 * What a gateway declares of a model, as fields of the model in the configuration, for the models of kind `chat`. Only what is declared is said:
 * the context window is `maxInputTokens` (the window, not BookWriter's input: see `tokenLimitsFromDetails`), the answer is `maxOutputTokens` (when it fits the
 * window), and a capability is said only when it is `true`. A capability that is `false` is what LlmProxy sends for everything its administrator has not
 * declared, so it is never turned into a restriction (a model that streams, with the box not ticked, must go on streaming); and an id that only
 * `/models` listed says nothing at all. The author's own values are kept by the caller: `{ ...model, ...fields }` lets the gateway's declarations win for
 * what it declares, and leaves the rest as it is.
 */
export function modelFieldsFromCatalogEntry(entry: AiModelCatalogEntry): AiCatalogModelFields {
  const source: Record<string, unknown> = isRecord(entry) ? entry : {};
  const window = tokenCount(source.contextWindow);
  const { outputTokens } = tokenLimitsFromDetails(entry);
  const capabilities = capabilitiesOf(source.capabilities);
  return {
    ...(window !== undefined ? { maxInputTokens: window } : {}),
    ...(outputTokens !== undefined ? { maxOutputTokens: outputTokens } : {}),
    ...(capabilities.tools === true ? { supportsToolCalls: true } : {}),
    ...(capabilities.streaming === true ? { supportsStreaming: true } : {}),
    ...(capabilities.reasoning === true ? { supportsReasoning: true } : {}),
    ...(capabilities.vision === true ? { supportsVision: true } : {}),
  };
}

// ─── LM Studio: GET /api/v1/models ──────────────────────────────────────────

type ThinkingLevel = Exclude<AiThinking, "automatic">;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];

/** The levels of thinking a model allows (in the engine's own order), and the one it uses when none is chosen. */
export interface AiLmStudioReasoning {
  options: ThinkingLevel[];
  default?: ThinkingLevel;
}

/** One language model of LM Studio, as its own list says it. */
export interface AiLmStudioModel {
  key: string;
  /**
   * The levels of thinking the model declares. `null`: the server says the model has no level to choose (what it allows is not low, medium, high or
   * xhigh). Absent: the server said nothing of reasoning for this model.
   */
  reasoning?: AiLmStudioReasoning | null;
  /** The longest context the model supports. */
  maxContext?: number;
  /** The instances that are loaded now, with the context each was loaded with. */
  loaded: Array<{ id: string; contextLength?: number }>;
}

/**
 * The language models (`type: "llm"`) of LM Studio's `GET /api/v1/models`, as BookWriter reads them: the thinking levels each declares
 * (`capabilities.reasoning.allowed_options`, of which only low, medium, high and xhigh are levels), its default, the context it supports and the one
 * it loaded. At most `LMSTUDIO_MAX_MODELS` entries are read. A payload that is not a list of models is an `AiCatalogError`.
 */
export function parseLmStudioModels(payload: unknown): AiLmStudioModel[] {
  let models: unknown[];
  try {
    const list = isRecord(payload) ? payload.models : undefined;
    if (!Array.isArray(list)) throw invalid();
    models = list;
  } catch {
    throw invalid();
  }
  const result: AiLmStudioModel[] = [];
  for (let index = 0; index < Math.min(models.length, LMSTUDIO_MAX_MODELS); index += 1) {
    const model = guarded((): AiLmStudioModel | undefined => {
      const raw = models[index];
      if (!isRecord(raw) || raw.type !== "llm" || typeof raw.key !== "string") return undefined;
      const key = raw.key.trim();
      if (!validId(key, LMSTUDIO_MAX_KEY_LENGTH)) return undefined;
      const maxContext = tokenCount(raw.max_context_length);
      const instances = Array.isArray(raw.loaded_instances) ? raw.loaded_instances : [];
      const loaded: AiLmStudioModel["loaded"] = [];
      for (let at = 0; at < Math.min(instances.length, MAX_WALKED) && loaded.length < MAX_LOADED_INSTANCES; at += 1) {
        const instance = instances[at];
        if (!isRecord(instance) || !validId(instance.id, LMSTUDIO_MAX_KEY_LENGTH)) continue;
        const contextLength = tokenCount(isRecord(instance.config) ? instance.config.context_length : undefined);
        loaded.push({ id: instance.id, ...(contextLength !== undefined ? { contextLength } : {}) });
      }
      let reasoning: AiLmStudioReasoning | null | undefined;
      // No block of capabilities is a server that said nothing: the levels stay unknown.
      if (isRecord(raw.capabilities)) {
        const declared = isRecord(raw.capabilities.reasoning) ? raw.capabilities.reasoning : undefined;
        const allowed = declared && Array.isArray(declared.allowed_options) ? declared.allowed_options : [];
        const options = THINKING_LEVELS.filter((level) => allowed.includes(level));
        const preferred = declared?.default;
        reasoning = options.length
          ? { options: [...options], ...(typeof preferred === "string" && (options as readonly string[]).includes(preferred) ? { default: preferred as ThinkingLevel } : {}) }
          : null;
      }
      return {
        key,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(maxContext !== undefined ? { maxContext } : {}),
        loaded,
      };
    });
    if (model) result.push(model);
  }
  return result;
}

/**
 * The context of one LM Studio model, found as BookWriter finds it: by its key or by the id of one of its loaded instances; `loaded` is the context
 * of that instance (else of the first one) and `max` the longest the model supports. `undefined` for a model the list does not have.
 */
export function lmStudioContext(models: readonly AiLmStudioModel[], modelId: string): { loaded?: number; max?: number } | undefined {
  for (const model of models) {
    const instance = model.loaded.find((entry) => entry.id === modelId);
    if (model.key !== modelId && !instance) continue;
    const chosen = instance ?? model.loaded[0];
    return {
      ...(chosen?.contextLength !== undefined ? { loaded: chosen.contextLength } : {}),
      ...(model.maxContext !== undefined ? { max: model.maxContext } : {}),
    };
  }
  return undefined;
}
