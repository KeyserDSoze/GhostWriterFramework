import { ServerRequestError, createAutopilotState, type AutopilotSnapshot, type NarrariumServerClient, type ServerBookSummary, type ServerInfo, type ServerStreamMessage } from "narrarium-engine";

export interface OpenStream {
  tab: string;
  /** Why it ended, when it did. */
  state: "open" | "ended" | "dropped";
  push: (message: ServerStreamMessage) => void;
  /** The server closes the stream: the client's read ends. */
  end: () => void;
}

const INFO: ServerInfo = { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.0", engineVersion: "0.1.2", serverId: "server-1", label: "Home server", git: true, features: [] };

/**
 * A personal server as the live connection sees it: it lists books, answers snapshots and holds streams open,
 * refusing the eleventh stream of the same token like the real one.
 */
export class FakeStreamServer {
  readonly streams: OpenStream[] = [];
  books: ServerBookSummary[] = [];
  readonly snapshotRequests: string[] = [];
  listBooksCalls = 0;
  /** Streams the server accepts for the token (the real limit is ten). */
  streamLimit = 10;
  /** `listBooks` fails with this while set. */
  listFailure: Error | null = null;
  /** A newly opened stream sends the `hello` the real server sends. */
  sendsHello = true;
  /** The state a snapshot reports. */
  running = false;

  get open(): OpenStream[] {
    return this.streams.filter((stream) => stream.state === "open");
  }

  /** What a message from the server does: reaches every stream that is open. */
  push(message: ServerStreamMessage): void {
    for (const stream of this.open) stream.push(message);
  }

  /** The server's `heartbeat`, every 15 seconds while the clock runs. */
  startHeartbeats(everyMs = 15_000): () => void {
    const timer = setInterval(() => this.push({ event: "heartbeat", data: { at: new Date().toISOString() } }), everyMs);
    return () => clearInterval(timer);
  }

  /** The connections of a tab vanish, as when the tab is closed. */
  dropTab(tab: string): void {
    for (const stream of this.streams) if (stream.tab === tab && stream.state === "open") stream.state = "dropped";
  }

  /** A client for a tab. */
  client(tab: string): NarrariumServerClient {
    const server = this;
    const fake = {
      async listBooks() {
        server.listBooksCalls += 1;
        if (server.listFailure) throw server.listFailure;
        return server.books;
      },
      async updates() {
        return { packageName: "narrarium-server", installedVersion: "0.1.0", available: false, canRequest: false, signed: true, supervised: false, hasUpdateScope: false, message: "Up to date." };
      },
      async autopilot(bookId: string): Promise<AutopilotSnapshot> {
        server.snapshotRequests.push(bookId);
        return { bookId, state: createAutopilotState(new Date("2026-11-21T10:00:00.000Z")), activities: [], live: null, running: server.running, host: "server" };
      },
      stream(onMessage: (message: ServerStreamMessage) => void, signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          if (server.open.length >= server.streamLimit) {
            reject(new ServerRequestError(`This client already holds ${server.streamLimit} live connections.`, 429, "too_many_streams"));
            return;
          }
          const stream: OpenStream = { tab, state: "open", push: (message) => { if (stream.state === "open") onMessage(message); }, end: () => finish() };
          server.streams.push(stream);
          const finish = (error?: unknown) => {
            if (stream.state === "open") stream.state = "ended";
            if (error) reject(error);
            else resolve();
          };
          signal.addEventListener("abort", () => finish(new DOMException("The operation was aborted.", "AbortError")), { once: true });
          if (signal.aborted) {
            finish(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          if (server.sendsHello) onMessage({ event: "hello", data: { serverId: INFO.serverId, at: new Date().toISOString() } });
        });
      },
    };
    return fake as unknown as NarrariumServerClient;
  }

  /** The runtime's `connect`: a verified server for a tab. */
  connector(tab: string) {
    return async () => ({ client: this.client(tab), info: INFO, fingerprint: "f".repeat(64) });
  }
}
