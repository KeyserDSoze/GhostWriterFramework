import { ServerRequestError, createAutopilotState, isBookConflictError, type AutopilotSnapshot, type NarrariumServerClient, type ServerBookSummary, type ServerInfo } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

export const SERVER_INFO = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.0", engineVersion: "0.1.2", serverId: "server-1", label: "Home server", git: true, features: [] } as ServerInfo;
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

  summary(bookId: string): ServerBookSummary {
    return { bookId, title: "The Glass Harbor", storage: { kind: "local" }, hasGithubToken: false, ready: true, revision: "r1", autopilot: null, running: this.running, lastSync: null };
  }

  snapshot(bookId: string): AutopilotSnapshot {
    const state = { ...createAutopilotState(new Date("2026-11-21T10:00:00.000Z")), status: this.running ? "running" as const : "paused" as const };
    return { bookId, state, activities: [], live: null, running: this.running, host: this.running ? "server" : null };
  }

  /** What `verifiedServer` returns. */
  verified() {
    return { client: this.client(), info: SERVER_INFO, fingerprint: PIN };
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
        return { configured: true, integrations: [], routedTasks: [], updatedAt: null };
      },
      async syncGitHub(bookId: string) {
        await server.serve("syncGitHub");
        return server.summary(bookId);
      },
      async startAutopilot(bookId: string, options: unknown) {
        await server.serve("startAutopilot");
        server.started.push(options);
        return server.snapshot(bookId);
      },
      async pauseAutopilot(bookId: string) {
        await server.serve("pauseAutopilot");
        return server.snapshot(bookId);
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
}
