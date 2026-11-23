import type { AiRuntimeConfig, RedactedAiIntegration, RedactedAiTaskRoute } from "../ai/config.js";
import type { EvaluationTarget } from "../book/paths.js";
import type { BookFileChange, BookFileContent, BookFileEntry } from "../book/store.js";
import type { DirectorOpinion } from "../director/opinion.js";
import type { FrozenChapterResult, FrozenStatus } from "../autopilot/frozen.js";
import type { AutopilotEvent, AutopilotLiveOptions, AutopilotPauseMode, AutopilotSnapshot, AutopilotStateSummary, FrozenAction, FrozenChangeKind, InterventionInput, QuestionAnswer, StartOptions } from "../autopilot/types.js";
import type { AiCallField } from "../autopilot/calls/types.js";

export const SERVER_API_VERSION = 1;
/** The oldest and the newest `ServerInfo.apiVersion` a server may speak for this engine to talk to it (see `serverCompatibility`). */
export const MIN_SUPPORTED_SERVER_API = 1;
export const MAX_SUPPORTED_SERVER_API = 1;
export const DEFAULT_SERVER_PORT = 24242;
/** Loopback port of the server's admin panel. */
export const DEFAULT_ADMIN_PORT = 24243;
export const SERVER_PACKAGE_NAME = "narrarium-server";

/** Permissions of a client token. `update` (replace the server version) is granted only explicitly by the owner. */
export const SERVER_SCOPES = ["read", "write", "run", "update"] as const;
export type ServerScope = (typeof SERVER_SCOPES)[number];

export interface ServerInfo {
  name: typeof SERVER_PACKAGE_NAME;
  apiVersion: number;
  serverVersion: string;
  engineVersion: string;
  serverId: string;
  label: string;
  /** Whether `git` is available for GitHub-backed books. */
  git: boolean;
  features: string[];
  /** Ed25519 public key of the server (SPKI DER, base64) and its SHA-256 fingerprint (hex). */
  publicKey?: string;
  fingerprint?: string;
  /** Echo of the request nonce and the Ed25519 signature of `nonce\nserverId\npublicKey` (base64). */
  nonce?: string;
  signature?: string;
  /** Started with `npx narrarium-server start`: the supervisor can install a new version on request. */
  supervised?: boolean;
}

/** Whether this engine and a server speak the same API: `server-older` (the server must be updated) or `server-newer` (this app must be). */
export type ServerCompatibilityStatus = "ok" | "server-older" | "server-newer";

export interface ServerCompatibility {
  status: ServerCompatibilityStatus;
  /** What to tell the author, in English: which version the server speaks, which this engine supports, and what to update. */
  message: string;
}

/**
 * Whether the server that answered `info` speaks an API this engine supports (`MIN_SUPPORTED_SERVER_API` to
 * `MAX_SUPPORTED_SERVER_API`). It never throws: a server that does not say which API it speaks (or says it oddly) is an older one,
 * and what to do about each answer is for the host to decide.
 */
export function serverCompatibility(info: Pick<ServerInfo, "apiVersion"> | null | undefined): ServerCompatibility {
  const version = info?.apiVersion;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { status: "server-older", message: "The personal server does not say which API version it speaks, so it is older than this app supports: update the server." };
  }
  const supported = MIN_SUPPORTED_SERVER_API === MAX_SUPPORTED_SERVER_API ? `${MIN_SUPPORTED_SERVER_API}` : `${MIN_SUPPORTED_SERVER_API} to ${MAX_SUPPORTED_SERVER_API}`;
  if (version < MIN_SUPPORTED_SERVER_API) return { status: "server-older", message: `The personal server speaks API version ${version}; this app supports ${supported}: update the server.` };
  if (version > MAX_SUPPORTED_SERVER_API) return { status: "server-newer", message: `The personal server speaks API version ${version}; this app supports ${supported}: update Narrarium.` };
  return { status: "ok", message: `The personal server speaks API version ${version}, which this app supports.` };
}

export interface ServerSession {
  serverId: string;
  label: string;
  clientLabel: string;
  clientId: string;
  scopes: ServerScope[];
}

