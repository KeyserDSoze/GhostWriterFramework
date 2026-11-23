import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AutopilotFinalReview, ChapterRound, PlannedChapter } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotResult } from "@/components/autopilot/AutopilotResult";
import { useAutopilotStore } from "@/autopilot/store";
import { useAskDirectorStore } from "@/store/askDirectorStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { judgedPlan, longPlan } from "./helpers/autopilotFixtures";
import { activityOf, seedRun } from "./helpers/autopilotBand";
import { t } from "./helpers/quickCommands";

const WORDS = "The arc holds: the lighthouse ledger pays off in the last chapter and the open threads are closed with care.";
const LONG_WORDS = `${WORDS} The middle of the book drags a little, chapters 8 to 11 repeat the same fog-and-doubt beat without moving the keeper's decision forward, and the epilogue is rushed. The prose is steady and the secret of the third light is revealed at the right moment. Consider a longer epilogue and trimming one of the fog chapters.`;
const REVIEW: AutopilotFinalReview = { verdict: "approve", score: 8, text: WORDS, at: "2026-11-21T10:30:00.000Z" };

const round = (director: number, readers?: number, accepted = 0, rejected = 0): ChapterRound => ({ director, ...(readers !== undefined ? { readers } : {}), accepted, rejected });

const judged = judgedPlan;

