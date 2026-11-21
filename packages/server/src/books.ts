import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  AiUnavailableError,
  AutopilotSession,
  createFetchAi,
  hasAiCandidates,
  summarizeAutopilotState,
  type AiPort,
  type AiRequest,
  type AiResponse,
  type AutopilotEvent,
  type RegisterBookRequest,
  type ServerBookSummary,
  type ServerBookSync,
} from "narrarium-engine";
import { assertBookId, assertBookToken, type DataDirectory, type StoredBook } from "./config.js";
import { HttpError } from "./errors.js";
import { renameReplacing } from "./files.js";
import { FileBookStore, KeyedMutex } from "./fs-store.js";
import { GitRepository } from "./git.js";

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

export interface BookRegistryOptions {
  gitAvailable: boolean;
  /** Fixed AI port (tests); otherwise the AI configuration saved on the server is used. */
  ai?: AiPort;
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

/** Books hosted by the server, each with its working copy and its autopilot session. */
export class BookRegistry {
  private readonly runtimes = new Map<string, BookRuntime>();
  /** Ids of new books being registered right now: they already take a place. */
  private readonly arriving = new Set<string>();
  /** `register` and `remove` of one book never overlap. */
  private readonly locks = new KeyedMutex();
  private aiCache: { updatedAt: string | null; port: AiPort; configured: boolean } | null = null;
  /** Set once an update is accepted: the server only finishes what it is doing and then restarts. */
  private maintenance = false;

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

  /** AI port reading the latest saved configuration on every call. */
  private readonly ai: AiPort = {
    complete: async (request: AiRequest): Promise<AiResponse> => {
      if (this.options.ai) return this.options.ai.complete(request);
      const { config, updatedAt } = await this.data.aiConfig();
      if (!this.aiCache || this.aiCache.updatedAt !== updatedAt) this.aiCache = { updatedAt, port: createFetchAi(config), configured: config.aiIntegrations.length > 0 };
      if (!hasAiCandidates(config, request.capability)) throw new AiUnavailableError(request.capability);
      return this.aiCache.port.complete(request);
    },
  };

  async load(): Promise<void> {
    await this.data.purgeTrash().then(
      (removed) => {
        if (removed.length) this.options.log(`Deleted ${removed.length} book copies from the trash after the retention period.`);
      },
      (error) => this.options.log(`The trash could not be cleaned: ${error instanceof Error ? error.message : String(error)}`),
    );
    for (const book of await this.data.books()) {
      try {
        this.instantiate(book);
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
        ai: this.ai,
        host: "server",
        hostLabel: this.data.config.label,
        hostId: this.data.config.serverId,
        hooks: book.storage.kind === "github" && git ? {
          beforeStep: async () => {
            await this.refreshToken(book.bookId);
            const result = await git.pull();
            if (result.changed) this.options.onBookChanged(book.bookId);
          },
          afterCommit: async () => {
            await this.refreshToken(book.bookId);
            await git.push();
            runtime.lastSync = { at: new Date().toISOString(), ok: true, message: "Pushed to GitHub.", head: await git.head() };
          },
        } : undefined,
      }),
      lastSync: null,
      unsubscribe: () => undefined,
    };
    runtime.unsubscribe = runtime.session.subscribe((event) => {
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

    if (request.githubToken !== undefined) await this.data.setBookToken(bookId, request.githubToken);
    await this.data.saveBook(book);
    // The same book again keeps its runtime: its session, its listeners and a run in progress.
    const runtime = existing ?? this.instantiate(book);
    runtime.book = book;
    try {
      if (storage.kind === "github") await this.refreshToken(bookId);
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

  /** Make sure the working copy exists and, for a GitHub book, is up to date. */
  private async prepareRepository(runtime: BookRuntime): Promise<void> {
    const { book, git } = runtime;
    const directory = this.data.bookDirectory(book.bookId);
    if (book.storage.kind === "github" && git) {
      if (existsSync(path.join(directory, ".git"))) {
        await this.syncGitHub(book.bookId);
        return;
      }
      const staged = await this.stage(book.bookId, book.storage, () => this.tokenCache.get(book.bookId));
      await this.swapIn(book.bookId, staged.directory);
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

  /** Put a staged working copy in place; the copy it replaces goes to the trash, never to waste. */
  private async swapIn(bookId: string, staged: string): Promise<void> {
    const directory = this.data.bookDirectory(bookId);
    const trashed = await this.data.moveToTrash(bookId);
    try {
      await renameReplacing(staged, directory);
    } catch (error) {
      if (trashed) await renameReplacing(trashed, directory).catch(() => undefined);
      await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Change where a book is stored: the new copy is built first, and a failure leaves the old copy and the registration as they were. */
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
    await this.swapIn(bookId, staged.directory);
    if (request.githubToken !== undefined) await this.data.setBookToken(bookId, request.githubToken);
    await this.data.saveBook(book);
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
      await this.data.removeBook(bookId);
      runtime.unsubscribe();
      this.runtimes.delete(bookId);
      this.tokenCache.delete(bookId);
    });
  }

  async syncGitHub(bookId: string): Promise<ServerBookSummary> {
    const runtime = this.get(bookId);
    if (runtime.book.storage.kind !== "github" || !runtime.git) throw new HttpError(400, "not_github", "This book is not linked to GitHub.");
    await this.refreshToken(bookId);
    try {
      const pulled = await runtime.git.pull();
      await runtime.git.push();
      runtime.lastSync = { at: new Date().toISOString(), ok: true, message: pulled.changed ? "Pulled and pushed." : "Up to date.", head: await runtime.git.head() };
    } catch (error) {
      runtime.lastSync = { at: new Date().toISOString(), ok: false, message: error instanceof Error ? error.message : String(error) };
      throw new HttpError(409, "sync_failed", runtime.lastSync.message);
    } finally {
      this.options.onBookChanged(bookId);
    }
    return this.summary(runtime);
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
      autopilot: snapshot.state ? summarizeAutopilotState(snapshot.state) : null,
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

  async close(): Promise<void> {
    for (const runtime of this.all()) runtime.session.pause("now");
    await Promise.all(this.all().map((runtime) => runtime.session.waitForIdle()));
  }
}
