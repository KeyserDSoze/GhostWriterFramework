import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";

// A private book on GitHub whose reader was updated on this device and not on GitHub, with GitHub Actions refused for its budget, and the repository
// made public and private again from the book settings: GitHub is stubbed, and every request it gets is kept.

test.use({ serviceWorkers: "block" });

const template = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "narrarium-site", "src", "narrarium", "bookTemplate.generated.json"), "utf8")) as { placeholders: { readerPackage: string }; files: Record<string, { text: string }> };
const V1 = readFileSync(path.join(__dirname, "..", "src", "narrarium-site", "test-browser", "fixtures", "pagesWorkflowV1.yml"), "utf8");
const LEGACY = V1.replace("          SITE_BASE:", "          NARRARIUM_READER_PASSWORD: ${{ secrets.BOOK_PASSWORD }}\n          SITE_BASE:");
const CURRENT = planPagesWorkflowUpgrade(LEGACY).text;
const WORKFLOW_PATH = ".github/workflows/deploy-reader-pages.yml";
const BOOK = { id: "book-gh", owner: "keyser", repo: "jesus", name: "Jesus", tokenIndex: null, activeBranch: "main", addedAt: "2026-11-01T00:00:00.000Z" };
const sha = (n: number) => String(n).padStart(40, "0");

/** The working copy of the book: the reader and the workflow already at the current version, the book's own files, and what Narrarium keeps. */
function workingCopy(): Map<string, string> {
  const files = new Map<string, string>();
  files.set("book.md", "---\ntype: book\nid: book\ntitle: Jesus\nlanguage: en\n---\n");
  files.set("chapters/001-the-road/chapter.md", "---\ntype: chapter\nid: chapter:001-the-road\nnumber: 1\ntitle: The Road\n---\n\nIt began.\n");
  files.set("secrets/the-key.md", "---\ntype: secret\nid: secret:the-key\ntitle: The key\n---\n\nHidden.\n");
  files.set("secrets/other.md", "---\ntype: secret\nid: secret:other\ntitle: Other\n---\n\nHidden too.\n");
  files.set("director.md", "---\ntype: director\n---\n\nThe author's voice.\n");
  for (const [path, file] of Object.entries(template.files)) if (path.startsWith("reader/")) files.set(path, file.text.split(template.placeholders.readerPackage).join("jesus-reader"));
  files.set(WORKFLOW_PATH, CURRENT);
  return files;
}

interface Github {
  requests: Array<{ method: string; path: string; body?: unknown }>;
  state: { private: boolean; pagesOn: boolean; unpublishOnPrivate: boolean; patchFailure: { status: number; message: string } | null; runs: unknown[]; jobs: unknown[]; annotations: Record<number, unknown[]> };
}

