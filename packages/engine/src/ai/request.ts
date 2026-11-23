import { DEFAULT_AZURE_API_VERSION, normalizeThinking, type AiIntegrationConfig, type AiReasoningParameter, type AiThinking } from "./config.js";
import type { AiCandidate } from "./router.js";
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

interface RequestTarget {
  url: string;
  headers: Record<string, string>;
}

function azureV1(integration: Pick<AiIntegrationConfig, "provider" | "endpoint">): boolean {
  return integration.provider === "azure_openai" && /\/openai\/v1$/i.test(trimBase(integration.endpoint));
}

/** How an integration authenticates: its key, in the header its provider expects (none for an endpoint that needs no key). */
function authHeaders(integration: Pick<AiIntegrationConfig, "provider" | "apiKey">): Record<string, string> {
  const key = (integration.apiKey ?? "").trim();
  if (!key) return {};
  return integration.provider === "azure_openai" ? { "api-key": key } : { authorization: `Bearer ${key}` };
}

function requestTarget(integration: AiIntegrationConfig, model: string, githubModelsBaseUrl: string): RequestTarget {
  const base = effectiveAiBase(integration, githubModelsBaseUrl);
  if (integration.provider === "azure_openai") {
    if (!base) throw new AiProviderError(`Azure OpenAI integration "${integration.name}" has no endpoint.`);
    const url = azureV1(integration)
      ? `${base}/chat/completions`
      : `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(integration.apiVersion || DEFAULT_AZURE_API_VERSION)}`;
    return { url, headers: authHeaders(integration) };
  }
  if (base && (integration.provider === "github_models" || integration.provider === "openai")) {
    return { url: `${base}/chat/completions`, headers: authHeaders(integration) };
  }
  throw new AiProviderError(`Provider ${integration.provider} cannot run chat tasks outside Microsoft 365.`);
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

/** The content of a message as the OpenAI API takes it: text as it is, a part of text as a text part and an image as an `image_url` with its data URL. */
function wireContent(content: AiMessage["content"]): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image_url" as const, image_url: { url: part.dataUrl } }));
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
export function applyReasoningLevel(body: Record<string, unknown>, parameter: AiReasoningParameter | undefined, level: AiReasoningEffort): void {
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
 * not know and no level at all send nothing: `automatic` is a choice, so it is not overridden by the integration's level.
 */
export function reasoningEffortOf(candidate: Pick<AiCandidate, "integration"> & Partial<Pick<AiCandidate, "thinking" | "supportsReasoning" | "reasoningParameter">>): AiReasoningEffort | undefined {
  return candidate.supportsReasoning === false || candidate.reasoningParameter === "none" ? undefined : requestedEffort(candidate);
}

/** One chat completion request exactly as it goes on the wire. */
export interface ChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The reply is asked for as server-sent events: every request, the forced function included, unless the integration's `streamMode` is `off` or the model declares it does not stream. */
  stream: boolean;
  /** The structured reply is requested as a forced function call; otherwise the JSON schema travels in the system prompt. */
  useTools: boolean;
  /** The output token limit the body asks for (`undefined`: none). */
  outputLimit?: number;
  /** The thinking level the body carries, as `reasoning_effort` or, when `reasoningParameter` says so, as the chat-template argument; absent when none is sent. */
  thinking?: AiReasoningEffort;
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
  candidate: Pick<AiCandidate, "integration" | "model"> & Partial<Pick<AiCandidate, "underlyingModel" | "supportsToolCalls" | "supportsStreaming" | "supportsReasoning" | "reasoningParameter" | "maxOutputTokens" | "thinking">>,
  request: Pick<AiRequest, "system" | "user" | "messages" | "json" | "maxOutputTokens" | "outputBoost" | "temperature" | "onText">,
  options: ChatRequestOptions = {},
): ChatRequest {
  const { integration, model } = candidate;
  const target = requestTarget(integration, model, options.githubModelsBaseUrl ?? GITHUB_MODELS_BASE_URL);
  const useTools = Boolean(request.json) && candidate.supportsToolCalls !== false;
  // What the integration turns off a model does not turn on; what a model declares it cannot do is not asked of it.
  const stream = integration.streamMode !== "off" && candidate.supportsStreaming !== false;
  const notes: string[] = [];
  if (integration.streamMode !== "off" && !stream) notes.push(`Streaming was not used: "${model}" is declared as not streaming (supportsStreaming is off).`);
  const messages = conversationOf(request, request.json && !useTools ? jsonInstruction(request.json) : undefined);
  const outputLimit = requestOutputLimit(request, candidate);
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((message) => ({ role: message.role, content: wireContent(message.content) })),
    ...completionTokenLimit(integration.provider, model, outputLimit, candidate.underlyingModel, azureV1(integration) ? "v1" : integration.apiVersion),
  };
  if (request.temperature !== undefined && !isReasoningModel(integration.provider, model, candidate.underlyingModel)) body.temperature = request.temperature;
  const thinking = reasoningEffortOf(candidate);
  if (thinking) applyReasoningLevel(body, candidate.reasoningParameter, thinking);
  const asked = requestedEffort(candidate);
  if (asked && !thinking) {
    notes.push(candidate.reasoningParameter === "none"
      ? `The thinking level "${asked}" was not sent: "${model}" has its thinking parameter set to "none".`
      : `The thinking level "${asked}" was not sent: "${model}" is declared as not reasoning (supportsReasoning is off).`);
  }
  if (useTools && request.json) {
    body.tools = [{ type: "function", function: request.json }];
    body.tool_choice = forcedToolChoice(integration.provider, integration.apiVersion, request.json.name);
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return {
    url: target.url,
    headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...target.headers },
    body,
    stream,
    useTools,
    ...(outputLimit ? { outputLimit } : {}),
    ...(thinking ? { thinking } : {}),
    ...(thinking && candidate.reasoningParameter === CHAT_TEMPLATE_PARAMETER ? { reasoningParameter: CHAT_TEMPLATE_PARAMETER } : {}),
    ...(notes.length ? { notes } : {}),
  };
}
