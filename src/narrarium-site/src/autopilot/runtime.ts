import { AUTOPILOT_LOCK_PREFIX } from "@/branches/locks";
import {
  AutopilotBusyError,
  AutopilotSession,
  ServerRequestError,
  isRevisionCampaignErrorCode,
  pickAiRuntimeConfig,
  readStoredAutopilot,
  remoteBookStore,
  resolveAiCandidates,
  runnerActivity,
  serverHasCalls,
  syncBookStores,
  type AiPort,
  type AskDirectorResult,
  type AutopilotEvent,
  type AutopilotLiveOptions,
  type AutopilotSnapshot,
  type EvaluationTarget,
  type FrozenAction,
  type FrozenChangeKind,
  type FrozenStatus,
  type GithubConflictsResponse,
  type InterventionInput,
  type NarrariumServerClient,
  type QuestionAnswer,
  type ReviewBookInput,
  type ReviseChaptersInput,
  type RevisionCampaignResult,
  type ServerInfo,
  type ResolveGithubConflictsRequest,
  type ResolveGithubConflictsResponse,
  type ServerBookStorage,
  type ServerBookSummary,
  type ServerStreamMessage,
  type StartOptions,
} from "narrarium-engine";
import i18n from "@/i18n";
import { localDeviceId } from "@/account/deviceIdentity";
import { createBrowserAi } from "@/autopilot/browserAi";
// What each step of a run of this browser costs is kept with its step as its calls end, whether or not a band shows it.
import "@/autopilot/taskCosts";
import { LocalWorkingCopyMissingError, createBrowserBookStore } from "@/autopilot/browserStore";
import { selectAutopilotControl } from "@/autopilot/control";
import { HandoverCoordinator, HandoverConsentError, type HandoverOptions, type HandoverPorts, type HandoverRequest, type HandoverSide, type RunInspection, type RunOutcome } from "@/autopilot/handover";
import { setAutopilotHost } from "@/autopilot/host";
import { AutopilotOperationBusyError, BookOperations, type AutopilotOperationKind } from "@/autopilot/operations";
import { copyServerCalls, ensureCallsHost } from "@/autopilot/calls/host";
import { isRecording } from "@/autopilot/calls/recording";
import { pageEnding, setLocalRuns } from "@/autopilot/localRuns";
import { autoResumeOn, decideResume, forgetRun, interruptedRuns, noteResume, recentResumes, rememberRun, rememberStep, type ResumeDecision, type ResumeIntent } from "@/autopilot/resume";
import { wireBrowserCalls } from "@/autopilot/calls/wire";
import { PLAN_FULL_LIST_LIMIT } from "@/autopilot/planWindow";
import { AutopilotControlsUnsupportedError, hasRunLimit, serverHasQuickControls, type PauseCommand, type RunOneKind } from "@/autopilot/quickControls";
import { AutopilotRulesUnsupportedError, serverEditsRules } from "@/autopilot/rules";
import { AutopilotFrozenUnsupportedError, frozenErrorCode, serverHasFrozenChapters } from "@/autopilot/frozenChapters";
import { AutopilotCampaignRefusedError, AutopilotOutlineApplyUnsupportedError, AutopilotReviewUnsupportedError, campaignRefusal, serverHasOutlineApply } from "@/autopilot/campaign";
import { serverHasReviewBook } from "@/autopilot/reviewPolicy";
import { AutopilotRetryUnsupportedError, serverHasRetry } from "@/autopilot/retry";
import { assertGithubConflicts, githubConflictFiles, isGithubConflict, noteGithubConflict } from "@/autopilot/githubConflictsServer";
import { RefreshCoordinator } from "@/autopilot/refreshCoordinator";
import { ServerAddressError, validateServerAddress } from "@/autopilot/serverAddress";
import { ServerIdentityError, verifiedServer, type VerifiedServer, type VerifiedServerOptions } from "@/autopilot/serverIdentity";
import {
  autopilotChannel,
  emptyView,
  lastRunEnd,
  lastSignalAt,
  shareAutopilotEvent,
  useAutopilotStore,
  type AutopilotChannel,
  type AutopilotChannelMessage,
  type BookSyncStatus,
  type RelayedCommand,
  type SharedServerState,
  type SyncOutcome,
  type SyncOutcomeKind,
} from "@/autopilot/store";
import { rememberLearnedModel } from "@/autopilot/learnedModels";
import { StreamWatchdog } from "@/autopilot/streamWatchdog";
import { budgetsApply, startWithBudgets } from "@/autopilot/startBudgets";
import { latestSummary } from "@/autopilot/summary";
import { describeConflicts, recordedManifest } from "@/autopilot/syncConflicts";
import { SyncBaseError, readSyncBase, writeSyncBase } from "@/autopilot/syncBase";
import { ScreenWakeLock } from "@/autopilot/wakeLock";
import { resolveAuthoritativeBranch } from "@/github/branchResolution";
import { getLocalRepository, localStatus } from "@/repository/localRepository";
import { captureRepositoryOperationScope, currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { getExistingLocalBookStructure, pullRemoteChanges, syncFullRepository } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, resolveGitHubCredential, resolveGitHubRemoteToken, type BookEntry, type PersonalServerSettings } from "@/types/settings";
import { githubRemoteAvailability, isUsableGitHubToken } from "@/github/remoteAvailability";
import { isRepositoryError, repositoryErrorDescription } from "@/repository/repositoryError";

export type AutopilotSetupErrorCode = "no-server" | "book-missing" | "web-locks" | "other-tab" | "github-token";

export class AutopilotSetupError extends Error {
  constructor(readonly code: AutopilotSetupErrorCode) {
    super(i18n.t(SETUP_ERROR_KEYS[code]));
    this.name = "AutopilotSetupError";
  }
}

const SETUP_ERROR_KEYS: Record<AutopilotSetupErrorCode, string> = {
  "no-server": "autopilot.errors.noServer",
  "book-missing": "autopilot.errors.bookMissing",
  "web-locks": "autopilot.errors.webLocks",
  "other-tab": "autopilot.errors.otherTab",
  "github-token": "autopilot.errors.githubToken",
};

/** Files changed on both sides stop the hand-over of a book until the author chooses which version of each to keep. */
export class AutopilotSyncConflictsError extends Error {
  constructor(readonly purpose: "moveToServer" | "moveBack" | "frozen", readonly conflicts: string[]) {
    super(i18n.t(purpose === "moveToServer" ? "autopilot.errors.conflictsMoveToServer" : purpose === "frozen" ? "autopilot.errors.conflictsFrozen" : "autopilot.errors.conflictsMoveBack", { count: conflicts.length }));
    this.name = "AutopilotSyncConflictsError";
  }
}

/** The book stays on the server: what the server wrote is not safely in this browser yet. */
export class AutopilotMoveBackError extends Error {
  constructor(readonly code: "local-changes" | "server-publish", reason = "") {
    super(i18n.t(`autopilot.errors.moveBack.${code}`, { reason }));
    this.name = "AutopilotMoveBackError";
  }
}

/** Held for the whole of a run of a book: the automatic sync of the branches leaves the book alone meanwhile (`@/branches/autoSync`). */
const LOCK_PREFIX = AUTOPILOT_LOCK_PREFIX;
/** One lock per connection to the personal server: whoever holds it keeps the live connection for the whole browser. */
const STREAM_LOCK_PREFIX = "narrarium:autopilot-stream:";
const RELAY_TIMEOUT_MS = 4000;
/** The state of a book is a few kilobytes per chapter: while a long book runs it is downloaded no more often than this. */
const REFRESH_INTERVAL_WHILE_RUNNING_MS = 4000;
/** The server sends a `heartbeat` every 15 seconds: a connection that delivered nothing for three times as long is dead. */
const STREAM_IDLE_LIMIT_MS = 45_000;
/** A handover that waits for a run to end looks at it again this often, besides when the live events say it ended: a connection that lost an event must not hold the plan for ever. */
const HANDOVER_POLL_MS = 5000;
/** A run that cannot be seen this many times in a row is not waited for any longer: the plan fails and says why. */
const HANDOVER_UNSEEN_LIMIT = 3;
/** The lock of a book that another tab still holds when the plan wants to move it: how many times it is tried again, and how long the first wait is (it grows with each). */
const HANDOVER_LOCK_RETRIES = 4;
const HANDOVER_LOCK_WAIT_MS = 150;

function settings() {
  return useSettingsStore.getState().settings;
}

/** What the app did with a run that was interrupted: resumed it, waits to, or leaves it to the author (and why); `error` when its start failed. */
export interface ResumeReport {
  intent: ResumeIntent;
  decision: ResumeDecision;
  error?: string;
}

/** The writing AI of the autopilot is configured, with the credentials its first model needs: without them a resumed run would only fail. */
function autopilotAiReady(): boolean {
  const [first] = resolveAiCandidates(pickAiRuntimeConfig(settings()), "autopilot");
  if (!first) return false;
  const integration = first.integration;
  return integration.provider === "openai" || integration.provider === "azure_openai" ? Boolean(integration.apiKey?.trim()) : true;
}

export function findBook(bookId: string): BookEntry {
  const book = settings().books.find((entry) => entry.id === bookId);
  if (!book) throw new AutopilotSetupError("book-missing");
  return book;
}

/** Same branch rule as the book pages (`useWorkingBranch`). */
export function resolveBookBranch(book: BookEntry): string {
  const state = useBooksStore.getState();
  const structure = state.structures[book.id];
  return resolveAuthoritativeBranch({
    activeBranch: book.activeBranch,
    workingBranch: state.workingBranches[book.id],
    loadedBranch: structure?.loadedBranch,
    defaultBranch: structure?.defaultBranch,
    userEmail: useAuthStore.getState().user?.email,
  }).branch;
}

export function autopilotHostOf(book: BookEntry): "browser" | "server" {
  return book.autopilotHost === "server" ? "server" : "browser";
}

function hasServer(connection: PersonalServerSettings | undefined): connection is PersonalServerSettings {
  return Boolean(connection?.url.trim() && connection.token.trim());
}

function browserLabel(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "browser";
  return `Browser · ${platform}`;
}

/** The autopilot's saved state is damaged: raised by the engine here, answered as `state_corrupt` by the personal server. */
function isStateCorrupt(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "state_corrupt";
}

/** A run learned something about a model (the provider refused a thinking level because the request carries tools): the flag goes into the settings and the page says it, once. */
function learnedFromEvent(event: Extract<AutopilotEvent, { type: "model-learned" }>): void {
  rememberLearnedModel({ integrationId: event.integrationId, integrationName: event.integrationName, model: event.model, body: event.body, off: event.off, responses: event.responses });
}