export interface PairingRequest {
  /** Nine-digit code shown in the server's admin panel. */
  code: string;
  /** 64 hex characters chosen by the client; only its hash is kept by the server. */
  nonce: string;
  label: string;
}

/**
 * What polling a pairing answers: still waiting for the owner, or the token (delivered once), with the four digits the owner
 * sees next to the client in the admin panel when the server sends them (`verification`: older servers do not).
 */
export type PairingResult = { pending: true } | { token: string; verification?: string };

export type ServerUpdateReason = "not_published" | "no_trusted_release" | "unavailable" | "up_to_date" | "no_supervisor" | "missing_scope";

export interface ServerUpdateResult {
  requestId: string;
  state: "completed" | "failed";
  /** `completed`, or why the update did not happen. */
  outcome: "completed" | "failed" | "limited" | "stopping";
  version: string;
  fromVersion: string;
  at: string;
  message: string;
}

export interface ServerUpdateInfo {
  packageName: typeof SERVER_PACKAGE_NAME;
  installedVersion: string;
  latestVersion?: string;
  /** A newer release exists, signed by the npm registry and attested by the publishing workflow. */
  available: boolean;
  /** This client may ask for the update now. */
  canRequest: boolean;
  signed: boolean;
  supervised: boolean;
  hasUpdateScope: boolean;
  reason?: ServerUpdateReason;
  message: string;
  lastUpdate?: ServerUpdateResult;
  /** An update already requested and waiting for the supervisor. */
  pending?: { version: string; requestedAt: string };
}

export interface ServerUpdateRequest {
  version: string;
  installedVersion: string;
  confirmed: true;
}

export interface ServerUpdateAccepted {
  accepted: true;
  version: string;
  message: string;
}

export type ServerBookStorage =
  | { kind: "github"; owner: string; repo: string; branch: string }
  | { kind: "local" };

export interface RegisterBookRequest {
  title: string;
  storage: ServerBookStorage;
  /** GitHub token for this book, sent only with the author's consent. `null` removes it. */
  githubToken?: string | null;
}

export interface ServerBookSync {
  at: string;
  ok: boolean;
  message: string;
  head?: string;
  /** Set when the last sync failed because the book conflicts with GitHub: how many files the author has to decide about (`GET …/github-conflicts`). */
  conflicts?: number;
}

export interface ServerBookSummary {
  bookId: string;
  title: string;
  storage: ServerBookStorage;
  hasGithubToken: boolean;
  ready: boolean;
  /** Changes whenever a file of the book changes on the server. */
  revision: string;
  autopilot: AutopilotStateSummary | null;
  running: boolean;
  lastSync: ServerBookSync | null;
  error?: string;
}

export interface ServerManifest {
  revision: string;
  files: BookFileEntry[];
}

export interface CommitFilesRequest {
  changes: BookFileChange[];
  message: string;
}

export interface ReadFilesResponse {
  files: BookFileContent[];
}

export interface AskDirectorRequest {
  target: EvaluationTarget;
  question?: string;
  save?: boolean;
}

export interface AskDirectorResponse {
  opinion: DirectorOpinion;
  path: string;
  saved: boolean;
  /** Problems of `director.md`, when the server's engine reports them (older servers send none). */
  warnings?: string[];
}

export interface ServerAiStatus {
  configured: boolean;
  /** Every integration, without its key; an integration that sets a thinking level says it (`thinking`). */
  integrations: RedactedAiIntegration[];
  routedTasks: string[];
  updatedAt: string | null;
  /** AI endpoint origins the server owner still has to approve in the admin panel before they can be called. */
  pendingApproval?: string[];
  /** Whether "Tools only" is in force (`AiRuntimeConfig.toolsOnly`: true unless the configuration turned it off). Absent from a server that does not say. */
  toolsOnly?: boolean;
  /** The route of every routed task, with the thinking level of each target when it sets one (`redactAiRuntimeConfig(...).taskRouting`). Absent from a server that does not say. */
  taskRouting?: Record<string, RedactedAiTaskRoute>;
}

