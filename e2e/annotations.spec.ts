import { expect, test, type Page } from "@playwright/test";

// The annotations of the reader, in a real browser, on a book kept on this device with GitHub out of reach: a passage is annotated from the
// right-click menu with a built-in tag and with the shortcut and a new tag of the book, the marks come back after a reload, follow the scene when its
// text is edited (moved, changed), and an annotation is deleted. No request goes to GitHub.

test.use({ serviceWorkers: "block" });

const CHAPTER = "001-the-gate";
const SCENE_PATH = `chapters/${CHAPTER}/001-opening.md`;
const FIRST = "the color of old steel";
const SECOND = "counting the lanterns one by one";
const sceneText = "The gate stood open beneath a sky the color of old steel. Mara waited by the wall, counting the lanterns one by one, and nobody came.";
const files = [
  { path: `chapters/${CHAPTER}/chapter.md`, text: "---\ntype: chapter\nid: chapter:001-the-gate\nnumber: 1\ntitle: The Gate\n---\n\nThe first chapter.\n" },
  { path: SCENE_PATH, text: `---\ntype: paragraph\nid: paragraph:001-the-gate:001-opening\nchapter: chapter:001-the-gate\nnumber: 1\ntitle: Opening\n---\n\n${sceneText}\n` },
];

function watchGitHub(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/^https:\/\/(?:api\.)?github\.com\//.test(request.url())) requests.push(`${request.method()} ${request.url()}`);
  });
  void page.route(/^https:\/\/(?:api\.)?github\.com\//, (route) => route.abort("internetdisconnected"));
  return requests;
}

async function createLocalBook(page: Page, title: string): Promise<string> {
  await page.goto("app/books/add");
  await page.getByPlaceholder("The Clockmaker's Daughter").fill(title);
  await page.getByRole("button", { name: "Create local book" }).click();
  await page.waitForURL((url) => /\/app\/books\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/add"));
  return decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
}

async function repositoryOf(page: Page, bookId: string): Promise<string> {
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
  return repoId!;
}

async function write(page: Page, repoId: string, writes: Array<{ path: string; text: string }>): Promise<void> {
  const result = await page.evaluate(({ repoId, writes }) => window.__narrariumE2e!.writePrimaryFiles(repoId, writes), { repoId, writes });
  expect(result.error).toBeNull();
}

async function fileText(page: Page, repoId: string, path: string): Promise<string | null> {
  return page.evaluate(({ repoId, path }) => new Promise<string | null>((resolve, reject) => {
    const open = indexedDB.open("narrarium-local-repositories");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("files", "readonly").objectStore("files").index("repoId").getAll(repoId);
      request.onsuccess = () => {
        db.close();
        const file = (request.result as Array<{ path: string; text?: string; status: string }>).find((entry) => entry.path === path && entry.status !== "deleted");
        resolve(file?.text ?? null);
      };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }), { repoId, path });
}

/** Selects `quote` in the reader as a pointer would, and returns the middle of the selection on the screen. */
async function select(page: Page, quote: string): Promise<{ x: number; y: number }> {
  return page.evaluate((quote) => {
    const prose = document.querySelector(".reader-prose")!;
    const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.nodeValue ?? "").indexOf(quote);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + quote.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`${quote} is not in the reader`);
  }, quote);
}

/**
 * The passage marked for the annotation whose mark holds `start`, and how it is drawn: a passage is one mark or more (its last word is a mark of its own,
 * kept on one line with its icon), all with the id of the annotation.
 */
async function marked(page: Page, start: string): Promise<{ text: string; underline: string | null; color: string | null; state: string | null } | null> {
  return page.evaluate((start) => {
    const marks = Array.from(document.querySelectorAll<HTMLElement>("mark.reader-annotation"));
    const first = marks.find((mark) => (mark.textContent ?? "").includes(start));
    if (!first) return null;
    const pieces = marks.filter((mark) => mark.dataset.annotationId === first.dataset.annotationId);
    return { text: pieces.map((mark) => mark.textContent).join(""), underline: first.dataset.markUnderline ?? null, color: first.dataset.markColor ?? null, state: first.dataset.anchorState ?? null };
  }, start);
}

