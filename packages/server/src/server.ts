import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AiUnavailableError,
  AutopilotBusyError,
  ENGINE_VERSION,
  SERVER_API_VERSION,
  SERVER_PACKAGE_NAME,
  encodeServerSentEvent,
  isBookConflictError,
  pickAiRuntimeConfig,
  redactAiRuntimeConfig,
  type AiPort,
  type AutopilotEvent,
  type EvaluationTarget,
  type ServerInfo,
  type ServerStreamMessage,
} from "narrarium-engine";
import { BookRegistry, HttpError } from "./books.js";
import { DEFAULT_ORIGINS, DataDirectory, defaultDataDirectory, type ServerConfig, type StoredToken } from "./config.js";
import { gitVersion } from "./git.js";
import { SERVER_VERSION } from "./version.js";

export interface NarrariumServerOptions {
  dataDir?: string;
  port?: number;
  host?: string;
  label?: string;
  /** Extra browser origins allowed to call the API. */
  origins?: string[];
  /** Extra `Host` header values accepted when bound to loopback (e.g. a tunnel hostname). */
  allowHosts?: string[];
  /** Inject an AI port (tests and demos). */
  ai?: AiPort;
  /** Override the GitHub clone URL (tests). */
  githubRemoteUrl?: (owner: string, repo: string) => string;
  /** Create a first client token when none exists (default true). */
  createInitialToken?: boolean;
  log?: (line: string) => void;
}

