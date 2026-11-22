import {
  AutopilotBusyError,
  AutopilotSession,
  ServerRequestError,
  pickAiRuntimeConfig,
  remoteBookStore,
  runnerActivity,
  syncBookStores,
  type AskDirectorResult,
  type AutopilotEvent,
  type AutopilotSnapshot,
  type EvaluationTarget,
  type InterventionInput,
  type NarrariumServerClient,
  type QuestionAnswer,
  type ServerBookStorage,
  type ServerBookSummary,
  type ServerStreamMessage,
  type StartOptions,
} from "narrarium-engine";
import i18n from "@/i18n";
import { localDeviceId } from "@/account/deviceIdentity";
import { createBrowserAi } from "@/autopilot/browserAi";
import { LocalWorkingCopyMissingError, createBrowserBookStore } from "@/autopilot/browserStore";
import { AutopilotOperationBusyError, BookOperations, type AutopilotOperationKind } from "@/autopilot/operations";
import { PLAN_FULL_LIST_LIMIT } from "@/autopilot/planWindow";
import { RefreshCoordinator } from "@/autopilot/refreshCoordinator";
import { ServerAddressError, validateServerAddress } from "@/autopilot/serverAddress";
import { ServerIdentityError, verifiedServer, type VerifiedServer, type VerifiedServerOptions } from "@/autopilot/serverIdentity";
import {
  autopilotChannel,
  emptyView,
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
import { StreamWatchdog } from "@/autopilot/streamWatchdog";
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
import { bookStorageMode, resolveGitHubRemoteToken, type BookEntry, type PersonalServerSettings } from "@/types/settings";

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
  constructor(readonly purpose: "moveToServer" | "moveBack", readonly conflicts: string[]) {
    super(i18n.t(purpose === "moveToServer" ? "autopilot.errors.conflictsMoveToServer" : "autopilot.errors.conflictsMoveBack", { count: conflicts.length }));
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

const LOCK_PREFIX = "narrarium:autopilot:";
/** One lock per connection to the personal server: whoever holds it keeps the live connection for the whole browser. */
const STREAM_LOCK_PREFIX = "narrarium:autopilot-stream:";
const RELAY_TIMEOUT_MS = 4000;
/** The state of a book is a few kilobytes per chapter: while a long book runs it is downloaded no more often than this. */
const REFRESH_INTERVAL_WHILE_RUNNING_MS = 4000;
/** The server sends a `heartbeat` every 15 seconds: a connection that delivered nothing for three times as long is dead. */
const STREAM_IDLE_LIMIT_MS = 45_000;

function settings() {
  return useSettingsStore.getState().settings;
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

/** Readable message for errors shown in the autopilot views. */
export function describeAutopilotError(error: unknown): string {
  if (error instanceof LocalWorkingCopyMissingError) return i18n.t("autopilot.errors.workingCopy");
  if (isStateCorrupt(error)) return i18n.t("autopilot.errors.stateCorrupt");
  if (error instanceof ServerIdentityError) return i18n.t(`personalServer.identity.${error.reason}`);
  if (error instanceof ServerAddressError) return i18n.t(`personalServer.address.${error.reason}`);
  if (error instanceof AutopilotBusyError) return i18n.t("autopilot.errors.busy", { label: error.runnerLabel });
  if (error instanceof ServerRequestError) {
    if (error.code === "unreachable") return i18n.t("autopilot.serverOffline");
    if (error.code === "book_not_found") return i18n.t("autopilot.where.serverBookMissing");
    if (error.code === "ai_not_configured") return `${error.message} ${i18n.t("personalServer.aiMissing")}`;
    if (error.code === "maintenance") return i18n.t("personalServer.updates.maintenance");
  }
  if (error instanceof Error && error.name === "AiUnavailableError") return i18n.t("autopilot.errors.aiMissing");
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

  constructor(private readonly env: RuntimeEnvironment = {}) {
    this.channel()?.addEventListener("message", (message: MessageEvent<AutopilotChannelMessage>) => this.onChannelMessage(message.data));
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
    const key = `${book.id}:${branch}`;
    const existing = this.sessions.get(book.id);
    if (existing && (existing.key === key || existing.session.running)) return existing.session;
    existing?.unsubscribe();
    const session = new AutopilotSession({
      bookId: book.id,
      store: createBrowserBookStore(book, branch),
      ai: createBrowserAi(),
      host: "browser",
      hostLabel: browserLabel(),
      hostId: localDeviceId(),
      ownRunnerAlive: () => this.lockHeldElsewhere(book.id),
      hooks: bookStorageMode(book) === "github" ? {
        afterChapter: async () => {
          const token = resolveGitHubRemoteToken(book, settings());
          if (!token) return;
          await syncFullRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity(), token });
          this.recordSync(book.id, syncOutcome("published"));
        },
      } : undefined,
    });
    const unsubscribe = session.subscribe((event) => {
      const title = bookTitle(book.id);
      useAutopilotStore.getState().ingest(event, title);
      shareAutopilotEvent(event, title);
      this.afterEvent(book.id, event, true);
    });
    this.sessions.set(book.id, { key, session, unsubscribe });
    return session;
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
      return snapshot;
    } catch (error) {
      useAutopilotStore.getState().patchView(bookId, { loading: false, error: describeAutopilotError(error) });
      return null;
    }
  }

  start(bookId: string, options: StartOptions & { force?: boolean } = {}): Promise<void> {
    return this.operations.run(bookId, "start", () => this.startNow(bookId, options));
  }

  private async startNow(bookId: string, options: StartOptions & { force?: boolean }): Promise<void> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      // Check the server before the book's changes are handed to it.
      await this.requireServer();
      await this.syncNow(book.id, { push: true, throwOnError: true });
      const { client } = await this.requireServer();
      const snapshot = await client.startAutopilot(book.id, options);
      useAutopilotStore.getState().patchView(bookId, { snapshot, error: null });
      return;
    }
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
        resolve();
        await session.waitForIdle();
      }).catch(reject);
    });
    await this.refresh(bookId);
  }

  /** Never held back by an operation in progress: pausing is how the author stops an expensive run. */
  async pause(bookId: string, mode: "now" | "after-step"): Promise<void> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      useAutopilotStore.getState().patchView(bookId, { snapshot: await (await this.requireServer()).client.pauseAutopilot(book.id, mode) });
      return;
    }
    const session = this.sessions.get(book.id)?.session;
    if (session?.running) {
      session.pause(mode);
      return;
    }
    if (await this.lockHeldElsewhere(book.id)) await this.relay(book.id, { type: "pause", mode });
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
        useAutopilotStore.getState().patchView(bookId, { snapshot: await (await this.requireServer()).client.configureAutopilot(book.id, options) });
        return;
      }
      await this.localSession(book, resolveBookBranch(book)).configure(options);
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

  /** Send a command to the tab that runs the book's autopilot. */
  private relay(bookId: string, command: RelayedCommand): Promise<void> {
    const channel = this.channel();
    if (!channel) return Promise.reject(new AutopilotSetupError("other-tab"));
    const id = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const onMessage = (message: MessageEvent<AutopilotChannelMessage>) => {
        const data = message.data;
        if (data?.kind !== "command-result" || data.id !== id) return;
        window.clearTimeout(timer);
        channel.removeEventListener("message", onMessage as EventListener);
        if (data.ok) resolve();
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
      if (command.type === "pause") session.pause(command.mode);
      else await session.intervene(command.input);
      this.post({ kind: "command-result", id, ok: true });
    } catch (error) {
      this.post({ kind: "command-result", id, ok: false, error: describeAutopilotError(error) });
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
      if (!token) throw new AutopilotSetupError("github-token");
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
        await client.syncGitHub(book.id);
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
    if (!token) throw new AutopilotSetupError("github-token");
    const meta = await getLocalRepository(book.owner, book.repo, branch, captureRepositoryOperationScope());
    if (!meta) throw new LocalWorkingCopyMissingError();
    const target = { bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity(), token };
    const status = await localStatus(meta.id);
    if (status.dirty > 0 || status.ahead > 0) {
      if (!request.push) return syncOutcome("local-changes");
      const published = await syncFullRepository(target);
      const { client } = await this.requireServer();
      await client.syncGitHub(book.id).catch(() => undefined);
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
      if (!known || autopilotHostOf(known) !== "server") return;
      this.refreshAfterEvent(event.bookId, event, 500);
      if (!relayed && ((event.type === "task-finished" && event.activity.status === "succeeded") || event.type === "run-ended")) {
        this.debounce(`server-sync:${event.bookId}`, 4000, () => void this.syncInBackground(event.bookId));
      }
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
