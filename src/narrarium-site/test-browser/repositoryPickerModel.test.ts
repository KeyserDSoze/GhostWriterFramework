import { describe, expect, it } from "vitest";
import {
  addedRepositories,
  credentialCacheKey,
  decisionAction,
  decisionReady,
  defaultPickerMode,
  existingRepositoryOutcome,
  filterRepositories,
  formatPushed,
  rateLimitResetAt,
  resolvePickerMode,
  resolveRepositoryName,
  suggestRepositoryName,
  type PickerRepository,
} from "@/github/repositoryPickerModel";

// Every decision of the repository picker that needs no screen: which mode first, how the list is filtered, what is done with a repository that is there.

const repo = (owner: string, name: string, extra: Partial<PickerRepository> = {}): PickerRepository => ({ id: Math.abs([...`${owner}/${name}`].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)), owner, name, fullName: `${owner}/${name}`, private: true, canPush: true, pushedAt: "2026-11-20T10:00:00Z", description: null, defaultBranch: "main", archived: false, ...extra });

describe("the mode that comes first", () => {
  it("is the list of existing repositories when the credential reaches some", () => {
    expect(defaultPickerMode({ status: "ready", count: 3 })).toBe("existing");
  });
  it("is the creation of a new one when it reaches none", () => {
    expect(defaultPickerMode({ status: "ready", count: 0 })).toBe("create");
  });
  it("is the list while the first page is on its way, when there is nothing to read yet, and when it failed (so that a person with repositories never sees the form flip, and the failure is shown where it happened)", () => {
    for (const status of ["idle", "loading", "error"] as const) expect(defaultPickerMode({ status })).toBe("existing");
  });
  it("is what the person chose once they chose, whatever is listed", () => {
    expect(resolvePickerMode("create", { status: "ready", count: 40 })).toBe("create");
    expect(resolvePickerMode("existing", { status: "ready", count: 0 })).toBe("existing");
    expect(resolvePickerMode(null, { status: "ready", count: 0 })).toBe("create");
  });
});

describe("the name of a new repository", () => {
  it("is the one derived from the title until the person types, then what they typed, trimmed", () => {
    expect(resolveRepositoryName(null, "grande-libro-della-giungla")).toBe("grande-libro-della-giungla");
    expect(resolveRepositoryName("  il-mio ", "grande-libro")).toBe("il-mio");
    expect(resolveRepositoryName("", "grande-libro")).toBe("");
  });
  it("suggests the next free number when the name is taken", () => {
    expect(suggestRepositoryName("grande-libro")).toBe("grande-libro-2");
    expect(suggestRepositoryName("grande-libro", ["grande-libro-2", "Grande-Libro-3"])).toBe("grande-libro-4");
    expect(suggestRepositoryName("grande-libro-2", new Set(["grande-libro-2"]))).toBe("grande-libro-3");
    expect(suggestRepositoryName("")).toBe("book-2");
    expect(suggestRepositoryName("x".repeat(100)).length).toBeLessThanOrEqual(100);
  });
});

describe("filtering the list", () => {
  const items = [repo("ada", "grande-libro-della-giungla", { description: "Il romanzo" }), repo("ada", "notes"), repo("acme", "libro-di-ricette"), repo("acme", "il-giardino", { description: "Un grande libro" }), repo("ada", "Èra-nuova")];
  const names = (query: string) => filterRepositories(items, query).map((entry) => entry.fullName);

  it("returns everything, in order, for an empty query", () => {
    expect(names("")).toEqual(items.map((entry) => entry.fullName));
    expect(names("   ")).toEqual(items.map((entry) => entry.fullName));
  });
  it("needs every word, in the name, the owner or the description, without case or accents", () => {
    expect(names("grande libro")).toEqual(["ada/grande-libro-della-giungla", "acme/il-giardino"]);
    expect(names("ACME")).toEqual(["acme/libro-di-ricette", "acme/il-giardino"]);
    expect(names("era")).toEqual(["ada/Èra-nuova"]);
    expect(names("nothing here")).toEqual([]);
  });
  it("puts the names that start with the word first, then the ones that contain it, then the owner and the description, each group in the order of the list", () => {
    expect(names("libro")).toEqual(["acme/libro-di-ricette", "ada/grande-libro-della-giungla", "acme/il-giardino"]);
  });
  it("does not change the list it is given", () => {
    const copy = [...items];
    filterRepositories(items, "libro");
    expect(items).toEqual(copy);
  });
});

