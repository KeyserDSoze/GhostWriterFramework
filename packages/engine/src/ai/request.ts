import { addressPath, effectiveApiVersion, effectiveResponsesApiVersion, isAzureV1Endpoint, normalizeApiProtocol, normalizeEndpointUrl, normalizeThinking, type AiApiProtocol, type AiIntegrationConfig, type AiNoThinkingWithTools, type AiReasoningParameter, type AiThinking } from "./config.js";
import type { AiCandidate } from "./router.js";
import { promptCacheHintFor, promptCacheKey, type PromptCacheHint } from "./prompt-cache.js";
import { forcedToolChoice } from "./structured.js";
import { completionTokenLimit, isReasoningModel, requestOutputLimit } from "./token-limit.js";
import { AiProviderError, type AiContentPart, type AiJsonSchema, type AiMessage, type AiRequest } from "./types.js";

export const GITHUB_MODELS_BASE_URL = "https://models.github.ai";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

function trimBase(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/**
 * Origin and path every request of an integration starts with, defaults included: the endpoint of an OpenAI-compatible
 * or Azure OpenAI integration, `https://api.openai.com/v1` for OpenAI without one, `<origin>/inference` for GitHub
 * Models. (Azure appends `/openai/deployments/<model>` to a plain endpoint.) `null` when requests cannot be built.
 * A host that approves where API keys may be sent compares these bases, not just origins.
 */
export function effectiveAiBase(integration: Pick<AiIntegrationConfig, "provider" | "endpoint">, githubModelsBaseUrl: string = GITHUB_MODELS_BASE_URL): string | null {
  if (integration.provider === "azure_openai") return trimBase(integration.endpoint) || null;
  if (integration.provider === "github_models") return `${trimBase(githubModelsBaseUrl)}/inference`;
  if (integration.provider === "openai") return trimBase(integration.endpoint) || OPENAI_BASE_URL;
  return null;
}

/**
 * The origin (`https://host:port`) of a web address, and nothing else: never its path, its query, its fragment or the credentials in
 * it, which is what may be shown and saved about where a request went. `undefined` for anything that is not an http or https address.
 */
export function endpointOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a trail says of where a candidate's requests go, as far as it may be shown and saved: the origin of the address (the model's own address when it has one, else the base of its integration), the path of
 * the model's own address (never its query: it may hold a key), and `responses` when the model is asked through the Responses API (Chat Completions is what no word means).
 */
export function candidateDestination(
  candidate: { integration: Pick<AiIntegrationConfig, "provider" | "endpoint"> } & { endpointUrl?: unknown; apiProtocol?: unknown },
  githubModelsBaseUrl?: string,
): { endpoint?: string; path?: string; protocol?: "responses" } {
  const own = normalizeEndpointUrl(candidate.endpointUrl);
  const endpoint = endpointOrigin(own ?? effectiveAiBase(candidate.integration, githubModelsBaseUrl));
  const path = own ? addressPath(own) : undefined;
  return { ...(endpoint ? { endpoint } : {}), ...(path ? { path } : {}), ...(normalizeApiProtocol(candidate.apiProtocol) ? { protocol: "responses" as const } : {}) };
}

/** The address a candidate's requests go to, as an attempt reports it: the base of its integration, or the model's own address without its query (and never a key). */
export function candidateEndpoint(candidate: { integration: Pick<AiIntegrationConfig, "provider" | "endpoint"> } & { endpointUrl?: unknown }, githubModelsBaseUrl?: string): string | null {
  const own = normalizeEndpointUrl(candidate.endpointUrl);
  if (!own) return effectiveAiBase(candidate.integration, githubModelsBaseUrl);
  return `${endpointOrigin(own) ?? ""}${addressPath(own) ?? ""}` || null;
}

interface RequestTarget {
  url: string;
  headers: Record<string, string>;
}

function azureV1(integration: Pick<AiIntegrationConfig, "provider" | "endpoint">): boolean {
  return integration.provider === "azure_openai" && isAzureV1Endpoint(integration.endpoint);
}

