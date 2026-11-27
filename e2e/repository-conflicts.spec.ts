import { expect, test, type Page } from "@playwright/test";

// The resolver of the conflicts of a full sync, in a real browser with GitHub stubbed: the autopilot's files changed on this device and on GitHub, with lines
// longer than any screen. Everything stays inside the window (its buttons always in view), the steps show while the choices apply, and the pill of the
// repository says what is true afterwards. A book made on this device and then put on GitHub shows the status of its copy, not «no copy».

test.use({ serviceWorkers: "block" });

const WORKSPACE_ID = "e2e-workspace";
const ACCOUNT_IDENTITY = `workspace:${WORKSPACE_ID}`;
const BOOK_ID = "book-jesus";
const LONG_TOKEN = `"request_id":"${"7f3c2a91b8e44d0c".repeat(20)}"`;

function activity(side: "base" | "local" | "remote"): string {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    id: `act-${index}${index >= 36 && side !== "base" ? `-${side}` : ""}`,
    title: `Writing scene ${index} of the chapter where the keeper climbs the tower before the storm reaches the cliffs of the old town`,
    changedPaths: ["chapters/012-the-long-night-of-the-harbour-and-the-lighthouse-keeper/003-the-last-light-before-the-storm-reaches-the-cliffs.md"],
    ...(index >= 36 && side === "remote" ? { error: `400 {${LONG_TOKEN}}` } : {}),
  }));
  return `${JSON.stringify({ schemaVersion: 1, activities: entries }, null, 2)}\n`;
}

const conflicted = [
  { path: "autopilot/activity.json", make: activity },
  { path: "autopilot/state.json", make: (side: string) => `${JSON.stringify({ schemaVersion: 1, version: side === "remote" ? 412 : side === "local" ? 409 : 400, status: "paused", expectedHash: `sha256:${(side === "remote" ? "9f2c" : "1a2b").repeat(40)}` }, null, 2)}\n` },
  { path: "evaluations/director/book.md", make: (side: string) => `---\ntype: director-evaluation\n---\n\n# The director on the whole book\n\n${"The harbour is alive and the storm is felt before it is seen, but the second half repeats the climb to the tower three times. ".repeat(6)}${side}\n\n- Source: https://github.com/KeyserDSoze/Jesus/blob/test2/chapters/001-the-long-night-of-the-harbour-and-the-lighthouse-keeper/001-the-keeper-climbs-the-tower-before-the-storm.md#L1-L400\n` },
];
const plain = [
  { path: "book.md", content: "---\ntype: book\nid: book\ntitle: Jesus\nlanguage: en\nghostwriter: default\n---\n\nA deterministic E2E book.\n" },
  { path: "ghostwriters/default.md", content: "---\ntype: ghostwriter\nid: ghostwriter:default\nname: Default\n---\n\nWrite plainly.\n" },
  { path: "chapters/001-the-arrival/chapter.md", content: "---\ntitle: The Arrival\nnumber: 1\n---\n\nThe opening chapter.\n" },
  { path: "chapters/001-the-arrival/001-opening.md", content: "---\ntype: paragraph\nid: paragraph:001-the-arrival:001-opening\nnumber: 001\n---\n\nThe gate stood open beneath a sky the color of old steel.\n" },
];

