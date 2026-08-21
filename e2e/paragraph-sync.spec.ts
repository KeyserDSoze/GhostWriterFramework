import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const ACCOUNT_IDENTITY = "google:e2e-google-user";
const BOOK_ID = "book-jesus";
const REPOSITORY_ID = `${ACCOUNT_IDENTITY}::keyserdsoze/jesus#test2`;
const PARAGRAPH_PATH = "chapters/001-the-arrival/001-opening.md";
const DRAFT_PATH = "drafts/001-the-arrival/001-opening.md";
const INITIAL_HEAD = "head-test2";
const UPDATED_HEAD = "head-test2-after-edit";
const INITIAL_BODY = "The gate stood open beneath a sky the color of old steel.";
const EDITED_BODY = `${INITIAL_BODY}\n\nE2E edit: the gate remembered every name.`;

const paragraphContent = `---
type: paragraph
id: paragraph:001-the-arrival:001-opening
number: 001
---

${INITIAL_BODY}
`;

const draftContent = `---
type: paragraph-draft
id: paragraph:001-the-arrival:001-opening
number: 001
---

${INITIAL_BODY}
`;

const seededFiles = [
  { path: "book.md", content: "---\ntitle: Jesus\nlanguage: en\n---\n\nA deterministic E2E book.\n" },
  { path: "chapters/001-the-arrival/chapter.md", content: "---\ntitle: The Arrival\nnumber: 1\n---\n\nThe opening chapter.\n" },
  { path: PARAGRAPH_PATH, content: paragraphContent },
  { path: DRAFT_PATH, content: draftContent },
  { path: "guidelines/writing-style.md", content: "# Writing style\n\nKeep the prose concrete.\n" },
];

type RequestEvent = { method: string; url: string; body: string | undefined };
type UnexpectedRequest = { method: string; url: string; status: number };
type RequestPhase = "opening" | "sync" | "reload";

function requestPath(event: RequestEvent): string {
  return decodeURIComponent(new URL(event.url).pathname);
}

