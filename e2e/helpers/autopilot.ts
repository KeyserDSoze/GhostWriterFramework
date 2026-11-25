import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type BrowserContext, type Page } from "@playwright/test";

// What the specs of the autopilot share: an OpenAI-compatible provider that answers every schema of the autopilot with the engine's own fake (whole,
// `streamMode: "off"`), the signed-in local workspace with books of this browser, and what the book's local repository says of its autopilot.

// The engine's build is ESM only: it is loaded by Node itself, not through the transform that Playwright gives the specs.
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
export const engineModule = (path: string) => nativeImport(pathToFileURL(resolve(__dirname, "../../packages/engine/dist", path)).href);

export const WORKSPACE_ID = "e2e-workspace";
export const ACCOUNT_IDENTITY = `workspace:${WORKSPACE_ID}`;
export const KEY = "e2e-plain-key-9f8a7b6c5d4e";

/** One request that reached a provider: who got it, the model the request names, the function (or `prose`) it asked for, and the thinking level it carried (`reasoning_effort`), when it carried one. */
export interface StubCall {
  provider: string;
  model: string;
  tool: string;
  thinking?: string;
}

/**
 * How a provider answers: whole (after `delayMs`), with an HTTP error at once (with the `type` of the error, `invalid_request_error` unless it says another, and its `param` and `code` when it has them),
 * only after `ms` (a provider that is too slow to be waited for), or as a model that refuses a thinking level because the request carries function tools (a 400, as the provider of `gpt-6-luna` does) and answers
 * every other request. `accepts` says what a request with function tools must carry to be taken, as the documentation of Azure OpenAI says of the families: `omit` (gpt-5.6-sol) the level left out, or none; `none`
 * (gpt-6-luna) none only; `nothing` (gpt-6.2-sol) nothing: it takes function tools on the Responses API only, and refuses none for its value.
 */
export type StubBehavior = { kind: "ok" } | { kind: "error"; status: number; message: string; type?: string; param?: string; code?: string } | { kind: "slow"; ms: number } | { kind: "refuse-thinking-with-tools"; accepts?: "omit" | "none" | "nothing" };

export interface StubProvider {
  server: Server;
  url: string;
  /** How many requests arrived, and the function (or `prose`) each asked for. */
  readonly requests: number;
  readonly asked: string[];
  /** Every request that arrived, in order. */
  readonly calls: StubCall[];
  /** Milliseconds every answer waits before it is sent: the time a step takes. */
  delayMs: number;
  /** How it answers from now on. */
  behavior: StubBehavior;
  close(): Promise<void>;
}

/**
 * An OpenAI-compatible provider that answers every autopilot schema with the engine's own fake, `delayMs` after the request arrives. With `name` and a shared
 * `timeline`, the requests of several providers are put in one list in the order they arrived: what a routing spec reads to say which provider was asked first.
 */