/** GitHub with the three files changed since this device's copy, and a push slow enough to be seen. */
async function mockNetwork(page: Page, options: { owner: string; repo: string; branch: string; conflicts: boolean }): Promise<{ pushes: string[] }> {
  const pushes: string[] = [];
  let head = options.conflicts ? "head-remote" : "head-base";
  await page.route("https://www.googleapis.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/oauth2/v3/userinfo") return route.fulfill({ json: { sub: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" } });
    if (url.pathname === "/drive/v3/about") return route.fulfill({ json: { user: { permissionId: "e2e-google-user", emailAddress: "e2e@example.test" } } });
    return route.fulfill({ json: { files: [], nextPageToken: null } });
  });
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    const tree = (side: "base" | "remote") => [...plain.map((file, index) => ({ path: file.path, sha: `plain-${index}` })), ...conflicted.map((file, index) => ({ path: file.path, sha: `${side}-${index}` }))]
      .map((entry) => ({ ...entry, mode: "100644", type: "blob", size: 100 }));
    if (/\/branches$/.test(path)) return route.fulfill({ json: [{ name: options.branch, commit: { sha: head }, protected: false }] });
    if (method === "GET" && path.endsWith(`/git/ref/heads/${options.branch}`)) return route.fulfill({ json: { ref: `refs/heads/${options.branch}`, object: { type: "commit", sha: head } } });
    const commit = /\/git\/commits\/(.+)$/.exec(path)?.[1];
    if (method === "GET" && commit) return route.fulfill({ json: { sha: commit, tree: { sha: commit === "head-base" ? "tree-base" : commit === "head-remote" ? "tree-remote" : "tree-pushed" }, parents: [] } });
    const treeSha = /\/git\/trees\/(.+)$/.exec(path)?.[1];
    if (method === "GET" && treeSha) return route.fulfill({ json: { sha: treeSha, truncated: false, tree: tree(treeSha === "tree-base" ? "base" : "remote") } });
    const blob = /\/git\/blobs\/(plain|base|remote)-(\d+)$/.exec(path);
    if (method === "GET" && blob) {
      const index = Number(blob[2]);
      return route.fulfill({ contentType: "application/octet-stream", body: blob[1] === "plain" ? plain[index].content : conflicted[index].make(blob[1]) });
    }
    if (new RegExp(`/repos/${options.owner}/${options.repo}$`, "i").test(path)) return route.fulfill({ json: { id: 1, name: options.repo, full_name: `${options.owner}/${options.repo}`, default_branch: options.branch, permissions: { pull: true, push: true } } });
    if (method === "POST" && /\/git\/(blobs|trees|commits)$/.test(path)) {
      pushes.push(path);
      return route.fulfill({ status: 201, json: { sha: `pushed-${pushes.length}`, tree: { sha: "pushed-tree" } } });
    }
    if (method === "PATCH" && path.endsWith(`/git/refs/heads/${options.branch}`)) {
      // GitHub takes its time with the reference: the window shows that it is publishing meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      pushes.push(path);
      head = "pushed-commit";
      return route.fulfill({ json: { ref: `refs/heads/${options.branch}`, object: { sha: head } } });
    }
    return route.fulfill({ status: 404, json: { message: "Not Found" } });
  });
  return { pushes };
}

