import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  AiUnavailableError,
  AutopilotSession,
  createFetchAi,
  hasAiCandidates,
  redactSecrets,
  type AiPort,
  type AiRequest,
  type AiResponse,
  type AutopilotEvent,
  type AutopilotPublishMode,
  type AutopilotSessionConfig,
  type BookCommitResult,
  type BookFileChange,
  type GithubConflictsResponse,
  type RegisterBookRequest,
  type ResolveGithubConflictsRequest,
  type ResolveGithubConflictsResponse,
  type ServerBookSummary,
  type ServerBookSync,
  type StartOptions,
} from "narrarium-engine";
import { assertAiApproved } from "./ai-approval.js";
import { assertBookId, assertBookToken, assertNewBookId, publicLabel, type DataDirectory, type StoredBook } from "./config.js";
import { HttpError } from "./errors.js";
import { renameReplacing } from "./files.js";
import { FileBookStore, KeyedMutex } from "./fs-store.js";
import { GitRepository } from "./git.js";
import { GithubConflictError } from "./github-conflicts.js";
import { spendSettingsOf, type SpendLedger, type SpendScope, type SpendSettings } from "./spend.js";

export { HttpError };

export interface BookRuntime {
  book: StoredBook;
  store: FileBookStore;
  git: GitRepository | null;
  session: AutopilotSession;
  lastSync: ServerBookSync | null;
  error?: string;
  unsubscribe: () => void;
}

/** Books one server hosts at most: each has a runtime, a working copy and a stored token, and the files that list them are read whole. */
export const MAX_BOOKS = 200;

/**
 * Where a book is published to GitHub when its author has not chosen (`publishEvery`): after every step, as the server always did. The author
 * can choose `chapter` or `off` for a book, also while it runs. It is what the summaries of the autopilot say for every book of this server;
 * a book that is not on GitHub has nowhere to publish, whatever it says.
 */
export const DEFAULT_PUBLISH: AutopilotPublishMode = "step";

/** What a failed publish tells in `lastSync` and in the warning of the run: what git said, without a token, cut short. */
const PUBLISH_MESSAGE_CHARACTERS = 500;

/** How the autopilot sessions wait and beat (tests shorten it; a session keeps the engine's own defaults for what is not given). */
export type AutopilotTuning = Partial<Pick<AutopilotSessionConfig, "retryDelayMs" | "random" | "heartbeatMs" | "persistHeartbeatMs">>;

export interface BookRegistryOptions {
  gitAvailable: boolean;
  /** Fixed AI port (tests); otherwise the AI configuration saved on the server is used. */
  ai?: AiPort;
  /** What the server spends on AI: the owner's switch and caps are checked before every call, and every attempt is counted. */
  spend: SpendLedger;
  autopilot?: AutopilotTuning;
  /** Override the GitHub clone URL (tests use a local bare repository). */
  githubRemoteUrl?: (owner: string, repo: string) => string;
  onEvent: (event: AutopilotEvent) => void;
  onBookChanged: (bookId: string) => void;
  log: (line: string) => void;
}

