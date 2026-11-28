import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { designCriterionLabel, type AutopilotState, type OutlineChapterEntry } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  runtime: {
    chooseDesignPitch: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    decideDesignFinding: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    start: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  },
}));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));

import i18n from "@/i18n";
import "@/i18n/design";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useAutopilotStore } from "@/autopilot/store";
import StudioReviews, { type StudioReviewsProps } from "@/components/outline/studio/StudioReviews";
import type { BookEntry } from "@/types/settings";
import { AT, FLAT, WITH_WEAK, finding, pitch, stateOf, subject } from "./helpers/designReviewFixtures";

// The reviews of a design in the Studio: the alternative pitches and the choice, the rubric of every subject that was judged, the findings of the analysis of the structure with what the
// author does about each, and the review on request of the whole design or of a chapter. The runtime is a stub that records what the author asked.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const ENTRIES = [1, 2, 3].map((number): OutlineChapterEntry => ({ number, title: `Chapter title ${number}`, body: "", design: undefined } as never));

const CRITICAL = "c-00000001";
const MAJOR = "a-00000002";
const MINOR = "a-00000003";
const HERS = "a-00000004";
const DISMISSED = "a-00000005";

function fullState(patch: (state: AutopilotState) => void = () => undefined): AutopilotState {
  return stateOf(
    {
      alternatives: {
        pitches: [pitch("p1", "The Glass Tide"), pitch("p2", "The Salt Ledger")],
        evaluations: {
          p1: [{ by: "director", name: "Marta Vela", overall: 7.4, scores: FLAT(7.4), note: "Strong premise." }, { by: "ada", name: "Ada", overall: 8, scores: FLAT(8), note: "I kept reading." }],
          p2: [{ by: "director", name: "Marta Vela", overall: 8.1, scores: FLAT(8.1), note: "The sharpest stakes." }],
        },
        recommended: { id: "p2", reason: "It has the sharpest stakes." },
      },
      rubric: {
        design: subject([FLAT(5.5), WITH_WEAK(8, { 2: 6.2, 4: 5 })]),
        "reader:ada": subject([FLAT(8.2)]),
        "chapter:1": subject([FLAT(8)]),
        "chapter:2": subject([WITH_WEAK(7.5, { 3: 4 })]),
        "pitch:p1": subject([FLAT(7.4)]),
      },
      reviewed: {
        "1": { sig: "00000001", round: 1, at: AT, overall: 8, verdict: "ok", summary: "Chapter one works." },
        "2": { sig: "00000002", round: 1, at: AT, overall: 6.9, verdict: "revise", summary: "The dialogue is flat." },
      },
      coherence: {
        sig: "abc12345",
        round: 2,
        at: AT,
        summary: "The structure mostly holds.",
        findings: [
          finding({ id: MINOR, text: "A minor repetition.", severity: "minor", chapters: [3], requires: [] }),
          finding({ id: CRITICAL, text: "The harbor master dies twice.", severity: "critical", source: "check", chapters: [2], requires: [2] }),
          finding({ id: MAJOR, text: "The tide rule changes.", proposal: "Keep the rule from chapter 1.", chapters: [1, 3], requires: [1, 3] }),
          finding({ id: HERS, text: "Her own entry contradicts chapter 3.", owner: "author", chapters: [1], requires: [1] }),
          finding({ id: DISMISSED, text: "A deliberate echo.", status: "dismissed", decision: { by: "director", reason: "It is deliberate.", at: AT } }),
        ],
      },
    },
    (state) => {
      state.concept = { done: false, generated: false, secrets: [] };
      state.plan = { chapters: [], readerReactions: [{ slug: "ada", name: "Ada Quill" }] } as never;
      patch(state);
    },
  );
}

function show(state: AutopilotState | null, props: Partial<StudioReviewsProps> = {}) {
  return render(<StudioReviews book={BOOK} state={state} entries={ENTRIES} running={false} designing={false} serverWithoutReview={false} designBlock={null} {...props} />);
}

const section = (name: string) => screen.getByRole("region", { name });
const sectionOf = (key: string) => section(t(key));

beforeAll(async () => {
  await i18n.changeLanguage("en");
  await loadAutopilotTranslations();
});

