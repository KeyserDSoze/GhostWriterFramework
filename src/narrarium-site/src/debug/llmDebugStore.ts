import { create } from "zustand";

const LOCAL_KEY = "narrarium-llm-debug-v1";
const RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 days
const MAX_ENTRIES = 500;

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
  /** Short label of the calling task, e.g. "copilot", "script→draft", "confirm", "tts". */
  label?: string;
  model: string;
  status: LlmRequestStatus;
  /** Chat: the messages sent. Other kinds: a single synthetic entry describing the input. */
  messages?: LlmDebugMessage[];
  /** Response text (chat) or transcript (stt) or a short note (tts/image). */
  response?: string;
  error?: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  /** EUR cost of this single request, when pricing is configured. */
  cost?: number;
}

function prune(entries: LlmDebugEntry[]): LlmDebugEntry[] {
  const cutoff = Date.now() - RETENTION_MS;
  return entries.filter((e) => e.at >= cutoff).slice(0, MAX_ENTRIES);
}

function loadLocal(): LlmDebugEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return prune(JSON.parse(raw) as LlmDebugEntry[]);
  } catch {
    // ignore
  }
  return [];
}

function persistLocal(entries: LlmDebugEntry[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(entries));
  } catch {
    // ignore
  }
}

interface LlmDebugState {
  entries: LlmDebugEntry[];
  /** Number of requests currently in flight (drives the live indicator). */
  pending: number;
  begin: (entry: Omit<LlmDebugEntry, "id" | "at" | "status"> & { id?: string }) => string;
  finish: (id: string, patch: Partial<LlmDebugEntry>) => void;
  clear: () => void;
}

export const useLlmDebugStore = create<LlmDebugState>()((set) => ({
  entries: loadLocal(),
  pending: 0,
  begin: (entry) => {
    const id = entry.id ?? crypto.randomUUID();
    set((s) => {
      const next = prune([{ ...entry, id, at: Date.now(), status: "pending" as const }, ...s.entries]);
      persistLocal(next);
      return { entries: next, pending: s.pending + 1 };
    });
    return id;
  },
  finish: (id, patch) => {
    set((s) => {
      let found = false;
      const next = s.entries.map((e) => {
        if (e.id !== id) return e;
        found = true;
        return { ...e, ...patch, endedAt: Date.now(), status: patch.status ?? "done" };
      });
      persistLocal(next);
      return { entries: next, pending: found ? Math.max(0, s.pending - 1) : s.pending };
    });
  },
  clear: () => {
    persistLocal([]);
    set({ entries: [] });
  },
}));

/** Flatten LLM message content (string or text/image parts) into a readable string. */
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
