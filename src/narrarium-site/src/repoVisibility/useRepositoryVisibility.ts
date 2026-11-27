import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Octokit } from "@octokit/rest";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { classifyTokenKind, type GitHubTokenKind } from "@/github/bookRepository";
import { useAppInstallations } from "@/github/useAppInstallations";
import { useSettingsStore } from "@/store/settingsStore";
import { resolveGitHubRemoteToken, type BookEntry } from "@/types/settings";
import { getPagesState, type PagesState } from "@/readerAccess/api";
import { readRepositoryVisibility, setRepositoryPrivate, type RepositoryVisibility } from "@/repoVisibility/api";
import { appAdministration, REPOSITORY_VISIBILITY_EVENT, visibilityAvailability, VisibilityFlowError, type VisibilityAvailability, type VisibilityFailure } from "@/repoVisibility/model";

export interface VisibilityChangeResult {
  now: "public" | "private";
  /** The Pages state read again after the change; `null`: it could not be read. */
  pages: PagesState | null;
}

const failureOf = (error: unknown): VisibilityFailure => (error instanceof VisibilityFlowError ? error.failure : { kind: "network" });

/** The visibility of a book's repository, read from GitHub, and the one action that changes it. An online action: nothing is queued, nothing fails silently. */
export function useRepositoryVisibility(book: BookEntry) {
  const settings = useSettingsStore((state) => state.settings);
  const token = resolveGitHubRemoteToken(book, settings);
  const tokenKind: GitHubTokenKind = classifyTokenKind(token);
  const repo = useMemo(() => ({ owner: book.owner, repo: book.repo }), [book.owner, book.repo]);
  const [info, setInfo] = useState<RepositoryVisibility | null>(null);
  const [loading, setLoading] = useState(false);
  const [readFailure, setReadFailure] = useState<VisibilityFailure | null>(null);
  const [changing, setChanging] = useState(false);
  const [changeFailure, setChangeFailure] = useState<VisibilityFailure | null>(null);
  const [result, setResult] = useState<VisibilityChangeResult | null>(null);
  const octokitRef = useRef<Octokit | null>(null);
  const alive = useRef(true);
  const installs = useAppInstallations(token || undefined, tokenKind === "app");

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { octokitRef.current = token ? createTrackedGitHubClient(token) : null; }, [token]);

  const read = useCallback(async (): Promise<RepositoryVisibility | null> => {
    const octokit = octokitRef.current ?? (token ? createTrackedGitHubClient(token) : null);
    // Offline there is nothing to ask: the card says so, and nothing is queued.
    if (!octokit || (typeof navigator !== "undefined" && navigator.onLine === false)) return null;
    octokitRef.current = octokit;
    setLoading(true);
    try {
      const value = await readRepositoryVisibility(octokit, repo);
      if (alive.current) { setInfo(value); setReadFailure(null); }
      return value;
    } catch (error) {
      if (alive.current) setReadFailure(failureOf(error));
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [token, repo]);

  useEffect(() => { void read(); }, [read]);

  const change = useCallback(async (makePrivate: boolean): Promise<boolean> => {
    const octokit = octokitRef.current;
    if (!octokit || changing) return false;
    setChanging(true);
    setChangeFailure(null);
    setResult(null);
    try {
      await setRepositoryPrivate(octokit, repo, makePrivate);
    } catch (error) {
      if (alive.current) { setChangeFailure(failureOf(error)); setChanging(false); }
      return false;
    }
    // What GitHub says now is what is shown: the repository is read again, and so is Pages when the repository became private.
    const value = await read();
    let pages: PagesState | null = null;
    if (makePrivate) pages = await getPagesState(octokit, repo).catch(() => null);
    if (alive.current) {
      setResult({ now: (value?.private ?? makePrivate) ? "private" : "public", pages });
      setChanging(false);
    }
    window.dispatchEvent(new CustomEvent(REPOSITORY_VISIBILITY_EVENT, { detail: { bookId: book.id } }));
    return true;
  }, [changing, read, repo, book.id]);

  const availability: VisibilityAvailability | null = info
    ? visibilityAvailability({ tokenKind, canAdminister: info.canAdminister, appAdministration: tokenKind === "app" ? appAdministration(installs.status === "ready" || installs.status === "error" ? installs.installations : null, book.owner) : "unknown" })
    : null;

  return {
    hasToken: Boolean(token),
    tokenKind,
    info,
    loading,
    readFailure,
    changing,
    changeFailure,
    dismissFailure: () => setChangeFailure(null),
    result,
    availability,
    appSettingsUrl: installs.status === "ready" ? installs.installations.find((entry) => entry.account.toLowerCase() === book.owner.toLowerCase())?.settingsUrl ?? null : null,
    refresh: () => { installs.reload(); return read(); },
    change,
  };
}