export async function startProvider(options: { delayMs?: number; chapters?: number; scenes?: number; words?: number; name?: string; timeline?: StubCall[]; behavior?: StubBehavior } = {}): Promise<StubProvider> {
  const { createFakeAutopilotAi } = await engineModule("testing/index.js");
  const fake = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: options.scenes ?? 1, words: options.words ?? 120, chapters: options.chapters ?? 1 });
  const asked: string[] = [];
  const calls: StubCall[] = [];
  const state = { delayMs: options.delayMs ?? 0, behavior: options.behavior ?? ({ kind: "ok" } as StubBehavior) };
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "*");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [] })); return; }
    let raw = "";
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw) as { model?: string; reasoning_effort?: string; messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
    const text = (content: unknown) => (typeof content === "string" ? content : "");
    const system = text(body.messages?.find((message) => message.role === "system")?.content);
    const user = text([...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content);
    const tool = body.tools?.[0]?.function;
    asked.push(tool?.name ?? "prose");
    const call: StubCall = { provider: options.name ?? "stub", model: body.model ?? "", tool: tool?.name ?? "prose", ...(body.reasoning_effort ? { thinking: body.reasoning_effort } : {}) };
    calls.push(call);
    options.timeline?.push(call);
    if (state.behavior.kind === "error") {
      response.writeHead(state.behavior.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: state.behavior.message, type: state.behavior.type ?? "invalid_request_error", ...(state.behavior.param ? { param: state.behavior.param } : {}), ...(state.behavior.code ? { code: state.behavior.code } : {}) } }));
      return;
    }
    if (state.behavior.kind === "refuse-thinking-with-tools" && tool) {
      const accepts = state.behavior.accepts ?? "omit";
      const level = body.reasoning_effort;
      const takes = accepts === "omit" ? !level || level === "none" : accepts === "none" ? level === "none" : false;
      if (!takes) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: accepts === "nothing" && level === "none"
          ? { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" }
          : { message: `Function tools with reasoning_effort are not supported for ${body.model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`, type: "invalid_request_error", param: "reasoning_effort", code: null } }));
        return;
      }
    }
    const wait = state.behavior.kind === "slow" ? state.behavior.ms : state.delayMs;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const answer = await fake.complete({ system, user, label: "e2e", ...(tool ? { json: { name: tool.name } } : {}) } as never);
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "cmpl-1", object: "chat.completion", model: "fake-model", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message: tool ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(answer.json) } }] } : { role: "assistant", content: answer.text } }] }));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    get requests() { return asked.length; },
    asked,
    calls,
    get delayMs() { return state.delayMs; },
    set delayMs(value: number) { state.delayMs = value; },
    get behavior() { return state.behavior; },
    set behavior(value: StubBehavior) { state.behavior = value; },
    close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
  };
}

/** The files of a book with an outline of `chapters` chapters and the brief the autopilot starts from. */
export async function bookFiles(idea: string, chapters = 1): Promise<Record<string, string>> {
  const { writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters }));
  await writeOutlineBrief(store, { idea, genre: "mystery", audience: "adults", wordsPerScene: 200, synopsis: "A glassmaker's daughter finds the lie." });
  return store.toObject();
}

export interface SeedBook {
  id: string;
  /** The id of its local repository. */
  repo: string;
  name: string;
  files: Record<string, string>;
}

/** The tasks of the text router: what a model has to be tagged with to be asked for one, and the rows of its table. */
export const TEXT_TASKS = ["default", "editor-actions", "copilot", "simple-tasks", "review", "chat-resume", "reader-evaluation", "reader-evaluation-summary", "rewrite-from-reader-feedback", "deep-research", "create-from-research", "audit", "autopilot", "director"];

const libraryOf = (books: readonly SeedBook[]) => ({
  ui: { language: "en", theme: "light" },
  repository: { autoFetchOnOpen: false, autoFetchIntervalMinutes: 0, autoPullWhenClean: false },
  books: books.map((book) => ({ id: book.id, storageMode: "local-only", localRepositoryId: book.repo, owner: "", repo: "", name: book.name, tokenIndex: null, activeBranch: `local:${book.repo}`, addedAt: "2026-11-20T00:00:00.000Z" })),
});

export function settingsOf(providerUrl: string, books: readonly SeedBook[]) {
  return {
    ...libraryOf(books),
    aiIntegrations: [{ id: "fake-ai", name: "Fake AI", provider: "openai", endpoint: providerUrl, apiKey: KEY, streamMode: "off", chatModels: [{ id: "fake-model", name: "fake-model", capabilities: TEXT_TASKS, supportsToolCalls: true, supportsStreaming: false }] }],
  };
}

/** An integration of a routing spec: one OpenAI-compatible endpoint (a stub provider) with one model that every text task may use. */
export interface RoutedIntegration {
  id: string;
  name: string;
  model: string;
  url: string;
  /** The context window of its model, in tokens: absent, the model has none declared. */
  window?: number;
  /** The thinking level of the integration (`low`, `medium`, `high`, `xhigh` or `automatic`): absent, none is chosen. */
  thinking?: string;
}