export interface PutAiConfigRequest {
  config: AiRuntimeConfig;
}

/**
 * The `ServerInfo.features` entry of a server that implements the quick controls of the autopilot: the pause modes `after-chapter` and
 * `cancel`, the `limits` of `start`, and `PUT /api/v1/books/:id/autopilot/options` (see `AutopilotLiveOptions`). A server without it
 * ignores `limits` (the run would not stop after the step or the chapter that was asked for) and takes every pause mode but `now` for
 * `after-step` (a `cancel` would pause): a client checks `serverSupportsAutopilotControls` before it sends them.
 */
export const SERVER_FEATURE_AUTOPILOT_CONTROLS = "autopilot-controls";

/** Whether the server announces that it implements the quick controls of the autopilot. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsAutopilotControls(info: { features?: unknown } | null | undefined): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_CONTROLS);
}

/**
 * The `ServerInfo.features` entry of a server that implements the routes that edit the permanent rules of the autopilot:
 * `PUT` and `DELETE /api/v1/books/:id/autopilot/rules/:index` (see `UpdateAutopilotRuleRequest`). A server without it answers 404 to them:
 * a client checks `serverSupportsAutopilotRules` before it offers to edit or remove a rule.
 */
export const SERVER_FEATURE_AUTOPILOT_RULES = "autopilot-rules";

/** Whether the server announces that it implements the routes that edit the permanent rules. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsAutopilotRules(info: { features?: unknown } | null | undefined): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_RULES);
}

/**
 * The `ServerInfo.features` entry of a server that implements the routes of the frozen chapters: `GET /api/v1/books/:id/autopilot/frozen`
 * (the changes and what can be done with them), `POST /api/v1/books/:id/autopilot/frozen/:number` (a decision about one, see
 * `ResolveFrozenChangeRequest`) and `POST /api/v1/books/:id/chapters/:slug/freeze` (`FreezeChapterRequest`). A server without it answers
 * 404 to them: a client checks `serverSupportsFrozenChapters` before it offers them. The answer to the question about a change needs no
 * new route: the `id` of a choice travels as the `answer` of `POST …/autopilot/answer`, as an older server forwards it.
 */
export const SERVER_FEATURE_AUTOPILOT_FROZEN = "autopilot-frozen";

/** Whether the server announces the routes of the frozen chapters. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsFrozenChapters(info: { features?: unknown } | null | undefined): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_FROZEN);
}

/**
 * The `ServerInfo.features` entry of a server that has «Retry later» and «Retry now»: it takes `options.longRetry` (`AutopilotLongRetry`, or `null`
 * to turn it off) in `PUT /api/v1/books/:id/autopilot/options`, `configure` and `start`, and answers `POST /api/v1/books/:id/autopilot/retry-now`.
 * A server without it refuses `longRetry` in the options route (400) and drops it from `configure` and `start` (its engine does not know it), and
 * answers 404 to `retry-now`: the engine's client never sends `longRetry` to such a server (it refuses with `feature_unavailable`).
 */
export const SERVER_FEATURE_AUTOPILOT_RETRY = "autopilot-retry";

/** Whether the server announces «Retry later» and «Retry now». Takes its info or the list of its features. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsAutopilotRetry(info: { features?: unknown } | readonly unknown[] | null | undefined): boolean {
  const features = Array.isArray(info) ? info : (info as { features?: unknown } | null | undefined)?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_RETRY);
}

/** The answer of `POST /api/v1/books/:id/autopilot/retry-now`: the snapshot after it, and whether the run was waiting (`skipped`: the wait was ended). */
export type RetryNowResponse = AutopilotSnapshot & { skipped: boolean };

/**
 * The `ServerInfo.features` entry of a server that resumes a run by itself when it starts again, for the books whose author turned «Resume after a
 * restart» on (`options.resumeAfterRestart`): a run that was going on when the server stopped (paused with `stoppedBy: "server-shutdown"`, or left
 * `running` by a process that ended), at most three times a day per book; a run the author paused never. It takes `resumeAfterRestart` (`true` or
 * `false`) in `PUT /api/v1/books/:id/autopilot/options`, `configure` and `start`. A server without it refuses the option in the options route (400)
 * and drops it from `configure` and `start` (its engine does not know it): the engine's client never sends it to such a server (it refuses with
 * `feature_unavailable`).
 */
