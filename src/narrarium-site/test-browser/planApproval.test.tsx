import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import { createAutopilotState, outlineEntryDigest, serializeOutlineChapter, type AutopilotActivity, type AutopilotPlan, type PlannedChapter, type ReaderReaction } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: undefined as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  toast: vi.fn(),
  save: vi.fn(async () => true),
  store: null as unknown,
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.store,
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { chapter, longPlan, planOf, scene } from "./helpers/autopilotFixtures";
import { activityOf, seedRun, stubWidth } from "./helpers/autopilotBand";
import { LOCAL_BOOK, T0, makeRuntime, quickName, t } from "./helpers/quickCommands";

const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const IDEA = "A harbor town built on glass hides a lie.";
const LOGLINE = "A glassmaker's daughter must expose the harbor's oldest lie before the tide takes the town.";
const PREMISE = "Mira, a glassmaker's daughter, uncovers the harbor's oldest lie.";

const CHAPTERS: PlannedChapter[] = [
  chapter(1, "planned", { title: "The key", summary: "Mira finds the key under the pier.", goal: "Set the lie in motion.", keyEvents: ["Mira finds the key", "Orrin sees her take it"], pov: ["Mira Vale"] }),
  chapter(2, "planned", { title: "The wall", summary: "The sea wall cracks during the night tide.", goal: "Raise the stakes.", keyEvents: ["The wall cracks"], reveals: ["The Wall Is Failing"] }),
  chapter(3, "planned", { title: "The light", summary: "The lighthouse goes dark for the first time in a century.", goal: "Close the first movement.", keyEvents: ["The light goes out"], ghostwriter: "night-owl" }),
];

const READERS: ReaderReaction[] = [
  { slug: "anna", name: "Anna", interest: 7, reaction: "I would read it for the harbor alone.", concerns: ["Slow start?"], wishes: ["More of the glass workshops"] },
  { slug: "ben", name: "Ben", interest: 4, reaction: "Too grim for a whole book.", concerns: ["No relief anywhere"], wishes: [] },
];

const CONCEPT = activityOf("concept", { id: "concept", phase: "concept", summary: `${LOGLINE} — 2 characters, 1 other canon entries, 1 secrets.`, changedPaths: ["story-design.md", "characters/mira-vale.md", "characters/orrin-hale.md", "locations/glass-harbor.md"], startedAt: at(0), endedAt: at(20) });
const PLANNED = activityOf("plan", { id: "plan", phase: "plan", summary: "1. The key; 2. The wall; 3. The light", startedAt: at(30), endedAt: at(60) });
const review = (summary: string, seconds: number) => activityOf("plan-review", { id: `review-${seconds}`, phase: "plan", summary, startedAt: at(seconds), endedAt: at(seconds + 20) });
const APPROVED = review("approve 8/10 — A solid plan: every chapter turns.", 100);

const character = (slug: string, name: string, role: string, line: string) => `---\ntype: character\nid: character:${slug}\nname: ${name}\nrole_tier: main\nstory_role: ${role}\nfunction_in_book: ${line}\ncanon: draft\n---\n\n# ${name}\n\n${line}\n`;

function bookFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "story-design.md": `---\ntype: note\nid: note:story-design\ntitle: Story Design\n---\n\n# Story Design\n\n> ${LOGLINE}\n\n## Premise\n\n${PREMISE}\n\n## Main Conflict\n\nThe council hides the failing sea wall.\n`,
    "characters/mira-vale.md": character("mira-vale", "Mira Vale", "protagonist", "A stubborn young glassmaker."),
    "characters/orrin-hale.md": character("orrin-hale", "Orrin Hale", "antagonist", "The harbor master, smooth and patient."),
    ...extra,
  };
}

interface Waiting {
  chapters?: PlannedChapter[];
  plan?: Partial<AutopilotPlan>;
  activities?: AutopilotActivity[];
  status?: "paused" | "idle";
  message?: string | null;
}

