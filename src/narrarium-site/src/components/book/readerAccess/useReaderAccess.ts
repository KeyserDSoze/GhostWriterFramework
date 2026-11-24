import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Octokit } from "@octokit/rest";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { classifyTokenKind, type GitHubTokenKind } from "@/github/bookRepository";
import { resolveGitHubRemoteToken, type BookEntry, type ReaderPasswordRecord } from "@/types/settings";
import { getPagesState, getRepositoryInfo, getWorkflowState, latestRuns, listSecretNames, readPasswordVariable, readWorkflowFile, type PagesState, type RepositoryInfo, type WorkflowRun } from "@/readerAccess/api";
import { ReaderFlowError, classifyReaderFailure, type ReaderFailure } from "@/readerAccess/errors";
import { readerRecordsOf, withReaderRecords, type RemoteReaderState } from "@/readerAccess/model";
import { addReaderPassword, disableReaderPages, enableReaderPages, removeReaderPassword, republishReader, resumeReaderPassword, type DisablePagesOptions, type ReaderOperationDeps, type ReaderOperationResult } from "@/readerAccess/operations";
import { describeReaderResult, type ReaderOperationKind, type ReaderResultText } from "@/readerAccess/messages";

export type ReaderPart = "repository" | "pages" | "secrets" | "variable" | "runs" | "workflow";

export interface ReaderSnapshot {
  repository: RepositoryInfo | null;
  pages: PagesState | null;
  remote: RemoteReaderState;
  runs: WorkflowRun[] | null;
  workflow: { present: boolean; content?: string } | null;
  /** `active`, `paused` (Pages was turned off), `missing`, or what GitHub says; `null` when it could not be read. */
  workflowState: string | null;
  failures: Partial<Record<ReaderPart, ReaderFailure>>;
  loadedAt: number | null;
}

const EMPTY: ReaderSnapshot = { repository: null, pages: null, remote: { secrets: null, listed: null }, runs: null, workflow: null, workflowState: null, failures: {}, loadedAt: null };
const POLL_MS = 6_000;
const POLL_LIMIT_MS = 15 * 60_000;

async function settle<T>(part: ReaderPart, step: ConstructorParameters<typeof ReaderFlowError>[0], work: Promise<T>, failures: ReaderSnapshot["failures"]): Promise<T | null> {
  try { return await work; }
  catch (error) {
    failures[part] = error instanceof ReaderFlowError ? error.failure : classifyReaderFailure(error, step);
    return null;
  }
}

