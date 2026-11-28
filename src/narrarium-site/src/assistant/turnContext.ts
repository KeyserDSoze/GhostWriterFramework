import type { RequestShape } from "@/assistant/contextBudget";
import type { ChatCapability } from "@/types/settings";

/**
 * What the calls of a turn of the Copilot or of Brainstorming sent and what the provider counted, told to the chat that made them (by the signal of the request, as the notices of
 * a retry and the cuts of a prompt): the shape of each request (`RequestShape`) and the usage the provider reported (its input, the part of it served from its cache, the output).
 * The chat keeps the first request of the turn and its usage: what its context ring measures the next message against.
 */
export interface TurnRequest {
  /** The task of the call: the chat keeps the requests of its own (`copilot`, `brainstorming`), not those of the tasks a turn may ask on the way. */
  capability: ChatCapability;
  integrationId: string;
  model: string;
  shape: RequestShape;
}

export interface TurnUsage {
  capability: ChatCapability;
  integrationId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

interface Listener {
  request?: (request: TurnRequest) => void;
  usage?: (usage: TurnUsage) => void;
}

const listeners = new WeakMap<AbortSignal, Set<Listener>>();

/** Listens to the requests and the usage of the calls made with `signal`; the result stops listening. */
export function listenToTurn(signal: AbortSignal, listener: Listener): () => void {
  let set = listeners.get(signal);
  if (!set) {
    set = new Set();
    listeners.set(signal, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

function tell(signal: AbortSignal | undefined, call: (listener: Listener) => void): void {
  if (!signal) return;
  for (const listener of [...(listeners.get(signal) ?? [])]) {
    try {
      call(listener);
    } catch {
      // A listener of the chat must never break a call.
    }
  }
}

export function announceTurnRequest(signal: AbortSignal | undefined, request: TurnRequest): void {
  tell(signal, (listener) => listener.request?.(request));
}

export function announceTurnUsage(signal: AbortSignal | undefined, usage: TurnUsage): void {
  tell(signal, (listener) => listener.usage?.(usage));
}
