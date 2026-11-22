import {
  SERVER_FEATURE_AUTOPILOT_CONTROLS,
  ServerRequestError,
  createAutopilotState,
  isBookConflictError,
  summarizeAutopilotState,
  type AutopilotLiveOptions,
  type AutopilotSnapshot,
  type AutopilotState,
  type AutopilotStatus,
  type NarrariumServerClient,
  type PauseAutopilotMode,
  type ServerAiStatus,
  type ServerBookSummary,
  type ServerInfo,
} from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

/** A server that announces the quick controls of the autopilot (`SERVER_FEATURE_AUTOPILOT_CONTROLS`). */
export const SERVER_INFO = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.5", engineVersion: "0.1.5", serverId: "server-1", label: "Home server", git: true, features: [SERVER_FEATURE_AUTOPILOT_CONTROLS] } as ServerInfo;
/** A server that predates them: it ignores `limits` and takes `after-chapter` and `cancel` for `after-step`. */
export const OLD_SERVER_INFO = { ...SERVER_INFO, serverVersion: "0.1.4", engineVersion: "0.1.4", features: [] } as ServerInfo;
export const PIN = "f".repeat(64);

/**
 * A personal server that hosts one book in a `MemoryBookStore`: the book's files go through the same compare-and-swap
 * rules as the real ones, and every call can be held back or made to fail by name.
 */
export class FakeBookServer {
  readonly store: MemoryBookStore;
  /** Every call, in order. */
  readonly calls: string[] = [];
  /** A call named here waits for the promise before it is served. */
  readonly gates: Record<string, Promise<void> | undefined> = {};
  /** A call named here fails with the error. */
  readonly failures: Record<string, Error | undefined> = {};
  readonly registered: Array<{ bookId: string; input: unknown }> = [];
  /** The state the book's autopilot is in on the server. */
  running = false;
  bookMissing = false;
  /** The server announces the quick controls (`SERVER_FEATURE_AUTOPILOT_CONTROLS`); false is a server that predates them. */
  controls = true;
  /** What the server holds for the book: its AI configuration, and the GitHub token of the book. */
  aiConfigured = true;
  hasGithubToken = false;
  /** The pause that waits on the run (what the summary says as `pausePending`), and the limits the run was started with. */
  pausePending: "after-step" | "after-chapter" | null = null;
  limits: { steps?: number; chapters?: number } | null = null;
  /** The status the stored state has while nothing runs, and its message (what the last run ended with). */
  endedAs: AutopilotStatus = "paused";
  endMessage: string | null = null;
  /** Called after `startAutopilot` has marked the run as running, to script what the run does next. */
  onStart?: (options: unknown) => void;
  /** Called after `pauseAutopilot` recorded the mode. */
  onPause?: (mode: string) => void;

  constructor(initial: Record<string, string> = {}) {
    this.store = new MemoryBookStore(initial);
  }

  private async serve(name: string): Promise<void> {
    this.calls.push(name);
    await this.gates[name];
    const failure = this.failures[name];
    if (failure) throw failure;
  }

  count(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }

  /** The server's own `GET /info`, with or without the quick controls. */
  info(): ServerInfo {
    return this.controls ? SERVER_INFO : OLD_SERVER_INFO;
  }

  summary(bookId: string): ServerBookSummary {
    return { bookId, title: "The Glass Harbor", storage: { kind: "local" }, hasGithubToken: this.hasGithubToken, ready: true, revision: "r1", autopilot: null, running: this.running, lastSync: null };
  }

  /** The run ends, as the server's engine ends it: the stored state says how, and nothing waits any more. */
  stop(status: AutopilotStatus = "paused", message: string | null = null): void {
    this.running = false;
    this.pausePending = null;
    this.limits = null;
    this.endedAs = status;
    this.endMessage = message;
  }

  state(): AutopilotState {
    return { ...createAutopilotState(new Date("2026-11-21T10:00:00.000Z")), status: this.running ? "running" : this.endedAs, message: this.running ? null : this.endMessage };
  }