/** How an integration authenticates: its key, in the header its provider expects (none for an endpoint that needs no key). */
function authHeaders(integration: Pick<AiIntegrationConfig, "provider" | "apiKey">): Record<string, string> {
  const key = (integration.apiKey ?? "").trim();
  if (!key) return {};
  return integration.provider === "azure_openai" ? { "api-key": key } : { authorization: `Bearer ${key}` };
}

/**
 * The address of a request of a protocol, built from the integration, and what authenticates it. `apiVersion` is what an Azure OpenAI address carries as its `api-version`: `effectiveApiVersion(integration, model)`
 * for Chat Completions, `effectiveResponsesApiVersion` for the Responses API. A model with an address of its own (`endpointUrl`) is sent exactly there, as it was written, with the key of its integration.
 */
function requestTarget(integration: AiIntegrationConfig, model: string, githubModelsBaseUrl: string, apiVersion: string | undefined, protocol: AiApiProtocol = "chat-completions", endpointUrl?: string): RequestTarget {
  if (endpointUrl) return { url: endpointUrl, headers: authHeaders(integration) };
  const base = effectiveAiBase(integration, githubModelsBaseUrl);
  const responses = protocol === "responses";
  if (integration.provider === "azure_openai") {
    if (!base) throw new AiProviderError(`Azure OpenAI integration "${integration.name}" has no endpoint.`);
    // The v1 API has one address for every model and no version; the older API has the deployment in the address of Chat Completions, and `/openai/responses` for the Responses API (the model is in the body).
    const url = azureV1(integration)
      ? `${base}/${responses ? "responses" : "chat/completions"}`
      : responses
        ? `${base}/openai/responses?api-version=${encodeURIComponent(apiVersion ?? "")}`
        : `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion ?? "")}`;
    return { url, headers: authHeaders(integration) };
  }
  if (integration.provider === "github_models" && responses) {
    throw new AiProviderError(`GitHub Models integration "${integration.name}" has no Responses API: its models are asked through Chat Completions. Set the model to Chat Completions, or give it an address of its own.`);
  }
  if (base && (integration.provider === "github_models" || integration.provider === "openai")) {
    return { url: `${base}/${responses ? "responses" : "chat/completions"}`, headers: authHeaders(integration) };
  }
  throw new AiProviderError(`Provider ${integration.provider} cannot run chat tasks outside Microsoft 365.`);
}

/** The protocol a model is asked through: `responses` when it says so, else Chat Completions. */
export function effectiveApiProtocol(model?: { apiProtocol?: unknown } | null): AiApiProtocol {
  return normalizeApiProtocol(model?.apiProtocol) ?? "chat-completions";
}

/** Where the requests of a model go, as the client builds the address: `url`, the protocol, the API version it carries (none for an address of the model's own, and for a provider that has none) and whether the address is the model's own. */
export interface ModelRequestTarget {
  protocol: AiApiProtocol;
  url: string;
  apiVersion?: string;
  own: boolean;
}

/** Why an address cannot be built: the integration has no endpoint, its provider has no Responses API (GitHub Models), or it cannot run chat tasks here at all. */
export type ModelRequestTargetProblem = "no-endpoint" | "no-responses-api" | "provider-unsupported";

/**
 * Where the requests of a model go and how they are asked, as the client builds them: the protocol, the address (the model's own, exactly as written, or the one built from its integration), and the API version
 * the address carries. It is what an editor shows of a model, and the one rule the client follows. `model` is the model's entry or a candidate. When no address can be built (the integration has no endpoint, or
 * its provider has no Responses API), it says why instead.
 */