export const SERVER_FEATURE_AUTOPILOT_AUTO_RESUME = "autopilot-auto-resume";

/** Whether the server announces that it resumes runs by itself after a restart. Takes its info or the list of its features. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsAutopilotAutoResume(info: { features?: unknown } | readonly unknown[] | null | undefined): boolean {
  const features = Array.isArray(info) ? info : (info as { features?: unknown } | null | undefined)?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_AUTO_RESUME);
}

/**
 * The `ServerInfo.features` entry of a server that takes the length of a book from its Scaletta: the chapters are the chapter entries of
 * `outline/` and the brief is `outline/_brief.md` (with the idea in `outline/book.md`). A server without it plans the default number of chapters and
 * ignores the outline, so the engine's client never starts or configures the autopilot of such a server (`ServerRequestError`, `feature_unavailable`).
 */
export const SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF = "autopilot-outline-brief";

/** Whether the server announces that the length of a book comes from its Scaletta. Takes its info or the list of its features. Never throws: an older server, or an odd answer, says no. */
export function serverHasOutlineBrief(info: { features?: unknown } | readonly unknown[] | null | undefined): boolean {
  const features = Array.isArray(info) ? info : (info as { features?: unknown } | null | undefined)?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_OUTLINE_BRIEF);
}

/**
 * The `ServerInfo.features` entry of a server that lists the conflicts of a GitHub book with GitHub and resolves them: `GET /api/v1/books/:id/github-conflicts`
 * and `POST /api/v1/books/:id/github-conflicts/resolve`. A server without it answers 404 to them: the engine's client refuses before sending
 * (`feature_unavailable`).
 */
export const SERVER_FEATURE_GITHUB_CONFLICTS = "github-conflicts";

/** Whether the server announces that it resolves the conflicts with GitHub. Takes its info or the list of its features. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsGithubConflicts(info: { features?: unknown } | readonly unknown[] | null | undefined): boolean {
  const features = Array.isArray(info) ? info : (info as { features?: unknown } | null | undefined)?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_GITHUB_CONFLICTS);
}

/**
 * The `ServerInfo.features` entry of a server that keeps the records of the AI calls of its autopilot runs (what was sent as the system and the user message, and what came back, also
 * while it streams) and serves them, read-only, to the clients that may read the book: `GET /api/v1/books/:id/autopilot/calls`, `…/calls/tasks/:activityId` and
 * `…/calls/:callId/text`, and, for the clients that may run its autopilot, `PUT …/calls/tasks/:activityId/keep` and `DELETE …/calls`. The records hold the book's text and its notes:
 * an app that connected through MCP never reaches them. A server without it answers 404 to these routes: the engine's client refuses before sending (`feature_unavailable`).
 */
export const SERVER_FEATURE_AUTOPILOT_CALLS = "autopilot-calls";

/** Whether the server announces that it keeps and serves the records of its AI calls. Takes its info or the list of its features. Never throws: an older server, or an odd answer, says no. */
export function serverHasCalls(info: { features?: unknown } | readonly unknown[] | null | undefined): boolean {
  const features = Array.isArray(info) ? info : (info as { features?: unknown } | null | undefined)?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_AUTOPILOT_CALLS);
}

/** Task headers in one page of `GET …/autopilot/calls` when the request says nothing, and the most it may ask for. */
export const SERVER_CALLS_PAGE_LIMIT = 20;
export const SERVER_CALLS_MAX_PAGE_LIMIT = 100;

/** The most bytes of text that one answer of `GET …/calls/:callId/text` holds (the text is read in pieces; the live view asks for what is new once a second). */
export const SERVER_CALL_TEXT_MAX_BYTES = 256 * 1024;

/** The fields of a call whose text a server keeps, in the order a page shows them. */
export const SERVER_CALL_FIELDS: readonly AiCallField[] = ["system", "user", "response"];

