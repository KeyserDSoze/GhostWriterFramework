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

function storageErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return fallback;
}

export function redactLlmDebugEntry(entry: LlmDebugEntry): LlmDebugEntry {
  return {
    ...entry,
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
