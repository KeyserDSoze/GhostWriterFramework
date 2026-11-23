import {
  AutopilotSession,
  FrozenChapterError,
  GITHUB_CONFLICTS_PAGE_LIMIT,
  GITHUB_CONFLICT_CODE,
  NarrariumServerClient,
  SERVER_FEATURE_AUTOPILOT_CONTROLS,
  SERVER_FEATURE_AUTOPILOT_FROZEN,
  SERVER_FEATURE_AUTOPILOT_RETRY,
  SERVER_FEATURE_GITHUB_CONFLICTS,
  SERVER_FEATURE_MCP,
  SERVER_FEATURE_MCP_OAUTH,
  ServerRequestError,
  createAutopilotState,
  isBookConflictError,
  summarizeAutopilotState,
  type AiPort,
  type AutopilotLiveOptions,
  type AutopilotLongRetry,
  type AutopilotRetryInfo,
  type AutopilotSnapshot,
  type AutopilotState,
  type AutopilotStatus,
  type FrozenAction,
  type FrozenChangeKind,
  type GithubConflict,
  type GithubConflictChoice,
  type GithubConflictsResponse,
  type PauseAutopilotMode,
  type ResolveGithubConflictsRequest,
  type ResolveGithubConflictsResponse,
  type ServerAiStatus,
  type ServerBookSummary,
  type ServerBookSync,
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
/** A server that announces «Retry later» and «Retry now» too (`SERVER_FEATURE_AUTOPILOT_RETRY`). */
export const RETRY_SERVER_INFO = { ...SERVER_INFO, serverVersion: "0.1.10", engineVersion: "0.1.10", features: [SERVER_FEATURE_AUTOPILOT_CONTROLS, SERVER_FEATURE_AUTOPILOT_RETRY] } as ServerInfo;
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
  /**
   * The server announces «Retry later» and «Retry now» (`SERVER_FEATURE_AUTOPILOT_RETRY`): it keeps `longRetry` with the options and answers
   * `retry-now`. Off by default: a server that predates them, which answers 404 to the route and is never sent `longRetry` (the engine's client refuses
   * it first, with `feature_unavailable`, and so does this fake).
   */
  retry = false;
  /** The wait the run is in, as the summary says it (`summary.retry`), while it runs. */
  waiting: AutopilotRetryInfo | null = null;
  /** «Retry later» as the server keeps it with the options of the book (`null`: off). */
  longRetry: AutopilotLongRetry | null = null;
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

  /**
   * The server announces the conflicts with GitHub (`SERVER_FEATURE_GITHUB_CONFLICTS`) and serves the two routes with the rules of narrarium-server (see `githubFetch`). Off
   * by default: a server that predates them, which the engine's client refuses before it sends anything (`feature_unavailable`).
   */
  githubConflicts = false;
  /** What the server finds when it compares its copy with GitHub's: the files that both changed. A resolution empties it. */
  conflicts: GithubConflict[] = [];
  /** Which side's state, log and plan a resolution keeps when both changed them (`autopilotFiles` of the list). */
  autopilotFiles: GithubConflictChoice | undefined;
  /** Commits of the server that GitHub does not have, and the other way round. */
  ahead = 4;
  behind = 2;
  /** The book is not on GitHub (`409 no_remote`); the two histories have nothing in common (`409 unrelated_histories`); GitHub holds a name no copy can hold (`422 invalid_github_path`, the sentence). */
  noRemote = false;
  unrelatedHistories = false;
  invalidGithubPath: string | null = null;
  /** The server cannot run git against GitHub (`502 git_failed`, what git said). */
  gitFailure: string | null = null;
  /** The server is about to restart (`503 maintenance`, for a resolution). */
  maintenance = false;
  /** The book is not published (`publishEvery: off`): a resolution pushes nothing. A push that fails (`pushError`) leaves the resolution on the server. */
  publishOff = false;
  pushError: string | null = null;
  /** The server cannot be reached: every request of the conflicts fails as a request that did not get there. */
  offline = false;
  /** What the server remembers of how the last sync went (`lastSync` of the book's summary). */
  lastSync: ServerBookSync | null = null;
  /** A refusal that a request answers instead of serving it, by the name of the client's method (`listGithubConflicts`, `resolveGithubConflicts`). */
  readonly refusals: Record<string, { status: number; code: string; message: string; details?: Record<string, unknown> } | undefined> = {};
  /** What the server adds to, or changes in, the answer of a resolution that works (a test says what the server leaves aside, for instance). */
  resolutionPatch: Partial<ResolveGithubConflictsResponse> | undefined;
  /** Every list the server gave, by the page that was asked for, and every resolution it received, in order. */
  readonly listed: Array<{ offset: number; limit: number }> = [];
  readonly resolutions: ResolveGithubConflictsRequest[] = [];
  /** Where the conflicts are while the server runs the book with the engine's own session (see `engine`): the typed error the run stops on. */
  private lastListed: string | undefined;
  private generation = 1;
  /**
   * The server runs the book with the engine's own session, as the real one does: `startAutopilot`, `autopilot` and `pauseAutopilot` go to it, and, while the server has
   * conflicts with GitHub, a step stops on the typed error the real server's hook throws (`github_conflict`, with how many files), which the engine classifies.
   */
  engine = false;
  private engineSession: AutopilotSession | null = null;

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

  /** The server's own `GET /info`, with or without the quick controls, with the frozen chapters, «Retry later», the conflicts with GitHub and the MCP features when it has them. */
  info(): ServerInfo {
    const info = this.controls ? SERVER_INFO : OLD_SERVER_INFO;
    const extra = [...(this.frozen ? [SERVER_FEATURE_AUTOPILOT_FROZEN] : []), ...(this.retry ? [SERVER_FEATURE_AUTOPILOT_RETRY] : []), ...(this.githubConflicts ? [SERVER_FEATURE_GITHUB_CONFLICTS] : []), ...(this.mcp ? [SERVER_FEATURE_MCP] : []), ...(this.mcpOAuth ? [SERVER_FEATURE_MCP_OAUTH] : [])];
    if (!extra.length) return info;
    return { ...info, ...(this.frozen ? { serverVersion: "0.1.9" } : {}), ...(this.retry ? { serverVersion: "0.1.10" } : {}), features: [...(info.features ?? []), ...extra] };
  }

  /**
   * What the engine's client does before it sends `longRetry` (in the options route, `configure` or `start`) to a server that does not announce
   * «Retry later»: it refuses, and nothing is sent.
   */
  private requireRetryFor(options: unknown): void {
    if (!options || typeof options !== "object" || (options as { longRetry?: unknown }).longRetry === undefined || this.retry) return;
    throw new ServerRequestError(`This personal server does not have "Retry later" (it does not announce the feature autopilot-retry): update the server, or leave longRetry out.`, 501, "feature_unavailable");
  }

  /** «Retry later» from a request: a policy is kept, `null` turns it off, and a run that waits for it then stops with the failure, as the engine does. */
  private takeLongRetry(options: unknown): void {
    const value = options && typeof options === "object" ? (options as { longRetry?: AutopilotLongRetry | null }).longRetry : undefined;
    if (value === undefined) return;
    this.longRetry = value;
    if (value === null && this.running && this.waiting?.longTerm) this.stop("error", "\"Retry later\" was turned off while the step waited to be tried again: openai m: HTTP 503 — overloaded");
  }

  /** The engine's session over the book the server holds, as the real server answers the routes of the frozen chapters and, with `engine`, the run of the autopilot. */
  private session(bookId: string): AutopilotSession {
    this.engineSession ??= new AutopilotSession({
      bookId,
      store: this.store,
      ai: this.ai ?? createFakeAutopilotAi(),
      host: "server",
      hostLabel: "Home server",
      // The real server's hook: before every step it brings in what the author changed on GitHub, and stops on a conflict that git cannot settle.
      hooks: { beforeStep: async () => this.assertNoGithubConflicts() },
      retryDelayMs: 0,
    });
    return this.engineSession;
  }

  /** The snapshot of the engine's own session (`engine`), and a wait until its run is over. */
  engineSnapshot(bookId = "book-1"): Promise<AutopilotSnapshot> {
    return this.session(bookId).snapshot();
  }
  engineIdle(bookId = "book-1"): Promise<void> {
    return this.session(bookId).waitForIdle();
  }

  /** The model of the engine's own session (`engine`): the fake of the engine's tests unless a test gives another. */
  ai: AiPort | undefined;

  /** The typed error of the real server's step: `github_conflict`, with how many files, that the engine classifies as a conflict. */
  private assertNoGithubConflicts(): void {
    if (!this.engine || !this.githubConflicts || this.conflicts.length === 0) return;
    const total = this.conflicts.length;
    throw Object.assign(new Error(`The book changed on GitHub in a way that conflicts with the server's work (${total} ${total === 1 ? "file" : "files"}). Resolve it in the app (Where it runs, or the error panel), then resume.`), { code: GITHUB_CONFLICT_CODE, total });
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

  /** GitHub moves again: the conflicts are the same files, but they are not the same versions any more, so a list made before is not the list now. */
  moveGithub(): void {
    this.generation += 1;
  }

  /** What these conflicts are, file by file and version by version: it changes when GitHub moves, and when the conflicts do. */
  fingerprint(): string {
    const text = `${this.generation}|${JSON.stringify(this.sortedConflicts())}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
    return `fp-${hash.toString(16)}`;
  }

  /** The conflicts in the order of their paths, as the real server lists them. */
  private sortedConflicts(): GithubConflict[] {
    return [...this.conflicts].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  /** One page of the list, and the whole picture, as `GET …/github-conflicts` answers. */
  listing(offset: number, limit: number): GithubConflictsResponse {
    const all = this.sortedConflicts();
    return {
      conflicts: all.slice(offset, offset + limit),
      total: all.length,
      offset,
      limit,
      ahead: this.ahead,
      behind: this.behind,
      branch: "main",
      head: "1111111111111111111111111111111111111111",
      githubHead: `${String(this.generation).padStart(2, "0")}22222222222222222222222222222222222222`.slice(0, 40),
      fingerprint: this.fingerprint(),
      ...(this.autopilotFiles ? { autopilotFiles: this.autopilotFiles } : {}),
    };
  }

  /**
   * The resolution, with the rules of narrarium-server: what is refused is refused before anything is written (in the order the server checks), a file without a choice
   * when there is no default is `choice_missing`, a list that is not the one the author chose from is `conflicts_changed`, and what works makes one merge commit that empties
   * the conflicts, and says how the book was published.
   */
  private resolution(request: ResolveGithubConflictsRequest): { status: number; body: unknown } {
    const refuse = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => ({ status, body: { code, message, ...details } });
    if (this.maintenance) return refuse(503, "maintenance", "The server is about to restart for an update: try again in a minute.");
    if (this.noRemote) return refuse(409, "no_remote", "This book is not on GitHub: it has no conflicts with GitHub to resolve.");
    if (this.running) return refuse(409, "busy", "Pause the autopilot before resolving the conflicts with GitHub.");
    if (this.gitFailure) return refuse(502, "git_failed", this.gitFailure);
    if (this.unrelatedHistories) return refuse(409, "unrelated_histories", "The book on GitHub and the server's copy have no history in common: they cannot be merged. Register the book again from GitHub.");
    if (this.invalidGithubPath) return refuse(422, "invalid_github_path", this.invalidGithubPath);
    const all = this.sortedConflicts();
    if (all.length === 0) return refuse(409, "not_conflicted", "There is nothing to resolve: the book does not conflict with GitHub.");
    const fingerprint = request.fingerprint ?? this.lastListed;
    if (fingerprint === undefined || fingerprint !== this.fingerprint()) {
      return refuse(409, "conflicts_changed", "The conflicts with GitHub changed since they were listed (GitHub moved again): nothing was written. Choose again from the list.", { ...this.listing(0, GITHUB_CONFLICTS_PAGE_LIMIT) });
    }
    const choices = request.choices ?? {};
    const resolvable = all.filter((conflict) => conflict.resolvable);
    const missing = resolvable.filter((conflict) => !Object.prototype.hasOwnProperty.call(choices, conflict.path) && !request.default).map((conflict) => conflict.path);
    if (missing.length) {
      return refuse(400, "choice_missing", `Choose the version to keep of ${missing.length} ${missing.length === 1 ? "file" : "files"} (the server's or GitHub's), or give a default for the files you do not name: nothing was written.`, { paths: missing.slice(0, 100), missing: missing.length });
    }
    const asked = new Set(resolvable.map((conflict) => conflict.path));
    const decided = resolvable.map((conflict) => ({ path: conflict.path, choice: (Object.prototype.hasOwnProperty.call(choices, conflict.path) ? choices[conflict.path] : request.default) as GithubConflictChoice }));
    const ignored = Object.keys(choices).filter((path) => !asked.has(path)).sort();
    const unresolvable = all.filter((conflict) => !conflict.resolvable).map((conflict) => conflict.path);
    const pushed = !this.publishOff && !this.pushError;
    const response: ResolveGithubConflictsResponse = {
      head: "3333333333333333333333333333333333333333",
      pushed,
      ...(!this.publishOff && this.pushError ? { pushError: this.pushError } : {}),
      resolved: decided.slice(0, 100),
      ignored: ignored.slice(0, 100),
      unresolvable: unresolvable.slice(0, 100),
      counts: { total: all.length, server: decided.filter((entry) => entry.choice === "server").length, github: decided.filter((entry) => entry.choice === "github").length, ignored: ignored.length, unresolvable: unresolvable.length },
      ...(this.autopilotFiles ? { autopilotFiles: this.autopilotFiles } : {}),
      ...this.resolutionPatch,
    };
    this.resolutions.push(request);
    this.conflicts = [];
    this.lastListed = undefined;
    this.lastSync = { at: "2026-11-21T10:05:00.000Z", ok: pushed || this.publishOff, message: pushed ? "The conflicts with GitHub were resolved and pushed." : "The conflicts with GitHub were resolved on the server.", head: response.head };
    return { status: 200, body: response };
  }

  /** The engine's own client, with the fetch that answers as the server does: a new one for every connection, as the app makes one for every call to `verifiedServer`. */
  githubClient(): NarrariumServerClient {
    return new NarrariumServerClient({ baseUrl: "http://127.0.0.1:24242", token: "nrs_token", fetch: this.githubFetch });
  }

  /** What the engine's client sends to the server: the info (which says whether the server has the conflicts with GitHub) and the two routes, answered by the rules above. */
  private readonly githubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError("Failed to fetch");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const refuse = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => answer(status, { code, message, ...details });
    if (method === "GET" && url.pathname === "/api/v1/info") {
      this.calls.push("info");
      return answer(200, this.info());
    }
    const route = /^\/api\/v1\/books\/([^/]+)\/github-conflicts(\/resolve)?$/.exec(url.pathname);
    if (!route || (route[2] ? method !== "POST" : method !== "GET")) return refuse(404, "not_found", "Unknown endpoint.");
    const name = route[2] ? "resolveGithubConflicts" : "listGithubConflicts";
    this.calls.push(name);
    await this.gates[name];
    const refusal = this.refusals[name];
    if (refusal) return answer(refusal.status, { code: refusal.code, message: refusal.message, ...refusal.details });
    if (this.bookMissing) return refuse(404, "book_not_found", "This book is not on the server.");
    if (!this.githubConflicts) return refuse(404, "not_found", "Unknown endpoint.");
    if (route[2]) {
      const outcome = this.resolution(JSON.parse(String(init?.body ?? "{}")) as ResolveGithubConflictsRequest);
      return answer(outcome.status, outcome.body);
    }
    if (this.noRemote) return refuse(409, "no_remote", "This book is not on GitHub: it has no conflicts with GitHub to resolve.");
    if (this.gitFailure) return refuse(502, "git_failed", this.gitFailure);
    const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : GITHUB_CONFLICTS_PAGE_LIMIT;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) return refuse(400, "invalid_request", "offset must be a whole number from 0 and limit one from 1 to 500.");
    this.listed.push({ offset, limit });
    this.lastListed = this.fingerprint();
    return answer(200, this.listing(offset, limit));
  };

  summary(bookId: string): ServerBookSummary {
    return { bookId, title: "The Glass Harbor", storage: { kind: "local" }, hasGithubToken: this.hasGithubToken, ready: true, revision: "r1", autopilot: null, running: this.engine ? this.session(bookId).running : this.running, lastSync: this.lastSync };
  }

  /** The run ends, as the server's engine ends it: the stored state says how, and nothing waits any more. */
  stop(status: AutopilotStatus = "paused", message: string | null = null): void {
    this.running = false;
    this.pausePending = null;
    this.limits = null;
    this.waiting = null;
    this.endedAs = status;
    this.endMessage = message;
  }

  state(): AutopilotState {
    const state = createAutopilotState(new Date("2026-11-21T10:00:00.000Z"));
    return { ...state, status: this.running ? "running" : this.endedAs, message: this.running ? null : this.endMessage, ...(this.longRetry ? { options: { ...state.options, longRetry: this.longRetry } } : {}) };
  }

  snapshot(bookId: string): AutopilotSnapshot {
    const state = this.state();
    const limits = this.running && this.limits ? { ...this.limits, stepsDone: 0, chaptersDone: 0 } : null;
    const summary = summarizeAutopilotState(state, { pausePending: this.running ? this.pausePending : null, limits, defaultPublish: "step" });
    const retry = this.running && this.waiting ? { retry: this.waiting } : {};
    return { bookId, state, summary: { ...summary, ...retry }, activities: [], live: null, running: this.running, host: this.running ? "server" : null };
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
        return server.engine ? server.session(bookId).snapshot() : server.snapshot(bookId);
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
      async startAutopilot(bookId: string, options: { limits?: { steps?: number; chapters?: number }; options?: unknown }) {
        server.requireRetryFor(options?.options);
        await server.serve("startAutopilot");
        server.started.push(options);
        server.takeLongRetry(options?.options);
        if (server.engine) {
          const session = server.session(bookId);
          await session.start(options);
          return session.snapshot();
        }
        server.running = true;
        server.pausePending = null;
        server.limits = options?.limits ?? null;
        server.onStart?.(options);
        return server.snapshot(bookId);
      },
      async pauseAutopilot(bookId: string, mode: PauseAutopilotMode) {
        await server.serve("pauseAutopilot");
        server.paused.push(mode);
        if (server.engine) {
          const session = server.session(bookId);
          if (mode === "cancel") session.cancelPause();
          else session.pause(mode);
          return session.snapshot();
        }
        if (server.running) {
          // A server that predates the quick controls takes every mode but `now` for `after-step`, and `cancel` too.
          const effective = server.controls || mode === "now" ? mode : "after-step";
          if (effective === "cancel") server.pausePending = null;
          else if (effective === "after-step" || effective === "after-chapter") server.pausePending = server.pausePending === "after-step" ? "after-step" : effective;
          // A pause after the step ends a wait at once, as the engine does: there is no step in progress to finish.
          if (server.waiting && (effective === "now" || effective === "after-step")) server.stop("paused");
        }
        server.onPause?.(mode);
        return server.snapshot(bookId);
      },
      async configureAutopilot(bookId: string, options: { options?: unknown } | undefined) {
        server.requireRetryFor(options?.options);
        await server.serve("configureAutopilot");
        server.configured.push(options);
        server.takeLongRetry(options?.options);
        return server.snapshot(bookId);
      },
      async updateAutopilotOptions(bookId: string, options: AutopilotLiveOptions) {
        server.requireRetryFor(options);
        await server.serve("updateAutopilotOptions");
        server.optionsUpdated.push(options);
        server.takeLongRetry(options);
        return server.snapshot(bookId);
      },
      async updateOptions(bookId: string, options: AutopilotLiveOptions) {
        return fake.updateAutopilotOptions(bookId, options);
      },
      async retryNow(bookId: string) {
        await server.serve("retryNow");
        if (!server.retry) throw new ServerRequestError("Unknown endpoint.", 404, "not_found");
        const skipped = server.running && server.waiting !== null;
        server.waiting = null;
        // The snapshot after it, with whether the run was waiting: `RetryNowResponse`.
        return { ...server.snapshot(bookId), skipped };
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
      // The two routes go through the engine's own client over a fake fetch: the feature check, the query and the details of a refusal are the real ones.
      async listGithubConflicts(bookId: string, page: { offset?: number; limit?: number } = {}) {
        return server.githubClient().listGithubConflicts(bookId, page);
      },
      async resolveGithubConflicts(bookId: string, request: ResolveGithubConflictsRequest) {
        return server.githubClient().resolveGithubConflicts(bookId, request);
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
