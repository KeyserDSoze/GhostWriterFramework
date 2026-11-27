import type { LoadedWriterContext } from "@/assistant/context";
import type { ScopedTool } from "@/assistant/scopedTools";
import type { BookStructure } from "@/types/book";
import type { AppSettings, BookEntry } from "@/types/settings";

/**
 * The contract of a page with the Copilot: what the Copilot sees of it (its state now, not only its address), the tools that work on it (listed first and chosen
 * first while the author is there) and a few lines that say what the page is. Every other tool of the Copilot stays available on every page.
 */

/** The pages of a book that have a contract with the Copilot. */
export type PageId = "readers" | "ghostwriters" | "director" | "evaluation-style" | "autopilot-settings" | "canon" | "assets";

/**
 * What the page shows the author right now that its files do not say (a filter, a selection), as the page publishes it on its root element: `data-copilot-page`
 * names the page and `data-copilot-view` holds a small JSON object (see `readPageView`).
 */
export type PageView = Record<string, string | number | boolean | string[]>;

/** What a page's state and its tools work on: the book as the Copilot loaded it for this request, and the request itself. */
export interface PageEnv {
  settings: AppSettings;
  book: BookEntry;
  branch: string;
  token: string;
  structure: BookStructure;
  context: LoadedWriterContext;
  /** The author's request, as written. */
  prompt: string;
  /** The words the author reads (a proposal, a refusal) are Italian. */
  italian: boolean;
  view: PageView | null;
  accountScope: string | null;
  signal?: AbortSignal;
}

export type PageTool = ScopedTool<never, PageEnv>;

export interface PageCapability {
  id: PageId;
  /** What the page is and how to work on it, for the model: a few lines of instructions. */
  prompt: string;
  /** What the Copilot sees of the page now: compact text, data of the book (never instructions), within the secret policy. */
  state(env: PageEnv): Promise<string>;
  /** The page's own tools: listed first and chosen first on the page; available on the other pages too. */
  tools: readonly PageTool[];
  /**
   * The tool of the Copilot's catalogue that the keyword rules choose on this page for a request about it, when the model cannot call tools (the rules of the
   * page come before the general ones); `null` when the request is not about the page.
   */
  fallbackToolId?(prompt: string): string | null;
  /** The page's tool that proposes its changes, and the JSON schema of its arguments: what a model that cannot call tools is asked to write (`pageChangesFromPrompt`). */
  proposeToolId?: string;
  proposeParameters?: Record<string, unknown>;
}

/** The page of a request, loaded: its contract, what the Copilot sees of it, and what its tools work on. */
export interface LoadedPage {
  id: PageId;
  capability: PageCapability;
  env: PageEnv;
  /** The state as the model reads it (empty when it could not be read: the request goes on without it). */
  state: string;
  /** What the model is told of the page, in its instructions (see `pageInstruction`). */
  instruction: string;
}