/** Everything the panel shows about a GitHub book's reader, one place that reads it and one that changes it. Nothing here logs a password or a token. */
export function useReaderAccess(book: BookEntry) {
  const settings = useSettingsStore((state) => state.settings);
  const { save } = useSettings();
  const token = resolveGitHubRemoteToken(book, settings);
  const tokenKind: GitHubTokenKind = classifyTokenKind(token);
  const records = useMemo(() => readerRecordsOf(settings, book.owner, book.repo), [settings, book.owner, book.repo]);
  const [snapshot, setSnapshot] = useState<ReaderSnapshot>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<ReaderOperationKind | null>(null);
  const [outcome, setOutcome] = useState<{ kind: ReaderOperationKind; result: ReaderOperationResult; text: ReaderResultText } | null>(null);
  const [polling, setPolling] = useState(false);
  const octokitRef = useRef<Octokit | null>(null);
  const alive = useRef(true);
  const repo = useMemo(() => ({ owner: book.owner, repo: book.repo }), [book.owner, book.repo]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { octokitRef.current = token ? createTrackedGitHubClient(token) : null; }, [token]);

  const refresh = useCallback(async () => {
    const octokit = octokitRef.current ?? (token ? createTrackedGitHubClient(token) : null);
    if (!octokit) return;
    octokitRef.current = octokit;
    setLoading(true);
    const failures: ReaderSnapshot["failures"] = {};
    const [repository, pages, secrets, variable, runs, workflow, workflowState] = await Promise.all([
      settle("repository", "repository", getRepositoryInfo(octokit, repo), failures),
      settle("pages", "pages-read", getPagesState(octokit, repo), failures),
      settle("secrets", "secrets-list", listSecretNames(octokit, repo), failures),
      settle("variable", "variable-read", readPasswordVariable(octokit, repo), failures),
      settle("runs", "runs", latestRuns(octokit, repo), failures),
      settle("workflow", "workflow-read", readWorkflowFile(octokit, repo), failures),
      getWorkflowState(octokit, repo).catch(() => null),
    ]);
    if (!alive.current) return;
    setSnapshot({ repository, pages, remote: { secrets, listed: variable ? variable.names : null }, runs, workflow, workflowState, failures, loadedAt: Date.now() });
    setLoading(false);
  }, [token, repo]);

  useEffect(() => { void refresh(); }, [refresh]);

  const deps = useCallback((): ReaderOperationDeps | null => {
    const octokit = octokitRef.current;
    if (!octokit) return null;
    return {
      octokit,
      repo,
      branch: snapshot.repository?.defaultBranch ?? "main",
      records: {
        get: () => readerRecordsOf(useSettingsStore.getState().settings, repo.owner, repo.repo),
        set: async (next: ReaderPasswordRecord[]) => {
          const state = useSettingsStore.getState();
          state.patchSettings({ readerAccess: withReaderRecords(state.settings.readerAccess, repo.owner, repo.repo, next) });
          await save();
        },
      },
      // The sealed box is its own chunk: nothing of it is loaded until a password is saved.
      seal: async (value, publicKey) => (await import("@/readerAccess/sealedBox")).sealSecret(value, publicKey),
    };
  }, [repo, save, snapshot.repository?.defaultBranch]);

  const run = useCallback(async (kind: ReaderOperationKind, work: (deps: ReaderOperationDeps) => Promise<ReaderOperationResult>): Promise<ReaderOperationResult | null> => {
    const operationDeps = deps();
    if (!operationDeps || busy) return null;
    setBusy(kind);
    setOutcome(null);
    let result: ReaderOperationResult;
    try { result = await work(operationDeps); }
    catch { result = { ok: false, done: [], failed: { step: "check", failure: { kind: "other" } }, dispatched: false }; }
    if (!alive.current) return result;
    setOutcome({ kind, result, text: describeReaderResult(kind, result, tokenKind) });
    setBusy(null);
    await refresh();
    if (result.dispatched) setPolling(true);
    return result;
  }, [deps, busy, refresh, tokenKind]);

  // After a run is started (or while the latest one is still going), look at it every few seconds for a while, so that the status is the real one.
  const latest = snapshot.runs?.[0];
  const going = latest?.state === "queued" || latest?.state === "running";
  useEffect(() => {
    if (!(polling || going)) return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const octokit = octokitRef.current;
      if (!octokit || Date.now() - started > POLL_LIMIT_MS) { window.clearInterval(timer); setPolling(false); return; }
      void latestRuns(octokit, repo).then((runs) => {
        if (!alive.current) return;
        setSnapshot((before) => ({ ...before, runs }));
        if (runs[0] && runs[0].state !== "queued" && runs[0].state !== "running") { window.clearInterval(timer); setPolling(false); }
      }, () => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, going, repo]);

  return {
    token: Boolean(token),
    tokenKind,
    records,
    snapshot,
    loading,
    busy,
    outcome,
    dismissOutcome: () => setOutcome(null),
    refresh,
    add: (input: { label: string; value: string }) => run("add", (d) => addReaderPassword(d, input)),
    remove: (secretName: string) => run("remove", (d) => removeReaderPassword(d, secretName)),
    resume: (secretName: string) => run("resume", (d) => resumeReaderPassword(d, secretName)),
    republish: () => run("republish", (d) => republishReader(d)),
    enablePages: () => run("enable-pages", (d) => enableReaderPages(d)),
    disablePages: (options: DisablePagesOptions) => run("disable-pages", (d) => disableReaderPages(d, options)),
  };
}
