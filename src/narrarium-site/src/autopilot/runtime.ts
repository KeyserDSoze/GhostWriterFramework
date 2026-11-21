import {
  AutopilotBusyError,
  AutopilotSession,
  NarrariumServerClient,
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
  type QuestionAnswer,
  type ServerBookStorage,
  type ServerStreamMessage,
  type StartOptions,
} from "narrarium-engine";
import i18n from "@/i18n";
import { localDeviceId } from "@/account/deviceIdentity";
import { createBrowserAi } from "@/autopilot/browserAi";
import { LocalWorkingCopyMissingError, createBrowserBookStore } from "@/autopilot/browserStore";
import { ServerIdentityError, verifiedServerInfo } from "@/autopilot/serverIdentity";
import { autopilotChannel, emptyView, shareAutopilotEvent, useAutopilotStore, type AutopilotChannelMessage, type RelayedCommand } from "@/autopilot/store";
import { resolveAuthoritativeBranch } from "@/github/branchResolution";
import { getLocalRepository, localStatus } from "@/repository/localRepository";
import { captureRepositoryOperationScope, currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { getExistingLocalBookStructure, pullRemoteChanges, syncFullRepository } from "@/repository/repositoryService";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, resolveGitHubRemoteToken, type BookEntry } from "@/types/settings";

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

const LOCK_PREFIX = "narrarium:autopilot:";
const SYNC_BASE_PREFIX = "narrarium-server-sync-base-v1:";
const RELAY_TIMEOUT_MS = 4000;

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

export function serverClient(): NarrariumServerClient | null {
  const connection = settings().personalServer;
  if (!connection?.url || !connection.token) return null;
  try {
    return new NarrariumServerClient({ baseUrl: connection.url, token: connection.token });
  } catch {
    return null;
  }
}

function browserLabel(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "browser";
  return `Browser · ${platform}`;
}