/**
 * Two integrations and a route for every text task: the primary (`first`) and its one fallback (`second`), the way the Router writes them.
 * `maxTotalDurationMs` is the routing time a fallback has (the Router's «Maximum total duration»), and `extra` is merged into the settings.
 */
export function routedSettingsOf(first: RoutedIntegration, second: RoutedIntegration, books: readonly SeedBook[], options: { maxTotalDurationMs?: number; extra?: Record<string, unknown> } = {}) {
  const integration = (entry: RoutedIntegration) => ({
    id: entry.id,
    name: entry.name,
    provider: "openai",
    endpoint: entry.url,
    apiKey: KEY,
    streamMode: "off",
    ...(entry.thinking ? { thinking: entry.thinking } : {}),
    chatModels: [{ id: entry.model, name: entry.model, capabilities: TEXT_TASKS, supportsToolCalls: true, supportsStreaming: false, ...(entry.window ? { maxInputTokens: entry.window } : {}) }],
  });
  const target = (entry: RoutedIntegration) => ({ integrationId: entry.id, model: entry.model });
  return {
    ...libraryOf(books),
    aiIntegrations: [integration(first), integration(second)],
    taskRouting: Object.fromEntries(TEXT_TASKS.map((task) => [task, { primary: target(first), fallbacks: [target(second)] }])),
    routingExecution: { maxCandidates: 4, maxTotalDurationMs: options.maxTotalDurationMs ?? 180_000, maxTokenAttempts: 200_000, maxEstimatedCost: 5 },
    ...(options.extra ?? {}),
  };
}

/**
 * The signed-in local workspace, its settings, and the books of this browser in their local repositories, before the app starts; the Google reads
 * the settings load with. A request to the real OpenAI (the integration without its endpoint) fails the spec where it happens, with that reason.
 */