function installDeterministicNetworkMocks(page: Page): { events: RequestEvent[]; headRequests: string[]; headRequestsByPhase: Record<RequestPhase, string[]>; blobDownloads: string[]; unexpected: UnexpectedRequest[]; setPhase: (phase: RequestPhase) => void } {
  const events: RequestEvent[] = [];
  const headRequests: string[] = [];
  const headRequestsByPhase: Record<RequestPhase, string[]> = { opening: [], sync: [], reload: [] };
  const blobDownloads: string[] = [];
  const unexpected: UnexpectedRequest[] = [];
  let phase: RequestPhase = "opening";
  let remoteHead = INITIAL_HEAD;

  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("https://api.github.com/")) {
      const event = { method: request.method(), url, body: request.postData() };
      events.push(event);
      const path = decodeURIComponent(new URL(url).pathname);
      if (request.method() === "GET" && /\/git\/ref\/heads\/test2$/.test(path)) {
        headRequests.push(url);
        headRequestsByPhase[phase].push(url);
      }
      if (request.method() === "GET" && /\/git\/blobs\//.test(path)) blobDownloads.push(url);
    }
  });

  page.route("https://www.googleapis.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/oauth2/v3/userinfo") {
      await route.fulfill({ json: { sub: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" } });
      return;
    }
    if (url.pathname === "/drive/v3/about") {
      await route.fulfill({ json: { user: { permissionId: "e2e-google-user", emailAddress: "e2e@example.test" } } });
      return;
    }
    if (url.pathname === "/drive/v3/files" && url.searchParams.get("q")?.includes("mimeType=")) {
      await route.fulfill({ json: { files: [{ id: "e2e-folder", name: "Narrarium", createdTime: "2024-01-01T00:00:00.000Z", appProperties: { narrariumAppFolder: "v1" } }] } });
      return;
    }
    if (url.pathname === "/drive/v3/files" && url.searchParams.get("q")?.includes("settings.json")) {
      await route.fulfill({ json: { files: [{ id: "e2e-settings", createdTime: "2024-01-01T00:00:00.000Z" }] } });
      return;
    }
    if (url.pathname === "/drive/v3/files/e2e-settings" && url.searchParams.has("alt")) {
      await route.fulfill({ json: { version: 2, defaultGitHubToken: "e2e-github-token", extraGitHubTokens: [], repository: { autoFetchOnOpen: true, autoFetchIntervalMinutes: 0, autoPullWhenClean: false }, ui: { language: "en", theme: "light" }, books: [{ id: BOOK_ID, owner: "KeyserDSoze", repo: "Jesus", name: "Jesus", tokenIndex: null, bookToken: "e2e-github-token", activeBranch: "test2", addedAt: "2024-01-01T00:00:00.000Z" }] } });
      return;
    }
    if (url.pathname === "/drive/v3/files/e2e-settings") {
      await route.fulfill({ json: { id: "e2e-settings", version: "1", modifiedTime: "2024-01-01T00:00:00.000Z" } });
      return;
    }
    if (url.pathname === "/drive/v3/files" && url.searchParams.get("q")?.includes("costs.json")) {
      await route.fulfill({ json: { files: [] } });
      return;
    }
    if (url.pathname === "/drive/v3/files" && url.searchParams.get("q")?.includes("clipboard.json")) {
      await route.fulfill({ json: { files: [] } });
      return;
    }
    unexpected.push({ method: request.method(), url: request.url(), status: 500 });
    await route.fulfill({ status: 500, json: { error: "Unexpected Google request in deterministic E2E" } });
  });

  page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    const method = request.method();
    const remoteTree = seededFiles.map((file, index) => ({ path: file.path, mode: "100644", type: "blob", sha: `blob-${index}`, size: new TextEncoder().encode(file.content).byteLength }));

    if (method === "GET" && /\/git\/ref\/heads\/test2$/.test(path)) {
      await route.fulfill({ json: { ref: "refs/heads/test2", node_id: "e2e-ref", url: request.url(), object: { type: "commit", sha: remoteHead, url: "https://api.github.com/e2e-commit" } } });
      return;
    }
    if (method === "GET" && /\/git\/commits\//.test(path)) {
      await route.fulfill({ json: { sha: remoteHead, tree: { sha: "tree-test2" } } });
      return;
    }
    if (method === "GET" && /\/git\/trees\//.test(path)) {
      await route.fulfill({ json: { sha: "tree-test2", truncated: false, tree: remoteTree } });
      return;
    }
    if (method === "GET" && /\/contents\/resumes\/chapters\/001-the-arrival\.md$/.test(path)) {
      await route.fulfill({ status: 404, json: { message: "Not Found" } });
      return;
    }
    if (method === "GET" && /\/contents\/evaluations\/chapters\/001-the-arrival\.md$/.test(path)) {
      await route.fulfill({ status: 404, json: { message: "Not Found" } });
      return;
    }
    if (method === "POST" && /\/git\/blobs$/.test(path)) {
      await route.fulfill({ json: { sha: "blob-edited" } });
      return;
    }
    if (method === "POST" && /\/git\/trees$/.test(path)) {
      await route.fulfill({ json: { sha: "tree-edited" } });
      return;
    }
    if (method === "POST" && /\/git\/commits$/.test(path)) {
      await route.fulfill({ json: { sha: "commit-edited", tree: { sha: "tree-edited" }, parents: [{ sha: INITIAL_HEAD }] } });
      return;
    }
    if (method === "PATCH" && /\/git\/refs\/heads\/test2$/.test(path)) {
      remoteHead = UPDATED_HEAD;
      await route.fulfill({ json: { ref: "refs/heads/test2", object: { sha: UPDATED_HEAD } } });
      return;
    }
    unexpected.push({ method, url: request.url(), status: 500 });
    await route.fulfill({ status: 500, json: { message: `Unexpected GitHub request: ${method} ${path}` } });
  });

  return { events, headRequests, headRequestsByPhase, blobDownloads, unexpected, setPhase: (next) => { phase = next; } };
}