/** Readable message for errors shown in the autopilot views. */
export function describeAutopilotError(error: unknown): string {
  if (error instanceof LocalWorkingCopyMissingError) return i18n.t("autopilot.errors.workingCopy");
  if (error instanceof ServerIdentityError) return i18n.t(`personalServer.identity.${error.reason}`);
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

interface LocalSessionEntry {
  key: string;
  session: AutopilotSession;
  unsubscribe: () => void;
}

class BrowserAutopilotRuntime {
  private readonly sessions = new Map<string, LocalSessionEntry>();
  private readonly timers = new Map<string, number>();
  private stream: { controller: AbortController; key: string } | null = null;
  private wakeLock: { release: () => Promise<void> } | null = null;
  private unloadGuard = false;

  constructor() {
    autopilotChannel()?.addEventListener("message", (message: MessageEvent<AutopilotChannelMessage>) => {
      const data = message.data;
      if (data?.kind === "command") void this.handleRelayedCommand(data.id, data.bookId, data.command);
      else if (data?.kind === "event" && data.event) this.afterEvent(data.event.bookId, data.event, false);
    });
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
          useAutopilotStore.getState().patchView(book.id, { sync: { at: new Date().toISOString(), ok: true, message: "published" } });
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

  /** Refresh views and the book structure after meaningful events (from this tab or another one). */
  private afterEvent(bookId: string, event: AutopilotEvent, local: boolean): void {
    if (event.type === "task-progress") return;
    if (event.type === "task-finished" || event.type === "state" || event.type === "run-ended") this.debounce(`refresh:${bookId}`, 400, () => void this.refresh(bookId));
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
      document.addEventListener("visibilitychange", this.visibilityChange);
    } else if (!running && this.unloadGuard) {
      this.unloadGuard = false;
      window.removeEventListener("beforeunload", this.beforeUnload);
      document.removeEventListener("visibilitychange", this.visibilityChange);
    }
    void this.updateWakeLock(running);
  }

  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    if (!this.anyLocalRunning()) return;
    event.preventDefault();
    event.returnValue = "";
  };

  private readonly visibilityChange = () => {
    if (document.visibilityState === "visible") void this.updateWakeLock(this.anyLocalRunning());
  };

  /** Keep the screen awake while this tab writes, so the device does not suspend the run. */
  private async updateWakeLock(wanted: boolean): Promise<void> {
    const wakeLockApi = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (!wanted) {
      const current = this.wakeLock;
      this.wakeLock = null;
      await current?.release().catch(() => undefined);
      return;
    }
    if (this.wakeLock || !wakeLockApi || document.visibilityState !== "visible") return;
    try {
      this.wakeLock = await wakeLockApi.request("screen");
    } catch {
      this.wakeLock = null;
    }
  }

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
    const held = await locks()?.query?.().catch(() => null);
    const name = `${LOCK_PREFIX}${bookId}`;
    return Boolean(held?.held?.some((lock) => lock.name === name));
  }

  /** Reload the snapshot shown by the autopilot page, the dock and the launcher. */
  async refresh(bookId: string): Promise<AutopilotSnapshot | null> {
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
        const snapshot = await this.requireClient().autopilot(book.id);
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

  async start(bookId: string, options: StartOptions & { force?: boolean } = {}): Promise<void> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      const client = this.requireClient();
      await this.syncWithServer(book.id, { push: true });
      const snapshot = await client.startAutopilot(book.id, options);
      useAutopilotStore.getState().patchView(bookId, { snapshot, error: null });
      return;
    }
    const session = this.localSession(book, resolveBookBranch(book));
    if (session.running) throw new AutopilotBusyError(browserLabel());
    const lockManager = locks();
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

  async pause(bookId: string, mode: "now" | "after-step"): Promise<void> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      useAutopilotStore.getState().patchView(bookId, { snapshot: await this.requireClient().pauseAutopilot(book.id, mode) });
      return;
    }
    const session = this.sessions.get(book.id)?.session;
    if (session?.running) {
      session.pause(mode);
      return;
    }
    if (await this.lockHeldElsewhere(book.id)) await this.relay(book.id, { type: "pause", mode });
  }

  async intervene(bookId: string, input: InterventionInput): Promise<void> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      useAutopilotStore.getState().patchView(bookId, { snapshot: await this.requireClient().intervene(book.id, input) });
      return;
    }
    const session = this.localSession(book, resolveBookBranch(book));
    if (!session.running && await this.lockHeldElsewhere(book.id)) {
      await this.relay(book.id, { type: "intervene", input });
      return;
    }
    await session.intervene(input);
    await this.refresh(bookId);
  }

  async answer(bookId: string, answer: QuestionAnswer): Promise<void> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      useAutopilotStore.getState().patchView(bookId, { snapshot: await this.requireClient().answer(book.id, answer) });
      return;
    }
    await this.localSession(book, resolveBookBranch(book)).answer(answer);
    await this.refresh(bookId);
  }

  async configure(bookId: string, options: StartOptions): Promise<void> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      useAutopilotStore.getState().patchView(bookId, { snapshot: await this.requireClient().configureAutopilot(book.id, options) });
      return;
    }
    await this.localSession(book, resolveBookBranch(book)).configure(options);
    await this.refresh(bookId);
  }

  async reset(bookId: string): Promise<void> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      useAutopilotStore.getState().patchView(bookId, { snapshot: await this.requireClient().resetAutopilot(book.id) });
      return;
    }
    await this.localSession(book, resolveBookBranch(book)).reset();
    await this.refresh(bookId);
  }

  /** "What does the director think?" — on the server when the book lives there, otherwise in the browser. */
  async askDirector(bookId: string, input: { target: EvaluationTarget; question?: string; save?: boolean; signal?: AbortSignal }): Promise<AskDirectorResult> {
    const book = findBook(bookId);
    if (autopilotHostOf(book) === "server") {
      const client = this.requireClient();
      // The director reads the server's copy: hand it the author's latest edits first.
      await this.syncWithServer(book.id, { push: true }).catch(() => undefined);
      const result = await client.askDirector(book.id, { target: input.target, question: input.question, save: input.save }, input.signal);
      if (input.save) this.debounce(`server-sync:${bookId}`, 300, () => void this.syncWithServer(bookId));
      return result;
    }
    const result = await this.localSession(book, resolveBookBranch(book)).askDirector(input);
    if (input.save) this.debounce(`structure:${bookId}`, 300, () => void this.reloadStructure(bookId));
    return result;
  }

  private requireClient(): NarrariumServerClient {
    const client = serverClient();
    if (!client) throw new AutopilotSetupError("no-server");
    return client;
  }

  /** Send a command to the tab that runs the book's autopilot. */
  private relay(bookId: string, command: RelayedCommand): Promise<void> {
    const channel = autopilotChannel();
    if (!channel) return Promise.reject(new AutopilotSetupError("other-tab"));
    const id = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const onMessage = (message: MessageEvent<AutopilotChannelMessage>) => {
        const data = message.data;
        if (data?.kind !== "command-result" || data.id !== id) return;
        window.clearTimeout(timer);
        channel.removeEventListener("message", onMessage);
        if (data.ok) resolve();
        else reject(new Error(data.error || i18n.t("autopilot.errors.action")));
      };
      const timer = window.setTimeout(() => {
        channel.removeEventListener("message", onMessage);
        reject(new AutopilotSetupError("other-tab"));
      }, RELAY_TIMEOUT_MS);
      channel.addEventListener("message", onMessage);
      channel.postMessage({ kind: "command", id, bookId, command } satisfies AutopilotChannelMessage);
    });
  }

  private async handleRelayedCommand(id: string, bookId: string, command: RelayedCommand): Promise<void> {
    const session = this.sessions.get(bookId)?.session;
    if (!session?.running) return;
    const reply = (message: AutopilotChannelMessage) => autopilotChannel()?.postMessage(message);
    try {
      if (command.type === "pause") session.pause(command.mode);
      else await session.intervene(command.input);
      reply({ kind: "command-result", id, ok: true });
    } catch (error) {
      reply({ kind: "command-result", id, ok: false, error: describeAutopilotError(error) });
    }
  }

  private syncBaseKey(serverId: string, bookId: string): string {
    return `${SYNC_BASE_PREFIX}${serverId}:${bookId}`;
  }

  private readBase(serverId: string, bookId: string): Map<string, string> {
    try {
      const raw = localStorage.getItem(this.syncBaseKey(serverId, bookId));
      return new Map(raw ? JSON.parse(raw) as Array<[string, string]> : []);
    } catch {
      return new Map();
    }
  }

  private writeBase(serverId: string, bookId: string, base: Map<string, string>): void {
    try {
      localStorage.setItem(this.syncBaseKey(serverId, bookId), JSON.stringify([...base.entries()]));
    } catch {
      // A missing base only makes the next sync more conservative.
    }
  }

  /**
   * Host the book's autopilot on the personal server. GitHub books travel through GitHub (the server
   * clones and pushes the same branch); local books are uploaded file by file with the shared sync.
   */
  async moveToServer(bookId: string, consent: { sendAiConfiguration: boolean; sendGitHubToken: boolean }): Promise<void> {
    const book = findBook(bookId);
    const client = this.requireClient();
    if (this.sessions.get(bookId)?.session.running || await this.lockHeldElsewhere(bookId)) throw new AutopilotBusyError(browserLabel());
    const info = await client.info();
    const branch = resolveBookBranch(book);
    if (consent.sendAiConfiguration) await client.putAiConfig(pickAiRuntimeConfig(settings()));
    let storage: ServerBookStorage = { kind: "local" };
    let githubToken: string | undefined;
    if (bookStorageMode(book) === "github") {
      const token = resolveGitHubRemoteToken(book, settings());
      if (!token) throw new AutopilotSetupError("github-token");
      await syncFullRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity(), token });
      storage = { kind: "github", owner: book.owner, repo: book.repo, branch };
      if (consent.sendGitHubToken) githubToken = token;
    }
    const summary = await client.registerBook(book.id, { title: book.name, storage, ...(githubToken ? { githubToken } : {}) });
    if (storage.kind === "local") {
      const result = await syncBookStores({ local: createBrowserBookStore(book, branch), remote: remoteBookStore(client, book.id), base: this.readBase(info.serverId, book.id), resolveConflict: () => "local", message: "Upload from Narrarium" });
      this.writeBase(info.serverId, book.id, result.base);
    }
    useAutopilotStore.getState().patchView(bookId, { server: summary, error: null });
    this.ensureServerStream();
  }

  /** Bring the server's work back and run the autopilot in this browser again. */
  async moveToBrowser(bookId: string): Promise<void> {
    const book = findBook(bookId);
    const client = serverClient();
    if (client) {
      const snapshot = await client.autopilot(book.id).catch(() => null);
      if (snapshot?.running) throw new AutopilotBusyError(i18n.t("autopilot.host.server"));
      await this.syncWithServer(bookId);
    }
    useAutopilotStore.getState().patchView(bookId, { server: null, error: null });
  }

  /**
   * Exchange work with the server. Local books: two-way file sync. GitHub books: the server pushes
   * to GitHub, so the browser pulls (and, with `push`, first publishes its own commits).
   */
  async syncWithServer(bookId: string, options: { push?: boolean } = {}): Promise<void> {
    const book = findBook(bookId);
    const client = serverClient();
    if (!client) return;
    const store = useAutopilotStore.getState();
    try {
      const branch = resolveBookBranch(book);
      if (bookStorageMode(book) === "github") {
        const token = resolveGitHubRemoteToken(book, settings());
        const meta = await getLocalRepository(book.owner, book.repo, branch, captureRepositoryOperationScope());
        if (!meta || !token) return;
        const status = await localStatus(meta.id);
        if (status.dirty > 0 || status.ahead > 0) {
          if (!options.push) {
            store.patchView(bookId, { sync: { at: new Date().toISOString(), ok: false, message: "local-changes" } });
            return;
          }
          await syncFullRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity(), token });
          await client.syncGitHub(book.id).catch(() => undefined);
        } else {
          await pullRemoteChanges({ bookId: book.id, owner: book.owner, repo: book.repo, branch, accountIdentity: currentRepositoryScopeIdentity(), token, mode: "safe" });
        }
      } else {
        const info = await client.info();
        const result = await syncBookStores({ local: createBrowserBookStore(book, branch), remote: remoteBookStore(client, book.id), base: this.readBase(info.serverId, book.id) });
        this.writeBase(info.serverId, book.id, result.base);
        if (result.conflicts.length) {
          useAutopilotStore.getState().patchView(bookId, { sync: { at: new Date().toISOString(), ok: false, message: `conflicts:${result.conflicts.length}` } });
          await this.reloadStructure(bookId);
          return;
        }
      }
      useAutopilotStore.getState().patchView(bookId, { sync: { at: new Date().toISOString(), ok: true, message: "synced" } });
      await this.reloadStructure(bookId);
    } catch (error) {
      useAutopilotStore.getState().patchView(bookId, { sync: { at: new Date().toISOString(), ok: false, message: describeAutopilotError(error) } });
      if (options.push) throw error;
    }
  }

  /** Keep one live connection to the personal server while it is configured. */
  ensureServerStream(): void {
    const connection = settings().personalServer;
    const key = connection?.url && connection.token ? `${connection.url}#${connection.token}` : "";
    if (this.stream?.key === key) return;
    this.stream?.controller.abort();
    this.stream = null;
    if (!key) {
      useAutopilotStore.getState().setServer({ status: "disabled", info: null, message: null, books: [], updates: null });
      return;
    }
    const controller = new AbortController();
    this.stream = { controller, key };
    void this.followServer(controller.signal);
  }

  /** Reconnect now (after a connection test or new credentials). */
  reconnectServer(): void {
    this.stream?.controller.abort();
    this.stream = null;
    this.ensureServerStream();
  }

  private async followServer(signal: AbortSignal): Promise<void> {
    let delay = 2000;
    while (!signal.aborted) {
      const client = serverClient();
      if (!client) return;
      useAutopilotStore.getState().setServer({ status: "connecting" });
      try {
        // The token is sent only to the server that proves the pinned identity.
        const { info } = await verifiedServerInfo(client, settings().personalServer?.fingerprint);
        const books = await client.listBooks();
        if (signal.aborted) return;
        useAutopilotStore.getState().setServer({ status: "online", info, message: null, books });
        void client.updates().then((updates) => {
          if (!signal.aborted) useAutopilotStore.getState().setServer({ updates });
        }).catch(() => undefined);
        for (const summary of books) {
          if (settings().books.some((book) => book.id === summary.bookId)) useAutopilotStore.getState().patchView(summary.bookId, { server: summary });
        }
        delay = 2000;
        await client.stream((message) => this.onServerMessage(message), signal);
        if (!signal.aborted) useAutopilotStore.getState().setServer({ status: "offline", message: null });
      } catch (error) {
        if (signal.aborted) return;
        const fatal = (error instanceof ServerRequestError && error.status === 401) || error instanceof ServerIdentityError;
        useAutopilotStore.getState().setServer({ status: fatal ? "error" : "offline", message: describeAutopilotError(error) });
        if (fatal) return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      delay = Math.min(30000, delay * 2);
    }
  }

  private onServerMessage(message: ServerStreamMessage): void {
    if (message.event === "autopilot") {
      const event = message.data;
      const known = settings().books.find((book) => book.id === event.bookId);
      useAutopilotStore.getState().ingest(event, known?.name ?? event.bookId);
      if (!known || autopilotHostOf(known) !== "server") return;
      if (event.type === "task-finished" || event.type === "state" || event.type === "run-ended") this.debounce(`refresh:${event.bookId}`, 500, () => void this.refresh(event.bookId));
      if ((event.type === "task-finished" && event.activity.status === "succeeded") || event.type === "run-ended") {
        this.debounce(`server-sync:${event.bookId}`, 4000, () => void this.syncWithServer(event.bookId));
      }
    } else if (message.event === "book") {
      const summary = message.data;
      const server = useAutopilotStore.getState().server;
      useAutopilotStore.getState().setServer({ books: [...server.books.filter((entry) => entry.bookId !== summary.bookId), summary] });
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