/** Readable message for errors shown in the autopilot views. */
export function describeAutopilotError(error: unknown): string {
  if (error instanceof LocalWorkingCopyMissingError) return i18n.t("autopilot.errors.workingCopy");
  if (isStateCorrupt(error)) return i18n.t("autopilot.errors.stateCorrupt");
  if (error instanceof ServerIdentityError) return i18n.t(`personalServer.identity.${error.reason}`);
  if (error instanceof ServerAddressError) return i18n.t(`personalServer.address.${error.reason}`);
  if (error instanceof AutopilotBusyError) return i18n.t("autopilot.errors.busy", { label: error.runnerLabel });
  if (error instanceof AutopilotCampaignRefusedError) return i18n.t(`autopilot.campaign.errors.${error.code}`);
  const frozenCode = frozenErrorCode(error);
  if (frozenCode) return i18n.t(`autopilot.frozen.errors.${frozenCode}`);
  if (error instanceof ServerRequestError) {
    if (error.code === "unreachable") return i18n.t("autopilot.serverOffline");
    if (error.code === "book_not_found") return i18n.t("autopilot.where.serverBookMissing");
    if (error.code === "ai_not_configured") return `${error.message} ${i18n.t("personalServer.aiMissing")}`;
    if (error.code === "maintenance") return i18n.t("personalServer.updates.maintenance");
    const conflicts = githubConflictFiles(error);
    if (conflicts !== null) return i18n.t("autopilot.errors.githubConflict", { count: conflicts });
  }
  if (error instanceof Error && error.name === "AiUnavailableError") return i18n.t("autopilot.errors.aiMissing");
  if (isRepositoryError(error)) return repositoryErrorDescription(error, (key, options) => i18n.t(key, options));
  return error instanceof Error ? error.message : String(error);
}

function bookTitle(bookId: string): string {
  return settings().books.find((book) => book.id === bookId)?.name ?? bookId;
}

function locks(): LockManager | undefined {
  return (navigator as Navigator & { locks?: LockManager }).locks;
}

/** A short name for a connection that can go in a lock's name or a message to other tabs: the token must not. */
function hashKey(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    second = (second ^ (second >>> 13)) >>> 0;
  }
  return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}

/** Wait, but wake up when the signal aborts. */
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Resolves when the signal aborts, and not before. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function outcomeText(kind: SyncOutcomeKind, conflicts: number): string {
  switch (kind) {
    case "synced": return i18n.t("autopilot.where.synced");
    case "up-to-date": return i18n.t("autopilot.where.upToDate");
    case "published": return i18n.t("autopilot.where.published");
    case "partial": return i18n.t("autopilot.where.partial");
    case "local-changes": return i18n.t("autopilot.where.localChanges");
    case "conflicts": return i18n.t("autopilot.where.conflicts", { count: conflicts });
    default: return "";
  }
}

function syncOutcome(kind: SyncOutcomeKind, extra: Partial<SyncOutcome> = {}): SyncOutcome {
  const conflicts = extra.conflicts ?? [];
  return {
    ok: kind === "synced" || kind === "up-to-date" || kind === "published",
    kind,
    conflicts,
    conflictDetails: [],
    skipped: [],
    message: outcomeText(kind, conflicts.length),
    firstSync: false,
    uploaded: 0,
    downloaded: 0,
    baseSaved: true,
    ...extra,
  };
}

/** How a sync is asked for. */
interface SyncRequest {
  /** GitHub books: publish the browser's own commits first (otherwise they are only reported). */
  push?: boolean;
  /** Raise the error instead of only reporting it as the outcome. */
  throwOnError?: boolean;
  /** How to settle the files changed on both sides: the author's choices; without it they are left as they are. */
  resolve?: (path: string) => "local" | "remote" | "skip";
  message?: string;
}

/** What the runtime needs of its surroundings: the browser's, unless a test gives it others (the tabs of a browser, a fake server). */
export interface RuntimeEnvironment {
  /** The lock manager of this tab. */
  locks?: () => LockManager | undefined;
  /** The channel shared with the other tabs of this browser. */
  channel?: () => AutopilotChannel | null;
  /** Check the identity of the personal server and build its client. */
  connect?: (options: VerifiedServerOptions) => Promise<VerifiedServer>;
  /** How the plans to move the autopilot to the other side keep time (a test shortens them). */
  handover?: HandoverOptions & { pollMs?: number };
  /** The base delay of the engine before it retries a failed step, which the waits of «Retry later» scale with too (a test makes them long or short). */
  retryDelayMs?: number;
}

interface LocalSessionEntry {
  key: string;
  session: AutopilotSession;
  unsubscribe: () => void;
}

/** The live connection to the personal server as this tab follows it. */
interface FollowedStream {
  controller: AbortController;
  key: string;
  /** `key` as a short hash: what lock names and messages to the other tabs carry. */
  id: string;
  connection: PersonalServerSettings;
  /** The browser's tabs share one connection through a Web Lock: false for a tab that connects by itself. */
  shared: boolean;
  /** This tab holds the connection (always, when it is not shared). */
  leader: boolean;
  /** The tab heard a leader before: if it becomes the leader itself, messages were missed in the handover. */
  sawLeader: boolean;
  /** What the leader knows of the connection: what it tells a tab that asks. */
  known: SharedServerState;
}

export class BrowserAutopilotRuntime {
  private readonly sessions = new Map<string, LocalSessionEntry>();
  private readonly timers = new Map<string, number>();
  private readonly downloads = new RefreshCoordinator<AutopilotSnapshot | null>((bookId) => this.loadSnapshot(bookId));
  private readonly operations = new BookOperations((bookId, operation) => useAutopilotStore.getState().patchView(bookId, { operation }));
  private readonly screen = new ScreenWakeLock();
  private stream: FollowedStream | null = null;
  private unloadGuard = false;
  /** The plans to move the autopilot of a book to the other side of the browser/server pair, one for each book. */
  private readonly handovers: HandoverCoordinator;
  /** How each plan keeps the author's settings (the host of the book is one of them): the component that made the plan gives it. */
  private readonly handoverSavers = new Map<string, () => Promise<unknown>>();
  /** The books whose next start goes on past the budgets (`allowBudgetOverrun`). */
  private readonly budgetOverrun = new Set<string>();

  constructor(private readonly env: RuntimeEnvironment = {}) {
    this.channel()?.addEventListener("message", (message: MessageEvent<AutopilotChannelMessage>) => this.onChannelMessage(message.data));
    this.handovers = new HandoverCoordinator(this.handoverPorts(), env.handover);
  }

  /**
   * The AI of a run of this page. When the page ends (a reload, an update, a tab or a browser closed) the browser aborts the call in flight: that
   * failure does not answer, so the engine does not record the step as failed, and the step is the resumed run's to do again. A call the engine
   * abandons itself (a pause «now») ends as always, before and after.
   */
  private aiOfPage(ai: AiPort): AiPort {
    return {
      complete: (request) => ai.complete(request).catch((error: unknown) => {
        if (!pageEnding() || request.signal?.aborted) throw error;
        return new Promise<never>((_, reject) => request.signal?.addEventListener("abort", () => reject(error), { once: true }));
      }),
    };
  }

  private locks(): LockManager | undefined {
    return this.env.locks ? this.env.locks() : locks();
  }

  private channel(): AutopilotChannel | null {
    return this.env.channel ? this.env.channel() : autopilotChannel();
  }

  private connect(options: VerifiedServerOptions): Promise<VerifiedServer> {
    return (this.env.connect ?? verifiedServer)(options);
  }

  private post(message: AutopilotChannelMessage): void {
    try {
      this.channel()?.postMessage(message);
    } catch {
      // Another tab missing an update only delays its view until the next refresh.
    }
  }

  private onChannelMessage(data: AutopilotChannelMessage | undefined): void {
    switch (data?.kind) {
      case "command":
        void this.handleRelayedCommand(data.id, data.bookId, data.command);
        break;
      case "event":
        if (data.event) this.afterEvent(data.event.bookId, data.event, false);
        break;
      case "server-message":
        if (this.followsAs(data.stream, "follower")) {
          this.stream!.sawLeader = true;
          this.onServerMessage(data.message, true);
        }
        break;
      case "server-state":
        if (this.followsAs(data.stream, "follower")) {
          this.stream!.sawLeader = true;
          useAutopilotStore.getState().setServer(data.state);
          this.applyServerBooks(data.state.books);
        }
        break;
      case "server-state-request":
        if (this.stream && this.followsAs(data.stream, "leader")) this.publishState(this.stream);
        break;
      case "server-reconnect":
        // Another tab asked to connect again (after a connection test): the tab that holds the connection does it.
        if (this.stream && this.followsAs(data.stream, "leader")) this.reconnectServer();
        break;
      case "server-reconnected":
        if (this.stream && this.followsAs(data.stream, "follower")) this.afterReconnect(this.stream);
        break;
      case "live-request": {
        // A tab that opened while this one runs the book wants what the step shows: the live part, with the candidate the call asks (events only tell what changes).
        const live = this.sessions.get(data.bookId)?.session.running ? useAutopilotStore.getState().live[data.bookId] : null;
        if (live) this.post({ kind: "live", bookId: data.bookId, live });
        break;
      }
      case "synced":
        useAutopilotStore.getState().patchView(data.bookId, { sync: data.sync });
        if (data.sync.uploaded + data.sync.downloaded > 0) void this.reloadStructure(data.bookId);
        break;
      default:
        break;
    }
  }

  private followsAs(id: string, role: "leader" | "follower"): boolean {
    const stream = this.stream;
    return Boolean(stream && stream.shared && stream.id === id && stream.leader === (role === "leader"));
  }

  private debounce(key: string, delay: number, action: () => void): void {
    const previous = this.timers.get(key);
    if (previous) window.clearTimeout(previous);
    this.timers.set(key, window.setTimeout(() => {
      this.timers.delete(key);
      action();
    }, delay));
  }