  snapshot(bookId: string): AutopilotSnapshot {
    const state = this.state();
    const limits = this.running && this.limits ? { ...this.limits, stepsDone: 0, chaptersDone: 0 } : null;
    const summary = summarizeAutopilotState(state, { pausePending: this.running ? this.pausePending : null, limits, defaultPublish: "step" });
    return { bookId, state, summary, activities: [], live: null, running: this.running, host: this.running ? "server" : null };
  }

  /** What `verifiedServer` returns. */
  verified() {
    return { client: this.client(), info: this.info(), fingerprint: PIN };
  }

  client(): NarrariumServerClient {
    const server = this;
    const fake = {
      async manifest(_bookId: string) {
        await server.serve("manifest");
        return { revision: "r1", files: await server.store.list() };
      },
      async readFiles(_bookId: string, paths: string[]) {
        await server.serve("readFiles");
        return server.store.readMany(paths);
      },
      async commitFiles(_bookId: string, changes: Parameters<MemoryBookStore["commit"]>[0], message: string) {
        await server.serve("commitFiles");
        try {
          return await server.store.commit(changes, message);
        } catch (error) {
          if (isBookConflictError(error)) throw new ServerRequestError(error.message, 409, "conflict");
          throw error;
        }
      },
      async autopilot(bookId: string) {
        await server.serve("autopilot");
        if (server.bookMissing) throw new ServerRequestError("This book is not on the server.", 404, "book_not_found");
        return server.snapshot(bookId);
      },
      async registerBook(bookId: string, input: unknown) {
        await server.serve("registerBook");
        server.registered.push({ bookId, input });
        return server.summary(bookId);
      },
      async putAiConfig() {
        await server.serve("putAiConfig");
        server.aiConfigured = true;
        return { configured: true, integrations: [], routedTasks: [], updatedAt: null };
      },
      async aiStatus(): Promise<ServerAiStatus> {
        await server.serve("aiStatus");
        return { configured: server.aiConfigured, integrations: [], routedTasks: [], updatedAt: null };
      },
      async syncGitHub(bookId: string) {
        await server.serve("syncGitHub");
        return server.summary(bookId);
      },
      async startAutopilot(bookId: string, options: { limits?: { steps?: number; chapters?: number } }) {
        await server.serve("startAutopilot");
        server.started.push(options);
        server.running = true;
        server.pausePending = null;
        server.limits = options?.limits ?? null;
        server.onStart?.(options);
        return server.snapshot(bookId);
      },
      async pauseAutopilot(bookId: string, mode: PauseAutopilotMode) {
        await server.serve("pauseAutopilot");
        server.paused.push(mode);
        if (server.running) {
          // A server that predates the quick controls takes every mode but `now` for `after-step`, and `cancel` too.
          const effective = server.controls || mode === "now" ? mode : "after-step";
          if (effective === "cancel") server.pausePending = null;
          else if (effective === "after-step" || effective === "after-chapter") server.pausePending = server.pausePending === "after-step" ? "after-step" : effective;
        }
        server.onPause?.(mode);
        return server.snapshot(bookId);
      },
      async configureAutopilot(bookId: string, options: unknown) {
        await server.serve("configureAutopilot");
        server.configured.push(options);
        return server.snapshot(bookId);
      },
      async updateAutopilotOptions(bookId: string, options: AutopilotLiveOptions) {
        await server.serve("updateAutopilotOptions");
        server.optionsUpdated.push(options);
        return server.snapshot(bookId);
      },
      async updateOptions(bookId: string, options: AutopilotLiveOptions) {
        return fake.updateAutopilotOptions(bookId, options);
      },
      async listBooks() {
        await server.serve("listBooks");
        return [server.summary("book-1")];
      },
      async updates() {
        return { packageName: "narrarium-server", installedVersion: "0.1.0", available: false, canRequest: false, signed: true, supervised: false, hasUpdateScope: false, message: "Up to date." };
      },
      stream() {
        return new Promise<void>(() => undefined);
      },
    };
    return fake as unknown as NarrariumServerClient;
  }

  /** What `startAutopilot` was called with. */
  readonly started: unknown[] = [];
  /** What `configureAutopilot` was called with. */
  readonly configured: unknown[] = [];
  /** The modes `pauseAutopilot` was called with, in order. */
  readonly paused: string[] = [];
  /** What `updateAutopilotOptions` was called with, in order. */
  readonly optionsUpdated: unknown[] = [];
}