/** A plan that waits for the author, as the engine leaves it when it stops after the director approved it. */
function seedWaiting({ chapters = CHAPTERS, plan = {}, activities = [CONCEPT, PLANNED, APPROVED], status = "paused", message = "The plan is ready: read it and resume when you want." }: Waiting = {}) {
  const base = createAutopilotState(new Date(T0), { idea: IDEA });
  return seedRun({
    status,
    phase: "plan",
    chapters,
    message,
    activities,
    statePatch: {
      brief: base.brief,
      concept: { done: true, generated: true, secrets: [], logline: LOGLINE },
      plan: { ...planOf(chapters), approved: true, awaitingAuthor: true, readerReactions: [], ...plan },
    },
  });
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

const approval = () => document.querySelector<HTMLElement>("[data-plan-approval]") as HTMLElement;
const region = (name: string) => within(approval()).getByRole("region", { name });
const chapterOf = (number: number) => approval().querySelector<HTMLElement>(`[data-plan-approval-chapter="${number}"]`) as HTMLElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
  // The files of the book are read through a module the screen loads when it needs it: loaded once here, so that the first test does not wait for it.
  await import("@/autopilot/browserStore");
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = { ...makeRuntime(), intervene: vi.fn(async () => undefined), frozenStatus: vi.fn(async () => ({ mode: "ask", changes: [], pending: [], warnings: [] })) };
  mocks.book = LOCAL_BOOK;
  mocks.structure = { chapters: [], characters: [], ghostwriters: [{ slug: "night-owl", path: "ghostwriters/night-owl.md", name: "Night Owl" }] };
  mocks.store = new MemoryBookStore(bookFiles());
  useBooksStore.setState({ structures: { [LOCAL_BOOK.id]: mocks.structure as never } });
  mocks.toast.mockReset();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useBooksStore.setState({ structures: {} });
  await i18n.changeLanguage("en");
});

