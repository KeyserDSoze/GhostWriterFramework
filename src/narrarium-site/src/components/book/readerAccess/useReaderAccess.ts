import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Octokit } from "@octokit/rest";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import { classifyTokenKind, type GitHubTokenKind } from "@/github/bookRepository";
import { resolveGitHubRemoteToken, type BookEntry, type ReaderPasswordRecord } from "@/types/settings";
import { useGitHubRemoteAvailability } from "@/github/remoteAvailability";
import { readRunFailure, getPagesState, getRepositoryInfo, getWorkflowState, latestRuns, listPublishingRuns, listSecretNames, readPasswordVariable, readWorkflowFile, type PagesState, type RepositoryInfo, type WorkflowRun } from "@/readerAccess/api";
import { ReaderFlowError, classifyReaderFailure, type ReaderFailure } from "@/readerAccess/errors";
import { REPOSITORY_VISIBILITY_EVENT } from "@/repoVisibility/model";
import { classifyRunFailure, type RunFailureInfo } from "@/readerAccess/runFailure";
import { readerProtection, readerRecordsOf, withReaderRecords, type RemoteReaderState } from "@/readerAccess/model";
import { readerPublication, workflowPublishesPasswords } from "@/readerRun/publication";
import { isGoing } from "@/readerRun/model";
import { usePublicationRun } from "@/readerRun/usePublicationRun";
import { useOutsideCheck } from "@/readerRun/outsideStore";
import { publicationKey, usePublicationStore } from "@/readerRun/store";
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
  /** Why the latest run failed (read from the annotations of its jobs); `null` when it did not fail, or until it has been read. */
  runFailure: RunFailureInfo | null;
  failures: Partial<Record<ReaderPart, ReaderFailure>>;
  loadedAt: number | null;
}