function sameStorage(left: StoredBook["storage"], right: StoredBook["storage"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validStorage(storage: unknown): StoredBook["storage"] {
  const value = storage as Partial<{ kind: string; owner: string; repo: string; branch: string }> | null;
  if (value?.kind === "local") return { kind: "local" };
  const segment = /^[A-Za-z0-9._-]{1,100}$/;
  const branch = /^(?!-)(?!.*\.\.)(?!\/)[A-Za-z0-9._/@+-]{1,200}$/;
  if (value?.kind === "github" && typeof value.owner === "string" && segment.test(value.owner) && typeof value.repo === "string" && segment.test(value.repo) && typeof value.branch === "string" && branch.test(value.branch)) {
    return { kind: "github", owner: value.owner, repo: value.repo, branch: value.branch };
  }
  throw new HttpError(400, "invalid_storage", "The book storage must be `local` or a GitHub owner, repository and branch.");
}

/** Steps that each can be undone: when one fails, the ones that went through are undone, the last first, and the registration leaves no trace. */
class Transaction {
  private readonly undo: Array<() => Promise<void>> = [];

  onRollback(step: () => Promise<void>): void {
    this.undo.push(step);
  }

  async rollback(log: (line: string) => void): Promise<void> {
    for (const step of this.undo.reverse()) {
      await step().catch((error) => log(`A registration could not be undone completely: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.undo.length = 0;
  }
}

/** Books hosted by the server, each with its working copy and its autopilot session. */
export class BookRegistry {
  private readonly runtimes = new Map<string, BookRuntime>();
  /** Ids of new books being registered right now: they already take a place. */
  private readonly arriving = new Set<string>();
  /** `register` and `remove` of one book never overlap. */
  private readonly locks = new KeyedMutex();
  /** Set once an update is accepted: the server only finishes what it is doing and then restarts. */
  private maintenance = false;
  /** The fingerprint of the conflicts with GitHub that the list last gave for each book: what a resolution that sends none was chosen from. */
  private readonly listedConflicts = new Map<string, string>();

  constructor(private readonly data: DataDirectory, private readonly options: BookRegistryOptions) {}

  get inMaintenance(): boolean {
    return this.maintenance;
  }

  /** Refuse new work while an accepted update waits for the supervisor. */
  assertNotInMaintenance(): void {
    if (this.maintenance) throw new HttpError(503, "maintenance", "The server is about to restart for an update: try again in a minute.");
  }

  /**
   * Accept an update only when no autopilot runs; from then on every new command is refused until
   * the supervisor restarts the server. If `action` fails the server leaves maintenance.
   */
  async requestUpdate(action: () => Promise<void>): Promise<void> {
    this.assertNotInMaintenance();
    if (this.runningCount() > 0) throw new HttpError(409, "running", "Pause every autopilot on the server before updating it.");
    this.maintenance = true;
    try {
      await action();
    } catch (error) {
      this.maintenance = false;
      throw error;
    }
  }

  /** The supervisor reported that the accepted update did not happen: accept work again. */
  leaveMaintenance(): void {
    this.maintenance = false;
  }

  /** The owner's switch and caps, as the configuration says now. */
  private get spendSettings(): SpendSettings {
    return spendSettingsOf(this.data.config);
  }

  /**
   * Refuse a new run when the owner's switch is off or a cap of the day is reached: a run that would stop at its first call is not started (it
   * would only leave an error in the book). Throws the same `SpendLimitError` a call would, answered `429 spend_limit`.
   */
  assertSpendAllowed(): void {
    this.options.spend.assertAllowed(this.spendSettings);
  }

  /**
   * Start or resume the autopilot of a book, in the order that every start has: the AI must be configured, the server may not already run as many
   * autopilots as the owner allows, and the owner's switch and caps must allow a run. The route that starts a run, the tool of the MCP endpoint
   * that resumes one and the server's own resume after a restart (`afterRestart`) all come here, so that no way of starting a run skips one of them.
   */
  async startRun(runtime: BookRuntime, start: StartOptions & { force?: boolean; afterRestart?: boolean }): Promise<void> {
    await this.assertStartAllowed();
    await runtime.session.start(start);
  }

  /** What every start asks of the server before the run (see `startRun`); it throws the refusal a start would answer. */
  async assertStartAllowed(): Promise<void> {
    if (!(await this.aiConfigured())) throw new HttpError(412, "ai_not_configured", "Send your AI router configuration to the server before starting the autopilot.");
    this.assertCanStart();
    // The owner's switch or a cap of the day would stop the run at its first call: it is not started (and leaves nothing in the book).
    this.assertSpendAllowed();
  }

  /**
   * What a commit from a client is: the files are committed (compare-and-swap, one writer at a time), and a GitHub book that no run publishes is
   * pulled and pushed at once (a run publishes by its own rules: see `publishEvery`). A sync that fails never fails the commit. The commit route
   * and the write tools of the MCP endpoint both come here, so that a change made through either reaches GitHub the same way.
   */
  async commitFiles(runtime: BookRuntime, changes: BookFileChange[], message: string): Promise<BookCommitResult> {
    const result = await runtime.store.commit(changes, message);
    if (runtime.book.storage.kind === "github" && runtime.git && !runtime.session.running) await this.syncGitHub(runtime.book.bookId).catch(() => undefined);
    return result;
  }

  /** Stop every autopilot at once (the owner switched AI spending off): each pauses, and the call in flight is abandoned. */
  stopAll(): void {
    for (const runtime of this.all()) runtime.session.pause("now");
  }

  /** The AI port of one book: the latest saved configuration is read on every call. */
  private aiFor(bookId: string): AiPort {
    return { complete: (request) => this.complete(bookId, request) };
  }

  /**
   * One AI call, in this order: the owner's switch and caps (for every AI port); the configuration; the approval of every endpoint the call can
   * reach (an endpoint that is not approved is never called, and the run stops saying which one to approve); then the engine's AI client, whose
   * `onAttemptEnd` counts every attempt, the failed ones that used tokens included.
   */
  private async complete(bookId: string, request: AiRequest): Promise<AiResponse> {
    const { spend } = this.options;
    const runId = this.runtimes.get(bookId)?.session.running ? spend.activeRun(bookId) : undefined;
    const scope: SpendScope | undefined = runId ? { bookId, runId } : undefined;
    spend.assertAllowed(this.spendSettings, scope);
    if (this.options.ai) return this.options.ai.complete(request);
    const { config } = await this.data.aiConfig();
    if (!hasAiCandidates(config, request.capability)) throw new AiUnavailableError(request.capability);
    assertAiApproved(config, request.capability, this.data.config.allowedAiBases);
    // `githubModelsBaseUrl` is not given: the server calls https://models.github.ai itself (there is no CORS here, so no proxy is needed).
    return createFetchAi(config, { onAttemptEnd: (end) => spend.record(end, scope) }).complete(request);
  }

  async load(): Promise<void> {
    await this.data.purgeTrash().then(
      (removed) => {
        if (removed.length) this.options.log(`Deleted ${removed.length} book copies from the trash after the retention period.`);
      },
      (error) => this.options.log(`The trash could not be cleaned: ${error instanceof Error ? error.message : String(error)}`),
    );
    for (const book of await this.data.books()) {
      try {
        const runtime = this.instantiate(book);
        // A server that stopped in the middle of a change of the copy (a merge, a rebase, git's lock) finds it as it was before that change.
        if (runtime.git && existsSync(path.join(runtime.store.root, ".git")) && await runtime.git.recover()) this.options.log(`Book ${book.bookId}: an interrupted git operation was undone.`);
      } catch (error) {
        this.options.log(`Book ${book.bookId} could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The git side of a working copy; `null` when git is not installed. Git runs in a private home inside the data folder. */
  private makeGit(directory: string, storage: StoredBook["storage"], token: () => string | undefined): GitRepository | null {
    if (!this.options.gitAvailable) return null;
    const remote = storage.kind === "github"
      ? { owner: storage.owner, repo: storage.repo, branch: storage.branch, token, url: this.options.githubRemoteUrl?.(storage.owner, storage.repo) }
      : undefined;
    return new GitRepository(directory, remote, { home: this.data.file("private", "git-home") });
  }

  private instantiate(book: StoredBook): BookRuntime {
    const previous = this.runtimes.get(book.bookId);
    if (previous) {
      previous.session.pause("now");
      previous.unsubscribe();
    }
    const directory = this.data.bookDirectory(book.bookId);
    const git = this.makeGit(directory, book.storage, () => this.tokenCache.get(book.bookId));
    const store = new FileBookStore(directory, {
      afterWrite: async (paths, message) => git && existsSync(path.join(directory, ".git")) ? git.commit(paths, message) : undefined,
    });
    const runtime: BookRuntime = {
      book,
      store,
      git,
      session: new AutopilotSession({
        bookId: book.bookId,
        store,
        ai: this.aiFor(book.bookId),
        host: "server",
        hostLabel: publicLabel(this.data.config.label),
        hostId: this.data.config.serverId,
        defaultPublish: DEFAULT_PUBLISH,
        ...this.options.autopilot,
        // Git's own work on the working copy (a pull may rewrite files) takes its turn among the commits and the syncs of the book. The engine decides
        // when to publish (`publishEvery`, read at the end of every step and chapter): `afterCommit` is called after a step when the book is published
        // after every step, `afterChapter` when a chapter is closed and the book is published by chapter or by step, and neither when it is not published.
        hooks: book.storage.kind === "github" && git ? {
          beforeStep: async () => {
            await this.refreshToken(book.bookId);
            try {
              // The run is active: the autopilot's own files are its own, whatever GitHub holds.
              const result = await store.exclusive(() => git.pull({ runActive: true }));
              if (result.changed) this.options.onBookChanged(book.bookId);
            } catch (error) {
              // A conflict stops the run (the author chooses); the book says it too, with how many files, until it is resolved.
              if (error instanceof GithubConflictError) {
                runtime.lastSync = { at: new Date().toISOString(), ok: false, message: error.message, conflicts: error.total };
                this.options.onBookChanged(book.bookId);
              }
              throw error;
            }
          },
          afterCommit: () => this.publish(runtime, git),
          afterChapter: () => this.publish(runtime, git),
        } : undefined,
      }),
      lastSync: null,
      unsubscribe: () => undefined,
    };
    runtime.unsubscribe = runtime.session.subscribe((event) => {
      // A run of the book has its own count of what it spends: it starts when the run does.
      if (event.type === "run-started") this.options.spend.beginRun(book.bookId, event.runId);
      else if (event.type === "run-ended") this.options.spend.endRun(book.bookId, event.runId);
      this.options.onEvent(event);
      if (event.type === "task-finished" || event.type === "run-ended" || event.type === "state") this.options.onBookChanged(book.bookId);
    });
    this.runtimes.set(book.bookId, runtime);
    return runtime;
  }

  private readonly tokenCache = new Map<string, string | undefined>();

  private async refreshToken(bookId: string): Promise<void> {
    this.tokenCache.set(bookId, await this.data.bookToken(bookId));
  }

  /**
   * Push a GitHub book, one at a time with its commits and syncs, and record how it went: `lastSync` says it whether it worked or not. A failure is
   * thrown again, with what a token could be in it removed, so that the run reports it as a warning and goes on (a publish never stops a run).
   */
  private async publish(runtime: BookRuntime, git: GitRepository): Promise<void> {
    const { bookId } = runtime.book;
    try {
      await this.refreshToken(bookId);
      await runtime.store.exclusive(() => git.push({ runActive: runtime.session.running }));
      runtime.lastSync = { at: new Date().toISOString(), ok: true, message: "Pushed to GitHub.", head: await git.head() };
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error), [this.tokenCache.get(bookId) ?? ""]).slice(0, PUBLISH_MESSAGE_CHARACTERS);
      runtime.lastSync = { at: new Date().toISOString(), ok: false, message, ...(error instanceof GithubConflictError ? { conflicts: error.total } : {}) };
      throw new Error(message);
    } finally {
      this.options.onBookChanged(bookId);
    }
  }

  get(bookId: string): BookRuntime {
    const runtime = this.runtimes.get(assertBookId(bookId));
    if (!runtime) throw new HttpError(404, "book_not_found", "This book is not registered on the server.");
    return runtime;
  }

  has(bookId: string): boolean {
    return this.runtimes.has(bookId);
  }

  all(): BookRuntime[] {
    return [...this.runtimes.values()];
  }

  runningCount(): number {
    return this.all().filter((runtime) => runtime.session.running).length;
  }

  assertCanStart(): void {
    this.assertNotInMaintenance();
    const max = this.data.config.maxConcurrentRuns;
    if (this.runningCount() >= max) {
      throw new HttpError(429, "too_many_runs", `The server already runs ${max} autopilots: pause one before starting another.`);
    }
  }

  async register(bookId: string, request: RegisterBookRequest): Promise<ServerBookSummary> {
    assertBookId(bookId);
    this.assertNotInMaintenance();
    assertBookToken(request.githubToken);
    // A new book needs a free place; one that is already hosted (or being registered right now) never does.
    const isNew = !this.runtimes.has(bookId) && !this.arriving.has(bookId);
    if (isNew) {
      assertNewBookId(bookId);
      if (this.runtimes.size + this.arriving.size >= MAX_BOOKS) throw new HttpError(409, "too_many_books", `This server hosts at most ${MAX_BOOKS} books: remove one before adding another.`);
      this.arriving.add(bookId);
    }
    try {
      return await this.locks.run(bookId, () => this.registerExclusive(bookId, request));
    } finally {
      if (isNew) this.arriving.delete(bookId);
    }
  }

  private async registerExclusive(bookId: string, request: RegisterBookRequest): Promise<ServerBookSummary> {
    this.assertNotInMaintenance();
    const title = typeof request.title === "string" && request.title.trim() ? request.title.trim().slice(0, 300) : bookId;
    const storage = validStorage(request.storage);
    const existing = this.runtimes.get(bookId);
    const unchanged = existing !== undefined && sameStorage(existing.book.storage, storage);
    if (existing?.session.running && !unchanged) throw new HttpError(409, "busy", "Pause the autopilot before changing where the book is stored.");
    const token = request.githubToken === undefined ? await this.data.bookToken(bookId) : request.githubToken?.trim() || undefined;
    if (storage.kind === "github") {
      if (!this.options.gitAvailable) throw new HttpError(412, "git_unavailable", "Install git on the server to host GitHub books.");
      if (!token) throw new HttpError(412, "github_token_required", "Send the book's GitHub token (with your consent) so the server can clone and push it.");
    }
    const now = new Date().toISOString();
    const book: StoredBook = { bookId, title, storage, createdAt: existing?.book.createdAt ?? now, updatedAt: now };
    if (existing && !unchanged) return this.move(existing, book, request, token);
    return existing ? this.update(existing, book, request) : this.create(book, request, token);
  }

  /**
   * Store a registration: the token (when one was sent) and the entry in the list of books. If the second fails the first is put
   * back (through `transaction`), so a registration that did not happen leaves neither a token nor an entry.
   */
  private async persist(book: StoredBook, request: RegisterBookRequest, transaction: Transaction): Promise<void> {
    const { bookId } = book;
    if (request.githubToken !== undefined) {
      // A stored token that cannot be read (a damaged entry) must not stop a new one from replacing it.
      const previous = await this.data.bookToken(bookId).catch(() => undefined);
      await this.data.setBookToken(bookId, request.githubToken);
      transaction.onRollback(() => this.data.setBookToken(bookId, previous ?? null));
    }
    const previousEntry = (await this.data.books()).find((entry) => entry.bookId === bookId);
    await this.data.saveBook(book);
    transaction.onRollback(() => (previousEntry ? this.data.saveBook(previousEntry) : this.data.forgetBook(bookId)));
  }

  /** A book that is hosted already, with the storage it had: its token and entry are updated together, its runtime (and a run in progress) kept. */
  private async update(existing: BookRuntime, book: StoredBook, request: RegisterBookRequest): Promise<ServerBookSummary> {
    const { bookId } = book;
    const transaction = new Transaction();
    try {
      await this.persist(book, request, transaction);
    } catch (error) {
      await transaction.rollback(this.options.log);
      throw error;
    }
    // The same book again keeps its runtime: its session, its listeners and a run in progress.
    const runtime = existing;
    runtime.book = book;
    try {
      if (book.storage.kind === "github") await this.refreshToken(bookId);
      // A running book is never cloned or synced from here: the run owns its folder.
      if (!runtime.session.running) await this.prepareRepository(runtime);
      runtime.error = undefined;
    } catch (error) {
      runtime.error = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, "repository_unavailable", runtime.error);
    } finally {
      this.options.onBookChanged(bookId);
    }
    return this.summary(runtime);
  }

  /**
   * A new book is registered completely or not at all. The clone (the step that fails for reasons outside the server) comes first, in
   * a folder of its own; then the token and the entry are stored, the clone is put in place and the runtime is made. If any of it
   * fails the registration is undone: no token, no entry, no runtime, and no folder that this call made.
   */
  private async create(book: StoredBook, request: RegisterBookRequest, token: string | undefined): Promise<ServerBookSummary> {
    const { bookId, storage } = book;
    const directory = this.data.bookDirectory(bookId);
    const parent = path.dirname(directory);
    const folderExisted = existsSync(directory);
    const parentExisted = existsSync(parent);
    const transaction = new Transaction();
    let staged: { directory: string; head: string | undefined } | undefined;
    let runtime: BookRuntime | undefined;
    try {
      // A working copy that is already there (put there by its owner, or left by a crash) is used as it is; otherwise a GitHub book is cloned.
      if (storage.kind === "github" && this.options.gitAvailable && !existsSync(path.join(directory, ".git"))) {
        try {
          staged = await this.stage(bookId, storage, () => token);
        } catch (error) {
          throw new HttpError(502, "repository_unavailable", error instanceof Error ? error.message : String(error));
        }
      }
      await this.persist(book, request, transaction);
      if (staged) {
        const trashed = await this.swapIn(bookId, staged.directory);
        transaction.onRollback(async () => {
          await rm(directory, { recursive: true, force: true });
          if (trashed) await renameReplacing(trashed, directory);
        });
      }
      runtime = this.instantiate(book);
      const made = runtime;
      transaction.onRollback(async () => {
        made.unsubscribe();
        this.runtimes.delete(bookId);
        this.tokenCache.delete(bookId);
      });
      if (storage.kind === "github") await this.refreshToken(bookId);
      if (staged) runtime.lastSync = { at: new Date().toISOString(), ok: true, message: "Cloned from GitHub.", head: staged.head };
      else {
        try {
          await this.prepareRepository(runtime);
        } catch (error) {
          throw new HttpError(502, "repository_unavailable", error instanceof Error ? error.message : String(error));
        }
      }
      runtime.error = undefined;
    } catch (error) {
      await transaction.rollback(this.options.log);
      if (staged) await rm(staged.directory, { recursive: true, force: true }).catch(() => undefined);
      if (!folderExisted) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (!parentExisted) await rmdir(parent).catch(() => undefined);
      throw error;
    }
    this.options.onBookChanged(bookId);
    return this.summary(runtime);
  }

  /** Make sure the working copy exists and, for a GitHub book, is up to date. */
  private async prepareRepository(runtime: BookRuntime): Promise<void> {
    const { book, git } = runtime;
    const directory = this.data.bookDirectory(book.bookId);
    if (book.storage.kind === "github" && git) {
      if (existsSync(path.join(directory, ".git"))) {
        // A copy that conflicts with GitHub is still a book: `lastSync` says it, and the author resolves it.
        await this.syncGitHub(book.bookId).catch((error) => {
          if (!(error instanceof HttpError && error.code === "github_conflict")) throw error;
        });
        return;
      }
      const staged = await this.stage(book.bookId, book.storage, () => this.tokenCache.get(book.bookId));
      await runtime.store.exclusive(() => this.swapIn(book.bookId, staged.directory));
      runtime.lastSync = { at: new Date().toISOString(), ok: true, message: "Cloned from GitHub.", head: staged.head };
    } else {
      await mkdir(directory, { recursive: true });
      if (git && !existsSync(path.join(directory, ".git"))) await git.init();
    }
  }

  /**
   * Build a working copy next to the final one (a clone, or an empty repository), so the copy in place
   * stays untouched until the new one is complete.
   */
  private async stage(bookId: string, storage: StoredBook["storage"], token: () => string | undefined): Promise<{ directory: string; head: string | undefined }> {
    const final = this.data.bookDirectory(bookId);
    const parent = path.dirname(final);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(parent)) if (entry.startsWith("repo.new-")) await rm(path.join(parent, entry), { recursive: true, force: true });
    const directory = `${final}.new-${randomUUID().slice(0, 8)}`;
    try {
      const git = this.makeGit(directory, storage, token);
      if (storage.kind === "github") {
        await git?.clone();
      } else {
        await mkdir(directory, { recursive: true });
        await git?.init();
      }
      return { directory, head: await git?.head() };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Put a staged working copy in place; the copy it replaces goes to the trash, never to waste (and its place in the trash is returned). */
  private async swapIn(bookId: string, staged: string): Promise<string | undefined> {
    const directory = this.data.bookDirectory(bookId);
    const trashed = await this.data.moveToTrash(bookId);
    try {
      await renameReplacing(staged, directory);
    } catch (error) {
      if (trashed) await renameReplacing(trashed, directory).catch(() => undefined);
      await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return trashed;
  }

  /**
   * Change where a book is stored: the new copy is built first, the token and the entry are stored, and only then is the new copy put in
   * place. A failure at any step leaves the old copy, the old registration and the old token as they were.
   */
  private async move(existing: BookRuntime, book: StoredBook, request: RegisterBookRequest, token: string | undefined): Promise<ServerBookSummary> {
    const { bookId } = book;
    let staged: { directory: string; head: string | undefined };
    try {
      staged = await this.stage(bookId, book.storage, () => token);
    } catch (error) {
      throw new HttpError(502, "repository_unavailable", error instanceof Error ? error.message : String(error));
    }
    if (existing.session.running) {
      await rm(staged.directory, { recursive: true, force: true }).catch(() => undefined);
      throw new HttpError(409, "busy", "Pause the autopilot before changing where the book is stored.");
    }
    const directory = this.data.bookDirectory(bookId);
    const transaction = new Transaction();
    try {
      await this.persist(book, request, transaction);
      // No commit of the old copy is in flight while it moves to the trash.
      const trashed = await existing.store.exclusive(() => this.swapIn(bookId, staged.directory));
      transaction.onRollback(async () => {
        await rm(directory, { recursive: true, force: true });
        if (trashed) await renameReplacing(trashed, directory);
      });
    } catch (error) {
      await transaction.rollback(this.options.log);
      await rm(staged.directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const runtime = this.instantiate(book);
    if (book.storage.kind === "github") await this.refreshToken(bookId);
    runtime.lastSync = book.storage.kind === "github" ? { at: new Date().toISOString(), ok: true, message: "Cloned from GitHub.", head: staged.head } : null;
    this.options.onBookChanged(bookId);
    return this.summary(runtime);
  }

  async remove(bookId: string): Promise<void> {
    assertBookId(bookId);
    return this.locks.run(bookId, async () => {
      const runtime = this.get(bookId);
      if (runtime.session.running) throw new HttpError(409, "busy", "Pause the autopilot before removing the book from the server.");
      // No commit or sync of the book is in the middle of its folder while that folder goes to the trash.
      await runtime.store.exclusive(() => this.data.removeBook(bookId));
      runtime.unsubscribe();
      this.runtimes.delete(bookId);
      this.tokenCache.delete(bookId);
      this.options.spend.forgetBook(bookId);
    });
  }

  async syncGitHub(bookId: string): Promise<ServerBookSummary> {
    const runtime = this.get(bookId);
    const { git } = runtime;
    if (runtime.book.storage.kind !== "github" || !git) throw new HttpError(400, "not_github", "This book is not linked to GitHub.");
    await this.refreshToken(bookId);
    try {
      // One at a time per book, and never during a commit: a pull rewrites files, two pulls fight over git's index lock.
      await runtime.store.exclusive(async () => {
        const policy = { runActive: runtime.session.running };
        const pulled = await git.pull(policy);
        await git.push(policy);
        runtime.lastSync = { at: new Date().toISOString(), ok: true, message: pulled.changed ? "Pulled and pushed." : "Up to date.", head: await git.head() };
      });
    } catch (error) {
      if (error instanceof GithubConflictError) {
        runtime.lastSync = { at: new Date().toISOString(), ok: false, message: error.message, conflicts: error.total };
        throw new HttpError(409, "github_conflict", error.message, {}, { conflicts: error.total });
      }
      runtime.lastSync = { at: new Date().toISOString(), ok: false, message: error instanceof Error ? error.message : String(error) };
      throw new HttpError(409, "sync_failed", runtime.lastSync.message);
    } finally {
      this.options.onBookChanged(bookId);
    }
    return this.summary(runtime);
  }

  /** The working copy of a book on GitHub: `409 no_remote` for any other. */
  private githubOf(runtime: BookRuntime): GitRepository {
    if (runtime.book.storage.kind !== "github" || !runtime.git) throw new HttpError(409, "no_remote", "This book is not on GitHub: it has no conflicts with GitHub to resolve.");
    return runtime.git;
  }

  /** A failure of git that is not a refusal of the request: what it said, without the token, as a `502`. */
  private gitFailure(bookId: string, error: unknown): unknown {
    if (error instanceof HttpError) return error;
    const message = redactSecrets(error instanceof Error ? error.message : String(error), [this.tokenCache.get(bookId) ?? ""]).slice(0, PUBLISH_MESSAGE_CHARACTERS);
    return new HttpError(502, "git_failed", message);
  }

  /**
   * The conflicts of a GitHub book with GitHub, a page at a time (`GET …/github-conflicts`): GitHub is fetched, and the two are compared by a merge that
   * writes nothing, one operation of the book at a time. The list it gives is the one a resolution without a fingerprint is checked against.
   */
  async githubConflicts(bookId: string, page: { offset: number; limit: number }): Promise<GithubConflictsResponse> {
    const runtime = this.get(bookId);
    const git = this.githubOf(runtime);
    await this.refreshToken(bookId);
    try {
      const listing = await runtime.store.exclusive(() => git.githubConflicts(page, { runActive: runtime.session.running }));
      this.listedConflicts.set(bookId, listing.fingerprint);
      return listing;
    } catch (error) {
      throw this.gitFailure(bookId, error);
    }
  }

  /**
   * Resolve them (`POST …/github-conflicts/resolve`): one merge commit with the version the author chose of every file, pushed when the book is
   * published (`publishEvery` other than `off`), with the run stopped (`409 busy` otherwise: the run's files must not change under it). The run is
   * not started again: the author resumes it. `lastSync` says how it went; the log says that it happened, with the counts and never a file.
   */
  async resolveGithubConflicts(bookId: string, request: ResolveGithubConflictsRequest): Promise<ResolveGithubConflictsResponse> {
    this.assertNotInMaintenance();
    const runtime = this.get(bookId);
    const git = this.githubOf(runtime);
    if (runtime.session.running) throw new HttpError(409, "busy", "Pause the autopilot before resolving the conflicts with GitHub.");
    await this.refreshToken(bookId);
    const publish = (await runtime.session.snapshot()).summary?.publish ?? DEFAULT_PUBLISH;
    const fingerprint = request.fingerprint ?? this.listedConflicts.get(bookId);
    try {
      const result = await runtime.store.exclusive(() => git.resolveGithubConflicts({ ...request, ...(fingerprint ? { fingerprint } : {}) }, { runActive: false, push: publish !== "off" }));
      const { counts } = result;
      const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
      runtime.lastSync = {
        at: new Date().toISOString(),
        ok: result.pushed || publish === "off",
        message: result.pushed ? "The conflicts with GitHub were resolved and pushed." : result.pushError ? `The conflicts with GitHub were resolved on the server; the push failed: ${redactSecrets(result.pushError, [this.tokenCache.get(bookId) ?? ""])}` : "The conflicts with GitHub were resolved on the server (the book is not published).",
        head: result.head,
      };
      this.listedConflicts.delete(bookId);
      this.options.log(`Book ${bookId}: the conflicts with GitHub were resolved (${files(counts.total)}: ${counts.server} kept from the server, ${counts.github} taken from GitHub, ${counts.unresolvable} kept because they cannot be chosen for here)${result.pushed ? "" : ", not pushed"}.`);
      return result;
    } catch (error) {
      throw this.gitFailure(bookId, error);
    } finally {
      this.options.onBookChanged(bookId);
    }
  }

  async summary(runtime: BookRuntime): Promise<ServerBookSummary> {
    const snapshot = await runtime.session.snapshot();
    const revision = (runtime.git && existsSync(path.join(runtime.store.root, ".git")) ? await runtime.git.head() : undefined) ?? await runtime.store.contentRevision();
    // Why the book cannot be used: the repository failed, or the autopilot's state file exists but cannot be read.
    const error = runtime.error ?? snapshot.stateError?.message;
    return {
      bookId: runtime.book.bookId,
      title: runtime.book.title,
      storage: runtime.book.storage,
      hasGithubToken: Boolean(await this.data.bookToken(runtime.book.bookId)),
      ready: existsSync(runtime.store.root),
      revision,
      // What the live session says: the pause that waits, the limits of the run and where the book is published (the state file alone says none of them, and nothing of the server's default).
      autopilot: snapshot.summary ?? null,
      running: runtime.session.running,
      lastSync: runtime.lastSync,
      ...(error ? { error } : {}),
    };
  }

  async summaries(): Promise<ServerBookSummary[]> {
    return Promise.all(this.all().map((runtime) => this.summary(runtime)));
  }

  async aiConfigured(): Promise<boolean> {
    if (this.options.ai) return true;
    return (await this.data.aiConfig()).config.aiIntegrations.length > 0;
  }

  /**
   * The server is stopping: every run pauses now, and its state says that the server stopped it (`stoppedBy: "server-shutdown"`), so that the
   * server resumes it when it starts again if its author asked for it (`options.resumeAfterRestart`). A pause the author asked for stays the author's.
   */
  async close(): Promise<void> {
    for (const runtime of this.all()) runtime.session.stopForShutdown();
    await Promise.all(this.all().map((runtime) => runtime.session.waitForIdle()));
  }
}
