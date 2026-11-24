/**
 * The decisions of the repository picker (the shared choice between connecting a repository that is there and creating a new one), with no React and no
 * network: which mode comes first, how the list is filtered, what is done with the repository that was picked, and what name is suggested when a name
 * is taken. The component and the pages only show these and act on them.
 */

export interface PickerRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  /** Whether the credential may write to it (`permissions.push`); `null` when GitHub did not say. */
  canPush: boolean | null;
  pushedAt: string | null;
  description: string | null;
  defaultBranch: string;
  archived: boolean;
}

export type PickerMode = "existing" | "create";

export type ListingProgress = { status: "idle" } | { status: "loading" } | { status: "ready"; count: number } | { status: "error" };

/**
 * The mode shown when the person has not chosen one: the list of repositories when the credential reaches some, the creation of a new one when it reaches
 * none. While the first page is on its way (or failed) the list comes first: it says what is happening, and a person with repositories never sees the form flip.
 */
export function defaultPickerMode(listing: ListingProgress): PickerMode {
  return listing.status === "ready" && listing.count === 0 ? "create" : "existing";
}

export function resolvePickerMode(chosen: PickerMode | null, listing: ListingProgress): PickerMode {
  return chosen ?? defaultPickerMode(listing);
}

/** The name in the field: what the person typed, or the one derived from the title while they have not typed. */
export function resolveRepositoryName(typed: string | null, derived: string): string {
  return (typed ?? derived).trim();
}

const normalize = (text: string): string => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * The repositories whose `owner/name` (or description) contain every word of the query, accents and case aside. Those whose name starts with the first word
 * come first, then the ones whose name contains it, then the others; each group keeps the order of the list (the most recently pushed first).
 */
export function filterRepositories(items: readonly PickerRepository[], query: string): PickerRepository[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  const ranked: Array<{ item: PickerRepository; rank: number; index: number }> = [];
  items.forEach((item, index) => {
    const name = normalize(item.name);
    const full = normalize(item.fullName);
    const description = normalize(item.description ?? "");
    if (!words.every((word) => full.includes(word) || description.includes(word))) return;
    ranked.push({ item, index, rank: name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : full.includes(words[0]) ? 2 : 3 });
  });
  return ranked.sort((left, right) => left.rank - right.rank || left.index - right.index).map((entry) => entry.item);
}

/** What the repository that was picked holds: a Narrarium book (it has `book.md` at its root), nothing at all, or something else. */
export type ExistingState = "book" | "empty" | "other";

export type PickerContext = "add" | "attach";

export type ExistingOutcome =
  /** It is a book already: it is added as a book, and nothing in it is written. For a book of this device the repository is not written to either: the book of this device stays as it is. */
  | { kind: "connect-book"; readOnly: boolean }
  /** It is empty: the book is written into it. */
  | { kind: "publish-empty" }
  /** It holds something else: nothing is written until the person turns the replacement on. */
  | { kind: "needs-overwrite" }
  | { kind: "publish-overwrite" }
  /** The credential cannot write to it, so the book cannot be written into it. */
  | { kind: "cannot-write" };

/**
 * What is done with a repository that is already there. A book is always connected, never overwritten, whatever the toggle says. An empty repository is
 * filled. Anything else is replaced only when the person said so. A repository the credential cannot write to (or an archived one) can be connected as a
 * book (reading it works) but nothing can be published into it.
 */
export function existingRepositoryOutcome(input: { state: ExistingState; overwrite: boolean; canPush: boolean | null; archived: boolean }): ExistingOutcome {
  const readOnly = input.canPush === false || input.archived;
  if (input.state === "book") return { kind: "connect-book", readOnly };
  if (readOnly) return { kind: "cannot-write" };
  if (input.state === "empty") return { kind: "publish-empty" };
  return input.overwrite ? { kind: "publish-overwrite" } : { kind: "needs-overwrite" };
}

/** `name-2`, `name-3`... the first that is not in `taken` (compared without case), never longer than the 100 characters GitHub allows. */
export function suggestRepositoryName(name: string, taken: ReadonlySet<string> | readonly string[] = []): string {
  const used = new Set([...taken].map((entry) => entry.toLowerCase()));
  const base = name.trim().replace(/-\d+$/, "").slice(0, 96) || "book";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now() % 100000}`;
}

/** A short key for the credential, for the cache of the lists: the app connection is its account, a token is a hash of it (the token itself is never a key). */
export function credentialCacheKey(input: { app: boolean; login?: string; token: string }): string {
  if (input.app && input.login) return `app:${input.login.toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.token.length; index += 1) {
    hash ^= input.token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${input.app ? "app" : "pat"}#${hash.toString(36)}.${input.token.length}`;
}

/** The time GitHub's limit ends, from the headers of a refused request (`X-RateLimit-Reset` in seconds, or `Retry-After` in seconds from now). */
export function rateLimitResetAt(headers: { get(name: string): string | null }, now = Date.now()): string | undefined {
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d{1,12}$/.test(reset)) return new Date(Number(reset) * 1000).toISOString();
  const retry = headers.get("retry-after");
  if (retry && /^\d{1,6}$/.test(retry)) return new Date(now + Number(retry) * 1000).toISOString();
  return undefined;
}

/** «3 days ago» in the language of the page, from an ISO date: the unit is the largest that is not zero. */
export function formatPushed(iso: string | null, locale: string, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return formatter.format(Math.trunc(seconds / size), unit);
  return formatter.format(0, "minute");
}

/** `owner/name` of the repositories of a list that are already books of this app, compared without case. */
export function addedRepositories(books: ReadonlyArray<{ owner: string; repo: string }>): Set<string> {
  return new Set(books.filter((book) => book.owner && book.repo).map((book) => `${book.owner}/${book.repo}`.toLowerCase()));
}

/** What the picker hands to the page: what was chosen, and whether it can be acted on now. */
export interface RepositoryDecision {
  mode: PickerMode;
  /** The name of the repository to create, or of the one that was picked. */
  name: string;
  /** The owner of the one that was picked; for a new one, the owner chosen (`undefined`: the account of the credential). */
  owner?: string;
  repository: PickerRepository | null;
  /** What happens with the picked repository; `null` while it is being looked at, or in the creation mode. */
  outcome: ExistingOutcome | null;
  overwrite: boolean;
  /** Whether the page can go on: a valid name that is not known to be taken, or a repository whose outcome is something that can be done. */
  ready: boolean;
}

/** Whether the choice can be acted on: a new repository needs a name GitHub accepts that is not known to be taken; a picked one needs an outcome that does something. */
export function decisionReady(input: { mode: PickerMode; nameProblem: string | null; name: string; nameTaken: boolean; repository: PickerRepository | null; outcome: ExistingOutcome | null }): boolean {
  if (input.mode === "create") return Boolean(input.name) && !input.nameProblem && !input.nameTaken;
  return Boolean(input.repository && input.outcome && (input.outcome.kind === "connect-book" || input.outcome.kind === "publish-empty" || input.outcome.kind === "publish-overwrite"));
}

/** Which action the button of the page names: the page keeps its own words for creating, and the picker has the words for the others (`choose`: nothing is picked yet, or it is still being looked at). */
export function decisionAction(decision: Pick<RepositoryDecision, "mode" | "outcome">): "create" | "choose" | "connectBook" | "publish" | "publishOverwrite" {
  if (decision.mode === "create") return "create";
  if (!decision.outcome) return "choose";
  switch (decision.outcome.kind) {
    case "connect-book": return "connectBook";
    case "publish-overwrite": return "publishOverwrite";
    default: return "publish";
  }
}
