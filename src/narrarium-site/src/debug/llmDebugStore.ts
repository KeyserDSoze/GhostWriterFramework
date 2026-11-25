import { create } from "zustand";

const LEGACY_LOCAL_KEY = "narrarium-llm-debug-v1";
const LOCAL_KEY_PREFIX = "narrarium-llm-debug-v2:";
export const LLM_DEBUG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LLM_DEBUG_MAX_ENTRIES = 200;
export const LLM_DEBUG_MAX_BYTES = 256 * 1024;
export const LLM_DEBUG_REDACTED = "[Content redacted: debug history stores metadata only]";
export const LLM_DEBUG_ERROR_REDACTED = "[Error details redacted]";

export type LlmRequestKind = "chat" | "tts" | "stt" | "image";
export type LlmRequestStatus = "pending" | "done" | "error";

export interface LlmDebugMessage {
  role: string;
  content: string;
}

export interface LlmDebugEntry {
  id: string;
  at: number;
  endedAt?: number;
  kind: LlmRequestKind;
  /** Content categories sent to this provider. Never contains content itself. */
  contentKinds?: Array<"text" | "image" | "audio">;
  /** Short label of the calling task, e.g. "copilot", "script→draft", "confirm", "tts". */
  label?: string;
  model: string;
  /** Provider type and pseudonymous integration identity; endpoints and credentials are never retained. */
  provider?: string;
  integrationId?: string;
  routeCandidateIndex?: number;
  usedFallback?: boolean;
  /** Privacy-safe failure classification; raw provider details remain redacted. */
  failureKind?: "timeout" | "cancelled" | "provider";
  timeoutMs?: number;
  status: LlmRequestStatus;
  /** Message roles are retained, but content is always redacted before entering the store. */
  messages?: LlmDebugMessage[];
  /** A response marker is retained instead of response or transcript content. */
  response?: string;
  error?: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  /** EUR cost of this single request, when pricing is configured. */
  cost?: number;
  /**
   * How the engine asked, and what came back, for a chat request of the autopilot: metadata only, every field optional (an entry saved before they existed has none). The store
   * keeps only flags, numbers and a few words of the engine, whatever it is given.
   */
  /** The request asked for a structured answer (a value, as the agents of the autopilot do), and not prose. */
  structured?: boolean;
  /** The structured answer was asked for as the forced call of a function (`true`) or as JSON in the message (`false`). */
  tools?: boolean;
  /** The request asked the provider to stream its reply. */
  stream?: boolean;
  /** What the integration says about streaming. */
  streamMode?: "auto" | "off";
  /** The API version the request carried (Azure OpenAI's `api-version`, or `v1`): a short word, nothing else. */
  apiVersion?: string;
  /** The level that was sent; absent when none was. */
  thinking?: "low" | "medium" | "high" | "xhigh";
  /** Where the level went, only when it went as the argument of the chat template (the model's "Thinking parameter"); absent: it went as `reasoning_effort`, or no level was sent. */
  reasoningParameter?: "chat_template_kwargs.reasoning_strength";
  /** «Tools only» was in force for the call. */
  toolsOnly?: boolean;
  /** The models of the route that the call did not ask, and why. */
  skipped?: Array<{ model: string; reason: "no-tool-calls" }>;
  /** The deadlines the attempt ran with, in milliseconds; `raisedFrom` is the provider timeout the minimum lifted. */
  timeouts?: { startMs: number; idleMs: number; capMs: number; raisedFrom?: number };
  /** At the end: the reply was read as a stream. */
  streamed?: boolean;
  /** At the end: milliseconds to the first byte of the reply. */
  firstByteMs?: number;
  /** At the end, for a structured request: whether the model delivered the answer as a function call. */
  toolCalled?: boolean;
  /** For a timeout: which deadline ran out. */
  timeoutPhase?: "start" | "idle" | "total";
  /**
   * At the end: what the transport saw of the call (the engine's `AiTransportDiagnostics`), kept as numbers, flags and the few words of a closed list. The end of the stream (`tail`) and the
   * reply that had arrived are never kept: this history stores metadata only, and is saved in the browser.
   */
  transport?: LlmDebugTransport;
}