describe("a plan that waits for the author", () => {
  it("is a screen of its own in place of the history, and says once that the plan is ready", () => {
    seedWaiting();
    render(<Page />);
    const main = document.querySelector("[data-autopilot-main]") as HTMLElement;
    expect(main.contains(approval()), "the screen is in the main column").toBe(true);
    expect(document.querySelector("[data-autopilot-timeline]"), "the history is not there while the plan waits").toBeNull();
    expect(within(approval()).getByRole("heading", { level: 2, name: t("autopilot.approval.title") })).toBeInTheDocument();
    expect(screen.getAllByText(/the plan is ready/i)).toHaveLength(1);
    expect(screen.queryByText(t("autopilot.plan.awaiting"))).not.toBeInTheDocument();
    // The plan is not listed a second time beside it.
    const side = document.querySelector("[data-autopilot-side]") as HTMLElement;
    expect(within(side).queryByRole("heading", { name: t("autopilot.plan.title") })).not.toBeInTheDocument();
    expect(within(side).queryByText("The key")).not.toBeInTheDocument();
  });

  it("says the idea, the logline and the premise of the book, and the cast the autopilot created, one line each", async () => {
    seedWaiting();
    render(<Page />);
    const book = region(t("autopilot.approval.concept.title"));
    expect(within(book).getByText(IDEA)).toBeInTheDocument();
    expect(within(book).getByText(LOGLINE)).toBeInTheDocument();
    expect(await within(book).findByText(PREMISE, undefined, { timeout: 20_000 })).toBeInTheDocument();
    const cast = region(t("autopilot.approval.cast.title"));
    const items = await within(cast).findAllByRole("listitem", undefined, { timeout: 20_000 });
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Mira Vale");
    expect(items[0]).toHaveTextContent(t("autopilot.approval.cast.role.protagonist"));
    expect(items[0]).toHaveTextContent("A stubborn young glassmaker.");
    expect(items[1]).toHaveTextContent("Orrin Hale");
    expect(items[1]).toHaveTextContent(t("autopilot.approval.cast.role.antagonist"));
  });

  it("says when the concept created no characters (the book had its own), and has no cast when the history no longer has the concept", () => {
    seedWaiting({ activities: [{ ...CONCEPT, changedPaths: ["story-design.md", "locations/glass-harbor.md"] }, PLANNED, APPROVED] });
    const view = render(<Page />);
    expect(within(region(t("autopilot.approval.cast.title"))).getByText(t("autopilot.approval.cast.none"))).toBeInTheDocument();
    view.unmount();
    seedWaiting({ activities: [PLANNED, APPROVED] });
    render(<Page />);
    expect(within(approval()).queryByRole("region", { name: t("autopilot.approval.cast.title") })).not.toBeInTheDocument();
  });

  it("lists every chapter open: synopsis, goal, key events, the scenes or when they are planned, and the ghostwriter when it is not the book's", () => {
    seedWaiting();
    render(<Page />);
    const second = chapterOf(2);
    expect(within(second).getByRole("heading", { level: 4 })).toHaveTextContent("2. The wall");
    for (const text of ["The sea wall cracks during the night tide.", "Raise the stakes.", "The wall cracks", "The Wall Is Failing"]) expect(within(second).getByText(text)).toBeVisible();
    expect(within(second).getByText(t("autopilot.approval.chapters.noScenes"))).toBeVisible();
    expect(within(chapterOf(3)).getByText(t("autopilot.plan.ghostwriter", { name: "Night Owl" }))).toBeVisible();
    expect(within(chapterOf(1)).queryByText(/Night Owl/)).not.toBeInTheDocument();
    expect(approval().querySelector("details:not([open])"), "nothing is behind a closed menu").toBeNull();
  });

  it("shows the scenes of a chapter that has them", () => {
    seedWaiting({ chapters: [chapter(1, "planned", { title: "The key", summary: "Mira finds the key.", scenes: [{ ...scene(1, "planned"), title: "The pier", goal: "Find the key." }, { ...scene(2, "planned"), title: "The council", goal: "Be seen." }] })] });
    render(<Page />);
    const scenes = within(chapterOf(1)).getByRole("list", { name: t("autopilot.approval.chapters.scenes") });
    expect(within(scenes).getAllByRole("listitem").map((item) => item.textContent)).toEqual([expect.stringContaining("The pier"), expect.stringContaining("The council")]);
  });

  it("can be collapsed and opened again, all together or one chapter at a time", () => {
    seedWaiting();
    render(<Page />);
    const toggleOf = (number: number) => within(chapterOf(number)).getByRole("button", { name: t("autopilot.approval.chapters.toggle", { number }) });
    expect(toggleOf(2)).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggleOf(2));
    expect(toggleOf(2)).toHaveAttribute("aria-expanded", "false");
    expect(within(chapterOf(2)).queryByText("The sea wall cracks during the night tide.")).not.toBeInTheDocument();
    expect(within(chapterOf(1)).getByText("Mira finds the key under the pier.")).toBeVisible();

    fireEvent.click(within(approval()).getByRole("button", { name: t("autopilot.approval.chapters.collapseAll") }));
    for (const number of [1, 2, 3]) expect(toggleOf(number)).toHaveAttribute("aria-expanded", "false");
    expect(within(approval()).queryByText("Mira finds the key under the pier.")).not.toBeInTheDocument();
    // The titles stay: the plan can be read as a list of titles.
    expect(within(chapterOf(1)).getByRole("heading", { level: 4 })).toHaveTextContent("1. The key");

    fireEvent.click(within(approval()).getByRole("button", { name: t("autopilot.approval.chapters.expandAll") }));
    for (const number of [1, 2, 3]) expect(toggleOf(number)).toHaveAttribute("aria-expanded", "true");
  });
});