async function installSeed(page: Page): Promise<void> {
  await page.addInitScript(({ repositoryId, files }) => {
    const marker = "narrarium-e2e-issue-65-seeded-v1";
    const target = window as unknown as { __narrariumE2eSeedReady?: Promise<void> };
    if (window.localStorage.getItem(marker)) {
      target.__narrariumE2eSeedReady = Promise.resolve();
      return;
    }

    const user = { provider: "google", providerAccountId: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" };
    const now = Date.now();
    window.localStorage.setItem(marker, "1");
    window.localStorage.setItem("narrarium-account-scope-v1", "google:e2e-google-user");
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
          const ensureIndex = (store: IDBObjectStore, name: string, keyPath: string | string[]) => {
            if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
          };
          if (!db.objectStoreNames.contains("repositories")) {
            const store = db.createObjectStore("repositories", { keyPath: "id" });
            ensureIndex(store, "bookId", "bookId");
            ensureIndex(store, "remote", ["owner", "repo", "branch"]);
          } else {
            const store = request.transaction!.objectStore("repositories");
            ensureIndex(store, "bookId", "bookId");
            ensureIndex(store, "remote", ["owner", "repo", "branch"]);
          }
          if (!db.objectStoreNames.contains("files")) {
            const store = db.createObjectStore("files", { keyPath: "key" });
            ensureIndex(store, "repoId", "repoId");
            ensureIndex(store, "repoStatus", ["repoId", "status"]);
          } else {
            const store = request.transaction!.objectStore("files");
            ensureIndex(store, "repoId", "repoId");
            ensureIndex(store, "repoStatus", ["repoId", "status"]);
          }
          if (!db.objectStoreNames.contains("commits")) {
            const store = db.createObjectStore("commits", { keyPath: "id" });
            ensureIndex(store, "repoId", "repoId");
          } else ensureIndex(request.transaction!.objectStore("commits"), "repoId", "repoId");
          if (!db.objectStoreNames.contains("logs")) {
            const store = db.createObjectStore("logs", { keyPath: "id" });
            ensureIndex(store, "repoId", "repoId");
          } else ensureIndex(request.transaction!.objectStore("logs"), "repoId", "repoId");
          if (!db.objectStoreNames.contains("recoveries")) {
            const store = db.createObjectStore("recoveries", { keyPath: "id" });
            ensureIndex(store, "repoId", "repoId");
          } else ensureIndex(request.transaction!.objectStore("recoveries"), "repoId", "repoId");
          for (const name of ["migrationJournals", "maintenanceFences", "removalJournals", "consumedBackupReceipts", "maintenanceTombstones", "maintenanceCompletions"] as const) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === "recoveries" ? "id" : name === "migrationJournals" ? "id" : name === "consumedBackupReceipts" ? "receiptId" : name === "recoveries" ? "id" : "repoId" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    target.__narrariumE2eSeedReady = (async () => {
      const db = await openDatabase();
      const prepared = await Promise.all(files.map(async (file, index) => {
        const currentHash = await sha256(file.content);
        return { key: `${repositoryId}::${file.path}`, repoId: repositoryId, path: file.path, kind: "text", text: file.content, baseSha: `blob-${index}`, baseHash: currentHash, currentHash, status: "clean", committed: false, size: new TextEncoder().encode(file.content).byteLength, updatedAt: "2024-01-01T00:00:00.000Z" };
      }));
      await new Promise<void>((resolve, reject) => {
        const storeNames = [...db.objectStoreNames];
        const transaction = db.transaction(storeNames, "readwrite");
        for (const name of storeNames) transaction.objectStore(name).clear();
        transaction.objectStore("repositories").put({ id: repositoryId, localInstanceId: "e2e-local-instance", bookId: "book-jesus", owner: "KeyserDSoze", repo: "Jesus", branch: "test2", defaultBranch: "main", remoteHeadSha: "head-test2", remoteChanged: false, remoteStatus: "clean", remoteCheckedAt: "2024-01-01T00:00:00.000Z", lastRemoteHead: "head-test2", lastKnownChanged: false, clonedAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z", lastFetchAt: "2024-01-01T00:00:00.000Z", cloneComplete: true, cloneStatus: "complete", expectedFileCount: prepared.length, nextCommitOrder: 0, accountScope: "google:e2e-google-user", operationFence: 0 });
        for (const file of prepared) transaction.objectStore("files").put(file);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("E2E IndexedDB seed aborted"));
      });
      db.close();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("narrarium-local-rewrite-operations", 7);
        request.onupgradeneeded = () => {
          const rewriteDb = request.result;
          if (!rewriteDb.objectStoreNames.contains("rewriteOperationsV3")) {
            const store = rewriteDb.createObjectStore("rewriteOperationsV3", { keyPath: "storageId" });
            store.createIndex("repoKey", "repoKey", { unique: false });
            store.createIndex("bookId", "bookId", { unique: false });
            store.createIndex("repoTargetKey", ["repoKey", "targetKey"], { unique: false });
            store.createIndex("operationId", "operationId", { unique: false });
          }
          if (!rewriteDb.objectStoreNames.contains("maintenanceTombstones")) rewriteDb.createObjectStore("maintenanceTombstones", { keyPath: "repoId" });
          if (!rewriteDb.objectStoreNames.contains("maintenanceCompletions")) rewriteDb.createObjectStore("maintenanceCompletions", { keyPath: "markerId" });
          if (!rewriteDb.objectStoreNames.contains("migrationCompletions")) rewriteDb.createObjectStore("migrationCompletions", { keyPath: "markerId" });
        };
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
      });
    })();
  }, { repositoryId: REPOSITORY_ID, files: seededFiles });
}

