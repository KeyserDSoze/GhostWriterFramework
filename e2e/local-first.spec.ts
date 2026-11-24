import { expect, test, type Page } from "@playwright/test";

// A book kept only on this device, in a workspace with no account and no GitHub credential, with GitHub out of reach: every page and every feature
// that does not need GitHub works from the working copy in IndexedDB, none sends a request to GitHub, and what needs GitHub says so in words.

test.use({ serviceWorkers: "block" });

const CHAPTER = "001-the-gate";
const files = [
  { path: `chapters/${CHAPTER}/chapter.md`, text: "---\ntype: chapter\nid: chapter:001-the-gate\nnumber: 1\ntitle: The Gate\n---\n\nThe first chapter.\n" },
  { path: `chapters/${CHAPTER}/001-opening.md`, text: "---\ntype: paragraph\nid: paragraph:001-the-gate:001-opening\nchapter: chapter:001-the-gate\nnumber: 1\ntitle: Opening\n---\n\nThe gate stood open beneath a sky the color of old steel.\n" },
  { path: `drafts/${CHAPTER}/001-opening.md`, text: "---\ntype: paragraph-draft\nid: paragraph:001-the-gate:001-opening\nnumber: 1\n---\n\nA rough first pass at the gate.\n" },
  { path: "characters/mara.md", text: "---\ntype: character\nid: character:mara\nname: Mara\n---\n\nThe gatekeeper.\n" },
];