describe("the readers and the director", () => {
  it("say when no reader read the plan", () => {
    seedWaiting();
    render(<Page />);
    const readers = region(t("autopilot.approval.readers.title"));
    expect(within(readers).getByText(t("autopilot.approval.readers.none"))).toBeInTheDocument();
    expect(within(readers).queryByRole("article")).not.toBeInTheDocument();
  });

  it("say that the readers do not read the plan when the configuration turned them off", () => {
    seedWaiting();
    useAutopilotStore.setState((store) => {
      const view = store.views[LOCAL_BOOK.id];
      const state = view.snapshot!.state!;
      return { views: { ...store.views, [LOCAL_BOOK.id]: { ...view, snapshot: { ...view.snapshot!, state: { ...state, options: { ...state.options, readersOnPlan: false } } } } } };
    });
    render(<Page />);
    expect(within(region(t("autopilot.approval.readers.title"))).getByText(t("autopilot.approval.readers.off"))).toBeInTheDocument();
  });

  it("show each reader's reaction as a card: the name, the interest, the reaction, the doubts and the wishes", () => {
    seedWaiting({ plan: { readerReactions: READERS, skippedReaders: ["carla"] } });
    render(<Page />);
    const readers = region(t("autopilot.approval.readers.title"));
    const anna = within(readers).getByRole("article", { name: "Anna" });
    expect(anna).toHaveTextContent(t("autopilot.approval.readers.interest", { score: 7 }));
    expect(anna).toHaveTextContent("I would read it for the harbor alone.");
    expect(within(anna).getByRole("list", { name: t("autopilot.approval.readers.concerns") })).toHaveTextContent("Slow start?");
    expect(within(anna).getByRole("list", { name: t("autopilot.approval.readers.wishes") })).toHaveTextContent("More of the glass workshops");
    const ben = within(readers).getByRole("article", { name: "Ben" });
    expect(ben).toHaveTextContent(t("autopilot.approval.readers.interest", { score: 4 }));
    expect(within(ben).queryByRole("list", { name: t("autopilot.approval.readers.wishes") })).not.toBeInTheDocument();
    expect(readers).toHaveTextContent(t("autopilot.approval.readers.skipped", { count: 1, names: "carla" }));
  });

  it("show the director's vote on the plan with its words, and say it in the sentence that opens the screen", () => {
    seedWaiting({ plan: { readerReactions: READERS } });
    render(<Page />);
    const vote = region(t("autopilot.approval.director.title"));
    expect(within(vote).getByText("8", { selector: "[data-plan-score]" })).toBeInTheDocument();
    expect(vote).toHaveTextContent(t("autopilot.approval.director.verdict.approve"));
    expect(vote).toHaveTextContent("A solid plan: every chapter turns.");
    expect(approval()).toHaveTextContent(t("autopilot.approval.leadVote", { score: "8" }));
  });

  it("show every review the director made of the plan, and how many revisions it asked for", () => {
    seedWaiting({
      plan: { rounds: 2 },
      activities: [CONCEPT, PLANNED, review("revise 5/10 — The middle sags.", 70), activityOf("plan", { id: "plan-2", phase: "plan", startedAt: at(80) }), review("revise 6/10 — Chapter 3 repeats chapter 2.", 90), APPROVED],
    });
    render(<Page />);
    const vote = region(t("autopilot.approval.director.title"));
    const reviews = within(vote).getByRole("list", { name: t("autopilot.approval.director.reviews") });
    expect(within(reviews).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("The middle sags."),
      expect.stringContaining("Chapter 3 repeats chapter 2."),
      expect.stringContaining("A solid plan: every chapter turns."),
    ]);
    expect(within(reviews).getAllByRole("listitem")[0]).toHaveTextContent(t("autopilot.approval.director.verdict.revise"));
    expect(within(reviews).getAllByRole("listitem")[0]).toHaveTextContent("5/10");
    expect(approval()).toHaveTextContent(t("autopilot.approval.leadVoteRounds", { score: "8", count: 2 }));
  });

  it("say so when the history no longer has the director's review", () => {
    seedWaiting({ activities: [] });
    render(<Page />);
    expect(within(region(t("autopilot.approval.director.title"))).getByText(t("autopilot.approval.director.noVote"))).toBeInTheDocument();
    expect(approval()).toHaveTextContent(t("autopilot.approval.lead"));
  });
});

