import type { TFunction } from "i18next";
import type { LlmMessage } from "@/assistant/llm";
import type { ModelWindow } from "@/assistant/promptBudget";

/**
 * What the router cut from a request to fit the window of the model it asked (`budgetLlmMessages`): the chat says that it was cut, how much, and where the window is set, rather than
 * answering as if the model had read everything. In characters, which the author can count, not in tokens, which the router can only estimate.
 */
export interface PromptCut {
  model: string;
  integration: string;
  /** The window the cut was made for, in tokens, and whether it is the model's own (else the default the router assumes for a model whose window is not set). */
  windowTokens: number;
  configured: boolean;
  /** The characters of the request, and how many of them were sent. */
  characters: number;
  sentCharacters: number;
  /** Images left out. */
  images: number;
}

type Listener = (cut: PromptCut) => void;

/** As the notices of a retry (`retryNotice.ts`): told to whoever listens to the signal of the request, the chat that sent it, and to no one else. */
const listeners = new WeakMap<AbortSignal, Set<Listener>>();

/** Listens to the cuts of the calls made with `signal`; the result stops listening. */
export function listenToPromptCuts(signal: AbortSignal, listener: Listener): () => void {
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

/** Tells the listeners of `signal` that a request was cut. A listener that throws never breaks the call. */
export function announcePromptCut(signal: AbortSignal | undefined, cut: PromptCut): void {
  if (!signal) return;
  for (const listener of [...(listeners.get(signal) ?? [])]) {
    try {
      listener(cut);
    } catch {
      // A listener of the chat must never break a call.
    }
  }
}

function measure(messages: readonly LlmMessage[]): { characters: number; images: number } {
  let characters = 0;
  let images = 0;
  for (const message of messages) {
    if (typeof message.content === "string") characters += message.content.length;
    else for (const part of message.content) {
      if (part.type === "text") characters += part.text.length;
      else images += 1;
    }
  }
  return { characters, images };
}

/** The cut between the request (`messages`) and what was sent (`sent`) for the window of the model (`modelWindow`), or `null` when nothing was cut (the router sends the same messages then). */
export function promptCutOf(candidate: { model: string; integrationName: string }, window: ModelWindow, messages: readonly LlmMessage[], sent: readonly LlmMessage[]): PromptCut | null {
  if (sent === messages) return null;
  const before = measure(messages);
  const after = measure(sent);
  if (after.characters >= before.characters && after.images >= before.images) return null;
  return {
    model: candidate.model,
    integration: candidate.integrationName,
    windowTokens: window.tokens,
    configured: window.source === "configured",
    characters: before.characters,
    sentCharacters: Math.min(before.characters, after.characters),
    images: Math.max(0, before.images - after.images),
  };
}

/**
 * The note the chat adds to a reply whose request was cut: for each model that was asked with less than the request (once, the most cut), how much was sent, the window it was cut
 * for, and where to set it. Nothing when nothing was cut.
 */
export function promptCutNote(cuts: readonly PromptCut[], t: TFunction, format: (value: number) => string): string {
  const worst = new Map<string, PromptCut>();
  for (const cut of cuts) {
    const key = `${cut.integration}\u0000${cut.model}`;
    const known = worst.get(key);
    if (!known || cut.sentCharacters / Math.max(1, cut.characters) < known.sentCharacters / Math.max(1, known.characters)) worst.set(key, cut);
  }
  if (!worst.size) return "";
  const lines = [...worst.values()].map((cut) => t(cut.configured ? "autopilot.copilotCut.line" : "autopilot.copilotCut.lineDefault", {
    model: cut.model,
    integration: cut.integration,
    sent: format(cut.sentCharacters),
    total: format(cut.characters),
    percent: Math.max(0, Math.min(99, Math.floor((cut.sentCharacters / Math.max(1, cut.characters)) * 100))),
    window: format(cut.windowTokens),
  }) + (cut.images ? ` ${t("autopilot.copilotCut.images", { count: cut.images })}` : ""));
  return `**${t("autopilot.copilotCut.title")}** ${lines.join(" ")} ${t("autopilot.copilotCut.where")}`;
}
