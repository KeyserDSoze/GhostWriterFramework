import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// The engine's build is ESM only: it is loaded by Node itself, not through the transform that Playwright gives the specs.
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const engineModule = (path: string) => nativeImport(pathToFileURL(resolve(__dirname, "../packages/engine/dist", path)).href);

// A book of this browser runs one step against a fake AI provider: the browser's AI call store (IndexedDB `narrarium-ai-calls`) holds what was sent and what came back, the step opens
// with its messages from #task-<id> and survives a reload, no record keeps the key of the integration, and with the recording turned off for the book on this device nothing is kept
// and the page says so. The provider answers whole (`streamMode: "off"`) to keep the checks short; the streaming view and the records of a personal server are not part of this suite.

test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

const WORKSPACE_ID = "e2e-workspace";
const ACCOUNT_IDENTITY = `workspace:${WORKSPACE_ID}`;
const BOOK_ID = "book-calls";
const LOCAL_REPOSITORY_ID = "e2e-local-calls";
const KEY = "e2e-plain-key-9f8a7b6c5d4e";
const IDEA = `A harbor town built on glass hides a lie that the tide will tell (the ledger key is ${KEY}).`;

let ai: { server: Server; url: string; requests: number };

/** An OpenAI-compatible provider that answers every autopilot schema with the engine's own fake (no streaming: the integration says `streamMode: "off"`). */
async function startProvider(): Promise<typeof ai> {
  const { createFakeAutopilotAi } = await engineModule("testing/index.js");
  const fake = createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 120, chapters: 1 });
  const state = { requests: 0 };
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "*");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [] })); return; }
    let raw = "";
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
    const text = (content: unknown) => (typeof content === "string" ? content : "");
    const system = text(body.messages?.find((message) => message.role === "system")?.content);
    const user = text([...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content);
    const tool = body.tools?.[0]?.function;
    state.requests += 1;
    const answer = await fake.complete({ system, user, label: "e2e", ...(tool ? { json: { name: tool.name } } : {}) } as never);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "cmpl-1", object: "chat.completion", model: "fake-model", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message: tool ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(answer.json) } }] } : { role: "assistant", content: answer.text } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, get requests() { return state.requests; } };
}

async function bookFiles(): Promise<Record<string, string>> {
  const { writeOutlineBrief } = await engineModule("index.js");
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200, synopsis: "A glassmaker's daughter finds the lie." });
  return store.toObject();
}

function settingsOf(providerUrl: string) {
  const capabilities = ["default", "editor-actions", "copilot", "simple-tasks", "review", "chat-resume", "reader-evaluation", "reader-evaluation-summary", "rewrite-from-reader-feedback", "deep-research", "create-from-research", "audit", "autopilot", "director"];
  return {
    ui: { language: "en", theme: "light" },
    repository: { autoFetchOnOpen: false, autoFetchIntervalMinutes: 0, autoPullWhenClean: false },
    books: [{ id: BOOK_ID, storageMode: "local-only", localRepositoryId: LOCAL_REPOSITORY_ID, owner: "", repo: "", name: "The Glass Harbor", tokenIndex: null, activeBranch: `local:${LOCAL_REPOSITORY_ID}`, addedAt: "2026-11-20T00:00:00.000Z" }],
    aiIntegrations: [{ id: "fake-ai", name: "Fake AI", provider: "openai", endpoint: providerUrl, apiKey: KEY, streamMode: "off", chatModels: [{ id: "fake-model", name: "fake-model", capabilities, supportsToolCalls: true, supportsStreaming: false }] }],
  };
}