describe("the entries of the outline", () => {
  it("say which chapters follow an entry the author wrote and which an entry the autopilot wrote", async () => {
    const theirs = { title: "The wall", body: "The sea wall cracks during the night tide.\n\n- The wall cracks" };
    mocks.store = new MemoryBookStore(bookFiles({
      "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "The key", body: "Mira finds the key. Orrin sees her.", origin: "author" }),
      "outline/chapters/002.md": serializeOutlineChapter({ number: 2, ...theirs, origin: "autopilot", digest: await outlineEntryDigest(theirs) }),
    }));
    seedWaiting();
    render(<Page />);
    expect(await within(chapterOf(1)).findByText(t("autopilot.approval.chapters.outlineAuthor"), undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(await within(chapterOf(2)).findByText(t("autopilot.approval.chapters.outlineAutopilot"))).toBeInTheDocument();
    expect(within(chapterOf(3)).queryByText(t("autopilot.approval.chapters.outlineAuthor"))).not.toBeInTheDocument();
    expect(within(chapterOf(3)).queryByText(t("autopilot.approval.chapters.outlineAutopilot"))).not.toBeInTheDocument();
  });
});

describe("asking for a change of a chapter", () => {
  it("is an intervention that rewrites, with the author's words about that chapter, and the focus comes back to the button", async () => {
    seedWaiting();
    render(<Page />);
    const ask = within(chapterOf(2)).getByRole("button", { name: t("autopilot.approval.change.ask", { number: 2 }) });
    expect(ask).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(ask);
    expect(ask).toHaveAttribute("aria-expanded", "true");
    const box = within(chapterOf(2)).getByRole("textbox", { name: t("autopilot.approval.change.label", { number: 2 }) });
    expect(box).toHaveFocus();
    // What it does is said under the field, and the field points at it.
    const hint = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    expect(hint).toHaveTextContent(t("autopilot.approval.change.replan"));
    const send = within(chapterOf(2)).getByRole("button", { name: t("autopilot.approval.change.send") });
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: "  The wall should crack in chapter 3 instead.  " } });
    fireEvent.click(send);
    await waitFor(() => expect(mocks.runtime.intervene).toHaveBeenCalledWith(LOCAL_BOOK.id, { scope: "rewrite", text: "Chapter 2 «The wall»: The wall should crack in chapter 3 instead." }));
    await waitFor(() => expect(within(chapterOf(2)).queryByRole("textbox")).not.toBeInTheDocument());
    expect(ask).toHaveFocus();
    // Said where a screen reader hears it, once.
    expect(within(approval()).getByText(t("autopilot.approval.change.sent", { number: 2 })).closest("[role='status']")).not.toBeNull();
  });

  it("can be cancelled, and the focus comes back to the button", () => {
    seedWaiting();
    render(<Page />);
    const ask = within(chapterOf(1)).getByRole("button", { name: t("autopilot.approval.change.ask", { number: 1 }) });
    fireEvent.click(ask);
    fireEvent.change(within(chapterOf(1)).getByRole("textbox"), { target: { value: "Something." } });
    fireEvent.click(within(chapterOf(1)).getByRole("button", { name: t("autopilot.approval.change.cancel") }));
    expect(within(chapterOf(1)).queryByRole("textbox")).not.toBeInTheDocument();
    expect(ask).toHaveFocus();
    expect(mocks.runtime.intervene).not.toHaveBeenCalled();
  });

  it("says what it does in a book that already has chapters written: they are revised, and the plan is not made again", () => {
    const imported = chapter(1, "done", { imported: true, title: "Before", scenes: [scene(1, "reviewed", 1200)] });
    seedWaiting({ chapters: [imported, ...CHAPTERS.map((entry) => ({ ...entry, number: entry.number + 1 }))] });
    render(<Page />);
    fireEvent.click(within(chapterOf(2)).getByRole("button", { name: t("autopilot.approval.change.ask", { number: 2 }) }));
    const box = within(chapterOf(2)).getByRole("textbox");
    expect(document.getElementById(box.getAttribute("aria-describedby") ?? "")).toHaveTextContent(t("autopilot.approval.change.written"));
    expect(within(chapterOf(1)).getByText(t("autopilot.approval.chapters.imported"))).toBeInTheDocument();
  });
});

