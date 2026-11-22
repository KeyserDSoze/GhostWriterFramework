import { BodyError, discardBody, readBoundedJson } from "./body.js";
import {
  AiCatalogError,
  CATALOG_MAX_MODELS,
  parseLmStudioModels,
  parseModalities,
  parseModelDetails,
  parseModelList,
  type AiCatalogErrorReason,
  type AiLmStudioModel,
  type AiModalityGroup,
  type AiModelCatalogEntry,
} from "./catalog.js";
import { abortReason, nameOf, timeoutOf, unsupportedCatalog } from "./catalog-support.js";
import type { AiIntegrationConfig } from "./config.js";
import { formatDuration, startClock, type DeadlineClock } from "./deadlines.js";
import { redactSecrets } from "./redact.js";
import { catalogTarget } from "./request.js";
import type { AiTimeoutPhase } from "./types.js";

/** The most bytes of an answer that are read. A longer one is refused as it passes the limit, whatever it said it weighed. */
export const CATALOG_MAX_BYTES = 600_000;
/** How long an endpoint may be silent, for each request: before it answers, and between two pieces of its answer. */
export const CATALOG_TIMEOUT_MS = 8_000;
/** The most a request may take in all, however the endpoint goes on sending: a safety, far above what a catalog needs. */
export const CATALOG_TOTAL_CAP_MS = 60_000;

export interface FetchModelCatalogOptions {
  /** The `fetch` to use (default the global one). Never given a cookie, and told not to follow a redirect. */
  fetch?: typeof fetch;
  /** Cancels the reading: an `AbortError`, never a catalog. */
  signal?: AbortSignal;
  /** How long an endpoint may be silent, per request (default `CATALOG_TIMEOUT_MS`, at most ten minutes). The most a request may take in all is a minute, or this when it is longer. */
  timeoutMs?: number;
}

/** What an integration's endpoint says of its models, from its list and from its companions. */
export interface AiModelCatalog {
  /** Every model the endpoint knows, sorted by id: the ids of `/models`, enriched with what `/models/details` and `/modalities` say, and the ids that only they know. Of every kind, with its `type`. */
  models: AiModelCatalogEntry[];
  /** Which of the answers were read: the list always (without it there is no catalog), the companions when the endpoint has them and they were as they should be. */
  source: { models: true; details: boolean; modalities: boolean };
  /** What the gateway offers by kind of model, with the kinds that run nothing; absent when `/modalities` was not read. */
  modalities?: AiModalityGroup[];
}

// ─── How a request fails ────────────────────────────────────────────────────

/** What went wrong with a request, before it is told in words. Internal: never leaves this module. */
class Fault extends Error {
  constructor(readonly reason: AiCatalogErrorReason, readonly about: { status?: number; phase?: AiTimeoutPhase; ms?: number; bytes?: boolean } = {}) {
    super(reason);
    this.name = "Fault";
  }
}

interface Reading {
  /** The integration as the messages name it (the key is out of it). */
  name: string;
  secrets: readonly string[];
  fetchImpl: typeof fetch;
  signal: AbortSignal | undefined;
  timeoutMs: number;
}

/** What went wrong, in words: why, and what to do. In English, and without the key, the address, or a word of what the endpoint sent. */
function describe(fault: Fault, how: Reading): AiCatalogError {
  const { name } = how;
  const { status, phase, ms, bytes } = fault.about;
  const message = ((): string => {
    switch (fault.reason) {
      case "unreachable":
        return `Could not reach ${name} to read its models. Check that the server is running and that the address is right (a redirect is refused: use the final address). In a browser, a server that does not allow this site (CORS) looks exactly like a server that is off.`;
      case "timeout":
        return phase === "start"
          ? `${name} did not answer within ${formatDuration(ms ?? how.timeoutMs)}. The server may be busy or off: try again, or check the address.`
          : phase === "idle"
            ? `${name} stopped sending its models for ${formatDuration(ms ?? how.timeoutMs)}. Try again in a moment.`
            : `Reading the models of ${name} took longer than ${formatDuration(ms ?? CATALOG_TOTAL_CAP_MS)} and was stopped. Try again, or enter the model names by hand.`;
      case "unauthorized":
        return status === 403
          ? `${name} denied access to its models (HTTP 403). The key may be wrong or not allowed to list models: check the key of the integration, or enter the model names by hand.`
          : `${name} refused the API key (HTTP ${status ?? 401}). Check the key of the integration.`;
      case "not-found":
        return `${name} has no list of models at its address (HTTP 404). Check that the address ends with the version path (for example /v1), or enter the model names by hand.`;
      case "rate-limited":
        return `${name} is limiting requests (HTTP 429). Wait a moment and try again.`;
      case "server-error":
        return `${name} failed while listing its models (HTTP ${status ?? 500}). It may be busy or restarting: try again in a moment.`;
      case "http-error":
        return `${name} answered HTTP ${status ?? 0} to the request for its models. Check the address and the key, or enter the model names by hand.`;
      case "empty":
        return `${name} lists no models. If it is a gateway, start a model there (a model that is stopped is not listed), or enter the model names by hand.`;
      case "too-large":
        return bytes
          ? `The answer of ${name} is larger than ${CATALOG_MAX_BYTES / 1000} KB and was not read. Enter the model names by hand.`
          : `The list of models of ${name} is too large to be read: it has more than ${CATALOG_MAX_MODELS} models, or it comes in pages. Enter the model names by hand.`;
      case "unsupported":
        return `${name} has no list of models to read.`;
      default:
        return `${name} answered, but what it sent is not a list of models in the OpenAI format. Check that the address is the API base (for example …/v1), or enter the model names by hand.`;
    }
  })();
  return new AiCatalogError(redactSecrets(message, how.secrets), fault.reason, status);
}

