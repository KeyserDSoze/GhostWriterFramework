import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { planPagesWorkflowUpgrade } from "narrarium-astro-reader/github-pages";

// The Reader access card of a book on GitHub, in a real browser with GitHub stubbed (a small repository that keeps commits, refs, runs, secrets and the
// variable): the live state of a publication from the click to its end (queued, running with its step, succeeded, and failed with its cause), the passwords
// that are prepared while the published reader is old and become active once it is rebuilt and checked from outside, and the update of the reader when the
// author works on a branch other than the one the workflow publishes from (it lands on both, one commit each, and a protected branch offers the pull request).

test.use({ serviceWorkers: "block" });

const template = JSON.parse(readFileSync(path.join(__dirname, "..", "src", "narrarium-site", "src", "narrarium", "bookTemplate.generated.json"), "utf8")) as { placeholders: { readerPackage: string }; files: Record<string, { text: string }> };
const V1 = readFileSync(path.join(__dirname, "..", "src", "narrarium-site", "test-browser", "fixtures", "pagesWorkflowV1.yml"), "utf8");
const CURRENT = planPagesWorkflowUpgrade(V1).text;
const WORKFLOW_PATH = ".github/workflows/deploy-reader-pages.yml";
const BOOK = { id: "book-gh", owner: "keyser", repo: "jesus", name: "Jesus", tokenIndex: null, activeBranch: "main", addedAt: "2026-11-01T00:00:00.000Z" };
const SITE = "https://keyser.github.io/jesus/";
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "x-oauth-scopes, x-ratelimit-remaining, x-ratelimit-reset, link, x-accepted-github-permissions" };

async function seed(page: Page, book: typeof BOOK): Promise<void> {
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
  }, [book]);
}

async function stubGoogle(page: Page, book: typeof BOOK): Promise<void> {
  await page.route("https://www.googleapis.com/**", async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q") ?? "";
    if (url.pathname === "/oauth2/v3/userinfo") return route.fulfill({ json: { sub: "e2e-google-user", name: "E2E User", email: "e2e@example.test", picture: "" } });
    if (url.pathname === "/drive/v3/about") return route.fulfill({ json: { user: { permissionId: "e2e-google-user", emailAddress: "e2e@example.test" } } });
    if (url.pathname === "/drive/v3/files/root") return route.fulfill({ json: { id: "e2e-root" } });
    if (url.pathname === "/drive/v3/files" && q.includes("mimeType=")) return route.fulfill({ json: { files: [{ id: "e2e-folder", name: "Narrarium", createdTime: "2024-01-01T00:00:00.000Z", mimeType: "application/vnd.google-apps.folder", parents: ["e2e-root"], trashed: false, ownedByMe: true }] } });
    if (url.pathname === "/drive/v3/files" && q.includes("settings.json")) return route.fulfill({ json: { files: [{ id: "e2e-settings", name: "settings.json", parents: ["e2e-folder"], trashed: false, ownedByMe: true, mimeType: "application/json", modifiedTime: "2026-11-01T00:00:00.000Z" }] } });
    if (url.pathname === "/drive/v3/files/e2e-settings" && url.searchParams.has("alt")) return route.fulfill({ json: { version: 2, defaultGitHubToken: "ghp_e2e_token_1234", extraGitHubTokens: [], repository: {}, books: [book] } });
    if (url.pathname === "/drive/v3/files/e2e-settings") return route.fulfill({ json: { id: "e2e-settings", name: "settings.json", parents: ["e2e-folder"], trashed: false, ownedByMe: true, mimeType: "application/json", modifiedTime: "2026-11-01T00:00:00.000Z" } });
    return route.fulfill({ json: { files: [], nextPageToken: null } });
  });
}

const blobSha = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

/** The files of the book at the start: the reader from the template (the current one), the book's own, and the workflow given. */
function initialFiles(workflow: string): Map<string, string> {
  const files = new Map<string, string>();
  files.set("book.md", "---\ntype: book\nid: book\ntitle: Jesus\nlanguage: en\nghostwriter: default\n---\n");
  files.set("ghostwriters/default.md", "---\ntype: ghostwriter\nid: ghostwriter:default\nname: Default\n---\n\nWrite plainly.\n");
  files.set("chapters/001-the-road/chapter.md", "---\ntype: chapter\nid: chapter:001-the-road\nnumber: 1\ntitle: The Road\n---\n\nIt began.\n");
  for (const [file, content] of Object.entries(template.files)) if (file.startsWith("reader/")) files.set(file, content.text.split(template.placeholders.readerPackage).join("jesus-reader"));
  files.set(WORKFLOW_PATH, workflow);
  return files;
}