describe("a plan that was reopened with changes", () => {
  const NOTE = "Chapter 2 «The wall»: The wall should crack in chapter 3 instead.";

  it("stays on the screen with the changes it will be made again with, and the way to do it", async () => {
    seedWaiting({ plan: { approved: false, awaitingAuthor: false, revisionNotes: [NOTE] } });
    render(<Page />);
    expect(within(approval()).getByRole("heading", { level: 2, name: t("autopilot.approval.reviseTitle") })).toBeInTheDocument();
    expect(within(approval()).getByRole("list", { name: t("autopilot.approval.changes") })).toHaveTextContent(NOTE);
    // The message the engine left when the plan was ready is no longer true, and the band does not say it.
    expect(screen.queryByText(/^The plan is ready/)).not.toBeInTheDocument();
    fireEvent.click(within(approval()).getByRole("button", { name: t("autopilot.approval.reviseAction") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith(LOCAL_BOOK.id));
    // More changes can still be asked.
    expect(within(chapterOf(3)).getByRole("button", { name: t("autopilot.approval.change.ask", { number: 3 }) })).toBeEnabled();
  });
});

describe("approving the plan", () => {
  it("is at the top, in the band, and at the end of the plan: the same action, told apart by name", async () => {
    seedWaiting();
    render(<Page />);
    expect(screen.getAllByRole("button", { name: quickName(t("autopilot.actions.approvePlan")) })).toHaveLength(1);
    const end = within(approval()).getByRole("button", { name: t("autopilot.actions.approvePlan") });
    const chapters = [...approval().querySelectorAll("[data-plan-approval-chapter]")];
    expect(chapters[chapters.length - 1].compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING, "after the last chapter").toBeTruthy();
    fireEvent.click(end);
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith(LOCAL_BOOK.id));
  });

  it("on a phone is the Plan tab, with the action in the bar at the bottom that keeps clear of the text", () => {
    stubWidth(390);
    seedWaiting();
    render(<Page />);
    const tab = screen.getByRole("tab", { name: t("autopilot.tabs.plan") });
    expect(tab).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(panel.contains(approval())).toBe(true);
    const bar = document.querySelector("[data-autopilot-bottom-bar]") as HTMLElement;
    expect(within(bar).getByRole("button", { name: quickName(t("autopilot.actions.approvePlan")) })).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue("--bottom-reserve")).not.toBe("");
  });
});

describe("a plan of three thousand chapters", () => {
  it("is shown twenty chapters at a time, with a filter and a jump to a number", async () => {
    seedWaiting({ chapters: longPlan(3000, 0, () => "planned") });
    const started = performance.now();
    render(<Page />);
    expect(performance.now() - started, "drawn fast").toBeLessThan(2000);
    expect(approval().querySelectorAll("[data-plan-approval-chapter]")).toHaveLength(20);
    expect(within(approval()).getByText(t("autopilot.map.window.range", { from: "1", to: "20", total: "3,000" }))).toBeInTheDocument();
    fireEvent.click(within(approval()).getByRole("button", { name: t("autopilot.map.window.next", { count: 20 }) }));
    expect(chapterOf(21)).not.toBeNull();
    expect(chapterOf(1)).toBeNull();

    fireEvent.change(within(approval()).getByRole("textbox", { name: t("autopilot.map.window.jump") }), { target: { value: "2750" } });
    fireEvent.click(within(approval()).getByRole("button", { name: t("autopilot.map.window.go") }));
    expect(chapterOf(2750)).not.toBeNull();
    await waitFor(() => expect(within(chapterOf(2750)).getByRole("heading", { level: 4 })).toHaveFocus());

    fireEvent.change(within(approval()).getByRole("searchbox", { name: t("autopilot.map.window.filter") }), { target: { value: "Title 1234" } });
    expect(approval().querySelectorAll("[data-plan-approval-chapter]")).toHaveLength(1);
    expect(chapterOf(1234)).not.toBeNull();
  });
});