export function modelRequestTarget(
  integration: AiIntegrationConfig,
  model: { name: string; apiVersion?: string; apiProtocol?: unknown; endpointUrl?: unknown },
  options: { githubModelsBaseUrl?: string } = {},
): ModelRequestTarget | { problem: ModelRequestTargetProblem } {
  const protocol = effectiveApiProtocol(model);
  const own = normalizeEndpointUrl(model.endpointUrl);
  const versionOf = protocol === "responses" ? effectiveResponsesApiVersion : effectiveApiVersion;
  const apiVersion = versionOf(integration, { apiVersion: model.apiVersion, ...(own ? { endpointUrl: own } : {}) });
  try {
    return { protocol, url: requestTarget(integration, model.name, options.githubModelsBaseUrl ?? GITHUB_MODELS_BASE_URL, apiVersion, protocol, own).url, ...(apiVersion ? { apiVersion } : {}), own: Boolean(own) };
  } catch {
    if (integration.provider === "github_models" && protocol === "responses") return { problem: "no-responses-api" };
    return { problem: integration.provider === "azure_openai" ? "no-endpoint" : "provider-unsupported" };
  }
}

/**
 * Where a request for the models of an OpenAI-compatible integration goes (`path` is `/models`, `/models/details`, `/modalities`), and how it
 * authenticates: the very base that its chat requests use (`effectiveAiBase`: the endpoint it was given, or OpenAI's own) and the same key header.
 * `null` for an integration that has no such list to read: Azure OpenAI (a deployment is created by hand, nobody lists them), GitHub Models (its
 * catalog is not at this address) and Microsoft 365.
 */
export function catalogTarget(integration: Pick<AiIntegrationConfig, "provider" | "endpoint" | "apiKey">, path: string): { url: string; headers: Record<string, string> } | null {
  if (integration.provider !== "openai") return null;
  const base = effectiveAiBase(integration);
  return base ? { url: `${base}${path}`, headers: authHeaders(integration) } : null;
}

function jsonInstruction(schema: AiJsonSchema): string {
  return `Reply with ONLY one JSON object, without code fences or commentary, matching this JSON schema (${schema.name}: ${schema.description}):\n${JSON.stringify(schema.parameters)}`;
}

/** A message as the engine keeps it for a request: a copy, so that nothing built from it can change the one the host gave. */
function copyMessage(message: AiMessage): AiMessage {
  return { role: message.role, content: typeof message.content === "string" ? message.content : message.content.map((part): AiContentPart => ({ ...part })) };
}

/**
 * What is sent, in the engine's own form: the messages the host gave (the conversation of the Copilot), or, for a host that has none, the system prompt and the user prompt,
 * as it always was. The JSON instruction of a model without tool calls goes into the first system message (as one more part when its content is parts), or into a system
 * message of its own placed first when there is none. Always copies.
 */
function conversationOf(request: Pick<AiRequest, "system" | "user" | "messages">, instruction: string | undefined): AiMessage[] {
  if (!request.messages?.length) {
    return [{ role: "system", content: instruction ? `${request.system}\n\n${instruction}` : request.system }, { role: "user", content: request.user }];
  }
  const messages = request.messages.map(copyMessage);
  if (!instruction) return messages;
  const at = messages.findIndex((message) => message.role === "system");
  if (at < 0) return [{ role: "system", content: instruction }, ...messages];
  const system = messages[at];
  messages[at] = { role: "system", content: typeof system.content === "string" ? `${system.content}\n\n${instruction}` : [...system.content, { type: "text", text: instruction }] };
  return messages;
}

/** A message as the engine builds it for a request, whichever protocol it is sent through: text, or parts of text and `image_url` with a data URL (the form of Chat Completions; the Responses API's `input` is made from it). */
export interface ChatWireMessage {
  role: AiMessage["role"];
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}

/** The content of a message as the OpenAI API takes it: text as it is, a part of text as a text part and an image as an `image_url` with its data URL. */
function wireContent(content: AiMessage["content"]): ChatWireMessage["content"] {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image_url" as const, image_url: { url: part.dataUrl } }));
}

/** A part of text that an Anthropic model is told to cache up to (`cache_control`), or an image. */
type CachedWirePart = { type: "text"; text: string; cache_control?: { type: "ephemeral" } } | { type: "image_url"; image_url: { url: string } };

/** Anthropic takes four cache breakpoints in a request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * The messages as an Anthropic model takes them (`cache_control` on the blocks that end the start of the prompt that stays the same): the system message, then every part a host marked
 * (`cacheBreak`), and the character of `user` where its stable start ends. The words are the ones that were going to be sent; only their blocks are cut, and a prompt that marks nothing is
 * sent exactly as it was but for its system message. No block is empty, because a provider refuses an empty block with a `cache_control`.
 */
