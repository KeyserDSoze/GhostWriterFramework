import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { engineModule } from "./autopilot";

// A personal server as far as the app asks of it when it is connected: it proves its identity (Ed25519, as the real one does, the key pinned in the settings), tells which books it
// hosts with what the autopilot of each spent, and keeps the live stream open. Nothing else: no files, no runs.

export interface StubServerBook {
  bookId: string;
  title: string;
  /** What the server's autopilot counted of the book over all its runs. */
  stats: { cost: number; currency?: string; aiCalls: number; costUnknownCalls?: number };
}

export interface StubServer {
  url: string;
  token: string;
  serverId: string;
  fingerprint: string;
  /** The books it lists, replaced at will; the stream tells nothing of the change, so the app sees it at its next connection. */
  books: StubServerBook[];
  /** What the app asked it, as `METHOD /path`. */
  requests: string[];
  close: () => Promise<void>;
}

const TOKEN = "e2e-server-token-0123456789abcdef";

export async function startServer(books: StubServerBook[]): Promise<StubServer> {
  const engine = await engineModule("index.js");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyText = Buffer.from(spki).toString("base64");
  const fingerprint = createHash("sha256").update(spki).digest("hex");
  const serverId = "e2e-server-1";
  const signer = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));
  const requests: string[] = [];
  const state = { books };
  const summaryOf = (book: StubServerBook) => {
    const base = engine.createAutopilotState(new Date("2026-11-20T10:00:00.000Z"), { ...engine.DEFAULT_BRIEF, idea: book.title });
    const stats = { tasks: book.stats.aiCalls, aiCalls: book.stats.aiCalls, inputTokens: book.stats.aiCalls * 1000, outputTokens: book.stats.aiCalls * 300, failures: 0, currency: book.stats.currency ?? "USD", ...book.stats };
    return engine.summarizeAutopilotState({ ...base, status: "paused", updatedAt: "2026-11-27T10:00:00.000Z", stats });
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    const json = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (url.pathname === "/api/v1/info") {
      const nonce = url.searchParams.get("nonce") ?? undefined;
      const signature = nonce ? sign(null, Buffer.from(engine.serverIdentityMessage(nonce, serverId, publicKeyText)), signer).toString("base64") : undefined;
      json(200, { name: "narrarium-server", apiVersion: engine.MAX_SUPPORTED_SERVER_API, serverVersion: "0.1.24", engineVersion: "0.1.29", serverId, label: "Home server", git: false, features: [], publicKey: publicKeyText, fingerprint, ...(nonce ? { nonce, signature } : {}) });
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { json(401, { code: "unauthorized", message: "Not signed in." }); return; }
    if (url.pathname === "/api/v1/books") {
      json(200, { books: state.books.map((book) => ({ bookId: book.bookId, title: book.title, storage: { kind: "local" }, hasGithubToken: false, ready: true, revision: "r1", autopilot: summaryOf(book), running: false, lastSync: null })) });
      return;
    }
    if (url.pathname === "/api/v1/stream") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write(": open\n\n");
      const beat = setInterval(() => response.write(": beat\n\n"), 5000);
      request.on("close", () => clearInterval(beat));
      return;
    }
    json(404, { code: "not_found", message: "The stub server does not serve this." });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: TOKEN,
    serverId,
    fingerprint,
    get books() { return state.books; },
    set books(next: StubServerBook[]) { state.books = next; },
    requests,
    close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
  };
}
