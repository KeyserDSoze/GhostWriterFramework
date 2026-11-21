import http, { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import {
  AiUnavailableError,
  AutopilotBusyError,
  DEFAULT_ADMIN_PORT,
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
  type ServerAiStatus,
  type ServerInfo,
  type ServerScope,
  type ServerStreamMessage,
  type ServerUpdateInfo,
  type ServerUpdateResult,
} from "narrarium-engine";
import { Auth, isScope, parseScopes, type ClientRecord } from "./auth.js";
import { BookRegistry } from "./books.js";
import { DEFAULT_ORIGINS, DataDirectory, normalizeOrigin } from "./config.js";
import { HttpError } from "./errors.js";
import { lockDataRoot, unsafeKeys } from "./files.js";
import { gitVersion } from "./git.js";
import { checkNpmServerRelease, isExactSemver, type NpmReleaseCheck } from "./npm-release.js";
import { RuntimeInstaller, SUPERVISED_ENV, type UpdateResult } from "./runtime-install.js";
import { CloudflareTunnelManager, type CloudflareTunnelManagerOptions } from "./tunnel.js";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "./ui.js";
import { SERVER_VERSION } from "./version.js";

export interface NarrariumServerOptions {
  dataDir: string;
  /** API port (default from config.json, 24242; 0 picks a free port). */
  port?: number;
  /** Admin panel port (default from config.json, 24243; 0 picks a free port). */
  adminPort?: number;
  label?: string;
  /** Extra browser origins allowed to call the API (saved in config.json). */
  origins?: string[];
  /** Inject an AI port (tests and demos). */
  ai?: AiPort;
  /** Override the GitHub clone URL (tests). */
  githubRemoteUrl?: (owner: string, repo: string) => string;
  /** Running under the npx supervisor (default: the NARRARIUM_SUPERVISED environment variable). */
  supervised?: boolean;
  /** npm release check (tests inject a fake registry). */
  checkRelease?: (installedVersion: string) => Promise<NpmReleaseCheck>;
  /** Cloudflare connector overrides (tests). */
  tunnel?: Omit<CloudflareTunnelManagerOptions, "root">;
  log?: (line: string) => void;
}

export interface RunningNarrariumServer {
  url: string;
  port: number;
  adminUrl: string;
  adminPort: number;
  data: DataDirectory;
  books: BookRegistry;
  auth: Auth;
  tunnel: CloudflareTunnelManager;
  /** AI origins the outbound network guard may reach. */
  allowedBases(): string[];
  close(): Promise<void>;
}

const SMALL_BODY = 2 * 1024 * 1024;
const LARGE_BODY = 64 * 1024 * 1024;
const MAX_STREAMS = 20;

function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = String(request.headers["content-type"] ?? "");
    if (type && !/^application\/json\b/i.test(type)) {
      reject(new HttpError(415, "unsupported_media_type", "Send JSON."));
      return;
    }
    const encoding = request.headers["content-encoding"];
    if (encoding && encoding !== "identity") {
      reject(new HttpError(415, "unsupported_encoding", "Compressed requests are not accepted."));
      return;
    }
    const declared = request.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
      reject(new HttpError(413, "payload_too_large", "The request is too large."));
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
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (unsafeKeys(parsed)) throw new Error("unsafe");
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

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Origins of the AI endpoints in a router configuration. */
function aiOrigins(config: ReturnType<typeof pickAiRuntimeConfig>): string[] {
  const origins = new Set<string>();
  for (const integration of config.aiIntegrations) {
    if (!integration.endpoint) continue;
    try {
      origins.add(new URL(integration.endpoint).origin);
    } catch {
      // A malformed endpoint simply cannot be called.
    }
  }
  return [...origins];
}

function toUpdateResult(result: UpdateResult | undefined): ServerUpdateResult | undefined {
  if (!result) return undefined;
  return { requestId: result.requestId, state: result.state, outcome: result.outcome, version: result.version, fromVersion: result.fromVersion, at: result.at, message: result.message };
}

type Handler = (context: { request: IncomingMessage; response: ServerResponse; params: string[]; url: URL; client: ClientRecord }) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  scope: ServerScope;
  handler: Handler;
}

