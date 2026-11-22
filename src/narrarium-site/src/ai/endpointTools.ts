import { AiCatalogError, fetchModelCatalog, pickAiRuntimeConfig, probeEndpoint, redactSecrets, type AiCatalogErrorReason, type AiEndpointProbe, type AiIntegrationConfig, type AiModelCatalog } from "narrarium-engine";
import type { AIIntegration } from "@/types/settings";

/**
 * What the integration card and the panel of an error ask of an endpoint: whether it answers (`probeEndpoint`) and which models it lists, with what each declares (`fetchModelCatalog`).
 * This module is loaded when the author presses a button and not with the settings page, and it is the one place that builds the integration the engine is given: the engine
 * needs the key to ask, and the key goes only in the header of the request to the integration's own endpoint. The engine's answers never carry it, nor the address.
 */

export interface EndpointCallOptions {
  /** Cancels the call: an `AbortError`, never a result. */
  signal?: AbortSignal;
  /** Another `fetch` than the page's own (the tests'). */
  fetch?: typeof fetch;
}

/**
 * The page's own `fetch`, looked up when the call is made. The engine calls the `fetch` it is given as a method of one of its own objects when it reads a catalog, and a browser refuses
 * the bare `fetch` called that way («Illegal invocation»), which the page then shows as an endpoint that cannot be reached: the engine is given a function that calls it plainly.
 */
const pageFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/**
 * The integration as the engine takes it, made by the engine's own `pickAiRuntimeConfig` so that its endpoint, key and models read the way every other request reads them. An integration
 * that is still being written may have no id yet, and the engine skips one that has none.
 */
export function engineIntegration(integration: AIIntegration): AiIntegrationConfig {
  const [config] = pickAiRuntimeConfig({ aiIntegrations: [{ ...integration, id: integration.id || "draft" }] }).aiIntegrations;
  return config;
}

/** Whether the endpoint answers, how fast, with what status and how many models it lists. It does not throw for what the endpoint does, only for a cancel and for an integration with no list. */
export function checkEndpoint(integration: AIIntegration, options: EndpointCallOptions = {}): Promise<AiEndpointProbe> {
  return probeEndpoint(engineIntegration(integration), { ...options, fetch: options.fetch ?? pageFetch });
}

/** The models of the endpoint, of every kind, with their window, largest answer and capabilities when the gateway declares them, and which of its answers were read. */
export function readCatalog(integration: AIIntegration, options: EndpointCallOptions = {}): Promise<AiModelCatalog> {
  return fetchModelCatalog(engineIntegration(integration), { ...options, fetch: options.fetch ?? pageFetch });
}

/** Why a reading failed, for the page to say in its own words: the engine's reason, or `unknown` for a failure that is none of its own; and the engine's English message, when it has one (with the key out of it, whatever it says). */
export interface EndpointFailure {
  reason: AiCatalogErrorReason | "unknown";
  message?: string;
}

export function failureOf(error: unknown, integration?: Pick<AIIntegration, "apiKey">): EndpointFailure {
  const secrets = integration ? [integration.apiKey] : [];
  if (error instanceof AiCatalogError) return { reason: error.reason, message: redactSecrets(error.message, secrets) };
  return { reason: "unknown", ...(error instanceof Error && error.message ? { message: redactSecrets(error.message, secrets) } : {}) };
}