async function seed(page: Page): Promise<void> {
  await page.addInitScript((books) => {
    const user = { provider: "google", providerAccountId: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" };
    const now = Date.now();
    localStorage.setItem("narrarium-onboarding-completed", "1");
    localStorage.setItem("narrarium-local-workspace-id-v1", "e2e-workspace");
    localStorage.setItem("narrarium-account-scope-v1", "workspace:e2e-workspace");
    const cached = { schemaVersion: 2, accountScope: "google:e2e-google-user", baseRevision: "1", base: { ui: { language: "en", theme: "light" }, repository: { autoFetchOnOpen: false, autoFetchIntervalMinutes: 0, autoPullWhenClean: false, autoSync: "off" }, books } };
    localStorage.setItem(`narrarium-settings-cache-v2:${encodeURIComponent("google:e2e-google-user")}`, JSON.stringify(cached));
    sessionStorage.setItem(`narrarium-settings-credentials-v1:${encodeURIComponent("google:e2e-google-user")}`, JSON.stringify({ defaultGitHubToken: "ghp_e2e_token_1234", extraGitHubTokens: [], azureOpenAIApiKey: "", integrationApiKeys: {}, deepSearchApiKeys: { braveApiKey: "", tavilyApiKey: "" }, bookTokens: {} }));
    localStorage.setItem("narrarium-account-continuity-v1", JSON.stringify({ version: 1, accounts: { google: { version: 1, provider: "google", providerAccountId: user.providerAccountId, normalizedEmail: user.email, lastSeenAt: now } } }));
    sessionStorage.setItem("narrarium-auth-session-v1", JSON.stringify({ version: 1, state: { accessToken: "e2e-google-token", accessTokenExpiry: now + 3_600_000, provider: user.provider, providerAccountId: user.providerAccountId, user }, savedAt: now }));
  }, [BOOK]);
}

async function stubGitHub(page: Page, remoteWorkflow: string): Promise<Github> {
  const github: Github = { requests: [], state: { private: true, pagesOn: true, unpublishOnPrivate: false, patchFailure: null, runs: [], jobs: [], annotations: {} } };
  await page.route("https://www.googleapis.com/**", async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q") ?? "";
    if (url.pathname === "/oauth2/v3/userinfo") return route.fulfill({ json: { sub: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" } });
    if (url.pathname === "/drive/v3/about") return route.fulfill({ json: { user: { permissionId: "e2e-google-user", emailAddress: "e2e@example.test" } } });
    if (url.pathname === "/drive/v3/files/root") return route.fulfill({ json: { id: "e2e-root" } });
    if (url.pathname === "/drive/v3/files" && q.includes("mimeType=")) return route.fulfill({ json: { files: [{ id: "e2e-folder", name: "Narrarium", createdTime: "2024-01-01T00:00:00.000Z", mimeType: "application/vnd.google-apps.folder", parents: ["e2e-root"], trashed: false, ownedByMe: true }] } });
    if (url.pathname === "/drive/v3/files" && q.includes("settings.json")) return route.fulfill({ json: { files: [{ id: "e2e-settings", name: "settings.json", parents: ["e2e-folder"], trashed: false, ownedByMe: true, mimeType: "application/json", modifiedTime: "2026-11-01T00:00:00.000Z" }] } });
    if (url.pathname === "/drive/v3/files/e2e-settings" && url.searchParams.has("alt")) return route.fulfill({ json: { version: 2, defaultGitHubToken: "ghp_e2e_token_1234", extraGitHubTokens: [], repository: {}, books: [BOOK] } });
    if (url.pathname === "/drive/v3/files/e2e-settings") return route.fulfill({ json: { id: "e2e-settings", name: "settings.json", parents: ["e2e-folder"], trashed: false, ownedByMe: true, mimeType: "application/json", modifiedTime: "2026-11-01T00:00:00.000Z" } });
    return route.fulfill({ json: { files: [], nextPageToken: null } });
  });

  const files = workingCopy();
  const blobs = new Map<string, string>();
  const entries: Array<Record<string, unknown>> = [];
  let index = 0;
  for (const [path, text] of files) { index += 1; blobs.set(sha(index), text); entries.push({ path, mode: "100644", type: "blob", sha: sha(index), size: Buffer.byteLength(text) }); }
  const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "x-oauth-scopes, x-ratelimit-remaining, x-ratelimit-reset, link, x-accepted-github-permissions" };

  await page.route("https://api.github.com/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    const method = request.method();
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, json: data, headers: { ...cors, ...headers } });
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    let body: unknown;
    try { body = request.postDataJSON(); } catch { body = undefined; }
    github.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
    if (path === "/user") return json({ login: "keyser", id: 1 }, 200, { "x-oauth-scopes": "repo, workflow" });
    if (path === "/user/orgs") return json([]);
    const repo = /^\/repos\/keyser\/jesus(\/.*)?$/.exec(path);
    if (!repo) return json({ message: `unexpected ${path}` }, 500);
    const rest = repo[1] ?? "";
    if (rest === "" && method === "GET") return json({ id: 7, name: "jesus", full_name: "keyser/jesus", owner: { login: "keyser", type: "User" }, private: github.state.private, visibility: github.state.private ? "private" : "public", archived: false, default_branch: "main", html_url: "https://github.com/keyser/jesus", permissions: { admin: true, push: true, pull: true } });
    if (rest === "" && method === "PATCH") {
      if (github.state.patchFailure) return json({ message: github.state.patchFailure.message }, github.state.patchFailure.status, github.state.patchFailure.status === 403 ? { "x-accepted-github-permissions": "administration=write" } : {});
      github.state.private = (body as { private?: boolean }).private === true;
      if (github.state.private && github.state.unpublishOnPrivate) github.state.pagesOn = false;
      return json({ id: 7, private: github.state.private });
    }
    if (rest === "/git/ref/heads/main" || rest === "/git/refs/heads/main") return json({ ref: "refs/heads/main", object: { sha: sha(9000), type: "commit" } });
    if (rest === `/git/commits/${sha(9000)}`) return json({ sha: sha(9000), tree: { sha: sha(9001) }, parents: [] });
    if (rest.startsWith("/git/trees/")) return json({ sha: sha(9001), truncated: false, tree: entries });
    const blob = /^\/git\/blobs\/(.+)$/.exec(rest);
    if (blob) return route.fulfill({ status: 200, contentType: "text/plain", body: blobs.get(blob[1]) ?? "", headers: cors });
    if (rest.startsWith("/branches")) return json([{ name: "main", commit: { sha: sha(9000) }, protected: false }]);
    if (rest === "/pages" && method === "GET") return github.state.pagesOn ? json({ html_url: "https://keyser.github.io/jesus/", build_type: "workflow", status: "built", public: true }) : json({ message: "Not Found" }, 404);
    if (rest === "/pages" && method === "DELETE") { github.state.pagesOn = false; return route.fulfill({ status: 204, headers: cors }); }
    if (rest === "/actions/secrets") return json({ total_count: 1, secrets: [{ name: "NARRARIUM_READER_PASSWORD" }] });
    if (rest === "/actions/secrets/public-key") return json({ key_id: "k1", key: Buffer.alloc(32, 7).toString("base64") });
    if (rest.startsWith("/actions/variables/READER_PASSWORD_SECRETS")) return json({ message: "Not Found" }, 404);
    if (/^\/actions\/workflows\/[^/]+\/disable$/.test(rest)) return route.fulfill({ status: 204, headers: cors });
    if (/^\/actions\/workflows\/[^/]+$/.test(rest)) return json({ id: 1, state: "active" });
    if (/^\/actions\/workflows\/[^/]+\/runs$/.test(rest)) return json({ total_count: github.state.runs.length, workflow_runs: github.state.runs });
    if (/^\/actions\/runs\/\d+\/jobs$/.test(rest)) return json({ total_count: github.state.jobs.length, jobs: github.state.jobs });
    const annotations = /^\/check-runs\/(\d+)\/annotations$/.exec(rest);
    if (annotations) return json(github.state.annotations[Number(annotations[1])] ?? []);
    if (rest.startsWith(`/contents/${WORKFLOW_PATH}`)) return json({ type: "file", name: "deploy-reader-pages.yml", path: WORKFLOW_PATH, content: Buffer.from(remoteWorkflow).toString("base64"), encoding: "base64", sha: sha(55) });
    if (rest.startsWith("/compare") || rest.startsWith("/commits")) return json({ sha: sha(9000) });
    return json({ message: `unexpected ${method} ${path}` }, 500);
  });
  return github;
}

