import type { AiRuntimeConfig } from "../ai/config.js";
import { BookConflictError, type BookCommitResult, type BookFileChange, type BookFileContent, type BookFileEntry, type BookStore } from "../book/store.js";
import type { FrozenChapterResult, FrozenStatus } from "../autopilot/frozen.js";
import type { AiCallField, AiCallTask, AiCallTaskHeader, AiCallTaskPage } from "../autopilot/calls/types.js";
import type { AutopilotSnapshot, FrozenAction, FrozenChangeKind, InterventionInput, QuestionAnswer, StartOptions } from "../autopilot/types.js";
import { linkedSignal } from "../util/abort.js";
import {
  ServerSentEventParser,
  bookRoute,
  normalizeServerUrl,
  randomNonce,
  serverCompatibility,
  serverHasCalls,
  serverHasOutlineBrief,
  serverSupportsAutopilotAutoResume,
  serverSupportsAutopilotRetry,
  serverSupportsGithubConflicts,
  serverSupportsOutlineApply,
  verifyServerIdentity,
  type AskDirectorRequest,
  type AskDirectorResponse,
  type KeepCallTaskRequest,
  type ErrorResponse,
  type EventsResponse,
  type FreezeChapterRequest,
  type GithubConflictsResponse,
  type ResolveFrozenChangeRequest,
  type ReviseChaptersRequest,
  type RevisionCampaignResponse,
  type PairingRequest,
  type PairingResult,
  type PauseAutopilotMode,
  type ReadFilesResponse,
  type RegisterBookRequest,
  type ResolveGithubConflictsRequest,
  type ResolveGithubConflictsResponse,
  type RetryNowResponse,
  type ServerAiStatus,
  type ServerBookSummary,
  type ServerCallText,
  type ServerCompatibility,
  type ServerDeleteCallsResponse,
  type ServerIdentityCheck,
  type ServerInfo,
  type ServerManifest,
  type ServerSession,
  type ServerStreamMessage,
  type ServerUpdateAccepted,
  type ServerUpdateInfo,
  type ServerUpdateRequest,
  type UpdateAutopilotOptionsRequest,
  type UpdateAutopilotRuleRequest,
  type ServerMcpClient,
  type ServerMcpStatus,
  type UpdateMcpRequest,
} from "./protocol.js";

export class ServerRequestError extends Error {
  /**
   * What the server's answer said besides its `code` and its `message`: the files without a choice of a `choice_missing`, the conflicts as they are now
   * of a `conflicts_changed`, and so on. Empty when it said nothing else, and for a failure that is not an answer of the server.
   */
  readonly details: Record<string, unknown>;

  constructor(message: string, readonly status: number, readonly code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ServerRequestError";
    this.details = details;
  }
}

export interface NarrariumServerClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Per-request timeout (default 60 s; streams are not limited). */
  timeoutMs?: number;
}

