import type { AppRouteContext, LoadedWriterContext } from "@/assistant/context";
import { readPageView } from "@/assistant/pages/view";
import type { LoadedPage, PageCapability, PageEnv, PageId } from "@/assistant/pages/types";
import type { AppSettings, BookEntry } from "@/types/settings";

/**
 * The pages that have a contract with the Copilot, and where each of them is. A page's contract is loaded with the first request made on it (or with the first
 * tool of it the Copilot is asked to run elsewhere): neither the app nor the Copilot's panel carries the pages it is never asked about.
 */

/** The tool of the Copilot's catalogue that changes the page the author is on (the batch of its proposing tool): what the author turns on or off in Settings. */
export const PAGE_TOOL = "edit-page";

const ROUTE_PAGES: Partial<Record<AppRouteContext["kind"], PageId>> = {
  "book-simulated-readers": "readers",
};

const LOADERS: Partial<Record<PageId, () => Promise<PageCapability>>> = {
  readers: () => import("@/assistant/pages/readers").then((module) => module.readersPage),
};

/** The words that name what a page is about, in English and in Italian: a request that has them, and changes something, is about that page. */
const PAGE_SUBJECTS: Partial<Record<PageId, RegExp>> = {
  readers: /(?<![\p{L}])(?:lettor[ei]|lettrice|lettrici|readers?|personas?)(?![\p{L}])/iu,
};

/** The page a request names by its subject: the page the author is on when it does, else the first that it names; `null` when it names none. */
export function pageIdForPrompt(prompt: string, current?: PageId | null): PageId | null {
  const names = (id: PageId) => Boolean(LOADERS[id] && PAGE_SUBJECTS[id]?.test(prompt));
  if (current && names(current)) return current;
  return pageIds().find(names) ?? null;
}

/** The page of a route that has a contract with the Copilot, or `null`. */
export function pageIdForRoute(route: AppRouteContext): PageId | null {
  const id = ROUTE_PAGES[route.kind] ?? null;
  return id && LOADERS[id] ? id : null;
}

/** Every page that has a contract, in the order the Copilot lists their tools. */
export function pageIds(): PageId[] {
  return Object.keys(LOADERS) as PageId[];
}

export async function loadPageCapability(id: PageId): Promise<PageCapability> {
  const load = LOADERS[id];
  if (!load) throw new Error(`No page of the Copilot is called ${id}.`);
  return load();
}

/** The language the author reads a proposal in: the request's when it is clearly Italian or English, else the app's. */
export function promptReadsItalian(prompt: string, settings: Pick<AppSettings, "ui">): boolean {
  if (/(?<![\p{L}])(?:il|lo|gli|di|del|della|dei|degli|che|non|sono|crea|creami|togli|leva|spegni|accendi|tutti|solo|lettori|lettore|voglio|fammi|metti|cambia|rendi|questo|questa)(?![\p{L}])/iu.test(prompt)) return true;
  if (/(?<![\p{L}])(?:the|and|of|create|make|turn|remove|only|all|readers?|please|want|change|set|this)(?![\p{L}])/iu.test(prompt)) return false;
  return settings.ui.language === "it";
}

export interface BookEnvInput {
  context: LoadedWriterContext;
  settings: AppSettings;
  book: BookEntry | null;
  branch: string;
  token: string;
  prompt: string;
  accountScope: string | null;
  signal?: AbortSignal;
}

/** What the tools of a page work on when the request was made elsewhere in the book: the book, and no view of the page. `null` without a book. */
export function bookEnv(input: BookEnvInput): PageEnv | null {
  const structure = input.context.structure;
  if (!input.book || !structure) return null;
  return { settings: input.settings, book: input.book, branch: input.branch, token: input.token, structure, context: input.context, prompt: input.prompt, italian: promptReadsItalian(input.prompt, input.settings), view: null, accountScope: input.accountScope, signal: input.signal };
}

/**
 * The page of a request, with what the Copilot sees of it: `null` when the route has no contract or no book is open. A state that cannot be read is left out (the
 * request goes on with the rest of the context, as it did before pages had one).
 */
export async function loadPage(input: BookEnvInput): Promise<LoadedPage | null> {
  const structure = input.context.structure;
  if (!input.context.route || !input.book || !structure) return null;
  const id = pageIdForRoute(input.context.route);
  if (!id) return null;
  const capability = await loadPageCapability(id);
  const env: PageEnv = { ...bookEnv(input)!, view: readPageView(id) };
  let state = "";
  try {
    state = await capability.state(env);
  } catch (error) {
    if (input.signal?.aborted) throw error;
  }
  return { id, capability, env, state, instruction: pageInstruction(capability) };
}

/** What the model is told of the page, in its instructions: the page's own lines, and that the page comes first (its state goes as data). */
export function pageInstruction(capability: Pick<PageCapability, "prompt">): string {
  return `CURRENT PAGE. ${capability.prompt}\nWork on this page first: a request that could be about it is about it. Everything else you can do stays available.`;
}