beforeEach(() => {
  mocks.runtime.chooseDesignPitch = vi.fn(async () => undefined);
  mocks.runtime.decideDesignFinding = vi.fn(async () => undefined);
  mocks.runtime.start = vi.fn(async () => undefined);
  useAutopilotStore.setState((state) => ({ views: {}, summaries: {}, server: { ...state.server, info: null } }));
});

afterEach(() => {
  cleanup();
});

describe("the alternative pitches", () => {
  it("shows every pitch with what the director and the readers said, and says which one the director recommends", () => {
    show(fullState());
    const panel = sectionOf("designReview.alternatives.title");
    expect(within(panel).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      t("designReview.alternatives.waiting"),
      "Pitch p1: The Glass Tide",
      "Pitch p2: The Salt Ledger" + t("designReview.alternatives.recommended"),
    ]);
    const first = panel.querySelector("[data-pitch='p1']")!;
    expect(within(first as HTMLElement).getByText(/Director: 7\.4/)).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText(t("designReview.alternatives.details"), { selector: "summary" })).toBeInTheDocument();
    expect(first.textContent).toContain("Readers:");
    expect(within(panel).getByText("Logline of The Glass Tide.")).toBeInTheDocument();
    // Premise, protagonist, stakes, twist, tone and what makes it different are one click away, as a list of terms.
    expect(first.querySelectorAll("dt")).toHaveLength(6);
    expect(within(panel).getByText(`${t("designReview.alternatives.waiting")}`)).toBeInTheDocument();
    expect(panel.textContent).toContain("The director recommends «The Salt Ledger»: It has the sharpest stakes.");
  });

  it("lets the author choose a pitch with one click, and tells her", async () => {
    show(fullState());
    fireEvent.click(screen.getByRole("button", { name: t("designReview.alternatives.chooseLabel", { title: "The Salt Ledger" }) }));
    await waitFor(() => expect(mocks.runtime.chooseDesignPitch).toHaveBeenCalledWith("book-1", { id: "p2" }));
    expect(await screen.findByText(t("designReview.alternatives.chosenAnnounce", { title: "The Salt Ledger" }), { selector: "[role='status']" })).toBeInTheDocument();
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it("says who chose and why, marks the chosen pitch, and offers the others as a change of mind until the concept is made", () => {
    show(fullState((state) => { state.design!.alternatives!.selected = { id: "p1", by: "director", reason: "The readers liked it more.", at: AT }; }));
    const panel = sectionOf("designReview.alternatives.title");
    expect(panel.querySelector("[data-pitch-selection]")?.textContent).toBe("Chosen by the director: The readers liked it more.");
    expect(panel.querySelector("[data-pitch='p1']")).toHaveAttribute("data-pitch-chosen");
    expect(within(panel).queryByText(t("designReview.alternatives.waiting"))).not.toBeInTheDocument();
    expect(panel.querySelector("[data-pitch-choose='p1']")).toBeNull();
    expect(screen.getByRole("button", { name: t("designReview.alternatives.chooseAnotherLabel", { title: "The Salt Ledger" }) })).toHaveTextContent(t("designReview.alternatives.chooseAnother"));
  });

  it("offers no choice once the book is designed from a pitch, and says why", () => {
    show(fullState((state) => {
      state.concept = { done: true, generated: true, secrets: [] };
      state.design!.alternatives!.selected = { id: "p1", by: "author", reason: "", at: AT };
    }));
    const panel = sectionOf("designReview.alternatives.title");
    expect(within(panel).queryAllByRole("button")).toEqual([]);
    expect(panel.querySelector("[data-pitch-selection]")?.textContent).toBe("Chosen by you.");
    expect(within(panel).getByText(t("designReview.alternatives.lockedHint"))).toBeInTheDocument();
  });

  it("waits while something holds the book", () => {
    show(fullState(), { running: true });
    expect(screen.getByRole("button", { name: t("designReview.alternatives.chooseLabel", { title: "The Glass Tide" }) })).toBeDisabled();
  });

  it("is not there when the design proposed none", () => {
    show(stateOf());
    expect(screen.queryByRole("region", { name: t("designReview.alternatives.title") })).not.toBeInTheDocument();
  });
});

