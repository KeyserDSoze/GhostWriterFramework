import type { AiRuntimeConfig } from "../ai/config.js";
import { BookConflictError, type BookCommitResult, type BookFileChange, type BookFileContent, type BookFileEntry, type BookStore } from "../book/store.js";
import type { AutopilotSnapshot, InterventionInput, QuestionAnswer, StartOptions } from "../autopilot/types.js";
import { linkedSignal } from "../util/abort.js";
import {
  ServerSentEventParser,
  bookRoute,
  normalizeServerUrl,
  type AskDirectorRequest,
  type AskDirectorResponse,
  type ErrorResponse,
  type EventsResponse,
  type ReadFilesResponse,
  type RegisterBookRequest,
  type ServerAiStatus,
  type ServerBookSummary,
  type ServerInfo,
  type ServerManifest,
  type ServerSession,
  type ServerStreamMessage,
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

  info(): Promise<ServerInfo> {
    return this.request("GET", "/api/v1/info", undefined, { auth: false, timeoutMs: 10_000 });
  }

  session(): Promise<ServerSession> {
    return this.request("GET", "/api/v1/session", undefined, { timeoutMs: 10_000 });
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

/** A `BookStore` backed by the files of a book hosted on the personal server. */
export function remoteBookStore(client: NarrariumServerClient, bookId: string): BookStore {
  return {
    async list(): Promise<BookFileEntry[]> {
      return (await client.manifest(bookId)).files;
    },
    async read(path: string): Promise<BookFileContent | null> {
      return (await client.readFiles(bookId, [path]))[0] ?? null;
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
