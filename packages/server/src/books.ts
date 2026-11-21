import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
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
import { assertBookId, type DataDirectory, type ServerConfig, type StoredBook } from "./config.js";
import { FileBookStore } from "./fs-store.js";
import { GitRepository } from "./git.js";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface BookRuntime {
  book: StoredBook;
  store: FileBookStore;
  git: GitRepository | null;
  session: AutopilotSession;
  lastSync: ServerBookSync | null;
  error?: string;
  unsubscribe: () => void;
}

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
  const branch = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/@+-]{1,200}$/;
  if (value?.kind === "github" && typeof value.owner === "string" && segment.test(value.owner) && typeof value.repo === "string" && segment.test(value.repo) && typeof value.branch === "string" && branch.test(value.branch)) {
    return { kind: "github", owner: value.owner, repo: value.repo, branch: value.branch };
  }
  throw new HttpError(400, "invalid_storage", "The book storage must be `local` or a GitHub owner, repository and branch.");
}

/** Books hosted by the server, each with its working copy and its autopilot session. */
export class BookRegistry {
  private readonly runtimes = new Map<string, BookRuntime>();
  private aiCache: { updatedAt: string | null; port: AiPort; configured: boolean } | null = null;

  constructor(private readonly data: DataDirectory, private readonly config: ServerConfig, private readonly options: BookRegistryOptions) {}

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
    for (const book of await this.data.books()) {
      try {
        this.instantiate(book);
      } catch (error) {
        this.options.log(`Book ${book.bookId} could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private instantiate(book: StoredBook): BookRuntime {
    this.runtimes.get(book.bookId)?.unsubscribe();
    const directory = this.data.bookDirectory(book.bookId);
    const git = this.options.gitAvailable
      ? new GitRepository(directory, book.storage.kind === "github"
        ? { owner: book.storage.owner, repo: book.storage.repo, branch: book.storage.branch, token: () => this.tokenCache.get(book.bookId), url: this.options.githubRemoteUrl?.(book.storage.owner, book.storage.repo) }
        : undefined)
      : null;
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
        hostLabel: this.config.label,
        hostId: this.config.serverId,
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
    if (this.runningCount() >= this.config.maxConcurrentRuns) {
      throw new HttpError(429, "too_many_runs", `The server already runs ${this.config.maxConcurrentRuns} autopilots: pause one before starting another.`);
    }
  }

  async register(bookId: string, request: RegisterBookRequest): Promise<ServerBookSummary> {
    assertBookId(bookId);
    const title = typeof request.title === "string" && request.title.trim() ? request.title.trim().slice(0, 300) : bookId;
    const storage = validStorage(request.storage);
    const existing = this.runtimes.get(bookId);
    if (existing?.session.running && !sameStorage(existing.book.storage, storage)) throw new HttpError(409, "busy", "Pause the autopilot before changing where the book is stored.");
    if (request.githubToken !== undefined) await this.data.setBookToken(bookId, request.githubToken);
    const directory = this.data.bookDirectory(bookId);
    const now = new Date().toISOString();
    const book: StoredBook = { bookId, title, storage, createdAt: existing?.book.createdAt ?? now, updatedAt: now };
    const moved = existing && !sameStorage(existing.book.storage, storage);
    if (moved) await rm(directory, { recursive: true, force: true });
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    if (storage.kind === "github") {
      if (!this.options.gitAvailable) throw new HttpError(412, "git_unavailable", "Install git on the server to host GitHub books.");
      if (!(await this.data.bookToken(bookId))) throw new HttpError(412, "github_token_required", "Send the book's GitHub token (with your consent) so the server can clone and push it.");
    }
    await this.data.saveBook(book);
    const runtime = this.instantiate(book);
    try {
      if (storage.kind === "github" && runtime.git) {
        await this.refreshToken(bookId);
        if (!existsSync(path.join(directory, ".git"))) {
          await rm(directory, { recursive: true, force: true });
          await runtime.git.clone();
          runtime.lastSync = { at: new Date().toISOString(), ok: true, message: "Cloned from GitHub.", head: await runtime.git.head() };
        } else if (!runtime.session.running) {
          await this.syncGitHub(bookId);
        }
      } else {
        await mkdir(directory, { recursive: true });
        if (runtime.git && !existsSync(path.join(directory, ".git"))) await runtime.git.init();
      }
      runtime.error = undefined;
    } catch (error) {
      runtime.error = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, "repository_unavailable", runtime.error);
    } finally {
      this.options.onBookChanged(bookId);
    }
    return this.summary(runtime);
  }

  async remove(bookId: string): Promise<void> {
    const runtime = this.get(bookId);
    if (runtime.session.running) throw new HttpError(409, "busy", "Pause the autopilot before removing the book from the server.");
    runtime.unsubscribe();
    this.runtimes.delete(bookId);
    await this.data.removeBook(bookId);
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
      ...(runtime.error ? { error: runtime.error } : {}),
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