function cacheControlled(source: readonly AiMessage[], userBreak: number | undefined): Array<{ role: AiMessage["role"]; content: string | CachedWirePart[] }> {
  let left = MAX_CACHE_BREAKPOINTS;
  const mark = (part: CachedWirePart): CachedWirePart => {
    if (left <= 0 || part.type !== "text" || !part.text) return part;
    left -= 1;
    return { ...part, cache_control: { type: "ephemeral" } };
  };
  const lastUser = source.reduce((found, message, index) => (message.role === "user" ? index : found), -1);
  let systemDone = false;
  return source.map((message, index) => {
    if (typeof message.content === "string") {
      if (message.role === "system" && !systemDone) {
        systemDone = true;
        return { role: message.role, content: message.content ? [mark({ type: "text", text: message.content })] : message.content };
      }
      if (index === lastUser && userBreak !== undefined && userBreak > 0 && userBreak < message.content.length) {
        return { role: message.role, content: [mark({ type: "text", text: message.content.slice(0, userBreak) }), { type: "text", text: message.content.slice(userBreak) }] };
      }
      return { role: message.role, content: message.content };
    }
    const first = message.role === "system" && !systemDone;
    if (first) systemDone = true;
    const lastText = first ? message.content.reduce((found, part, at) => (part.type === "text" && part.text ? at : found), -1) : -1;
    return {
      role: message.role,
      content: message.content.map((part, at): CachedWirePart => {
        if (part.type !== "text") return { type: "image_url", image_url: { url: part.dataUrl } };
        const wire: CachedWirePart = { type: "text", text: part.text };
        return part.cacheBreak === true || at === lastText ? mark(wire) : wire;
      }),
    };
  });
}

/**
 * The messages as the Responses API takes them in `input`: the system prompt as a developer message (the way the Azure portal sends it), what the author wrote as `input_text` parts and its images as
 * `input_image` (the address of the image, a data URL here, is a string and not an object), and what the assistant said before as `output_text`, the only kind of part an assistant message may have.
 */
function responsesInput(messages: readonly ChatWireMessage[]): Array<{ role: "developer" | "user" | "assistant"; content: Array<Record<string, unknown>> }> {
  return messages.map((message) => {
    const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    return {
      role: message.role === "system" ? "developer" : message.role,
      content: parts.map((part) => (part.type === "text"
        ? { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text }
        : { type: "input_image", image_url: part.image_url.url })),
    };
  });
}

/** A function as a tool of the Responses API: flat (its name, description and parameters beside its type, not inside a `function` object), and never strict: the schemas of the engine are best effort, as they are with Chat Completions, where strict is off unless asked. */
function responsesTool(schema: AiJsonSchema): Record<string, unknown> {
  return { type: "function", name: schema.name, description: schema.description, parameters: schema.parameters, strict: false };
}

/** The thinking levels that travel to the provider (as `reasoning_effort`, or as the chat-template argument the model's `reasoningParameter` says): `automatic` and no level at all send nothing. */
export type AiReasoningEffort = Exclude<AiThinking, "automatic">;

const CHAT_TEMPLATE_PARAMETER = "chat_template_kwargs.reasoning_strength" satisfies AiReasoningParameter;

/**
 * Puts a thinking level into the body of a chat request the way the model's thinking parameter says; it is the one place where a level lands in a body.
 * `reasoning_effort` (and absent, and any word the engine does not know) is the OpenAI field. `chat_template_kwargs.reasoning_strength` is the argument of
 * the chat template, `chat_template_kwargs: { reasoning_strength: <level> }`, merged with the arguments the body already has (the object that was there is
 * not changed, and a value that is not a set of arguments is replaced); `reasoning_effort` is then not sent. `none` puts nothing in the body.
 */