describe("in Italian", () => {
  it("says everything in Italian", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    seedWaiting({ plan: { readerReactions: READERS } });
    render(<Page />);
    expect(within(approval()).getByRole("heading", { level: 2, name: "Il piano è pronto" })).toBeInTheDocument();
    expect(within(approval()).getByRole("button", { name: "Approva il piano e continua" })).toBeInTheDocument();
    expect(within(chapterOf(2)).getByRole("button", { name: "Chiedi una modifica al capitolo 2" })).toBeInTheDocument();
    expect(region("Cosa ne pensano i lettori")).toHaveTextContent("Interesse 7/10");
    expect(region("Il voto del direttore")).toHaveTextContent("Approvato");
    fireEvent.click(within(chapterOf(2)).getByRole("button", { name: "Chiedi una modifica al capitolo 2" }));
    fireEvent.change(within(chapterOf(2)).getByRole("textbox"), { target: { value: "Il muro crolla nel capitolo 3." } });
    fireEvent.click(within(chapterOf(2)).getByRole("button", { name: "Chiedi questa modifica" }));
    await waitFor(() => expect(mocks.runtime.intervene).toHaveBeenCalledWith(LOCAL_BOOK.id, { scope: "rewrite", text: "Capitolo 2 «The wall»: Il muro crolla nel capitolo 3." }));
  });
});

describe("the other states in Italian", () => {
  it("say them in Italian too: no reader, the reviews of the plan, the entries of the Scaletta, and the plan reopened with changes", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    const theirs = { title: "The wall", body: "The sea wall cracks during the night tide.\n\n- The wall cracks" };
    mocks.store = new MemoryBookStore(bookFiles({
      "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "The key", body: "Mira trova la chiave.", origin: "author" }),
      "outline/chapters/002.md": serializeOutlineChapter({ number: 2, ...theirs, origin: "autopilot", digest: await outlineEntryDigest(theirs) }),
    }));
    seedWaiting({ plan: { rounds: 1 }, activities: [CONCEPT, PLANNED, review("revise 5/10 — Il centro cede.", 70), APPROVED] });
    const view = render(<Page />);
    expect(region("Cosa ne pensano i lettori")).toHaveTextContent("Nessun lettore ha reagito al piano.");
    expect(within(region("Il voto del direttore")).getByRole("list", { name: "Le revisioni del piano fatte dal direttore" })).toHaveTextContent("Revisione 1");
    expect(approval()).toHaveTextContent("Il direttore l'ha approvato con 8/10 dopo 1 revisione.");
    expect(await within(chapterOf(1)).findByText("Dalla tua Sinossi", undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(await within(chapterOf(2)).findByText("Sinossi scritta dall'autopilot", undefined, { timeout: 20_000 })).toBeInTheDocument();
    view.unmount();
    seedWaiting({ plan: { approved: false, awaitingAuthor: false, revisionNotes: ["Capitolo 2 «The wall»: il muro crolla dopo."] } });
    render(<Page />);
    expect(within(approval()).getByRole("heading", { level: 2, name: "Il piano sarà rifatto" })).toBeInTheDocument();
    expect(within(approval()).getByRole("list", { name: "Le modifiche per il piano" })).toHaveTextContent("il muro crolla dopo.");
    expect(within(approval()).getByRole("button", { name: "Rifai il piano con queste modifiche" })).toBeInTheDocument();
  });
});

describe("the end of a chapter on a phone", () => {
  it("has the button to read the chapter next to Resume, in the bar at the bottom", () => {
    stubWidth(390);
    mocks.structure = { chapters: [{ slug: "004-chapter-4", title: "Chapter 4", paragraphs: [{}] }], characters: [], ghostwriters: [] };
    seedRun({ status: "paused", message: "Chapter 4 approved: read it and resume.", activities: [activityOf("consolidate", { chapterNumber: 4 })] });
    render(<Page />);
    const bar = within(document.querySelector("[data-autopilot-bottom-bar]") as HTMLElement);
    const read = bar.getByRole("link", { name: t("autopilot.actions.readChapter", { number: 4 }) });
    expect(read).toHaveAttribute("href", "/app/books/book-1/chapters/004-chapter-4");
    expect(read.parentElement).toBe(bar.getByRole("button", { name: quickName(t("autopilot.actions.resume")) }).parentElement);
  });
});