/** Turns the pages of the reader (the cover comes first) until the scene is on the screen. */
async function showScene(page: Page): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    const visible = await page.evaluate(() => {
      const prose = document.querySelector(".reader-prose")!.getBoundingClientRect();
      const viewport = document.querySelector("article.reader-page-flow")!.parentElement!.getBoundingClientRect();
      return prose.left >= viewport.left - 1 && prose.left < viewport.right;
    });
    if (visible) return;
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForTimeout(300);
  }
  throw new Error("The scene never came on the screen.");
}

async function openReader(page: Page, bookId: string, text = "The gate stood open"): Promise<void> {
  await page.goto(`app/books/${bookId}/reader`);
  await expect(page.locator('[data-route-ready="ReaderPreviewPage"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator(".reader-prose").first()).toContainText(text, { timeout: 15_000 });
  await showScene(page);
}

test("annotating in the reader: a built-in tag from the menu, a new tag with the shortcut, marks after a reload, an edited scene, a deletion", async ({ page }) => {
  test.setTimeout(240_000);
  const github = watchGitHub(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.addInitScript(() => { window.__NARRARIUM_ENABLE_E2E_BRIDGE__ = true; });
  await page.setViewportSize({ width: 1280, height: 800 });

  const bookId = await createLocalBook(page, "The Annotated Gate");
  const repoId = await repositoryOf(page, bookId);
  await write(page, repoId, files);
  await page.reload();
  await openReader(page, bookId);

  // 1. Right click on a selection: Annotate › a note › «To rewrite».
  const first = await select(page, FIRST);
  await page.mouse.click(first.x, first.y, { button: "right" });
  const menu = page.locator("[data-no-context-menu]").filter({ has: page.getByRole("button", { name: /^Annotate/ }) }).first();
  const annotate = menu.getByRole("button", { name: /^Annotate/ });
  await expect(annotate).toBeVisible();
  await annotate.hover();
  await page.getByLabel("Note (optional)").fill("Too familiar an image.");
  await page.getByRole("group", { name: "Save with the tag" }).getByRole("button", { name: /To rewrite/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Annotation saved" }).first()).toBeVisible();
  await expect.poll(() => marked(page, "the color of")).toEqual({ text: FIRST, underline: "wavy", color: "amber", state: "exact" });
  await expect(page.getByRole("button", { name: "Annotation: To rewrite. Too familiar an image." })).toBeVisible();

  // 2. The shortcut on another selection, and a new tag of the book made in the dialog.
  await select(page, SECOND);
  await page.keyboard.press("Control+Alt+M");
  const dialog = page.getByRole("dialog", { name: "Annotate the passage" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(SECOND)).toBeVisible();
  await dialog.getByRole("button", { name: "New tag…" }).click();
  const tagDialog = page.getByRole("dialog", { name: "New tag for this book" });
  await tagDialog.getByLabel("Name").fill("Slow pace");
  await tagDialog.getByText("Dashed", { exact: true }).click();
  await tagDialog.getByText("Violet", { exact: true }).click();
  await tagDialog.getByLabel("What it means, and what the AI should do").fill("The pace slows here: cut what does not move the scene.");
  await tagDialog.getByRole("button", { name: "Create the tag" }).click();
  await expect(dialog.getByRole("radio", { name: /Slow pace/ })).toBeChecked();
  await dialog.getByLabel("Note", { exact: true }).fill("Shorter.");
  await dialog.getByRole("button", { name: "Save the annotation" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => marked(page, "counting the")).toEqual({ text: SECOND, underline: "dashed", color: "violet", state: "exact" });

  // The files of the book: one chapter file sorted by id, and the tag of the book.
  const chapterFile = await fileText(page, repoId, `annotations/chapters/${CHAPTER}.yml`);
  expect(chapterFile).toContain("paragraph: paragraph:001-the-gate:001-opening");
  expect(chapterFile).toContain(`quote: ${FIRST}`);
  expect(chapterFile).toContain("comment: Too familiar an image.");
  expect(chapterFile).toContain("tag: rewrite");
  const tagsFile = await fileText(page, repoId, "annotations/tags.yml");
  expect(tagsFile).toContain("name: Slow pace");
  expect(tagsFile).toContain("underline: dashed");

  // 3. After a reload the marks are where they were.
  await page.reload();
  await openReader(page, bookId);
  await expect.poll(() => marked(page, "the color of")).toEqual({ text: FIRST, underline: "wavy", color: "amber", state: "exact" });
  await expect.poll(() => marked(page, "counting the")).toEqual({ text: SECOND, underline: "dashed", color: "violet", state: "exact" });
  // The last word of each passage stays on the line of its icon.
  expect(await page.evaluate(() => Array.from(document.querySelectorAll(".reader-annotation-tail")).map((tail) => [tail.textContent, getComputedStyle(tail).whiteSpace]))).toEqual([["steel", "nowrap"], ["one", "nowrap"]]);
  await expect(page.getByRole("button", { name: "2 annotations to review in this scene" })).toBeVisible();

  // 4. The scene is edited: words before the first passage (moved), a word inside the second (changed).
  const edited = sceneText.replace("The gate stood open", "At dawn the gate stood wide open").replace("counting the lanterns one by one", "counting the lamps one by one");
  await write(page, repoId, [{ path: SCENE_PATH, text: files[1].text.replace(sceneText, edited) }]);
  await page.reload();
  await openReader(page, bookId, "At dawn the gate");
  await expect.poll(async () => (await marked(page, "the color of"))?.state).toBe("moved");
  await expect.poll(() => marked(page, "counting the")).toEqual({ text: "counting the lamps one by one", underline: "dashed", color: "violet", state: "edited" });

  // 5. A click on the mark opens the annotation; Delete removes it, and it stays removed.
  await page.locator("mark.reader-annotation", { hasText: "the color of" }).click();
  const editor = page.getByRole("dialog", { name: "Annotation" });
  await expect(editor.getByText("The passage moved: it was found again elsewhere in the text.")).toBeVisible();
  await editor.getByRole("button", { name: "Delete" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => marked(page, "the color of")).toBeNull();
  await page.reload();
  await openReader(page, bookId, "At dawn the gate");
  await expect(page.locator(".reader-annotation-icon")).toHaveCount(1);
  await expect.poll(() => marked(page, "the color of")).toBeNull();
  expect(await fileText(page, repoId, `annotations/chapters/${CHAPTER}.yml`)).toContain("deletedAt:");

  expect(github).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a selection gets its own toolbar: Annotate opens the sheet, and a tap on the icon of a mark opens the annotation", async ({ page }) => {
    test.setTimeout(180_000);
    const github = watchGitHub(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => { window.__NARRARIUM_ENABLE_E2E_BRIDGE__ = true; });

    const bookId = await createLocalBook(page, "The Annotated Gate");
    const repoId = await repositoryOf(page, bookId);
    await write(page, repoId, files);
    await page.reload();
    await openReader(page, bookId);

    await select(page, "Mara waited by the wall");
    const toolbar = page.getByRole("toolbar", { name: "Actions for the selected passage" });
    await expect(toolbar).toBeVisible();
    // Two targets a finger can hit.
    for (const button of await toolbar.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toolbar.getByRole("button", { name: "Annotate" }).tap();
    const sheet = page.getByRole("dialog", { name: "Annotate the passage" });
    await expect(sheet.getByText("Mara waited by the wall")).toBeVisible();
    await sheet.getByText("Keep it", { exact: true }).tap();
    await expect(sheet.getByRole("radio", { name: "Keep it" })).toBeChecked();
    await sheet.getByRole("button", { name: "Save the annotation" }).tap();
    await expect(sheet).toBeHidden();
    await expect.poll(() => marked(page, "Mara waited")).toEqual({ text: "Mara waited by the wall", underline: "solid", color: "emerald", state: "exact" });

    // The icon of the mark is a button; under a finger its target is 44 px around it.
    const icon = page.getByRole("button", { name: "Annotation: Keep it" });
    expect(await icon.evaluate((element) => [getComputedStyle(element, "::after").width, getComputedStyle(element, "::after").height])).toEqual(["44px", "44px"]);
    // A tap on a button leaves a selection where it was: the icon opens its annotation all the same.
    await select(page, "The gate stood open");
    await expect(toolbar).toBeVisible();
    await icon.tap();
    const editor = page.getByRole("dialog", { name: "Annotation" });
    await expect(editor.getByText("Mara waited by the wall")).toBeVisible();
    await editor.getByText("Later", { exact: true }).tap();
    await editor.getByRole("button", { name: "Save the changes" }).tap();
    await expect(editor).toBeHidden();
    expect(await fileText(page, repoId, `annotations/chapters/${CHAPTER}.yml`)).toContain("status: later");

    expect(github).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