/**
 * One piece of the kept text of a call: the bytes from `from` (UTF-8, on a character boundary: it can be lower than the offset that was asked for) to `next`. `size` is how much is kept now,
 * and `attempt` the response it came from (the last one that has text when the request names none; null for the system and the user message). `done` is true once the call has ended and
 * `next` has reached `size`: nothing more will come. A reader that follows a call asks again from `next`; if `size` is lower than the `next` it holds, or `attempt` changed, the call began another
 * answer (a retry, a fallback) and the reader starts over.
 */
export interface ServerCallText {
  text: string;
  from: number;
  next: number;
  size: number;
  attempt: number | null;
  done: boolean;
}

/** The body of `PUT …/calls/tasks/:activityId/keep`: pin a task (it is never dropped to make room, but it counts against the budget) or let it go. */
export interface KeepCallTaskRequest {
  pinned: boolean;
}

/** What `DELETE …/autopilot/calls` removed: every record of the book, the pinned ones too (this is the owner's choice). */
export interface ServerDeleteCallsResponse {
  deleted: true;
  tasks: number;
  calls: number;
  bytes: number;
}

/**
 * The `code` of a conflict with GitHub: the server's commits and GitHub's changed the same files, and git cannot bring them together by itself. It is the
 * code of the error a server's run stops with (which the engine classifies as a `conflict` with `errorDetail.githubConflicts`), and of the answer of a
 * sync that meets one (`409`).
 */
export const GITHUB_CONFLICT_CODE = "github_conflict";

/** What happened to a file on one side since the version both sides started from. */
export type GithubConflictChange = "modified" | "added" | "deleted";

/** The version a resolution keeps of a file: the server's, or GitHub's (for a file deleted on that side, the deletion). */
export type GithubConflictChoice = "server" | "github";

export const GITHUB_CONFLICT_CHOICES: readonly GithubConflictChoice[] = ["server", "github"];

/** Conflicts in one page of `GET …/github-conflicts` when the request says nothing, and the most it may ask for. */
export const GITHUB_CONFLICTS_PAGE_LIMIT = 100;
export const GITHUB_CONFLICTS_MAX_PAGE_LIMIT = 500;

/** One file that changed on both sides. Its name only, and the size of each version: never what it holds. */
export interface GithubConflict {
  path: string;
  server: GithubConflictChange;
  github: GithubConflictChange;
  /** Bytes of each version, when the file is there on that side. */
  serverBytes?: number;
  githubBytes?: number;
  /**
   * `false`: the server cannot choose for this file, and a resolution keeps the server's version of it whatever is asked (`reason`: a name the server does
   * not read or write, `unsafe-path`, shown cleaned; a file on one side where the other has a folder, `file-directory`; or not a plain file, `not-a-file`).
   */
  resolvable: boolean;
  reason?: "unsafe-path" | "file-directory" | "not-a-file";
}

/** The answer of `GET /api/v1/books/:id/github-conflicts?offset=&limit=`: one page of the conflicts, in the order of their paths, and the whole picture. */
export interface GithubConflictsResponse {
  conflicts: GithubConflict[];
  /** All the conflicts, this page included. */
  total: number;
  offset: number;
  limit: number;
  /** Commits of the server that GitHub does not have, and commits of GitHub that the server does not have. */
  ahead: number;
  behind: number;
  branch: string;
  /** The server's commit and GitHub's, as compared (`githubHead` absent when the branch is not on GitHub yet). */
  head?: string;
  githubHead?: string;
  /** What these conflicts are, file by file and version by version: a resolution sends it back, and is refused (`409 conflicts_changed`) if they changed since. */
  fingerprint: string;
  /** Present when both sides changed the autopilot's own files (state, log, plan): the version a resolution keeps of them, never asked (see the server's README). */
  autopilotFiles?: GithubConflictChoice;
}

/**
 * The body of `POST /api/v1/books/:id/github-conflicts/resolve`. `choices` names a version for each file (by the `path` the list gave), `default` the
 * version of every other one; with neither for a file the answer is `400 choice_missing` and nothing is written. `fingerprint` is the one of the list the
 * author chose from: without it the server compares with the last list it gave for the book. `message` is the subject of the merge commit.
 */