/** What a page of a book kept on this device must never show: the raw text of a GitHub read or of a network error. */
const RAW_ERROR = /content read failed|REPOSITORY_[A-Z_]+|Failed to fetch|NetworkError|TypeError|Load failed|could not be reached|is not in the local working copy|HttpError|Bad credentials|Push or discard|must be clean/i;

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`);
  });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

async function shownProblems(page: Page): Promise<string[]> {
  const texts = await page.locator('[role="alert"], [role="status"]').allInnerTexts().catch(() => []);
  return texts.map((text) => text.trim()).filter((text) => RAW_ERROR.test(text));
}

async function createLocalBook(page: Page, title: string): Promise<string> {
  await page.goto("app/books/add");
  await page.getByPlaceholder("The Clockmaker's Daughter").fill(title);
  await page.getByRole("button", { name: "Create local book" }).click();
  await page.waitForURL((url) => /\/app\/books\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/add"));
  return decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
}

/** The scenes of a first chapter and a character, written into the working copy as the author would. */
async function addFiles(page: Page, bookId: string): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__narrariumE2e));
  const repositories = await page.evaluate(() => new Promise<Array<{ id: string; bookId: string }>>((resolve, reject) => {
    const open = indexedDB.open("narrarium-local-repositories");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("repositories", "readonly").objectStore("repositories").getAll();
      request.onsuccess = () => { db.close(); resolve(request.result as Array<{ id: string; bookId: string }>); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }));
  const repoId = repositories.find((repository) => repository.bookId === bookId)?.id;
  expect(repoId, JSON.stringify(repositories)).toBeTruthy();
  const result = await page.evaluate(({ repoId, files }) => window.__narrariumE2e!.writePrimaryFiles(repoId!, files), { repoId, files });
  expect(result.error).toBeNull();
}

test("a book kept on this device works on every page without GitHub", async ({ page }) => {
  test.setTimeout(240_000);
  const github = watchGitHub(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => { window.__NARRARIUM_ENABLE_E2E_BRIDGE__ = true; });

  const bookId = await createLocalBook(page, "The Glass Gate");
  await addFiles(page, bookId);
  await page.reload();
  const book = `app/books/${bookId}`;
  const chapter = `${book}/chapters/${CHAPTER}`;
  const paragraph = `${chapter}/paragraphs/001`;

  // The repository pill: the new files are local changes; a sync of a book kept on this device saves them here, and the pill says so.
  await expect(page.locator('[data-route-ready="BookPage"]')).toBeAttached();
  const pill = page.getByRole("button", { name: /local changes/ });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await pill.click();
  await expect(page.getByText("This book is kept on this device: fetch, pull and push need GitHub. Connect it to GitHub from the book settings.")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Fetch" })).toBeDisabled();
  await page.getByRole("button", { name: "Full sync" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Book saved locally" }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Local only" })).toBeVisible({ timeout: 15_000 });

  // The repository status: what the book has, and what needs GitHub said in words instead of buttons that fail.
  await page.getByRole("button", { name: "Local only" }).click();
  await page.getByRole("menuitem", { name: "View status" }).click();
  const status = page.getByRole("dialog");
  await expect(status.getByText("This device only")).toBeVisible();
  await expect(status.getByText(/This book is kept on this device: sync, fetch, pull, push and re-clone need GitHub/)).toBeVisible();
  await expect(status.getByRole("button", { name: "Force re-clone from GitHub" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const routes: Array<[string, string, string?]> = [
    ["app/books", "BooksPage", "The Glass Gate"],
    [book, "BookPage"],
    [`${book}/dashboard`, "BookDashboardPage", "This device only"],
    [`${book}/outline`, "OutlinePage"],
    [`${book}/autopilot`, "AutopilotPage"],
    [`${book}/autopilot/settings`, "AutopilotSettingsPage"],
    [`${book}/director`, "DirectorPage"],
    [`${book}/assets`, "AssetGalleryPage"],
    [`${book}/reader`, "ReaderPreviewPage", "The gate stood open beneath a sky the color of old steel."],
    [`${book}/export`, "BookExportPage"],
    [`${book}/research`, "DeepResearchPage"],
    [`${book}/ghostwriters`, "GhostwritersPage"],
    [`${book}/evaluation-style`, "EvaluationStylePage"],
    [`${book}/simulated-readers`, "ReaderPersonasPage"],
    [`${book}/settings`, "BookSettingsPage", "Branches live on GitHub. Connect this book to GitHub to use them."],
    [`${book}/audit`, "AuditPage", "No audit report yet"],
    [`${book}/canon/characters/mara`, "CanonEntityPage", "The gatekeeper."],
    [chapter, "ChapterPage", "Opening"],
    [`${chapter}/workspace/draft`, "WorkspaceDocPage"],
    [`${chapter}/drafts`, "DraftStageRoute"],
    [`${chapter}/scripts`, "ScriptStageRoute"],
    [`${chapter}/reader-evaluations`, "ReaderEvaluationsPage"],
    [`${chapter}/audit`, "AuditPage", "No audit report yet"],
    [paragraph, "ParagraphPage", "The gate stood open beneath a sky the color of old steel."],
    [`${paragraph}/workspace/draft`, "WorkspaceDocPage"],
    [`${paragraph}/workspace/script`, "WorkspaceDocPage"],
    [`${paragraph}/reader-evaluations`, "ReaderEvaluationsPage"],
    [`${paragraph}/audit`, "AuditPage", "No audit report yet"],
    [`${paragraph}/split`, "ParagraphSplitPage"],
    ["app/chats", "AssistantChatsPage"],
    ["app/autopilot", "AutopilotHubPage"],
    ["app/settings", "SettingsPage"],
    ["app/settings/github", "SettingsPage"],
    ["app/settings/repository", "SettingsPage"],
    ["app/account-sync", "AccountSyncPage"],
    ["app/custom-actions", "CustomActionsPage"],
    ["app/costs", "CostsPage"],
    ["app/reader-settings", "ReaderSettingsPage"],
  ];
  for (const [route, component, text] of routes) {
    await page.goto(route);
    await expect(page.locator(`[data-route-ready="${component}"]`), route).toBeAttached({ timeout: 15_000 });
    if (text) await expect(page.getByText(text, { exact: false }).first(), route).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    expect(await shownProblems(page), route).toEqual([]);
  }

  // The settings of a book kept on this device: its name and its audits are its own to change, and only the branches need GitHub.
  await page.goto(`${book}/settings`);
  await expect(page.locator('[data-route-ready="BookSettingsPage"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator("#book-name")).toHaveValue("The Glass Gate");
  await expect(page.getByText("Audit settings", { exact: true })).toBeVisible();

  // The actions of the book (the floating panel of a phone): the commit history and the pull requests need GitHub, and the panel says so instead of offering them.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(book);
  await expect(page.locator('[data-route-ready="BookPage"]')).toBeAttached();
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await expect(page.getByText("Commit history and pull requests need GitHub. Connect this book to GitHub from its settings to use them.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Commits" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PRs" })).toHaveCount(0);

  expect(github).toEqual([]);
  expect(pageErrors).toEqual([]);
});