/** What the debug history keeps of the transport of a call: the figures of the response, how the stream ended, and the id the provider gave the request. */
export interface LlmDebugTransport {
  /** The HTTP status of the response. */
  status?: number;
  bytes?: number;
  chunks?: number;
  events?: number;
  /** Milliseconds from the start of the call to its last chunk, and from that chunk to the end of the call. */
  lastChunkAfterMs?: number;
  silentMs?: number;
  /** How the stream ended: `done` (`[DONE]`), `closed` (without it), `reset` (the connection broke), `error` (the provider reported a failure), `timeout` (a deadline ran out). */
  end?: "done" | "closed" | "reset" | "error" | "timeout";
  /** How the provider said the reply ended (`stop`, `length`...). */
  finishReason?: string;
  /** The provider reported the tokens, and the request asked it to. */
  usageReceived?: boolean;
  usageRequested?: boolean;
  /** What the provider or its gateway calls the request (letters, digits and a few signs). */
  requestId?: string;
}

function storageKey(identity: string): string {
  return `${LOCAL_KEY_PREFIX}${hashIdentifier(identity)}`;
}

function hashIdentifier(identity: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < identity.length; index++) {
    hash ^= BigInt(identity.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

const SAFE_PROVIDERS = new Set(["azure_openai", "openai", "github_models", "m365_copilot"]);

export function redactIntegrationIdentity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^integration:[0-9a-f]{16}$/.test(value)) return value;
  return `integration:${hashIdentifier(value)}`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function pruneLlmDebugEntries(entries: LlmDebugEntry[], now = Date.now()): LlmDebugEntry[] {
  const cutoff = now - LLM_DEBUG_RETENTION_MS;
  const candidates = entries.filter((entry) => entry.at >= cutoff).slice(0, LLM_DEBUG_MAX_ENTRIES);
  while (candidates.length && utf8Bytes(JSON.stringify(candidates)) > LLM_DEBUG_MAX_BYTES) candidates.pop();
  return candidates;
}

function redactText(value: unknown): string | undefined {
  return value == null ? undefined : LLM_DEBUG_REDACTED;
}

function redactError(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(value)
    .replace(/\b(?:bearer\s+)?(?:sk|gh[opusr]|github_pat)[-_][a-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/((?:api[-_ ]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 1000);
}

const THINKING = new Set(["low", "medium", "high", "xhigh"]);
/** The engine says where the level went only when it went as the argument of the chat template: the other two ways say nothing, so nothing else is kept. */
const REASONING_PARAMETERS = new Set(["chat_template_kwargs.reasoning_strength"]);
const STREAM_MODES = new Set(["auto", "off"]);
const TIMEOUT_PHASES = new Set(["start", "idle", "total"]);
const MAX_SKIPPED_MODELS = 8;
const MAX_MODEL_NAME = 120;
const STREAM_ENDS = new Set(["done", "closed", "reset", "error", "timeout"]);
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const FINISH_REASON = /^[A-Za-z0-9_ .:-]{1,60}$/;

const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const milliseconds = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
const word = (value: unknown, allowed: ReadonlySet<string>): string | undefined => (typeof value === "string" && allowed.has(value) ? value : undefined);

function skippedModels(value: unknown): LlmDebugEntry["skipped"] {
  if (!Array.isArray(value)) return undefined;
  const kept: NonNullable<LlmDebugEntry["skipped"]> = [];
  for (const item of value) {
    if (kept.length >= MAX_SKIPPED_MODELS || !item || typeof item !== "object") continue;
    const { model, reason } = item as { model?: unknown; reason?: unknown };
    if (reason !== "no-tool-calls" || typeof model !== "string" || !model.trim()) continue;
    kept.push({ model: (redactError(model.trim()) ?? "").slice(0, MAX_MODEL_NAME), reason });
  }
  return kept.length ? kept : undefined;
}

function deadlines(value: unknown): LlmDebugEntry["timeouts"] {
  if (!value || typeof value !== "object") return undefined;
  const { startMs, idleMs, capMs, raisedFrom } = value as Record<string, unknown>;
  const start = milliseconds(startMs);
  const idle = milliseconds(idleMs);
  const cap = milliseconds(capMs);
  if (start === undefined || idle === undefined || cap === undefined) return undefined;
  const raised = milliseconds(raisedFrom);
  return { startMs: start, idleMs: idle, capMs: cap, ...(raised !== undefined ? { raisedFrom: raised } : {}) };
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12 ? Math.round(value) : undefined);

/** What the store keeps of the transport of a call: figures, flags and words of closed lists, an id of plain characters, and nothing else, whatever it is given. `undefined` when nothing is left. */
function transportFields(value: unknown): LlmDebugTransport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const status = count(source.status);
  const fields: Record<string, unknown> = {
    status: status !== undefined && status >= 100 && status <= 599 ? status : undefined,
    bytes: count(source.bytes),
    chunks: count(source.chunks),
    events: count(source.events),
    lastChunkAfterMs: count(source.lastChunkAfterMs),
    silentMs: count(source.silentMs),
    end: word(source.end, STREAM_ENDS),
    finishReason: typeof source.finishReason === "string" && FINISH_REASON.test(source.finishReason) ? source.finishReason : undefined,
    usageReceived: flag(source.usageReceived),
    usageRequested: flag(source.usageRequested),
    requestId: typeof source.requestId === "string" && REQUEST_ID.test(source.requestId) ? source.requestId : undefined,
  };
  const kept = Object.fromEntries(Object.entries(fields).filter(([, entry]) => entry !== undefined));
  return Object.keys(kept).length ? kept as LlmDebugTransport : undefined;
}

/** What the store keeps of how an attempt was asked: flags, numbers and the few words of the engine, and nothing else, whatever it is given. A field that is not valid is left out. */
function attemptFields(entry: LlmDebugEntry): Partial<LlmDebugEntry> {
  const fields: Record<string, unknown> = {
    structured: flag(entry.structured),
    tools: flag(entry.tools),
    stream: flag(entry.stream),
    streamMode: word(entry.streamMode, STREAM_MODES),
    apiVersion: typeof entry.apiVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(entry.apiVersion) ? entry.apiVersion : undefined,
    thinking: word(entry.thinking, THINKING),
    reasoningParameter: word(entry.reasoningParameter, REASONING_PARAMETERS),
    toolsOnly: flag(entry.toolsOnly),
    skipped: skippedModels(entry.skipped),
    timeouts: deadlines(entry.timeouts),
    streamed: flag(entry.streamed),
    firstByteMs: milliseconds(entry.firstByteMs),
    toolCalled: flag(entry.toolCalled),
    timeoutPhase: word(entry.timeoutPhase, TIMEOUT_PHASES),
    transport: transportFields(entry.transport),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<LlmDebugEntry>;
}

function storageErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return fallback;
}

export function redactLlmDebugEntry(entry: LlmDebugEntry): LlmDebugEntry {
  const { structured: _s, tools: _t, stream: _st, streamMode: _sm, apiVersion: _av, thinking: _th, reasoningParameter: _rp, toolsOnly: _to, skipped: _sk, timeouts: _ti, streamed: _sd, firstByteMs: _fb, toolCalled: _tc, timeoutPhase: _tp, transport: _tr, ...rest } = entry;
  return {
    ...rest,
    ...attemptFields(entry),
    label: redactError(entry.label),
    model: redactError(entry.model) ?? "",
    provider: entry.provider && SAFE_PROVIDERS.has(entry.provider) ? entry.provider : undefined,
    integrationId: redactIntegrationIdentity(entry.integrationId),
    messages: entry.messages?.map((message) => ({ role: redactError(message.role) ?? "", content: LLM_DEBUG_REDACTED })),
    response: redactText(entry.response),
    error: entry.error == null ? undefined : LLM_DEBUG_ERROR_REDACTED,
  };
}

function loadLocal(identity: string | null): LlmDebugEntry[] {
  if (!identity) return [];
  try {
    const raw = localStorage.getItem(storageKey(identity));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return pruneLlmDebugEntries(parsed.map((entry) => redactLlmDebugEntry(entry as LlmDebugEntry)));
  } catch {
    return [];
  }
}

function persistLocal(identity: string | null, entries: LlmDebugEntry[]): string | null {
  if (!identity) return null;
  try {
    localStorage.setItem(storageKey(identity), JSON.stringify(entries));
    return null;
  } catch (error) {
    return storageErrorMessage(error, "Local storage quota exceeded.");
  }
}

function removeLocal(identity: string | null): string | null {
  try {
    localStorage.removeItem(LEGACY_LOCAL_KEY);
    if (identity) localStorage.removeItem(storageKey(identity));
    return null;
  } catch (error) {
    return storageErrorMessage(error, "Could not clear local debug history.");
  }
}

interface LlmDebugState {
  entries: LlmDebugEntry[];
  /** Number of requests currently in flight (drives the live indicator). */
  pending: number;
  storageError: string | null;
  accountIdentity: string | null;
  begin: (entry: Omit<LlmDebugEntry, "id" | "at" | "status"> & { id?: string }) => string;
  finish: (id: string, patch: Partial<LlmDebugEntry>) => void;
  clear: () => void;
  setAccount: (identity: string | null, previousIdentity?: string | null, clear?: boolean) => void;
}

export const useLlmDebugStore = create<LlmDebugState>()((set) => ({
  entries: [],
  pending: 0,
  storageError: null,
  accountIdentity: null,
  begin: (entry) => {
    const id = entry.id ?? crypto.randomUUID();
    set((state) => {
      const redacted = redactLlmDebugEntry({ ...entry, id, at: Date.now(), status: "pending" });
      const entries = pruneLlmDebugEntries([redacted, ...state.entries]);
      return { entries, pending: state.pending + 1, storageError: persistLocal(state.accountIdentity, entries) };
    });
    return id;
  },
  finish: (id, patch) => {
    set((state) => {
      let found = false;
      const entries = pruneLlmDebugEntries(state.entries.map((entry) => {
        if (entry.id !== id) return entry;
        found = true;
        return redactLlmDebugEntry({ ...entry, ...patch, endedAt: Date.now(), status: patch.status ?? "done" });
      }));
      return {
        entries,
        pending: found ? Math.max(0, state.pending - 1) : state.pending,
        storageError: persistLocal(state.accountIdentity, entries),
      };
    });
  },
  clear: () => {
    set((state) => ({ entries: [], pending: 0, storageError: removeLocal(state.accountIdentity) }));
  },
  setAccount: (identity, previousIdentity = null, clear = false) => {
    let storageError = removeLocal(null); // Delete v1 rather than migrating sensitive raw content.
    if (clear) {
      const previousError = removeLocal(previousIdentity);
      const identityError = removeLocal(identity);
      storageError = identityError ?? previousError ?? storageError;
    }
    const entries = clear ? [] : loadLocal(identity);
    if (!clear && identity) storageError = persistLocal(identity, entries) ?? storageError;
    set({
      accountIdentity: identity,
      entries,
      pending: 0,
      storageError,
    });
  },
}));

/** Flatten LLM message content without retaining embedded image data. */
export function flattenLlmContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
        if (part && typeof part === "object" && ("image" in part || "image_url" in part)) return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
