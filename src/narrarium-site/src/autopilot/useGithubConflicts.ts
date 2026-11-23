import { useCallback, useEffect, useReducer, useRef } from "react";
import type { GithubConflictsResponse, ResolveGithubConflictsResponse } from "narrarium-engine";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { CONFLICTS_PAGE, choose, chooseRest, emptyDraft, failureOf, knownOf, readiness, resolutionRequest, type Draft, type Failure, type Known, type Readiness, type Version } from "@/autopilot/githubConflicts";

/**
 * Where the author is in settling the conflicts of a book with GitHub: reading the list a page at a time, choosing, resolving, and what came of it.
 *
 * - `loading`: a page is being read (the first, or another).
 * - `list`: a page is on show and the author chooses; a failure that the author can act on (and still choose) is told above the actions.
 * - `resolving`: the request is with the server.
 * - `done`: the server resolved them.
 * - `failed`: there is no list to show: it could not be read, or there is nothing to settle, or the server cannot do it. The failure is told alone.
 */
export type Stage = "loading" | "list" | "resolving" | "done" | "failed";

interface State {
  stage: Stage;
  /** The page on show, as the server gave it: it is also what the author's choices belong to (its fingerprint). */
  listing: GithubConflictsResponse | null;
  /** The files of the pages that were read. */
  known: Known;
  draft: Draft;
  failure: Failure | null;
  /** GitHub changed again while the author chose: the choices were dropped, and this is the list as it is now. */
  again: boolean;
  /** The page being read, or on show. */
  offset: number;
  answer: ResolveGithubConflictsResponse | null;
}

const NOTHING_SEEN: Known = { total: 0, conflicts: new Map() };

const INITIAL: State = { stage: "loading", listing: null, known: NOTHING_SEEN, draft: emptyDraft, failure: null, again: false, offset: 0, answer: null };

/** The failures after which there is no more to do with the list: the book has nothing to settle, is not on GitHub, cannot be merged, is not there, or the server cannot do it. */
const ENDS_THE_LIST: ReadonlySet<Failure["kind"]> = new Set(["not-conflicted", "no-remote", "unrelated-histories", "feature-unavailable", "book-missing"]);

/** The failures about the choices the author made, which a new choice answers. */
const ABOUT_CHOICES: ReadonlySet<Failure["kind"]> = new Set(["choice-missing", "too-many"]);

type Action =
  | { type: "reading"; offset: number }
  | { type: "page"; listing: GithubConflictsResponse }
  | { type: "restart" }
  | { type: "failed"; failure: Failure }
  | { type: "choose"; path: string; version: Version }
  | { type: "rest"; version: Version | null }
  | { type: "resolving" }
  | { type: "done"; answer: ResolveGithubConflictsResponse }
  | { type: "changed"; listing: GithubConflictsResponse }
  | { type: "clear" };

/** The page that was read joins the files that were seen when it belongs to the list the author is choosing from (`fresh`: it does not, and starts a new list). */
function withPage(state: State, listing: GithubConflictsResponse, fresh: boolean): State {
  if (listing.total === 0) return { ...state, stage: "failed", listing, known: NOTHING_SEEN, draft: emptyDraft, failure: { kind: "not-conflicted" }, offset: 0 };
  return { ...state, stage: "list", listing, known: knownOf(listing.total, listing.conflicts, fresh ? undefined : state.known), draft: fresh ? emptyDraft : state.draft, failure: null, offset: listing.offset };
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "reading": return { ...state, stage: "loading", offset: action.offset, failure: null };
    case "page": {
      // The list is not the one the author was choosing from (GitHub moved): their choices are dropped, and they are told.
      const changed = state.listing !== null && state.listing.fingerprint !== action.listing.fingerprint;
      return { ...withPage(state, action.listing, changed || state.listing === null), again: changed || state.again };
    }
    // GitHub moved while the author went through the pages: what they chose belongs to a list that is not there any more.
    case "restart": return { ...state, listing: null, known: NOTHING_SEEN, draft: emptyDraft, again: true };
    case "failed": return { ...state, stage: ENDS_THE_LIST.has(action.failure.kind) || state.listing === null ? "failed" : "list", failure: action.failure };
    case "choose": return { ...state, draft: choose(state.draft, action.path, action.version), again: false, failure: state.failure && ABOUT_CHOICES.has(state.failure.kind) ? null : state.failure };
    case "rest": return { ...state, draft: chooseRest(state.draft, action.version), again: false, failure: state.failure && ABOUT_CHOICES.has(state.failure.kind) ? null : state.failure };
    case "resolving": return { ...state, stage: "resolving", failure: null };
    case "done": return { ...state, stage: "done", answer: action.answer, failure: null };
    case "changed": return { ...withPage(state, action.listing, true), again: action.listing.total > 0 };
    case "clear": return { ...state, failure: null };
  }
}

/** The conflicts the author sees, and what they can do about them. The window that shows it mounts it when it opens, so that every opening reads the list again. */
export function useGithubConflicts(bookId: string) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const latest = useRef(state);
  latest.current = state;
  const alive = useRef(true);
  const ticket = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Read the page that starts at `offset`. An answer that is not the last asked for is not heard. */
  const read = useCallback(async (offset: number): Promise<void> => {
    const mine = ++ticket.current;
    dispatch({ type: "reading", offset });
    try {
      const runtime = await loadAutopilotRuntime();
      const listing = await runtime.githubConflicts(bookId, { offset, limit: CONFLICTS_PAGE });
      if (!alive.current || mine !== ticket.current) return;
      const current = latest.current.listing;
      if (current && current.fingerprint !== listing.fingerprint && listing.offset !== 0) {
        dispatch({ type: "restart" });
        await read(0);
        return;
      }
      dispatch({ type: "page", listing });
    } catch (error) {
      if (!alive.current || mine !== ticket.current) return;
      dispatch({ type: "failed", failure: failureOf(error) });
    }
  }, [bookId]);

  useEffect(() => {
    void read(0);
  }, [read]);

  /** Send what the author chose. `confirm` is asked when a version for all the others is about to be applied to files the author did not look at one by one. */
  const resolve = useCallback(async (confirm: (version: Version, count: number) => boolean): Promise<void> => {
    const { draft, known, listing } = latest.current;
    if (!listing) return;
    const request = resolutionRequest(draft, known, listing.fingerprint);
    if (!request.ok) {
      dispatch({ type: "failed", failure: { kind: "too-many" } });
      return;
    }
    const { covered } = readiness(draft, known);
    if (draft.rest !== null && covered > 0 && !confirm(draft.rest, covered)) return;
    ticket.current += 1;
    dispatch({ type: "resolving" });
    try {
      const runtime = await loadAutopilotRuntime();
      const answer = await runtime.resolveGithubConflicts(bookId, request.request);
      if (alive.current) dispatch({ type: "done", answer });
    } catch (error) {
      if (!alive.current) return;
      const failure = failureOf(error);
      dispatch(failure.kind === "changed" && failure.listing ? { type: "changed", listing: failure.listing } : { type: "failed", failure });
    }
  }, [bookId]);

  return {
    state,
    readiness: readiness(state.draft, state.known) as Readiness,
    read,
    resolve,
    choose: useCallback((path: string, version: Version) => dispatch({ type: "choose", path, version }), []),
    chooseRest: useCallback((version: Version | null) => dispatch({ type: "rest", version }), []),
    clearFailure: useCallback(() => dispatch({ type: "clear" }), []),
  };
}
