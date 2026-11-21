import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PlannedChapter } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { PlanCard } from "@/pages/AutopilotPage";
import { chapter, countTitleReads, longPlan, planOf, scene } from "./helpers/autopilotFixtures";
import smallPlanMarkup from "./helpers/autopilotPlanSmall.html?raw";

function show(chapters: PlannedChapter[], reviewNumber?: number, linked: string[] = []) {
  const props = { bookId: "book-1", plan: planOf(chapters), reviewNumber, linkedSlugs: new Set(linked) as ReadonlySet<string>, awaitingPlan: false };
  const view = render(<MemoryRouter><PlanCard {...props} /></MemoryRouter>);
  return {
    ...view,
    /** The plan downloaded again, with some chapters changed. */
    update(next: PlannedChapter[], nextReview = reviewNumber) {
      view.rerender(<MemoryRouter><PlanCard {...props} plan={planOf(next)} reviewNumber={nextReview} /></MemoryRouter>);
    },
  };
}

const rows = (container: HTMLElement) => container.querySelectorAll("ol > li > details").length;
const numbers = (container: HTMLElement) => [...container.querySelectorAll("ol > li > details > summary > span:first-child")].map((element) => Number.parseInt(element.textContent ?? "", 10));
const runs = () => screen.queryAllByRole("button").filter((button) => button.hasAttribute("aria-expanded"));
const run = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const rowOf = (title: string) => screen.getByText(title).closest("details") as HTMLDetailsElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
  show(longPlan(60, 10)).unmount();
});

afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("a plan of up to 40 chapters", () => {
  it("is drawn exactly as before: every chapter, with its scenes inside", () => {
    const small = [
      chapter(1, "done", { score: 9, summary: "The harbor wakes.", scenes: [scene(1, "reviewed", 1400), scene(2, "written", 1210)] }),
      chapter(2, "done", { imported: true }),
      chapter(3, "writing", { summary: "The wall cracks.", scenes: [scene(1, "written", 980), scene(2, "planned")] }),
      chapter(4, "planned"),
    ];
    const { container } = show(small, 3, ["001-chapter-1", "003-chapter-3"]);
    expect(container.querySelector("ol")!.outerHTML).toBe(smallPlanMarkup);
  });

  it("lists all 40 chapters with nothing hidden, and the scenes are already in the page", () => {
    const { container } = show(longPlan(40, 20), 21);
    expect(rows(container)).toBe(40);
    expect(numbers(container)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(runs()).toHaveLength(0);
    expect(screen.getByText("Scene 40.2")).toBeInTheDocument();
  });
});

describe("a plan of 41 chapters", () => {
  it("starts to hide the chapters between the window and the end, in a button that says what they are", () => {
    const { container } = show(longPlan(41, 0), 1);
    expect(numbers(container)).toEqual([1, 2, 3, 4, 5, 6, 37, 38, 39, 40, 41]);
    const hidden = runs();
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toHaveTextContent("30 chapters planned");
    expect(hidden[0]).toHaveTextContent("Chapters 7–36");
    expect(hidden[0]).toHaveTextContent("Show all");
    expect(hidden[0].tagName).toBe("BUTTON");
    expect(hidden[0]).toHaveAttribute("type", "button");
    expect(hidden[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("hides on both sides of the chapter in progress", () => {
    const { container } = show(longPlan(41, 20), 21);
    expect(numbers(container)).toEqual([1, 2, 3, 4, 5, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 37, 38, 39, 40, 41]);
    const [before, after] = runs();
    expect(before).toHaveTextContent("10 chapters approved");
    expect(before).toHaveTextContent("Chapters 6–15");
    expect(after).toHaveTextContent("10 chapters planned");
    expect(after).toHaveTextContent("Chapters 27–36");
  });

  it("says 'Show all' for a hidden run of at most 100 chapters and 'Show 50 more' for a longer one", () => {
    show(longPlan(111, 0), 1);
    expect(runs()[0]).toHaveTextContent("100 chapters planned");
    expect(runs()[0]).toHaveTextContent("Show all");
    cleanup();
    show(longPlan(112, 0), 1);
    expect(runs()[0]).toHaveTextContent("101 chapters planned");
    expect(runs()[0]).toHaveTextContent("Show 50 more");
  });
});

describe("a plan of 2000 chapters", () => {
  const plan = () => longPlan(2000, 999);

  it("opens with a window of 21 chapters, fast, with the chapter in progress in it", () => {
    const chapters = plan();
    const timings: number[] = [];
    let container!: HTMLElement;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      cleanup();
      const started = performance.now();
      ({ container } = show(chapters, 1000));
      timings.push(performance.now() - started);
    }

    // Generous: a busy machine may slow one render down. Drawing the 2000 rows took more than a second.
    expect(Math.min(...timings)).toBeLessThan(300);
    expect(rows(container)).toBeLessThanOrEqual(40);
    expect(numbers(container)).toEqual([1, 2, 3, 4, 5, ...Array.from({ length: 11 }, (_, index) => 995 + index), 1996, 1997, 1998, 1999, 2000]);
    expect(container.querySelectorAll("*").length).toBeLessThan(600);

    expect(screen.getByText("Title 1000")).toBeInTheDocument();
    expect(rowOf("Title 1000").className).toContain("border-primary/50");
    expect(rowOf("Title 999").className).not.toContain("border-primary/50");
    expect(screen.queryByText("Title 6")).not.toBeInTheDocument();
    expect(screen.queryByText("Title 1500")).not.toBeInTheDocument();
  });

  it("lines the titles up whatever the number of digits of the chapter numbers", () => {
    const { container } = show(plan(), 1000);
    const columns = new Set([...container.querySelectorAll("ol > li > details > summary > span:first-child")].map((element) => [...element.classList].find((name) => /^w-\d+$/.test(name))));
    expect([...columns]).toEqual(["w-9"]);
    cleanup();
    const wide = show(longPlan(100_000, 99_000), 99_001);
    expect(new Set([...wide.container.querySelectorAll("ol > li > details > summary > span:first-child")].map((element) => [...element.classList].find((name) => /^w-\d+$/.test(name)))).size).toBe(1);
    expect(wide.container.querySelector("ol > li > details > summary > span:first-child")).toHaveClass("w-12");
  });

  it("says what is hidden, with the numbers of the chapters", () => {
    show(plan(), 1000);
    expect(runs()).toHaveLength(2);
    expect(runs()[0]).toHaveTextContent("989 chapters approved");
    expect(runs()[0]).toHaveTextContent("Chapters 6–994");
    expect(runs()[0]).toHaveTextContent("Show 50 more");
    expect(runs()[1]).toHaveTextContent("990 chapters planned");
    expect(runs()[1]).toHaveTextContent("Chapters 1006–1995");
  });

  it("shows the next 50 chapters of a run each time it is opened", () => {
    const { container } = show(plan(), 1000);
    fireEvent.click(run(/989 chapters approved/));
    expect(rows(container)).toBe(71);
    expect(numbers(container).slice(0, 55)).toEqual(Array.from({ length: 55 }, (_, index) => index + 1));
    expect(runs()[0]).toHaveTextContent("939 chapters approved");
    expect(runs()[0]).toHaveTextContent("Chapters 56–994");
    expect(screen.queryByText("Title 56")).not.toBeInTheDocument();

    fireEvent.click(run(/939 chapters approved/));
    expect(rows(container)).toBe(121);
    expect(runs()[0]).toHaveTextContent("889 chapters approved");
    expect(runs()[1]).toHaveTextContent("990 chapters planned");
  });

  it("keeps the focus on the button it was opened with", () => {
    show(plan(), 1000);
    const button = run(/989 chapters approved/);
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(button).toHaveTextContent("939 chapters approved");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("builds the scenes of a chapter only when it is opened", async () => {
    show(plan(), 1000);
    expect(screen.queryByText("Scene 1000.1")).not.toBeInTheDocument();
    expect(screen.queryByText("Summary 1000")).not.toBeInTheDocument();
    fireEvent.click(rowOf("Title 1000").querySelector("summary")!);
    expect(await screen.findByText("Scene 1000.1")).toBeInTheDocument();
    expect(screen.getByText("Summary 1000")).toBeInTheDocument();
    expect(screen.queryByText("Scene 999.1")).not.toBeInTheDocument();
    fireEvent.click(rowOf("Title 1000").querySelector("summary")!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByText("Scene 1000.1")).not.toBeInTheDocument();
  });

  it("offers the link of an opened chapter that exists in the book", async () => {
    show(plan(), 1000, ["1000-chapter-title"]);
    fireEvent.click(rowOf("Title 1000").querySelector("summary")!);
    await screen.findByText("Scene 1000.1");
    expect(screen.queryByRole("link", { name: i18n.t("common.open") })).not.toBeInTheDocument();
    cleanup();
    show(plan(), 1000, ["1000-chapter-1000"]);
    fireEvent.click(rowOf("Title 1000").querySelector("summary")!);
    expect(await screen.findByRole("link", { name: i18n.t("common.open") })).toHaveAttribute("href", "/app/books/book-1/chapters/1000-chapter-1000");
  });
});

describe("the rows of a long plan", () => {
  const total = (reads: Map<number, number>) => [...reads.values()].reduce((sum, count) => sum + count, 0);

  it("draw only themselves when a hidden run is opened: the chapters already listed are left alone", () => {
    const reads = new Map<number, number>();
    show(countTitleReads(longPlan(2000, 999), reads), 1000);
    expect(total(reads)).toBe(21);

    fireEvent.click(run(/989 chapters approved/));
    expect(total(reads)).toBe(21 + 50);
    fireEvent.click(run(/939 chapters approved/));
    expect(total(reads)).toBe(21 + 50 + 50);
  });

  it("draw only themselves when one of them is opened", async () => {
    const reads = new Map<number, number>();
    show(countTitleReads(longPlan(2000, 999), reads), 1000);
    fireEvent.click(rowOf("Title 1000").querySelector("summary")!);
    await screen.findByText("Scene 1000.1");
    expect(total(reads)).toBeLessThanOrEqual(21 + 2);
  });
});

describe("the plan of another book", () => {
  it("does not inherit what the author opened in the plan of the previous one", () => {
    const props = { plan: planOf(longPlan(2000, 999)), reviewNumber: 1000, linkedSlugs: new Set<string>() as ReadonlySet<string>, awaitingPlan: false };
    const view = render(<MemoryRouter><PlanCard bookId="book-1" {...props} /></MemoryRouter>);
    fireEvent.click(run(/989 chapters approved/));
    expect(screen.getByText("Title 55")).toBeInTheDocument();

    view.rerender(<MemoryRouter><PlanCard bookId="book-2" {...props} plan={planOf(longPlan(2000, 999))} /></MemoryRouter>);
    expect(screen.queryByText("Title 55")).not.toBeInTheDocument();
    expect(runs()[0]).toHaveTextContent("989 chapters approved");
  });
});

describe("the window while the run goes on", () => {
  it("follows the chapter in progress", () => {
    const view = show(longPlan(2000, 999), 1000);
    expect(screen.getByText("Title 995")).toBeInTheDocument();
    expect(screen.queryByText("Title 1006")).not.toBeInTheDocument();

    view.update(longPlan(2000, 1000), 1001);
    expect(screen.queryByText("Title 995")).not.toBeInTheDocument();
    expect(screen.getByText("Title 996")).toBeInTheDocument();
    expect(screen.getByText("Title 1006")).toBeInTheDocument();
    expect(rowOf("Title 1001").className).toContain("border-primary/50");
    expect(runs()[0]).toHaveTextContent("990 chapters approved");
    expect(runs()[0]).toHaveTextContent("Chapters 6–995");
    expect(runs()[1]).toHaveTextContent("989 chapters planned");
    expect(runs()[1]).toHaveTextContent("Chapters 1007–1995");
  });

  it("keeps what the author opened where it is, and goes on from there", () => {
    const view = show(longPlan(2000, 999), 1000);
    fireEvent.click(run(/989 chapters approved/));
    expect(screen.getByText("Title 55")).toBeInTheDocument();

    view.update(longPlan(2000, 1004), 1005);
    expect(screen.getByText("Title 6")).toBeInTheDocument();
    expect(screen.getByText("Title 55")).toBeInTheDocument();
    expect(screen.queryByText("Title 56")).not.toBeInTheDocument();
    expect(runs()[0]).toHaveTextContent("944 chapters approved");
    expect(runs()[0]).toHaveTextContent("Chapters 56–999");
    expect(screen.getByText("Title 1010")).toBeInTheDocument();
  });

  it("keeps an opened chapter in the list after the window moved past it", async () => {
    const view = show(longPlan(2000, 999), 1000);
    fireEvent.click(rowOf("Title 998").querySelector("summary")!);
    await screen.findByText("Scene 998.1");

    view.update(longPlan(2000, 1010), 1011);
    expect(screen.getByText("Title 998")).toBeInTheDocument();
    expect(screen.getByText("Scene 998.1")).toBeInTheDocument();
    expect(screen.queryByText("Title 997")).not.toBeInTheDocument();
    expect(runs()).toHaveLength(3);
  });

  it("shows only the two ends of a plan whose chapters are all approved", () => {
    const { container } = show(longPlan(2000, 2000));
    expect(numbers(container)).toEqual([1, 2, 3, 4, 5, 1996, 1997, 1998, 1999, 2000]);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toHaveTextContent("1,990 chapters approved");
    expect(runs()[0]).toHaveTextContent("Chapters 6–1995");
  });
});

describe("a hidden run that is short", () => {
  it("is shown whole by 'Show all', and the focus goes to its first chapter", () => {
    const { container } = show(longPlan(100, 0), 1);
    const button = run(/89 chapters planned/);
    expect(button).toHaveTextContent("Show all");
    button.focus();
    fireEvent.click(button);

    expect(runs()).toHaveLength(0);
    expect(rows(container)).toBe(100);
    expect(document.activeElement?.tagName).toBe("SUMMARY");
    expect(document.activeElement).toHaveTextContent("7.");
  });

  it("is shown in a few clicks when it is long", () => {
    const { container } = show(longPlan(300, 0), 1);
    let clicks = 0;
    while (runs().length && clicks < 20) {
      fireEvent.click(runs()[0]);
      clicks += 1;
    }
    expect(rows(container)).toBe(300);
    expect(clicks).toBe(5);
  });
});

describe("what a hidden run holds", () => {
  it("is written for a mix of chapters, in English", () => {
    show(longPlan(41, 11, (number) => (number === 20 || number === 21 ? "done" : number === 30 ? "review" : undefined)), 12);
    expect(runs()).toHaveLength(2);
    expect(runs()[0]).toHaveTextContent("1 chapter approved");
    expect(runs()[0]).toHaveTextContent("Chapter 6");
    expect(runs()[1]).toHaveTextContent("19 chapters: 2 approved, 1 in progress, 16 planned");
    expect(runs()[1]).toHaveTextContent("Chapters 18–36");
  });

  it("tells the chapters the author wrote from the ones the autopilot wrote, in both languages", async () => {
    const written = (until: number) => longPlan(2000, 1500).map((entry) => (entry.number <= until ? { ...entry, imported: true } : entry));

    show(written(1495), 1501);
    expect(runs()[0]).toHaveTextContent("1,490 chapters written by you");
    cleanup();

    show(written(1200), 1501);
    expect(runs()[0]).toHaveTextContent("1,490 chapters: 1,195 written by you, 295 approved");
    cleanup();

    await act(async () => { await i18n.changeLanguage("it"); });
    show(written(6), 1501);
    expect(runs()[0]).toHaveTextContent("1490 capitoli: 1 scritto da te, 1489 approvati");
  });

  it("is written in Italian, with its own plurals", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    show(longPlan(41, 11, (number) => (number === 20 || number === 21 ? "done" : undefined)), 12);
    expect(runs()[0]).toHaveTextContent("1 capitolo approvato");
    expect(runs()[0]).toHaveTextContent("Capitolo 6");
    expect(runs()[0]).toHaveTextContent("Mostra tutti");
    expect(runs()[1]).toHaveTextContent("19 capitoli: 2 approvati, 17 pianificati");
    expect(runs()[1]).toHaveTextContent("Capitoli 18–36");
    cleanup();

    show(longPlan(2000, 999), 1000);
    expect(runs()[0]).toHaveTextContent("989 capitoli approvati");
    expect(runs()[0]).toHaveTextContent("Mostra altri 50");
    expect(runs()[1]).toHaveTextContent("990 capitoli pianificati");
  });
});