function statusFault(status: number): Fault {
  if (status === 401 || status === 403) return new Fault("unauthorized", { status });
  if (status === 404) return new Fault("not-found", { status });
  if (status === 429) return new Fault("rate-limited", { status });
  return new Fault(status >= 500 ? "server-error" : "http-error", { status });
}

/** What a failure of the request is: the author's cancel, a deadline, a status, a body that cannot be used, or no answer at all. */
function interpret(error: unknown, clock: DeadlineClock, how: Reading): Error {
  if (how.signal?.aborted) return abortReason(how.signal);
  const expired = clock.expired();
  if (expired) return new Fault("timeout", { phase: expired.phase, ms: expired.ms });
  if (error instanceof Fault) return error;
  if (error instanceof BodyError) return error.fault === "too-large" ? new Fault("too-large", { bytes: true }) : new Fault(error.fault === "lost" ? "unreachable" : "invalid");
  return new Fault("unreachable");
}

/** A parser's refusal of an answer is a fault of the answer; whatever else a parser throws is the same. */
function parsed<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new Fault(error instanceof AiCatalogError ? error.reason : "invalid");
  }
}

// ─── One request ────────────────────────────────────────────────────────────

/**
 * One GET: no cookie, no redirect, no cache, no referrer, the key in its header and nowhere else, a start deadline and then a silence between two pieces
 * (and a cap on the whole), an answer that is not OK let go unread, and a body that is read as JSON within `CATALOG_MAX_BYTES`. It throws a `Fault`,
 * or the author's cancel as it is.
 */
async function readJson(target: { url: string; headers: Record<string, string> }, how: Reading): Promise<unknown> {
  const clock = startClock(how.signal, { startMs: how.timeoutMs, idleMs: how.timeoutMs, capMs: Math.max(CATALOG_TOTAL_CAP_MS, how.timeoutMs) });
  try {
    const sent = Promise.resolve(how.fetchImpl(target.url, {
      method: "GET",
      headers: { accept: "application/json", ...target.headers },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: clock.signal,
    }));
    // An answer that comes after the request was given up is dropped, and its body let go.
    sent.then((late) => {
      if (clock.interrupted()) discardBody(late);
    }, () => undefined);
    const response = await clock.guard(sent);
    if (!response.ok) {
      discardBody(response);
      throw statusFault(response.status);
    }
    // The headers are here: the start deadline is over, and from now on it is the silence between two pieces that is watched.
    clock.streaming();
    return await readBoundedJson(response, clock, CATALOG_MAX_BYTES);
  } catch (error) {
    throw interpret(error, clock, how);
  } finally {
    clock.dispose();
  }
}

function readingOf(integration: AiIntegrationConfig, options: FetchModelCatalogOptions): Reading {
  return {
    name: nameOf(integration),
    secrets: [integration.apiKey],
    // The global fetch is called on its own, never as a method of this object: a browser refuses `fetch` called with another `this` (Illegal invocation).
    fetchImpl: options.fetch ?? ((input, init) => fetch(input, init)),
    signal: options.signal,
    timeoutMs: timeoutOf(options.timeoutMs, CATALOG_TIMEOUT_MS),
  };
}

// ─── The catalog of an endpoint ─────────────────────────────────────────────

/** Fills in what the companions say of a model: field by field, what `over` declares wins; what it leaves out stays as `base` has it. */
function combine(base: AiModelCatalogEntry, over: AiModelCatalogEntry): AiModelCatalogEntry {
  const contextWindow = over.contextWindow ?? base.contextWindow;
  const maxOutputTokens = over.maxOutputTokens ?? base.maxOutputTokens;
  const inputModalities = over.inputModalities ?? base.inputModalities;
  const outputModalities = over.outputModalities ?? base.outputModalities;
  return {
    id: base.id,
    type: over.type !== "unknown" ? over.type : base.type,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities ? { inputModalities: [...inputModalities] } : {}),
    ...(outputModalities ? { outputModalities: [...outputModalities] } : {}),
    capabilities: { ...base.capabilities, ...over.capabilities },
  };
}