interface RunRecord { id: number; status: string; conclusion: string | null; event: string; head_branch: string; head_sha: string; created_at: string; run_started_at?: string; updated_at: string; html_url: string }

interface Repo {
  requests: Array<{ method: string; path: string; body?: unknown }>;
  commits: Map<string, { files: Map<string, string>; parents: string[]; message: string }>;
  refs: Map<string, string>;
  protectedBranches: Set<string>;
  pulls: Array<{ head: string; base: string; title: string }>;
  secrets: Set<string>;
  variable: { value: string | null };
  runs: RunRecord[];
  jobs: Record<number, unknown[]>;
  annotations: Record<number, unknown[]>;
  /** What the published site answers: a protected reader publishes no EPUB. */
  site: { protectedReader: boolean };
  /** A commit made by someone else on a branch. */
  commit(branch: string, files: Record<string, string>, message: string): string;
  /** A push makes a run, as GitHub does for the workflow's push trigger. */
  runOnPush: boolean;
  nextRunId: number;
}

/** A GitHub repository in memory: the Git data API (refs, commits, trees, blobs), the contents of a file at a ref, Pages, Actions (runs, jobs, secrets, variable) and pull requests. */
async function stubRepo(page: Page, options: { workflow: string; branches?: string[] }): Promise<Repo> {
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const repo: Repo = {
    requests: [], commits: new Map(), refs: new Map(), protectedBranches: new Set(), pulls: [], secrets: new Set(), variable: { value: null }, runs: [], jobs: {}, annotations: {}, site: { protectedReader: false }, runOnPush: true, nextRunId: 100,
    commit(branch, files, message) {
      const parent = repo.refs.get(branch)!;
      const next = new Map(repo.commits.get(parent)!.files);
      for (const [file, content] of Object.entries(files)) { const sha = blobSha(content); blobs.set(sha, content); next.set(file, sha); }
      const sha = `c${String(repo.commits.size + 1).padStart(6, "0")}`.padEnd(40, "0");
      repo.commits.set(sha, { files: next, parents: [parent], message });
      repo.refs.set(branch, sha);
      return sha;
    },
  };
  let counter = 0;
  const initial = new Map<string, string>();
  for (const [file, content] of initialFiles(options.workflow)) { const sha = blobSha(content); blobs.set(sha, content); initial.set(file, sha); }
  const first = `c000001`.padEnd(40, "0");
  repo.commits.set(first, { files: initial, parents: [], message: "Initial" });
  for (const branch of options.branches ?? ["main"]) repo.refs.set(branch, first);

  const filesOfTree = (id: string): { files: Map<string, string>; dir: string } => {
    const [base, ...rest] = id.split("|");
    const dir = rest.join("|");
    // A tree is named by the tree of a commit («c<commit>»), a tree that was made («n<number>»), a commit, or a branch: GitHub takes all of them.
    const files = trees.get(base) ?? repo.commits.get(base.startsWith("c") && !repo.commits.has(base) ? base.slice(1) : base)?.files ?? repo.commits.get(repo.refs.get(base) ?? "")?.files;
    if (!files) throw new Error(`unknown tree ${id}`);
    return { files, dir };
  };
  const listTree = (id: string, recursive: boolean) => {
    const { files, dir } = filesOfTree(id);
    const base = id.split("|")[0];
    const prefix = dir ? `${dir}/` : "";
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const [file, sha] of files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0 || recursive) out.push({ path: rest, mode: "100644", type: "blob", sha, size: Buffer.byteLength(blobs.get(sha) ?? "") });
      else if (!seen.has(rest.slice(0, slash))) { seen.add(rest.slice(0, slash)); out.push({ path: rest.slice(0, slash), mode: "040000", type: "tree", sha: `${base}|${prefix}${rest.slice(0, slash)}` }); }
    }
    return out;
  };
  const resolveRef = (ref: string): string | undefined => repo.refs.get(ref) ?? (repo.commits.has(ref) ? ref : undefined);

  await page.route(`${SITE}**`, async (route) => {
    const url = route.request().url();
    if (url.includes("downloads/book.epub")) return route.fulfill({ status: repo.site.protectedReader ? 404 : 200, headers: CORS, body: repo.site.protectedReader ? "Not Found" : "epub" });
    if (url.includes("version.json")) return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ protected: repo.site.protectedReader }) });
    return route.fulfill({ status: 404, headers: CORS, body: "" });
  });

  await page.route("https://api.github.com/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = decodeURIComponent(url.pathname);
    const method = request.method();
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, json: data, headers: { ...CORS, ...headers } });
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    let body: Record<string, unknown> | undefined;
    try { body = request.postDataJSON() as Record<string, unknown>; } catch { body = undefined; }
    repo.requests.push({ method, path: pathname, ...(body !== undefined ? { body } : {}) });
    if (pathname === "/user") return json({ login: "keyser", id: 1 }, 200, { "x-oauth-scopes": "repo, workflow" });
    if (pathname === "/user/orgs") return json([]);
    const match = /^\/repos\/keyser\/jesus(\/.*)?$/.exec(pathname);
    if (!match) return json({ message: `unexpected ${pathname}` }, 500);
    const rest = match[1] ?? "";
    const raw = (request.headers().accept ?? "").includes("raw");

    if (rest === "" && method === "GET") return json({ id: 7, name: "jesus", full_name: "keyser/jesus", owner: { login: "keyser", type: "User" }, private: true, visibility: "private", archived: false, default_branch: "main", html_url: "https://github.com/keyser/jesus", permissions: { admin: true, push: true, pull: true } });
    if (rest.startsWith("/branches")) return json([...repo.refs].map(([name, sha]) => ({ name, commit: { sha }, protected: repo.protectedBranches.has(name) })));

    const ref = /^\/git\/refs?\/heads\/(.+)$/.exec(rest);
    if (ref && method === "GET") { const sha = repo.refs.get(ref[1]); return sha ? json({ ref: `refs/heads/${ref[1]}`, object: { type: "commit", sha } }) : json({ message: "Not Found" }, 404); }
    if (ref && method === "PATCH") {
      const branch = ref[1];
      const sha = String(body?.sha);
      if (repo.protectedBranches.has(branch)) return json({ message: `Protected branch update failed for refs/heads/${branch}. Changes must be made through a pull request.` }, 422);
      const current = repo.refs.get(branch);
      if (!current) return json({ message: "Reference does not exist" }, 422);
      if (body?.force !== true && !repo.commits.get(sha)?.parents.includes(current)) return json({ message: "Update is not a fast forward" }, 422);
      repo.refs.set(branch, sha);
      if (repo.runOnPush) repo.runs.unshift({ id: repo.nextRunId++, status: "queued", conclusion: null, event: "push", head_branch: branch, head_sha: sha, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: "" });
      return json({ ref: `refs/heads/${branch}`, object: { sha } });
    }
    if (rest === "/git/refs" && method === "POST") {
      const branch = String(body?.ref).replace(/^refs\/heads\//, "");
      if (repo.refs.has(branch)) return json({ message: "Reference already exists" }, 422);
      repo.refs.set(branch, String(body?.sha));
      return json({ ref: body?.ref, object: { sha: body?.sha } }, 201);
    }
    const commit = /^\/git\/commits\/(.+)$/.exec(rest);
    if (commit && method === "GET") { const found = repo.commits.get(commit[1]); return found ? json({ sha: commit[1], tree: { sha: `c${commit[1]}|` }, parents: found.parents.map((sha) => ({ sha })) }) : json({ message: "Not Found" }, 404); }
    if (rest === "/git/commits" && method === "POST") {
      const files = new Map(filesOfTree(String(body?.tree)).files);
      const sha = `c${String(repo.commits.size + 1).padStart(6, "0")}`.padEnd(40, "0");
      repo.commits.set(sha, { files, parents: (body?.parents as string[]) ?? [], message: String(body?.message ?? "") });
      return json({ sha, tree: { sha: String(body?.tree) }, parents: [] }, 201);
    }
    const tree = /^\/git\/trees\/(.+)$/.exec(rest);
    if (tree && method === "GET") return json({ sha: tree[1], truncated: false, tree: listTree(tree[1], url.searchParams.has("recursive")) });
    if (rest === "/git/trees" && method === "POST") {
      const files = new Map(body?.base_tree ? filesOfTree(String(body.base_tree)).files : []);
      for (const entry of (body?.tree as Array<{ path: string; sha?: string | null; content?: string }>) ?? []) {
        if (entry.sha === null) files.delete(entry.path);
        else if (typeof entry.content === "string") { const sha = blobSha(entry.content); blobs.set(sha, entry.content); files.set(entry.path, sha); }
        else if (entry.sha) files.set(entry.path, entry.sha);
      }
      const id = `n${++counter}`;
      trees.set(id, files);
      return json({ sha: id, tree: [] }, 201);
    }
    if (rest === "/git/blobs" && method === "POST") {
      const content = body?.encoding === "base64" ? Buffer.from(String(body.content), "base64").toString("utf8") : String(body?.content);
      const sha = blobSha(content);
      blobs.set(sha, content);
      return json({ sha }, 201);
    }
    const blob = /^\/git\/blobs\/(.+)$/.exec(rest);
    if (blob && method === "GET") {
      const text = blobs.get(blob[1]);
      if (text === undefined) return json({ message: "Not Found" }, 404);
      return raw ? route.fulfill({ status: 200, contentType: "text/plain", body: text, headers: CORS }) : json({ sha: blob[1], content: Buffer.from(text).toString("base64"), encoding: "base64", size: Buffer.byteLength(text) });
    }
    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (contents && method === "GET") {
      const at = resolveRef(url.searchParams.get("ref") ?? "main");
      const sha = at ? repo.commits.get(at)?.files.get(contents[1]) : undefined;
      if (!sha) return json({ message: "Not Found" }, 404);
      return json({ type: "file", name: contents[1].split("/").pop(), path: contents[1], content: Buffer.from(blobs.get(sha)!).toString("base64"), encoding: "base64", sha });
    }
    if (rest === "/pulls" && method === "POST") {
      repo.pulls.push({ head: String(body?.head), base: String(body?.base), title: String(body?.title) });
      return json({ number: repo.pulls.length, html_url: `https://github.com/keyser/jesus/pull/${repo.pulls.length}` }, 201);
    }
    if (rest === "/pages" && method === "GET") return json({ html_url: SITE, build_type: "workflow", status: "built", public: true });
    if (rest === "/actions/secrets" && method === "GET") return json({ total_count: repo.secrets.size, secrets: [...repo.secrets].map((name) => ({ name })) });
    if (rest === "/actions/secrets/public-key") return json({ key_id: "k1", key: Buffer.alloc(32, 7).toString("base64") });
    const secret = /^\/actions\/secrets\/([^/]+)$/.exec(rest);
    if (secret && method === "PUT") { repo.secrets.add(secret[1]); return route.fulfill({ status: 201, headers: CORS }); }
    if (secret && method === "DELETE") { repo.secrets.delete(secret[1]); return route.fulfill({ status: 204, headers: CORS }); }
    if (rest.startsWith("/actions/variables/READER_PASSWORD_SECRETS")) {
      if (method === "GET") return repo.variable.value === null ? json({ message: "Not Found" }, 404) : json({ name: "READER_PASSWORD_SECRETS", value: repo.variable.value });
      if (method === "PATCH") { if (repo.variable.value === null) return json({ message: "Not Found" }, 404); repo.variable.value = String(body?.value); return route.fulfill({ status: 204, headers: CORS }); }
      if (method === "DELETE") { repo.variable.value = null; return route.fulfill({ status: 204, headers: CORS }); }
    }
    if (rest === "/actions/variables" && method === "POST") { repo.variable.value = String(body?.value); return json({}, 201); }
    if (/^\/actions\/workflows\/[^/]+$/.test(rest)) return json({ id: 1, state: "active" });
    if (/^\/actions\/workflows\/[^/]+\/dispatches$/.test(rest) && method === "POST") {
      const branch = String(body?.ref);
      repo.runs.unshift({ id: repo.nextRunId++, status: "queued", conclusion: null, event: "workflow_dispatch", head_branch: branch, head_sha: repo.refs.get(branch) ?? "", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: "" });
      return route.fulfill({ status: 204, headers: CORS });
    }
    if (/^\/actions\/workflows\/[^/]+\/runs$/.test(rest)) {
      let runs = repo.runs.slice();
      const event = url.searchParams.get("event");
      if (event) runs = runs.filter((run) => run.event === event);
      if (url.searchParams.get("status") === "success") runs = runs.filter((run) => run.conclusion === "success");
      return json({ total_count: runs.length, workflow_runs: runs.slice(0, Number(url.searchParams.get("per_page") ?? 30)).map((run) => ({ ...run, html_url: `https://github.com/keyser/jesus/actions/runs/${run.id}` })) });
    }
    const runJobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest);
    if (runJobs) { const jobs = repo.jobs[Number(runJobs[1])] ?? []; return json({ total_count: jobs.length, jobs }); }
    const run = /^\/actions\/runs\/(\d+)$/.exec(rest);
    if (run) { const found = repo.runs.find((entry) => entry.id === Number(run[1])); return found ? json({ ...found, html_url: `https://github.com/keyser/jesus/actions/runs/${found.id}` }) : json({ message: "Not Found" }, 404); }
    const annotations = /^\/check-runs\/(\d+)\/annotations$/.exec(rest);
    if (annotations) return json(repo.annotations[Number(annotations[1])] ?? []);
    if (rest.startsWith("/compare") || rest.startsWith("/commits")) return json({ sha: repo.refs.get("main") });
    return json({ message: `unexpected ${method} ${pathname}` }, 500);
  });
  return repo;
}