describe("what is done with a repository that is already there", () => {
  const outcome = (state: "book" | "empty" | "other", options: { overwrite?: boolean; canPush?: boolean | null; archived?: boolean } = {}) => existingRepositoryOutcome({ state, overwrite: options.overwrite ?? false, canPush: options.canPush ?? true, archived: options.archived ?? false });

  it("connects a book, whatever the toggle says: nothing of it is overwritten", () => {
    expect(outcome("book")).toEqual({ kind: "connect-book", readOnly: false });
    expect(outcome("book", { overwrite: true })).toEqual({ kind: "connect-book", readOnly: false });
  });
  it("says a book the credential cannot write to is connected read-only", () => {
    expect(outcome("book", { canPush: false })).toEqual({ kind: "connect-book", readOnly: true });
    expect(outcome("book", { archived: true })).toEqual({ kind: "connect-book", readOnly: true });
    expect(outcome("book", { canPush: null })).toEqual({ kind: "connect-book", readOnly: false });
  });
  it("fills an empty repository", () => {
    expect(outcome("empty")).toEqual({ kind: "publish-empty" });
    expect(outcome("empty", { overwrite: true })).toEqual({ kind: "publish-empty" });
  });
  it("asks for the replacement of a repository with other content, and does nothing until it is given", () => {
    expect(outcome("other")).toEqual({ kind: "needs-overwrite" });
    expect(outcome("other", { overwrite: true })).toEqual({ kind: "publish-overwrite" });
  });
  it("publishes nothing into a repository the credential cannot write to, or that is archived, even with the toggle on", () => {
    expect(outcome("empty", { canPush: false })).toEqual({ kind: "cannot-write" });
    expect(outcome("other", { canPush: false, overwrite: true })).toEqual({ kind: "cannot-write" });
    expect(outcome("empty", { archived: true })).toEqual({ kind: "cannot-write" });
  });
});

describe("the key of the cache", () => {
  it("is the account for the app and a hash for a token, never the token", () => {
    expect(credentialCacheKey({ app: true, login: "Ada", token: "ghu_secret" })).toBe("app:ada");
    const key = credentialCacheKey({ app: false, token: "ghp_secretsecretsecret" });
    expect(key).toMatch(/^pat#/);
    expect(key).not.toContain("secret");
    expect(credentialCacheKey({ app: false, token: "ghp_other" })).not.toBe(credentialCacheKey({ app: false, token: "ghp_secretsecretsecret" }));
    expect(credentialCacheKey({ app: false, token: "ghp_other" })).toBe(credentialCacheKey({ app: false, token: "ghp_other" }));
  });
});

describe("GitHub's limit and the dates", () => {
  const headers = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? null });
  it("reads the time the limit ends from the reset header, or from the seconds to wait", () => {
    expect(rateLimitResetAt(headers({ "x-ratelimit-reset": "1893456000" }))).toBe("2030-01-01T00:00:00.000Z");
    expect(rateLimitResetAt(headers({ "retry-after": "60" }), Date.parse("2030-01-01T00:00:00Z"))).toBe("2030-01-01T00:01:00.000Z");
    expect(rateLimitResetAt(headers({}))).toBeUndefined();
    expect(rateLimitResetAt(headers({ "x-ratelimit-reset": "soon" }))).toBeUndefined();
  });
  it("says when a repository was last pushed, in the language of the page", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(formatPushed("2026-11-24T10:00:00Z", "en", now)).toBe("2 hours ago");
    expect(formatPushed("2026-11-21T12:00:00Z", "en", now)).toBe("3 days ago");
    expect(formatPushed("2026-11-21T12:00:00Z", "it", now)).toBe("3 giorni fa");
    expect(formatPushed("2026-08-24T12:00:00Z", "en", now)).toBe("3 months ago");
    expect(formatPushed(null, "en", now)).toBe("");
    expect(formatPushed("never", "en", now)).toBe("");
  });
  it("lists the repositories that are books already, without case", () => {
    expect(addedRepositories([{ owner: "Ada", repo: "Book" }, { owner: "", repo: "" }])).toEqual(new Set(["ada/book"]));
  });
});

describe("whether the choice can be acted on", () => {
  const picked = repo("ada", "book");
  it("needs, for a new repository, a name GitHub accepts that is not taken", () => {
    const base = { mode: "create" as const, nameProblem: null, name: "libro", nameTaken: false, repository: null, outcome: null };
    expect(decisionReady(base)).toBe(true);
    expect(decisionReady({ ...base, name: "" })).toBe(false);
    expect(decisionReady({ ...base, nameProblem: "characters" })).toBe(false);
    expect(decisionReady({ ...base, nameTaken: true })).toBe(false);
  });
  it("needs, for one that is there, a repository whose outcome does something", () => {
    const base = { mode: "existing" as const, nameProblem: null, name: "book", nameTaken: false, repository: picked };
    expect(decisionReady({ ...base, outcome: { kind: "connect-book", readOnly: false } })).toBe(true);
    expect(decisionReady({ ...base, outcome: { kind: "publish-empty" } })).toBe(true);
    expect(decisionReady({ ...base, outcome: { kind: "publish-overwrite" } })).toBe(true);
    expect(decisionReady({ ...base, outcome: { kind: "needs-overwrite" } })).toBe(false);
    expect(decisionReady({ ...base, outcome: { kind: "cannot-write" } })).toBe(false);
    expect(decisionReady({ ...base, outcome: null })).toBe(false);
    expect(decisionReady({ ...base, repository: null, outcome: { kind: "publish-empty" } })).toBe(false);
  });
  it("names the action of the button from the outcome", () => {
    expect(decisionAction({ mode: "create", outcome: null })).toBe("create");
    expect(decisionAction({ mode: "existing", outcome: null })).toBe("choose");
    expect(decisionAction({ mode: "existing", outcome: { kind: "connect-book", readOnly: false } })).toBe("connectBook");
    expect(decisionAction({ mode: "existing", outcome: { kind: "publish-empty" } })).toBe("publish");
    expect(decisionAction({ mode: "existing", outcome: { kind: "publish-overwrite" } })).toBe("publishOverwrite");
  });
});
