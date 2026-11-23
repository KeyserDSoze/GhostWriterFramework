import { describe, expect, it } from "vitest";
import { ServerRequestError, type AutopilotErrorDetail, type AutopilotErrorKind, type GithubConflict, type GithubConflictsResponse, type ServerBookSync } from "narrarium-engine";
import {
  CONFLICTS_PAGE,
  MAX_CHOICES,
  choose,
  chooseRest,
  emptyDraft,
  failureOf,
  githubConflictsOfError,
  githubConflictsOfSync,
  githubConflictsSettled,
  knownOf,
  pageCount,
  pageRange,
  readiness,
  resolutionRequest,
  type Draft,
  type Known,
} from "@/autopilot/githubConflicts";

const conflict = (path: string, patch: Partial<GithubConflict> = {}): GithubConflict => ({ path, server: "modified", github: "modified", serverBytes: 1_200, githubBytes: 2_048, resolvable: true, ...patch });
const paths = (count: number, prefix = "notes/n-") => Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(5, "0")}.md`);

/** What the author has seen: the conflicts of the pages that were read, and how many there are in all. */
function seen(total: number, ...pages: GithubConflict[][]): Known {
  return knownOf(total, pages.flat());
}

const pick = (draft: Draft, version: "server" | "github", ...files: string[]): Draft => ({ ...draft, chosen: { ...draft.chosen, ...Object.fromEntries(files.map((file) => [file, version])) } });

describe("how many files the run stopped on", () => {
  it("is what the engine says of a conflict with GitHub, and only of that", () => {
    expect(githubConflictsOfError("conflict", { githubConflicts: 3 })).toBe(3);
    expect(githubConflictsOfError("conflict", { githubConflicts: 1 })).toBe(1);
    expect(githubConflictsOfError("conflict", { githubConflicts: 12_000 })).toBe(12_000);
  });

  it.each(["network", "auth", "rate_limit", "timeout", "truncated", "refused", "budget", "limit", "profile", "config", "provider", "unknown"] as AutopilotErrorKind[])("is nothing for a failure of kind %s, whatever its detail says", (kind) => {
    expect(githubConflictsOfError(kind, { githubConflicts: 3 })).toBeNull();
  });

  it("is nothing for the other conflict, the one of a file that changed while a step ran (it has no count)", () => {
    expect(githubConflictsOfError("conflict", {})).toBeNull();
    expect(githubConflictsOfError("conflict", undefined)).toBeNull();
    expect(githubConflictsOfError(undefined, { githubConflicts: 3 })).toBeNull();
  });

  it.each([0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null])("is nothing for a count that is not a whole number from one (%s)", (count) => {
    expect(githubConflictsOfError("conflict", { githubConflicts: count } as unknown as AutopilotErrorDetail)).toBeNull();
  });
});

describe("how many files the server's last sync says conflict", () => {
  const sync = (patch: Partial<ServerBookSync>): ServerBookSync => ({ at: "2026-11-21T10:00:00.000Z", ok: false, message: "The book changed on GitHub.", ...patch });

  it("is the count of a sync that failed on a conflict", () => {
    expect(githubConflictsOfSync(sync({ conflicts: 4 }))).toBe(4);
  });

  it("is nothing when there is no sync, no count, a count that is not one, or a sync that worked", () => {
    expect(githubConflictsOfSync(null)).toBeNull();
    expect(githubConflictsOfSync(undefined)).toBeNull();
    expect(githubConflictsOfSync(sync({}))).toBeNull();
    expect(githubConflictsOfSync(sync({ conflicts: 0 }))).toBeNull();
    expect(githubConflictsOfSync(sync({ conflicts: 2.5 }))).toBeNull();
    expect(githubConflictsOfSync(sync({ conflicts: "2" as unknown as number }))).toBeNull();
    expect(githubConflictsOfSync(sync({ ok: true, conflicts: 4 }))).toBeNull();
  });
});

describe("whether the conflicts the run stopped on have been settled since", () => {
  const FAILED_AT = "2026-11-21T10:00:00.000Z";
  const sync = (patch: Partial<ServerBookSync>): ServerBookSync => ({ at: "2026-11-21T10:05:00.000Z", ok: true, message: "The conflicts with GitHub were resolved and pushed.", ...patch });

  it("is when the server's last sync worked after the run stopped: a sync that works means there is no conflict left", () => {
    expect(githubConflictsSettled(FAILED_AT, sync({}))).toBe(true);
    expect(githubConflictsSettled(FAILED_AT, sync({ at: "2026-11-21T10:00:01.000Z" }))).toBe(true);
  });

  it("is not when the last sync is older than the error, or as old (it is the one that failed), failed, or says it met conflicts", () => {
    expect(githubConflictsSettled(FAILED_AT, sync({ at: "2026-11-21T09:59:59.000Z" }))).toBe(false);
    expect(githubConflictsSettled(FAILED_AT, sync({ at: FAILED_AT }))).toBe(false);
    expect(githubConflictsSettled(FAILED_AT, sync({ ok: false, message: "remote: Permission denied." }))).toBe(false);
    expect(githubConflictsSettled(FAILED_AT, sync({ ok: false, conflicts: 3 }))).toBe(false);
    expect(githubConflictsSettled(FAILED_AT, sync({ conflicts: 3 }))).toBe(false);
  });

  it("is not when nothing is known: no sync (the server forgot it when it restarted), no time of the error, or times that are not dates", () => {
    expect(githubConflictsSettled(FAILED_AT, null)).toBe(false);
    expect(githubConflictsSettled(FAILED_AT, undefined)).toBe(false);
    expect(githubConflictsSettled(null, sync({}))).toBe(false);
    expect(githubConflictsSettled("yesterday", sync({}))).toBe(false);
    expect(githubConflictsSettled(FAILED_AT, sync({ at: "later" }))).toBe(false);
  });
});

describe("the pages of the list", () => {
  it("are fifty files, like the list of the conflicts between a device and the server", () => {
    expect(CONFLICTS_PAGE).toBe(50);
    expect(MAX_CHOICES).toBe(5_000);
  });

  it("are counted from the total, and a list with none has none", () => {
    expect([0, 1, 50, 51, 100, 101, 5_000].map(pageCount)).toEqual([0, 1, 1, 2, 2, 3, 100]);
  });

  it("say which files of the list a page shows", () => {
    expect(pageRange(0, 50, 230)).toEqual({ from: 1, to: 50 });
    expect(pageRange(200, 30, 230)).toEqual({ from: 201, to: 230 });
    expect(pageRange(0, 1, 1)).toEqual({ from: 1, to: 1 });
    expect(pageRange(0, 0, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe("what the author has chosen, and whether it is enough to resolve", () => {
  it("is nothing at first, and a file without a version is not ready", () => {
    const known = seen(1, [conflict("plot.md")]);
    expect(readiness(emptyDraft, known)).toEqual({ ready: false, chosen: 0, left: 1, covered: 0 });
  });

  it("is ready when every file of a list that fits one page has a version", () => {
    const known = seen(3, [conflict("a.md"), conflict("b.md"), conflict("c.md")]);
    const draft = pick(emptyDraft, "server", "a.md", "b.md");
    expect(readiness(draft, known)).toMatchObject({ ready: false, chosen: 2, left: 1 });
    expect(readiness(choose(draft, "c.md", "github"), known)).toMatchObject({ ready: true, chosen: 3, left: 0 });
  });

  it("is not ready while there are files on pages the author has not read, though every file on the pages read has a version", () => {
    const first = paths(50).map((path) => conflict(path));
    const known = seen(120, first);
    const draft = pick(emptyDraft, "github", ...paths(50));
    expect(readiness(draft, known)).toEqual({ ready: false, chosen: 50, left: 70, covered: 0 });
    const all = seen(120, first, paths(70, "notes/m-").map((path) => conflict(path)));
    expect(readiness(pick(draft, "server", ...paths(70, "notes/m-")), all)).toMatchObject({ ready: true, left: 0, chosen: 120 });
  });

  it("is ready with a version for all the others, whatever has been read: it covers the files that have none", () => {
    const known = seen(1_200, paths(50).map((path) => conflict(path)));
    const draft = chooseRest(pick(emptyDraft, "server", "notes/n-00003.md"), "github");
    expect(readiness(draft, known)).toEqual({ ready: true, chosen: 1, left: 1_199, covered: 1_199 });
  });

  it("does not ask for a version for a file the server cannot choose for: it keeps the server's, whatever is asked", () => {
    const known = seen(3, [conflict("a.md"), conflict("b.md"), conflict("a\u0000b.md", { resolvable: false, reason: "unsafe-path" })]);
    const draft = pick(emptyDraft, "github", "a.md", "b.md");
    expect(readiness(draft, known)).toEqual({ ready: true, chosen: 2, left: 0, covered: 0 });
  });

  it("is ready when every conflict is one the server cannot choose for", () => {
    const known = seen(1, [conflict("docs", { resolvable: false, reason: "file-directory", server: "added", github: "added" })]);
    expect(readiness(emptyDraft, known)).toMatchObject({ ready: true, left: 0, covered: 0 });
  });

  it("takes the last choice for a file, and takes a version for all the others back", () => {
    const known = seen(1, [conflict("a.md")]);
    const twice = choose(choose(emptyDraft, "a.md", "server"), "a.md", "github");
    expect(twice.chosen).toEqual({ "a.md": "github" });
    const rest = chooseRest(emptyDraft, "server");
    expect(readiness(rest, known).ready).toBe(true);
    expect(readiness(chooseRest(rest, null), known).ready).toBe(false);
  });

  it("never changes the draft it was given", () => {
    const before = pick(emptyDraft, "server", "a.md");
    const snapshot = JSON.stringify(before);
    choose(before, "b.md", "github");
    chooseRest(before, "github");
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(JSON.stringify(emptyDraft)).toBe(JSON.stringify({ chosen: {}, rest: null }));
  });

  it("holds the conflicts of the pages that were read by their path, a page read again replacing its files", () => {
    const first = knownOf(3, [conflict("a.md"), conflict("b.md")]);
    const again = knownOf(3, [conflict("b.md", { server: "deleted", serverBytes: undefined }), conflict("c.md")], first);
    expect([...again.conflicts.keys()]).toEqual(["a.md", "b.md", "c.md"]);
    expect(again.conflicts.get("b.md")?.server).toBe("deleted");
    expect(again.total).toBe(3);
  });
});

describe("the request that resolves", () => {
  const FINGERPRINT = "fp-1";

  it("carries the fingerprint of the list the author saw, and the version of each file they chose", () => {
    const known = seen(2, [conflict("a.md"), conflict("b.md")]);
    const draft = choose(choose(emptyDraft, "a.md", "server"), "b.md", "github");
    expect(resolutionRequest(draft, known, FINGERPRINT)).toEqual({ ok: true, request: { fingerprint: FINGERPRINT, choices: { "a.md": "server", "b.md": "github" } } });
  });

  it("carries the version for all the others as the default, and only the files that differ from it as choices", () => {
    const known = seen(300, paths(50).map((path) => conflict(path)));
    const draft = chooseRest(pick(pick(emptyDraft, "github", "notes/n-00001.md", "notes/n-00002.md"), "server", "notes/n-00003.md"), "github");
    expect(resolutionRequest(draft, known, FINGERPRINT)).toEqual({ ok: true, request: { fingerprint: FINGERPRINT, default: "github", choices: { "notes/n-00003.md": "server" } } });
  });

  it("is a default alone when no file differs from it", () => {
    const known = seen(300, paths(50).map((path) => conflict(path)));
    expect(resolutionRequest(chooseRest(emptyDraft, "server"), known, FINGERPRINT)).toEqual({ ok: true, request: { fingerprint: FINGERPRINT, default: "server" } });
  });

  it("is a request with no choice at all when every conflict is one the server cannot choose for", () => {
    const known = seen(1, [conflict("docs", { resolvable: false, reason: "file-directory" })]);
    expect(resolutionRequest(emptyDraft, known, FINGERPRINT)).toEqual({ ok: true, request: { fingerprint: FINGERPRINT } });
  });

  it("never names a file the author has not seen, nor one the server cannot choose for", () => {
    const known = seen(2, [conflict("a.md"), conflict("fixed.md", { resolvable: false, reason: "not-a-file" })]);
    const draft = pick(emptyDraft, "github", "a.md", "fixed.md", "ghost.md");
    expect(resolutionRequest(draft, known, FINGERPRINT)).toEqual({ ok: true, request: { fingerprint: FINGERPRINT, choices: { "a.md": "github" } } });
  });

  it("does not send more choices than the server takes: with thousands of files chosen one by one, the version most of them have becomes the default", () => {
    const every = paths(MAX_CHOICES + 600);
    const known = seen(every.length, every.map((path) => conflict(path)));
    const exceptions = every.slice(0, 1_000);
    const draft = pick(pick(emptyDraft, "github", ...every.slice(1_000)), "server", ...exceptions);
    const result = resolutionRequest(draft, known, FINGERPRINT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.default).toBe("github");
    expect(Object.keys(result.request.choices ?? {})).toEqual(exceptions);
    expect(Object.values(result.request.choices ?? {}).every((version) => version === "server")).toBe(true);
  });

  it("says so when even the exceptions are more than the server takes", () => {
    const every = paths(MAX_CHOICES + 3_000);
    const known = seen(every.length, every.map((path) => conflict(path)));
    const draft = chooseRest(pick(emptyDraft, "server", ...every), "github");
    expect(resolutionRequest(draft, known, FINGERPRINT)).toEqual({ ok: false, reason: "too-many-choices" });
  });
});

describe("what a refusal of the server means", () => {
  const refuse = (status: number, code: string, details: Record<string, unknown> = {}, message = "The server said no.") => failureOf(new ServerRequestError(message, status, code, details));

  it.each([
    [409, "busy", "busy"],
    [409, "not_conflicted", "not-conflicted"],
    [409, "no_remote", "no-remote"],
    [409, "unrelated_histories", "unrelated-histories"],
    [503, "maintenance", "maintenance"],
    [501, "feature_unavailable", "feature-unavailable"],
    [404, "book_not_found", "book-missing"],
    [403, "scope", "forbidden"],
    [401, "unauthorized", "forbidden"],
  ])("%s %s is %s", (status, code, kind) => {
    expect(refuse(status, code).kind).toBe(kind);
  });

  it("is a server that cannot be reached, for a request that did not get there", () => {
    expect(refuse(0, "unreachable").kind).toBe("unreachable");
  });

  it("is the first page of the new list for conflicts that changed, with what the server said of it", () => {
    const listing = { conflicts: [conflict("a.md")], total: 4, offset: 0, limit: 50, ahead: 1, behind: 2, branch: "main", fingerprint: "fp-2" } satisfies GithubConflictsResponse;
    const failure = refuse(409, "conflicts_changed", listing);
    expect(failure).toEqual({ kind: "changed", listing });
  });

  it("is a refusal that changed nothing the author can use, when the new list is not there", () => {
    expect(refuse(409, "conflicts_changed", { total: "many" })).toEqual({ kind: "changed", listing: null });
    expect(refuse(409, "conflicts_changed")).toEqual({ kind: "changed", listing: null });
  });

  it("names the files without a version, and how many there are", () => {
    expect(refuse(400, "choice_missing", { paths: ["a.md", "b.md"], missing: 7 })).toEqual({ kind: "choice-missing", paths: ["a.md", "b.md"], missing: 7 });
    expect(refuse(400, "choice_missing", { paths: "a.md", missing: "7" })).toEqual({ kind: "choice-missing", paths: [], missing: 0 });
  });

  it("keeps the server's own sentence for a path GitHub holds that no copy can hold, and for a git that failed", () => {
    expect(refuse(422, "invalid_github_path", {}, "GitHub holds a file whose name cannot be written (a/..).")).toEqual({ kind: "invalid-path", detail: "GitHub holds a file whose name cannot be written (a/..)." });
    expect(refuse(502, "git_failed", {}, "fatal: unable to access GitHub")).toEqual({ kind: "git-failed", detail: "fatal: unable to access GitHub" });
  });

  it("is what an error says for anything else: an operation that holds the book, a failure that is not the server's, something nobody expected", () => {
    expect(refuse(400, "invalid_request", {}, "limit must be from 1 to 500")).toEqual({ kind: "other", message: "limit must be from 1 to 500", server: true });
    expect(failureOf(new Error("The book is being synced with the server: wait until it is done."))).toEqual({ kind: "other", message: "The book is being synced with the server: wait until it is done." });
    expect(failureOf("boom")).toEqual({ kind: "other", message: "boom" });
    expect(failureOf(undefined)).toEqual({ kind: "other", message: "" });
  });
});