/** The book is opened before its settings, as in the app: opening it makes the working copy of its branch on this device. */
async function openBook(page: Page, book: typeof BOOK): Promise<void> {
  await page.goto(`app/books/${book.id}`);
  await expect.poll(() => page.evaluate((branch) => new Promise<boolean>((resolve) => {
    const open = indexedDB.open("narrarium-local-repositories");
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("repositories")) { db.close(); resolve(false); return; }
      const request = db.transaction("repositories", "readonly").objectStore("repositories").getAll();
      request.onsuccess = () => { db.close(); resolve((request.result as Array<{ owner?: string; repo?: string; branch?: string; cloneComplete?: boolean }>).some((row) => row.owner === "keyser" && row.repo === "jesus" && row.branch === branch && row.cloneComplete === true)); };
      request.onerror = () => { db.close(); resolve(false); };
    };
  }), book.activeBranch), { timeout: 90_000, intervals: [500] }).toBe(true);
}

const publication = (page: Page) => page.getByTestId("reader-publication");
const accessCard = (page: Page) => page.locator("section, div").filter({ has: page.getByRole("heading", { name: "Pages" }) }).first();

test("the live state of a publication goes from queued to succeeded and to failed, with the link that opens the run, and nothing is asked when nothing publishes", async ({ page }) => {
  test.setTimeout(240_000);
  await seed(page, BOOK);
  await stubGoogle(page, BOOK);
  const repo = await stubRepo(page, { workflow: CURRENT });
  await page.clock.install();
  await openBook(page, BOOK);
  await page.goto("app/books/book-gh/settings#reader");
  await expect(page.getByRole("heading", { name: "Pages" })).toBeVisible({ timeout: 60_000 });
  const asked = () => repo.requests.filter((request) => /\/actions\/(runs\/\d+|workflows\/[^/]+\/runs)/.test(request.path)).length;

  // Nothing is publishing: the runs are read once, with the card, and never again while it is open.
  await expect(publication(page)).toHaveCount(0);
  const idle = asked();
  await page.clock.fastForward(5 * 60_000);
  await page.waitForTimeout(500);
  expect(asked()).toBe(idle);

  // «Publish again»: the run of this click is found (workflow_dispatch on main, after the newest run that existed) and followed.
  await page.getByRole("button", { name: "Publish again" }).first().click();
  const live = publication(page);
  await expect(live).toHaveAttribute("data-phase", "queued", { timeout: 30_000 });
  const dispatch = repo.requests.find((request) => request.method === "POST" && request.path.endsWith("/dispatches"));
  expect(dispatch?.body).toEqual({ ref: "main" });
  const runId = repo.runs[0].id;
  const link = live.getByRole("link", { name: /Open the run on GitHub/ });
  await expect(link).toHaveAttribute("href", `https://github.com/keyser/jesus/actions/runs/${runId}`);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(live.getByRole("link", { name: /View all runs/ })).toHaveAttribute("href", "https://github.com/keyser/jesus/actions/workflows/deploy-reader-pages.yml");
  await expect(live.getByText("Queued: waiting for GitHub to give it a machine.")).toBeVisible();

  // It starts to run, with a step.
  repo.runs[0].status = "in_progress";
  const browserNow = await page.evaluate(() => Date.now());
  repo.runs[0].run_started_at = new Date(browserNow - 70_000).toISOString();
  repo.jobs[runId] = [{ id: 1, name: "build", status: "in_progress", conclusion: null, steps: [{ name: "Checkout", status: "completed" }, { name: "Build reader site", status: "in_progress" }, { name: "Upload Pages artifact", status: "queued" }] }];
  await page.clock.fastForward(21_000);
  await expect(live).toHaveAttribute("data-phase", "running");
  await expect(live.getByTestId("reader-publication-step")).toContainText("Step 2 of 3: Build reader site");
  await expect(live.getByTestId("reader-publication-duration")).toContainText(/1 min \d+ s so far/);

  // It succeeds: the state, the duration, and the polling stops.
  repo.runs[0].status = "completed";
  repo.runs[0].conclusion = "success";
  repo.runs[0].updated_at = new Date(Date.parse(repo.runs[0].run_started_at!) + 125_000).toISOString();
  await page.clock.fastForward(21_000);
  await expect(live).toHaveAttribute("data-phase", "succeeded");
  await expect(live.getByTestId("reader-publication-duration")).toHaveText("2 min 5 s");
  await page.waitForTimeout(500);
  const ended = asked();
  await page.clock.fastForward(3 * 60_000);
  await page.waitForTimeout(500);
  expect(asked()).toBe(ended);

  // A second publication fails for the Actions budget: the cause is said in words, and the link is the run's.
  await page.getByRole("button", { name: "Publish again" }).first().click();
  await expect(live).toHaveAttribute("data-phase", "queued", { timeout: 30_000 });
  const failedId = repo.runs[0].id;
  expect(failedId).not.toBe(runId);
  repo.runs[0].status = "completed";
  repo.runs[0].conclusion = "failure";
  repo.jobs[failedId] = [{ id: 77, name: "build", status: "completed", conclusion: "failure", steps: [] }];
  repo.annotations[77] = [{ message: "The job was not started because an Actions budget is preventing further use." }];
  await page.clock.fastForward(21_000);
  await expect(live).toHaveAttribute("data-phase", "failed");
  await expect(live.getByTestId("reader-publication-cause")).toHaveText("GitHub Actions cannot run: the budget or billing blocks it");
  await expect(live.getByRole("link", { name: /Open the run on GitHub/ })).toHaveAttribute("href", `https://github.com/keyser/jesus/actions/runs/${failedId}`);
  await expect(page.getByTestId("reader-run-failure-compact")).toHaveAttribute("data-cause", "budget");
});