async function listen(server: http.Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

/**
 * Start the API (127.0.0.1:24242) and the admin panel (127.0.0.1:24243) for one data folder.
 * Both listen on loopback only; remote access goes through an HTTPS tunnel such as Cloudflare.
 */
export async function startNarrariumServer(options: NarrariumServerOptions): Promise<RunningNarrariumServer> {
  const log = options.log ?? (() => undefined);
  const releaseLock = await lockDataRoot(options.dataDir, () => log("The data folder lock was lost: stopping."));
  const closers: Array<() => Promise<void> | void> = [];
  try {
    const data = await DataDirectory.open(options.dataDir, { label: options.label, origins: options.origins });
    const auth = await Auth.open(data.root, data.vault);
    const supervised = options.supervised ?? process.env[SUPERVISED_ENV] === "1";
    const checkRelease = options.checkRelease ?? ((version: string) => checkNpmServerRelease(version));
    const installer = new RuntimeInstaller({ dataRoot: data.root });
    const gitAvailable = Boolean(await gitVersion());

    const streams = new Map<ServerResponse, ClientRecord>();
    /** Close the live streams of clients whose token was revoked or replaced. */
    const dropStaleStreams = () => {
      for (const [stream, client] of streams) {
        if (auth.isCurrent(client)) continue;
        stream.end();
        streams.delete(stream);
      }
    };
    const broadcast = (message: ServerStreamMessage, id?: number) => {
      const frame = encodeServerSentEvent(message, id);
      for (const [stream, client] of streams) {
        if (stream.writableLength > 4 * 1024 * 1024 || !auth.isCurrent(client)) {
          stream.end();
          streams.delete(stream);
          continue;
        }
        stream.write(frame);
      }
    };
    const pendingBookUpdates = new Set<string>();
    let bookTimer: NodeJS.Timeout | null = null;
    const books = new BookRegistry(data, {
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
    closers.push(() => books.close());

    const tunnel = new CloudflareTunnelManager({ root: data.root, ...options.tunnel });
    closers.push(() => tunnel.close());
    // A connector problem is shown in the admin panel; it never prevents the server from starting.
    await tunnel.start().catch(() => undefined);

    const info = (nonce?: string): ServerInfo => ({
      name: SERVER_PACKAGE_NAME,
      apiVersion: SERVER_API_VERSION,
      serverVersion: SERVER_VERSION,
      engineVersion: ENGINE_VERSION,
      serverId: data.config.serverId,
      label: data.config.label,
      git: gitAvailable,
      features: ["autopilot", "director", "sync", "pairing", "updates", ...(gitAvailable ? ["github"] : [])],
      publicKey: data.publicKey,
      fingerprint: data.fingerprint,
      supervised,
      ...(nonce ? { nonce, signature: data.signIdentity(nonce) } : {}),
    });

    const aiStatus = async (): Promise<ServerAiStatus> => {
      const { config: aiConfig, updatedAt } = await data.aiConfig();
      const redacted = redactAiRuntimeConfig(aiConfig);
      const pending = aiOrigins(aiConfig).filter((origin) => !data.config.allowedAiBases.includes(origin));
      return { configured: options.ai ? true : aiConfig.aiIntegrations.length > 0, integrations: redacted.integrations, routedTasks: redacted.routedTasks, updatedAt, ...(pending.length && !options.ai ? { pendingApproval: pending } : {}) };
    };

    /** The update request still waiting for the supervisor (one it already answered is not pending). */
    const pendingRequest = async () => {
      const [request, result] = await Promise.all([installer.readUpdateRequest().catch(() => undefined), installer.readUpdateResult().catch(() => undefined)]);
      return request && result?.requestId !== request.requestId ? request : undefined;
    };

    // While an accepted update waits, watch for the supervisor giving up on it (for example when the
    // server did not stop in time): the server then accepts work again instead of staying latched.
    let maintenanceRequestId: string | undefined;
    let maintenanceTimer: NodeJS.Timeout | undefined;
    const watchMaintenance = (requestId: string) => {
      maintenanceRequestId = requestId;
      if (maintenanceTimer) return;
      maintenanceTimer = setInterval(() => {
        void installer.readUpdateResult().then((result) => {
          if (!maintenanceRequestId || result?.requestId !== maintenanceRequestId || result.state !== "failed") return;
          maintenanceRequestId = undefined;
          clearInterval(maintenanceTimer);
          maintenanceTimer = undefined;
          books.leaveMaintenance();
          log(`Update to ${result.version} not installed: ${result.message}`);
        }).catch(() => undefined);
      }, 1000);
      maintenanceTimer.unref();
    };

    const updateInfo = async (client?: ClientRecord): Promise<ServerUpdateInfo> => {
      const [release, lastUpdate, pending] = await Promise.all([
        checkRelease(SERVER_VERSION),
        installer.readUpdateResult().catch(() => undefined),
        pendingRequest(),
      ]);
      const hasUpdateScope = client ? client.scopes.includes("update") : true;
      const base: ServerUpdateInfo = {
        packageName: SERVER_PACKAGE_NAME,
        installedVersion: SERVER_VERSION,
        ...(release.latestVersion ? { latestVersion: release.latestVersion } : {}),
        available: release.available,
        canRequest: release.available && supervised && hasUpdateScope && !books.inMaintenance,
        signed: release.signed,
        supervised,
        hasUpdateScope,
        ...(release.reason ? { reason: release.reason } : {}),
        message: release.message,
        ...(toUpdateResult(lastUpdate) ? { lastUpdate: toUpdateResult(lastUpdate) } : {}),
        ...(pending ? { pending: { version: pending.version, requestedAt: pending.requestedAt } } : {}),
      };
      if (release.available && !supervised) return { ...base, reason: "no_supervisor", message: "Start the server with `npx narrarium-server start` (the supervisor) to install updates remotely." };
      if (release.available && !hasUpdateScope) return { ...base, reason: "missing_scope", message: "This client may not update the server. In the admin panel, issue it a token that also allows updates." };
      return base;
    };

    const requestUpdate = async (body: Record<string, unknown>, source: "client" | "admin") => {
      if (!supervised) throw new HttpError(409, "no_supervisor", "Remote updates need the supervisor: start the server with `npx narrarium-server start`.");
      const version = body.version;
      if (!isExactSemver(version) || body.confirmed !== true) throw new HttpError(400, "invalid_request", "Send the exact version to install and confirm it.");
      if (body.installedVersion !== undefined && body.installedVersion !== SERVER_VERSION) throw new HttpError(412, "version", "The server version changed: reload before trying again.");
      const release = await checkRelease(SERVER_VERSION);
      if (!release.available || !release.signed || release.latestVersion !== version) throw new HttpError(409, "release", "The requested version is not the latest signed and attested npm release: no update was started.");
      await books.requestUpdate(async () => {
        const previous = await pendingRequest();
        if (previous && previous.version !== version) throw new HttpError(409, "update_pending", "A different update is already waiting for the supervisor.");
        const requestId = previous?.requestId ?? randomUUID();
        if (!previous) await installer.writeUpdateRequest({ schemaVersion: 1, packageName: SERVER_PACKAGE_NAME, version, requestedAt: new Date().toISOString(), requestId, source });
        watchMaintenance(requestId);
      });
      log(`Update to ${version} requested by ${source}.`);
      return { accepted: true as const, version, message: "Update requested: the supervisor stops the server cleanly, verifies the npm package and restarts the server only after a valid installation." };
    };

    const routes: Route[] = [
      { method: "GET", pattern: /^\/api\/v1\/session$/, scope: "read", handler: async ({ client }) => ({ serverId: data.config.serverId, label: data.config.label, clientLabel: client.label, clientId: client.id, scopes: client.scopes }) },
      { method: "GET", pattern: /^\/api\/v1\/ai$/, scope: "read", handler: aiStatus },
      {
        method: "PUT", pattern: /^\/api\/v1\/ai$/, scope: "write", handler: async ({ request }) => {
          const body = asObject(await readBody(request, SMALL_BODY));
          const config = pickAiRuntimeConfig(body.config);
          await data.saveAiConfig(config);
          const unapproved = aiOrigins(config).filter((origin) => !data.config.allowedAiBases.includes(origin));
          if (unapproved.length) await data.updateConfig((next) => {
            next.pendingAiBases = [...new Set([...next.pendingAiBases, ...unapproved])].slice(-50);
          });
          return aiStatus();
        },
      },
      { method: "GET", pattern: /^\/api\/v1\/books$/, scope: "read", handler: async () => ({ books: await books.summaries() }) },
      {
        method: "PUT", pattern: /^\/api\/v1\/books\/([^/]+)$/, scope: "write", handler: async ({ request, params }) => {
          const body = asObject(await readBody(request, SMALL_BODY));
          return books.register(params[0], {
            title: String(body.title ?? ""),
            storage: body.storage as never,
            ...(body.githubToken === null || typeof body.githubToken === "string" ? { githubToken: body.githubToken as string | null } : {}),
          });
        },
      },
      {
        method: "DELETE", pattern: /^\/api\/v1\/books\/([^/]+)$/, scope: "write", handler: async ({ params }) => {
          await books.remove(params[0]);
          return { removed: true };
        },
      },
      {
        method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/manifest$/, scope: "read", handler: async ({ params }) => {
          const runtime = books.get(params[0]);
          return { revision: (await books.summary(runtime)).revision, files: await runtime.store.list() };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/files\/read$/, scope: "read", handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const paths = Array.isArray(body.paths) ? body.paths.filter((entry): entry is string => typeof entry === "string").slice(0, 2000) : [];
          const files = await Promise.all(paths.map((path) => runtime.store.read(path)));
          return { files: files.filter(Boolean) };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/files\/commit$/, scope: "write", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
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
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/sync$/, scope: "write", handler: async ({ params }) => {
          books.assertNotInMaintenance();
          return books.syncGitHub(params[0]);
        },
      },
      { method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot$/, scope: "read", handler: async ({ params }) => books.get(params[0]).session.snapshot() },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/start$/, scope: "run", handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          if (!(await books.aiConfigured())) throw new HttpError(412, "ai_not_configured", "Send your AI router configuration to the server before starting the autopilot.");
          books.assertCanStart();
          await runtime.session.start({ brief: body.brief as never, options: body.options as never, force: body.force === true });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/pause$/, scope: "run", handler: async ({ request, params }) => {
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          runtime.session.pause(body.mode === "now" ? "now" : "after-step");
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/intervene$/, scope: "run", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const scope = body.scope === "from_now" || body.scope === "rewrite" ? body.scope : "next_step";
          await runtime.session.intervene({ scope, text: String(body.text ?? "").slice(0, 8000), interrupt: body.interrupt === true });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/answer$/, scope: "run", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          await runtime.session.answer({ questionId: String(body.questionId ?? ""), answer: String(body.answer ?? "").slice(0, 8000), accept: body.accept === true });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/configure$/, scope: "write", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          await runtime.session.configure({ brief: body.brief as never, options: body.options as never });
          return runtime.session.snapshot();
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/reset$/, scope: "write", handler: async ({ params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          await runtime.session.reset();
          return runtime.session.snapshot();
        },
      },
      {
        method: "GET", pattern: /^\/api\/v1\/books\/([^/]+)\/autopilot\/events$/, scope: "read", handler: async ({ params, url }) => {
          const runtime = books.get(params[0]);
          const since = Number(url.searchParams.get("since") ?? "0");
          return { events: runtime.session.recentEvents(Number.isFinite(since) ? since : 0), lastSeq: runtime.session.lastSeq };
        },
      },
      {
        method: "POST", pattern: /^\/api\/v1\/books\/([^/]+)\/director\/ask$/, scope: "run", handler: async ({ request, params }) => {
          books.assertNotInMaintenance();
          const runtime = books.get(params[0]);
          const body = asObject(await readBody(request, SMALL_BODY));
          const controller = new AbortController();
          request.on("close", () => {
            if (!request.complete || request.destroyed) controller.abort();
          });
          return runtime.session.askDirector({ target: asTarget(body.target), question: typeof body.question === "string" ? body.question.slice(0, 4000) : undefined, save: body.save === true, signal: controller.signal });
        },
      },
      { method: "GET", pattern: /^\/api\/v1\/updates$/, scope: "read", handler: async ({ client }) => updateInfo(client) },
      { method: "POST", pattern: /^\/api\/v1\/updates$/, scope: "update", handler: async ({ request }) => requestUpdate(asObject(await readBody(request, 4096)), "client") },
    ];

    const limits = new Map<string, { window: number; count: number }>();
    const limit = (key: string, max: number) => {
      let state = limits.get(key);
      if (!state || Date.now() - state.window >= 60_000) {
        state = { window: Date.now(), count: 0 };
        limits.set(key, state);
      }
      state.count += 1;
      if (state.count > max) throw new HttpError(429, "rate_limit", "Too many requests: wait a moment and try again.");
    };
    const common = (response: ServerResponse) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
    };
    let apiPort = options.port ?? data.config.apiPort;
    let adminPort = options.adminPort ?? data.config.adminPort ?? DEFAULT_ADMIN_PORT;
    const allowedOrigins = () => new Set([...DEFAULT_ORIGINS, ...data.config.origins].map((origin) => origin.replace(/\/+$/, "")));

    const api = http.createServer((request, response) => {
      const started = Date.now();
      void (async () => {
        common(response);
        response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
        const hosts = new Set([`127.0.0.1:${apiPort}`, `localhost:${apiPort}`, `[::1]:${apiPort}`, ...(hostOf(data.config.publicUrl) ? [hostOf(data.config.publicUrl)!] : [])]);
        if (!hosts.has(String(request.headers.host ?? "").toLowerCase())) throw new HttpError(421, "host_not_allowed", "Unexpected Host header. Set the public address of the server in its admin panel (Approved network).");
        const origin = typeof request.headers.origin === "string" ? request.headers.origin.replace(/\/+$/, "") : "";
        if (origin) {
          if (!allowedOrigins().has(origin)) throw new HttpError(403, "origin_not_allowed", `The origin ${origin} is not allowed. Add it in the server's admin panel (Approved network).`);
          response.setHeader("access-control-allow-origin", origin);
          response.setHeader("vary", "Origin");
          response.setHeader("access-control-expose-headers", "etag");
        }
        if (request.method === "OPTIONS") {
          response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
          response.setHeader("access-control-allow-headers", "authorization, content-type, accept, if-match, last-event-id");
          response.setHeader("access-control-max-age", "600");
          if (request.headers["access-control-request-private-network"] === "true") response.setHeader("access-control-allow-private-network", "true");
          response.writeHead(204);
          response.end();
          return;
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && (url.pathname === "/api/v1/info" || url.pathname === "/")) {
          limit("info", 600);
          const nonce = url.searchParams.get("nonce");
          if (nonce !== null && !/^[a-f0-9]{64}$/.test(nonce)) throw new HttpError(400, "invalid_nonce", "The nonce must be 64 hexadecimal characters.");
          sendJson(response, 200, url.pathname === "/" ? { ...info(), message: "Narrarium personal server. Connect it from Narrarium → Settings → Personal server." } : info(nonce ?? undefined));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/pairings") {
          limit("pair", 30);
          const body = asObject(await readBody(request, 4096));
          const code = typeof body.code === "string" ? body.code : "";
          const nonce = typeof body.nonce === "string" ? body.nonce : "";
          const label = typeof body.label === "string" ? body.label.trim() : "";
          if (!/^\d{9}$/.test(code) || !/^[a-f0-9]{64}$/.test(nonce) || !label || label.length > 80) throw new HttpError(400, "invalid_request", "Send the nine-digit code, a nonce and a client name.");
          sendJson(response, 200, await auth.requestPairing(code, nonce, label));
          return;
        }
        const pairing = /^\/api\/v1\/pairings\/([0-9a-f-]{36})\/result$/.exec(url.pathname);
        if (request.method === "POST" && pairing) {
          limit("pair_result", 120);
          const body = asObject(await readBody(request, 4096));
          if (typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/.test(body.nonce)) throw new HttpError(400, "invalid_request", "Send the pairing nonce.");
          sendJson(response, 200, await auth.pollPairing(pairing[1], body.nonce));
          return;
        }
        const token = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization ?? ""))?.[1];
        const client = auth.authenticate(token);
        limit("authenticated", 1200);
        // Disconnecting a device revokes its own token, whatever its permissions.
        if (request.method === "DELETE" && url.pathname === "/api/v1/session") {
          await auth.revoke(client.id);
          dropStaleStreams();
          sendJson(response, 200, { revoked: true });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/v1/events") {
          auth.authenticate(token, "read");
          if (streams.size >= MAX_STREAMS) throw new HttpError(429, "too_many_streams", "Too many live connections to this server.");
          response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" });
          response.write(encodeServerSentEvent({ event: "hello", data: { serverId: data.config.serverId, at: new Date().toISOString() } }));
          streams.set(response, client);
          request.on("close", () => streams.delete(response));
          return;
        }
        for (const route of routes) {
          if (route.method !== request.method) continue;
          const match = route.pattern.exec(url.pathname);
          if (!match) continue;
          auth.authenticate(token, route.scope);
          const params = match.slice(1).map((value) => decodeURIComponent(value));
          const payload = await route.handler({ request, response, params, url, client });
          if (!auth.isCurrent(client)) throw new HttpError(401, "revoked", "This client token was revoked.");
          sendJson(response, url.pathname === "/api/v1/updates" && request.method === "POST" ? 202 : 200, payload);
          return;
        }
        throw new HttpError(404, "not_found", "Unknown endpoint.");
      })().catch((error) => {
        const { status, code, message } = errorStatus(error);
        if (status >= 500) log(`Error on ${request.method} ${request.url}: ${message}`);
        if (!response.headersSent) {
          response.setHeader("connection", "close");
          sendJson(response, status, { code, message });
        } else response.end();
      }).finally(() => {
        if (request.url !== "/api/v1/events") log(`${request.method} ${request.url} ${response.statusCode} ${Date.now() - started}ms`);
      });
    });

    const admin = http.createServer((request, response) => {
      void (async () => {
        common(response);
        response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const localOrigins = [`http://127.0.0.1:${adminPort}`, `http://localhost:${adminPort}`];
        const publicAdmin = data.config.allowRemoteAdmin ? (data.config.adminPublicUrl ?? data.config.publicUrl) : undefined;
        const publicAdminOrigin = publicAdmin ? normalizeOrigin(publicAdmin, false) : undefined;
        const adminOrigins = [...localOrigins, ...(publicAdminOrigin ? [publicAdminOrigin] : [])];
        const host = String(request.headers.host ?? "").toLowerCase();
        const remote = Boolean(publicAdminOrigin) && host === hostOf(publicAdminOrigin);
        const local = localOrigins.some((origin) => hostOf(origin) === host);
        const path = request.url ?? "/";
        const bridge = remote && /^\/api\/v1\//.test(path);
        if ((!local && !remote) || (request.headers.origin && !bridge && !adminOrigins.includes(request.headers.origin))) {
          throw new HttpError(403, "admin_origin", "The admin panel is available only from this computer or from its approved public address.");
        }
        // One public hostname can point to the admin port: the panel is served on / and /api/v1/*
        // is bridged to the loopback API, which still checks Host, Origin and the client token.
        if (bridge) {
          const upstream = httpRequest({ hostname: "127.0.0.1", port: apiPort, path, method: request.method, headers: { ...request.headers, host: hostOf(data.config.publicUrl) ?? `127.0.0.1:${apiPort}`, "x-narrarium-proxy": "admin-gateway" } }, (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          });
          upstream.on("error", () => {
            if (!response.headersSent) sendJson(response, 503, { code: "api_proxy", message: "The server API is not reachable." });
            else response.end();
          });
          upstream.setTimeout(130_000, () => upstream.destroy(new Error("timeout")));
          request.pipe(upstream);
          return;
        }
        if (request.method === "GET" && (path === "/" || path === "/admin.js" || path === "/admin.css")) {
          response.writeHead(200, { "content-type": path === "/" ? "text/html; charset=utf-8" : path === "/admin.css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
          response.end(path === "/" ? ADMIN_HTML : path === "/admin.css" ? ADMIN_CSS : ADMIN_JS);
          return;
        }
        if (request.method === "POST" && !adminOrigins.includes(header(request, "origin") ?? "")) throw new HttpError(403, "admin_csrf", "This admin request does not come from the admin panel.");
        // Cookies are shared by every port of a host: one name per admin port keeps two servers apart.
        const cookieName = `nrs_admin_${adminPort}`;
        if (path === "/admin/api/login" && request.method === "POST") {
          const body = asObject(await readBody(request, 4096));
          const session = await auth.login(typeof body.code === "string" ? body.code.trim() : "");
          const secure = header(request, "origin")?.startsWith("https://") ? "; Secure" : "";
          response.setHeader("set-cookie", `${cookieName}=${session.cookie}; HttpOnly; SameSite=Strict; Path=/admin/; Max-Age=1800${secure}`);
          sendJson(response, 200, { csrf: session.csrf });
          return;
        }
        const cookie = new RegExp(`(?:^|;\\s*)${cookieName}=([A-Za-z0-9_-]+)`).exec(header(request, "cookie") ?? "")?.[1];
        auth.adminSession(cookie, request.method === "POST" ? header(request, "x-csrf-token") ?? "" : undefined);
        const body = request.method === "POST" ? asObject(await readBody(request, 16_384)) : {};
        if (path === "/admin/api/logout" && request.method === "POST") {
          auth.logout(cookie);
          response.setHeader("set-cookie", `${cookieName}=; HttpOnly; SameSite=Strict; Path=/admin/; Max-Age=0`);
          sendJson(response, 200, { ok: true });
          return;
        }
        if (path === "/admin/api/status" && request.method === "GET") {
          const summaries = await books.summaries().catch(() => []);
          sendJson(response, 200, {
            serverId: data.config.serverId,
            label: data.config.label,
            fingerprint: data.fingerprint,
            serverVersion: SERVER_VERSION,
            engineVersion: ENGINE_VERSION,
            apiPort,
            adminPort,
            apiUrl: `http://127.0.0.1:${apiPort}`,
            dataRoot: data.root,
            supervised,
            maintenance: books.inMaintenance,
            git: gitAvailable,
            defaultOrigins: DEFAULT_ORIGINS,
            origins: data.config.origins,
            allowedAiBases: data.config.allowedAiBases,
            pendingAiBases: data.config.pendingAiBases.filter((base) => !data.config.allowedAiBases.includes(base)),
            publicUrl: data.config.publicUrl ?? "",
            adminPublicUrl: data.config.adminPublicUrl ?? "",
            allowRemoteAdmin: data.config.allowRemoteAdmin,
            tunnel: tunnel.status(),
            books: summaries.map((book) => ({ bookId: book.bookId, title: book.title, storage: book.storage.kind, running: book.running, status: book.autopilot?.status ?? null, phase: book.autopilot?.phase ?? null, error: book.error ?? null })),
            ...auth.list(),
          });
          return;
        }
        if (path === "/admin/api/admin-code/rotate" && request.method === "POST") {
          sendJson(response, 200, { code: await auth.rotateAdminCode() });
          return;
        }
        if (path === "/admin/api/admin-code/set" && request.method === "POST") {
          await auth.replaceAdminCode(typeof body.code === "string" ? body.code : "");
          sendJson(response, 200, { changed: true });
          return;
        }
        if (path === "/admin/api/token" && request.method === "POST") {
          const replaceId = typeof body.replaceId === "string" ? body.replaceId : undefined;
          sendJson(response, 200, await auth.issue(typeof body.label === "string" ? body.label : "", parseScopes(body.scopes), replaceId));
          if (replaceId) dropStaleStreams();
          return;
        }
        if (path === "/admin/api/revoke" && request.method === "POST") {
          if (typeof body.id !== "string") throw new HttpError(400, "invalid_request", "Which client?");
          sendJson(response, 200, { revoked: await auth.revoke(body.id) });
          dropStaleStreams();
          return;
        }
        if (path === "/admin/api/pairing" && request.method === "POST") {
          sendJson(response, 200, await auth.startPairing());
          return;
        }
        if (path === "/admin/api/pairing/approve" && request.method === "POST") {
          if (typeof body.id !== "string") throw new HttpError(400, "invalid_request", "Which pairing?");
          await auth.approvePairing(body.id, { allowUpdate: body.allowUpdate === true });
          sendJson(response, 200, { approved: true });
          return;
        }
        if (path === "/admin/api/pairing/cancel" && request.method === "POST") {
          await auth.cancelPairing();
          sendJson(response, 200, { cancelled: true });
          return;
        }
        if (path === "/admin/api/network" && request.method === "POST") {
          const list = (value: unknown, max: number) => (Array.isArray(value) ? value : []).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, max);
          const origins = list(body.origins, 20).map((origin) => normalizeOrigin(origin));
          const allowedAiBases = list(body.allowedAiBases, 50).map((base) => normalizeOrigin(base));
          const publicUrl = typeof body.publicUrl === "string" && body.publicUrl.trim() ? normalizeOrigin(body.publicUrl, false) : undefined;
          const adminPublicUrl = typeof body.adminPublicUrl === "string" && body.adminPublicUrl.trim() ? normalizeOrigin(body.adminPublicUrl, false) : undefined;
          await data.updateConfig((next) => {
            next.origins = [...new Set(origins)];
            next.allowedAiBases = [...new Set(allowedAiBases)];
            next.pendingAiBases = next.pendingAiBases.filter((base) => !next.allowedAiBases.includes(base));
            if (publicUrl) next.publicUrl = publicUrl;
            else delete next.publicUrl;
            if (adminPublicUrl) next.adminPublicUrl = adminPublicUrl;
            else delete next.adminPublicUrl;
            if (typeof body.allowRemoteAdmin === "boolean") next.allowRemoteAdmin = body.allowRemoteAdmin;
          });
          sendJson(response, 200, { saved: true });
          return;
        }
        if ((path === "/admin/api/ai/approve" || path === "/admin/api/ai/dismiss") && request.method === "POST") {
          const bases = (Array.isArray(body.bases) ? body.bases : []).filter((entry): entry is string => typeof entry === "string").slice(0, 50).map((base) => normalizeOrigin(base));
          await data.updateConfig((next) => {
            if (path.endsWith("approve")) next.allowedAiBases = [...new Set([...next.allowedAiBases, ...bases])].slice(0, 50);
            next.pendingAiBases = next.pendingAiBases.filter((base) => !bases.includes(base));
          });
          sendJson(response, 200, { saved: true });
          return;
        }
        if (path === "/admin/api/tunnel/configure" && request.method === "POST") {
          try {
            await tunnel.configure({ token: typeof body.token === "string" ? body.token : "", hostname: typeof body.hostname === "string" ? body.hostname : undefined });
          } catch (error) {
            throw new HttpError(422, "tunnel", error instanceof Error ? error.message : String(error));
          }
          sendJson(response, 200, await tunnel.start());
          return;
        }
        if (path === "/admin/api/tunnel/restart" && request.method === "POST") {
          sendJson(response, 200, await tunnel.restart());
          return;
        }
        if (path === "/admin/api/tunnel/remove" && request.method === "POST") {
          sendJson(response, 200, await tunnel.remove());
          return;
        }
        if (path === "/admin/api/updates" && request.method === "GET") {
          sendJson(response, 200, await updateInfo());
          return;
        }
        if (path === "/admin/api/updates" && request.method === "POST") {
          sendJson(response, 202, await requestUpdate({ ...body, confirmed: true }, "admin"));
          return;
        }
        if (path === "/admin/api/scopes" && request.method === "GET") {
          sendJson(response, 200, { scopes: ["read", "write", "run", "update"].filter(isScope) });
          return;
        }
        throw new HttpError(404, "not_found", "Unknown admin endpoint.");
      })().catch((error) => {
        const { status, code, message } = errorStatus(error);
        if (status >= 500) log(`Admin error on ${request.method} ${request.url}: ${message}`);
        if (!response.headersSent) {
          response.setHeader("connection", "close");
          sendJson(response, status, { code, message });
        } else response.end();
      });
    });

    for (const server of [api, admin]) {
      server.requestTimeout = 0;
      server.headersTimeout = 20_000;
      server.keepAliveTimeout = 5_000;
      server.maxHeadersCount = 60;
      server.maxConnections = 256;
    }
    try {
      apiPort = await listen(api, apiPort);
      adminPort = await listen(admin, adminPort);
    } catch (error) {
      api.close();
      admin.close();
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(code === "EADDRINUSE" ? `Port ${apiPort} or ${adminPort} is already in use: is another narrarium-server running? Change the ports with --port and --admin-port.` : `The server could not listen: ${error instanceof Error ? error.message : String(error)}`);
    }
    const heartbeat = setInterval(() => broadcast({ event: "heartbeat", data: { at: new Date().toISOString() } }), 15_000);
    heartbeat.unref();

    let closed = false;
    return {
      url: `http://127.0.0.1:${apiPort}`,
      port: apiPort,
      adminUrl: `http://127.0.0.1:${adminPort}`,
      adminPort,
      data,
      books,
      auth,
      tunnel,
      allowedBases: () => [...data.config.allowedAiBases],
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (maintenanceTimer) clearInterval(maintenanceTimer);
        if (bookTimer) clearTimeout(bookTimer);
        for (const stream of streams.keys()) stream.end();
        for (const close of closers.reverse()) await close();
        await Promise.all([api, admin].map((server) => new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        })));
        await releaseLock();
      },
    };
  } catch (error) {
    for (const close of closers.reverse()) await Promise.resolve(close()).catch(() => undefined);
    await releaseLock();
    throw error;
  }
}