async function readLocalFile(page: Page): Promise<{ text: string; status: string; committed: boolean }> {
  return page.evaluate(async ({ repositoryId, path }) => new Promise((resolve, reject) => {
    const request = indexedDB.open("narrarium-local-repositories");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("files", "readonly");
      const read = transaction.objectStore("files").get(`${repositoryId}::${path}`);
      read.onsuccess = () => { db.close(); resolve({ text: read.result?.text ?? "", status: read.result?.status ?? "missing", committed: Boolean(read.result?.committed) }); };
      read.onerror = () => reject(read.error);
    };
  }), { repositoryId: REPOSITORY_ID, path: PARAGRAPH_PATH });
}

test("edits a locally cloned paragraph and full-syncs it to test2", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  const network = installDeterministicNetworkMocks(page);
  try {
    await installSeed(page);
    await page.goto(".", { waitUntil: "domcontentloaded" });
    await page.waitForFunction((repositoryId) => new Promise<boolean>((resolve) => {
      const request = indexedDB.open("narrarium-local-repositories");
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("repositories", "readonly").objectStore("repositories").get(repositoryId);
        read.onsuccess = () => { db.close(); resolve(Boolean(read.result)); };
        read.onerror = () => { db.close(); resolve(false); };
      };
    }), REPOSITORY_ID);

  await page.goto(`app/books/${BOOK_ID}/chapters/001-the-arrival/paragraphs/001`);
  const editButton = page.getByRole("button", { name: "Edit paragraph" });
  try {
    await expect(editButton).toBeVisible({ timeout: 15000 });
  } catch (error) {
    throw new Error(`Initial route did not render editor. body=${JSON.stringify(await page.locator("body").innerText())} browserErrors=${JSON.stringify(browserErrors)} failedResponses=${JSON.stringify(failedResponses)} unexpected=${JSON.stringify(network.unexpected)} events=${JSON.stringify(network.events)}`, { cause: error });
  }
  expect(network.blobDownloads).toHaveLength(0);
  expect(network.unexpected).toEqual([]);
  // Opening allows one branch-head check; sync allows one remote check plus
  // the push/final-head verification; reload allows one check.
  expect(network.headRequestsByPhase.opening.length).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Edit paragraph" }).click();
  const editor = page.getByRole("textbox", { name: "Start writing…" });
  await expect(editor).toHaveValue(`${INITIAL_BODY}\n`);
  await editor.fill(EDITED_BODY);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  const localBeforeSync = await readLocalFile(page);
  expect(localBeforeSync.status).toBe("modified");
  expect(localBeforeSync.committed).toBe(false);
  expect(localBeforeSync.text).toContain(EDITED_BODY);

  const headsBeforeSync = network.headRequests.length;
  const statusButton = page.getByRole("button", { name: /Clean|local changes|Checking remote/ }).first();
  await expect(statusButton).toBeVisible();
  await statusButton.click();
  await page.getByRole("menuitem", { name: "View status" }).click();
  const statusDialog = page.getByRole("dialog");
  await expect(statusDialog.getByRole("heading", { name: "Repository status" })).toBeVisible();
  if (!(await statusDialog.getByRole("button", { name: "Full sync" }).isEnabled())) {
    await statusDialog.getByRole("button", { name: "Close" }).click();
    await statusButton.click();
    await page.getByRole("menuitem", { name: "View status" }).click();
  }
  await expect(statusDialog.getByRole("heading", { name: "Repository status" })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  const forceConfirmation = statusDialog.getByRole("textbox", { name: "Type the FORCE RECLONE phrase shown above" });
  const forceReclone = statusDialog.getByRole("button", { name: "Force re-clone from GitHub" });
  await expect(statusDialog.getByText("FORCE RECLONE KeyserDSoze/Jesus#test2", { exact: true })).toBeVisible();
  await expect(forceReclone).toBeDisabled();
  await forceConfirmation.fill("FORCE RECLONE KeyserDSoze/Jesus#wrong");
  await expect(forceReclone).toBeDisabled();
  await forceConfirmation.fill("FORCE RECLONE KeyserDSoze/Jesus#test2");
  await expect(forceReclone).toBeEnabled();
  await forceConfirmation.clear();
  await page.setViewportSize({ width: 1280, height: 720 });
  const fullSync = statusDialog.getByRole("button", { name: "Full sync" });
  await expect(fullSync).toBeEnabled();
  network.setPhase("sync");
  await statusDialog.getByRole("button", { name: "Full sync" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sync complete:" })).toBeVisible();

  const createBlob = network.events.find((event) => event.method === "POST" && /\/git\/blobs$/.test(requestPath(event)));
  const createCommitIndex = network.events.findIndex((event) => event.method === "POST" && /\/git\/commits$/.test(requestPath(event)));
  const updateRefIndex = network.events.findIndex((event) => event.method === "PATCH" && /\/git\/refs\/heads\/test2$/.test(requestPath(event)));
  expect(headsBeforeSync).toBeLessThanOrEqual(1);
  expect(network.headRequestsByPhase.sync.length).toBeLessThanOrEqual(3);
  expect(createBlob).toBeDefined();
  expect(JSON.parse(createBlob!.body ?? "{}").content).toContain(EDITED_BODY);
  expect(createCommitIndex).toBeGreaterThan(-1);
  expect(updateRefIndex).toBeGreaterThan(createCommitIndex);
  expect(network.events.findIndex((event) => event === createBlob)).toBeLessThan(updateRefIndex);
  expect(network.events.filter((event) => event.method === "PATCH" && /\/git\/refs\/heads\/test2$/.test(requestPath(event)))).toHaveLength(1);
  expect(requestPath(network.events.find((event) => event.method === "PATCH" && /\/git\/refs\/heads\/test2$/.test(requestPath(event)))!)).toContain("heads/test2");
  expect(network.blobDownloads).toHaveLength(0);

  const localAfterSync = await readLocalFile(page);
  expect(localAfterSync.status).toBe("clean");
  expect(localAfterSync.committed).toBe(false);
  expect(localAfterSync.text).toContain(EDITED_BODY);

  const headsBeforeReload = network.headRequests.length;
  network.setPhase("reload");
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit paragraph" })).toBeVisible();
  expect(network.headRequests.length - headsBeforeReload).toBeLessThanOrEqual(1);
  expect(network.headRequestsByPhase.reload.length).toBeLessThanOrEqual(1);
  expect(network.blobDownloads).toHaveLength(0);
  await page.getByRole("button", { name: "Edit paragraph" }).click();
  await expect(page.getByRole("textbox", { name: "Start writing…" })).toHaveValue(EDITED_BODY);
  expect(network.unexpected).toEqual([]);
  } finally {
    if (testInfo.status !== testInfo.expectedStatus) {
      console.log("Unexpected intercepted requests", JSON.stringify(network.unexpected));
      console.log("Repository status dialog", await page.getByRole("dialog").allTextContents().catch(() => []));
    }
  }
});