export function applyReasoningLevel(body: Record<string, unknown>, parameter: AiReasoningParameter | undefined, level: AiReasoningEffort | "none"): void {
  if (parameter === "none") return;
  if (parameter === CHAT_TEMPLATE_PARAMETER) {
    const existing = body.chat_template_kwargs;
    body.chat_template_kwargs = { ...(typeof existing === "object" && existing !== null && !Array.isArray(existing) ? existing : {}), reasoning_strength: level };
    return;
  }
  body.reasoning_effort = level;
}

/** Narrow on purpose: Muse Glimmer by the names that its sources use, with an optional `meta-` before, and nothing that merely contains the words. */
const MUSE_GLIMMER = /^(?:meta[-_ ]?)?muse[-_ ]?glimmer(?![a-z])/i;

/**
 * A hint for a screen, never an order: the thinking parameter that a documented source gives the model with this name, or `undefined` for every other
 * name. Today that is Muse Glimmer, and nothing else: no other family is guessed (Muse Spark included: no source says it). For Muse Glimmer it is
 * `chat_template_kwargs.reasoning_strength`, because
 * - Meta, "Run inference" (https://dev.meta.ai/docs/muse-glimmer/deploy), for llama.cpp: «`reasoning_effort`, the OpenAI spelling, is not implemented by
 *   llama.cpp. Use `chat_template_kwargs.reasoning_strength`», per request or for the whole server; and, for ExecuTorch, `reasoning_effort` is rejected with a 400;
 * - Meta, "Prompting guide" (https://dev.meta.ai/docs/muse-glimmer/prompting#reasoning): the level is the `reasoning_strength` template argument, `xhigh`,
 *   `high`, `medium` or `low`;
 * - LlmProxy, `docs/model-profiles.md` ("Reasoning controls differ per model") and `src/LlmProxy.NodeAgent/ModelFamilyProfiles.cs` (the Muse Glimmer
 *   profile, checked on 2026-11-13).
 * The names are those that these sources use, with or without the part before the last `/` (`meta-models/`, `unsloth/`, `RadixArk/`) and a tag after the
 * name: `muse-glimmer`, `muse-glimmer-30B`, `Muse-Glimmer-30B-GGUF:Q4_K_M`, `muse-glimmer:30b-mlx` and, as LlmProxy's logs name one, `meta-muse-glimmer`.
 *
 * The engine does not apply the hint: a model is called with `reasoning_effort` until its author sets `reasoningParameter`. `underlyingModel` is the model
 * that a deployment really is, when it is declared: it is what is read then (as `isReasoningModel` does for an Azure deployment), else the name. Pure, and
 * cheap for any text.
 */
export function suggestedReasoningParameter(modelName: string, underlyingModel?: string): AiReasoningParameter | undefined {
  const declared = typeof underlyingModel === "string" ? underlyingModel.trim() : "";
  const identity = declared || (typeof modelName === "string" ? modelName.trim() : "");
  return MUSE_GLIMMER.test(identity.slice(identity.lastIndexOf("/") + 1)) ? CHAT_TEMPLATE_PARAMETER : undefined;
}

/** The level that is asked for: the candidate's own (resolved from its route target, else its integration), else its integration's. */
function requestedEffort(candidate: Pick<AiCandidate, "integration"> & Partial<Pick<AiCandidate, "thinking">>): AiReasoningEffort | undefined {
  const level = normalizeThinking(candidate.thinking) ?? normalizeThinking(candidate.integration.thinking);
  return level && level !== "automatic" ? level : undefined;
}

/**
 * The level a request carries: the one that is asked for, unless the model declares that it does not reason (`supportsReasoning: false`), which
 * is a refusal waiting to happen, or its author says that no level is sent to it (`reasoningParameter: "none"`). `automatic`, a level the engine does
 * not know and no level at all send nothing: `automatic` is a choice, so it is not overridden by the integration's level. The Responses API has
 * one field for the level (`reasoning.effort`), so a model whose level goes in the chat template (`chat_template_kwargs.reasoning_strength`) is sent none when it is asked through it.
 */