export interface ResolveGithubConflictsRequest {
  choices?: Record<string, GithubConflictChoice>;
  default?: GithubConflictChoice;
  message?: string;
  fingerprint?: string;
}

/** The answer of a resolution: the commit the book is at now (a merge of the server's work and GitHub's), whether GitHub has it, and what was decided. */
export interface ResolveGithubConflictsResponse {
  head: string;
  /** `false` when the push failed (the reason in `pushError`, without a token): the book is resolved on the server, and the next publish or sync pushes it. */
  pushed: boolean;
  pushError?: string;
  /** The files resolved, with the version kept (the first ones: `counts` says how many in all). */
  resolved: Array<{ path: string; choice: GithubConflictChoice }>;
  /** Choices for files that do not conflict (any more): left aside. */
  ignored: string[];
  /** Files the server cannot choose for: kept as the server has them. */
  unresolvable: string[];
  counts: { total: number; server: number; github: number; ignored: number; unresolvable: number };
  /** The version kept of the autopilot's own files, when both sides had changed them. */
  autopilotFiles?: GithubConflictChoice;
}

/** The body of `POST /api/v1/books/:id/autopilot/frozen/:number`: what to do with the change of that chapter (`AutopilotSession.resolveFrozenChange`). */
export interface ResolveFrozenChangeRequest {
  action: FrozenAction;
  /** `frozen` (the chapter's text) or `outline` (its outline entry), for a chapter that has both; without it the action says it. */
  kind?: FrozenChangeKind;
  /** The author's words for the director. */
  note?: string;
}

/** The body of `POST /api/v1/books/:id/chapters/:slug/freeze`: freeze the chapter by hand, or take its record away. */
export interface FreezeChapterRequest {
  frozen: boolean;
}

/** The answer of `GET …/autopilot/frozen` and of `POST …/autopilot/frozen/:number`. */
export type FrozenStatusResponse = FrozenStatus;
/** The answer of `POST …/chapters/:slug/freeze`. */
export type FreezeChapterResponse = FrozenChapterResult;

/**
 * The `ServerInfo.features` entry of a server that has the MCP endpoint of a book (`/mcp/<slug>`, which an assistant such as Claude Code connects to with a
 * client token) and the routes that switch it on and off: `GET` and `PUT /api/v1/books/:id/mcp`. A server without it answers 404 to them: a client checks
 * `serverSupportsMcp` before it offers the setting.
 */
export const SERVER_FEATURE_MCP = "mcp";

/** Whether the server announces that it has the MCP endpoint of a book. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsMcp(info: { features?: unknown } | null | undefined): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_MCP);
}

/**
 * The `ServerInfo.features` entry of a server on which apps such as ChatGPT and Claude.ai connect to a book by themselves, through OAuth (the owner allows each
 * one on a page of his server): the status of the book's MCP then says how many are connected and where the OAuth server is (`ServerMcpStatus.connections` and
 * `oauth`), and `GET` and `DELETE /api/v1/books/:id/mcp/clients` list and revoke them. A server with the MCP endpoint but without it answers 404 to those two
 * routes: a client checks `serverSupportsMcpOAuth` before it offers the list.
 */
export const SERVER_FEATURE_MCP_OAUTH = "mcp-oauth";

/** Whether the server announces that apps can connect to a book's MCP endpoint through OAuth. Never throws: an older server, or an odd answer, says no. */
export function serverSupportsMcpOAuth(info: { features?: unknown } | null | undefined): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(SERVER_FEATURE_MCP_OAUTH);
}

/** Where a server's OAuth server is, as the status of a book's MCP says it (`GET /api/v1/books/:id/mcp`, from a server that announces `SERVER_FEATURE_MCP_OAUTH`). */
export interface ServerMcpOAuth {
  /** The issuer: the server's public address, or the address on its own computer while it has none. */
  issuer: string;
  /** The metadata of the authorization server (RFC 8414) and of this book as a protected resource (RFC 9728): what an app reads to find out how to get a token. */
  metadataUrl: string;
  resourceMetadataUrl: string;
  /** What an app may ask for: `mcp:read`, `mcp:write`, `mcp:run`. */
  scopes: string[];
}