const EMPTY: ReaderSnapshot = { repository: null, pages: null, remote: { secrets: null, listed: null }, runs: null, workflow: null, workflowState: null, runFailure: null, failures: {}, loadedAt: null };
/** A run that was already going when the card opened is followed only if it is recent: a run stuck in a queue for hours is not a publication in progress. */
const OBSERVE_WITHIN_MS = 2 * 3_600_000;

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
  // GitHub is asked only with a credential it accepts (remoteAvailability): a token it refused is no credential, as no token is.
  const remote = useGitHubRemoteAvailability(book, token);
  const usable = remote === "ready" || remote === "offline";
  const tokenKind: GitHubTokenKind = classifyTokenKind(token);
  const records = useMemo(() => readerRecordsOf(settings, book.owner, book.repo), [settings, book.owner, book.repo]);
  const [snapshot, setSnapshot] = useState<ReaderSnapshot>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<ReaderOperationKind | null>(null);
  const [outcome, setOutcome] = useState<{ kind: ReaderOperationKind; result: ReaderOperationResult; text: ReaderResultText } | null>(null);
  const octokitRef = useRef<Octokit | null>(null);
  const alive = useRef(true);
  const repo = useMemo(() => ({ owner: book.owner, repo: book.repo }), [book.owner, book.repo]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { octokitRef.current = usable ? createTrackedGitHubClient(token) : null; }, [token, usable]);

  const refresh = useCallback(async () => {
    const octokit = usable ? octokitRef.current ?? createTrackedGitHubClient(token) : null;
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
    setSnapshot((before) => ({ repository, pages, remote: { secrets, listed: variable ? variable.names : null }, runs, workflow, workflowState, runFailure: before.runFailure, failures, loadedAt: Date.now() }));
    setLoading(false);
  }, [token, usable, repo]);

  useEffect(() => { void refresh(); }, [refresh]);
  // A change of the repository's visibility (Book settings, GitHub tab) can stop Pages: the published side is read again.
  useEffect(() => {
    const again = () => { void refresh(); };
    window.addEventListener(REPOSITORY_VISIBILITY_EVENT, again);
    return () => window.removeEventListener(REPOSITORY_VISIBILITY_EVENT, again);
  }, [refresh]);

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
    // The newest run before the action: the run the action makes is the first one after it (run ids only grow), which no clock can tell.
    const baselineRunId = await latestRuns(operationDeps.octokit, operationDeps.repo).then((runs) => runs[0]?.id ?? 0, () => null);
    let result: ReaderOperationResult;
    try { result = await work(operationDeps); }
    catch { result = { ok: false, done: [], failed: { step: "check", failure: { kind: "other" } }, dispatched: false }; }
    if (!alive.current) return result;
    setOutcome({ kind, result, text: describeReaderResult(kind, result, tokenKind) });
    setBusy(null);
    await refresh();
    if (result.dispatched) beginPublication({ trigger: "dispatch", branch: operationDeps.branch, baselineRunId });
    return result;
  }, [deps, busy, refresh, tokenKind]);

  // The latest run failed: its annotations say why (a job that never started is explained only there).
  const trackedFailed = usePublicationStore((state) => state.entries[publicationKey(repo.owner, repo.repo)]);
  const failedRunId = trackedFailed?.state === "failed" && trackedFailed.runId !== undefined ? trackedFailed.runId : snapshot.runs?.[0]?.state === "failed" ? snapshot.runs[0].id : null;
  useEffect(() => {
    const octokit = octokitRef.current;
    if (failedRunId === null) { setSnapshot((before) => (before.runFailure ? { ...before, runFailure: null } : before)); return undefined; }
    if (!octokit || snapshot.runFailure?.runId === failedRunId) return undefined;
    let current = true;
    void readRunFailure(octokit, repo, failedRunId).then(
      (read) => { if (current && alive.current) setSnapshot((before) => ({ ...before, runFailure: classifyRunFailure(read) })); },
      () => { if (current && alive.current) setSnapshot((before) => ({ ...before, runFailure: { runId: failedRunId, cause: "unreadable", neverStarted: false } })); },
    );
    return () => { current = false; };
  }, [failedRunId, repo, snapshot.runFailure?.runId]);

  const publication = usePublicationRun({ repo, octokit: () => octokitRef.current, enabled: usable, onEnded: () => { void refresh(); } });
  const tracked = publication.tracked;
  const siteUrl = snapshot.pages?.status === "enabled" ? snapshot.pages.url : null;
  const outside = useOutsideCheck(siteUrl);
  const publicationId = publicationKey(repo.owner, repo.repo);

  function beginPublication(input: Parameters<typeof publication.begin>[0]) {
    outside.reset();
    publication.begin(input);
  }

  // A run that was already going when the card opened (someone else's push, an earlier click on another device) is followed too: nothing is asked when nothing is publishing.
  const latest = snapshot.runs?.[0];
  useEffect(() => {
    if (!latest || (latest.state !== "queued" && latest.state !== "running")) return;
    if (Date.now() - Date.parse(latest.createdAt) > OBSERVE_WITHIN_MS) return;
    const current = usePublicationStore.getState().entries[publicationId];
    if (current && (isGoing(current, Date.now()) || current.runId === latest.id)) return;
    publication.begin({ trigger: "observed", branch: snapshot.repository?.defaultBranch ?? "main", runId: latest.id });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, latest?.state, publicationId]);

  // The outside check is made once when a publication of a reader with passwords has succeeded: it is the proof of what the published reader does.
  const configured = readerProtection(snapshot.remote) === "protected";
  useEffect(() => {
    if (!tracked || tracked.state !== "succeeded" || tracked.outsideChecked || !siteUrl || !configured) return;
    usePublicationStore.getState().update(publicationId, (before) => ({ ...before, outsideChecked: true }));
    outside.reset();
    void outside.check();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked?.state, tracked?.outsideChecked, siteUrl, configured, publicationId]);

  // Whether the workflow that built the latest successful publication reads the passwords: a secret that no workflow reads protects nothing, so «protected» is
  // only said when the published reader was built by one that does (or the outside check says it).
  const [evidence, setEvidence] = useState<{ runId: number | null; reads: boolean | null } | null>(null);
  const builtCache = useRef(new Map<number, boolean>());
  const evidenceKey = `${latest?.id ?? 0}:${latest?.state ?? ""}:${tracked?.state ?? ""}`;
  useEffect(() => {
    const octokit = octokitRef.current;
    if (!configured || !octokit || snapshot.loadedAt === null) { setEvidence(null); return undefined; }
    let current = true;
    void (async () => {
      try {
        const success = latest?.state === "succeeded" ? latest : (await listPublishingRuns(octokit, repo, { success: true, perPage: 1 }))[0];
        if (!success) { if (current) setEvidence({ runId: null, reads: false }); return; }
        const cached = builtCache.current.get(success.id);
        const file = cached === undefined ? await readWorkflowFile(octokit, repo, success.headSha ?? "") : null;
        const reads: boolean = cached ?? Boolean(file?.present && workflowPublishesPasswords(file.content));
        builtCache.current.set(success.id, reads);
        if (current) setEvidence({ runId: success.id, reads });
      } catch { if (current) setEvidence({ runId: null, reads: null }); }
    })();
    return () => { current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, snapshot.loadedAt, evidenceKey, repo]);
  const publicationState = readerPublication({ remote: snapshot.remote, builtReadsPasswords: evidence?.reads ?? null, publishing: isGoing(tracked, Date.now()), outside: outside.result });
  const publicationReady = !configured || evidence !== null || outside.result !== null;

  return {
    token: usable,
    tokenKind,
    records,
    snapshot,
    loading,
    busy,
    outcome,
    dismissOutcome: () => setOutcome(null),
    refresh,
    /** Follows the publication of a commit that was just pushed to the branch the workflow runs from: its run is found by the commit, and followed until it ends. */
    watchCommit: (sha: string, branch?: string) => { beginPublication({ trigger: "push", branch: branch ?? snapshot.repository?.defaultBranch ?? "main", headSha: sha }); void refresh(); },
    /** The live state of the publication being followed (`tracked` is `null` when nothing is). */
    publication: { tracked, live: publication.live, going: publication.going, refreshNow: publication.refreshNow },
    outside: { ...outside, siteUrl },
    /** Whether the published reader asks for a password, from evidence and not from the secrets alone (see `readerPublication`). */
    readerState: publicationState,
    readerStateReady: publicationReady,
    add: (input: { label: string; value: string }) => run("add", (d) => addReaderPassword(d, input)),
    remove: (secretName: string) => run("remove", (d) => removeReaderPassword(d, secretName)),
    resume: (secretName: string) => run("resume", (d) => resumeReaderPassword(d, secretName)),
    republish: () => run("republish", (d) => republishReader(d)),
    enablePages: () => run("enable-pages", (d) => enableReaderPages(d)),
    disablePages: (options: DisablePagesOptions) => run("disable-pages", (d) => disableReaderPages(d, options)),
  };
}

export type ReaderAccess = ReturnType<typeof useReaderAccess>;
