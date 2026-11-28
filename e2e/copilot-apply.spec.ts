import { expect, test, type Page } from "@playwright/test";
import { ACCOUNT_IDENTITY, engineModule, openApp, seed, settingsOf, startProvider, waitForAiSettings, type SeedBook, type StubProvider } from "./helpers/autopilot";

// A change of the Copilot on a book on GitHub whose working copy holds work that GitHub does not have yet (issue #124: the owner applied a page proposal of the
// ghostwriters twice and was told something had to be committed first). With GitHub out of reach the first proposal is applied and kept on this device; with an
// edit that is not a commit yet added to it, the second one is applied too, and the book's normal sync sends all of it, in order, at once, never forced.

test.use({ serviceWorkers: "block" });

const BOOK = { id: "book-jesus", repo: "e2e-jesus", name: "Jesus" };
const GITHUB = { owner: "KeyserDSoze", repo: "Jesus", branch: "main", token: "e2e-github-token" };
const REPOSITORY_ID = `${ACCOUNT_IDENTITY}::${GITHUB.branch}`;

async function book(): Promise<SeedBook> {
  const { MemoryBookStore, seedBookFiles } = await engineModule("testing/index.js");
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: BOOK.name }));
  return { ...BOOK, files: store.toObject(), github: GITHUB };
}

interface Network { reachable: boolean; pushes: string[]; trees: string[][]; refs: Array<{ sha: string; force?: boolean }>; messages: string[] }

/** GitHub as the sync finds it: the branch is at `head-base`, takes what is pushed and moves to it. Out of reach, every request fails as a lost connection does. */
async function mockGitHub(page: Page, paths: string[]): Promise<Network> {
  const network: Network = { reachable: true, pushes: [], trees: [], refs: [], messages: [] };
  let head = "head-base";
  await page.route("https://api.github.com/**", async (route) => {
    if (!network.reachable) return route.abort("internetdisconnected");
    const request = route.request();
    const method = request.method();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (new RegExp(`/repos/${GITHUB.owner}/${GITHUB.repo}$`, "i").test(path)) return route.fulfill({ json: { id: 1, name: GITHUB.repo, full_name: `${GITHUB.owner}/${GITHUB.repo}`, default_branch: GITHUB.branch, permissions: { pull: true, push: true } } });
    if (/\/branches$/.test(path)) return route.fulfill({ json: [{ name: GITHUB.branch, commit: { sha: head }, protected: false }] });
    if (method === "GET" && path.endsWith(`/git/ref/heads/${GITHUB.branch}`)) return route.fulfill({ json: { ref: `refs/heads/${GITHUB.branch}`, object: { type: "commit", sha: head } } });
    const commit = /\/git\/commits\/(.+)$/.exec(path)?.[1];
    if (method === "GET" && commit) return route.fulfill({ json: { sha: commit, tree: { sha: commit === "head-base" ? "tree-base" : "tree-pushed" }, parents: [] } });
    if (method === "GET" && /\/git\/trees\/(.+)$/.test(path)) return route.fulfill({ json: { sha: "tree-base", truncated: false, tree: paths.map((entry, index) => ({ path: entry, mode: "100644", type: "blob", sha: `blob-${index}`, size: 10 })) } });
    if (method === "POST" && /\/git\/trees$/.test(path)) {
      network.pushes.push(path);
      network.trees.push((request.postDataJSON() as { tree: Array<{ path: string }> }).tree.map((entry) => entry.path));
      return route.fulfill({ status: 201, json: { sha: "pushed-tree" } });
    }
    if (method === "POST" && /\/git\/commits$/.test(path)) {
      network.pushes.push(path);
      network.messages.push((request.postDataJSON() as { message: string }).message);
      return route.fulfill({ status: 201, json: { sha: "pushed-commit", tree: { sha: "pushed-tree" } } });
    }
    if (method === "POST" && /\/git\/blobs$/.test(path)) {
      network.pushes.push(path);
      return route.fulfill({ status: 201, json: { sha: `pushed-blob-${network.pushes.length}` } });
    }
    if (method === "PATCH" && path.endsWith(`/git/refs/heads/${GITHUB.branch}`)) {
      const body = request.postDataJSON() as { sha: string; force?: boolean };
      network.refs.push(body);
      head = body.sha;
      return route.fulfill({ json: { ref: `refs/heads/${GITHUB.branch}`, object: { sha: head } } });
    }
    return route.fulfill({ status: 404, json: { message: "Not Found" } });
  });
  return network;
}