const FINAL_STEP = activityOf("final", { phase: "final", title: "The director reviews the whole book", summary: `approve 8/10 — ${WORDS}`, startedAt: "2026-11-21T10:00:00.000Z", endedAt: "2026-11-21T10:00:41.000Z" });
const slugs = (count = 12) => new Set(Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(3, "0")}-chapter-${index + 1}`));

function done(options: { chapters?: PlannedChapter[]; review?: AutopilotFinalReview | null; stats?: Record<string, unknown>; activities?: ReturnType<typeof activityOf>[]; status?: "completed" | "paused" | "running" | "error"; statePatch?: Record<string, unknown> } = {}) {
  const review = options.review === undefined ? REVIEW : options.review;
  return seedRun({
    status: options.status ?? "completed",
    phase: "completed",
    chapters: options.chapters ?? judged(),
    message: "The book is complete.",
    statePatch: { finalDone: true, ...(review ? { finalReview: review } : {}), ...options.statePatch },
    stats: { cost: 17.62, aiCalls: 366, inputTokens: 1_240_000, outputTokens: 402_000, workedMs: 13_260_000, ...options.stats },
    activities: options.activities ?? [FINAL_STEP],
  });
}

function show(linked: ReadonlySet<string> = slugs()) {
  return render(<MemoryRouter><AutopilotResult bookId="book-1" linkedSlugs={linked} /></MemoryRouter>);
}

const card = () => document.querySelector<HTMLElement>("[data-autopilot-result]") as HTMLElement;
const figure = (label: string) => within(card()).getByText(label, { selector: "dt" }).closest("div")?.querySelector("dd") as HTMLElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAskDirectorStore.getState().close();
  await i18n.changeLanguage("en");
});

describe("the result of a book that is finished", () => {
  it("is a card of its own, with a heading, once the book is complete", () => {
    done();
    show();
    expect(card()).not.toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: t("autopilot.result.title") })).toBeInTheDocument();
    expect(card().getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { level: 2, name: t("autopilot.result.title") }).id);
  });

  it.each(["paused", "running", "error"] as const)("is not there while the book is %s", (status) => {
    done({ status });
    const view = show();
    expect(card()).toBeNull();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("is not there for a book that has no autopilot yet", () => {
    seedRun({ noState: true });
    show();
    expect(card()).toBeNull();
  });
});

describe("the verdict of the director", () => {
  it("is the score, big, with its scale, and the verdict in words with an icon: not told by colour alone", () => {
    done();
    show();
    const block = screen.getByRole("heading", { level: 3, name: t("autopilot.result.verdict.title") }).parentElement as HTMLElement;
    expect(within(block).getByText(t("autopilot.result.verdict.approve"))).toBeInTheDocument();
    expect(within(block).getByText(t("autopilot.result.verdict.score", { score: 8 }))).toBeInTheDocument();
    const score = block.querySelector<HTMLElement>("[data-result-score]") as HTMLElement;
    expect(score).toHaveTextContent("8/10");
    expect(score.className).toMatch(/text-(4xl|5xl|6xl)/);
    expect(block.querySelector("svg[aria-hidden='true']"), "the verdict has an icon, which is decoration").not.toBeNull();
  });

  it("says a verdict that asks for a revision in words, and what to do: the book is closed all the same, and nothing is approved by default", () => {
    done({ review: { verdict: "revise", score: 7, text: "Good, but the middle drags.", at: REVIEW.at } });
    show();
    expect(screen.getByText(t("autopilot.result.verdict.revise"))).toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.result.verdict.approve"))).not.toBeInTheDocument();
    expect(screen.getByText("Good, but the middle drags.")).toBeInTheDocument();
    expect(screen.getByText(t("autopilot.result.verdict.reviseHint"))).toBeInTheDocument();
  });

  it("does not give the hint to a book that was approved", () => {
    done();
    show();
    expect(screen.queryByText(t("autopilot.result.verdict.reviseHint"))).not.toBeInTheDocument();
  });

  it("writes a score with a decimal part the way the language does", async () => {
    done({ review: { ...REVIEW, score: 7.5 } });
    show();
    expect(card().querySelector("[data-result-score]")).toHaveTextContent("7.5/10");
    cleanup();
    await i18n.changeLanguage("it");
    show();
    expect(card().querySelector("[data-result-score]")).toHaveTextContent("7,5/10");
  });

  it("shows the words of the director, and when they are long gives the whole of them on request, naming what the button does", () => {
    done({ review: { ...REVIEW, text: LONG_WORDS } });
    show();
    const words = card().querySelector<HTMLElement>("[data-result-words]") as HTMLElement;
    expect(words).toHaveTextContent(LONG_WORDS);
    const more = screen.getByRole("button", { name: t("autopilot.result.verdict.showAll") });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveAttribute("aria-controls", words.id);
    expect(words.className).toMatch(/line-clamp/);
    fireEvent.click(more);
    const less = screen.getByRole("button", { name: t("autopilot.result.verdict.showLess") });
    expect(less).toHaveAttribute("aria-expanded", "true");
    expect(words.className).not.toMatch(/line-clamp/);
  });

  it("has no button for words that are short", () => {
    done();
    show();
    expect(screen.queryByRole("button", { name: t("autopilot.result.verdict.showAll") })).not.toBeInTheDocument();
  });

  it("takes the whole words of the saved state when the summary has them cut: it is the same review", () => {
    done({ review: { ...REVIEW, text: LONG_WORDS } });
    const summary = useAutopilotStore.getState().summaries["book-1"];
    expect(summary.finalReview?.text.length, "the summary has the words cut").toBeLessThan(LONG_WORDS.length);
    show();
    expect(card().querySelector("[data-result-words]")).toHaveTextContent(LONG_WORDS);
  });

  it("reads the verdict from the log for a state that an older engine wrote, the way the band did", () => {
    done({ review: null });
    show();
    expect(card().querySelector("[data-result-score]")).toHaveTextContent("8/10");
    expect(screen.getByText(t("autopilot.result.verdict.approve"))).toBeInTheDocument();
    expect(card().querySelector("[data-result-words]")).toHaveTextContent(WORDS);
  });

  it("says nothing of a verdict when there is none to say, and does not make one up", () => {
    done({ review: null, activities: [] });
    show();
    expect(screen.queryByRole("heading", { name: t("autopilot.result.verdict.title") })).not.toBeInTheDocument();
    expect(screen.queryByText(t("autopilot.result.verdict.approve"))).not.toBeInTheDocument();
    expect(card().querySelector("[data-result-score]")).toBeNull();
    // What is there is still told: the figures.
    expect(figure(t("autopilot.result.numbers.cost"))).toHaveTextContent("$17.62");
  });

  it("tells the words of a log that the engine did not write the usual way, without a score", () => {
    done({ review: null, activities: [activityOf("final", { summary: "The book is good." })] });
    show();
    expect(card().querySelector("[data-result-words]")).toHaveTextContent("The book is good.");
    expect(card().querySelector("[data-result-score]")).toBeNull();
    expect(screen.queryByText(t("autopilot.result.verdict.approve"))).not.toBeInTheDocument();
  });
});

describe("the figures", () => {
  it("are the chapters, the scenes, the words, the working time the engine counted, the cost, the tokens and the calls", () => {
    done({ stats: { workedMs: 13_260_000 } });
    show();
    const labels = [...card().querySelectorAll("dt")].map((item) => item.textContent);
    expect(labels).toEqual([t("autopilot.result.numbers.chapters"), t("autopilot.result.numbers.scenes"), t("autopilot.result.numbers.words"), t("autopilot.result.numbers.time"), t("autopilot.result.numbers.cost"), t("autopilot.result.numbers.tokens"), t("autopilot.result.numbers.calls")]);
    expect(figure(t("autopilot.result.numbers.chapters"))).toHaveTextContent("12");
    expect(figure(t("autopilot.result.numbers.scenes"))).toHaveTextContent("24");
    expect(figure(t("autopilot.result.numbers.words"))).toHaveTextContent("16,800");
    expect(figure(t("autopilot.result.numbers.time"))).toHaveTextContent("3h 41m");
    expect(figure(t("autopilot.result.numbers.time"))).not.toHaveTextContent(t("autopilot.result.numbers.timeAtLeast", { time: "3h 41m" }));
    expect(figure(t("autopilot.result.numbers.cost"))).toHaveTextContent("$17.62");
    expect(figure(t("autopilot.result.numbers.tokens"))).toHaveTextContent("1.6M");
    expect(figure(t("autopilot.result.numbers.calls"))).toHaveTextContent("366");
  });

  it.each([["en", "counted since Nov 25, 2026"], ["it", "contato dal 25 nov 2026"]] as const)("say since when the time is counted, for a book that is older than the count: what was done before is not in it (%s)", async (language, words) => {
    await i18n.changeLanguage(language);
    done({ stats: { workedMs: 13_260_000, workedMsSince: "2026-11-25T12:00:00.000Z" } });
    show();
    const time = figure(t("autopilot.result.numbers.time"));
    expect(time).toHaveTextContent("3h 41m");
    expect(time).toHaveTextContent(words);
    expect(time).not.toHaveTextContent(t("autopilot.result.numbers.timeAtLeast", { time: "3h 41m" }));
    // In a narrow column the phrase goes to the next line whole, and is not cut between «counted» and «since».
    expect(within(time).getByText(words).className).toMatch(/\binline-block\b/);
  });

  it("say nothing of the beginning of the count when the engine did not say it, or when the count began with the book", () => {
    done({ stats: { workedMs: 13_260_000 } });
    show();
    expect(figure(t("autopilot.result.numbers.time"))).not.toHaveTextContent(/counted since/);
    cleanup();
    done({ stats: { workedMs: 13_260_000, workedMsSince: "2026-11-21T10:00:30.000Z" } });
    show();
    expect(figure(t("autopilot.result.numbers.time"))).not.toHaveTextContent(/counted since/);
  });

  it("say nothing of it, and make no date up, when the moment the engine gives is not a date", () => {
    done({ stats: { workedMs: 13_260_000, workedMsSince: "yesterday" } });
    show();
    expect(figure(t("autopilot.result.numbers.time"))).toHaveTextContent("3h 41m");
    expect(figure(t("autopilot.result.numbers.time"))).not.toHaveTextContent(/counted since/);
  });

  it("have the time of the log, said to be a minimum, when the engine did not count it and the log is full: the oldest steps are gone", () => {
    const full = [...Array.from({ length: 199 }, (_, index) => activityOf("write", { id: `w-${index}`, startedAt: "2026-11-21T09:00:00.000Z", endedAt: "2026-11-21T09:01:00.000Z" })), FINAL_STEP];
    done({ stats: { workedMs: undefined }, activities: full });
    show();
    expect(figure(t("autopilot.result.numbers.time"))).toHaveTextContent(t("autopilot.result.numbers.timeAtLeast", { time: "3h 19m" }));
  });

  it("have the time of the log as it is when the log is not full", () => {
    done({ stats: { workedMs: undefined }, activities: [activityOf("write", { startedAt: "2026-11-21T09:00:00.000Z", endedAt: "2026-11-21T10:01:00.000Z" }), FINAL_STEP] });
    show();
    expect(figure(t("autopilot.result.numbers.time"))).toHaveTextContent("1h 01m");
    expect(figure(t("autopilot.result.numbers.time"))).not.toHaveTextContent(t("autopilot.result.numbers.timeAtLeast", { time: "1h 01m" }));
  });

  it("leave out what is not there: no time, no cost, no tokens, no calls are shown as zero", () => {
    done({ stats: { workedMs: undefined, cost: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0 }, activities: [] });
    show();
    const labels = [...card().querySelectorAll("dt")].map((item) => item.textContent);
    expect(labels).toEqual([t("autopilot.result.numbers.chapters"), t("autopilot.result.numbers.scenes"), t("autopilot.result.numbers.words")]);
  });

  it("are a list of terms and values, so that a screen reader says each with its name", () => {
    done();
    show();
    const list = card().querySelector("dl") as HTMLElement;
    expect(list.querySelectorAll("dt").length).toBe(list.querySelectorAll("dd").length);
    expect(screen.getByRole("heading", { level: 3, name: t("autopilot.result.numbers.title") })).toBeInTheDocument();
  });
});

describe("the scores of the chapters", () => {
  const table = () => screen.getByRole("table", { name: t("autopilot.result.scores.title") });
  const rowsOf = () => within(table()).getAllByRole("row").slice(1);
  const numberOf = (row: HTMLElement) => Number(within(row).getAllByRole("rowheader")[0].textContent?.match(/^\d+/)?.[0]);

  it("are a table of the chapter, the final score, the score of each round and the readers, that a screen reader can read", () => {
    done();
    show();
    expect(table()).toHaveAccessibleDescription(t("autopilot.result.scores.caption"));
    expect(within(table()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([t("autopilot.result.scores.chapter"), t("autopilot.result.scores.final"), t("autopilot.result.scores.round", { number: 1 }), t("autopilot.result.scores.round", { number: 2 }), t("autopilot.result.scores.round", { number: 3 }), t("autopilot.result.scores.readers")]);
    const fourth = rowsOf()[3];
    expect(within(fourth).getByRole("rowheader")).toHaveTextContent("4 · Title 4");
    expect([...fourth.querySelectorAll("td")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim())).toEqual(["6", "4.5", "5.5", "6", "6.5"]);
  });

  describe("and what each round decided, when the plan says it", () => {
    /** The plan of an engine that records the verdict: every round but the last sent the chapter back, the last closed it. */
    const withVerdicts = (chapters: PlannedChapter[]): PlannedChapter[] => chapters.map((entry) => (entry.rounds ? { ...entry, rounds: entry.rounds.map((one, index, all) => ({ ...one, verdict: index === all.length - 1 ? ("approve" as const) : ("revise" as const) })) } : entry));
    const roundCells = (row: HTMLElement) => [...row.querySelectorAll("td")].slice(1, 4);

    it.each([["en"], ["it"]] as const)("tells in words, next to the score of a round that sent the chapter back, and not by a colour (%s)", async (language) => {
      await i18n.changeLanguage(language);
      done({ chapters: withVerdicts(judged()) });
      show();
      const fourth = rowsOf()[3];
      const [first, second, third] = roundCells(fourth);
      for (const cell of [first, second]) {
        expect(cell.querySelector("[data-round-verdict=revise]")).not.toBeNull();
        expect(cell).toHaveTextContent(t("autopilot.result.scores.revised"));
      }
      expect(third.querySelector("[data-round-verdict]")).toBeNull();
      expect(third).not.toHaveTextContent(t("autopilot.result.scores.revised"));
      expect(t("autopilot.result.scores.revised")).toBe(language === "en" ? "sent back for revision" : "rimandato in revisione");
    });

    it("explains the sign once, in a line under the table, when the table has such a round", () => {
      done({ chapters: withVerdicts(judged()) });
      show();
      expect(screen.getAllByText(t("autopilot.result.scores.reviseLegend"))).toHaveLength(1);
      expect(t("autopilot.result.scores.reviseLegend")).toBe("↻ The round sent the chapter back for fixes.");
    });

    it("says nothing of a verdict, and shows no sign and no legend, for a plan that records none: an older state", () => {
      done();
      show();
      expect(card().querySelector("[data-round-verdict]")).toBeNull();
      expect(screen.queryByText(t("autopilot.result.scores.reviseLegend"))).not.toBeInTheDocument();
    });

    it("keeps the cells of a round as they were for the readers of the table: the score, and the words after it only for a round that sent the chapter back", () => {
      done({ chapters: withVerdicts(judged()) });
      show();
      const fourth = rowsOf()[3];
      expect([...fourth.querySelectorAll("td")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim())).toEqual(["6", "↻ 4.5 sent back for revision", "↻ 5.5 sent back for revision", "6", "6.5"]);
    });

    it("puts the sign before the score, so that the digits of a right-aligned column stay under one another, and says the score first to a screen reader, then the words", () => {
      done({ chapters: withVerdicts(judged()) });
      show();
      const [flagged, , plain] = roundCells(rowsOf()[3]);
      const sign = flagged.querySelector("[data-round-verdict]") as HTMLElement;
      expect(sign).toHaveAttribute("aria-hidden", "true");
      // The sign comes before the score in the cell: the score is the last thing the eye sees at the right edge, as in the cells that have no sign.
      expect(flagged.textContent?.trimStart().startsWith("↻")).toBe(true);
      // They are held together by a space that does not break: in a narrow cell (a phone) the sign must not be left alone on a line above the score.
      expect(flagged.textContent).toContain("↻\u00a04.5");
      expect(plain.textContent?.trim()).toBe("6");
      // What is read out: the score, then what the round decided; never the sign.
      const heard = flagged.cloneNode(true) as HTMLElement;
      heard.querySelectorAll("[aria-hidden=true]").forEach((node) => node.remove());
      expect(heard.textContent?.replace(/\s+/g, " ").trim()).toBe("4.5 sent back for revision");
    });
  });

  it("say that a round has no score in words, not with a bare dash", () => {
    done();
    show();
    const first = rowsOf()[0];
    expect(within(first).getAllByText(t("autopilot.result.scores.none")).length).toBeGreaterThan(0);
  });

  it("have no column for the readers when none of the chapters has an average of them, and none for the rounds when no chapter has a record", () => {
    done({ chapters: judged(12, false) });
    show();
    const headers = within(table()).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual([t("autopilot.result.scores.chapter"), t("autopilot.result.scores.final")]);
  });

  it("show all of a short book, in the order of the chapters, with no button to show more", () => {
    done();
    show();
    expect(rowsOf()).toHaveLength(12);
    expect(rowsOf().map(numberOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("draw a window of a long book, the first chapters, and give the rest when asked; and can be made short again", () => {
    done({ chapters: judged(64) });
    show(slugs(64));
    expect(rowsOf()).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.result.scores.showAll", { count: 64 }) }));
    expect(rowsOf()).toHaveLength(64);
    expect(screen.queryByRole("button", { name: t("autopilot.result.scores.showAll", { count: 64 }) })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.result.scores.showFewer") }));
    expect(rowsOf()).toHaveLength(10);
  });

  it("keep the focus on the button that asked for more rows: the button is the same one, and says what it does next", () => {
    done({ chapters: judged(64) });
    show(slugs(64));
    const button = screen.getByRole("button", { name: t("autopilot.result.scores.showAll", { count: 64 }) });
    button.focus();
    fireEvent.click(button);
    expect(rowsOf()).toHaveLength(64);
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAccessibleName(t("autopilot.result.scores.showFewer"));
    fireEvent.click(button);
    expect(rowsOf()).toHaveLength(10);
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAccessibleName(t("autopilot.result.scores.showAll", { count: 64 }));
  });

  it("are put in the order of the score, the lowest first, by a choice of two that a keyboard can make and a screen reader names", () => {
    done({ chapters: judged(64) });
    show(slugs(64));
    const group = screen.getByRole("radiogroup", { name: t("autopilot.result.scores.order.label") });
    const [byChapter, byScore] = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(byChapter).toBeChecked();
    expect(byChapter).toHaveAccessibleName(t("autopilot.result.scores.order.chapter"));
    expect(byScore).toHaveAccessibleName(t("autopilot.result.scores.order.lowest"));
    expect(byChapter.name).toBe(byScore.name);
    fireEvent.click(byScore);
    expect(byScore).toBeChecked();
    // The lowest of the twelve we know: chapter 8 (5.5), then chapter 4 (6) and chapter 6 (7).
    expect(rowsOf().slice(0, 3).map(numberOf)).toEqual([8, 4, 6]);
  });

  it("keep the words that only a screen reader hears inside the box that scrolls: it is the box they are positioned in, so they do not make the page wider than the screen", () => {
    done();
    show();
    const region = screen.getByRole("region", { name: t("autopilot.result.scores.title") });
    expect(region.querySelectorAll(".sr-only").length, "there are such words in the table").toBeGreaterThan(0);
    expect(region.className).toMatch(/(^|\s)relative(\s|$)/);
    expect(region.className).toMatch(/(^|\s)overflow-x-auto(\s|$)/);
  });

  it("make a link of a chapter the book has, and plain words of one it has not (it is not in the book yet)", () => {
    done();
    show(new Set(["004-chapter-4"]));
    const rows = rowsOf();
    expect(within(rows[3]).getByRole("link", { name: /Title 4/ })).toHaveAttribute("href", "/app/books/book-1/chapters/004-chapter-4");
    expect(within(rows[0]).queryByRole("link")).toBeNull();
  });

  it("have a picture of the final scores with the words that say it: the lowest, the highest, the average, from which chapter to which", () => {
    done();
    show();
    const chart = screen.getByRole("img", { name: t("autopilot.result.scores.chart", { first: 1, last: 12, min: 5.5, minChapter: 8, max: 9, maxChapter: 3, average: 7.7 }) });
    expect(chart.querySelectorAll("[data-bar]").length).toBe(12);
  });

  it("have no table, no picture and no section when the director scored none of the chapters", () => {
    done({ chapters: longPlan(12, 12) .map((entry) => ({ ...entry, score: undefined })) as PlannedChapter[] });
    show();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: t("autopilot.result.scores.title") })).not.toBeInTheDocument();
  });

  it("do not read the title of a chapter that is not shown", () => {
    const reads = new Set<number>();
    const guarded = judged(64).map((entry) => Object.defineProperty({ ...entry }, "title", { enumerable: true, get: () => { reads.add(entry.number); return `Chapter title ${entry.number}`; } }) as PlannedChapter);
    done({ chapters: guarded });
    show(slugs(64));
    expect(reads.size).toBeLessThanOrEqual(10 + 3);
  });
});

describe("what to read first", () => {
  const list = () => screen.getByRole("list", { name: t("autopilot.result.read.title") });

  it("are the three chapters that need the most attention, each with a line that says why and the way to read it", () => {
    done();
    show();
    const items = within(list()).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Chapter 8 (5.5, three rounds) is the lowest of the book and needed the most rounds; chapter 4 (6, three rounds); chapter 6 (7, two rounds).
    expect(within(items[0]).getByRole("link", { name: /Chapter 8/ })).toHaveAttribute("href", "/app/books/book-1/chapters/008-chapter-8");
    expect(items[0]).toHaveTextContent(t("autopilot.result.read.why.both", { score: 5.5, count: 3 }));
    expect(within(items[1]).getByRole("link", { name: /Chapter 4/ })).toBeInTheDocument();
    expect(items[1]).toHaveTextContent(t("autopilot.result.read.why.both", { score: 6, count: 3 }));
  });

  it("say that a chapter is not under the average but needed many rounds, and the lowest of the book when it needed one", () => {
    const chapters = judged(12).map((entry, index) => (index === 2 ? { ...entry, score: 9, rounds: [round(4), round(5), round(6), round(6.5), round(7), round(7.5), round(8), round(9)] } : entry));
    done({ chapters });
    show();
    const items = within(list()).getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.match(/Chapter (\d+)/)?.[1])).toEqual(["8", "4", "3"]);
    expect(items[2]).toHaveTextContent(t("autopilot.result.read.why.rounds", { score: 9, count: 8 }));
  });

  it("name a chapter that is not a link when the book does not have it, and still say why", () => {
    done();
    show(new Set());
    const first = within(list()).getAllByRole("listitem")[0];
    expect(within(first).queryByRole("link")).toBeNull();
    expect(first).toHaveTextContent("Chapter 8");
  });

  it("are not offered when the director scored none of the chapters", () => {
    done({ chapters: longPlan(12, 12).map((entry) => ({ ...entry, score: undefined })) as PlannedChapter[] });
    show();
    expect(screen.queryByRole("heading", { name: t("autopilot.result.read.title") })).not.toBeInTheDocument();
  });
});

describe("what to do next", () => {
  it("is to add chapters (the same as the band offers), to read the book, to export it and to ask the director", () => {
    done();
    show();
    const group = screen.getByRole("group", { name: t("autopilot.result.actions.label") });
    // Changed on purpose (the menu in groups): the number of chapters is in the configuration, a page of its own.
    expect(within(group).getByRole("link", { name: t("autopilot.result.actions.add") })).toHaveAttribute("href", "/app/books/book-1/outline");
    expect(within(group).getByRole("link", { name: t("autopilot.result.actions.read") })).toHaveAttribute("href", "/app/books/book-1/reader");
    expect(within(group).getByRole("link", { name: t("autopilot.result.actions.export") })).toHaveAttribute("href", "/app/books/book-1/export");
    expect(within(group).getByRole("button", { name: t("autopilot.result.actions.ask") })).toBeInTheDocument();
  });

  it("opens the question to the director about the whole book, in the window that already exists", () => {
    done();
    show();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.result.actions.ask") }));
    expect(useAskDirectorStore.getState().request).toEqual({ bookId: "book-1", target: { kind: "book" } });
  });

  it("does not offer to resume a book that is complete", () => {
    done();
    show();
    expect(screen.queryByRole("button", { name: new RegExp(t("autopilot.actions.resume")) })).not.toBeInTheDocument();
  });
});

describe("a state that an older engine wrote", () => {
  it("shows what is there and nothing that is not: no verdict from the engine, no time it did not count, no rounds it did not record", () => {
    done({ review: null, chapters: judged(12, false), stats: { workedMs: undefined }, activities: [activityOf("write", { startedAt: "2026-11-21T09:00:00.000Z", endedAt: "2026-11-21T10:01:00.000Z" }), FINAL_STEP] });
    show();
    expect(card().querySelector("[data-result-score]")).toHaveTextContent("8/10");
    expect(figure(t("autopilot.result.numbers.time"))).toHaveTextContent("1h 01m");
    const headers = within(screen.getByRole("table", { name: t("autopilot.result.scores.title") })).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual([t("autopilot.result.scores.chapter"), t("autopilot.result.scores.final")]);
  });
});

describe("in Italian", () => {
  it("says it all in Italian: the heading, the verdict, the figures, the scores, what to read first and what to do next", async () => {
    await i18n.changeLanguage("it");
    done({ review: { verdict: "revise", score: 7, text: "Buono, ma la parte centrale rallenta.", at: REVIEW.at } });
    show();
    expect(screen.getByRole("heading", { level: 2, name: "Com'è venuto il libro" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Il verdetto del direttore" })).toBeInTheDocument();
    expect(screen.getByText("Da rivedere")).toBeInTheDocument();
    expect(screen.getByText("Voto 7 su 10")).toBeInTheDocument();
    expect(screen.getByText("Tempo di lavoro", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Voti per capitolo" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Giro 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Da leggere per primi" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Cosa fare adesso" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Aggiungi capitoli" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Leggi il libro" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Esporta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chiedi al direttore" })).toBeInTheDocument();
  });
});

describe("what a screen reader is told", () => {
  it("has nothing live in the card: the result of a finished book does not change", () => {
    done();
    show();
    expect(card().querySelectorAll("[aria-live], [role='status'], [role='alert'], [role='timer']")).toHaveLength(0);
  });

  it("has a heading for each part, under the one of the card", () => {
    done();
    show();
    const headings = within(card()).getAllByRole("heading").map((heading) => [heading.tagName, heading.textContent]);
    expect(headings[0]).toEqual(["H2", t("autopilot.result.title")]);
    expect(headings.slice(1).every(([tag]) => tag === "H3")).toBe(true);
    expect(headings.map(([, text]) => text)).toEqual([t("autopilot.result.title"), t("autopilot.result.verdict.title"), t("autopilot.result.numbers.title"), t("autopilot.result.scores.title"), t("autopilot.result.read.title")]);
  });
});