/** The catalog: every id of the list, then what `/modalities` knows of it, then what `/models/details` says (which wins); an id only they know is added, up to the limit. */
function merge(ids: readonly string[], details: readonly AiModelCatalogEntry[] | undefined, groups: readonly AiModalityGroup[] | undefined): AiModelCatalogEntry[] {
  const entries = new Map<string, AiModelCatalogEntry>();
  for (const id of ids) entries.set(id, { id, type: "unknown", capabilities: {} });
  const add = (entry: AiModelCatalogEntry): void => {
    const have = entries.get(entry.id);
    if (have) entries.set(entry.id, combine(have, entry));
    else if (entries.size < CATALOG_MAX_MODELS) entries.set(entry.id, combine({ id: entry.id, type: "unknown", capabilities: {} }, entry));
  };
  for (const group of groups ?? []) for (const model of group.models) add(model);
  for (const model of details ?? []) add(model);
  return [...entries.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * Reads the models an integration's endpoint offers, as BookWriter does and as LlmProxy exposes them: `GET <base>/models` (the OpenAI list: without
 * it there is no catalog, and a failure is an `AiCatalogError` that says why and what to do), then, together, `GET <base>/models/details` (the window,
 * the largest answer and what each model can do) and `GET <base>/modalities` (what the gateway offers, by kind of model, and what runs for each), which
 * an endpoint may not have and whose every failure is silent: the catalog is then what the list says. The base is the one the chat requests use.
 * The models of every kind are returned, with their `type`, so that a screen can fill the tables of the tools that are not chat. Only OpenAI-compatible
 * integrations have such a list: any other is an `AiCatalogError` of reason `unsupported`, and nothing is sent.
 *
 * What an endpoint sends is untrusted: a request is a plain GET with no cookie and no redirect, with the key in its header only; an endpoint may be
 * silent for 8 s (before it answers, and between two pieces), a minute in all; a body is read in pieces up to 600 KB, and let go the moment it is too
 * much, or not JSON; and nothing it says is quoted in an error. The key is in no message and no result. A cancelled reading is an `AbortError`.
 */
export async function fetchModelCatalog(integration: AiIntegrationConfig, options: FetchModelCatalogOptions = {}): Promise<AiModelCatalog> {
  const target = catalogTarget(integration, "/models");
  if (!target) throw unsupportedCatalog(integration);
  const how = readingOf(integration, options);
  if (how.signal?.aborted) throw abortReason(how.signal);

  let ids: string[];
  try {
    const payload = await readJson(target, how);
    ids = parsed(() => parseModelList(payload));
  } catch (error) {
    throw error instanceof Fault ? describe(error, how) : error;
  }

  // The companions are optional: an endpoint that does not have them, or whose answer is not what it should be, leaves the catalog as the list says it.
  const optional = async <T>(path: string, read: (payload: unknown) => T): Promise<T | undefined> => {
    const asked = catalogTarget(integration, path);
    if (!asked) return undefined;
    try {
      return read(await readJson(asked, how));
    } catch {
      return undefined;
    }
  };
  const [details, groups] = await Promise.all([optional("/models/details", parseModelDetails), optional("/modalities", parseModalities)]);
  if (how.signal?.aborted) throw abortReason(how.signal);
  return {
    models: merge(ids, details, groups),
    source: { models: true, details: details !== undefined, modalities: groups !== undefined },
    ...(groups !== undefined ? { modalities: groups } : {}),
  };
}

/**
 * The native list of an LM Studio on this computer (`GET /api/v1/models` at the root of its server): the thinking levels each language model declares
 * and the context it loaded and supports, for `parseLmStudioModels`. Only a server that runs on this machine is asked (`localhost`, `127.0.0.1`, `::1`,
 * with no credentials in its address), and only an OpenAI-compatible integration is read: for any other, and for any server that is not LM Studio,
 * cannot be reached, or answers what is not its list, the answer is `undefined`, and the caller keeps what it knew. A key that is configured is sent, to this
 * computer only. A cancelled reading is an `AbortError`.
 */
export async function fetchLmStudioModels(integration: AiIntegrationConfig, options: FetchModelCatalogOptions = {}): Promise<AiLmStudioModel[] | undefined> {
  const headers = catalogTarget(integration, "/models")?.headers;
  if (!headers) return undefined;
  let url: URL;
  try {
    url = new URL(integration.endpoint ?? "");
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
  const how = readingOf(integration, options);
  if (how.signal?.aborted) throw abortReason(how.signal);
  try {
    return parseLmStudioModels(await readJson({ url: `${url.origin}/api/v1/models`, headers }, how));
  } catch {
    if (how.signal?.aborted) throw abortReason(how.signal);
    return undefined;
  }
}