describe("the rubric", () => {
  it("scores the design on the twelve criteria in a table a screen reader can read, with the weak ones said in words", () => {
    show(fullState());
    const panel = sectionOf("designReview.rubric.title");
    const table = within(panel).getByRole("table", { name: t("designReview.rubric.caption", { subject: t("designReview.rubric.design") }) });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([t("designReview.rubric.criterion"), t("designReview.rubric.scoreColumn"), t("designReview.rubric.reason")]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(12);
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent(designCriterionLabel("originality", "en"));
    expect(rows[0]).not.toHaveAttribute("data-weak");
    const coherence = table.querySelector("[data-criterion='coherence']") as HTMLElement;
    expect(coherence).toHaveAttribute("data-weak");
    expect(coherence).toHaveTextContent(t("designReview.scoreWeak", { score: 6.2 }));
    expect(coherence).toHaveTextContent("The coherence is thin.");
    expect(coherence).toHaveTextContent(`${t("designReview.rubric.proposals")}: Strengthen the coherence`);
    expect(table.querySelector("[data-criterion='tension']")).toHaveTextContent(t("designReview.scoreWeak", { score: 5 }));
  });

  it("says how the design went, review by review, in words and not only in a mark", () => {
    show(fullState());
    const design = sectionOf("designReview.rubric.title").querySelector("[data-rubric-subject='design']") as HTMLElement;
    expect(design.querySelector("summary")).toHaveTextContent(`${t("designReview.rubric.criteria")} · 7.6/10 · 2 weak points`);
    expect(design).toHaveTextContent(`${t("designReview.rubric.overall")}: 7.6`);
    expect(design).toHaveTextContent("before: 5.5");
    expect(design.querySelector("[data-rubric-trend]")).toHaveAttribute("data-rubric-trend", "up");
    expect(design.querySelector("[data-rubric-trend]")).toHaveTextContent("up 2.1 since the first review");
    expect(design).toHaveTextContent("2 weak points");
    expect(within(design).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Review 1: 5.5/10", "Review 2: 7.6/10"]);
  });

  it("names a reader as the plan does, lists the chapters with the verdict of the panel, and the pitches with the one they are", () => {
    show(fullState());
    const panel = sectionOf("designReview.rubric.title");
    expect(panel.querySelector("[data-rubric-subject='reader:ada']")).toHaveTextContent("Ada Quill");
    const chapter2 = panel.querySelector("[data-rubric-subject='chapter:2']") as HTMLElement;
    expect(chapter2).toHaveTextContent("Chapter 2 «Chapter title 2»");
    // Closed, a row says its score, its weak points and the verdict of the panel: the author sees which chapters to open.
    expect(chapter2.querySelector("summary")).toHaveTextContent("Chapter 2 «Chapter title 2» · 7.2/10 · 1 weak point · should be revised");
    expect(panel.querySelector("[data-rubric-subject='chapter:1'] summary")).toHaveTextContent("Chapter 1 «Chapter title 1» · 8/10");
    expect(panel.querySelector("[data-rubric-subject='reader:ada'] summary")).toHaveTextContent("Ada Quill · 8.2/10");
    expect(chapter2).toHaveTextContent("should be revised — The dialogue is flat.");
    expect(chapter2).toHaveTextContent("1 weak point");
    expect(panel.querySelector("[data-rubric-subject='chapter:1']")).toHaveTextContent("can be written as it is — Chapter one works.");
    expect(panel.textContent).toContain(t("designReview.rubric.reviewed", { count: 2, weak: 1 }));
    expect(panel.querySelector("[data-rubric-subject='pitch:p1']")).toHaveTextContent("Pitch p1: The Glass Tide");
  });

  it("asks for the review of one chapter again with its button, and offers it no more while the autopilot runs", async () => {
    const { rerender } = show(fullState());
    // The chapters are closed rows: the button is in the one that is opened.
    (document.querySelector("[data-rubric-subject='chapter:2'] details") as HTMLDetailsElement).open = true;
    fireEvent.click(screen.getByRole("button", { name: t("designReview.rubric.reviewChapter", { number: 2 }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: { reviewOnly: { chapters: [2] } } }));
    expect(await screen.findByText(t("designReview.request.started"), { selector: "[role='status']" })).toBeInTheDocument();
    rerender(<StudioReviews book={BOOK} state={fullState()} entries={ENTRIES} running designing={false} serverWithoutReview={false} designBlock={null} />);
    expect(document.querySelector("[data-rubric-review]")).toBeNull();
  });

  it("offers no review of a chapter while the personal server cannot make one", () => {
    show(fullState(), { serverWithoutReview: true });
    expect(screen.queryByRole("button", { name: t("designReview.rubric.reviewChapter", { number: 2 }) })).not.toBeInTheDocument();
  });

  it("is not there while nothing was judged", () => {
    show(stateOf({ rubric: {} }));
    expect(screen.queryByRole("region", { name: t("designReview.rubric.title") })).not.toBeInTheDocument();
  });
});

describe("the findings of the analysis of the structure", () => {
  const finding_ = (id: string) => document.querySelector(`[data-finding='${id}']`) as HTMLElement;

  it("tells what is wrong, where, which chapters to revise and what to do, the critical ones first, with the severity said in a word", () => {
    show(fullState());
    const panel = sectionOf("designReview.findings.title");
    expect(panel.textContent).toContain("Analysed on");
    expect(panel.textContent).toContain("The structure mostly holds.");
    expect(panel.querySelector("[data-findings-counts]")).toHaveTextContent("1 critical, 2 major, 1 minor");
    const open = panel.querySelector("[data-finding-group='open']") as HTMLElement;
    expect(within(open).getByRole("heading", { level: 3 })).toHaveTextContent(`${t("designReview.findings.groups.open")} (4)`);
    expect([...open.querySelectorAll("[data-finding]")].map((item) => item.getAttribute("data-finding"))).toEqual([CRITICAL, MAJOR, HERS, MINOR]);
    const critical = finding_(CRITICAL);
    expect(critical).toHaveAttribute("data-finding-severity", "critical");
    expect(critical).toHaveTextContent(t("designReview.severity.critical"));
    expect(critical).toHaveTextContent(t("designReview.kind.contradiction"));
    expect(critical).toHaveTextContent("Chapter 2");
    expect(critical).toHaveTextContent("The harbor master dies twice.");
    expect(critical).toHaveTextContent(t("designReview.findings.source.check"));
    expect(critical).toHaveTextContent("To fix it, revise: chapter 2");
    const major = finding_(MAJOR);
    expect(major).toHaveTextContent("Chapters 1, 3");
    expect(major).toHaveTextContent("What to do: Keep the rule from chapter 1.");
    expect(major).toHaveTextContent("To fix it, revise: chapters 1, 3");
    expect(finding_(MINOR)).toHaveTextContent(t("designReview.severity.minor"));
  });

  it("asks the autopilot to fix a finding with one click: the decision is saved, and a design round begins", async () => {
    show(fullState());
    fireEvent.click(within(finding_(MAJOR)).getByRole("button", { name: t("designReview.findings.fixLabel", { text: "The tide rule changes." }) }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: {} }));
    expect(mocks.runtime.decideDesignFinding).toHaveBeenCalledWith("book-1", { id: MAJOR, action: "fix" });
    expect(mocks.runtime.decideDesignFinding.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.start.mock.invocationCallOrder[0]);
    expect(await screen.findByText(t("designReview.findings.started"), { selector: "[role='status']" })).toBeInTheDocument();
  });

  it("does not begin a round when the decision is refused", async () => {
    mocks.runtime.decideDesignFinding = vi.fn(async () => { throw new Error("refused"); });
    show(fullState());
    fireEvent.click(within(finding_(MAJOR)).getByRole("button", { name: t("designReview.findings.fixLabel", { text: "The tide rule changes." }) }));
    await waitFor(() => expect(mocks.runtime.decideDesignFinding).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it("lets the author take a finding, or say it is not a problem, with no round and with focus on the heading of the findings", async () => {
    show(fullState());
    fireEvent.click(within(finding_(MAJOR)).getByRole("button", { name: t("designReview.findings.mineLabel", { text: "The tide rule changes." }) }));
    await waitFor(() => expect(mocks.runtime.decideDesignFinding).toHaveBeenCalledWith("book-1", { id: MAJOR, action: "mine" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: t("designReview.findings.title") })));
    fireEvent.click(within(finding_(MINOR)).getByRole("button", { name: t("designReview.findings.dismissLabel", { text: "A minor repetition." }) }));
    await waitFor(() => expect(mocks.runtime.decideDesignFinding).toHaveBeenCalledWith("book-1", { id: MINOR, action: "dismiss" }));
    expect(mocks.runtime.start).not.toHaveBeenCalled();
    expect(await screen.findByText(t("designReview.findings.announce.dismiss"), { selector: "[role='status']" })).toBeInTheDocument();
  });

  it("leaves a finding that concerns only her entries to her: the autopilot proposes, it is not asked to fix it", () => {
    show(fullState());
    const hers = finding_(HERS);
    expect(hers).toHaveTextContent(t("designReview.findings.authors"));
    expect(within(hers).queryByRole("button", { name: /Ask the autopilot to fix it/ })).not.toBeInTheDocument();
    expect(within(hers).getByRole("button", { name: t("designReview.findings.mineLabel", { text: "Her own entry contradicts chapter 3." }) })).toBeEnabled();
  });

  it("keeps what was decided apart: what the autopilot will fix, what is hers, and what is not a problem, with who said so and why", async () => {
    show(fullState((state) => {
      const findings = state.design!.coherence!.findings;
      findings.push(finding({ id: "a-00000006", text: "Being fixed.", status: "fixing" }), finding({ id: "a-00000007", text: "Taken by her.", status: "mine", decision: { by: "author", at: AT } }), finding({ id: "a-00000008", text: "Already fixed.", status: "fixed", decision: { by: "author", at: AT } }));
    }));
    const panel = sectionOf("designReview.findings.title");
    expect(panel.querySelector("[data-finding-group='fixing'] [data-finding='a-00000006']")).not.toBeNull();
    expect(panel.querySelector("[data-finding-group='mine'] [data-finding='a-00000007']")).toHaveTextContent("You");
    const dismissed = panel.querySelector("[data-finding-group='dismissed']") as HTMLElement;
    expect(dismissed.tagName).toBe("DETAILS");
    expect(dismissed).not.toHaveAttribute("open");
    expect(dismissed).toHaveTextContent("The director: It is deliberate.");
    expect(panel.querySelector("[data-finding-group='fixed']")?.tagName).toBe("DETAILS");
    // What is fixed says so by its group: who decided about it is told only of what is still to do.
    expect(panel.querySelector("[data-finding='a-00000008']")).not.toHaveTextContent("You");
    // A decision is taken back with its own button.
    fireEvent.click(within(finding_(DISMISSED)).getByRole("button", { name: t("designReview.findings.reopenLabel", { text: "A deliberate echo." }) }));
    await waitFor(() => expect(mocks.runtime.decideDesignFinding).toHaveBeenCalledWith("book-1", { id: DISMISSED, action: "reopen" }));
  });

  it("does not offer a fix when the design cannot be made again, and waits while something holds the book", () => {
    const { unmount } = show(fullState(), { designBlock: "written" });
    expect(within(finding_(MAJOR)).getByRole("button", { name: t("designReview.findings.fixLabel", { text: "The tide rule changes." }) })).toBeDisabled();
    expect(within(finding_(MAJOR)).getByRole("button", { name: t("designReview.findings.mineLabel", { text: "The tide rule changes." }) })).toBeEnabled();
    unmount();
    show(fullState(), { running: true });
    for (const button of within(finding_(MAJOR)).getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("says that the structure holds when the analysis found nothing", () => {
    show(stateOf({ coherence: { sig: "abc12345", round: 1, at: AT, summary: "", findings: [] } }));
    expect(sectionOf("designReview.findings.title").querySelector("[data-findings-none]")).toHaveTextContent(t("designReview.findings.none"));
  });
});

describe("the review on request", () => {
  it("asks for a review of the whole design with one button", async () => {
    show(stateOf());
    const card = sectionOf("designReview.request.title");
    fireEvent.click(within(card).getByRole("button", { name: t("designReview.request.whole") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: { reviewOnly: {} } }));
    expect(await screen.findByText(t("designReview.request.started"), { selector: "[role='status']" })).toBeInTheDocument();
  });

  it("asks for a review of one chapter, chosen by its title", async () => {
    show(stateOf());
    const card = sectionOf("designReview.request.title");
    const select = within(card).getByLabelText(t("designReview.request.chapterLabel")) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["1. Chapter title 1", "2. Chapter title 2", "3. Chapter title 3"]);
    fireEvent.change(select, { target: { value: "3" } });
    fireEvent.click(within(card).getByRole("button", { name: t("designReview.request.chapter") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1", { design: { reviewOnly: { chapters: [3] } } }));
  });

  it("is in the Studio whenever the Synopsis has chapters, and not when it has none", () => {
    const { unmount } = show(null, { entries: [] });
    expect(screen.queryByRole("region", { name: t("designReview.request.title") })).not.toBeInTheDocument();
    unmount();
    show(null);
    expect(screen.getByRole("region", { name: t("designReview.request.title") })).toBeInTheDocument();
  });

  it.each([
    ["running", { running: true }],
    ["designing", { designing: true }],
    ["server", { serverWithoutReview: true }],
  ] as const)("says why it cannot begin: %s", (reason, props) => {
    show(stateOf(), props);
    const card = sectionOf("designReview.request.title");
    expect(within(card).getByRole("button", { name: t("designReview.request.whole") })).toBeDisabled();
    expect(within(card).getByRole("button", { name: t("designReview.request.chapter") })).toBeDisabled();
    const why = card.querySelector("[data-review-blocked]") as HTMLElement;
    expect(why).toHaveAttribute("data-review-blocked", reason);
    expect(why).toHaveTextContent(t(`designReview.request.blocked.${reason}`, { version: "0.1.26" }));
    // The reason is what the button is described by, so that a screen reader says it with the button.
    expect(within(card).getByRole("button", { name: t("designReview.request.whole") }).getAttribute("aria-describedby")).toContain(why.id);
  });
});

describe("what a reader of a screen reads", () => {
  it("is a document of sections, each with its heading, and no heading level is skipped", () => {
    show(fullState());
    const reviews = document.querySelector("[data-design-reviews]") as HTMLElement;
    const levels = [...reviews.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) => Number(heading.tagName[1]));
    expect(levels[0]).toBe(2);
    levels.forEach((level, index) => { if (index > 0) expect(level - levels[index - 1], `heading ${index}`).toBeLessThanOrEqual(1); });
    expect(within(reviews).getAllByRole("region").map((region) => region.getAttribute("aria-labelledby"))).toEqual(["studio-alternatives-title", "studio-findings-title", "studio-rubric-title", "studio-review-title"]);
    for (const region of within(reviews).getAllByRole("region")) expect(document.getElementById(region.getAttribute("aria-labelledby")!)).not.toBeNull();
  });

  it("gives every button a name that begins with the words it shows, and no control without a name", () => {
    show(fullState());
    for (const button of screen.getAllByRole("button")) {
      const visible = (button.textContent ?? "").trim();
      const name = button.getAttribute("aria-label");
      expect(visible || name, "a button has a name").toBeTruthy();
      if (name && visible) expect(name.toLowerCase().startsWith(visible.toLowerCase()), `${name} / ${visible}`).toBe(true);
    }
    for (const control of screen.getAllByRole("combobox")) expect(control).toHaveAccessibleName();
  });

  it("shows a severity in a word, never only in a colour", () => {
    show(fullState());
    for (const item of document.querySelectorAll("[data-finding]")) {
      const severity = item.getAttribute("data-finding-severity")!;
      expect(item.textContent).toContain(t(`designReview.severity.${severity}`));
    }
  });

  it("is said in Italian when the app is", async () => {
    await i18n.changeLanguage("it");
    try {
      show(fullState());
      expect(screen.getByRole("heading", { level: 2, name: t("designReview.findings.title") })).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2, name: "Pitch alternativi" })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /^Chiedi all'autopilot di risolverlo: / }).length).toBeGreaterThan(0);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
