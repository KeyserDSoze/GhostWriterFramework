import { DEFAULT_AZURE_API_VERSION, type AiIntegrationConfig } from "./config.js";
import type { AiCandidate } from "./router.js";
import { forcedToolChoice } from "./structured.js";
import { completionTokenLimit, isReasoningModel, requestOutputLimit } from "./token-limit.js";
import { AiProviderError, type AiJsonSchema, type AiRequest } from "./types.js";

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

interface RequestTarget {
  url: string;
  headers: Record<string, string>;
}

function azureV1(integration: Pick<AiIntegrationConfig, "provider" | "endpoint">): boolean {
  return integration.provider === "azure_openai" && /\/openai\/v1$/i.test(trimBase(integration.endpoint));
}

function requestTarget(integration: AiIntegrationConfig, model: string, githubModelsBaseUrl: string): RequestTarget {
  const key = (integration.apiKey ?? "").trim();
  const base = effectiveAiBase(integration, githubModelsBaseUrl);
  if (integration.provider === "azure_openai") {
    if (!base) throw new AiProviderError(`Azure OpenAI integration "${integration.name}" has no endpoint.`);
    const url = azureV1(integration)
      ? `${base}/chat/completions`
      : `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(integration.apiVersion || DEFAULT_AZURE_API_VERSION)}`;
    return { url, headers: key ? { "api-key": key } : {} };
  }
  if (base && (integration.provider === "github_models" || integration.provider === "openai")) {
    return { url: `${base}/chat/completions`, headers: key ? { authorization: `Bearer ${key}` } : {} };
  }
  throw new AiProviderError(`Provider ${integration.provider} cannot run chat tasks outside Microsoft 365.`);
}

function jsonInstruction(schema: AiJsonSchema): string {
  return `Reply with ONLY one JSON object, without code fences or commentary, matching this JSON schema (${schema.name}: ${schema.description}):\n${JSON.stringify(schema.parameters)}`;
}

/** One chat completion request exactly as it goes on the wire. */
export interface ChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The reply arrives as server-sent events. */
  stream: boolean;
  /** The structured reply is requested as a forced function call; otherwise the JSON schema travels in the system prompt. */
  useTools: boolean;
  /** The output token limit the body asks for (`undefined`: none). */
  outputLimit?: number;
}

export interface ChatRequestOptions {
  /** Origin of GitHub Models (or of a proxy forwarding `/inference`). */
  githubModelsBaseUrl?: string;
}

/**
 * The only place a chat request is built: URL, headers, body, streaming and tool use for every provider and model
 * family, so that every host (browser and server) sends the same request for the same book and configuration.
 * Pure: it calls nothing and changes nothing. Throws only when the integration cannot be called at all.
 */
export function buildChatRequest(
  candidate: Pick<AiCandidate, "integration" | "model"> & Partial<Pick<AiCandidate, "underlyingModel" | "supportsToolCalls" | "maxOutputTokens">>,
  request: Pick<AiRequest, "system" | "user" | "json" | "maxOutputTokens" | "outputBoost" | "temperature" | "onText">,
  options: ChatRequestOptions = {},
): ChatRequest {
  const { integration, model } = candidate;
  const target = requestTarget(integration, model, options.githubModelsBaseUrl ?? GITHUB_MODELS_BASE_URL);
  const useTools = Boolean(request.json) && candidate.supportsToolCalls !== false;
  const stream = Boolean(request.onText) && !request.json;
  const system = request.json && !useTools ? `${request.system}\n\n${jsonInstruction(request.json)}` : request.system;
  const outputLimit = requestOutputLimit(request, candidate);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: request.user },
    ],
    ...completionTokenLimit(integration.provider, model, outputLimit, candidate.underlyingModel, azureV1(integration) ? "v1" : integration.apiVersion),
  };
  if (request.temperature !== undefined && !isReasoningModel(integration.provider, model, candidate.underlyingModel)) body.temperature = request.temperature;
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
  };
}