/** Typed client of the personal server API, shared by the web app and the CLI. */
export class NarrariumServerClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: NarrariumServerClientOptions) {
    this.baseUrl = normalizeServerUrl(options.baseUrl);
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private async request<T>(method: string, path: string, body?: unknown, options: { auth?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const timer = linkedSignal(options.signal, options.timeoutMs ?? this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(options.auth === false ? {} : { authorization: `Bearer ${this.token}` }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: timer.signal,
          cache: "no-store",
          credentials: "omit",
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new ServerRequestError(timer.timedOut() ? "The personal server did not answer in time." : `The personal server is not reachable at ${this.baseUrl}.`, 0, "unreachable");
      }
      const text = await response.text();
      let payload: unknown = undefined;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new ServerRequestError(`Unexpected reply from the personal server (HTTP ${response.status}).`, response.status, "invalid_reply");
        }
      }
      if (!response.ok) {
        const error = (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}) as Partial<ErrorResponse> & Record<string, unknown>;
        const { code: _code, message: _message, ...details } = error;
        throw new ServerRequestError(error.message || `The personal server answered HTTP ${response.status}.`, response.status, error.code || "http_error", details);
      }
      return payload as T;
    } finally {
      timer.dispose();
    }
  }

  info(nonce?: string): Promise<ServerInfo> {
    return this.request("GET", `/api/v1/info${nonce ? `?nonce=${encodeURIComponent(nonce)}` : ""}`, undefined, { auth: false, timeoutMs: 10_000 });
  }

  /** Ask the server to sign a fresh nonce and check it (see `verifyServerIdentity`). */
  async verifiedInfo(): Promise<{ info: ServerInfo; identity: ServerIdentityCheck }> {
    const nonce = randomNonce();
    const info = await this.info(nonce);
    return { info, identity: await verifyServerIdentity(info, nonce) };
  }

  session(): Promise<ServerSession> {
    return this.request("GET", "/api/v1/session", undefined, { timeoutMs: 10_000 });
  }

  /** Revoke this client's own token: the device is disconnected from the server. */
  forgetSession(): Promise<{ revoked: boolean }> {
    return this.request("DELETE", "/api/v1/session", undefined, { timeoutMs: 10_000 });
  }

  /**
   * Sign out: revoke the token this client holds, and no other (`DELETE /api/v1/session`, with a token of any permission). A
   * token that is already revoked or unknown is already signed out: it answers `{ revoked: false }` instead of an error. A server
   * that cannot be reached is an error, because the token may still be valid there.
   */
  async signOut(): Promise<{ revoked: boolean }> {
    try {
      return await this.forgetSession();
    } catch (error) {
      if (error instanceof ServerRequestError && error.status === 401) return { revoked: false };
      throw error;
    }
  }

  /** First pairing step: send the code shown in the server's admin panel. `verification` (four digits the owner sees next to the request) is absent from older servers. */
  requestPairing(request: PairingRequest): Promise<{ id: string; verification?: string }> {
    return this.request("POST", "/api/v1/pairings", request, { auth: false, timeoutMs: 15_000 });
  }

  /** Poll a pairing until the owner approves it in the admin panel; the token is delivered once. */
  pairingResult(id: string, nonce: string): Promise<PairingResult> {
    return this.request("POST", `/api/v1/pairings/${encodeURIComponent(id)}/result`, { nonce }, { auth: false, timeoutMs: 15_000 });
  }

  updates(): Promise<ServerUpdateInfo> {
    return this.request("GET", "/api/v1/updates", undefined, { timeoutMs: 30_000 });
  }

  requestUpdate(version: string, installedVersion: string): Promise<ServerUpdateAccepted> {
    return this.request("POST", "/api/v1/updates", { version, installedVersion, confirmed: true } satisfies ServerUpdateRequest, { timeoutMs: 60_000 });
  }

  aiStatus(): Promise<ServerAiStatus> {
    return this.request("GET", "/api/v1/ai");
  }

  putAiConfig(config: AiRuntimeConfig): Promise<ServerAiStatus> {
    return this.request("PUT", "/api/v1/ai", { config });
  }

  async listBooks(): Promise<ServerBookSummary[]> {
    return (await this.request<{ books: ServerBookSummary[] }>("GET", "/api/v1/books")).books;
  }

  registerBook(bookId: string, input: RegisterBookRequest): Promise<ServerBookSummary> {
    return this.request("PUT", bookRoute(bookId), input, { timeoutMs: 300_000 });
  }

  removeBook(bookId: string): Promise<{ removed: boolean }> {
    return this.request("DELETE", bookRoute(bookId));
  }

  manifest(bookId: string): Promise<ServerManifest> {
    return this.request("GET", bookRoute(bookId, "/manifest"));
  }

  async readFiles(bookId: string, paths: string[]): Promise<BookFileContent[]> {
    return (await this.request<ReadFilesResponse>("POST", bookRoute(bookId, "/files/read"), { paths })).files;
  }

  commitFiles(bookId: string, changes: BookFileChange[], message: string): Promise<{ revision: string }> {
    return this.request("POST", bookRoute(bookId, "/files/commit"), { changes, message }, { timeoutMs: 120_000 });
  }

  syncGitHub(bookId: string): Promise<ServerBookSummary> {
    return this.request("POST", bookRoute(bookId, "/sync"), {}, { timeoutMs: 300_000 });
  }

  autopilot(bookId: string): Promise<AutopilotSnapshot> {
    return this.request("GET", bookRoute(bookId, "/autopilot"));
  }

  /**
   * Starting and configuring the autopilot need a server that takes the length of the book from its Scaletta (`SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF`):
   * an older one would plan the default number of chapters and write them, ignoring the outline. The client asks the server's features and refuses
   * before anything is sent: a `ServerRequestError` with status 501 and code `feature_unavailable`, which says to update the server.
   */
  private async assertOutlineBriefSupported(info: ServerInfo): Promise<void> {
    if (!serverHasOutlineBrief(info)) {
      throw new ServerRequestError(`This personal server is too old to take the length of the book from its synopsis (it does not announce the feature autopilot-outline-brief): it would plan the default number of chapters and ignore the synopsis. Update the server, then start the autopilot again.`, 501, "feature_unavailable");
    }
  }

  /**
   * The settings that only a newer server knows go only to a server that announces them: `options.longRetry` («Retry later») to one that announces
   * `SERVER_FEATURE_AUTOPILOT_RETRY`, `options.resumeAfterRestart` («Resume after a restart») to one that announces `SERVER_FEATURE_AUTOPILOT_AUTO_RESUME`.
   * An older one refuses them in the options route, and drops them from `configure` and `start` without a word. With such a setting in a request
   * (`null` and `false` included) the client asks the server's features first, and refuses for a server without it before anything is sent: a
   * `ServerRequestError` with status 501 and code `feature_unavailable`. A request without them asks nothing more.
   */
  private async assertOptionsSupported(options: unknown, known?: ServerInfo): Promise<void> {
    if (!options || typeof options !== "object") return;
    const { longRetry, resumeAfterRestart } = options as { longRetry?: unknown; resumeAfterRestart?: unknown };
    if (longRetry === undefined && resumeAfterRestart === undefined) return;
    const info = known ?? await this.info();
    if (longRetry !== undefined && !serverSupportsAutopilotRetry(info)) {
      throw new ServerRequestError(`This personal server does not have "Retry later" (it does not announce the feature autopilot-retry): update the server, or leave longRetry out.`, 501, "feature_unavailable");
    }
    if (resumeAfterRestart !== undefined && !serverSupportsAutopilotAutoResume(info)) {
      throw new ServerRequestError(`This personal server does not resume the autopilot by itself after a restart (it does not announce the feature autopilot-auto-resume): update the server, or leave resumeAfterRestart out.`, 501, "feature_unavailable");
    }
  }

  /**
   * Start or resume the autopilot: `POST …/autopilot/start`. `limits` (`{ steps?, chapters? }`: pause after that many steps or chapters
   * of this run) need a server that announces `SERVER_FEATURE_AUTOPILOT_CONTROLS`: an older one ignores them and runs on. `options.longRetry`
   * needs `SERVER_FEATURE_AUTOPILOT_RETRY` and `options.resumeAfterRestart` `SERVER_FEATURE_AUTOPILOT_AUTO_RESUME` (see `assertOptionsSupported`).
   */
  async startAutopilot(bookId: string, options: StartOptions & { force?: boolean } = {}): Promise<AutopilotSnapshot> {
    const info = await this.info();
    await this.assertOutlineBriefSupported(info);
    await this.assertOptionsSupported(options?.options, info);
    return this.request("POST", bookRoute(bookId, "/autopilot/start"), options, { timeoutMs: 300_000 });
  }

  /**
   * Pause the autopilot (`now`, `after-step`, `after-chapter`), or take back a pause that waits (`cancel`): `POST …/autopilot/pause`.
   * `after-chapter` and `cancel` need a server that announces `SERVER_FEATURE_AUTOPILOT_CONTROLS`: an older one takes them for `after-step`.
   */
  pauseAutopilot(bookId: string, mode: PauseAutopilotMode): Promise<AutopilotSnapshot> {
    return this.request("POST", bookRoute(bookId, "/autopilot/pause"), { mode });
  }

  /**
   * Change where the book is published, whether the run pauses after every chapter, what to do with a change of a frozen chapter and «Retry
   * later», also while a run goes on: `PUT …/autopilot/options` (a server that announces `SERVER_FEATURE_AUTOPILOT_CONTROLS`; `longRetry` one
   * that announces `SERVER_FEATURE_AUTOPILOT_RETRY`, `resumeAfterRestart` one that announces `SERVER_FEATURE_AUTOPILOT_AUTO_RESUME`, see
   * `assertOptionsSupported`). `publishEvery: null` takes the choice back, `longRetry: null`
   * turns it off. Answers the snapshot, like `configureAutopilot`.
   */
  async updateAutopilotOptions(bookId: string, input: UpdateAutopilotOptionsRequest): Promise<AutopilotSnapshot> {
    await this.assertOptionsSupported(input);
    return this.request("PUT", bookRoute(bookId, "/autopilot/options"), input);
  }

  /**
   * «Retry now»: end the wait before the next attempt of a failed step (a quick retry, or a cycle of «Retry later»), so that the attempt starts at
   * once: `POST …/autopilot/retry-now`, with no body (a server that announces `SERVER_FEATURE_AUTOPILOT_RETRY`; an older one answers 404). Answers
   * the snapshot with `skipped`: `false` when the run was not waiting, and nothing happened.
   */
  retryNow(bookId: string): Promise<RetryNowResponse> {
    return this.request("POST", bookRoute(bookId, "/autopilot/retry-now"));
  }

  /** The server announced `SERVER_FEATURE_GITHUB_CONFLICTS`: asked once, and again until it says yes (a server that is updated meanwhile is found). */
  private githubConflictsSupported = false;

  /** The routes of the conflicts with GitHub go only to a server that announces them: an older one is refused here, before anything is sent. */
  private async assertGithubConflicts(): Promise<void> {
    if (this.githubConflictsSupported) return;
    if (!serverSupportsGithubConflicts(await this.info())) {
      throw new ServerRequestError("This personal server cannot resolve the conflicts with GitHub (it does not announce the feature github-conflicts): update the server.", 501, "feature_unavailable");
    }
    this.githubConflictsSupported = true;
  }

  /**
   * The files of a GitHub book that changed both on the server and on GitHub since they parted, a page at a time: `GET …/github-conflicts?offset=&limit=`
   * (permission `read`; a server that announces `SERVER_FEATURE_GITHUB_CONFLICTS`, else `feature_unavailable` before anything is sent). The server
   * fetches GitHub first and compares without changing anything. `409 no_remote` for a book that is not on GitHub.
   */
  async listGithubConflicts(bookId: string, page: { offset?: number; limit?: number } = {}): Promise<GithubConflictsResponse> {
    await this.assertGithubConflicts();
    const query = new URLSearchParams();
    if (page.offset !== undefined) query.set("offset", String(page.offset));
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    const search = query.toString();
    return this.request("GET", bookRoute(bookId, `/github-conflicts${search ? `?${search}` : ""}`));
  }

  /**
   * Resolve them: `POST …/github-conflicts/resolve` with the version to keep of each file (permission `write`). The server merges GitHub into its work (one
   * merge commit) and pushes it. A refusal is a `ServerRequestError` whose `details` carry what the server said with it: `400 choice_missing` (`paths`,
   * `missing`), `409 conflicts_changed` (the conflicts as they are now, as `listGithubConflicts` gives them), `409 not_conflicted`, `409 no_remote`,
   * `409 busy` (a run is active), `422 invalid_github_path`, `503 maintenance`.
   */
  async resolveGithubConflicts(bookId: string, request: ResolveGithubConflictsRequest): Promise<ResolveGithubConflictsResponse> {
    await this.assertGithubConflicts();
    return this.request("POST", bookRoute(bookId, "/github-conflicts/resolve"), request, { timeoutMs: 300_000 });
  }

  /** The server announced `SERVER_FEATURE_AUTOPILOT_CALLS`: asked once, and again until it says yes (a server that is updated meanwhile is found). */
  private callsSupported = false;

  /** The routes of the AI call records go only to a server that announces them: an older one is refused here, before anything is sent. */
  private async assertCalls(): Promise<void> {
    if (this.callsSupported) return;
    if (!serverHasCalls(await this.info())) {
      throw new ServerRequestError("This personal server does not keep the records of the AI calls of the autopilot (it does not announce the feature autopilot-calls): update the server.", 501, "feature_unavailable");
    }
    this.callsSupported = true;
  }

  /**
   * The tasks of a book whose AI calls the server kept, newest first, a page at a time: `GET …/autopilot/calls?before=&limit=` (permission `read`; a server that announces
   * `SERVER_FEATURE_AUTOPILOT_CALLS`, else `feature_unavailable` before anything is sent). Each entry is the task's header (title, kind, chapter, status, times, how many calls, how many
   * bytes, pinned or not); `next` is the cursor to give as `before` for the following page, or `null` on the last one. `limit` is 1 to `SERVER_CALLS_MAX_PAGE_LIMIT` (default `SERVER_CALLS_PAGE_LIMIT`).
   */
  async listCalls(bookId: string, page: { before?: string; limit?: number } = {}): Promise<AiCallTaskPage> {
    await this.assertCalls();
    const query = new URLSearchParams();
    if (page.before !== undefined) query.set("before", page.before);
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    const search = query.toString();
    return this.request("GET", bookRoute(bookId, `/autopilot/calls${search ? `?${search}` : ""}`));
  }

  /**
   * One task with its calls in the order they were made, without their texts: `GET …/autopilot/calls/tasks/:activityId` (permission `read`). Each call says what it is, which model answered, how it
   * ended, how big its texts are and what each provider attempt did. `404 call_task_not_found` when the server holds no such task.
   */
  async readCallTask(bookId: string, activityId: string): Promise<AiCallTask> {
    await this.assertCalls();
    return this.request("GET", bookRoute(bookId, `/autopilot/calls/tasks/${encodeURIComponent(activityId)}`));
  }

  /**
   * The kept text of one call, a piece at a time: `GET …/autopilot/calls/:callId/text?field=&attempt=&from=&limit=` (permission `read`). `field` is `system`, `user` or `response`; `attempt` names the
   * response of a provider attempt (from 1; the last one that has text when it is left out); `from` is a byte offset (default 0) and `limit` at most `SERVER_CALL_TEXT_MAX_BYTES`. The answer says where it
   * starts, where the next piece does, how much is kept now and whether the call is over (`ServerCallText`): a view that follows a running call asks again from `next` once a second.
   * `404 call_not_found` when the server does not hold the call.
   */
  async readCallText(bookId: string, callId: string, options: { field: AiCallField; attempt?: number; from?: number; limit?: number }): Promise<ServerCallText> {
    await this.assertCalls();
    const query = new URLSearchParams({ field: options.field });
    if (options.attempt !== undefined) query.set("attempt", String(options.attempt));
    if (options.from !== undefined) query.set("from", String(options.from));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return this.request("GET", bookRoute(bookId, `/autopilot/calls/${encodeURIComponent(callId)}/text?${query.toString()}`));
  }

  /**
   * Keep a task (`pinned: true`: it is never dropped to make room, but it counts against the budget) or let it go: `PUT …/autopilot/calls/tasks/:activityId/keep` (permission `run`). Answers the task's header
   * as it is now. `404 call_task_not_found` when the server holds no such task.
   */
  async keepCallTask(bookId: string, activityId: string, pinned: boolean): Promise<AiCallTaskHeader> {
    await this.assertCalls();
    const body: KeepCallTaskRequest = { pinned };
    return this.request("PUT", bookRoute(bookId, `/autopilot/calls/tasks/${encodeURIComponent(activityId)}/keep`), body);
  }

  /**
   * Delete every AI call record of the book on the server, the pinned tasks too: `DELETE …/autopilot/calls` (permission `run`). Answers what it removed. What a browser or an account copied stays where
   * it was copied. Never touches the book itself.
   */
  async deleteCalls(bookId: string): Promise<ServerDeleteCallsResponse> {
    await this.assertCalls();
    return this.request("DELETE", bookRoute(bookId, "/autopilot/calls"));
  }

  /** The short name of `updateAutopilotOptions`. */
  updateOptions(bookId: string, input: UpdateAutopilotOptionsRequest): Promise<AutopilotSnapshot> {
    return this.updateAutopilotOptions(bookId, input);
  }

  /**
   * Replace the text of the permanent rule at `index`: `PUT …/autopilot/rules/:index` with `{ text, expectedText? }` (a server that announces
   * `SERVER_FEATURE_AUTOPILOT_RULES`; an older one answers 404). `expectedText` is the rule as the author saw it: when the rule is no longer
   * that, nothing is written and the server answers 409 `rule_changed`. Answers the snapshot, like `configureAutopilot`; a rule it refuses
   * is a `ServerRequestError` with the status and the code of the server (`rule_empty`, `rule_too_long`, `rule_duplicate`, `rule_not_found`).
   */
  updateRule(bookId: string, index: number, text: string, expectedText?: string): Promise<AutopilotSnapshot> {
    const body: UpdateAutopilotRuleRequest = { text, ...(expectedText === undefined ? {} : { expectedText }) };
    return this.request("PUT", bookRoute(bookId, `/autopilot/rules/${encodeURIComponent(String(index))}`), body);
  }

  /** Remove the permanent rule at `index`, with the same check of `expectedText` (in the query): `DELETE …/autopilot/rules/:index?expectedText=…`. Answers the snapshot. */
  removeRule(bookId: string, index: number, expectedText?: string): Promise<AutopilotSnapshot> {
    const query = expectedText === undefined ? "" : `?expectedText=${encodeURIComponent(expectedText)}`;
    return this.request("DELETE", bookRoute(bookId, `/autopilot/rules/${encodeURIComponent(String(index))}${query}`));
  }

  intervene(bookId: string, input: InterventionInput): Promise<AutopilotSnapshot> {
    return this.request("POST", bookRoute(bookId, "/autopilot/intervene"), input);
  }

  answer(bookId: string, input: QuestionAnswer): Promise<AutopilotSnapshot> {
    return this.request("POST", bookRoute(bookId, "/autopilot/answer"), input);
  }

  /**
   * The changes of frozen chapters (and of the outline of written ones) and what can be done with each: `GET …/autopilot/frozen` (a server
   * that announces `SERVER_FEATURE_AUTOPILOT_FROZEN`; an older one answers 404).
   */
  frozenStatus(bookId: string): Promise<FrozenStatus> {
    return this.request("GET", bookRoute(bookId, "/autopilot/frozen"));
  }

  /**
   * Decide about the change of a chapter: `POST …/autopilot/frozen/:number` with `{ action, kind?, note? }` (`ResolveFrozenChangeRequest`).
   * Answers the status after it. A refusal is a `ServerRequestError` with the code of the engine's `FrozenChapterError`
   * (`chapter_not_found`, `not_changed`, `invalid_action`).
   */
  resolveFrozenChange(bookId: string, number: number, action: FrozenAction, options: { kind?: FrozenChangeKind; note?: string } = {}): Promise<FrozenStatus> {
    const body: ResolveFrozenChangeRequest = { action, ...(options.kind ? { kind: options.kind } : {}), ...(options.note !== undefined ? { note: options.note } : {}) };
    return this.request("POST", bookRoute(bookId, `/autopilot/frozen/${encodeURIComponent(String(number))}`), body);
  }

  /**
   * Revise these chapters now, for this reason, in order, then go on with the plan: `POST …/autopilot/campaign` (`ReviseChaptersRequest`, the engine's
   * `AutopilotSession.reviseChapters`). The reason `outline-change` needs `SERVER_FEATURE_AUTOPILOT_OUTLINE_APPLY`, else `feature_unavailable` before anything is
   * sent. A refusal is a `ServerRequestError` with the code of the engine's `RevisionCampaignError` (`invalid_request`, `campaign_active`, `not_changed`, `stale`).
   */
  async reviseChapters(bookId: string, request: ReviseChaptersRequest): Promise<RevisionCampaignResponse> {
    await this.requireOutlineApply();
    return this.request("POST", bookRoute(bookId, "/autopilot/campaign"), request);
  }

  /** Cancel the chapters of the campaign that wait (the one being worked finishes): `DELETE …/autopilot/campaign`. The same feature as `reviseChapters`. */
  async cancelRevisionCampaign(bookId: string): Promise<RevisionCampaignResponse> {
    await this.requireOutlineApply();
    return this.request("DELETE", bookRoute(bookId, "/autopilot/campaign"));
  }

  private async requireOutlineApply(): Promise<void> {
    if (!serverSupportsOutlineApply(await this.info())) {
      throw new ServerRequestError("This personal server cannot apply the Synopsis to a book (it does not announce the feature autopilot-outline-apply): update the server.", 501, "feature_unavailable");
    }
  }

  /** Freeze a chapter by hand (`frozen: true`), or take its record away: `POST …/chapters/:slug/freeze` with `{ frozen }`. Answers the chapter's record now. */
  freezeChapter(bookId: string, slug: string, frozen = true): Promise<FrozenChapterResult> {
    const body: FreezeChapterRequest = { frozen };
    return this.request("POST", bookRoute(bookId, `/chapters/${encodeURIComponent(slug)}/freeze`), body);
  }

  /**
   * Change the brief or the options while the autopilot is not running: `POST …/autopilot/configure`. `options.longRetry` needs
   * `SERVER_FEATURE_AUTOPILOT_RETRY` and `options.resumeAfterRestart` `SERVER_FEATURE_AUTOPILOT_AUTO_RESUME` (see `assertOptionsSupported`).
   */
  async configureAutopilot(bookId: string, input: StartOptions): Promise<AutopilotSnapshot> {
    const info = await this.info();
    await this.assertOutlineBriefSupported(info);
    await this.assertOptionsSupported(input?.options, info);
    return this.request("POST", bookRoute(bookId, "/autopilot/configure"), input);
  }

  resetAutopilot(bookId: string): Promise<AutopilotSnapshot> {
    return this.request("POST", bookRoute(bookId, "/autopilot/reset"), {});
  }

  events(bookId: string, since = 0): Promise<EventsResponse> {
    return this.request("GET", bookRoute(bookId, `/autopilot/events?since=${since}`));
  }

  askDirector(bookId: string, input: AskDirectorRequest, signal?: AbortSignal): Promise<AskDirectorResponse> {
    return this.request("POST", bookRoute(bookId, "/director/ask"), input, { timeoutMs: 600_000, signal });
  }

  /**
   * The MCP endpoint of a book (a server that announces `SERVER_FEATURE_MCP`; an older one answers `404 not_found`): `GET …/mcp` needs `read` and answers whether it is
   * on, its slug and the address an assistant connects to. From a server that announces `SERVER_FEATURE_MCP_OAUTH` it also says how many apps are connected and where
   * the OAuth server is. The answer is passed on as the server gave it; `404 book_not_found` for a book that is not there.
   */
  mcpStatus(bookId: string): Promise<ServerMcpStatus> {
    return this.request("GET", bookRoute(bookId, "/mcp"));
  }

  /**
   * Switch a book's MCP on or off and/or give it another slug: `PUT …/mcp` with `{ enabled?, slug? }` (needs `write`). Only what is given is sent, and only those two
   * things; a `false` is a value. Answers the status after the change. Switching off, or a new slug, disconnects the apps of the book. The server refuses with
   * `400 invalid_slug`, `409 slug_taken` (another book has it), `400 invalid_request` (nothing to change), `404 book_not_found` and `503 maintenance`: each is a
   * `ServerRequestError` with the status and the code of the server.
   */
  updateMcp(bookId: string, input: UpdateMcpRequest): Promise<ServerMcpStatus> {
    const body: UpdateMcpRequest = { ...(input.enabled === undefined ? {} : { enabled: input.enabled }), ...(input.slug === undefined ? {} : { slug: input.slug }) };
    return this.request("PUT", bookRoute(bookId, "/mcp"), body);
  }

  /**
   * The apps connected to a book through OAuth (a server that announces `SERVER_FEATURE_MCP_OAUTH`; one that has only the endpoint answers `404 not_found`): `GET …/mcp/clients`
   * needs `write`, because it says who may change the book. Answers the list, which is empty when nothing is connected (and for an answer that has no list: a host never
   * has to guard for it). Each entry is as the server gave it, with what a newer server adds.
   */
  async listMcpClients(bookId: string): Promise<ServerMcpClient[]> {
    const answer = await this.request<{ clients?: unknown } | null | undefined>("GET", bookRoute(bookId, "/mcp/clients"));
    const clients = answer?.clients;
    return Array.isArray(clients) ? (clients as ServerMcpClient[]) : [];
  }

  /**
   * Disconnect an app: `DELETE …/mcp/clients/:id` (needs `write`), with the `id` of the entry that `listMcpClients` gave (the connection's, not the app's). Its next call is
   * refused and its tokens are useless; the app has to ask the owner again. Answers `{ revoked: true }`; `404 client_missing` when the book has no such connection (it was
   * revoked already, or belongs to another book), told apart from `404 book_not_found` by the code.
   */
  revokeMcpClient(bookId: string, id: string): Promise<{ revoked: boolean }> {
    return this.request("DELETE", bookRoute(bookId, `/mcp/clients/${encodeURIComponent(id)}`));
  }

  /**
   * Follow the live stream of every book until the signal aborts or the server closes it.
   * Uses `fetch` so the token travels in a header, never in the URL.
   */
  async stream(onMessage: (message: ServerStreamMessage) => void, signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/events`, {
      headers: { accept: "text/event-stream", authorization: `Bearer ${this.token}` },
      signal,
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok || !response.body) throw new ServerRequestError(`The live stream is not available (HTTP ${response.status}).`, response.status, "stream_unavailable");
    const parser = new ServerSentEventParser((event, data) => {
      try {
        onMessage({ event, data: JSON.parse(data) } as ServerStreamMessage);
      } catch {
        // Ignore malformed frames.
      }
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
  }
}

/** Paths asked of the server in one request: it answers up to 100 and 16 MiB. */
const READ_CHUNK_PATHS = 50;

/** The server refuses what it was asked to read in one request: too many bytes, or (older and newer servers differ) too many paths. */
function isTooMuchToRead(error: unknown): boolean {
  return error instanceof ServerRequestError && (error.status === 413 || error.code === "too_many_paths");
}

/** A `BookStore` backed by the files of a book hosted on the personal server. */
export function remoteBookStore(client: NarrariumServerClient, bookId: string): BookStore {
  /** One request for the paths; a refusal because it is too much splits it in halves, down to one path. */
  async function readChunk(paths: string[]): Promise<BookFileContent[]> {
    try {
      const rank = (file: BookFileContent) => paths.indexOf(file.path) + 1 || paths.length + 1;
      return (await client.readFiles(bookId, paths)).sort((left, right) => rank(left) - rank(right));
    } catch (error) {
      if (!isTooMuchToRead(error) || paths.length <= 1) throw error;
      const middle = Math.ceil(paths.length / 2);
      return [...await readChunk(paths.slice(0, middle)), ...await readChunk(paths.slice(middle))];
    }
  }

  return {
    async list(): Promise<BookFileEntry[]> {
      return (await client.manifest(bookId)).files;
    },
    async read(path: string): Promise<BookFileContent | null> {
      return (await client.readFiles(bookId, [path]))[0] ?? null;
    },
    async readMany(paths: string[]): Promise<BookFileContent[]> {
      const unique = [...new Set(paths)];
      const files: BookFileContent[] = [];
      for (let start = 0; start < unique.length; start += READ_CHUNK_PATHS) files.push(...await readChunk(unique.slice(start, start + READ_CHUNK_PATHS)));
      return files;
    },
    async commit(changes: BookFileChange[], message: string): Promise<BookCommitResult> {
      try {
        return await client.commitFiles(bookId, changes, message);
      } catch (error) {
        if (error instanceof ServerRequestError && error.status === 409) throw new BookConflictError(error.message);
        throw error;
      }
    },
  };
}

/** What is known while the owner is asked to approve a pairing. */
export interface PairingWaiting {
  /** The four digits the owner sees next to the request in the admin panel: show them, so that the owner can tell this device's request from another one. Absent from older servers. */
  verification?: string;
  /** Whether the server speaks an API this app supports; absent when the server did not answer `info`. */
  compatibility?: ServerCompatibility;
}

export interface PairWithServerOptions {
  baseUrl: string;
  /** Nine-digit code generated in the server's admin panel. */
  code: string;
  /** Name of this client as the owner will see it. */
  label: string;
  signal?: AbortSignal;
  /** Called once the code is accepted, while the owner has to approve the request. */
  onWaitingApproval?: (request: PairingWaiting) => void;
  /** Called with everything the pairing found out (the token, the verification digits, the compatibility) just before `pairWithServer` answers the token. */
  onPaired?: (pairing: ServerPairing) => void;
  pollMs?: number;
  fetch?: typeof fetch;
}

/** Everything a pairing found out, not only the token. */
export interface ServerPairing {
  token: string;
  /** The four digits the admin panel shows next to this client (derived from the token). Absent from older servers. */
  verification?: string;
  /** The four digits the owner saw next to the request while approving it. Absent from older servers. */
  requestVerification?: string;
  /** Whether the server speaks an API this app supports; absent when the server did not answer `info`. */
  compatibility?: ServerCompatibility;
}

/** Four digits as the server derives them, or `undefined` for anything else: a server that sends nothing, or something odd, is not an error. */
function verificationOf(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}$/.test(value) ? value : undefined;
}

/**
 * Pair this client with a server and return what the pairing found out: send the code, wait for the owner's approval, and
 * return the token with the verification digits and the server's compatibility. Nothing here throws for a server that is older
 * or newer than the app, or that sends no verification: the host decides how to say it.
 */
export async function pairWithServerDetailed(options: PairWithServerOptions): Promise<ServerPairing> {
  const client = new NarrariumServerClient({ baseUrl: options.baseUrl, token: "", fetch: options.fetch });
  options.signal?.throwIfAborted();
  const compatibility = await client.info().then((info) => serverCompatibility(info), () => undefined);
  const nonce = randomNonce();
  const requested = await client.requestPairing({ code: options.code.replace(/\D/g, ""), nonce, label: options.label.trim().slice(0, 80) || "Narrarium" });
  const requestVerification = verificationOf(requested.verification);
  options.onWaitingApproval?.({ ...(requestVerification ? { verification: requestVerification } : {}), ...(compatibility ? { compatibility } : {}) });
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const result = await client.pairingResult(requested.id, nonce);
    if ("token" in result) {
      const verification = verificationOf(result.verification);
      const pairing: ServerPairing = { token: result.token, ...(verification ? { verification } : {}), ...(requestVerification ? { requestVerification } : {}), ...(compatibility ? { compatibility } : {}) };
      options.onPaired?.(pairing);
      return pairing;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(options.signal?.reason);
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, options.pollMs ?? 2000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new ServerRequestError("The pairing expired before it was approved.", 408, "pairing_expired");
}

/** Pair this client with a server: send the code, wait for the owner's approval, return the token (`pairWithServerDetailed` returns more). */
export async function pairWithServer(options: PairWithServerOptions): Promise<string> {
  return (await pairWithServerDetailed(options)).token;
}