  private localSession(book: BookEntry, branch: string): AutopilotSession {
    // The recording of the book's messages is chosen on this device, and the store the session records into is for the account the page is in: both are read when the session is made. A session
    // that is idle is made again when either changes; one that runs keeps them until its run ends.
    const key = `${book.id}:${branch}:${currentRepositoryScopeIdentity()}:${isRecording(book.id) ? "recording" : "not-recording"}`;
    const existing = this.sessions.get(book.id);
    if (existing && (existing.key === key || existing.session.running)) return existing.session;
    existing?.unsubscribe();
    // The step that runs: what its calls cost is counted as one task of the book's autopilot (`usage` of the AI port), whichever tab or page shows it.
    const running: { activity?: string } = {};
    const session = new AutopilotSession({
      bookId: book.id,
      store: createBrowserBookStore(book, branch),
      ai: this.aiOfPage(createBrowserAi({ usage: () => ({ bookId: book.id, bookName: bookTitle(book.id), origin: "autopilot", ...(running.activity ? { task: running.activity } : {}) }) })),
      host: "browser",
      hostLabel: browserLabel(),
      hostId: localDeviceId(),
      ...(this.env.retryDelayMs !== undefined ? { retryDelayMs: this.env.retryDelayMs } : {}),
      ownRunnerAlive: () => this.lockHeldElsewhere(book.id),
      // The engine decides which of the two is called, and when, from where the book is published (after every step, every chapter or never).
      hooks: bookStorageMode(book) === "github" ? {
        afterCommit: () => this.publishFromBrowser(book, branch),
        afterChapter: () => this.publishFromBrowser(book, branch),
      } : undefined,
      // The messages and the response of every AI call of this book's tasks, kept on this device (`autopilot/calls/wire.ts`): the engine's `calls`, `callsSecrets` and `callsAccountScope`,
      // none of them when the author turned the recording off for this book on this device or this browser keeps no IndexedDB (the run is the same either way).
      ...wireBrowserCalls({ bookId: book.id }),
    });
    // The store, and the copies to the place the author chose, are made ready with the session: a task that ends is queued for them by the store itself.
    void ensureCallsHost();
    const scope = currentRepositoryScopeIdentity();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "task-started") running.activity = event.activity.id;
      else if (event.type === "task-finished" || event.type === "run-ended") running.activity = undefined;
      // What a run says while its page ends is not shown here or in the other tabs, and changes nothing of what resumes it.
      if (pageEnding()) return;
      const title = bookTitle(book.id);
      useAutopilotStore.getState().ingest(event, title);
      shareAutopilotEvent(event, title);
      // What the app needs to resume the run if the page ends while it goes on: what it does now, and that it is over (paused, stopped, done).
      if (event.type === "task-started") rememberStep(scope, book.id, event.activity.title);
      else if (event.type === "run-ended") forgetRun(scope, book.id);
      this.afterEvent(book.id, event, true);
    });
    this.sessions.set(book.id, { key, session, unsubscribe });
    return session;
  }

  /**
   * Publish the book's commits of this browser to GitHub: what the engine asks for after a step or a chapter, as the author chose. Without GitHub (no credential,
   * one GitHub refused, offline) the commits wait in the working copy for the next step, chapter or sync, and the run goes on.
   */
  private async publishFromBrowser(book: BookEntry, branch: string): Promise<void> {
    const token = resolveGitHubRemoteToken(book, settings());
    if (githubRemoteAvailability(book, token) !== "ready") return;
    try {
      await syncFullRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity(), token });
    } catch (error) {
      // The engine reports a failed publication in the activity: in the author's words, not GitHub's.
      if (isRepositoryError(error)) throw new Error(repositoryErrorDescription(error, (key, options) => i18n.t(key, options)));
      throw error;
    }
    this.recordSync(book.id, syncOutcome("published"));
  }

  /**
   * Which events make the downloaded state out of date, and when it is worth downloading again. The `state` event of a
   * running book carries what the page shows of its status and statistics (see `latestSummary`), so it asks for nothing.
   * The end of a step brings the plan of the chapter that changed; for a long book that is a big download, so while the
   * run goes on it is asked for at most every few seconds. The start and the end of a run, and a state that is not
   * running (an answer, a pause, a change of settings), are downloaded at once.
   */
  private refreshAfterEvent(bookId: string, event: AutopilotEvent, delay: number): void {
    if (event.type === "state" && event.state.status === "running") return;
    if (event.type !== "task-finished" && event.type !== "state" && event.type !== "run-started" && event.type !== "run-ended") return;
    const spaced = event.type === "task-finished" && this.runningLongBook(bookId);
    this.downloads.schedule(bookId, { delay, minInterval: spaced ? REFRESH_INTERVAL_WHILE_RUNNING_MS : 0 });
  }

  /** The book is running, according to the newest of its last `state` event and its downloaded state, and its plan is long (as long as the page starts to list only a window of it). */
  private runningLongBook(bookId: string): boolean {
    const store = useAutopilotStore.getState();
    const downloaded = store.views[bookId]?.snapshot?.state ?? null;
    const live = store.summaries[bookId];
    const newest = live && (!downloaded || live.updatedAt >= downloaded.updatedAt) ? live : null;
    const chapters = Math.max(newest?.progress.chapters ?? 0, downloaded?.plan?.chapters.length ?? 0);
    return (newest?.status ?? downloaded?.status) === "running" && chapters > PLAN_FULL_LIST_LIMIT;
  }

  /** Refresh views and the book structure after meaningful events (from this tab or another one). */
  private afterEvent(bookId: string, event: AutopilotEvent, local: boolean): void {
    if (event.type === "task-progress") return;
    if (event.type === "model-learned") learnedFromEvent(event);
    this.refreshAfterEvent(bookId, event, 400);
    if (event.type === "task-finished" && event.activity.status === "succeeded" && event.activity.changedPaths?.some((path) => !path.startsWith("autopilot/"))) {
      this.debounce(`structure:${bookId}`, 1200, () => void this.reloadStructure(bookId));
    }
    if (local && event.type === "run-started") this.onLocalRunChanged();
    if (local && event.type === "run-ended") window.setTimeout(() => this.onLocalRunChanged(), 0);
  }

  private anyLocalRunning(): boolean {
    return [...this.sessions.values()].some((entry) => entry.session.running);
  }

  private onLocalRunChanged(): void {
    const running = this.anyLocalRunning();
    // What the update of the app and a page that cannot load must know before they reload the document.
    const runs = [...this.sessions].filter(([, entry]) => entry.session.running).map(([bookId]) => bookId);
    setLocalRuns(runs);
    if (running && !this.unloadGuard) {
      this.unloadGuard = true;
      window.addEventListener("beforeunload", this.beforeUnload);
    } else if (!running && this.unloadGuard) {
      this.unloadGuard = false;
      window.removeEventListener("beforeunload", this.beforeUnload);
    }
    // Keep the screen awake while this tab writes, so the device does not suspend the run.
    if (running) this.screen.start();
    else void this.screen.stop();
  }

  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    if (!this.anyLocalRunning()) return;
    event.preventDefault();
    event.returnValue = "";
  };

  private async reloadStructure(bookId: string): Promise<void> {
    try {
      const book = findBook(bookId);
      const loaded = await getExistingLocalBookStructure(book.id, book.owner, book.repo, resolveBookBranch(book), currentRepositoryScopeIdentity());
      if (loaded) useBooksStore.getState().setStructure(book.id, loaded.structure);
    } catch {
      // The pages reload the structure themselves when they open.
    }
  }

  /** The book's run belongs to another tab of this browser. */
  private async lockHeldElsewhere(bookId: string): Promise<boolean> {
    if (this.sessions.get(bookId)?.session.running) return false;
    const held = await this.locks()?.query?.().catch(() => null);
    const name = `${LOCK_PREFIX}${bookId}`;
    return Boolean(held?.held?.some((lock) => lock.name === name));
  }

  /**
   * Hold the book's lock for the whole of a move: no other tab of this browser can run the autopilot of the book,
   * or move it, until it is over (and the other way round). The tab that already runs the book here is told so by the caller.
   */
  private async holdingTheBook<T>(bookId: string, kind: AutopilotOperationKind, work: () => Promise<T>): Promise<T> {
    const manager = this.locks();
    if (!manager?.request) return work();
    return await manager.request(`${LOCK_PREFIX}${bookId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new AutopilotOperationBusyError(kind, "otherTab");
      return work();
    });
  }

  /**
   * Reload the snapshot shown by the autopilot page, the dock and the launcher. The downloads of a book never overlap:
   * asked while one is on its way, it runs once more right after it (the one in flight may have started before the change
   * the caller waits to see), unless the caller only wants to look (`join`), when the one on its way is enough.
   */
  refresh(bookId: string, options: { join?: boolean } = {}): Promise<AutopilotSnapshot | null> {
    return this.downloads.refresh(bookId, options);
  }

  private async loadSnapshot(bookId: string): Promise<AutopilotSnapshot | null> {
    const store = useAutopilotStore.getState();
    let book: BookEntry;
    try {
      book = findBook(bookId);
    } catch (error) {
      store.patchView(bookId, { error: describeAutopilotError(error), loading: false });
      return null;
    }
    store.patchView(bookId, { loading: true });
    try {
      if (autopilotHostOf(book) === "server") {
        const { client } = await this.requireServer();
        const snapshot = await client.autopilot(book.id);
        useAutopilotStore.getState().patchView(bookId, { snapshot, loading: false, error: null, busyInAnotherTab: false });
        return snapshot;
      }
      const session = this.localSession(book, resolveBookBranch(book));
      const snapshot = await session.snapshot();
      const busyInAnotherTab = !session.running && snapshot.state?.status === "running" && session.isOwnRunner(snapshot.state.runner) && await this.lockHeldElsewhere(book.id);
      useAutopilotStore.getState().patchView(bookId, { snapshot, loading: false, error: null, busyInAnotherTab });
      // The step that tab runs is shown from its own events on: what it is doing now is asked of it, so that a tab that opens in the middle of a step does not wait for the next one.
      if (busyInAnotherTab) this.post({ kind: "live-request", bookId });
      return snapshot;
    } catch (error) {
      useAutopilotStore.getState().patchView(bookId, { loading: false, error: describeAutopilotError(error) });
      return null;
    }
  }

  /**
   * What a command of the server answered: its snapshot, with the summary of its own session (the pause that waits, the limits of
   * the run, where the book is published). It is the newest thing known of the book, so it is also the summary the page follows.
   */
  private applySnapshot(bookId: string, snapshot: AutopilotSnapshot): void {
    useAutopilotStore.getState().patchView(bookId, { snapshot, error: null });
    const summary = snapshot.summary;
    if (summary) useAutopilotStore.setState((state) => ({ summaries: { ...state.summaries, [bookId]: summary } }));
  }

  start(bookId: string, options: StartOptions & { force?: boolean; afterRestart?: boolean } = {}): Promise<void> {
    return this.operations.run(bookId, "start", () => this.startNow(bookId, options));
  }

  /** Run one step, or one chapter, and pause: a start with that limit. The limit is for this run only; the next one has none unless it asks. */
  runOne(bookId: string, kind: RunOneKind): Promise<void> {
    return this.start(bookId, { limits: kind === "step" ? { steps: 1 } : { chapters: 1 } });
  }

  /**
   * The person chose to go on past the budgets: the next start of the book ignores them, that one only (`startWithBudgets`). It is for the start that was refused for them, or the
   * one that goes on after the engine stopped at the cap they gave.
   */
  allowBudgetOverrun(bookId: string): void {
    this.budgetOverrun.add(bookId);
  }

  private async startNow(bookId: string, requested: StartOptions & { force?: boolean; afterRestart?: boolean }): Promise<void> {
    const book = findBook(bookId);
    // The money cap the budgets leave (the engine's own cap, see `startWithBudgets`), from what the book holds now: a book without budgets is not read.
    const overrun = this.budgetOverrun.delete(bookId);
    if (budgetsApply(bookId)) await this.refresh(bookId, { join: true }).catch(() => null);
    const startOptions = startWithBudgets(book, requested, overrun);
    if (autopilotHostOf(book) === "server") {
      // Check the server before the book's changes are handed to it, and before a limit is asked of one that would not stop at it.
      const { info } = await this.requireServer();
      const { afterRestart: _local, ...options } = startOptions;
      const { limits, ...unlimited } = options;
      const limited = hasRunLimit(limits);
      if (limited && !serverHasQuickControls(info)) throw new AutopilotControlsUnsupportedError();
      if (options.options?.longRetry !== undefined && !serverHasRetry(info)) throw new AutopilotRetryUnsupportedError();
      await this.syncNow(book.id, { push: true, throwOnError: true });
      const { client } = await this.requireServer();
      this.applySnapshot(bookId, await client.startAutopilot(book.id, limited ? options : unlimited));
      return;
    }
    const options = startOptions;
    const session = this.localSession(book, resolveBookBranch(book));
    if (session.running) throw new AutopilotBusyError(browserLabel());
    const lockManager = this.locks();
    if (!lockManager?.request) throw new AutopilotSetupError("web-locks");
    await new Promise<void>((resolve, reject) => {
      lockManager.request(`${LOCK_PREFIX}${book.id}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(new AutopilotSetupError("other-tab"));
          return;
        }
        try {
          await session.start(options);
        } catch (error) {
          reject(error);
          return;
        }
        // This browser runs the book from now on, until the run ends: a page that ends meanwhile resumes it when the app starts again.
        if (session.running) rememberRun({ bookId: book.id, scope: currentRepositoryScopeIdentity(), since: new Date().toISOString() });
        resolve();
        await session.waitForIdle();
      }).catch(reject);
    });
    await this.refresh(bookId);
  }

  /**
   * Resume the runs of this account that this browser was running when the page ended (a reload, an update of the app, a browser closed or
   * crashed), each in the tab that gets the book's lock, for the books whose autopilot resumes by itself here (on unless the author turned it
   * off on this device). The rules are `decideResume`'s: never a run the author paused or stopped, nor one another tab or host runs; a wait while
   * the device is offline; the author told why when the working copy or the AI is missing, or after three resumes in ten minutes. A run that
   * resumes goes on from what the book saved (a step is saved whole or not at all), and says that it was resumed.
   */
  async resumeInterrupted(): Promise<ResumeReport[]> {
    const scope = currentRepositoryScopeIdentity();
    const reports: ResumeReport[] = [];
    for (const intent of interruptedRuns(scope)) reports.push(await this.resumeOne(intent, scope));
    return reports;
  }

  private async resumeOne(intent: ResumeIntent, scope: string): Promise<ResumeReport> {
    const book = settings().books.find((entry) => entry.id === intent.bookId) ?? null;
    const host = book ? autopilotHostOf(book) : null;
    let state: { status: string; ownRunner: boolean } | null = null;
    let workingCopy = false;
    let heldElsewhere = false;
    if (book && host === "browser") {
      const branch = resolveBookBranch(book);
      heldElsewhere = await this.lockHeldElsewhere(book.id);
      workingCopy = Boolean(await getExistingLocalBookStructure(book.id, book.owner, book.repo, branch, scope).catch(() => null));
      if (workingCopy && !heldElsewhere) {
        // The state as the book saved it: the session's snapshot shows a run of this host that nobody runs as paused («Interrupted»), which it is
        // to the author, while here it is the run to resume.
        const session = this.localSession(book, branch);
        const stored = await readStoredAutopilot(createBrowserBookStore(book, branch)).catch(() => null);
        const runner = stored?.state?.runner ?? null;
        state = stored?.state ? { status: stored.state.status, ownRunner: Boolean(runner && session.isOwnRunner(runner)) } : null;
      }
    }
    const decision = decideResume({
      host,
      autoResume: autoResumeOn(intent.bookId),
      online: typeof navigator === "undefined" || navigator.onLine !== false,
      settingsReady: useSettingsStore.getState().cloudLoaded,
      state,
      heldElsewhere,
      workingCopy,
      aiReady: autopilotAiReady(),
      resumes: recentResumes(scope, intent.bookId, Date.now()).length,
    });
    if (decision.kind === "skip" && decision.forget) forgetRun(scope, intent.bookId);
    if (decision.kind !== "resume") return { intent, decision };
    noteResume(scope, intent.bookId, Date.now());
    try {
      await this.start(intent.bookId, { afterRestart: true });
      return { intent, decision };
    } catch (error) {
      return { intent, decision, error: describeAutopilotError(error) };
    }
  }

  /**
   * Pause the run: `now` abandons the request in flight, `after-step` lets the step finish, `after-chapter` goes on to the end of the
   * chapter in progress, and `cancel` takes back a pause that waits. Never held back by an operation in progress: pausing is how the author
   * stops an expensive run. A run of another tab is commanded through that tab; on the server, a server that predates the quick controls
   * would take `after-chapter` for `after-step` and `cancel` for a pause, so those are not sent to it.
   */
  async pause(bookId: string, mode: PauseCommand): Promise<void> {
    const book = findBook(bookId);
    // The author who stops the run, or takes back the pause, while a switch waits for the step to end has changed their mind about it: the
    // switch is taken back first, so that it does not start the autopilot on the other side after the author stopped it.
    if ((mode === "now" || mode === "cancel") && this.handovers.plan(bookId)?.phase === "armed") await this.handovers.cancel(bookId);
    if (autopilotHostOf(book) === "server") {
      const { client, info } = await this.requireServer();
      if ((mode === "after-chapter" || mode === "cancel") && !serverHasQuickControls(info)) throw new AutopilotControlsUnsupportedError();
      this.applySnapshot(bookId, await client.pauseAutopilot(book.id, mode));
      return;
    }
    const session = this.sessions.get(book.id)?.session;
    if (session?.running) {
      if (mode === "cancel") session.cancelPause();
      else session.pause(mode);
      this.notePause(book.id, mode);
      return;
    }
    if (await this.lockHeldElsewhere(book.id)) await this.relay(book.id, mode === "cancel" ? { type: "cancel-pause" } : { type: "pause", mode });
  }

  /**
   * A run the author asks to pause is never resumed by itself, even when the page ends before the step it finishes: the intent goes at once, and
   * comes back if the author takes the pause back.
   */
  private notePause(bookId: string, mode: PauseCommand): void {
    const scope = currentRepositoryScopeIdentity();
    if (mode === "cancel") rememberRun({ bookId, scope, since: new Date().toISOString() });
    else forgetRun(scope, bookId);
  }

  /**
   * «Retry now»: end the wait before the next attempt of a failed step (a quick retry, or a restart of «Retry later»), so that the attempt starts
   * at once. Answers whether a wait was skipped: `false` when nothing waited (the wait was already over, or nothing runs), which is no error. Like a
   * pause it is never held back by an operation in progress. A run of another tab is asked through that tab; a server that predates the route is
   * not asked at all.
   */
  async retryNow(bookId: string): Promise<boolean> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      const { client, info } = await this.requireServer();
      if (!serverHasRetry(info)) throw new AutopilotRetryUnsupportedError();
      const { skipped, ...snapshot } = await client.retryNow(book.id);
      this.applySnapshot(bookId, snapshot);
      return skipped;
    }
    const session = this.sessions.get(book.id)?.session;
    if (session?.running) return session.retryNow();
    if (!(await this.lockHeldElsewhere(book.id))) return false;
    return (await this.relay(book.id, { type: "retry-now" })) === true;
  }

  /**
   * Change where the book is published, whether the run pauses after every chapter, what to do with a changed frozen chapter and «Retry later»,
   * also while the run goes on: it takes hold from the next step, or the next chapter (`longRetry` when a step has failed; `null` turns it off, and
   * stops a run that waits for it). A book run by the server needs a server that has the quick controls, and «Retry later» one that has it too; one
   * run by another tab of this browser is changed through that tab, which says it to the others.
   */
  updateOptions(bookId: string, options: AutopilotLiveOptions): Promise<void> {
    return this.operations.run(bookId, "configure", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        const { client, info } = await this.requireServer();
        if (!serverHasQuickControls(info)) throw new AutopilotControlsUnsupportedError();
        // A server that predates the frozen chapters refuses the whole request for a key it does not know.
        if (options.frozenEdits !== undefined && !serverHasFrozenChapters(info)) throw new AutopilotFrozenUnsupportedError();
        if (options.longRetry !== undefined && !serverHasRetry(info)) throw new AutopilotRetryUnsupportedError();
        this.applySnapshot(bookId, await client.updateOptions(book.id, options));
        return;
      }
      const session = this.localSession(book, resolveBookBranch(book));
      if (!session.running && await this.lockHeldElsewhere(book.id)) {
        await this.relay(book.id, { type: "update-options", options });
        return;
      }
      await session.updateOptions(options);
      await this.refresh(bookId);
    });
  }

  /**
   * Publish the book to GitHub now. A book this browser runs: its commits are published. A book the server runs: the server publishes
   * what it wrote first (it publishes by itself after the steps or the chapters the author chose, and this is the one that does not wait),
   * and then this browser pulls it. One operation of the book, like a sync.
   */
  publishNow(bookId: string): Promise<SyncOutcome> {
    return this.operations.run(bookId, "sync", async () => {
      const book = findBook(bookId);
      if (bookStorageMode(book) !== "github") throw new Error(i18n.t("autopilot.errors.notGitHub"));
      if (autopilotHostOf(book) === "server") {
        const { client } = await this.requireServer();
        await this.publishToGithub(book, client);
        return this.syncNow(bookId, { push: true, throwOnError: true });
      }
      const token = resolveGitHubRemoteToken(book, settings());
      if (!isUsableGitHubToken(token)) throw new AutopilotSetupError("github-token");
      await syncFullRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch: resolveBookBranch(book), accountIdentity: currentRepositoryScopeIdentity(), token });
      const outcome = syncOutcome("published");
      this.recordSync(bookId, outcome);
      return outcome;
    });
  }

  intervene(bookId: string, input: InterventionInput): Promise<void> {
    return this.operations.run(bookId, "intervene", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        useAutopilotStore.getState().patchView(bookId, { snapshot: await (await this.requireServer()).client.intervene(book.id, input) });
        return;
      }
      const session = this.localSession(book, resolveBookBranch(book));
      if (!session.running && await this.lockHeldElsewhere(book.id)) {
        await this.relay(book.id, { type: "intervene", input });
        return;
      }
      await session.intervene(input);
      await this.refresh(bookId);
    });
  }

  answer(bookId: string, answer: QuestionAnswer): Promise<void> {
    return this.operations.run(bookId, "answer", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        useAutopilotStore.getState().patchView(bookId, { snapshot: await (await this.requireServer()).client.answer(book.id, answer) });
        return;
      }
      await this.localSession(book, resolveBookBranch(book)).answer(answer);
      await this.refresh(bookId);
    });
  }

  configure(bookId: string, options: StartOptions): Promise<void> {
    return this.operations.run(bookId, "configure", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        const { client, info } = await this.requireServer();
        // «Retry later» goes only to a server that has it (the engine's client would refuse it, in its own words).
        if (options.options?.longRetry !== undefined && !serverHasRetry(info)) throw new AutopilotRetryUnsupportedError();
        useAutopilotStore.getState().patchView(bookId, { snapshot: await client.configureAutopilot(book.id, options) });
        return;
      }
      await this.localSession(book, resolveBookBranch(book)).configure(options);
      await this.refresh(bookId);
    });
  }

  /**
   * Change the text of the permanent rule at `index`, also while a run goes on (the run merges it when its step ends). `expectedText` is the
   * rule as the author saw it: a rule that changed in the meantime is never overwritten, and the refusal carries the engine's code
   * (`rule_changed`, `rule_not_found`, `rule_too_long`, `rule_duplicate`, `rule_empty`). A server that predates the rules is not asked.
   */
  updateRule(bookId: string, index: number, text: string, expectedText: string): Promise<void> {
    return this.operations.run(bookId, "configure", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        const { client, info } = await this.requireServer();
        if (!serverEditsRules(info)) throw new AutopilotRulesUnsupportedError();
        this.applySnapshot(bookId, await client.updateRule(book.id, index, text, expectedText));
        return;
      }
      await this.localSession(book, resolveBookBranch(book)).updateRule(index, text, expectedText);
      await this.refresh(bookId);
    });
  }

  /**
   * The changes of the frozen chapters of the book (and of the outline of its written chapters), with what can be done with each: the engine's
   * `frozenStatus`, which also refreshes the count the summary shows. A personal server that predates the frozen chapters is not asked.
   */
  async frozenStatus(bookId: string): Promise<FrozenStatus> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      const { client, info } = await this.requireServer();
      if (!serverHasFrozenChapters(info)) throw new AutopilotFrozenUnsupportedError();
      return client.frozenStatus(book.id);
    }
    return this.localSession(book, resolveBookBranch(book)).frozenStatus();
  }

  /**
   * Decide about the change of a frozen chapter (or of the outline of a written one), as the answer to its question would, also while a run goes
   * on: marking it reviewed is done at once, a review is recorded and carried out by the next run (by a run in progress, at its next step). A
   * book run by another tab of this browser is decided through that tab. On the personal server the author's latest edits are handed to it first
   * (it decides on its own copy of the book), and what it wrote comes back. The refusals keep the engine's code (`frozenErrorCode`).
   */
  resolveFrozenChange(bookId: string, number: number, action: FrozenAction, options: { kind?: FrozenChangeKind; note?: string } = {}): Promise<FrozenStatus> {
    return this.operations.run(bookId, "frozen", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        const { info } = await this.requireServer();
        if (!serverHasFrozenChapters(info)) throw new AutopilotFrozenUnsupportedError();
        await this.handToServer(book);
        const { client } = await this.requireServer();
        const status = await client.resolveFrozenChange(book.id, number, action, options);
        await this.bringFromServer(book, client);
        await this.refresh(bookId);
        return status;
      }
      const session = this.localSession(book, resolveBookBranch(book));
      let status: FrozenStatus;
      if (!session.running && await this.lockHeldElsewhere(book.id)) {
        await this.relay(book.id, { type: "resolve-frozen", number, action, options });
        status = await session.frozenStatus();
      } else {
        status = await session.resolveFrozenChange(number, action, options);
      }
      // Marking it reviewed wrote the chapter's chapter.md (the record of what it is now).
      if (action === "mark-reviewed") await this.reloadStructure(bookId);
      await this.refresh(bookId);
      return status;
    });
  }

  /**
   * Freeze a chapter by hand, as it is now (`by: author`: a change made to it is accepted as it is), or take its record away; the decisions that
   * waited for it are dropped. A book run by another tab is changed through that tab; on the personal server the author's latest edits are handed
   * over first, so that the server freezes the chapter as the author has it, and its chapter.md comes back.
   */
  setChapterFrozen(bookId: string, slug: string, frozen: boolean): Promise<void> {
    return this.operations.run(bookId, "frozen", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        const { info } = await this.requireServer();
        if (!serverHasFrozenChapters(info)) throw new AutopilotFrozenUnsupportedError();
        await this.handToServer(book);
        const { client } = await this.requireServer();
        await client.freezeChapter(book.id, slug, frozen);
        await this.bringFromServer(book, client);
        await this.refresh(bookId);
        return;
      }
      const session = this.localSession(book, resolveBookBranch(book));
      if (!session.running && await this.lockHeldElsewhere(book.id)) await this.relay(book.id, { type: "set-frozen", slug, frozen });
      else if (frozen) await session.freezeChapter(slug);
      else await session.unfreezeChapter(slug);
      await this.reloadStructure(bookId);
      await this.refresh(bookId);
    });
  }

  /**
   * Revise these chapters now, for this reason, in order, then go on with the plan: the engine's campaign (`reviseChapters`), the Synopsis applied to the book. It is
   * recorded also while a run goes on (the run takes it at its next step); a book run by another tab of this browser records it through that tab; on the personal server
   * the author's latest edits are handed to it first (it checks the campaign against its own copy of the book), a server that predates the campaigns is not asked, and what
   * it wrote comes back. A refusal of the engine, here or there, is an `AutopilotCampaignRefusedError` with its code. Nothing is started: `start` does it.
   */
  reviseChapters(bookId: string, input: ReviseChaptersInput): Promise<RevisionCampaignResult> {
    return this.operations.run(bookId, "campaign", () => this.campaignCommand(bookId, { type: "revise-chapters", input }));
  }

  /**
   * Review the finished book again to a target score: the engine's campaign of reason `review-target` (`reviewBook`), with the caps it is given (the options' own). The
   * same ways as `reviseChapters`; a personal server that predates it is not asked (`AutopilotReviewUnsupportedError`). Nothing is started: `start` does it.
   */
  reviewBook(bookId: string, input: ReviewBookInput): Promise<RevisionCampaignResult> {
    return this.operations.run(bookId, "campaign", () => this.campaignCommand(bookId, { type: "review-book", input }));
  }

  /** Cancel the chapters of the campaign that wait (the one being worked finishes): they are left for the author. The same ways as `reviseChapters`. */
  cancelRevisionCampaign(bookId: string): Promise<RevisionCampaignResult> {
    return this.operations.run(bookId, "campaign", () => this.campaignCommand(bookId, { type: "cancel-campaign" }));
  }

  private async campaignCommand(bookId: string, command: Extract<RelayedCommand, { type: "revise-chapters" | "review-book" | "cancel-campaign" }>): Promise<RevisionCampaignResult> {
    const book = findBook(bookId);
    try {
      if (autopilotHostOf(book) === "server") {
        const { info } = await this.requireServer();
        // Each command needs the feature of its campaign; a cancel, any campaign the server has.
        if (command.type === "review-book" && !serverHasReviewBook(info)) throw new AutopilotReviewUnsupportedError();
        if (command.type === "revise-chapters" && !serverHasOutlineApply(info)) throw new AutopilotOutlineApplyUnsupportedError();
        if (command.type === "cancel-campaign" && !serverHasOutlineApply(info) && !serverHasReviewBook(info)) throw new AutopilotOutlineApplyUnsupportedError();
        await this.handToServer(book);
        const { client } = await this.requireServer();
        const result = command.type === "revise-chapters" ? await client.reviseChapters(book.id, command.input) : command.type === "review-book" ? await client.reviewBook(book.id, command.input) : await client.cancelRevisionCampaign(book.id);
        await this.bringFromServer(book, client);
        await this.refresh(bookId);
        return result;
      }
      const session = this.localSession(book, resolveBookBranch(book));
      let result: RevisionCampaignResult;
      if (!session.running && await this.lockHeldElsewhere(book.id)) result = await this.relay(book.id, command) as RevisionCampaignResult;
      else result = command.type === "revise-chapters" ? await session.reviseChapters(command.input) : command.type === "review-book" ? await session.reviewBook(command.input) : await session.cancelRevisionCampaign();
      await this.refresh(bookId);
      return result;
    } catch (error) {
      throw campaignRefusal(error);
    }
  }

  /** The server decides on its own copy of the book: the author's latest edits go there first, and files changed on both sides stop the decision. */
  private async handToServer(book: BookEntry): Promise<void> {
    const outcome = await this.syncNow(book.id, { push: true, throwOnError: true });
    if (outcome.kind === "conflicts") throw new AutopilotSyncConflictsError("frozen", outcome.conflicts);
  }

  /** What the server wrote (a chapter frozen again, a record taken away) comes back to this browser: a GitHub book through GitHub. */
  private async bringFromServer(book: BookEntry, client: NarrariumServerClient): Promise<void> {
    if (bookStorageMode(book) === "github") await this.publishToGithub(book, client);
    await this.syncNow(book.id);
  }

  /** Remove the permanent rule at `index`, with the same guard as `updateRule`: the rules after it move up. */
  removeRule(bookId: string, index: number, expectedText: string): Promise<void> {
    return this.operations.run(bookId, "configure", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        const { client, info } = await this.requireServer();
        if (!serverEditsRules(info)) throw new AutopilotRulesUnsupportedError();
        this.applySnapshot(bookId, await client.removeRule(book.id, index, expectedText));
        return;
      }
      await this.localSession(book, resolveBookBranch(book)).removeRule(index, expectedText);
      await this.refresh(bookId);
    });
  }

  reset(bookId: string): Promise<void> {
    return this.operations.run(bookId, "reset", async () => {
      const book = findBook(bookId);
      if (autopilotHostOf(book) === "server") {
        useAutopilotStore.getState().patchView(bookId, { snapshot: await (await this.requireServer()).client.resetAutopilot(book.id) });
        return;
      }
      await this.localSession(book, resolveBookBranch(book)).reset();
      await this.refresh(bookId);
    });
  }

  /** "What does the director think?" — on the server when the book lives there, otherwise in the browser. */
  async askDirector(bookId: string, input: { target: EvaluationTarget; question?: string; save?: boolean; signal?: AbortSignal }): Promise<AskDirectorResult> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      await this.requireServer();
      // The director reads the server's copy: hand it the author's latest edits first.
      await this.syncWithServer(book.id, { push: true }).catch(() => undefined);
      const { client } = await this.requireServer();
      const result = await client.askDirector(book.id, { target: input.target, question: input.question, save: input.save }, input.signal);
      if (input.save) this.debounce(`server-sync:${bookId}`, 300, () => void this.syncInBackground(bookId));
      return result;
    }
    const result = await this.localSession(book, resolveBookBranch(book)).askDirector(input);
    if (input.save) this.debounce(`structure:${bookId}`, 300, () => void this.reloadStructure(bookId));
    return result;
  }

  /** The connection the runtime follows: an address typed in the settings counts only once `ensureServerStream` picked it up. */
  private currentConnection(): PersonalServerSettings | undefined {
    return this.stream?.connection ?? settings().personalServer;
  }

  /**
   * The personal server, after it proved the identity pinned in the settings: the only way the runtime
   * talks to it. Every request carries the client token, and some carry secrets (AI keys, GitHub token).
   */
  private async requireServer(): Promise<VerifiedServer> {
    const connection = this.currentConnection();
    if (!hasServer(connection)) throw new AutopilotSetupError("no-server");
    return this.connect({ connection });
  }

  /** Send a command to the tab that runs the book's autopilot: what it answers comes back (whether «Retry now» skipped a wait), or why it failed. */
  private relay(bookId: string, command: RelayedCommand): Promise<unknown> {
    const channel = this.channel();
    if (!channel) return Promise.reject(new AutopilotSetupError("other-tab"));
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const onMessage = (message: MessageEvent<AutopilotChannelMessage>) => {
        const data = message.data;
        if (data?.kind !== "command-result" || data.id !== id) return;
        window.clearTimeout(timer);
        channel.removeEventListener("message", onMessage as EventListener);
        if (data.ok) resolve(data.result);
        else if (isRevisionCampaignErrorCode(data.code)) reject(new AutopilotCampaignRefusedError(data.code, data.error ?? ""));
        else reject(new Error(data.error || i18n.t("autopilot.errors.action")));
      };
      const timer = window.setTimeout(() => {
        channel.removeEventListener("message", onMessage as EventListener);
        reject(new AutopilotSetupError("other-tab"));
      }, RELAY_TIMEOUT_MS);
      channel.addEventListener("message", onMessage as EventListener);
      channel.postMessage({ kind: "command", id, bookId, command } satisfies AutopilotChannelMessage);
    });
  }

  private async handleRelayedCommand(id: string, bookId: string, command: RelayedCommand): Promise<void> {
    const session = this.sessions.get(bookId)?.session;
    if (!session?.running) return;
    try {
      let result: boolean | RevisionCampaignResult | undefined;
      if (command.type === "pause") {
        session.pause(command.mode);
        this.notePause(bookId, command.mode);
      } else if (command.type === "cancel-pause") {
        session.cancelPause();
        this.notePause(bookId, "cancel");
      }
      else if (command.type === "retry-now") result = session.retryNow();
      else if (command.type === "update-options") await session.updateOptions(command.options);
      else if (command.type === "resolve-frozen") await session.resolveFrozenChange(command.number, command.action, command.options);
      else if (command.type === "set-frozen") await (command.frozen ? session.freezeChapter(command.slug) : session.unfreezeChapter(command.slug));
      else if (command.type === "revise-chapters") result = await session.reviseChapters(command.input);
      else if (command.type === "review-book") result = await session.reviewBook(command.input);
      else if (command.type === "cancel-campaign") result = await session.cancelRevisionCampaign();
      else await session.intervene(command.input);
      this.post({ kind: "command-result", id, ok: true, ...(result === undefined ? {} : { result }) });
    } catch (error) {
      const refusal = campaignRefusal(error);
      this.post({ kind: "command-result", id, ok: false, error: refusal instanceof AutopilotCampaignRefusedError ? refusal.message : describeAutopilotError(error), ...(refusal instanceof AutopilotCampaignRefusedError ? { code: refusal.code } : {}) });
    }
  }

  /**
   * Host the book's autopilot on the personal server. GitHub books travel through GitHub (the server
   * clones and pushes the same branch); local books are uploaded file by file with the shared sync.
   */
  moveToServer(bookId: string, consent: { sendAiConfiguration: boolean; sendGitHubToken: boolean }): Promise<void> {
    return this.operations.run(bookId, "moveToServer", () => {
      if (this.sessions.get(bookId)?.session.running) throw new AutopilotBusyError(browserLabel());
      return this.holdingTheBook(bookId, "moveToServer", () => this.moveToServerNow(bookId, consent));
    });
  }

  private async moveToServerNow(bookId: string, consent: { sendAiConfiguration: boolean; sendGitHubToken: boolean }): Promise<void> {
    const book = findBook(bookId);
    if (!hasServer(this.currentConnection())) throw new AutopilotSetupError("no-server");
    // The AI keys and the GitHub token are sent only to a server that proved the identity this device paired with.
    const { client: aiClient } = await this.requireServer();
    const branch = resolveBookBranch(book);
    if (consent.sendAiConfiguration) await aiClient.putAiConfig(pickAiRuntimeConfig(settings()));
    let storage: ServerBookStorage = { kind: "local" };
    let githubToken: string | undefined;
    if (bookStorageMode(book) === "github") {
      const token = resolveGitHubRemoteToken(book, settings());
      if (!isUsableGitHubToken(token)) throw new AutopilotSetupError("github-token");
      await syncFullRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity(), token });
      storage = { kind: "github", owner: book.owner, repo: book.repo, branch };
      if (consent.sendGitHubToken) githubToken = token;
    }
    // The publication above can take a while: the server proves itself again before it receives the book (and the token).
    const { client } = await this.requireServer();
    const summary = await client.registerBook(book.id, { title: book.name, storage, ...(githubToken ? { githubToken } : {}) });
    if (storage.kind === "local") {
      // Files the server already has and that differ from these are not overwritten: the author settles them first.
      const outcome = await this.syncNow(bookId, { message: "Upload from Narrarium", throwOnError: true });
      if (outcome.kind === "conflicts") throw new AutopilotSyncConflictsError("moveToServer", outcome.conflicts);
    }
    useAutopilotStore.getState().patchView(bookId, { server: summary, error: null });
    this.ensureServerStream();
  }

  /**
   * Sends the GitHub app's renewed access token to the server for every GitHub book it runs on that token. The token lasts 8 hours and the server cannot renew
   * it (it has no client secret and never receives the refresh token), so while a browser is open the server's copy is kept fresh. It only touches books the
   * server already holds a token for (the consent given when the book was moved there) and whose token is the app's; it never fails a caller.
   */
  async refreshServerGitHubToken(token: string): Promise<void> {
    if (!token || !hasServer(this.currentConnection())) return;
    for (const book of settings().books) {
      if (autopilotHostOf(book) !== "server" || bookStorageMode(book) !== "github" || resolveGitHubCredential(book, settings())?.source !== "app") continue;
      if (!useAutopilotStore.getState().views[book.id]?.server?.hasGithubToken) continue;
      try {
        const { client } = await this.requireServer();
        await client.registerBook(book.id, { title: book.name, storage: { kind: "github", owner: book.owner, repo: book.repo, branch: resolveBookBranch(book) }, githubToken: token });
      } catch {
        // The server may be away or busy: the next renewal sends it again.
      }
    }
  }

  /**
   * Bring the server's work back and run the autopilot in this browser again. The server lets the book go only after
   * its work was downloaded without conflicts (the author can choose to leave without it when the server cannot be reached).
   */
  moveToBrowser(bookId: string, options: { discardServerWork?: boolean } = {}): Promise<void> {
    return this.operations.run(bookId, "moveToBrowser", () => this.holdingTheBook(bookId, "moveToBrowser", () => this.moveToBrowserNow(bookId, options)));
  }

  private async moveToBrowserNow(bookId: string, options: { discardServerWork?: boolean }): Promise<void> {
    const book = findBook(bookId);
    const discard = options.discardServerWork === true;
    let client: NarrariumServerClient | null = null;
    let snapshot: AutopilotSnapshot | null = null;
    try {
      if (!hasServer(this.currentConnection())) throw new AutopilotSetupError("no-server");
      client = (await this.requireServer()).client;
      snapshot = await client.autopilot(book.id);
    } catch (error) {
      if (!(error instanceof ServerRequestError && error.code === "book_not_found") && !discard) throw error;
      client = null;
      snapshot = null;
    }
    if (snapshot?.running) throw new AutopilotBusyError(i18n.t("autopilot.host.server"));
    if (snapshot && client && !discard) await this.downloadServerWork(book, client);
    useAutopilotStore.getState().patchView(bookId, { server: null, error: null });
  }

  /** The server's latest work, in this browser, or an error saying why not. */
  private async downloadServerWork(book: BookEntry, client: NarrariumServerClient): Promise<void> {
    if (bookStorageMode(book) === "github") {
      // The server publishes what it wrote to GitHub, where this browser pulls it from.
      try {
        await this.publishToGithub(book, client);
      } catch (error) {
        throw new AutopilotMoveBackError("server-publish", describeAutopilotError(error));
      }
    }
    const outcome = await this.syncNow(book.id, { throwOnError: true });
    if (outcome.kind === "conflicts") throw new AutopilotSyncConflictsError("moveBack", outcome.conflicts);
    if (outcome.kind === "local-changes") throw new AutopilotMoveBackError("local-changes");
  }

  /**
   * Exchange work with the server. Local books: two-way file sync. GitHub books: the server pushes
   * to GitHub, so the browser pulls (and, with `push`, first publishes its own commits). The outcome says what
   * happened; with `throwOnError` (the default with `push`) a failure is raised instead of only being reported.
   */
  syncWithServer(bookId: string, options: { push?: boolean; throwOnError?: boolean } = {}): Promise<SyncOutcome> {
    return this.operations.run(bookId, "sync", () => this.syncNow(bookId, { push: options.push, throwOnError: options.throwOnError ?? options.push === true }));
  }

  /** Sync again, settling the files that changed on both sides as the author chose: `local` keeps this device's version, `remote` the server's. */
  resolveSyncConflicts(bookId: string, choices: Record<string, "local" | "remote">): Promise<SyncOutcome> {
    const chosen = new Map(Object.entries(choices));
    return this.operations.run(bookId, "sync", () => this.syncNow(bookId, { throwOnError: true, resolve: (path) => chosen.get(path) ?? "skip", message: "Settle conflicts from Narrarium" }));
  }

  /**
   * One page of the files that changed both on the server and on GitHub: the server's own list (`GET …/github-conflicts`), made after a fetch and a merge that writes nothing.
   * Looking changes nothing, so it does not hold the book. A server that does not announce the feature is refused before anything is sent.
   */
  async githubConflicts(bookId: string, page: { offset?: number; limit?: number } = {}): Promise<GithubConflictsResponse> {
    const { client, info } = await this.requireServer();
    assertGithubConflicts(info);
    return client.listGithubConflicts(findBook(bookId).id, page);
  }

  /**
   * Resolve them with the version the author chose of each file (`POST …/github-conflicts/resolve`): the server makes one merge commit and, when the book is published, pushes it.
   * One operation of the book, so that nothing else is started on it meanwhile. The run is not started again: the author resumes it. The summary of the book on the server is
   * read again, so that the notice of the conflicts goes away at once.
   */
  resolveGithubConflicts(bookId: string, request: ResolveGithubConflictsRequest): Promise<ResolveGithubConflictsResponse> {
    return this.operations.run(bookId, "githubConflicts", async () => {
      const { client, info } = await this.requireServer();
      assertGithubConflicts(info);
      const answer = await client.resolveGithubConflicts(findBook(bookId).id, request);
      await client.listBooks().then((books) => this.applyServerBooks(books)).catch(() => undefined);
      return answer;
    });
  }

  /** Ask the server to pull and push the book now. A conflict with GitHub that it answers is kept in the summary of the book (`lastSync`), where «Where it runs» reads it. */
  private async publishToGithub(book: BookEntry, client: NarrariumServerClient): Promise<void> {
    try {
      await client.syncGitHub(book.id);
    } catch (error) {
      noteGithubConflict(book.id, error);
      throw error;
    }
  }

  /** A sync nobody asked for (after a step of the server): it gives way, doing nothing, to whatever else holds the book. */
  private async syncInBackground(bookId: string): Promise<void> {
    try {
      await this.operations.runAutomatic(bookId, "sync", () => this.syncNow(bookId));
    } catch {
      // The outcome is in the book's view.
    }
  }

  private recordSync(bookId: string, outcome: SyncOutcome): void {
    const sync: BookSyncStatus = { ...outcome, at: new Date().toISOString() };
    useAutopilotStore.getState().patchView(bookId, { sync });
    this.post({ kind: "synced", bookId, sync });
  }

  private async syncNow(bookId: string, request: SyncRequest = {}): Promise<SyncOutcome> {
    const book = findBook(bookId);
    if (!hasServer(this.currentConnection())) throw new AutopilotSetupError("no-server");
    let outcome: SyncOutcome;
    try {
      outcome = bookStorageMode(book) === "github" ? await this.syncRepository(book, request) : await this.syncFiles(book, request);
    } catch (error) {
      const failed = syncOutcome("error", { message: describeAutopilotError(error) });
      this.recordSync(bookId, failed);
      if (request.throwOnError) throw error;
      return failed;
    }
    this.recordSync(bookId, outcome);
    if (outcome.uploaded + outcome.downloaded > 0) await this.reloadStructure(bookId);
    return outcome;
  }

  /** A local book: the files of the browser's working copy and of the server, three ways against the base of the last sync. */
  private async syncFiles(book: BookEntry, request: SyncRequest): Promise<SyncOutcome> {
    const branch = resolveBookBranch(book);
    const { client, info } = await this.requireServer();
    const { base, found } = await readSyncBase(info.serverId, book.id);
    const local = recordedManifest(createBrowserBookStore(book, branch));
    const remote = recordedManifest(remoteBookStore(client, book.id));
    const result = await syncBookStores({ local: local.store, remote: remote.store, base, resolveConflict: request.resolve, message: request.message ?? "Sync with the personal server" });
    // Not saving the base is not silent: without it the next sync cannot see deletions, and files deleted on one side come back.
    let baseSaved = true;
    try {
      await writeSyncBase(info.serverId, book.id, result.base);
    } catch (error) {
      if (!(error instanceof SyncBaseError)) throw error;
      baseSaved = false;
    }
    const conflictDetails = await describeConflicts({ conflicts: result.conflicts, local: { store: local.store, hashes: local.hashes() }, remote: { store: remote.store, hashes: remote.hashes() }, base });
    // Files left out are said, never ignored: a sync that moved everything it could is still not "all synced" while some stay behind.
    const kind: SyncOutcomeKind = result.conflicts.length ? "conflicts" : !baseSaved ? "error" : result.skipped.length ? "partial" : result.uploaded.length + result.downloaded.length === 0 ? "up-to-date" : "synced";
    return syncOutcome(kind, {
      conflicts: result.conflicts,
      conflictDetails,
      skipped: result.skipped,
      firstSync: !found,
      uploaded: result.uploaded.length,
      downloaded: result.downloaded.length,
      baseSaved,
      ...(kind === "error" ? { message: i18n.t("autopilot.errors.baseSaveFailed") } : {}),
    });
  }

  /** A GitHub book: it travels through GitHub, so the browser pulls what the server pushed (and publishes its own commits when asked). */
  private async syncRepository(book: BookEntry, request: SyncRequest): Promise<SyncOutcome> {
    const branch = resolveBookBranch(book);
    const token = resolveGitHubRemoteToken(book, settings());
    if (!isUsableGitHubToken(token)) throw new AutopilotSetupError("github-token");
    const meta = await getLocalRepository(book.owner, book.repo, branch, captureRepositoryOperationScope());
    if (!meta) throw new LocalWorkingCopyMissingError();
    const target = { bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity(), token };
    const status = await localStatus(meta.id);
    if (status.dirty > 0 || status.ahead > 0) {
      if (!request.push) return syncOutcome("local-changes");
      const published = await syncFullRepository(target);
      const { client } = await this.requireServer();
      // Asking the server to pull what was published is best effort, except for a conflict with GitHub: the server cannot bring the two together, and the author is told.
      await this.publishToGithub(book, client).catch((error: unknown) => {
        if (isGithubConflict(error)) throw error;
      });
      return syncOutcome("published", { uploaded: published.committed ?? 0, downloaded: published.pulled ?? 0 });
    }
    const pulled = await pullRemoteChanges({ ...target, mode: "safe" });
    return syncOutcome(pulled.updated > 0 ? "synced" : "up-to-date", { downloaded: pulled.updated });
  }

  /** Keep one live connection to the personal server while it is configured. */
  ensureServerStream(): void {
    const saved = settings().personalServer;
    const connection = hasServer(saved) ? { ...saved } : null;
    const key = connection ? `${connection.url}#${connection.token}#${connection.fingerprint ?? ""}` : "";
    if (this.stream?.key === key) return;
    this.stream?.controller.abort();
    this.stream = null;
    const store = useAutopilotStore.getState();
    if (!connection) {
      store.setServer({ status: "disabled", info: null, message: null, books: [], updates: null, connection: null });
      return;
    }
    const stream: FollowedStream = { controller: new AbortController(), key, id: hashKey(key), connection, shared: false, leader: false, sawLeader: false, known: { status: "connecting", info: null, message: null, books: [], updates: null } };
    this.stream = stream;
    const followed = store.server.connection;
    const sameServer = followed?.url === connection.url && followed.token === connection.token;
    // What was learned from another address or token is not shown for this one.
    store.setServer({ connection, ...(sameServer ? {} : { info: null, message: null, books: [], updates: null }) });
    const address = validateServerAddress(connection.url);
    if (address.ok === false) {
      store.setServer({ status: "error", info: null, books: [], updates: null, message: describeAutopilotError(new ServerAddressError(address.reason)) });
      return;
    }
    this.startFollowing(stream);
  }

  /** Reconnect now (after a connection test or new credentials). */
  reconnectServer(): void {
    const stream = this.stream;
    // The connection belongs to the leader tab of the browser: a tab that only follows it asks that one to connect again.
    if (stream?.shared && !stream.leader) this.post({ kind: "server-reconnect", stream: stream.id });
    stream?.controller.abort();
    this.stream = null;
    this.ensureServerStream();
  }

  /**
   * One live connection for the whole browser: the server accepts only a few per token, and an author has many tabs.
   * The tabs queue for a Web Lock named after the connection; the tab that holds it follows the server and tells the
   * others what it hears (`server-*` messages), and when it closes the next tab takes over. Without Web Locks every tab connects by itself.
   */
  private startFollowing(stream: FollowedStream): void {
    const manager = this.locks();
    if (!manager?.request) {
      stream.leader = true;
      void this.followServer(stream);
      return;
    }
    stream.shared = true;
    useAutopilotStore.getState().setServer({ status: "connecting" });
    this.post({ kind: "server-state-request", stream: stream.id });
    const signal = stream.controller.signal;
    let led = false;
    void manager.request(`${STREAM_LOCK_PREFIX}${stream.id}`, { signal }, async () => {
      if (signal.aborted) return;
      led = true;
      stream.leader = true;
      try {
        await this.followServer(stream);
        // After a failure that retrying cannot mend the tab keeps the lock: the others would only meet the same failure.
        await untilAborted(signal);
      } finally {
        stream.leader = false;
      }
    }).catch(() => {
      // The browser refused the lock (a sandboxed page, for one): this tab follows the server by itself, as it always did.
      if (led || signal.aborted) return;
      stream.shared = false;
      stream.leader = true;
      void this.followServer(stream);
    });
  }

  /** Set what the connection shows, and tell the other tabs of this browser when this one holds it. */
  private publish(stream: FollowedStream, patch: Partial<SharedServerState>): void {
    useAutopilotStore.getState().setServer(patch);
    stream.known = { ...stream.known, ...patch };
    this.publishState(stream);
  }

  private publishState(stream: FollowedStream): void {
    if (!stream.shared || !stream.leader) return;
    this.post({ kind: "server-state", stream: stream.id, state: stream.known });
  }

  /** The views of the books the server hosts, as the connection left them. */
  private applyServerBooks(books: ServerBookSummary[]): void {
    for (const summary of books) {
      if (settings().books.some((book) => book.id === summary.bookId)) useAutopilotStore.getState().patchView(summary.bookId, { server: summary });
    }
  }

  /**
   * The connection came back after a gap. Whatever the server did meanwhile was not heard: the previews of steps that may
   * have ended are cleared, and each book the server hosts is downloaded once (together with the other requests for it).
   */
  private afterReconnect(stream: FollowedStream): void {
    const hosted = settings().books.filter((book) => autopilotHostOf(book) === "server").map((book) => book.id);
    const { live } = useAutopilotStore.getState();
    if (hosted.some((id) => live[id])) useAutopilotStore.setState({ live: { ...live, ...Object.fromEntries(hosted.map((id) => [id, null])) } });
    for (const id of hosted) this.downloads.schedule(id, { delay: 0, minInterval: 0 });
    if (stream.shared && stream.leader) this.post({ kind: "server-reconnected", stream: stream.id });
  }

  /** Read the live stream until it closes, or until nothing arrived for too long (`silent`). */
  private async readStream(stream: FollowedStream, client: NarrariumServerClient): Promise<"closed" | "silent"> {
    const outer = stream.controller.signal;
    const inner = new AbortController();
    const abortInner = () => inner.abort();
    outer.addEventListener("abort", abortInner, { once: true });
    const watchdog = new StreamWatchdog(STREAM_IDLE_LIMIT_MS, abortInner);
    try {
      await client.stream((message) => {
        watchdog.touch();
        this.onServerMessage(message);
      }, inner.signal);
      return watchdog.tripped ? "silent" : "closed";
    } catch (error) {
      if (watchdog.tripped && !outer.aborted) return "silent";
      throw error;
    } finally {
      watchdog.stop();
      outer.removeEventListener("abort", abortInner);
    }
  }

  /**
   * The finished tasks of the books that run on the personal server are copied to this device (it keeps the messages of every book, whoever ran it), when the server announces
   * the records: once the server is attached, to catch up with what ran while this browser was away, and when a run ends. Only the tab that follows the server does it. A copy that
   * fails is the next one's to finish; a book whose recording is off on this device is left alone.
   */
  private copyHostedCalls(api: NarrariumServerClient, info: Pick<ServerInfo, "features">, reason: "open" | "run-ended", only?: string): void {
    if (!serverHasCalls(info)) return;
    const hosted = settings().books.filter((book) => autopilotHostOf(book) === "server" && (only === undefined || book.id === only));
    for (const book of hosted) void copyServerCalls(book.id, api, reason).catch(() => undefined);
  }

  /** A run of a book on the server ended: its tasks are copied once the server has saved them. */
  private async copyCallsAfterRun(bookId: string): Promise<void> {
    try {
      const { client, info } = await this.connect({});
      this.copyHostedCalls(client, info, "run-ended", bookId);
    } catch {
      // The next time the server is attached it catches up.
    }
  }

  /** Makes ready the store of the AI call records and the copies of the books that have a place to copy to (the app opened with such a book). */
  ensureCallsHost(): void {
    void ensureCallsHost();
  }

  private async followServer(stream: FollowedStream): Promise<void> {
    const { connection } = stream;
    const signal = stream.controller.signal;
    let delay = 2000;
    // A tab that took the connection over from another one starts as if it had been connected before: there was a gap.
    let connectedBefore = stream.sawLeader;
    let lost = false;
    while (!signal.aborted) {
      this.publish(stream, { status: lost ? "reconnecting" : "connecting" });
      try {
        // The token is sent only to the server that proves the pinned identity.
        const { client, info } = await this.connect({ connection, fresh: true, signal });
        const books = await client.listBooks();
        if (signal.aborted) return;
        this.publish(stream, { status: "online", info, message: null, books });
        void client.updates().then((updates) => {
          if (!signal.aborted) this.publish(stream, { updates });
        }).catch(() => undefined);
        this.applyServerBooks(books);
        this.copyHostedCalls(client, info, "open");
        if (connectedBefore) this.afterReconnect(stream);
        connectedBefore = true;
        lost = false;
        delay = 2000;
        const ended = await this.readStream(stream, client);
        if (signal.aborted) return;
        lost = true;
        this.publish(stream, { status: "reconnecting", message: null });
        // A connection that went quiet is opened again at once; one the server closed gets the usual short pause.
        if (ended === "silent") continue;
      } catch (error) {
        if (signal.aborted) return;
        const fatal = (error instanceof ServerRequestError && error.status === 401) || error instanceof ServerIdentityError || error instanceof ServerAddressError;
        this.publish(stream, { status: fatal ? "error" : "offline", message: describeAutopilotError(error) });
        if (fatal) return;
      }
      await sleep(delay, signal);
      delay = Math.min(30000, delay * 2);
    }
  }

  /**
   * What the live stream of the personal server tells. A message the leader tab received is handled here and told to
   * the other tabs (`relayed`: it came from the leader tab, and what only one tab should do is left to the leader).
   */
  onServerMessage(message: ServerStreamMessage, relayed = false): void {
    if (!relayed && (message.event === "autopilot" || message.event === "book") && this.stream?.shared && this.stream.leader) {
      this.post({ kind: "server-message", stream: this.stream.id, message });
    }
    if (message.event === "autopilot") {
      const event = message.data;
      const known = settings().books.find((book) => book.id === event.bookId);
      useAutopilotStore.getState().ingest(event, known?.name ?? event.bookId);
      // What a run on the server learned about a model is kept here too: the model's flag is in the settings of this browser, which is where the author changes it.
      if (event.type === "model-learned") learnedFromEvent(event);
      if (!known || autopilotHostOf(known) !== "server") return;
      this.refreshAfterEvent(event.bookId, event, 500);
      if (!relayed && ((event.type === "task-finished" && event.activity.status === "succeeded") || event.type === "run-ended")) {
        this.debounce(`server-sync:${event.bookId}`, 4000, () => void this.syncInBackground(event.bookId));
      }
      if (!relayed && event.type === "run-ended") this.debounce(`server-calls:${event.bookId}`, 1500, () => void this.copyCallsAfterRun(event.bookId));
    } else if (message.event === "book") {
      const summary = message.data;
      const server = useAutopilotStore.getState().server;
      const books = [...server.books.filter((entry) => entry.bookId !== summary.bookId), summary];
      useAutopilotStore.getState().setServer({ books });
      // A tab that asks later for the state of the connection is told about this book too.
      if (this.stream?.leader) this.stream.known = { ...this.stream.known, books };
      if (settings().books.some((book) => book.id === summary.bookId)) useAutopilotStore.getState().patchView(summary.bookId, { server: summary });
    }
  }

  // ─── Moving the autopilot to the other side ──────────────────────────────────────────────────────────────

  /**
   * Plan to move the autopilot of the book to the other side (this browser ↔ the personal server): after the step that runs, or now, and
   * with `returnAfterSteps`, for that many steps there and then back. The plan is an intention of this tab: it holds nothing of the book
   * while it waits, and it is lost when the tab closes (a run on the server goes on). It resolves once the plan is armed; a plan that cannot
   * be made (the book is already there, another operation holds it, a consent is missing, the server cannot take it) throws before anything is paused.
   * `saveSettings` keeps the author's settings when the book changes hands.
   */
  async armHandover(bookId: string, request: HandoverRequest, persistence: { saveSettings?: () => Promise<unknown> } = {}): Promise<void> {
    if (persistence.saveSettings) this.handoverSavers.set(bookId, persistence.saveSettings);
    await this.handovers.arm(bookId, request);
  }

  /** Take back a plan that still waits for the step to end, and the pause it asked for. `false` when it cannot be taken back. */
  cancelHandover(bookId: string): Promise<boolean> {
    return this.handovers.cancel(bookId);
  }

  /** Close the plan that ended (the author read how). */
  dismissHandover(bookId: string): void {
    this.handovers.dismiss(bookId);
  }

  /** What the plans need of the runtime: the same commands the author has, so they obey the same rules (one operation at a time, no secret sent by itself). */
  private handoverPorts(): HandoverPorts {
    return {
      hostOf: (bookId) => autopilotHostOf(findBook(bookId)),
      assertFree: (bookId) => {
        const active = this.operations.current(bookId);
        if (active) throw new AutopilotOperationBusyError("moveToServer", active.kind);
      },
      inspect: (bookId) => this.inspectRun(bookId),
      prepareMove: (bookId, to, options) => this.prepareHandoverMove(bookId, to, options.limits),
      pause: (bookId, mode) => this.pause(bookId, mode),
      waitUntilStopped: (bookId, signal, since) => this.waitUntilStopped(bookId, signal, since),
      move: (bookId, to) => this.moveForHandover(bookId, to),
      start: (bookId, options) => (options?.limits ? this.start(bookId, { limits: options.limits }) : this.start(bookId)),
      publish: (bookId, plan) => useAutopilotStore.getState().patchView(bookId, { handover: plan }),
      describeError: (error) => describeAutopilotError(error),
    };
  }

  /** A fresh look at the run of the book. A run that cannot be seen is never taken for stopped: the error says why. */
  private async inspectRun(bookId: string): Promise<RunInspection> {
    const snapshot = await this.refresh(bookId);
    const store = useAutopilotStore.getState();
    const view = store.views[bookId] ?? emptyView(bookId);
    if (!snapshot) throw new Error(view.error ?? i18n.t("autopilot.errors.action"));
    const summary = latestSummary(snapshot.state, store.summaries[bookId], snapshot.summary);
    const control = selectAutopilotControl({ snapshot, busyInAnotherTab: view.busyInAnotherTab, summary, lastSignal: lastSignalAt(bookId) }, Date.now());
    return { running: control.running, controllable: control.controllable, pausePending: summary?.pausePending ?? null };
  }

  /**
   * Check, before a run is paused for it, that the book can go to the other side. The server proves its identity, keeps the limit of a run when
   * one is asked, and holds what a run on it needs: the AI configuration and, for a GitHub book, the token. A handover never sends a secret by
   * itself, so what is missing is for the author to give, in the flow of "Where it runs".
   */
  private async prepareHandoverMove(bookId: string, to: HandoverSide, limits: boolean): Promise<void> {
    const book = findBook(bookId);
    const { client, info } = await this.requireServer();
    if (to !== "server") return;
    if (limits && !serverHasQuickControls(info)) throw new AutopilotControlsUnsupportedError();
    if ((await client.aiStatus()).configured !== true) throw new HandoverConsentError("ai");
    if (bookStorageMode(book) === "github") {
      const store = useAutopilotStore.getState();
      const known = store.server.books.find((entry) => entry.bookId === bookId) ?? store.views[bookId]?.server;
      if (!known?.hasGithubToken) throw new HandoverConsentError("github");
    }
  }

  /**
   * The files of the book, and its host: what "Move to my server" and "Bring back to this browser" do, with the consents the server already
   * holds. The run that has just ended in this tab lets go of the book's lock a moment after it is over, so a book that looks held by another
   * tab is looked at again for a little while before the plan gives up.
   */
  private async moveForHandover(bookId: string, to: HandoverSide): Promise<void> {
    const move = () => (to === "server" ? this.moveToServer(bookId, { sendAiConfiguration: false, sendGitHubToken: false }) : this.moveToBrowser(bookId));
    for (let attempt = 0; ; attempt += 1) {
      try {
        await move();
        break;
      } catch (error) {
        const lockStillHeld = error instanceof AutopilotOperationBusyError && error.active === "otherTab";
        if (!lockStillHeld || attempt >= HANDOVER_LOCK_RETRIES) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, HANDOVER_LOCK_WAIT_MS * (attempt + 1)));
      }
    }
    await setAutopilotHost(bookId, to, this.handoverSavers.get(bookId));
  }

  /**
   * Resolves when the run of the book is no longer running, wherever it ran: when the live events say it ended, when the local session goes
   * idle, and, in case an event was lost, when a download of the book (every few seconds) says so. Rejects when `signal` aborts, or when the
   * book cannot be seen for several downloads in a row (a server that went away). `since` is when the plan began asking for the end of the run.
   */
  private waitUntilStopped(bookId: string, signal: AbortSignal, since: number): Promise<RunOutcome> {
    const pollMs = this.env.handover?.pollMs ?? HANDOVER_POLL_MS;
    return new Promise<RunOutcome>((resolve, reject) => {
      let over = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let checking = false;
      let again = false;
      let unseen = 0;
      const finish = (settle: () => void) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => finish(() => reject(new DOMException("The wait for the end of the run was abandoned.", "AbortError")));
      const check = async (): Promise<void> => {
        if (over) return;
        if (checking) {
          again = true;
          return;
        }
        checking = true;
        try {
          do {
            again = false;
            const snapshot = await this.refresh(bookId);
            if (over) return;
            const view = useAutopilotStore.getState().views[bookId] ?? emptyView(bookId);
            if (!snapshot) {
              unseen += 1;
              if (unseen >= HANDOVER_UNSEEN_LIMIT) return finish(() => reject(new Error(view.error ?? i18n.t("autopilot.serverOffline"))));
              continue;
            }
            unseen = 0;
            if (!snapshot.running && !view.busyInAnotherTab) {
              const end = lastRunEnd(bookId);
              const heard = end && end.at >= since ? end : undefined;
              // What the run announced as it ended is how it ended: a download of the book can have been read while it ended, and a server that
              // predates the fix calls the stop of a pause an interruption in it. The download tells only when the end was not heard.
              return finish(() => resolve(heard
                ? { status: heard.status, message: heard.message, ...(heard.code ? { code: heard.code } : {}) }
                : { status: snapshot.state?.status ?? null, message: snapshot.state?.message ?? null }));
            }
          } while (again);
        } finally {
          checking = false;
        }
        schedule();
      };
      const schedule = () => {
        clearTimeout(timer);
        if (!over) timer = setTimeout(() => void check(), pollMs);
      };
      // The end of a run is told by the live events: the end itself, or a summary that no longer says it runs.
      const unsubscribe = useAutopilotStore.subscribe((state, previous) => {
        const last = state.feed[state.feed.length - 1];
        const ended = last && last !== previous.feed[previous.feed.length - 1] && last.event.bookId === bookId && last.event.type === "run-ended";
        const summary = state.summaries[bookId];
        if (ended || (summary !== previous.summaries[bookId] && summary?.status !== "running")) void check();
      });
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      void this.sessions.get(bookId)?.session.waitForIdle().then(() => check());
      void check();
    });
  }

  /** Runner described by a stored state that is not this tab (another device or the server). */
  remoteRunner(snapshot: AutopilotSnapshot | null): { label: string; host: "browser" | "server" } | null {
    const state = snapshot?.state;
    if (!state || snapshot?.running || runnerActivity(state) !== "active" || !state.runner) return null;
    return { label: state.runner.label, host: state.runner.host };
  }

  isRunningHere(bookId: string): boolean {
    return Boolean(this.sessions.get(bookId)?.session.running);
  }

  describeError(error: unknown): string {
    return describeAutopilotError(error);
  }

  view(bookId: string) {
    return useAutopilotStore.getState().views[bookId] ?? emptyView(bookId);
  }
}

export type AutopilotRuntime = BrowserAutopilotRuntime;

export const autopilotRuntime = new BrowserAutopilotRuntime();