export interface RunningNarrariumServer {
  url: string;
  port: number;
  config: ServerConfig;
  data: DataDirectory;
  books: BookRegistry;
  /** Clear token created at first start, shown once. */
  initialToken?: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SMALL_BODY = 2 * 1024 * 1024;
const LARGE_BODY = 64 * 1024 * 1024;

function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = String(request.headers["content-type"] ?? "");
    if (type && !/^application\/json\b/i.test(type)) {
      reject(new HttpError(415, "unsupported_media_type", "Send JSON."));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "payload_too_large", "The request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"), (key, value) => (key === "__proto__" || key === "constructor" || key === "prototype") ? undefined : value);
        resolve(parsed ?? {});
      } catch {
        reject(new HttpError(400, "invalid_json", "The request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function errorStatus(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof AiUnavailableError) return { status: 412, code: "ai_not_configured", message: error.message };
  if (error instanceof AutopilotBusyError) return { status: 409, code: "busy", message: error.message };
  if (isBookConflictError(error)) return { status: 409, code: "conflict", message: (error as Error).message };
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "internal";
  return { status, code, message: error instanceof Error ? error.message : String(error) };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request", "Expected a JSON object.");
  return value as Record<string, unknown>;
}

function asTarget(value: unknown): EvaluationTarget {
  const target = asObject(value);
  if (target.kind === "book") return { kind: "book" };
  if (target.kind === "chapter" && typeof target.chapter === "string") return { kind: "chapter", chapter: target.chapter };
  if (target.kind === "paragraph" && typeof target.chapter === "string" && typeof target.paragraph === "string") return { kind: "paragraph", chapter: target.chapter, paragraph: target.paragraph };
  throw new HttpError(400, "invalid_target", "The director target must be the book, a chapter or a paragraph.");
}

type Handler = (context: { request: IncomingMessage; response: ServerResponse; params: string[]; url: URL; client: StoredToken }) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  bodyLimit?: number;
}

export async function startNarrariumServer(options: NarrariumServerOptions = {}): Promise<RunningNarrariumServer> {
  const log = options.log ?? (() => undefined);
  const data = new DataDirectory(options.dataDir ?? defaultDataDirectory());
  await data.ensure();
  const releaseLock = await data.acquireLock();
  try {
    const config = await data.config({ port: options.port, host: options.host, label: options.label, origins: options.origins });
    let initialToken: string | undefined;
    if (options.createInitialToken !== false && (await data.tokens()).length === 0) initialToken = (await data.createToken("first client")).token;
    const gitAvailable = Boolean(await gitVersion());
    const origins = new Set([...DEFAULT_ORIGINS, ...config.origins].map((origin) => origin.replace(/\/+$/, "")));
    const streams = new Set<ServerResponse>();
    const broadcast = (message: ServerStreamMessage, id?: number) => {
      const frame = encodeServerSentEvent(message, id);
      for (const stream of streams) {
        if (stream.writableLength > 4 * 1024 * 1024) {
          stream.end();
          streams.delete(stream);
          continue;
        }
        stream.write(frame);
      }
    };
    const pendingBookUpdates = new Set<string>();
    let bookTimer: NodeJS.Timeout | null = null;
    const books = new BookRegistry(data, config, {
      gitAvailable,
      ai: options.ai,
      githubRemoteUrl: options.githubRemoteUrl,
      log,
      onEvent: (event: AutopilotEvent) => broadcast({ event: "autopilot", data: event }, event.seq),
      onBookChanged: (bookId) => {
        pendingBookUpdates.add(bookId);
        if (bookTimer) return;
        bookTimer = setTimeout(() => {
          bookTimer = null;
          const ids = [...pendingBookUpdates];
          pendingBookUpdates.clear();
          for (const id of ids) {
            if (!books.has(id)) continue;
            void books.summary(books.get(id)).then((summary) => broadcast({ event: "book", data: summary })).catch(() => undefined);
          }
        }, 300);
      },
    });
    await books.load();

    const info = (): ServerInfo => ({
      name: SERVER_PACKAGE_NAME,
      apiVersion: SERVER_API_VERSION,
      serverVersion: SERVER_VERSION,
      engineVersion: ENGINE_VERSION,
      serverId: config.serverId,
      label: config.label,
      git: gitAvailable,
      features: ["autopilot", "director", "sync", ...(gitAvailable ? ["github"] : [])],
    });
    const aiStatus = async () => {
      const { config: aiConfig, updatedAt } = await data.aiConfig();
      const redacted = redactAiRuntimeConfig(aiConfig);
      return { configured: options.ai ? true : aiConfig.aiIntegrations.length > 0, integrations: redacted.integrations, routedTasks: redacted.routedTasks, updatedAt };
    };

    const routes: Route[] = [
      { method: "GET", pattern: /^\/api\/v1\/session$/, handler: async ({ client }) => ({ serverId: config.serverId, label: config.label, clientLabel: client.label, clientId: client.id }) },
      { method: "GET", pattern: /^\/api\/v1\/ai$/, handler: aiStatus },
      {
        method: "PUT", pattern: /^\/api\/v1\/ai$/, handler: async ({ request }) => {
          const body = asObject(await readBody(request, SMALL_BODY));
          await data.saveAiConfig(pickAiRuntimeConfig(body.config));
          return aiStatus();
        },
      },
      { method: "GET", pattern: /^\/api\/v1\/books$/, handler: async () => ({ books: await books.summaries() }) },
      {
        method: "PUT", pattern: /^\/api\/v1\/books\/([^/]+)$/, handler: async ({ request, params }) => {
          const body = asObject(await readBody(request, SMALL_BODY));
          return books.register(params[0], {
            title: String(body.title ?? ""),
            storage: body.storage as never,
            ...(body.githubToken === null || typeof body.githubToken === "string" ? { githubToken: body.githubToken as string | null } : {}),
          });
        },
      },
      {
        method: "DELETE", pattern: /^\/api\/v1\/books\/([^/]+)$/, handler: async ({ params }) => {
          await books.remove(params[0]);
          return { removed: true };
        },
      },
      {
        method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/manifest$/, handler: async ({ params }) => {
          const runtime = books.get(params[0]);
          return { revision: (await books.summary(runtime)).revision, files: await runtime.store.list() };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/files\/read$/, handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const paths = Array.isArray(body.paths) ? body.paths.filter((entry): entry is string => typeof entry === "string").slice(0, 2000) : [];
          const files = await Promise.all(paths.map((path) => runtime.store.read(path)));
          return { files: files.filter(Boolean) };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/files\/commit$/, bodyLimit: LARGE_BODY, handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, LARGE_BODY));
          const changes = Array.isArray(body.changes) ? body.changes.map((entry) => {
            const change = asObject(entry);
            if (typeof change.path !== "string" || (change.content !== null && typeof change.content !== "string")) throw new HttpError(400, "invalid_change", "Every change needs a path and a text content (or null).");
            return {
              path: change.path,
              content: change.content as string | null,
              ...(change.expectedHash === null || typeof change.expectedHash === "string" ? { expectedHash: change.expectedHash as string | null } : {}),
            };
          }) : [];
          if (!changes.length) throw new HttpError(400, "invalid_request", "No changes to commit.");
          await runtime.store.commit(changes, typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 300) : "Sync from Narrarium");
          if (runtime.book.storage.kind === "github" && runtime.git && !runtime.session.running) await books.syncGitHub(params[0]).catch(() => undefined);
          return { revision: (await books.summary(runtime)).revision };
        },
      },
      { method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/sync$/, handler: async ({ params }) => books.syncGitHub(params[0]) },
      { method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot$/, handler: async ({ params }) => books.get(params[0]).session.snapshot() },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/start$/, handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          if (!(await books.aiConfigured())) throw new HttpError(412, "ai_not_configured", "Send your AI router configuration to the server before starting the autopilot.");
          books.assertCanStart();
          await runtime.session.start({ brief: body.brief as never, options: body.options as never, force: body.force === true });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/pause$/, handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          runtime.session.pause(body.mode === "now" ? "now" : "after-step");
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/intervene$/, handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const scope = body.scope === "from_now" || body.scope === "rewrite" ? body.scope : "next_step";
          await runtime.session.intervene({ scope, text: String(body.text ?? "").slice(0, 8000), interrupt: body.interrupt === true });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/answer$/, handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          await runtime.session.answer({ questionId: String(body.questionId ?? ""), answer: String(body.answer ?? "").slice(0, 8000), accept: body.accept === true });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/configure$/, handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          await runtime.session.configure({ brief: body.brief as never, options: body.options as never });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/reset$/, handler: async ({ params }) => {
          const runtime = books.get(params[0]);
          await runtime.session.reset();
          return runtime.session.snapshot();
        },
      },
      {
        method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/events$/, handler: async ({ params, url }) => {
          const runtime = books.get(params[0]);
          const since = Number(url.searchParams.get("since") ?? "0");
          return { events: runtime.session.recentEvents(Number.isFinite(since) ? since : 0), lastSeq: runtime.session.lastSeq };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/director\/ask$/, handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const controller = new AbortController();
          request.on("close", () => {
            if (!request.complete || request.destroyed) controller.abort();
          });
          return runtime.session.askDirector({ target: asTarget(body.target), question: typeof body.question === "string" ? body.question.slice(0, 4000) : undefined, save: body.save === true, signal: controller.signal });
        },
      },
    ];

    const allowedHosts = new Set([...(options.allowHosts ?? [])].map((host) => host.toLowerCase()));
    const loopbackBinding = LOOPBACK.has(config.host);

    const server = http.createServer((request, response) => {
      const started = Date.now();
      void (async () => {
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("referrer-policy", "no-referrer");
        const origin = typeof request.headers.origin === "string" ? request.headers.origin.replace(/\/+$/, "") : "";
        if (origin) {
          if (!origins.has(origin)) throw new HttpError(403, "origin_not_allowed", `The origin ${origin} is not allowed. Start the server with --origin ${origin} to allow it.`);
          response.setHeader("access-control-allow-origin", origin);
          response.setHeader("vary", "Origin");
        }
        const hostHeader = String(request.headers.host ?? "").toLowerCase();
        const hostName = hostHeader.replace(/:\d+$/, "");
        if (loopbackBinding && !LOOPBACK.has(hostName) && !allowedHosts.has(hostName) && !allowedHosts.has(hostHeader)) {
          throw new HttpError(421, "host_not_allowed", "Unexpected Host header. Use --allow-host for a tunnel or reverse proxy hostname.");
        }
        if (request.method === "OPTIONS") {
          response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
          response.setHeader("access-control-allow-headers", "authorization, content-type, accept");
          response.setHeader("access-control-max-age", "600");
          if (request.headers["access-control-request-private-network"] === "true") response.setHeader("access-control-allow-private-network", "true");
          response.writeHead(204);
          response.end();
          return;
        }
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET" && url.pathname === "/api/v1/info") {
          sendJson(response, 200, info());
          return;
        }
        if (request.method === "GET" && url.pathname === "/") {
          sendJson(response, 200, { ...info(), message: "Narrarium personal server. Connect it from Narrarium → Settings → Personal server." });
          return;
        }
        const authorization = String(request.headers.authorization ?? "");
        const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? "";
        const client = await data.verifyToken(token);
        if (!client) throw new HttpError(401, "unauthorized", "Missing or invalid client token. Create one with: npx narrarium-server token create");
        if (request.method === "GET" && url.pathname === "/api/v1/events") {
          response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" });
          response.write(encodeServerSentEvent({ event: "hello", data: { serverId: config.serverId, at: new Date().toISOString() } }));
          streams.add(response);
          request.on("close", () => streams.delete(response));
          return;
        }
        for (const route of routes) {
          if (route.method !== request.method) continue;
          const match = route.pattern.exec(url.pathname);
          if (!match) continue;
          const params = match.slice(1).map((value) => decodeURIComponent(value));
          const payload = await route.handler({ request, response, params, url, client });
          sendJson(response, 200, payload);
          return;
        }
        throw new HttpError(404, "not_found", "Unknown endpoint.");
      })().catch((error) => {
        const { status, code, message } = errorStatus(error);
        if (status >= 500) log(`Error on ${request.method} ${request.url}: ${message}`);
        if (!response.headersSent) sendJson(response, status, { code, message });
        else response.end();
      }).finally(() => {
        if (request.url !== "/api/v1/events") log(`${request.method} ${request.url} ${response.statusCode} ${Date.now() - started}ms`);
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 20_000;
    server.keepAliveTimeout = 5_000;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const heartbeat = setInterval(() => broadcast({ event: "heartbeat", data: { at: new Date().toISOString() } }), 15_000);
    heartbeat.unref();
    const displayHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host.includes(":") ? `[${config.host}]` : config.host;

    let closed = false;
    return {
      url: `http://${displayHost}:${address.port}`,
      port: address.port,
      config,
      data,
      books,
      initialToken,
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (bookTimer) clearTimeout(bookTimer);
        await books.close();
        for (const stream of streams) stream.end();
        const closing = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        await closing;
        await releaseLock();
      },
    };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}