/** The working copy of this device: the three files changed here, or (`attached`) a book made on this device that was then put on GitHub, with the id it had. */
async function seed(page: Page, options: { repositoryId: string; owner: string; repo: string; branch: string; conflicts: boolean; book: Record<string, unknown> }): Promise<void> {
  const files = [
    ...plain.map((file, index) => ({ path: file.path, base: file.content, local: file.content, baseSha: `plain-${index}` })),
    ...conflicted.map((file, index) => ({ path: file.path, base: file.make("base"), local: file.make(options.conflicts ? "local" : "base"), baseSha: `base-${index}` })),
  ];
  await page.addInitScript(({ files, accountIdentity, workspaceId, repositoryId, owner, repo, branch, book, now }) => {
    const target = window as unknown as { __narrariumE2eSeedReady?: Promise<void> };
    const marker = "narrarium-repository-conflicts-seeded-v1";
    if (window.localStorage.getItem(marker)) { target.__narrariumE2eSeedReady = Promise.resolve(); return; }
    window.localStorage.setItem(marker, "1");
    window.localStorage.setItem("narrarium-local-workspace-id-v1", workspaceId);
    window.localStorage.setItem("narrarium-account-scope-v1", accountIdentity);
    const user = { provider: "google", providerAccountId: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" };
    const cachedSettings = { schemaVersion: 2, accountScope: "google:e2e-google-user", baseRevision: "1", base: { ui: { language: "en", theme: "light" }, repository: { autoFetchOnOpen: true, autoFetchIntervalMinutes: 0, autoPullWhenClean: false }, books: [book] } };
    window.localStorage.setItem(`narrarium-settings-cache-v2:${encodeURIComponent("google:e2e-google-user")}`, JSON.stringify(cachedSettings));
    window.sessionStorage.setItem(`narrarium-settings-credentials-v1:${encodeURIComponent("google:e2e-google-user")}`, JSON.stringify({ defaultGitHubToken: "e2e-github-token", extraGitHubTokens: [], azureOpenAIApiKey: "", integrationApiKeys: {}, deepSearchApiKeys: { braveApiKey: "", tavilyApiKey: "" }, bookTokens: { [book.id as string]: { token: "e2e-github-token" } } }));
    window.localStorage.setItem("narrarium-account-continuity-v1", JSON.stringify({ version: 1, accounts: { google: { version: 1, provider: "google", providerAccountId: user.providerAccountId, normalizedEmail: user.email, displayName: user.name, picture: user.picture, createdAt: 1704067200000, lastSeen: now } } }));
    window.sessionStorage.setItem("narrarium-auth-session-v1", JSON.stringify({ version: 1, state: { accessToken: "e2e-google-token", accessTokenExpiry: now + 3_600_000, provider: user.provider, providerAccountId: user.providerAccountId } }));
    const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("narrarium-local-repositories", 12);
      request.onupgradeneeded = () => {
        const db = request.result;
        const index = (store: IDBObjectStore, name: string, keyPath: string | string[]) => { if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false }); };
        const repositories = db.createObjectStore("repositories", { keyPath: "id" });
        index(repositories, "bookId", "bookId"); index(repositories, "remote", ["owner", "repo", "branch"]);
        const filesStore = db.createObjectStore("files", { keyPath: "key" });
        index(filesStore, "repoId", "repoId"); index(filesStore, "repoStatus", ["repoId", "status"]);
        for (const name of ["commits", "logs", "recoveries"]) index(db.createObjectStore(name, { keyPath: "id" }), "repoId", "repoId");
        for (const name of ["migrationJournals", "maintenanceFences", "removalJournals", "consumedBackupReceipts", "maintenanceTombstones", "maintenanceCompletions"]) db.createObjectStore(name, { keyPath: name === "migrationJournals" ? "id" : name === "consumedBackupReceipts" ? "receiptId" : "repoId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    target.__narrariumE2eSeedReady = (async () => {
      const db = await open();
      const rows: Array<{ store: string; value: unknown }> = [{ store: "repositories", value: { id: repositoryId, localInstanceId: "e2e-conflicts", bookId: book.id, repositoryKind: "book", remoteKind: "github", owner, repo, branch, defaultBranch: branch, remoteHeadSha: "head-base", remoteChanged: false, remoteStatus: "clean", remoteCheckedAt: "2024-01-01T00:00:00.000Z", lastRemoteHead: "head-base", lastKnownChanged: false, clonedAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z", lastFetchAt: "2024-01-01T00:00:00.000Z", cloneComplete: true, cloneStatus: "complete", expectedFileCount: files.length, nextCommitOrder: 0, accountScope: accountIdentity, operationFence: 0 } }];
      for (const file of files) {
        const baseHash = await sha256(file.base);
        const currentHash = await sha256(file.local);
        rows.push({ store: "files", value: { key: `${repositoryId}::${file.path}`, repoId: repositoryId, path: file.path, kind: "text", text: file.local, baseSha: file.baseSha, baseHash, currentHash, status: currentHash === baseHash ? "clean" : "modified", committed: false, size: file.local.length, updatedAt: "2024-01-01T00:00:00.000Z" } });
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["repositories", "files"], "readwrite");
        for (const row of rows) tx.objectStore(row.store).put(row.value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    })();
  }, { files, accountIdentity: ACCOUNT_IDENTITY, workspaceId: WORKSPACE_ID, ...options, now: Date.now() });
}

/** The element is wholly on the screen, and nothing (a notice, another layer) covers it: what is at its centre is the element itself. */
async function wholly(page: Page, selector: ReturnType<Page["locator"]>): Promise<boolean> {
  return selector.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const onScreen = box.width > 0 && box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight;
    // A disabled button takes no pointer events: for the look at what covers it, it takes them.
    const target = element as HTMLElement;
    const pointerEvents = target.style.pointerEvents;
    target.style.pointerEvents = "auto";
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    target.style.pointerEvents = pointerEvents;
    return onScreen && Boolean(hit) && (hit === element || element.contains(hit));
  });
}

/** Nothing in the window is wider than the window: no part of it scrolls sideways, and no part runs out of it. */
async function overflow(page: Page): Promise<string[]> {
  return page.locator("[data-repository-conflicts]").evaluate((dialog) => {
    const limit = dialog.getBoundingClientRect();
    const problems: string[] = [];
    if (dialog.scrollWidth > dialog.clientWidth + 1) problems.push(`dialog scrolls sideways: ${dialog.scrollWidth} > ${dialog.clientWidth}`);
    for (const element of dialog.querySelectorAll<HTMLElement>("*")) {
      const box = element.getBoundingClientRect();
      if (!box.width || element.closest(".sr-only") || element.classList.contains("sr-only")) continue;
      if (box.right > limit.right + 1 || box.left < limit.left - 1) problems.push(`${element.tagName}.${element.className.toString().slice(0, 40)} runs out: ${Math.round(box.left)}–${Math.round(box.right)} of ${Math.round(limit.left)}–${Math.round(limit.right)}`);
      if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible" && !element.closest("[data-conflict-diff]")) problems.push(`${element.tagName} scrolls sideways`);
    }
    if (window.innerWidth < limit.right + 0.5 || limit.left < -0.5) problems.push("dialog wider than the screen");
    return problems.slice(0, 8);
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`the conflict resolver fits ${viewport.width}x${viewport.height}, shows its steps while it applies, and the pill tells the truth after`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const network = await mockNetwork(page, { owner: "KeyserDSoze", repo: "Jesus", branch: "test2", conflicts: true });
    await seed(page, { repositoryId: `${ACCOUNT_IDENTITY}::keyserdsoze/jesus#test2`, owner: "KeyserDSoze", repo: "Jesus", branch: "test2", conflicts: true, book: { id: BOOK_ID, owner: "KeyserDSoze", repo: "Jesus", name: "Jesus", tokenIndex: null, activeBranch: "test2", addedAt: "2024-01-01T00:00:00.000Z" } });
    await page.goto(`app/books/${BOOK_ID}/chapters/001-the-arrival/paragraphs/001`);
    await expect(page.getByRole("button", { name: "Edit paragraph" })).toBeVisible({ timeout: 30_000 });
    const pill = page.getByTestId("repository-pill");
    await expect(pill).toHaveText("3 local changes", { timeout: 20_000 });

    await pill.click();
    await page.getByRole("menu").getByRole("button", { name: "Full sync", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Resolve repository conflicts" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const apply = dialog.getByRole("button", { name: "Apply choices and sync", exact: true });
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    // The window, its title and its buttons are on the screen, and nothing in it is wider than it, the long lines included.
    expect(await wholly(page, dialog)).toBe(true);
    expect(await wholly(page, dialog.getByRole("heading", { name: "Resolve repository conflicts" }))).toBe(true);
    expect(await wholly(page, apply)).toBe(true);
    expect(await wholly(page, cancel)).toBe(true);
    expect(await overflow(page)).toEqual([]);
    await expect(apply).toBeDisabled();

    const activityFile = dialog.locator('[data-conflict-file="autopilot/activity.json"]');
    await expect(activityFile.getByText(/Lines only on this device: \d+ · only on GitHub: \d+/)).toBeVisible();
    await activityFile.getByRole("button", { name: "Show the differences" }).click();
    const differences = activityFile.getByRole("table", { name: "Differences of autopilot/activity.json" });
    await expect(differences).toBeVisible();
    await expect(differences.getByText(/unchanged lines/).first()).toBeVisible();
    const block = activityFile.locator("[data-conflict-diff]");
    expect(await block.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await activityFile.scrollIntoViewIfNeeded();
    expect(await overflow(page)).toEqual([]);
    expect(await wholly(page, apply)).toBe(true);

    await dialog.getByRole("button", { name: "Keep this device's versions", exact: true }).click();
    await expect(apply).toBeEnabled();
    expect(await wholly(page, apply)).toBe(true);
    await apply.click();

    // While it applies: the steps in words, the current one announced, the buttons held, and no way to stop it halfway through the publication.
    await expect(dialog.getByRole("heading", { name: "Applying your choices" })).toBeVisible();
    const publishing = dialog.locator('[data-sync-step="publishing"][data-state="current"]');
    await expect(publishing).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("status").filter({ hasText: "Publishing to GitHub…" })).toBeAttached();
    await expect(dialog.locator('[data-sync-step="checking"][data-state="done"]')).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Applying…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
    await expect(dialog.getByText("It cannot be stopped now", { exact: false })).toBeVisible();
    expect(await wholly(page, dialog.getByRole("button", { name: "Applying…" }))).toBe(true);
    expect(await overflow(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    // What came of it, then the pill: the three choices published, nothing left only here.
    await expect(dialog.getByText("Your choices are applied")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("Kept this device's version of 3 files.")).toBeVisible();
    await expect(dialog.getByText("Published 3 files to GitHub.")).toBeVisible();
    expect(await wholly(page, dialog.getByRole("button", { name: "Close", exact: true }))).toBe(true);
    expect(network.pushes.filter((path) => path.endsWith("/git/blobs"))).toHaveLength(3);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(pill).toHaveText("Clean", { timeout: 10_000 });
  });
}

test("a book made on this device and then put on GitHub shows the status of its copy, never that there is no copy", async ({ page }) => {
  test.setTimeout(90_000);
  const localRepositoryId = "0f6f1a52-3c5e-4a43-9f53-2f0a7e2b9c11";
  await mockNetwork(page, { owner: "ada", repo: "glass-harbor", branch: "main", conflicts: false });
  // The working copy keeps the id it had on this device (`…::local:<id>`), under the name of its repository on GitHub.
  await seed(page, {
    repositoryId: `${ACCOUNT_IDENTITY}::local:${localRepositoryId}`,
    owner: "ada",
    repo: "glass-harbor",
    branch: "main",
    conflicts: false,
    book: { id: BOOK_ID, owner: "ada", repo: "glass-harbor", name: "The Glass Harbor", tokenIndex: null, storageMode: "github", localRepositoryId, activeBranch: "main", addedAt: "2024-01-01T00:00:00.000Z" },
  });
  await page.goto(`app/books/${BOOK_ID}/chapters/001-the-arrival/paragraphs/001`);
  await expect(page.getByRole("button", { name: "Edit paragraph" })).toBeVisible({ timeout: 30_000 });
  const pill = page.getByTestId("repository-pill");
  await expect(pill).toHaveText("Clean", { timeout: 20_000 });
  await page.waitForTimeout(3000);
  await expect(pill).toHaveText("Clean");
});
