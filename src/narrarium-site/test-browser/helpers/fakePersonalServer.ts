import { serverIdentityMessage, type ServerInfo } from "narrarium-engine";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A real Ed25519 key pair announced the way narrarium-server announces its identity. */
export interface FakeIdentity {
  serverId: string;
  publicKey: string;
  fingerprint: string;
  sign(nonce: string): Promise<string>;
}

export async function createFakeIdentity(serverId: string = crypto.randomUUID()): Promise<FakeIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const publicKey = base64(spki);
  return {
    serverId,
    publicKey,
    fingerprint: hex(await crypto.subtle.digest("SHA-256", spki)),
    sign: async (nonce) => base64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(serverIdentityMessage(nonce, serverId, publicKey))))),
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  origin: string;
  path: string;
  authorization: string | null;
  body: unknown;
  signal: AbortSignal | null;
}

export interface FakeServer {
  identity: FakeIdentity;
  /** Client token the server accepts. */
  token: string;
  label?: string;
  /** Answer `/info` without a signature, like a server that cannot prove who it is. */
  unsigned?: boolean;
  /** Announce `identity` but sign with another key. */
  forgeWith?: FakeIdentity;
  /** Answer every authenticated request with this status instead of serving it. */
  failWith?: number;
  /** Authenticated requests wait for this promise (and for an abort) before they are served. */
  hold?: Promise<void>;
  books?: unknown[];
  aiConfig?: unknown;
  registered?: Array<{ bookId: string; body: unknown }>;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that serves fake personal servers by origin and records everything sent to them. */
export function createFakeNetwork(servers: Record<string, FakeServer>) {
  const requests: RecordedRequest[] = [];
  const byOrigin = new Map(Object.entries(servers));

  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, url: url.href, origin: url.origin, path: url.pathname, authorization: headers.get("authorization"), body, signal: init?.signal ?? null });
    init?.signal?.throwIfAborted();
    const server = byOrigin.get(url.origin);
    if (!server) throw new TypeError("fetch failed");

    if (method === "GET" && url.pathname === "/api/v1/info") {
      const nonce = url.searchParams.get("nonce") ?? undefined;
      const signer = server.forgeWith ?? server.identity;
      const info: ServerInfo = {
        name: "narrarium-server",
        apiVersion: 1,
        serverVersion: "0.1.0",
        engineVersion: "0.1.1",
        serverId: server.identity.serverId,
        label: server.label ?? "Test server",
        git: true,
        features: [],
        publicKey: server.identity.publicKey,
        fingerprint: server.identity.fingerprint,
        ...(nonce && !server.unsigned ? { nonce, signature: await signer.sign(nonce) } : {}),
      };
      return json(200, info);
    }
    if (method === "POST" && url.pathname === "/api/v1/pairings") return json(200, { id: "pairing-1" });

    if (headers.get("authorization") !== `Bearer ${server.token}`) return json(401, { code: "unauthorized", message: "Unknown client token." });
    if (server.hold) {
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort, { once: true });
        void server.hold!.then(resolve);
      });
    }
    if (server.failWith) return json(server.failWith, { code: "broken", message: `HTTP ${server.failWith}` });

    const route = `${method} ${url.pathname}`;
    if (route === "GET /api/v1/session") return json(200, { serverId: server.identity.serverId, label: server.label ?? "Test server", clientLabel: "Test device", clientId: "client-1", scopes: ["read", "write", "run"] });
    if (route === "DELETE /api/v1/session") return json(200, { revoked: true });
    if (route === "GET /api/v1/ai") return json(200, { configured: Boolean(server.aiConfig), integrations: [], routedTasks: [], updatedAt: null });
    if (route === "PUT /api/v1/ai") {
      server.aiConfig = (body as { config?: unknown } | undefined)?.config;
      return json(200, { configured: true, integrations: [], routedTasks: [], updatedAt: "2026-11-21T10:00:00.000Z" });
    }
    if (route === "GET /api/v1/updates") return json(200, { packageName: "narrarium-server", installedVersion: "0.1.0", available: false, canRequest: false, signed: true, supervised: false, hasUpdateScope: false, reason: "up_to_date", message: "Up to date." });
    if (route === "GET /api/v1/books") return json(200, { books: server.books ?? [] });
    if (route === "GET /api/v1/events") {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: hello\ndata: ${JSON.stringify({ serverId: server.identity.serverId, at: "2026-11-21T10:00:00.000Z" })}\n\n`));
          signal?.addEventListener("abort", () => { try { controller.error(signal.reason ?? new DOMException("Aborted", "AbortError")); } catch { /* already closed */ } }, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const bookRoute = /^\/api\/v1\/books\/([^/]+)$/.exec(url.pathname);
    if (method === "PUT" && bookRoute) {
      const bookId = decodeURIComponent(bookRoute[1]);
      server.registered?.push({ bookId, body });
      return json(200, { bookId, title: (body as { title?: string } | undefined)?.title ?? bookId, storage: (body as { storage?: unknown } | undefined)?.storage ?? { kind: "local" }, hasGithubToken: Boolean((body as { githubToken?: unknown } | undefined)?.githubToken), ready: true, revision: "r1", autopilot: null, running: false, lastSync: null });
    }
    if (/^GET \/api\/v1\/books\/[^/]+\/manifest$/.test(route)) return json(200, { revision: "r1", files: [] });
    return json(404, { code: "not_found", message: "Unknown endpoint." });
  };

  return {
    fetch: fetchFake as typeof fetch,
    requests,
    /** Requests that carried the client token. */
    authenticated: () => requests.filter((request) => request.authorization),
    infoProbes: (origin?: string) => requests.filter((request) => request.path === "/api/v1/info" && (!origin || request.origin === origin)),
  };
}
