import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterRound, PlannedChapter } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotResult } from "@/components/autopilot/AutopilotResult";
import { useAutopilotStore } from "@/autopilot/store";
import { putLocalRepository, removeLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { judgedPlan } from "./helpers/autopilotFixtures";
import { seedRun } from "./helpers/autopilotBand";
import { putCleanLocalFile } from "./helpers/localRepositorySeed";
import { GITHUB_BOOK, LOCAL_BOOK, t } from "./helpers/quickCommands";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

// The reading window of a chapter of the finished book, with the working copy of the book in a real (fake) IndexedDB: what it reads, what it shows, how it moves and closes.

const slugs = (count = 12) => new Set(Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(3, "0")}-chapter-${index + 1}`));
const slugOf = (number: number) => `${String(number).padStart(3, "0")}-chapter-${number}`;
const sceneBody = (chapter: number, scene: number) => `---\ntype: paragraph\nchapter: chapter:${slugOf(chapter)}\nnumber: ${scene}\ntitle: Scene ${chapter}.${scene}\n---\nText of ${chapter}.${scene}, first paragraph.\n\nText of ${chapter}.${scene}, second paragraph.`;
const scenePath = (chapter: number, scene: number) => `chapters/${slugOf(chapter)}/${String(scene).padStart(3, "0")}-scene-${scene}.md`;

let repoId = "";

async function seedWorkingCopy(book = LOCAL_BOOK, extra: Record<string, string> = {}, scenesOf: (chapter: number) => number = (chapter) => (chapter === 3 ? 11 : chapter === 4 ? 0 : 2)): Promise<void> {
  const repo = await putLocalRepository({ bookId: book.id, owner: book.owner, repo: book.repo, branch: "main", defaultBranch: "main", remoteHeadSha: "head", clonedAt: "2026-11-27T00:00:00.000Z", cloneComplete: true }, captureRepositoryOperationScope());
  repoId = repo.id;
  const files: Record<string, string> = { ...extra };
  for (let chapter = 1; chapter <= 12; chapter += 1) {
    files[`chapters/${slugOf(chapter)}/chapter.md`] = `---\ntype: chapter\n---\nNotes of chapter ${chapter}.`;
    for (let scene = 1; scene <= scenesOf(chapter); scene += 1) files[scenePath(chapter, scene)] = sceneBody(chapter, scene);
  }
  for (const [path, text] of Object.entries(files)) await putCleanLocalFile({ repoId: repo.id, path, kind: "text", text, size: new TextEncoder().encode(text).length });
}

const round = (director: number, patch: Partial<ChapterRound> = {}): ChapterRound => ({ director, accepted: 0, rejected: 0, ...patch });

function finished(chapters: PlannedChapter[] = judgedPlan(), book = LOCAL_BOOK) {
  return seedRun({ book, status: "completed", phase: "completed", chapters, message: "The book is complete.", statePatch: { finalDone: true, finalReview: { verdict: "approve", score: 8, text: "Good.", at: "2026-11-21T10:30:00.000Z" } }, stats: { cost: 1, aiCalls: 10, inputTokens: 1000, outputTokens: 1000, workedMs: 60_000 } });
}

/** What the history said, step by step: the state of each location the page was at. */
const states: unknown[] = [];
const hasStep = (state: unknown) => (state as { narrariumSheet?: string } | null)?.narrariumSheet === "chapter-reading";

function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  states.push(location.state);
  return <><p data-testid="where">{location.pathname}</p><button type="button" data-testid="back" onClick={() => navigate(-1)}>back</button></>;
}

function show(options: { review?: boolean; linked?: ReadonlySet<string>; book?: typeof LOCAL_BOOK } = {}) {
  const book = options.book ?? LOCAL_BOOK;
  return render(
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes>
        <Route path="*" element={<><AutopilotResult bookId="book-1" linkedSlugs={options.linked ?? slugs()} review={options.review === false ? undefined : { book, branch: "main" }} /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

const card = () => document.querySelector<HTMLElement>("[data-autopilot-result]") as HTMLElement;
const linksOf = (number: number) => Array.from(card().querySelectorAll<HTMLAnchorElement>(`a[data-chapter-link="${slugOf(number)}"]`));
const tableLink = (number: number) => linksOf(number)[0];
const readFirstLink = (): HTMLAnchorElement => within(screen.getByRole("heading", { name: t("autopilot.result.read.title") }).parentElement as HTMLElement).getAllByRole("link")[0] as HTMLAnchorElement;
const dialog = () => screen.findByRole("dialog");
const modal = () => document.querySelector<HTMLElement>("[data-chapter-reading]") as HTMLElement;
const textOf = () => document.querySelector<HTMLElement>("[data-reading-text]") as HTMLElement;

async function open(number: number): Promise<HTMLElement> {
  const link = tableLink(number);
  link.focus();
  fireEvent.click(link);
  await dialog();
  return link;
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  states.length = 0;
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  if (repoId) await removeLocalRepository(repoId, captureRepositoryOperationScope());
  repoId = "";
  await i18n.changeLanguage("en");
});

describe("a chapter link of the result", () => {
  it("opens the chapter in a window over the page, from the table of scores, with the page left where it is", async () => {
    await seedWorkingCopy();
    finished();
    show();
    expect(tableLink(2)).toHaveAttribute("href", "/app/books/book-1/chapters/002-chapter-2");
    fireEvent.click(tableLink(2));
    const opened = await dialog();
    expect(opened).toHaveAccessibleName(t("autopilot.chapterPanel.title", { number: 2, title: "Title 2" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/autopilot");
  });

  it("opens it from «Read these first» too", async () => {
    await seedWorkingCopy();
    finished();
    show();
    const link = readFirstLink();
    const slug = link.getAttribute("data-chapter-link");
    fireEvent.click(link);
    const opened = await dialog();
    expect(slug).toBe(slugOf(8));
    expect(opened).toHaveAccessibleName(t("autopilot.chapterPanel.title", { number: 8, title: "Title 8" }));
  });

  it("says it opens a dialog, to whoever hears the page", async () => {
    await seedWorkingCopy();
    finished();
    show();
    expect(tableLink(2)).toHaveAttribute("aria-haspopup", "dialog");
    expect(readFirstLink()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it.each([["Ctrl", { ctrlKey: true }], ["Cmd", { metaKey: true }], ["Shift", { shiftKey: true }], ["Alt", { altKey: true }], ["the middle button", { button: 1 }]])("opens the page, as a link does, with %s held: no window", async (_name, patch) => {
    await seedWorkingCopy();
    finished();
    show();
    const followed = fireEvent.click(tableLink(2), patch);
    expect(followed, "the click is not cancelled: the browser follows the link").toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(modal()).toBeNull();
  });

  it("is a link and nothing more when the book cannot be read from this page", async () => {
    finished();
    show({ review: false });
    expect(tableLink(2)).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(tableLink(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/chapters/002-chapter-2"));
  });
});

describe("the window of a chapter", () => {
  it("is a dialog with its name and what it is for, and the reading area has the focus so that a page key reads on", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(2);
    const opened = await dialog();
    expect(opened).toHaveAccessibleDescription(t("autopilot.result.reading.description", { position: 2, total: 12 }));
    await waitFor(() => expect(screen.getByRole("region", { name: t("autopilot.chapterPanel.title", { number: 2, title: "Title 2" }) })).toHaveFocus());
    expect(screen.getByRole("region", { name: t("autopilot.chapterPanel.title", { number: 2, title: "Title 2" }) })).toHaveAttribute("tabindex", "0");
  });

  it("shows the scenes of the chapter in order, as text that is read and not written", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(2);
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 2.2, second paragraph."));
    const scenes = Array.from(textOf().querySelectorAll("[data-reading-scene]"));
    expect(scenes.map((scene) => scene.getAttribute("data-reading-scene"))).toEqual([scenePath(2, 1), scenePath(2, 2)]);
    expect(within(scenes[0] as HTMLElement).getByRole("heading", { level: 3 })).toHaveTextContent(t("autopilot.result.reading.sceneTitled", { number: 1, title: "Scene 2.1" }));
    expect(textOf().querySelectorAll(".reader-prose p"), "the reader's rules for line breaks: «book» runs the paragraphs of a scene into one").toHaveLength(2);
    expect(textOf().textContent).not.toContain("type: paragraph");
    expect(textOf().querySelectorAll("textarea, input, [contenteditable]"), "nothing in the text can be written").toHaveLength(0);
    expect(textOf().querySelectorAll("img, a, button.reader-entity-link"), "no image, no link to the canon in the text").toHaveLength(0);
  });

  it("reads its text with the type of the reader of the app: its face, its size and its line height", async () => {
    await seedWorkingCopy();
    finished();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, reader: { ...DEFAULT_SETTINGS.reader, fontFamily: "sans", fontSize: 21, lineHeight: 1.9 } } });
    show();
    await open(2);
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 2.1"));
    expect(textOf().style.fontSize).toBe("21px");
    expect(textOf().style.lineHeight).toBe("1.9");
    expect(textOf().style.fontFamily).toContain("Inter");
    expect(textOf().className, "a line of about sixty characters, not the width of the screen").toContain("max-w-prose");
  });

  it("keeps the paragraphs of a scene apart when the reader of the app is set to the line breaks of the source", async () => {
    await seedWorkingCopy();
    finished();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, reader: { ...DEFAULT_SETTINGS.reader, lineBreakMode: "source" } } });
    show();
    await open(2);
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 2.2, second paragraph."));
    expect(textOf().querySelectorAll(".reader-prose p")).toHaveLength(4);
  });

  it("reads the working copy of the book and asks the network for nothing, on a book kept on GitHub as on one kept here", async () => {
    const fetched = vi.fn(() => Promise.reject(new Error("the window went to the network")));
    vi.stubGlobal("fetch", fetched);
    await seedWorkingCopy(GITHUB_BOOK);
    finished(judgedPlan(), GITHUB_BOOK);
    show({ book: GITHUB_BOOK });
    await open(2);
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 2.2, second paragraph."));
    expect(fetched).not.toHaveBeenCalled();
  });

  it("reads one folder: no secret, no canon, no other chapter, nothing of the chapter's own file, and the names in the text are not links", async () => {
    await seedWorkingCopy(LOCAL_BOOK, {
      "secrets/the-lie.md": "---\ntype: secret\nreveal_in: chapter:012-chapter-12\n---\nThe harbor master is the thief.",
      "characters/mira.md": "---\ntype: character\nname: Mira\n---\nMira is a keeper.",
      "chapters/002-chapter-2/drafts/001-draft.md": "A draft nobody asked for.",
      "chapters/002-chapter-2/003-scene-3.md": "---\ntype: paragraph\n---\nMira told Mira about the harbor master.",
    });
    finished();
    show();
    await open(2);
    await waitFor(() => expect(textOf()).toHaveTextContent("Mira told Mira about the harbor master."));
    const text = modal().textContent ?? "";
    for (const forbidden of ["The harbor master is the thief", "Mira is a keeper", "A draft nobody asked for", "Notes of chapter 2", "Text of 1.1", "Text of 3.1"]) expect(text, forbidden).not.toContain(forbidden);
    expect(modal().querySelectorAll("button.reader-entity-link, [data-reader-entity-path]"), "a name of the canon stays plain text").toHaveLength(0);
  });

  it("draws a long chapter a few scenes at a time, and the button for the rest gives the focus to the first scene it adds", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(3);
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 3.1"));
    expect(textOf().querySelectorAll("[data-reading-scene]"), "the first three scenes of eleven").toHaveLength(3);
    expect(textOf().textContent).not.toContain("Text of 3.4");
    const more = within(textOf()).getByRole("button", { name: t("autopilot.result.reading.more", { count: 8 }) });
    fireEvent.click(more);
    await waitFor(() => expect(textOf().querySelectorAll("[data-reading-scene]")).toHaveLength(7));
    expect(within(textOf()).getByRole("heading", { level: 3, name: t("autopilot.result.reading.sceneTitled", { number: 4, title: "Scene 3.4" }) })).toHaveFocus();
    fireEvent.click(within(textOf()).getByRole("button", { name: t("autopilot.result.reading.more", { count: 4 }) }));
    await waitFor(() => expect(textOf().querySelectorAll("[data-reading-scene]")).toHaveLength(11));
    expect(within(textOf()).queryByRole("button", { name: /Show more|Mostra altro/ })).toBeNull();
    expect(textOf().querySelector("[data-reading-end]"), "the end of the chapter is said").not.toBeNull();
  });

  it("says that the chapter has no text yet, and that the book has no working copy here, in words", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(4);
    expect(await within(await dialog()).findByText(t("autopilot.result.reading.empty"))).toBeInTheDocument();
    cleanup();
    await removeLocalRepository(repoId, captureRepositoryOperationScope());
    repoId = "";
    finished();
    show();
    await open(2);
    expect(await within(await dialog()).findByRole("alert")).toHaveTextContent(t("autopilot.result.reading.missing"));
  });

  it("is said in Italian, with the words of the app", async () => {
    await seedWorkingCopy();
    finished();
    await i18n.changeLanguage("it");
    show();
    await open(2);
    const opened = await dialog();
    expect(opened).toHaveAccessibleName(t("autopilot.chapterPanel.title", { number: 2, title: "Title 2" }));
    expect(within(opened).getByRole("button", { name: t("autopilot.result.reading.previousLabel", { chapter: "1 · Title 1" }) })).toBeInTheDocument();
    expect(within(opened).getByRole("link", { name: t("autopilot.result.reading.open") })).toBeInTheDocument();
    expect(t("autopilot.result.reading.open")).toBe("Apri la pagina del capitolo");
    await waitFor(() => expect(within(opened).getByRole("heading", { level: 3, name: t("autopilot.result.reading.sceneTitled", { number: 1, title: "Scene 2.1" }) })).toBeInTheDocument());
    expect(t("autopilot.result.reading.sceneTitled", { number: 1, title: "x" })).toBe("Scena 1 · x");
  });
});

describe("the votes and the rounds of the chapter, in the window", () => {
  it("are its final score and the readers' average, with when the readers read it, and the rounds of its review", async () => {
    await seedWorkingCopy();
    const plan = judgedPlan();
    plan[1] = { ...plan[1], score: 9, rounds: [round(6, { readers: 6.5, verdict: "revise", round: 1, accepted: 2, rejected: 1 }), round(9, { verdict: "approve", round: 2 }), { readers: 7, reading: "end", round: 2 }] };
    finished(plan);
    show();
    await open(2);
    const opened = await dialog();
    expect(within(opened).getByText(t("autopilot.result.reading.votes.final")).closest("div")).toHaveTextContent("9/10");
    const readers = opened.querySelector("[data-reading-readers]") as HTMLElement;
    expect(readers).toHaveTextContent("7/10");
    expect(readers.parentElement).toHaveTextContent(t("autopilot.result.scores.readersNowRound", { round: 2 }));
    const table = within(opened).getByRole("table", { name: t("autopilot.chapterPanel.rounds.title") });
    const rows = within(table).getAllByRole("row");
    expect(rows, "the header and three rows").toHaveLength(4);
    expect(rows[1]).toHaveTextContent(t("autopilot.chapterPanel.rounds.revise"));
    expect(rows[2]).toHaveTextContent(t("autopilot.chapterPanel.rounds.approve"));
    expect(rows[3]).toHaveTextContent(t("autopilot.chapterPanel.rounds.reading.end"));
    expect(rows[3].getAttribute("data-round-reading")).toBe("end");
  });

  it("say the readers read the text before its last corrections when they did, and the window says no more than the numbers", async () => {
    await seedWorkingCopy();
    const plan = judgedPlan();
    plan[1] = { ...plan[1], score: 9, rounds: [round(6, { readers: 6.5, verdict: "revise", round: 1 }), round(9, { verdict: "approve", round: 2 })] };
    finished(plan);
    show();
    await open(2);
    const opened = await dialog();
    const readers = opened.querySelector("[data-reading-readers]") as HTMLElement;
    expect(readers.parentElement).toHaveTextContent(/before its later corrections|before its last corrections/);
    expect(opened.textContent).not.toMatch(/problem|suggestion|finding/i);
  });

  it("have a place on a chapter nobody scored, which says so in words", async () => {
    await seedWorkingCopy();
    const plan = judgedPlan();
    plan[2] = { ...plan[2], score: undefined, rounds: undefined };
    finished(plan);
    show();
    await open(1);
    fireEvent.click(within(await dialog()).getByRole("button", { name: /^Next chapter/ }));
    fireEvent.click(within(await dialog()).getByRole("button", { name: /^Next chapter/ }));
    await waitFor(() => expect(within(modal()).getByText(t("autopilot.result.reading.votes.none"))).toBeInTheDocument());
  });
});

describe("moving between chapters in the window", () => {
  it("goes to the next and the previous chapter with the buttons, which say which chapter they lead to, and says the chapter it is on", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(2);
    const opened = await dialog();
    expect(within(opened).getByRole("button", { name: t("autopilot.result.reading.nextLabel", { chapter: "3 · Title 3" }) })).toBeInTheDocument();
    fireEvent.click(within(opened).getByRole("button", { name: /^Next chapter/ }));
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 3.1"));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName(t("autopilot.chapterPanel.title", { number: 3, title: "Title 3" }));
    expect(modal().querySelector("[data-reading-announce]")).toHaveTextContent(t("autopilot.result.reading.announce", { position: 3, total: 12, chapter: "3 · Title 3" }));
    fireEvent.click(within(modal()).getByRole("button", { name: /^Previous chapter/ }));
    fireEvent.click(within(modal()).getByRole("button", { name: /^Previous chapter/ }));
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 1.1"));
    expect(modal().querySelectorAll("[data-reading-scene]").length).toBeGreaterThan(0);
    expect(textOf().textContent).not.toContain("Text of 3.1");
  });

  it("goes with the arrow keys too, and leaves a key with a modifier to the browser", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(2);
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 2.1"));
    fireEvent.keyDown(modal(), { key: "ArrowRight", altKey: true });
    expect(textOf()).toHaveTextContent("Text of 2.1");
    fireEvent.keyDown(modal(), { key: "ArrowRight" });
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 3.1"));
    fireEvent.keyDown(modal(), { key: "ArrowLeft" });
    fireEvent.keyDown(modal(), { key: "ArrowLeft" });
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 1.1"));
  });

  it("is marked, and not turned off, at the first and at the last chapter, so that the focus stays on the button", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(1);
    const previous = within(await dialog()).getByRole("button", { name: t("autopilot.result.reading.noPrevious") });
    expect(previous).toHaveAttribute("aria-disabled", "true");
    expect(previous).not.toBeDisabled();
    previous.focus();
    fireEvent.click(previous);
    expect(previous).toHaveFocus();
    expect(modal()).toHaveAccessibleName(t("autopilot.chapterPanel.title", { number: 1, title: "Title 1" }));
    fireEvent.keyDown(modal(), { key: "ArrowLeft" });
    expect(modal()).toHaveAccessibleName(t("autopilot.chapterPanel.title", { number: 1, title: "Title 1" }));
  });

  it("goes only among the chapters the book has", async () => {
    await seedWorkingCopy();
    finished();
    show({ linked: new Set([slugOf(1), slugOf(2), slugOf(5)]) });
    await open(2);
    const opened = await dialog();
    expect(opened).toHaveAccessibleDescription(t("autopilot.result.reading.description", { position: 2, total: 3 }));
    expect(within(opened).getByRole("button", { name: t("autopilot.result.reading.nextLabel", { chapter: "5 · Title 5" }) })).toBeInTheDocument();
  });
});

describe("closing the window", () => {
  it("is done with Escape, and the focus goes back to the link that opened it", async () => {
    await seedWorkingCopy();
    finished();
    show();
    const link = await open(2);
    expect(link).not.toHaveFocus();
    fireEvent.keyDown(await dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(link).toHaveFocus());
  });

  it("is done with its button, and the focus goes back to the link all the same, also after moving to another chapter", async () => {
    await seedWorkingCopy();
    finished();
    show();
    const link = await open(2);
    fireEvent.click(within(await dialog()).getByRole("button", { name: /^Next chapter/ }));
    await waitFor(() => expect(textOf()).toHaveTextContent("Text of 3.1"));
    fireEvent.click(within(modal()).getByRole("button", { name: t("common.close") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(link).toHaveFocus());
  });

  it("leaves the page where it was, with no step of its own in the history", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(2);
    fireEvent.keyDown(await dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/autopilot"));
  });

  it("is a link to the chapter's page, which takes the place of the window", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(2);
    const link = within(await dialog()).getByRole("link", { name: t("autopilot.result.reading.open") });
    expect(link).toHaveAttribute("href", "/app/books/book-1/chapters/002-chapter-2");
    await act(async () => { fireEvent.click(link); });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/chapters/002-chapter-2"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("has a step of its own in the history while it is open, and gives it back when it is closed at once, before the step is even seen", async () => {
    await seedWorkingCopy();
    finished();
    show();
    fireEvent.click(tableLink(2));
    fireEvent.keyDown(await dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(hasStep(states[states.length - 1]), "back where it started, with no step of the window").toBe(false));
    expect(states.some(hasStep), "it had its step while it was open").toBe(true);
  });

  it("is closed by the back gesture, and the page stays where it was", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(2);
    await waitFor(() => expect(states.some(hasStep)).toBe(true));
    fireEvent.click(screen.getByTestId("back"), { bubbles: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent("/app/books/book-1/autopilot");
    expect(hasStep(states[states.length - 1])).toBe(false);
  });

  it("shows the votes and the rounds above the text on a narrow screen, behind a button that says whether they are shown", async () => {
    await seedWorkingCopy();
    finished();
    show();
    await open(2);
    const toggle = within(await dialog()).getByRole("button", { name: t("autopilot.result.reading.votes.show") });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls") as string) as HTMLElement;
    expect(panel.className, "closed on a phone, always there beside the text on a wide screen").toContain("hidden lg:block");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent(t("autopilot.result.reading.votes.hide"));
    expect(panel.className).not.toContain("hidden");
  });
});