/** What the working copy on this device holds: its files (with their state) and the local commits GitHub does not have. */
const workingCopy = (page: Page) => page.evaluate((repositoryId) => new Promise<{ files: Array<{ path: string; text: string; status: string; committed: boolean }>; unsent: string[] }>((resolve) => {
  const open = indexedDB.open("narrarium-local-repositories");
  open.onsuccess = () => {
    const db = open.result;
    const tx = db.transaction(["files", "commits"], "readonly");
    const files = tx.objectStore("files").getAll();
    const commits = tx.objectStore("commits").getAll();
    tx.oncomplete = () => {
      db.close();
      resolve({
        files: (files.result as Array<{ repoId: string; path: string; text: string; status: string; committed: boolean }>).filter((file) => file.repoId === repositoryId).map(({ path, text, status, committed }) => ({ path, text, status, committed })),
        unsent: (commits.result as Array<{ repoId: string; message: string; pushed?: boolean }>).filter((commit) => commit.repoId === repositoryId && !commit.pushed).map((commit) => commit.message),
      });
    };
  };
}), REPOSITORY_ID);

let ai: StubProvider;
let turn = 0;
test.beforeAll(async () => {
  ai = await startProvider({
    answers: {
      copilot_turn: () => {
        turn += 1;
        const name = turn === 1 ? "Warm Voice" : "Dry Voice";
        return { reply: `Here is the proposal: a new ghostwriter, ${name}.`, calls: [{ tool: "propose_ghostwriter_changes", args: { create: [{ name, tone: turn === 1 ? "warm" : "dry" }] } }] };
      },
    },
  });
});
test.afterAll(async () => { await ai.close(); });

test("a page proposal of the Copilot is applied on a book with a local commit and an edit not saved yet, and the sync sends it with the rest", async ({ page }) => {
  const seeded = await book();
  const network = await mockGitHub(page, Object.keys(seeded.files));
  await page.addInitScript(() => { window.__NARRARIUM_ENABLE_E2E_BRIDGE__ = true; });
  await seed(page, settingsOf(ai.url, [seeded]), [seeded]);
  await openApp(page);
  await page.goto("app/books", { waitUntil: "domcontentloaded" });
  await waitForAiSettings(page, ai.url);
  await page.goto(`app/books/${BOOK.id}/ghostwriters`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Copilot", exact: true }).click();
  const panel = page.locator('[data-assistant-mode="copilot"]');
  await expect(panel).toBeVisible();

  // GitHub is out of reach: the first proposal is applied and kept on this device, as a local commit the sync has yet to send.
  network.reachable = false;
  await panel.locator("textarea").fill("Add a warm ghostwriter");
  await panel.getByRole("button", { name: "Send" }).click();
  const first = panel.locator('[data-page-review="ghostwriters"]');
  await expect(first).toBeVisible({ timeout: 30_000 });
  await first.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/It is saved on this device\. GitHub could not be reached/).first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await workingCopy(page)).unsent, { timeout: 20_000 }).toEqual(["Apply 1 Copilot file update"]);
  expect(network.pushes).toEqual([]);

  // The author's own edit, which is not a commit yet, is there too.
  await page.waitForFunction(() => Boolean(window.__narrariumE2e));
  await page.evaluate((repositoryId) => window.__narrariumE2e!.writePrimaryFile(repositoryId, "notes/scratch.md", "# Scratch\n\nMy own edit.\n"), REPOSITORY_ID);
  const before = await workingCopy(page);
  expect(before.files.find((file) => file.path === "notes/scratch.md")).toMatchObject({ status: "new", committed: false });

  // GitHub is back. The second proposal used to be refused («the local working copy must be clean», «push or discard existing local commits»).
  network.reachable = true;
  await panel.locator("textarea").fill("Add a dry ghostwriter");
  await panel.getByRole("button", { name: "Send" }).click();
  const second = panel.locator('[data-page-review="ghostwriters"]').last();
  await expect(second.getByRole("button", { name: "Apply" })).toBeVisible({ timeout: 30_000 });
  await second.getByRole("button", { name: "Apply" }).click();

  await expect(page.getByText("Applied and synchronised: 1 change of yours and 2 earlier ones").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/local working copy must be clean|Push or discard/)).toHaveCount(0);
  // One push, in order: the first proposal, the author's edit and this proposal in the same commit, on top of GitHub's head, never forced.
  expect(network.trees).toHaveLength(1);
  expect(network.trees[0].sort()).toEqual(["ghostwriters/dry-voice.md", "ghostwriters/warm-voice.md", "notes/scratch.md"]);
  expect(network.refs).toHaveLength(1);
  expect(network.refs[0].force).not.toBe(true);
  const after = await workingCopy(page);
  expect(after.unsent).toEqual([]);
  expect(after.files.filter((file) => file.status !== "clean")).toEqual([]);
  expect(after.files.find((file) => file.path === "ghostwriters/warm-voice.md")?.text).toContain("Warm Voice");
  expect(after.files.find((file) => file.path === "ghostwriters/dry-voice.md")?.text).toContain("Dry Voice");
  expect(after.files.find((file) => file.path === "notes/scratch.md")?.text).toContain("My own edit.");
});