export function reasoningEffortOf(candidate: Pick<AiCandidate, "integration"> & Partial<Pick<AiCandidate, "thinking" | "supportsReasoning" | "reasoningParameter" | "apiProtocol">>): AiReasoningEffort | undefined {
  if (candidate.supportsReasoning === false || candidate.reasoningParameter === "none") return undefined;
  if (candidate.apiProtocol === "responses" && candidate.reasoningParameter === CHAT_TEMPLATE_PARAMETER) return undefined;
  return requestedEffort(candidate);
}

/**
 * What a request does of the thinking level, as a panel says it: the level that is sent; `automatic` when none is chosen (nothing is sent, and the model
 * uses its own default); `not-sent` when a level is chosen and the model does not take it (it is declared as not reasoning, or its thinking parameter is `none`).
 */
export type AiAttemptThinking = AiReasoningEffort | "none" | "automatic" | "not-sent";

/** Why the level of a request is not the one that was chosen, when it is the request that decides: it carries function tools, and the model is set (or was learned) not to think with them. */
export type AiThinkingWhy = "tools";

/** Whether `reasoning_effort: "none"` can be sent to a candidate: it takes its level in `reasoning_effort`, and is not declared as one that does not reason. */
export function canSendNone(candidate: Partial<Pick<AiCandidate, "supportsReasoning" | "reasoningParameter">>): boolean {
  return candidate.supportsReasoning !== false && (candidate.reasoningParameter === undefined || candidate.reasoningParameter === "reasoning_effort");
}

/**
 * The thinking of the request a candidate gets (see `AiAttemptThinking`): the one rule of what is sent (`reasoningEffortOf`, and, for a model that refuses a level when the request carries function tools,
 * none: the level left out, or `none` sent), told in a few words. `tools`: the request carries function tools (a forced function, a loop of tool calls).
 */
export function attemptThinking(candidate: Pick<AiCandidate, "integration"> & Partial<Pick<AiCandidate, "thinking" | "supportsReasoning" | "reasoningParameter" | "noThinkingWithTools" | "apiProtocol">>, tools = false): AiAttemptThinking {
  const off = withToolsRule(candidate);
  if (tools && off === "none" && canSendNone(candidate)) return "none";
  if (tools && off) return requestedEffort(candidate) ? "not-sent" : "automatic";
  return reasoningEffortOf(candidate) ?? (requestedEffort(candidate) ? "not-sent" : "automatic");
}

/**
 * What a model is set (or was learned) to do with its thinking level when the request carries function tools (`noThinkingWithTools`). It is a rule of Chat Completions: the Responses API takes a thinking level and function
 * tools together, so a model that is asked through it has none, whatever is set (it comes back into force if the model is set back to Chat Completions).
 */
export function withToolsRule(candidate: Partial<Pick<AiCandidate, "noThinkingWithTools" | "apiProtocol">>): AiNoThinkingWithTools | undefined {
  return candidate.apiProtocol === "responses" ? undefined : candidate.noThinkingWithTools;
}

/** One request to a chat model exactly as it goes on the wire, through Chat Completions or the Responses API (`protocol`). */
export interface ChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The protocol the request is made through: `chat-completions` (the body has `messages`), or `responses` (the body has `input`). */
  protocol: AiApiProtocol;
  /** The messages the body carries, in the engine's form (see `ChatWireMessage`), whichever protocol they are sent through: what the hooks report and the router counts. */
  messages: ChatWireMessage[];
  /** The reply is asked for as server-sent events: every request, the forced function included, unless the integration's `streamMode` is `off` or the model declares it does not stream. */
  stream: boolean;
  /** The structured reply is requested as a forced function call; otherwise the JSON schema travels in the system prompt. */
  useTools: boolean;
  /** The output token limit the body asks for (`undefined`: none). */
  outputLimit?: number;
  /** The API version the request carries (Azure OpenAI: the `api-version` of its address, or `v1`); absent for a provider that has none. */
  apiVersion?: string;
  /** The hint that helps the provider find its cache that the body carries (see `promptCacheHintFor`); absent when it carries none. */
  cacheHint?: PromptCacheHint;
  /** The thinking level the body carries, as `reasoning_effort` or, when `reasoningParameter` says so, as the chat-template argument (`none`: sent for a model that takes no other with function tools); absent when none is sent. */
  thinking?: AiReasoningEffort | "none";
  /** Why the level is not the one that was chosen, when the request is what decided it (`tools`: it carries function tools and the model refuses the level, or any, with them). Absent otherwise. */
  thinkingWhy?: AiThinkingWhy;
  /** Where the level went, when it went in the chat-template argument (`chat_template_kwargs.reasoning_strength`). Absent: it went as `reasoning_effort`, or no level was sent. */
  reasoningParameter?: "chat_template_kwargs.reasoning_strength";
  /**
   * What the request does not do that the configuration asked, because of what a model declares or says: a level of thinking that is not sent to a model that
   * does not reason or whose thinking parameter is `none`, a stream that is not asked of a model that does not stream. Absent when there is nothing to say.
   */
  notes?: string[];
}

