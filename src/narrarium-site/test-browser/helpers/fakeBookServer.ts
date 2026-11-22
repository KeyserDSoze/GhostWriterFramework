import {
  AutopilotSession,
  FrozenChapterError,
  SERVER_FEATURE_AUTOPILOT_CONTROLS,
  SERVER_FEATURE_AUTOPILOT_FROZEN,
  SERVER_FEATURE_MCP,
  SERVER_FEATURE_MCP_OAUTH,
  ServerRequestError,
  createAutopilotState,
  isBookConflictError,
  summarizeAutopilotState,
  type AutopilotLiveOptions,
  type AutopilotSnapshot,
  type AutopilotState,
  type AutopilotStatus,
  type FrozenAction,
  type FrozenChangeKind,
  type NarrariumServerClient,
  type PauseAutopilotMode,
  type ServerAiStatus,
  type ServerBookSummary,
  type ServerInfo,
  type ServerMcpClient,
  type ServerMcpStatus,
  type UpdateMcpRequest,
} from "narrarium-engine";
import { MemoryBookStore, createFakeAutopilotAi } from "narrarium-engine/testing";

/** A server that announces the quick controls of the autopilot (`SERVER_FEATURE_AUTOPILOT_CONTROLS`). */
export const SERVER_INFO = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.5", engineVersion: "0.1.5", serverId: "server-1", label: "Home server", git: true, features: [SERVER_FEATURE_AUTOPILOT_CONTROLS] } as ServerInfo;
/** A server that predates them: it ignores `limits` and takes `after-chapter` and `cancel` for `after-step`. */
export const OLD_SERVER_INFO = { ...SERVER_INFO, serverVersion: "0.1.4", engineVersion: "0.1.4", features: [] } as ServerInfo;
export const PIN = "f".repeat(64);
/** What the server says of an MCP address while it has no public address (the words of narrarium-server). */
export const MCP_LOCAL_MESSAGE = "This server has no public address yet, so this address works only from this computer. Set the public address of the server in the admin panel (Approved network), then connect from anywhere.";
const MCP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  /**
   * The server announces the frozen chapters (`SERVER_FEATURE_AUTOPILOT_FROZEN`), and serves their routes as the real one does: with the engine's
   * own session over the book it holds. Off by default: a server that predates them.
   */
  frozen = false;
  private frozenSession: AutopilotSession | null = null;
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
  /**
   * The server gives each book its MCP endpoint (`SERVER_FEATURE_MCP`) and lets apps connect through OAuth (`SERVER_FEATURE_MCP_OAUTH`). Both off: a server that
   * predates them, which answers `404 not_found` to their routes.
   */
  mcp = false;
  mcpOAuth = false;
  /** The MCP of the book: on or off, its slug, and the public address of the server (`null`: it has none, the address is the local one). */
  mcpEnabled = false;
  mcpSlug = "the-glass-harbor";
  mcpPublicUrl: string | null = "https://books.example.net";
  /** The slugs of the other books of the server. */
  readonly takenSlugs = new Set<string>(["another-book"]);
  /** The apps connected to the book through OAuth, as the server lists them (a newer server may add fields: they are passed on as they are). */
  mcpClients: ServerMcpClient[] = [];
  /** What `updateMcp` was called with, and the connections `revokeMcpClient` revoked, in order. */
  readonly mcpUpdates: UpdateMcpRequest[] = [];
  readonly mcpRevoked: string[] = [];

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

  /** The server's own `GET /info`, with or without the quick controls, with the frozen chapters and the MCP features when it has them. */
  info(): ServerInfo {
    const info = this.controls ? SERVER_INFO : OLD_SERVER_INFO;
    const extra = [...(this.frozen ? [SERVER_FEATURE_AUTOPILOT_FROZEN] : []), ...(this.mcp ? [SERVER_FEATURE_MCP] : []), ...(this.mcpOAuth ? [SERVER_FEATURE_MCP_OAUTH] : [])];
    if (!extra.length) return info;
    return { ...info, ...(this.frozen ? { serverVersion: "0.1.9" } : {}), features: [...(info.features ?? []), ...extra] };
  }

  /** The engine's session over the book the server holds, as the real server answers the routes of the frozen chapters. */
  private session(bookId: string): AutopilotSession {
    this.frozenSession ??= new AutopilotSession({ bookId, store: this.store, ai: createFakeAutopilotAi(), host: "server", hostLabel: "Home server" });
    return this.frozenSession;
  }

  /** A refusal of the engine, as the server answers it: the status of its code, and the code. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FrozenChapterError) throw new ServerRequestError(error.message, error.code === "chapter_not_found" ? 404 : error.code === "not_changed" ? 409 : 400, error.code);
      throw error;
    }
  }

  /** The status of the book's MCP, as `GET /books/:id/mcp` answers it: `connections` and `oauth` only from a server with OAuth apps. */
  mcpStatus(bookId: string): ServerMcpStatus {
    const path = `/mcp/${this.mcpSlug}`;
    const base = this.mcpPublicUrl ?? "http://127.0.0.1:24242";
    return {
      bookId,
      enabled: this.mcpEnabled,
      slug: this.mcpSlug,
      path,
      url: `${base}${path}`,
      public: Boolean(this.mcpPublicUrl),
      ...(this.mcpPublicUrl ? {} : { message: MCP_LOCAL_MESSAGE }),
      protocolVersions: ["2025-06-18", "2025-03-26"],
      updatedAt: "2026-11-21T10:00:00.000Z",
      ...(this.mcpOAuth ? { connections: this.mcpClients.length, oauth: { issuer: base, metadataUrl: `${base}/.well-known/oauth-authorization-server`, resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource${path}`, scopes: ["mcp:read", "mcp:write", "mcp:run"] } } : {}),
    };
  }

  /** The refusals of the MCP routes: a server without the feature does not know them, and a book that is not there is not found. */
  private requireMcp(oauth = false): void {
    if (!this.mcp || (oauth && !this.mcpOAuth)) throw new ServerRequestError("Unknown endpoint.", 404, "not_found");
    if (this.bookMissing) throw new ServerRequestError("This book is not on the server.", 404, "book_not_found");
  }

  /** `PUT /books/:id/mcp` with the rules of narrarium-server: switching off, or another slug, disconnects every app of the book. */
  updateMcp(bookId: string, input: UpdateMcpRequest): ServerMcpStatus {
    this.requireMcp();
    if (input.enabled === undefined && input.slug === undefined) throw new ServerRequestError("Nothing to change.", 400, "invalid_request");
    if (input.slug !== undefined && input.slug !== this.mcpSlug) {
      if (!MCP_SLUG.test(input.slug) || input.slug.length > 80) throw new ServerRequestError("A slug is made of lowercase letters, digits and single hyphens.", 400, "invalid_slug");
      if (this.takenSlugs.has(input.slug)) throw new ServerRequestError("Another book has this slug.", 409, "slug_taken");
      this.mcpSlug = input.slug;
      this.mcpClients = [];
    }
    if (input.enabled !== undefined) {
      if (!input.enabled) this.mcpClients = [];
      this.mcpEnabled = input.enabled;
    }
    return this.mcpStatus(bookId);
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
      async frozenStatus(bookId: string) {
        await server.serve("frozenStatus");
        return server.session(bookId).frozenStatus();
      },
      async resolveFrozenChange(bookId: string, number: number, action: FrozenAction, options: { kind?: FrozenChangeKind; note?: string } = {}) {
        await server.serve("resolveFrozenChange");
        server.resolved.push({ number, action, options });
        return server.refusing(() => server.session(bookId).resolveFrozenChange(number, action, options));
      },
      async freezeChapter(bookId: string, slug: string, frozen = true) {
        await server.serve("freezeChapter");
        const session = server.session(bookId);
        return server.refusing(() => (frozen ? session.freezeChapter(slug) : session.unfreezeChapter(slug)));
      },
      async listBooks() {
        await server.serve("listBooks");
        return [server.summary("book-1")];
      },
      async updates() {
        return { packageName: "narrarium-server", installedVersion: "0.1.0", available: false, canRequest: false, signed: true, supervised: false, hasUpdateScope: false, message: "Up to date." };
      },
      async mcpStatus(bookId: string) {
        await server.serve("mcpStatus");
        server.requireMcp();
        return server.mcpStatus(bookId);
      },
      async updateMcp(bookId: string, input: UpdateMcpRequest) {
        await server.serve("updateMcp");
        server.mcpUpdates.push(input);
        return server.updateMcp(bookId, input);
      },
      async listMcpClients(_bookId: string) {
        // The server answers with the apps it has when the request arrives; a gate holds the answer back on its way.
        const answer = server.mcpClients.map((client) => ({ ...client }));
        await server.serve("listMcpClients");
        server.requireMcp(true);
        return answer;
      },
      async revokeMcpClient(_bookId: string, id: string) {
        await server.serve("revokeMcpClient");
        server.requireMcp(true);
        const index = server.mcpClients.findIndex((client) => client.id === id);
        if (index < 0) throw new ServerRequestError("The book has no such connection.", 404, "client_missing");
        server.mcpClients.splice(index, 1);
        server.mcpRevoked.push(id);
        return { revoked: true };
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
  /** What `resolveFrozenChange` was called with, in order. */
  readonly resolved: Array<{ number: number; action: FrozenAction; options: { kind?: FrozenChangeKind; note?: string } }> = [];
}