/** The signed-in local workspace, its settings, and the book of this browser in the local repository, before the app starts; the Google reads the settings load with. */
async function seed(page: Page, settings: ReturnType<typeof settingsOf>, files: Record<string, string>, recordingOff = false): Promise<void> {
  await page.route("https://www.googleapis.com/**", async (route) => {
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
    return route.fulfill({ status: 500, json: { error: `Unexpected Google request in the AI calls check: ${url.pathname}` } });
  });
  await page.addInitScript(({ settings, files, accountIdentity, workspaceId, bookId, localRepositoryId, recordingOff }) => {
    const marker = "narrarium-e2e-ai-calls-seeded-v1";
    const target = window as unknown as { __seedReady?: Promise<void> };
    if (window.localStorage.getItem(marker)) { target.__seedReady = Promise.resolve(); return; }
    const now = Date.now();
    const user = { provider: "google", providerAccountId: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" };
    window.localStorage.setItem(marker, "1");
    window.localStorage.setItem("narrarium-local-workspace-id-v1", workspaceId);
    window.localStorage.setItem("narrarium-account-scope-v1", accountIdentity);
    if (recordingOff) window.localStorage.setItem("narrarium.aiCalls.recording.v1", JSON.stringify([bookId]));
    const keyOf = encodeURIComponent(`${user.provider}:${user.providerAccountId}`);
    window.localStorage.setItem(`narrarium-settings-cache-v2:${keyOf}`, JSON.stringify({ schemaVersion: 2, accountScope: `${user.provider}:${user.providerAccountId}`, baseRevision: "1", base: settings }));
    window.sessionStorage.setItem(`narrarium-settings-credentials-v1:${keyOf}`, JSON.stringify({ defaultGitHubToken: "", extraGitHubTokens: [], azureOpenAIApiKey: "", integrationApiKeys: { "fake-ai": settings.aiIntegrations[0].apiKey }, deepSearchApiKeys: { braveApiKey: "", tavilyApiKey: "" }, bookTokens: {} }));
    window.localStorage.setItem("narrarium-account-continuity-v1", JSON.stringify({ version: 1, accounts: { google: { version: 1, provider: "google", providerAccountId: user.providerAccountId, normalizedEmail: user.email, displayName: user.name, picture: user.picture, createdAt: 1704067200000, lastSeen: now } } }));
    window.sessionStorage.setItem("narrarium-auth-session-v1", JSON.stringify({ version: 1, state: { accessToken: "e2e-google-token", accessTokenExpiry: now + 3_600_000, provider: user.provider, providerAccountId: user.providerAccountId } }));

    async function sha256(value: string): Promise<string> {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    function openDatabase(): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("narrarium-local-repositories", 12);
        request.onupgradeneeded = () => {
          const db = request.result;
          const ensureIndex = (store: IDBObjectStore, name: string, keyPath: string | string[]) => { if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false }); };
          const open = (name: string, options: IDBObjectStoreParameters) => (db.objectStoreNames.contains(name) ? request.transaction!.objectStore(name) : db.createObjectStore(name, options));
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
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    target.__seedReady = (async () => {
      const branch = `local:${localRepositoryId}`;
      const repositoryId = `${accountIdentity}::${branch}`;
      const db = await openDatabase();
      const prepared = await Promise.all(Object.entries(files).map(async ([path, content], index) => {
        const hash = await sha256(content);
        return { key: `${repositoryId}::${path}`, repoId: repositoryId, path, kind: "text", text: content, baseSha: `blob-${index}`, baseHash: hash, currentHash: hash, status: "clean", committed: false, size: new TextEncoder().encode(content).byteLength, updatedAt: "2026-11-20T00:00:00.000Z" };
      }));
      await new Promise<void>((resolve, reject) => {
        const names = [...db.objectStoreNames];
        const transaction = db.transaction(names, "readwrite");
        for (const name of names) transaction.objectStore(name).clear();
        transaction.objectStore("repositories").put({ id: repositoryId, localInstanceId: "e2e-local-instance", bookId, repositoryKind: "book", remoteKind: "none", localRepositoryId, owner: "", repo: "", branch, defaultBranch: branch, remoteHeadSha: "local:e2e-seed", clonedAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", cloneComplete: true, cloneStatus: "complete", expectedFileCount: prepared.length, nextCommitOrder: 0, accountScope: accountIdentity, operationFence: 0 });
        for (const file of prepared) transaction.objectStore("files").put(file);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("E2E IndexedDB seed aborted"));
      });
      db.close();
    })();
  }, { settings, files, accountIdentity: ACCOUNT_IDENTITY, workspaceId: WORKSPACE_ID, bookId: BOOK_ID, localRepositoryId: LOCAL_REPOSITORY_ID, recordingOff });
}

/** The state of the book's autopilot, read from its local repository. */
const autopilotStatus = (page: Page) => page.evaluate(() => new Promise<string | null>((resolve) => {
  const open = indexedDB.open("narrarium-local-repositories");
  open.onsuccess = () => {
    const db = open.result;
    const all = db.transaction("files", "readonly").objectStore("files").getAll();
    all.onsuccess = () => {
      const file = (all.result as Array<{ path: string; text: string }>).find((entry) => entry.path === "autopilot/state.json");
      db.close();
      try { resolve(file ? (JSON.parse(file.text) as { status: string }).status : null); } catch { resolve(null); }
    };
    all.onerror = () => { db.close(); resolve(null); };
  };
  open.onerror = () => resolve(null);
}));

/** What the browser's AI call store holds: how many tasks, and every text (decompressed) with its field. */
const storeOf = (page: Page) => page.evaluate(async () => {
  const names = (await indexedDB.databases()).map((entry) => entry.name);
  if (!names.includes("narrarium-ai-calls")) return { database: false, tasks: 0, texts: [] as Array<{ field: string; text: string }> };
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("narrarium-ai-calls"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const all = (name: string) => new Promise<any[]>((resolve, reject) => { const request = db.transaction(name, "readonly").objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const [tasks, rows] = await Promise.all([all("tasks"), all("texts")]);
  const texts: Array<{ field: string; text: string }> = [];
  for (const row of rows) {
    const bytes = row.encoding === "plain" ? new Blob([row.data]).stream() : new Blob([row.data]).stream().pipeThrough(new DecompressionStream("gzip"));
    texts.push({ field: row.field, text: new TextDecoder().decode(await new Response(bytes).arrayBuffer()) });
  }
  db.close();
  return { database: true, tasks: tasks.filter((task) => task.listed === 1).length, texts };
});

/** Configures nothing but the first step: no readers, no specialists, no pause after the plan; starts the autopilot and pauses it after the step that runs. */
async function runOneStep(page: Page): Promise<void> {
  await page.goto("app/books/book-calls/autopilot/settings", { waitUntil: "domcontentloaded" });
  await page.locator("#autopilot-tab-review").click();
  for (const name of [/Simulated readers read every chapter/, /Simulated readers react to the plan/, /Specialists check continuity/, /Pause when the plan is ready/]) {
    const toggle = page.getByRole("switch", { name });
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
  }
  await page.getByRole("button", { name: "Start autopilot" }).click();
  // The runtime lives in the document: the page is left by the app's own links, not by a new document.
  const pause = page.getByRole("button", { name: /^Pause after this step/ }).first();
  if (!(await pause.isVisible().catch(() => false))) await page.getByRole("link", { name: "Live" }).first().click();
  await pause.click();
  await expect.poll(() => autopilotStatus(page), { timeout: 60_000 }).toBe("paused");
}

test.beforeAll(async () => { ai = await startProvider(); });
test.afterAll(async () => { await new Promise<void>((resolve) => { ai.server.closeAllConnections(); ai.server.close(() => resolve()); }); });

test("a step run in this browser is recorded in the browser's store and opens with its messages", async ({ page }) => {
  await seed(page, settingsOf(ai.url), await bookFiles());
  await page.goto(".", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => (window as unknown as { __seedReady: Promise<void> }).__seedReady);
  await runOneStep(page);
  expect(ai.requests).toBeGreaterThan(0);

  const kept = await storeOf(page);
  expect(kept.tasks).toBeGreaterThanOrEqual(1);
  for (const field of ["system", "user", "response"]) expect(kept.texts.some((entry) => entry.field === field && entry.text.length > 20), field).toBe(true);
  expect(kept.texts.some((entry) => entry.text.includes(KEY)), "no record keeps the key of the integration").toBe(false);
  expect(kept.texts.some((entry) => entry.text.includes("[redacted]")), "the place the key was in says so").toBe(true);

  const state = await page.evaluate(() => new Promise<string>((resolve) => {
    const open = indexedDB.open("narrarium-local-repositories");
    open.onsuccess = () => { const all = open.result.transaction("files", "readonly").objectStore("files").getAll(); all.onsuccess = () => resolve((all.result as Array<{ path: string; text: string }>).find((entry) => entry.path === "autopilot/activity.json")?.text ?? "{}"); };
  }));
  const activity = (JSON.parse(state) as { activities: Array<{ id: string }> }).activities[0];
  await page.evaluate((id) => { window.location.hash = `#task-${id}`; }, activity.id);
  const view = page.locator("[data-task-calls]").first();
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(view).toContainText("System");
  await expect(view).toContainText("Response");
  await page.reload({ waitUntil: "domcontentloaded" });
  expect((await storeOf(page)).tasks, "the records survive a reload").toBe(kept.tasks);
});

test("nothing is recorded while the recording of the book is off on this device, and the step says so", async ({ page }) => {
  await seed(page, settingsOf(ai.url), await bookFiles(), true);
  await page.goto(".", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => (window as unknown as { __seedReady: Promise<void> }).__seedReady);
  await runOneStep(page);
  expect(await storeOf(page)).toMatchObject({ tasks: 0 });
  const state = await page.evaluate(() => new Promise<string>((resolve) => {
    const open = indexedDB.open("narrarium-local-repositories");
    open.onsuccess = () => { const all = open.result.transaction("files", "readonly").objectStore("files").getAll(); all.onsuccess = () => resolve((all.result as Array<{ path: string; text: string }>).find((entry) => entry.path === "autopilot/activity.json")?.text ?? "{}"); };
  }));
  const activity = (JSON.parse(state) as { activities: Array<{ id: string }> }).activities[0];
  await page.evaluate((id) => { window.location.hash = `#task-${id}`; }, activity.id);
  const view = page.locator("[data-task-calls]").first();
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(view).toContainText("the recording is turned off");
  await expect(view).toContainText("No messages were recorded for this step");
});