/** The book is opened before its settings, as in the app: opening it makes the working copy on this device. */
async function openBook(page: Page): Promise<void> {
  await page.goto("app/books/book-gh");
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    const open = indexedDB.open("narrarium-local-repositories");
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("repositories")) { db.close(); resolve(false); return; }
      const request = db.transaction("repositories", "readonly").objectStore("repositories").getAll();
      request.onsuccess = () => { db.close(); resolve((request.result as Array<{ owner?: string; repo?: string; cloneComplete?: boolean }>).some((row) => row.owner === "keyser" && row.repo === "jesus" && row.cloneComplete === true)); };
      request.onerror = () => { db.close(); resolve(false); };
    };
  })), { timeout: 90_000, intervals: [500] }).toBe(true);
}

test("the reader card says «updated on this device, not yet on GitHub», names the Actions budget, and takes the old reader offline", async ({ page }) => {
  test.setTimeout(240_000);
  await seed(page);
  const github = await stubGitHub(page, LEGACY);
  github.state.runs = [{ id: 31, status: "completed", conclusion: "failure", html_url: "https://github.com/keyser/jesus/actions/runs/31", created_at: "2026-11-26T21:53:00Z", head_branch: "main", head_sha: sha(9000), event: "workflow_dispatch" }];
  github.state.jobs = [{ id: 41, name: "build", conclusion: "failure", steps: [] }];
  github.state.annotations[41] = [{ message: "The job was not started because an Actions budget is preventing further use." }];
  await openBook(page);

  await page.goto("app/books/book-gh/settings#reader");
  const card = page.getByTestId("reader-update-card");
  const onDevice = card.getByTestId("reader-on-device");
  await expect(onDevice).toBeVisible({ timeout: 60_000 });
  await expect(onDevice.getByText("Updated on this device, not yet on GitHub")).toBeVisible();
  await expect(onDevice.getByText(/On GitHub the workflow is the old one/)).toBeVisible();
  await expect(card.getByText(/up to date/i)).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Sync now" })).toBeEnabled();

  // The reason the published reader cannot be built: from the annotation of the job that never started, in the update card and in Reader access.
  const failure = card.getByTestId("reader-run-failure");
  await expect(failure).toHaveAttribute("data-cause", "budget");
  await expect(failure.getByText("GitHub Actions cannot run: the budget or billing blocks it")).toBeVisible();
  await expect(failure.getByRole("link", { name: /Open GitHub billing/ })).toHaveAttribute("href", "https://github.com/settings/billing");
  await expect(page.getByTestId("reader-run-failure-compact")).toBeVisible();
  expect(github.requests.some((request) => request.path === "/repos/keyser/jesus/check-runs/41/annotations")).toBe(true);

  // The immediate safe action.
  await card.getByRole("button", { name: "Turn GitHub Pages off" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn Pages off" }).click();
  await expect(page.getByTestId("reader-pages-off-result")).toContainText("GitHub Pages is off");
  expect(github.requests.filter((request) => request.method === "DELETE" && request.path === "/repos/keyser/jesus/pages")).toHaveLength(1);
  expect(github.state.pagesOn).toBe(false);
});

test("the visibility of the repository is read from GitHub and changed both ways, with the refusals explained", async ({ page }) => {
  test.setTimeout(240_000);
  await seed(page);
  const github = await stubGitHub(page, CURRENT);
  github.state.unpublishOnPrivate = true;
  await openBook(page);

  await page.goto("app/books/book-gh/settings#github");
  const card = page.getByTestId("repository-visibility-card");
  await expect(card.getByTestId("repository-visibility-state")).toContainText("Private: only you and the people you invited", { timeout: 60_000 });

  // A refusal is explained and changes nothing.
  github.state.patchFailure = { status: 404, message: "Not Found" };
  await card.getByRole("button", { name: "Make public…" }).click();
  let dialog = page.getByRole("dialog", { name: "Make jesus public?" });
  await expect(dialog.getByText(/cannot be undone for what is copied meanwhile/)).toBeVisible();
  await expect(dialog.getByTestId("repository-visibility-kept")).toContainText("secrets/ — 2 files");
  await expect(dialog.getByTestId("repository-visibility-kept")).toContainText("director.md");
  const confirm = dialog.getByRole("button", { name: "Make public" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/To confirm, type the name of the repository: jesus/).fill("jesus");
  await confirm.click();
  const alert = card.getByTestId("repository-visibility-failure");
  await expect(alert).toContainText("The visibility was not changed.");
  await expect(alert).toContainText("this credential cannot change the visibility");
  expect(github.state.private).toBe(true);

  // Allowed: public.
  github.state.patchFailure = null;
  await card.getByRole("button", { name: "Make public…" }).click();
  dialog = page.getByRole("dialog", { name: "Make jesus public?" });
  await dialog.getByLabel(/To confirm, type the name of the repository: jesus/).fill("jesus");
  await dialog.getByRole("button", { name: "Make public" }).click();
  await expect(card.getByTestId("repository-visibility-result")).toContainText("The repository is now public.");
  await expect(card.getByTestId("repository-visibility-state")).toContainText("Public: anyone on the internet");
  expect(github.requests.filter((request) => request.method === "PATCH" && request.path === "/repos/keyser/jesus").map((request) => request.body)).toEqual([{ private: false }, { private: false }]);

  // And private again: Pages is read again and says what GitHub did.
  const before = github.requests.length;
  await card.getByRole("button", { name: "Make private…" }).click();
  await page.getByRole("dialog", { name: "Make jesus private?" }).getByRole("button", { name: "Make private" }).click();
  await expect(card.getByTestId("repository-visibility-result")).toContainText("The repository is now private.");
  await expect(card.getByTestId("repository-visibility-result")).toContainText("GitHub Pages is off now");
  const after = github.requests.slice(before).map((request) => `${request.method} ${request.path}`);
  expect(after).toEqual(expect.arrayContaining(["PATCH /repos/keyser/jesus", "GET /repos/keyser/jesus", "GET /repos/keyser/jesus/pages"]));
  expect(github.state.private).toBe(true);
});