/**
 * The MCP endpoint of a book as the server reports it: whether it is on, and the address an assistant connects to. It is off until the owner switches it on, one
 * book at a time. `connections` and `oauth` come from a server that announces `SERVER_FEATURE_MCP_OAUTH`; one that has the endpoint without it sends neither
 * (a missing `connections` is *unknown*, not *none*).
 */
export interface ServerMcpStatus {
  bookId: string;
  enabled: boolean;
  /** The last part of the address, made from the title once and the owner's to change: `/mcp/<slug>`. Stable: a new title never moves it. */
  slug: string;
  path: string;
  /** The address to paste into the assistant: `<public address>/mcp/<slug>`, or the local one while the server has no public address. */
  url: string;
  /** Whether `url` can be reached from outside this computer (the server has a public address). */
  public: boolean;
  /** Why `url` works from this computer only, when `public` is false. */
  message?: string;
  /** The versions of the MCP protocol the endpoint speaks, newest first. */
  protocolVersions: string[];
  updatedAt: string;
  /** How many apps are connected to the book through OAuth. Switching the book off, or changing its slug, ends them all. */
  connections?: number;
  oauth?: ServerMcpOAuth;
}

/**
 * The body of `PUT /api/v1/books/:id/mcp`: switch the endpoint on or off and/or choose the slug (lowercase letters and digits, joined by single hyphens, at most 80
 * characters). At least one of the two. Switching off, or choosing another slug, disconnects every app of the book.
 */
export interface UpdateMcpRequest {
  enabled?: boolean;
  slug?: string;
}

/** What an app connected through OAuth may do with a book: `read` always, `write` the editing tools, `run` the autopilot's. (Never `update`: an app cannot update the server.) */
export type ServerMcpClientScope = Exclude<ServerScope, "update">;

/** An app that the owner allowed to use a book through OAuth, as `GET /api/v1/books/:id/mcp/clients` lists it. Never a token. */
export interface ServerMcpClient {
  /** The connection's id: what `DELETE …/mcp/clients/:id` revokes. The same app connected twice has two. */
  id: string;
  /** The id the app registered under. */
  clientId: string;
  /** What the app calls itself, cleaned: one short line, to be shown as text. */
  name: string;
  /** The host (and port, when it has one) the app sends the owner back to: where the owner can see that it is the app's own. */
  redirectHost: string;
  /** What the owner allowed. A server may add others: show what is known and leave the rest out. */
  scopes: ServerMcpClientScope[];
  createdAt: string;
  lastUsedAt: string;
}

/** What `GET /api/v1/books/:id/mcp/clients` answers: `listMcpClients` returns the list. */
export interface ListMcpClientsResponse {
  clients: ServerMcpClient[];
}

/** The `mode`s of `POST /api/v1/books/:id/autopilot/pause`: `now`, `after-step` and `after-chapter` pause (see `AutopilotPauseMode`); `cancel` takes back a pause that waits. */
export const PAUSE_AUTOPILOT_MODES = ["now", "after-step", "after-chapter", "cancel"] as const;

/** How a client asks the server to pause (one of `PAUSE_AUTOPILOT_MODES`). */
export type PauseAutopilotMode = AutopilotPauseMode | "cancel";

export type StartAutopilotRequest = StartOptions & { force?: boolean };
export type PauseAutopilotRequest = { mode: PauseAutopilotMode };
/** The body of `PUT /api/v1/books/:id/autopilot/options`: at least one of the settings that can change while a run goes on (`longRetry` only for a server that announces `SERVER_FEATURE_AUTOPILOT_RETRY`, `resumeAfterRestart` only for one that announces `SERVER_FEATURE_AUTOPILOT_AUTO_RESUME`). */
export type UpdateAutopilotOptionsRequest = AutopilotLiveOptions;
/**
 * The body of `PUT /api/v1/books/:id/autopilot/rules/:index`: the new text of the rule at that index of `state.constraints`, and the text the
 * author saw there (`expectedText`), so that a rule that changed in the meantime is never overwritten (`DELETE …/rules/:index?expectedText=…`
 * takes it as a query parameter). Both answer the snapshot, like `configure`.
 */
