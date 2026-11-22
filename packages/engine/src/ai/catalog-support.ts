import { abortError } from "../util/abort.js";
import { AiCatalogError } from "./catalog.js";
import type { AiIntegrationConfig } from "./config.js";
import { redactSecrets } from "./redact.js";

// What reading the models of an endpoint and probing it have in common. Internal: not exported by the package.

/** The integration as a message names it, in quotes, with its key (which a careless name may hold) taken out. */
export function nameOf(integration: Pick<AiIntegrationConfig, "name" | "provider" | "apiKey">): string {
  return redactSecrets(`"${integration.name || integration.provider}"`, [integration.apiKey]);
}

/** What a caller that cancelled is told: its own reason when it gave one, else an `AbortError`. */
export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : abortError();
}

/** The longest a host may ask a request to be silent: ten minutes, far under what a timer can count (past about 24 days it would fire at once). */
export const MAX_REQUEST_TIMEOUT_MS = 600_000;

/** The positive number a host gave as a time, kept within `MAX_REQUEST_TIMEOUT_MS`, or the default. */
export function timeoutOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_REQUEST_TIMEOUT_MS) : fallback;
}

/** An integration that has no list of models to read: it says why, and that its models are entered by hand or picked from the catalog that has them. */
export function unsupportedCatalog(integration: Pick<AiIntegrationConfig, "provider">): AiCatalogError {
  const message = integration.provider === "azure_openai"
    ? "The models of an Azure OpenAI integration cannot be listed: a deployment is created by hand in Azure, and nobody lists them. Enter the deployment names."
    : integration.provider === "github_models"
      ? "GitHub Models does not list its models at this address: its catalog is read from GitHub's own catalog, not from the endpoint. Pick the models from that catalog."
      : "A Microsoft 365 Copilot integration has no catalog of models to read: it runs only inside Microsoft 365.";
  return new AiCatalogError(message, "unsupported");
}
