import { BodyError, discardBody, readBoundedJson } from "./body.js";
import { AiCatalogError, parseModelList } from "./catalog.js";
import { abortReason, nameOf, timeoutOf, unsupportedCatalog } from "./catalog-support.js";
import type { AiIntegrationConfig } from "./config.js";
import { formatDuration, startClock } from "./deadlines.js";
import { redactSecrets } from "./redact.js";
import { catalogTarget } from "./request.js";

/** How long the probe waits for the endpoint to answer: a short GET, as BookWriter's `localEndpointTimeoutHint` makes. */
export const PROBE_TIMEOUT_MS = 4_000;
/** The most of the answer the probe reads, to count the models: a bigger one is not read, and the endpoint has answered all the same. */
const PROBE_MAX_BYTES = 256_000;

/** `ok`: the endpoint answered with a status that is a success. `http-error`: it answered with an error. `unreachable`: nothing answered. */
export type AiProbeOutcome = "ok" | "http-error" | "unreachable";

/** What one short request to the endpoint says of it. */
export interface AiEndpointProbe {
  outcome: AiProbeOutcome;
  /** The HTTP status, when anything answered. */
  httpStatus?: number;
  /** Milliseconds until the answer began (until the endpoint gave up, for an `unreachable` one). */
  latencyMs: number;
  /** How many models the endpoint lists, when it answered with a list it could be read from in time. */
  models?: number;
  /**
   * `ok`: an answer arrived, so nothing blocked the request (CORS lets it through). `blocked-or-unreachable`: no answer arrived, and a browser cannot
   * tell a request that CORS blocked from a server that is off, from an address that is wrong, or from a connection that failed: the message says so.
   */
  cors?: "ok" | "blocked-or-unreachable";
  /** In English, with what to do about it; never the key, the address, or a word of what the endpoint sent. */
  message: string;
}

export interface ProbeEndpointOptions {
  /** The `fetch` to use (default the global one). Never given a cookie, and told not to follow a redirect. */
  fetch?: typeof fetch;
  /** Cancels the probe: an `AbortError`, never a result. */
  signal?: AbortSignal;
  /** How long to wait for an answer (default `PROBE_TIMEOUT_MS`, at most ten minutes). */
  timeoutMs?: number;
}

const CORS_NOTE = "In a browser, a server that does not allow this site (CORS) looks exactly like a server that is off: if it runs, allow this site in its CORS settings.";

function reachedMessage(name: string, status: number): string {
  if (status === 401) return `${name} is reachable but refused the API key (HTTP 401). Check the key of the integration.`;
  if (status === 403) return `${name} is reachable but denied access (HTTP 403). The key may be wrong or not allowed to list models: check the key of the integration.`;
  if (status === 404) return `${name} is reachable but has no list of models at its address (HTTP 404). Check that the address ends with the version path (for example /v1).`;
  if (status === 429) return `${name} is reachable but is limiting requests (HTTP 429). Wait a moment and try again.`;
  if (status >= 500) return `${name} is reachable but failing (HTTP ${status}): it may be busy or restarting. Try again in a moment.`;
  return `${name} is reachable but answered HTTP ${status} to the request for its models. Check the address and the key.`;
}

/**
 * Asks an OpenAI-compatible endpoint one short question, `GET <base>/models` (the base chat uses), and says whether it answers: how fast, with which
 * status, how many models it lists, and, when it does not answer, that a browser cannot tell why (the server is off, the address is wrong, CORS blocked
 * the request): the foundation of a "Check the connection" in an error panel. A request that is refused with a status is still an answer: the endpoint is
 * reachable, and the status says what to fix (the key, the address). The key is sent, so that a gateway that refuses it is told from one that is off.
 * Never throws for what the endpoint does: only for a cancel (`AbortError`) and for an integration that has no such list to ask (`AiCatalogError`,
 * reason `unsupported`: Azure OpenAI, GitHub Models, Microsoft 365).
 */
export async function probeEndpoint(integration: AiIntegrationConfig, options: ProbeEndpointOptions = {}): Promise<AiEndpointProbe> {
  const target = catalogTarget(integration, "/models");
  if (!target) throw unsupportedCatalog(integration);
  const { signal } = options;
  if (signal?.aborted) throw abortReason(signal);
  const name = nameOf(integration);
  const secrets = [integration.apiKey];
  const timeoutMs = timeoutOf(options.timeoutMs, PROBE_TIMEOUT_MS);
  const fetchImpl = options.fetch ?? fetch;
  const say = (message: string): string => redactSecrets(message, secrets);
  const startedAt = Date.now();
  const clock = startClock(signal, { startMs: timeoutMs, idleMs: timeoutMs, capMs: timeoutMs * 2 });
  try {
    let response: Response;
    try {
      const sent = Promise.resolve(fetchImpl(target.url, {
        method: "GET",
        headers: { accept: "application/json", ...target.headers },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: clock.signal,
      }));
      sent.then((late) => {
        if (clock.interrupted()) discardBody(late);
      }, () => undefined);
      response = await clock.guard(sent);
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      const latencyMs = Date.now() - startedAt;
      const expired = clock.expired();
      const what = expired
        ? `${name} did not answer within ${formatDuration(expired.ms)}. The server may be off, busy or unreachable: check that it is running and that the address is right.`
        : `Could not reach ${name}: the connection failed. Check that the server is running and that the address is right (a redirect is refused: use the final address).`;
      return { outcome: "unreachable", latencyMs, cors: "blocked-or-unreachable", message: say(`${what} ${CORS_NOTE}`) };
    }
    const latencyMs = Date.now() - startedAt;
    const httpStatus = response.status;
    if (!response.ok) {
      discardBody(response);
      return { outcome: "http-error", httpStatus, latencyMs, cors: "ok", message: say(reachedMessage(name, httpStatus)) };
    }
    // It answered. Its models are counted when its body can be read in the time that is left: whatever goes wrong with the body, the endpoint has answered.
    clock.streaming();
    const answered = `${name} answered in ${latencyMs} ms (HTTP ${httpStatus})`;
    try {
      const models = parseModelList(await readBoundedJson(response, clock, PROBE_MAX_BYTES)).length;
      return { outcome: "ok", httpStatus, latencyMs, models, cors: "ok", message: say(`${answered} and lists ${models} ${models === 1 ? "model" : "models"}.`) };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error instanceof AiCatalogError && error.reason === "empty") {
        return { outcome: "ok", httpStatus, latencyMs, models: 0, cors: "ok", message: say(`${answered} but lists no models. If it is a gateway, start a model there (a model that is stopped is not listed).`) };
      }
      const notAList = (error instanceof AiCatalogError && error.reason === "invalid") || (error instanceof BodyError && error.fault === "invalid");
      return {
        outcome: "ok",
        httpStatus,
        latencyMs,
        cors: "ok",
        message: say(notAList
          ? `${answered}, but not with a list of models: check that the address is the API base (for example …/v1) and not a web page.`
          : `${answered}; its list of models was not read.`),
      };
    }
  } finally {
    clock.dispose();
  }
}