export interface UpdateAutopilotRuleRequest {
  text: string;
  expectedText?: string;
}
export type InterveneRequest = InterventionInput;
export type AnswerRequest = QuestionAnswer;

export interface EventsResponse {
  events: AutopilotEvent[];
  lastSeq: number;
}

export interface ErrorResponse {
  code: string;
  message: string;
}

/** Messages carried by the `/api/v1/events` stream. */
export type ServerStreamMessage =
  | { event: "hello"; data: { serverId: string; at: string } }
  | { event: "heartbeat"; data: { at: string } }
  | { event: "autopilot"; data: AutopilotEvent }
  | { event: "book"; data: ServerBookSummary };

export function encodeServerSentEvent(message: ServerStreamMessage, id?: string | number): string {
  const lines = [`event: ${message.event}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  for (const line of JSON.stringify(message.data).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** Incremental parser for a `text/event-stream` body. */
export class ServerSentEventParser {
  private buffer = "";
  private event = "message";
  private data: string[] = [];

  constructor(private readonly onEvent: (event: string, data: string) => void, private readonly maxEventBytes = 2_000_000) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxEventBytes) throw new Error("Server event too large.");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private line(line: string): void {
    if (!line) {
      if (this.data.length) this.onEvent(this.event, this.data.join("\n"));
      this.event = "message";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value || "message";
    else if (field === "data") this.data.push(value);
  }
}

/** Normalize a server URL typed by the author (`localhost:24242` → `http://localhost:24242`). */
export function normalizeServerUrl(value: string): string {
  let raw = value.trim();
  if (!raw) throw new Error("The server address is empty.");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") throw new Error("The server address must use http or https.");
  if (!scheme) raw = `${/^(localhost|127\.|\[::1\])/i.test(raw) ? "http" : "https"}://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The server address must use http or https.");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function bookRoute(bookId: string, suffix = ""): string {
  return `/api/v1/books/${encodeURIComponent(bookId)}${suffix}`;
}

/** The text a server signs to prove its identity for one request. */
export function serverIdentityMessage(nonce: string, serverId: string, publicKey: string): string {
  return `${nonce}\n${serverId}\n${publicKey}`;
}

/** 64 random hex characters, used as identity and pairing nonces. */
export function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface ServerIdentityCheck {
  /** The signature was verified with Web Crypto. */
  verified: boolean;
  /** This runtime cannot verify Ed25519 signatures (only the fingerprint can be compared). */
  unsupported?: boolean;
  fingerprint: string;
  /** Whether the server speaks an API this engine supports: reported, never thrown, so the host decides how to say it. */
  compatibility: ServerCompatibility;
}

/**
 * Check that a signed `/api/v1/info` answer comes from the holder of the announced key: the
 * fingerprint must match the key and the signature must cover this nonce. Throws when they do not.
 */
export async function verifyServerIdentity(info: ServerInfo, nonce: string): Promise<ServerIdentityCheck> {
  if (!info.publicKey || !info.signature || !info.fingerprint || info.nonce !== nonce) throw new Error("The personal server did not prove its identity.");
  const compatibility = serverCompatibility(info);
  const subtle = globalThis.crypto.subtle;
  const keyBytes = base64Bytes(info.publicKey);
  const digest = new Uint8Array(await subtle.digest("SHA-256", keyBytes));
  const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (fingerprint !== info.fingerprint) throw new Error("The personal server's identity does not match its key.");
  let key: CryptoKey;
  try {
    key = await subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { verified: false, unsupported: true, fingerprint, compatibility };
  }
  const valid = await subtle.verify({ name: "Ed25519" }, key, base64Bytes(info.signature), new TextEncoder().encode(serverIdentityMessage(nonce, info.serverId, info.publicKey)));
  if (!valid) throw new Error("The personal server's identity signature is not valid.");
  return { verified: true, fingerprint, compatibility };
}

export type { AutopilotSnapshot };