test("passwords are prepared while the published reader is old, never called protected, and become active once the rebuilt reader is checked from outside", async ({ page }) => {
  test.setTimeout(240_000);
  await seed(page, BOOK);
  await stubGoogle(page, BOOK);
  // The published reader is the old one: the workflow on main does not name the passwords, and a run built by it succeeded.
  const repo = await stubRepo(page, { workflow: V1 });
  repo.runs.push({ id: 90, status: "completed", conclusion: "success", event: "push", head_branch: "main", head_sha: repo.refs.get("main")!, created_at: "2026-11-26T10:00:00Z", run_started_at: "2026-11-26T10:00:05Z", updated_at: "2026-11-26T10:02:00Z", html_url: "" });
  await page.clock.install();
  await openBook(page, BOOK);
  await page.goto("app/books/book-gh/settings#reader");
  await expect(page.getByRole("heading", { name: "Passwords" })).toBeVisible({ timeout: 60_000 });

  // The refusal is gone: a password can be added, and the note says what it is.
  await expect(page.getByTestId("reader-workflow-outdated")).toContainText("On “main”, the branch the reader is published from, the reader workflow does not read passwords yet");
  await expect(page.getByTestId("reader-add-note")).toContainText("Passwords you add now are only prepared");
  await page.getByLabel("Password", { exact: true }).fill("A-long-random-password-for-readers-1");
  await page.getByRole("button", { name: "Add password" }).click();
  await expect(page.getByText(/Done\. The password is prepared/)).toBeVisible({ timeout: 30_000 });
  // The secret and the list are on GitHub, and the old workflow is not started for them.
  expect(repo.secrets.has("READER_PASSWORD_001")).toBe(true);
  expect(repo.variable.value).toBe("READER_PASSWORD_001");
  expect(repo.requests.some((request) => request.path.endsWith("/dispatches"))).toBe(false);
  await expect(publication(page)).toHaveCount(0);

  // Prepared, never protected: the row, the status, the notice with the one action, and the exposure warning of the old reader.
  const row = page.getByTestId("reader-password").first();
  await expect(row.getByText("Prepared, not protecting yet")).toBeVisible();
  await expect(row.getByText("In use")).toHaveCount(0);
  await expect(page.getByTestId("reader-protection")).toHaveText("Passwords are prepared, but the published reader does not ask for a password yet: it is public.");
  await expect(page.getByText("The published reader asks for a password.")).toHaveCount(0);
  const notice = page.getByTestId("reader-prepared");
  await expect(notice.getByRole("heading", { name: "Prepared, not protecting yet" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Update the reader" })).toBeVisible();
  await expect(page.getByTestId("reader-update-exposure")).toContainText("Your published book is less private than it looks");
  await expect(page.getByTestId("reader-activated")).toHaveCount(0);
  await notice.getByRole("button", { name: "Check from outside" }).click();
  await expect(notice).toContainText("Checked from outside: the EPUB answered 200. It is still public.");

  // The workflow is updated and published: main has the current workflow, a run built by it succeeds, and the reader now publishes no EPUB.
  const built = repo.commit("main", { [WORKFLOW_PATH]: CURRENT }, "Update the reader");
  await page.getByRole("button", { name: "Check again" }).last().click();
  await expect(notice.getByRole("button", { name: "Publish again" })).toBeVisible({ timeout: 30_000 });
  await notice.getByRole("button", { name: "Publish again" }).click();
  await expect(publication(page)).toHaveAttribute("data-phase", "queued", { timeout: 30_000 });
  repo.runs[0].head_sha = built;
  repo.runs[0].status = "completed";
  repo.runs[0].conclusion = "success";
  repo.site.protectedReader = true;
  await page.clock.fastForward(21_000);
  await expect(publication(page)).toHaveAttribute("data-phase", "succeeded");
  // The check from outside is made once, by itself, and the card says the prepared passwords are active, without typing them again.
  await expect(publication(page).getByTestId("reader-publication-outside")).toContainText("Checked from outside: the EPUB answers 404");
  await expect(page.getByTestId("reader-activated")).toContainText("Your prepared passwords are now active");
  await expect(row.getByText("In use")).toBeVisible();
  await expect(page.getByTestId("reader-protection")).toHaveText("The published reader asks for a password.");
  await expect(page.getByTestId("reader-prepared")).toHaveCount(0);
});

const FEATURE = { ...BOOK, activeBranch: "feature/x" };

test("from a branch other than main, «Update the reader» lands on main on GitHub and on the working branch, one commit each, never forced", async ({ page }) => {
  test.setTimeout(240_000);
  await seed(page, FEATURE);
  await stubGoogle(page, FEATURE);
  const repo = await stubRepo(page, { workflow: V1, branches: ["main", "feature/x"] });
  await openBook(page, FEATURE);
  await page.goto("app/books/book-gh/settings#reader");
  const card = page.getByTestId("reader-update-card");
  const branches = card.getByTestId("reader-branches");
  await expect(branches).toBeVisible({ timeout: 60_000 });
  await expect(branches.locator('[data-branch="publishing"]')).toContainText("“main” (publishes the reader): old reader: it needs the update");
  await expect(branches.locator('[data-branch="current"]')).toContainText("“feature/x” (this branch): old reader: it needs the update");
  await expect(card.getByText(/one commit on “main”, the branch the reader is published from, directly on GitHub, and one on “feature\/x”/)).toBeVisible();

  const mainBefore = repo.refs.get("main")!;
  await card.getByRole("button", { name: "Update the reader" }).click();
  const outcome = card.getByTestId("reader-update-outcome");
  await expect(outcome.locator('[data-branch="publishing"]')).toHaveAttribute("data-status", "published", { timeout: 60_000 });
  await expect(outcome.locator('[data-branch="current"]')).toHaveAttribute("data-status", "published");

  // main: ONE commit on the head it was read at, moved forward without force; its workflow and reader files are the update's, the book's own files are not touched.
  const mainHead = repo.refs.get("main")!;
  expect(mainHead).not.toBe(mainBefore);
  expect(repo.commits.get(mainHead)!.parents).toEqual([mainBefore]);
  expect(repo.requests.filter((request) => request.method === "PATCH" && request.path.endsWith("/git/refs/heads/main")).map((request) => (request.body as { force?: boolean }).force ?? false)).toEqual([false]);
  const featureHead = repo.refs.get("feature/x")!;
  const files = (sha: string) => repo.commits.get(sha)!.files;
  expect(files(mainHead).get(WORKFLOW_PATH)).toBe(blobShaOf(planPagesWorkflowUpgrade(V1).text));
  // The same files on both branches: nothing to resolve when one is merged into the other.
  for (const file of [WORKFLOW_PATH, "reader/package.json"]) expect(files(featureHead).get(file)).toBe(files(mainHead).get(file));
  expect(files(mainHead).get("book.md")).toBe(files(mainBefore).get("book.md"));
  // The push of main makes a run: the card follows it, found by that commit.
  await expect(card.getByTestId("reader-publication")).toHaveAttribute("data-phase", "queued", { timeout: 30_000 });
});

test("when main is protected the card says it with GitHub's words, still updates the working branch, and opens a pull request that carries the update", async ({ page }) => {
  test.setTimeout(240_000);
  await seed(page, FEATURE);
  await stubGoogle(page, FEATURE);
  const repo = await stubRepo(page, { workflow: V1, branches: ["main", "feature/x"] });
  repo.protectedBranches.add("main");
  await openBook(page, FEATURE);
  await page.goto("app/books/book-gh/settings#reader");
  const card = page.getByTestId("reader-update-card");
  await expect(card.getByTestId("reader-branches")).toBeVisible({ timeout: 60_000 });
  const mainBefore = repo.refs.get("main")!;
  await card.getByRole("button", { name: "Update the reader" }).click();
  const outcome = card.getByTestId("reader-update-outcome");
  await expect(outcome.locator('[data-branch="publishing"]')).toHaveAttribute("data-status", "protected", { timeout: 60_000 });
  await expect(outcome).toContainText("“main” is protected, so GitHub did not let it be updated directly. GitHub said: “Protected branch update failed for refs/heads/main. Changes must be made through a pull request.”");
  await expect(outcome.locator('[data-branch="current"]')).toHaveAttribute("data-status", "published");
  expect(repo.refs.get("main")).toBe(mainBefore);

  await outcome.getByRole("button", { name: "Open a pull request" }).click();
  const link = outcome.getByRole("link", { name: /Open pull request #1 on GitHub/ });
  await expect(link).toHaveAttribute("href", "https://github.com/keyser/jesus/pull/1");
  await expect(link).toHaveAttribute("target", "_blank");
  expect(repo.pulls).toEqual([expect.objectContaining({ base: "main", head: expect.stringMatching(/^narrarium\/update-reader-\d{8}$/) })]);
  expect(repo.refs.get("main")).toBe(mainBefore);
  const carried = repo.refs.get(repo.pulls[0].head)!;
  expect(repo.commits.get(carried)!.parents).toEqual([mainBefore]);
  expect(repo.commits.get(carried)!.files.get(WORKFLOW_PATH)).toBe(blobShaOf(planPagesWorkflowUpgrade(V1).text));
});

function blobShaOf(text: string): string {
  return createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
}
