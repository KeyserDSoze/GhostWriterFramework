import type { AiRuntimeConfig } from "../ai/config.js";
import { BookConflictError, type BookCommitResult, type BookFileChange, type BookFileContent, type BookFileEntry, type BookStore } from "../book/store.js";
import type { AutopilotSnapshot, InterventionInput, QuestionAnswer, StartOptions } from "../autopilot/types.js";
import { linkedSignal } from "../util/abort.js";
import {
  ServerSentEventParser,
  bookRoute,
  normalizeServerUrl,
  randomNonce,
  verifyServerIdentity,
  type AskDirectorRequest,
  type AskDirectorResponse,
  type ErrorResponse,
  type EventsResponse,
  type PairingRequest,
  type PairingResult,
  type ReadFilesResponse,
  type RegisterBookRequest,
  type ServerAiStatus,
  type ServerBookSummary,
  type ServerIdentityCheck,
  type ServerInfo,
  type ServerManifest,
  type ServerSession,
  type ServerStreamMessage,
  type ServerUpdateAccepted,
  type ServerUpdateInfo,
  type ServerUpdateRequest,
} from "./protocol.js";

export class ServerRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ServerRequestError";
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
        const error = (payload ?? {}) as Partial<ErrorResponse>;
        throw new ServerRequestError(error.message || `The personal server answered HTTP ${response.status}.`, response.status, error.code || "http_error");
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

  /** First pairing step: send the code shown in the server's admin panel. */
  requestPairing(request: PairingRequest): Promise<{ id: string }> {
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

  startAutopilot(bookId: string, options: StartOptions & { force?: boolean } = {}): Promise<AutopilotSnapshot> {
    return this.request("POST", bookRoute(bookId, "/autopilot/start"), options, { timeoutMs: 300_000 });
  }

  pauseAutopilot(bookId: string, mode: "now" | "after-step"): Promise<AutopilotSnapshot> {
    return this.request("POST", bookRoute(bookId, "/autopilot/pause"), { mode });
  }

  intervene(bookId: string, input: InterventionInput): Promise<AutopilotSnapshot> {
    return this.request("POST", bookRoute(bookId, "/autopilot/intervene"), input);
  }

  answer(bookId: string, input: QuestionAnswer): Promise<AutopilotSnapshot> {
    return this.request("POST", bookRoute(bookId, "/autopilot/answer"), input);
  }

  configureAutopilot(bookId: string, input: StartOptions): Promise<AutopilotSnapshot> {
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

export interface PairWithServerOptions {
  baseUrl: string;
  /** Nine-digit code generated in the server's admin panel. */
  code: string;
  /** Name of this client as the owner will see it. */
  label: string;
  signal?: AbortSignal;
  /** Called once the code is accepted, while the owner has to approve the request. */
  onWaitingApproval?: () => void;
  pollMs?: number;
  fetch?: typeof fetch;
}

/** Pair this client with a server: send the code, wait for the owner's approval, return the token. */
export async function pairWithServer(options: PairWithServerOptions): Promise<string> {
  const client = new NarrariumServerClient({ baseUrl: options.baseUrl, token: "", fetch: options.fetch });
  const nonce = randomNonce();
  const { id } = await client.requestPairing({ code: options.code.replace(/\D/g, ""), nonce, label: options.label.trim().slice(0, 80) || "Narrarium" });
  options.onWaitingApproval?.();
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const result = await client.pairingResult(id, nonce);
    if ("token" in result) return result.token;
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