export async function seed(target: Page | BrowserContext, settings: ReturnType<typeof settingsOf> | ReturnType<typeof routedSettingsOf>, books: readonly SeedBook[], options: { recordingOff?: string[]; marker?: string } = {}): Promise<{ openAi: string[] }> {
  const openAi: string[] = [];
  await target.route("https://api.openai.com/**", (route) => { openAi.push(route.request().url()); return route.fulfill({ status: 599, json: { error: { message: "The spec's integration has no endpoint: the request went to api.openai.com." } } }); });
  await target.route("https://www.googleapis.com/**", async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q") ?? "";
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === "/oauth2/v3/userinfo") return json({ sub: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" });
    if (url.pathname === "/drive/v3/about") return json({ user: { permissionId: "e2e-google-user", emailAddress: "e2e@example.test" } });
    if (url.pathname === "/drive/v3/files/root") return json({ id: "e2e-root" });
    if (url.pathname === "/drive/v3/files" && q.includes("mimeType=")) return json({ files: [{ id: "e2e-folder", name: "Narrarium", createdTime: "2024-01-01T00:00:00.000Z", mimeType: "application/vnd.google-apps.folder", parents: ["e2e-root"], ownedByMe: true, trashed: false, appProperties: { narrariumAppFolder: "v1" } }] });
    if (url.pathname === "/drive/v3/files" && q.includes("settings.json")) return json({ files: [{ id: "e2e-settings", name: "settings.json", parents: ["e2e-folder"], trashed: false, ownedByMe: true, mimeType: "application/json", createdTime: "2024-01-01T00:00:00.000Z" }] });
    if (url.pathname === "/drive/v3/files/e2e-settings" && url.searchParams.has("alt")) return json({ version: 2, defaultGitHubToken: "", extraGitHubTokens: [], ...settings });
    if (url.pathname === "/drive/v3/files/e2e-settings") return json({ id: "e2e-settings", name: "settings.json", parents: ["e2e-folder"], trashed: false, ownedByMe: true, mimeType: "application/json", version: "1", modifiedTime: "2024-01-01T00:00:00.000Z" });
    if (url.pathname === "/drive/v3/files/e2e-folder" && route.request().method() === "PATCH") return json({ id: "e2e-folder" });
    if (url.pathname === "/drive/v3/files" && (q.includes("costs.json") || q.includes("clipboard.json"))) return json({ files: [] });
    if (url.pathname === "/drive/v3/files" && q.includes("'e2e-folder' in parents")) return json({ files: [], nextPageToken: null });
    return route.fulfill({ status: 500, json: { error: `Unexpected Google request in the autopilot specs: ${url.pathname}` } });
  });
  await target.addInitScript(({ settings, books, accountIdentity, workspaceId, recordingOff, marker }) => {
    const target = window as unknown as { __seedReady?: Promise<void> };
    if (window.localStorage.getItem(marker)) { target.__seedReady = Promise.resolve(); return; }
    const now = Date.now();
    const user = { provider: "google", providerAccountId: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" };
    window.localStorage.setItem(marker, "1");
    window.localStorage.setItem("narrarium-local-workspace-id-v1", workspaceId);
    window.localStorage.setItem("narrarium-account-scope-v1", accountIdentity);
    window.localStorage.setItem("narrarium-install-dismissed", "1");
    if (recordingOff.length) window.localStorage.setItem("narrarium.aiCalls.recording.v1", JSON.stringify(recordingOff));
    const keyOf = encodeURIComponent(`${user.provider}:${user.providerAccountId}`);
    window.localStorage.setItem(`narrarium-settings-cache-v2:${keyOf}`, JSON.stringify({ schemaVersion: 2, accountScope: `${user.provider}:${user.providerAccountId}`, baseRevision: "1", base: settings }));
    window.sessionStorage.setItem(`narrarium-settings-credentials-v1:${keyOf}`, JSON.stringify({ defaultGitHubToken: "", extraGitHubTokens: [], azureOpenAIApiKey: "", integrationApiKeys: Object.fromEntries(settings.aiIntegrations.map((entry) => [entry.id, entry.apiKey])), deepSearchApiKeys: { braveApiKey: "", tavilyApiKey: "" }, bookTokens: {} }));
    window.localStorage.setItem("narrarium-account-continuity-v1", JSON.stringify({ version: 1, accounts: { google: { version: 1, provider: "google", providerAccountId: user.providerAccountId, normalizedEmail: user.email, displayName: user.name, picture: user.picture, createdAt: 1704067200000, lastSeen: now } } }));
    window.sessionStorage.setItem("narrarium-auth-session-v1", JSON.stringify({ version: 1, state: { accessToken: "e2e-google-token", accessTokenExpiry: now + 3_600_000, provider: user.provider, providerAccountId: user.providerAccountId } }));

    async function sha256(value: string): Promise<string> {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    function openDatabase(): Promise<IDBDatabase> {
      return new Promise((resolveOpen, reject) => {
        const request = indexedDB.open("narrarium-local-repositories", 12);
        request.onupgradeneeded = () => {
          const db = request.result;
          const ensureIndex = (store: IDBObjectStore, name: string, keyPath: string | string[]) => { if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false }); };
          const open = (name: string, storeOptions: IDBObjectStoreParameters) => (db.objectStoreNames.contains(name) ? request.transaction!.objectStore(name) : db.createObjectStore(name, storeOptions));
          const repositories = open("repositories", { keyPath: "id" });
          ensureIndex(repositories, "bookId", "bookId");
          ensureIndex(repositories, "remote", ["owner", "repo", "branch"]);
          const filesStore = open("files", { keyPath: "key" });
          ensureIndex(filesStore, "repoId", "repoId");
          ensureIndex(filesStore, "repoStatus", ["repoId", "status"]);
          for (const name of ["commits", "logs", "recoveries"]) ensureIndex(open(name, { keyPath: "id" }), "repoId", "repoId");
          for (const name of ["migrationJournals", "maintenanceFences", "removalJournals", "consumedBackupReceipts", "maintenanceTombstones", "maintenanceCompletions"]) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === "migrationJournals" ? "id" : name === "consumedBackupReceipts" ? "receiptId" : "repoId" });
          }
        };
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    target.__seedReady = (async () => {
      const db = await openDatabase();
      const rows: Array<{ book: typeof books[number]; branch: string; repositoryId: string; prepared: Array<Record<string, unknown>> }> = [];
      for (const book of books) {
        const branch = `local:${book.repo}`;
        const repositoryId = `${accountIdentity}::${branch}`;
        const prepared = await Promise.all(Object.entries(book.files).map(async ([path, content], index) => {
          const hash = await sha256(content);
          return { key: `${repositoryId}::${path}`, repoId: repositoryId, path, kind: "text", text: content, baseSha: `blob-${index}`, baseHash: hash, currentHash: hash, status: "clean", committed: false, size: new TextEncoder().encode(content).byteLength, updatedAt: "2026-11-20T00:00:00.000Z" };
        }));
        rows.push({ book, branch, repositoryId, prepared });
      }
      await new Promise<void>((done, reject) => {
        const names = [...db.objectStoreNames];
        const transaction = db.transaction(names, "readwrite");
        for (const name of names) transaction.objectStore(name).clear();
        for (const { book, branch, repositoryId, prepared } of rows) {
          transaction.objectStore("repositories").put({ id: repositoryId, localInstanceId: "e2e-local-instance", bookId: book.id, repositoryKind: "book", remoteKind: "none", localRepositoryId: book.repo, owner: "", repo: "", branch, defaultBranch: branch, remoteHeadSha: "local:e2e-seed", clonedAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", cloneComplete: true, cloneStatus: "complete", expectedFileCount: prepared.length, nextCommitOrder: 0, accountScope: accountIdentity, operationFence: 0 });
          for (const file of prepared) transaction.objectStore("files").put(file);
        }
        transaction.oncomplete = () => done();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("E2E IndexedDB seed aborted"));
      });
      db.close();
    })();
  }, { settings, books, accountIdentity: ACCOUNT_IDENTITY, workspaceId: WORKSPACE_ID, recordingOff: options.recordingOff ?? [], marker: options.marker ?? "narrarium-e2e-autopilot-seeded-v1" });
  return { openAi };
}

/** The page is the app with the seed in place. */
export async function openApp(page: Page): Promise<void> {
  await page.goto(".", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => (window as unknown as { __seedReady: Promise<void> }).__seedReady);
}

export interface AutopilotFacts {
  status: string;
  phase: string;
  lastError: unknown;
  /** The steps of the log, `task:status`, oldest first. */
  steps: string[];
  /** The steps that succeeded, as `task:chapter:scene`. */
  done: string[];
}

/** What the book's local repository says of its autopilot: its state and the log of its steps. */
export const autopilotFacts = (page: Page, repo: string) => page.evaluate((repo) => new Promise<AutopilotFacts | null>((resolveFacts) => {
  const open = indexedDB.open("narrarium-local-repositories");
  open.onsuccess = () => {
    const db = open.result;
    const all = db.transaction("files", "readonly").objectStore("files").getAll();
    all.onsuccess = () => {
      const files = (all.result as Array<{ repoId: string; path: string; text: string }>).filter((entry) => entry.repoId.endsWith(`::local:${repo}`));
      db.close();
      try {
        const state = JSON.parse(files.find((entry) => entry.path === "autopilot/state.json")?.text ?? "null") as { status: string; phase: string; lastError?: unknown } | null;
        const log = JSON.parse(files.find((entry) => entry.path === "autopilot/activity.json")?.text ?? "{\"activities\":[]}") as { activities: Array<{ task: string; status: string; chapterNumber?: number; sceneNumber?: number }> };
        resolveFacts(state ? {
          status: state.status,
          phase: state.phase,
          lastError: state.lastError ?? null,
          steps: log.activities.map((entry) => `${entry.task}:${entry.status}`),
          done: log.activities.filter((entry) => entry.status === "succeeded").map((entry) => `${entry.task}:${entry.chapterNumber ?? ""}:${entry.sceneNumber ?? ""}`),
        } : null);
      } catch { resolveFacts(null); }
    };
    all.onerror = () => { db.close(); resolveFacts(null); };
  };
  open.onerror = () => resolveFacts(null);
}), repo).catch(() => null);

/** The files of a book's local repository under a folder, with their text. */
export const filesUnder = (page: Page, repo: string, prefix: string) => page.evaluate(({ repo, prefix }) => new Promise<Array<{ path: string; text: string }>>((resolveFiles) => {
  const open = indexedDB.open("narrarium-local-repositories");
  open.onsuccess = () => {
    const db = open.result;
    const all = db.transaction("files", "readonly").objectStore("files").getAll();
    all.onsuccess = () => {
      db.close();
      resolveFiles((all.result as Array<{ repoId: string; path: string; text: string; status?: string }>).filter((entry) => entry.repoId.endsWith(`::local:${repo}`) && entry.path.startsWith(prefix) && entry.status !== "deleted").map((entry) => ({ path: entry.path, text: entry.text })));
    };
  };
}), { repo, prefix });

/**
 * Waits for the autopilot of a book to reach one of `statuses`, and fails with what the state says (its status, its last error and its steps) when it
 * does not: a run that ends in error says why in the failure itself.
 */
export async function waitForAutopilot(page: Page, repo: string, statuses: string[], timeout = 60_000): Promise<AutopilotFacts> {
  const started = Date.now();
  let facts: AutopilotFacts | null = null;
  while (Date.now() - started < timeout) {
    facts = await autopilotFacts(page, repo);
    if (facts && statuses.includes(facts.status)) return facts;
    if (facts?.status === "error" && !statuses.includes("error")) break;
    await page.waitForTimeout(200);
  }
  throw new Error(`The autopilot of ${repo} did not reach ${statuses.join(" or ")}: ${JSON.stringify(facts)}`);
}

/**
 * The settings of the account are in the app with the AI integration's endpoint (they come from the account's store, which the cloud copy fills):
 * a run started before would send its first request to the default endpoint of the provider.
 */
export async function waitForAiSettings(page: Page, providerUrl: string): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((entry) => entry.name === "narrarium-local-account")) return null;
    return new Promise<string | null>((resolveEndpoint) => {
      const open = indexedDB.open("narrarium-local-account");
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("core")) { db.close(); resolveEndpoint(null); return; }
        const get = db.transaction("core", "readonly").objectStore("core").getAll();
        get.onsuccess = () => { db.close(); resolveEndpoint((get.result[0]?.settings?.aiIntegrations ?? [])[0]?.endpoint ?? null); };
        get.onerror = () => { db.close(); resolveEndpoint(null); };
      };
      open.onerror = () => resolveEndpoint(null);
    });
  }).catch(() => null), { timeout: 20_000, message: "The settings of the account never had the AI integration's endpoint" }).toBe(providerUrl);
}

/** Turns off what the specs do not need (readers, specialists, the pause after the plan) and starts the autopilot of the book from its configuration. */
export async function startAutopilot(page: Page, bookId: string): Promise<void> {
  await page.goto(`app/books/${bookId}/autopilot/settings`, { waitUntil: "domcontentloaded" });
  await page.locator("#autopilot-tab-review").click();
  for (const name of [/Simulated readers read every chapter/, /Simulated readers react to the plan/, /Specialists check continuity/, /Pause when the plan is ready/]) {
    const toggle = page.getByRole("switch", { name });
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
  }
  await page.getByRole("button", { name: "Start autopilot" }).click();
}