export interface ChatRequestOptions {
  /** Origin of GitHub Models (or of a proxy forwarding `/inference`). */
  githubModelsBaseUrl?: string;
  /** The hints that help a provider find its cache are sent unless this is false (`AiRuntimeConfig.promptCacheHints`). */
  promptCacheHints?: boolean;
}

/**
 * The only place a chat request is built: URL, headers, body, streaming and tool use for every provider and model
 * family, so that every host (browser and server) sends the same request for the same book and configuration.
 * Streaming is the integration's choice (`streamMode`, `auto` unless it says `off`) and not the request's, and a model that declares it does not
 * stream (`supportsStreaming: false`) is not asked to: a structured reply streams too, as the arguments of its forced function, so that a slow
 * model is never a silent connection.
 * Pure: it calls nothing and changes nothing. Throws only when the integration cannot be called at all.
 */
export function buildChatRequest(
  candidate: Pick<AiCandidate, "integration" | "model"> & Partial<Pick<AiCandidate, "underlyingModel" | "supportsToolCalls" | "supportsStreaming" | "supportsReasoning" | "reasoningParameter" | "noThinkingWithTools" | "promptCaching" | "promptCacheHintsRefused" | "apiVersion" | "apiProtocol" | "endpointUrl" | "maxOutputTokens" | "thinking">>,
  request: Pick<AiRequest, "system" | "user" | "messages" | "json" | "maxOutputTokens" | "outputBoost" | "temperature" | "onText"> & Partial<Pick<AiRequest, "cacheKey" | "cacheBreak">>,
  options: ChatRequestOptions = {},
): ChatRequest {
  const { integration, model } = candidate;
  const protocol = effectiveApiProtocol(candidate);
  const responses = protocol === "responses";
  // The API version of the model that is asked: its own, else its integration's (for the Responses API, one that has it). A fallback in another integration, or another model, is asked with its own.
  const apiVersion = (responses ? effectiveResponsesApiVersion : effectiveApiVersion)(integration, candidate);
  const target = requestTarget(integration, model, options.githubModelsBaseUrl ?? GITHUB_MODELS_BASE_URL, apiVersion, protocol, normalizeEndpointUrl(candidate.endpointUrl));
  const useTools = Boolean(request.json) && candidate.supportsToolCalls !== false;
  // What the integration turns off a model does not turn on; what a model declares it cannot do is not asked of it.
  const stream = integration.streamMode !== "off" && candidate.supportsStreaming !== false;
  const notes: string[] = [];
  if (integration.streamMode !== "off" && !stream) notes.push(`Streaming was not used: "${model}" is declared as not streaming (supportsStreaming is off).`);
  const conversation = conversationOf(request, request.json && !useTools ? jsonInstruction(request.json) : undefined);
  const messages = conversation.map((message): ChatWireMessage => ({ role: message.role, content: wireContent(message.content) }));
  const outputLimit = requestOutputLimit(request, candidate);
  // The output limit and the thinking level are the one field each of the Responses API (`max_output_tokens`, `reasoning.effort`); Chat Completions has the parameters that its model families expect.
  const body: Record<string, unknown> = responses
    ? { model, input: responsesInput(messages), ...(outputLimit ? { max_output_tokens: outputLimit } : {}) }
    : { model, messages, ...completionTokenLimit(integration.provider, model, outputLimit, candidate.underlyingModel, apiVersion) };
  if (request.temperature !== undefined && !isReasoningModel(integration.provider, model, candidate.underlyingModel)) body.temperature = request.temperature;
  // The hint that helps the provider find the cache of an earlier request with the same start: a key for OpenAI and Azure OpenAI (when the host named the scope), the blocks that end the stable start for an Anthropic model.
  let cacheHint = options.promptCacheHints === false ? undefined : promptCacheHintFor(candidate, target.url, protocol);
  if (cacheHint === "prompt_cache_key" && request.cacheKey) body.prompt_cache_key = promptCacheKey(request.cacheKey);
  else if (cacheHint === "cache_control" && !responses) body.messages = cacheControlled(conversation, request.cacheBreak);
  else cacheHint = undefined;
  // A model that refuses a level when the request carries function tools is sent none with them, or `none` when it takes no request without a level (it keeps the level for a request without tools).
  // The Responses API takes both together, so it has no such rule (`withToolsRule`).
  const off = useTools ? withToolsRule(candidate) : undefined;
  const sendNone = off === "none" && canSendNone(candidate);
  const thinking: AiReasoningEffort | "none" | undefined = sendNone ? "none" : off ? undefined : reasoningEffortOf(candidate);
  if (thinking) {
    if (responses) body.reasoning = { effort: thinking };
    else applyReasoningLevel(body, candidate.reasoningParameter, thinking);
  }
  const asked = requestedEffort(candidate);
  const noThinkingWithTools = Boolean(off) && (sendNone || Boolean(asked));
  if (sendNone) {
    notes.push(`${asked ? `The thinking level "${asked}" was replaced by "none"` : `The level "none" was sent`}: "${model}" refuses function tools with a thinking level and without one, and takes "none" (noThinkingWithTools).`);
  } else if (asked && off) {
    notes.push(`The thinking level "${asked}" was not sent: "${model}" refuses a thinking level when the request carries function tools (noThinkingWithTools), and this one does.`);
  } else if (asked && !thinking) {
    notes.push(candidate.reasoningParameter === "none"
      ? `The thinking level "${asked}" was not sent: "${model}" has its thinking parameter set to "none".`
      : candidate.supportsReasoning === false
        ? `The thinking level "${asked}" was not sent: "${model}" is declared as not reasoning (supportsReasoning is off).`
        : `The thinking level "${asked}" was not sent: the thinking parameter of "${model}" is "${CHAT_TEMPLATE_PARAMETER}", which only Chat Completions has, and the Responses API takes the level in "reasoning.effort".`);
  }
  if (useTools && request.json) {
    // Only the one function of the reply is sent, so "required" forces it: llama.cpp and LM Studio understand it where they ignore the named form. Chat Completions of old Azure API versions only knows the named form.
    body.tools = [responses ? responsesTool(request.json) : { type: "function", function: request.json }];
    body.tool_choice = responses ? "required" : forcedToolChoice(integration.provider, apiVersion, request.json.name);
  }
  // The Responses API keeps what it answers for 30 days unless it is told not to: a manuscript is not stored.
  if (responses) body.store = false;
  if (stream) {
    body.stream = true;
    // Chat Completions sends the tokens of a stream only when asked; the Responses API always ends its stream with them.
    if (!responses) body.stream_options = { include_usage: true };
  }
  return {
    url: target.url,
    headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...target.headers },
    body,
    protocol,
    messages,
    stream,
    useTools,
    ...(apiVersion ? { apiVersion } : {}),
    ...(outputLimit ? { outputLimit } : {}),
    ...(cacheHint ? { cacheHint } : {}),
    ...(thinking ? { thinking } : {}),
    ...(noThinkingWithTools ? { thinkingWhy: "tools" as const } : {}),
    ...(thinking && candidate.reasoningParameter === CHAT_TEMPLATE_PARAMETER ? { reasoningParameter: CHAT_TEMPLATE_PARAMETER } : {}),
    ...(notes.length ? { notes } : {}),
  };
}
