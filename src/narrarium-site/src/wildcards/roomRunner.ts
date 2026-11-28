import {
  WILDCARDS_CAPABILITY, consultWildcards, estimateModelOf, estimateWildcardRoom, mergeWildcards, parseIdeasJournal, parseWildcard, pickAiRuntimeConfig, rejectedIdeas,
  type AiPort, type WildcardConsultInput, type WildcardConsultResult, type WildcardProfile, type WildcardRoomEstimate,
} from "narrarium-engine";
import { createBrowserAi } from "@/autopilot/browserAi";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { usageTaskOf } from "@/costs/usageTasks";
import type { AppSettings, BookEntry } from "@/types/settings";
import { accountWildcardProfiles } from "@/wildcards/wildcardFiles";

/**
 * The room of the wildcards in the browser: the engine's consultation (`consultWildcards`, the same as the autopilot's) over the book's working copy, with the
 * engine's client as its door to the models (`createBrowserAi`, routed for the task `wildcards`). Its calls are counted as the use «Wildcards' ideas» on the
 * Costs page, in the task of the turn that asked (a turn of the Copilot or of Brainstorming) when there is one.
 */

/** The engine's client for the room's calls: the author's settings, the book they belong to, the task of the turn that asked. */
export function roomAi(input: { settings: AppSettings; book: Pick<BookEntry, "id" | "name">; accountScope?: string | null; signal?: AbortSignal }): AiPort {
  return createBrowserAi({
    settings: input.settings,
    ...(input.accountScope !== undefined ? { accountScope: input.accountScope } : {}),
    usage: () => {
      const task = usageTaskOf(input.signal)?.task;
      return { bookId: input.book.id, bookName: input.book.name, ...(task ? { task } : {}) };
    },
  });
}

/** The context window of the model the room is routed to: what its material is sized for. */
export function roomWindow(settings: AppSettings): number | undefined {
  try {
    return estimateModelOf(pickAiRuntimeConfig(settings), WILDCARDS_CAPABILITY)?.maxInputTokens;
  } catch {
    return undefined;
  }
}

/** What a consultation will cost, before it runs: calls, tokens and money as an interval (`null` money when the room's model has no price). */
export function roomEstimate(settings: AppSettings, input: { voices: number; materialChars: number; contextChars?: number }): WildcardRoomEstimate {
  let model: ReturnType<typeof estimateModelOf> = null;
  try {
    model = estimateModelOf(pickAiRuntimeConfig(settings), WILDCARDS_CAPABILITY);
  } catch {
    model = null;
  }
  return estimateWildcardRoom({ ...input, model, ...(settings.costCurrency ? { currency: settings.costCurrency } : {}) });
}

/** The wildcards of a book read from files the caller has (the book's `wildcards/*.md`), over the account's and the built-in ones. */
export function roomPanelOf(settings: AppSettings, language: string | undefined, files: ReadonlyArray<{ path: string; content: string }>): WildcardProfile[] {
  const book = files.filter((file) => /^wildcards\/[^/]+\.md$/.test(file.path)).map((file) => parseWildcard(file.path.slice("wildcards/".length, -3), file.content, file.path));
  return mergeWildcards(language, { account: accountWildcardProfiles(settings), book });
}

/** The titles of the ideas rejected before, from the journal's text: the room is told not to give them again. */
export function rejectedFromJournal(text: string | null | undefined): string[] {
  return rejectedIdeas(parseIdeasJournal(text));
}

/** Consult the room about a part of a book on this device: the engine reads the book, the account adds the author's wildcards. Nothing is written. */
export async function consultBookRoom(input: Omit<WildcardConsultInput, "store" | "ai" | "account" | "bookId" | "windowTokens"> & { settings: AppSettings; book: BookEntry; branch: string; accountScope?: string | null }): Promise<WildcardConsultResult> {
  const { settings, book, branch, accountScope, ...rest } = input;
  const window = roomWindow(settings);
  return consultWildcards({
    ...rest,
    store: createBrowserBookStore(book, branch),
    ai: roomAi({ settings, book, ...(accountScope !== undefined ? { accountScope } : {}), ...(rest.signal ? { signal: rest.signal } : {}) }),
    account: accountWildcardProfiles(settings),
    bookId: book.id,
    ...(window ? { windowTokens: window } : {}),
  });
}
