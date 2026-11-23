import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AutopilotActivity, AutopilotErrorDetail, AutopilotErrorKind, AutopilotEvent, ChapterRound } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotTimeline } from "@/components/autopilot/AutopilotTimeline";
import { useAutopilotStore } from "@/autopilot/store";
import { formatClock } from "@/autopilot/format";
import { GROUP_ROWS } from "@/autopilot/timelineModel";
import { chapterFlow, countActivityReads, eventAt, finishedEvent, insightFor, resetIds, resetSeq, retryNotice, runEnded, runStarted, sec, stepOf } from "./helpers/autopilotTimeline";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK = "book-1";

type Props = Partial<React.ComponentProps<typeof AutopilotTimeline>> & { events?: AutopilotEvent[]; live?: { activity: AutopilotActivity; preview?: string; characters?: number } | null };

function show({ events = [], live = null, ...props }: Props = {}) {
  act(() => {
    useAutopilotStore.setState({
      feed: events.map((event) => ({ event, bookTitle: "The Glass Harbor" })),
      live: { [BOOK]: live ? { activity: live.activity, preview: live.preview ?? "", characters: live.characters ?? 0 } : null },
    });
  });
  const view = render(<MemoryRouter><AutopilotTimeline bookId={BOOK} activities={[]} {...props} /></MemoryRouter>);
  return view;
}

const rowsOf = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-timeline-row]")];
const groupHeader = (name: RegExp | string) => screen.getByRole("button", { name });
const summaryOf = (title: string) => screen.getByText(title).closest("summary") as HTMLElement;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  resetIds();
  resetSeq();
  sessionStorage.clear();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  sessionStorage.clear();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  await i18n.changeLanguage("en");
});

const twoChapters = () => {
  const first = chapterFlow(3, { from: 0 });
  const second = chapterFlow(4, { from: first.end + 10 });
  return [...first.activities, ...second.activities];
};

describe("one list of everything that happened, in groups", () => {
  it("has a group for each chapter and round, the newest one open and the others closed with no rows in them", () => {
    const { container } = show({ activities: twoChapters() });
    expect(screen.getByRole("heading", { level: 2, name: t("autopilot.activity.title") })).toBeInTheDocument();
    const headers = screen.getAllByRole("button").filter((button) => button.hasAttribute("aria-expanded"));
    expect(headers.map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "false", "false", "false"]);
    expect(headers.map((button) => button.textContent)).toEqual([
      expect.stringContaining(t("autopilot.timeline.group.chapter", { chapter: 4, round: 2 })),
      expect.stringContaining(t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })),
      expect.stringContaining(t("autopilot.timeline.group.chapter", { chapter: 3, round: 2 })),
      expect.stringContaining(t("autopilot.timeline.group.chapter", { chapter: 3, round: 1 })),
    ]);
    // Only the rows of the open group are in the page: 4 steps (the fixes, the second review and its specialists, the closing).
    expect(rowsOf(container)).toHaveLength(4);
    expect(container.querySelectorAll("details")).toHaveLength(4);
  });

  it("names the group headers with a heading of their own, a button that opens them and what is in them", () => {
    show({ activities: twoChapters() });
    const header = groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })));
    expect(header.closest("h3")).not.toBeNull();
    expect(header).toHaveAttribute("aria-controls");
    // The verdict and the score of the round are in the text of the header: one text, a different one for every group.
    expect(header).toHaveTextContent(`${t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })} · ${t("director.opinion.verdict.revise")} 6/10`);
    expect(header).toHaveTextContent(t("autopilot.timeline.group.steps", { count: 10 }));
    const open = groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 2 })));
    expect(open).toHaveTextContent(`${t("autopilot.timeline.group.chapter", { chapter: 4, round: 2 })} · ${t("director.opinion.verdict.approve")} 8/10`);
    expect(open).toHaveTextContent(t("autopilot.timeline.group.steps", { count: 4 }));
  });

  it("writes the title of the chapter in the header, as one text, when the plan has it", () => {
    show({ activities: twoChapters(), chapterTitle: (number) => (number === 4 ? "The Salt Road" : undefined) });
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.chapterTitled", { chapter: 4, title: "The Salt Road", round: 2 })))).toBeInTheDocument();
    expect(screen.queryByText("The Salt Road")).not.toBeInTheDocument();
  });

  it("calls the groups that are not about a chapter by what they are", () => {
    const list = [stepOf("concept", { from: 0 }), stepOf("plan", { from: 40 }), ...chapterFlow(1, { from: 100, rounds: 1 }).activities, stepOf("final", { from: 2000, summary: "approve 8/10 — The arc holds." })];
    show({ activities: list });
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.final")))).toHaveTextContent(`${t("autopilot.timeline.group.final")} · ${t("director.opinion.verdict.approve")} 8/10`);
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.plan")))).toBeInTheDocument();
  });

  it("opens a closed group when it is asked to, and closes it again, and does not draw its rows while it is closed", () => {
    const { container } = show({ activities: twoChapters() });
    const header = groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 3, round: 1 })));
    expect(screen.queryByText("scenes of chapter 3")).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("scenes of chapter 3")).toBeInTheDocument();
    expect(rowsOf(container)).toHaveLength(4 + 10);
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("scenes of chapter 3")).not.toBeInTheDocument();
  });

  it("closes the group that is no longer the newest by itself when nobody asked for it to stay", () => {
    const first = chapterFlow(3, { from: 0, rounds: 1 });
    const view = show({ activities: first.activities });
    const before = groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 3, round: 1 })));
    expect(before).toHaveAttribute("aria-expanded", "true");
    const second = chapterFlow(4, { from: first.end + 10, rounds: 1 });
    view.rerender(<MemoryRouter><AutopilotTimeline bookId={BOOK} activities={[...first.activities, ...second.activities]} /></MemoryRouter>);
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })))).toHaveAttribute("aria-expanded", "true");
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 3, round: 1 })))).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves open the group the author chose to keep open, and closed the one they closed, when a newer one comes", () => {
    const first = chapterFlow(3, { from: 0, rounds: 1 });
    const view = show({ activities: first.activities });
    const only = groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 3, round: 1 })));
    // A click closes it and a second click opens it again: that is a choice, not the default.
    fireEvent.click(only);
    fireEvent.click(only);
    const second = chapterFlow(4, { from: first.end + 10, rounds: 1 });
    view.rerender(<MemoryRouter><AutopilotTimeline bookId={BOOK} activities={[...first.activities, ...second.activities]} /></MemoryRouter>);
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 3, round: 1 })))).toHaveAttribute("aria-expanded", "true");
    const newest = groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })));
    fireEvent.click(newest);
    const third = chapterFlow(5, { from: second.end + 10, rounds: 1 });
    view.rerender(<MemoryRouter><AutopilotTimeline bookId={BOOK} activities={[...first.activities, ...second.activities, ...third.activities]} /></MemoryRouter>);
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })))).toHaveAttribute("aria-expanded", "false");
  });

  it("says there is nothing yet in one line, with no card around it, and shows the loading state while the log is read", () => {
    const empty = show();
    expect(screen.getByText(t("autopilot.activity.idle"))).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: t("autopilot.activity.title") })).not.toBeInTheDocument();
    empty.unmount();
    show({ loading: true });
    expect(screen.getByText(t("common.loading"))).toBeInTheDocument();
  });
});

describe("a row", () => {
  const write = () => stepOf("write", {
    from: 0, length: 68, chapterNumber: 1, sceneNumber: 2, title: "Writing scene 2 of chapter 1 «Scene 2»", reason: "The scene is the next of the plan.", next: "The readers will read the chapter.",
    summary: "640 words — The keeper climbs the stairs.", model: "fake-model", provider: "openai", usage: { inputTokens: 4001, outputTokens: 900, cachedInputTokens: 100 }, cost: 0.0312,
    changedPaths: ["chapters/001-one/002-scene-2.md", "plot.md"], host: "browser",
  });

  it("says what the step is, how it went, how long it took and what it cost, closed", () => {
    show({ activities: [write()] });
    const summary = summaryOf("Writing scene 2 of chapter 1 «Scene 2»");
    expect(summary).toHaveTextContent("1m 08s");
    expect(summary).toHaveTextContent("$0.0312");
    // The outcome is in words for a screen reader and not only an icon.
    expect(within(summary).getByText(t("autopilot.activity.status.succeeded"))).toBeInTheDocument();
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("640 words — The keeper climbs the stairs.")).not.toBeInTheDocument();
  });

  it("tells, once it is opened, why and what comes next, what was written, the model, the tokens, the cost and the files", async () => {
    show({ activities: [write()] });
    fireEvent.click(summaryOf("Writing scene 2 of chapter 1 «Scene 2»"));
    expect(await screen.findByText("640 words — The keeper climbs the stairs.")).toBeInTheDocument();
    const body = screen.getByText("640 words — The keeper climbs the stairs.").closest("details") as HTMLElement;
    expect(within(body).getByText(t("autopilot.timeline.row.written"))).toBeInTheDocument();
    expect(body).toHaveTextContent(`${t("autopilot.why")}: The scene is the next of the plan.`);
    expect(body).toHaveTextContent(`${t("autopilot.next")}: The readers will read the chapter.`);
    expect(body).toHaveTextContent("fake-model");
    expect(body).toHaveTextContent("openai");
    expect(body).toHaveTextContent("4,001");
    expect(body).toHaveTextContent("900");
    expect(body).toHaveTextContent("100");
    expect(body).toHaveTextContent(t("autopilot.host.browser"));
    expect(within(body).getByText(t("autopilot.activity.changed"))).toBeInTheDocument();
    expect(within(body).getByText("chapters/001-one/002-scene-2.md")).toBeInTheDocument();
    expect(within(body).getByText("plot.md")).toBeInTheDocument();
  });

  it("says 'result' where a step wrote nothing, and never repeats what is already in the row", async () => {
    show({ activities: [stepOf("consolidate", { from: 0, chapterNumber: 1, title: "Closing chapter 1", summary: "Chapter closed: summary and recap written." })] });
    fireEvent.click(summaryOf("Closing chapter 1"));
    const body = (await screen.findByText("Chapter closed: summary and recap written.")).closest("details") as HTMLElement;
    expect(within(body).getByText(t("autopilot.timeline.row.result"))).toBeInTheDocument();
    expect(within(body).queryByText(t("autopilot.timeline.row.written"))).not.toBeInTheDocument();
    expect(within(body).queryByText(t("autopilot.why"), { exact: false })).not.toBeInTheDocument();
  });

  it("says a step failed in words, and gives the whole error once it is opened", async () => {
    const error = "The AI provider answered 429 (rate limit exceeded) three times in a row: the step was not completed.";
    show({ activities: [stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1, title: "Writing scene 1", status: "failed", error })] });
    const summary = summaryOf("Writing scene 1");
    expect(within(summary).getByText(t("autopilot.activity.status.failed"))).toBeInTheDocument();
    expect(screen.queryByText(error)).not.toBeInTheDocument();
    fireEvent.click(summary);
    expect(await screen.findByText(error)).toBeInTheDocument();
  });

  it("puts the attempts of a step in the row of the step, with the notice of every retry between them", async () => {
    const failed1 = stepOf("write", { from: 0, length: 10, chapterNumber: 1, sceneNumber: 1, title: "Writing scene 1", status: "failed", error: "429 once" });
    const failed2 = stepOf("write", { from: 40, length: 10, chapterNumber: 1, sceneNumber: 1, title: "Writing scene 1", status: "failed", error: "429 twice" });
    const worked = stepOf("write", { from: 130, length: 30, chapterNumber: 1, sceneNumber: 1, title: "Writing scene 1", summary: "640 words — done" });
    const { container } = show({ activities: [failed1, failed2, worked], events: [finishedEvent(failed1), retryNotice(11, 1, 3, 20_000), finishedEvent(failed2), retryNotice(51, 2, 3, 60_000), finishedEvent(worked)] });
    expect(container.querySelectorAll("details")).toHaveLength(1);
    const summary = summaryOf("Writing scene 1");
    expect(summary).toHaveTextContent(t("autopilot.timeline.row.attempts", { count: 3 }));
    fireEvent.click(summary);
    const body = (await screen.findByText("429 once")).closest("details") as HTMLElement;
    expect(within(body).getByRole("list", { name: t("autopilot.timeline.row.attemptsTitle") })).toBeInTheDocument();
    expect(body).toHaveTextContent("429 twice");
    // The notice of the retry is said in the language of the app, from its code, with how many and how long.
    expect(body).toHaveTextContent(t("autopilot.insight.failureRetry", { attempt: 1, retries: 3, seconds: 20 }));
    expect(body).toHaveTextContent(t("autopilot.insight.failureRetry", { attempt: 2, retries: 3, seconds: 60 }));
    // And no row of its own for any of them.
    expect(rowsOf(container)).toHaveLength(1);
  });

  it("shows the insights and the warnings of a step under it, with the text of their code in the language of the app, and counts the warnings in the row", async () => {
    const closing = stepOf("consolidate", { from: 0, chapterNumber: 1, title: "Closing chapter 1" });
    const events = [
      insightFor(closing, "ok", "Chapter 1 approved (8/10)", "The chapter closes the first act."),
      eventAt(40, { type: "sync", activityId: closing.id, tone: "warning", code: "publishFailed", title: "Pubblicazione del capitolo non riuscita.", detail: "GitHub answered 502." }),
    ];
    show({ activities: [closing], events });
    const summary = summaryOf("Closing chapter 1");
    expect(summary).toHaveTextContent(t("autopilot.timeline.row.warnings", { count: 1 }));
    fireEvent.click(summary);
    const body = (await screen.findByText("Chapter 1 approved (8/10)")).closest("details") as HTMLElement;
    expect(within(body).getByText("The chapter closes the first act.")).toBeInTheDocument();
    // The engine wrote this one in Italian; the app is in English and has the text of the code.
    expect(within(body).getByText(t("autopilot.insight.publishFailed"))).toBeInTheDocument();
    expect(within(body).queryByText("Pubblicazione del capitolo non riuscita.")).not.toBeInTheDocument();
    expect(within(body).getByText("GitHub answered 502.")).toBeInTheDocument();
  });

  it("does not say twice what the result of a step already says: a note whose detail is in the result keeps its line and drops the detail", async () => {
    const write = stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1, title: "Writing scene 1", summary: "640 words — The keeper climbs the stairs." });
    show({ activities: [write], events: [insightFor(write, "ok", "Scene 1.1 written: 640 words", "The keeper climbs the stairs."), insightFor(write, "info", "Another note", "A detail that is only here.")] });
    fireEvent.click(summaryOf("Writing scene 1"));
    expect(await screen.findByText("Scene 1.1 written: 640 words")).toBeInTheDocument();
    // The result has it, once; the detail of the other note is told in full.
    expect(screen.getAllByText(/The keeper climbs the stairs\./)).toHaveLength(1);
    expect(screen.getByText("A detail that is only here.")).toBeInTheDocument();
  });

  it("does not count good news as a warning", () => {
    const closing = stepOf("consolidate", { from: 0, chapterNumber: 1, title: "Closing chapter 1" });
    show({ activities: [closing], events: [insightFor(closing, "ok", "Chapter 1 approved (8/10)")] });
    expect(summaryOf("Closing chapter 1")).not.toHaveTextContent(t("autopilot.timeline.row.warnings", { count: 1 }));
  });

  it("marks where a run started and how it ended, in the group, and keeps what it said for when it is opened", async () => {
    const flow = chapterFlow(1, { from: 10, rounds: 1 });
    show({ activities: flow.activities, events: [runStarted(5), runEnded(flow.end + 20, "paused", "Chapter 1 approved: read it and resume.")] });
    expect(screen.getByText(t("autopilot.feed.runStarted", { host: t("autopilot.host.browser") }))).toBeInTheDocument();
    const ended = screen.getByText(t("autopilot.feed.runEnded", { status: t("autopilot.status.paused") }));
    expect(screen.queryByText("Chapter 1 approved: read it and resume.")).not.toBeInTheDocument();
    fireEvent.click(ended.closest("summary") as HTMLElement);
    expect(await screen.findByText("Chapter 1 approved: read it and resume.")).toBeInTheDocument();
  });
});

describe("the filters", () => {
  const withProblems = () => {
    const flow = chapterFlow(4, { rounds: 2 });
    const failed = stepOf("write", { from: flow.end + 10, length: 5, chapterNumber: 5, sceneNumber: 1, title: "Writing scene 1 of chapter 5", status: "failed", error: "429" });
    const specialists = flow.activities.find((activity) => activity.task === "specialists")!;
    return { activities: [...flow.activities, failed], events: [insightFor(specialists, "warning", "continuity: the lamp is lit twice")] };
  };
  const radio = (name: RegExp | string) => screen.getByRole("radio", { name });

  it("offers all, the problems, the director, the readers and the writing, as one choice among five, with how many each has", () => {
    show(withProblems());
    const group = screen.getByRole("radiogroup", { name: t("autopilot.timeline.filter.label") });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((item) => item.getAttribute("name"))).toEqual(Array(5).fill(radios[0].getAttribute("name")));
    expect(radios.map((item) => (item as HTMLInputElement).checked)).toEqual([true, false, false, false, false]);
    expect(radios.map((item) => item.closest("label")?.textContent)).toEqual([
      expect.stringContaining(t("autopilot.timeline.filter.all")),
      expect.stringContaining(t("autopilot.timeline.filter.problems")),
      expect.stringContaining(t("autopilot.timeline.filter.director")),
      expect.stringContaining(t("autopilot.timeline.filter.readers")),
      expect.stringContaining(t("autopilot.timeline.filter.writing")),
    ]);
    expect(radio(new RegExp(t("autopilot.timeline.filter.problems")))).toHaveAccessibleName(expect.stringContaining("2"));
  });

  it("shows only the problems when asked, and no group that has none", () => {
    const { container } = show(withProblems());
    fireEvent.click(radio(new RegExp(t("autopilot.timeline.filter.problems"))));
    expect(screen.getByText("Writing scene 1 of chapter 5")).toBeInTheDocument();
    expect(screen.queryByText("director-review of chapter 4")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button").filter((button) => button.hasAttribute("aria-expanded"))).toHaveLength(2);
    expect(rowsOf(container).length).toBeLessThanOrEqual(2);
  });

  it("shows only the steps of one kind of work, and says how many it shows to a screen reader", () => {
    show(withProblems());
    fireEvent.click(radio(new RegExp(t("autopilot.timeline.filter.readers"))));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(t("autopilot.timeline.announce", { filter: t("autopilot.timeline.filter.readers"), count: 4 }));
    // Only the group of round 1 has readers, and it is the newest of what is shown: it is the one that is open.
    expect(screen.getAllByRole("button").filter((button) => button.hasAttribute("aria-expanded")).map((button) => button.getAttribute("aria-expanded"))).toEqual(["true"]);
    expect(screen.getAllByText(/^(reader|readers-summary) of chapter 4/)).toHaveLength(4);
    expect(screen.queryByText("scenes of chapter 4")).not.toBeInTheDocument();
  });

  it("remembers the choice for the session: a page drawn again has the same filter, per book", () => {
    const first = show(withProblems());
    fireEvent.click(radio(new RegExp(t("autopilot.timeline.filter.director"))));
    first.unmount();
    show(withProblems());
    expect((radio(new RegExp(t("autopilot.timeline.filter.director"))) as HTMLInputElement).checked).toBe(true);
    expect(sessionStorage.length).toBeGreaterThan(0);
    cleanup();
    act(() => { useAutopilotStore.setState({ feed: [], live: {} }); });
    render(<MemoryRouter><AutopilotTimeline bookId="book-2" activities={chapterFlow(1, { rounds: 1 }).activities} /></MemoryRouter>);
    expect((radio(new RegExp(t("autopilot.timeline.filter.all"))) as HTMLInputElement).checked).toBe(true);
  });

  it("says nothing matches, and gives the way back, when the filter leaves no step", () => {
    show({ activities: chapterFlow(1, { rounds: 1 }).activities });
    fireEvent.click(radio(new RegExp(t("autopilot.timeline.filter.problems"))));
    expect(screen.getByText(t("autopilot.timeline.empty"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.timeline.showAll") }));
    expect((radio(new RegExp(t("autopilot.timeline.filter.all"))) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(t("autopilot.timeline.empty"))).not.toBeInTheDocument();
  });

  it("does not speak when nothing was asked: the status is empty until the filter changes", () => {
    show(withProblems());
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("a step the app has no words for", () => {
  it("is called what its kind is when it has no title, and does not break the list", () => {
    const odd = { ...stepOf("write", { from: 0 }), task: "something-new" as never, title: "", chapterNumber: undefined, sceneNumber: undefined };
    show({ activities: [odd, ...chapterFlow(1, { from: 100, rounds: 1 }).activities] });
    expect(screen.getByRole("button", { name: new RegExp(t("autopilot.timeline.group.other")) })).toBeInTheDocument();
    expect(screen.getAllByRole("button").filter((button) => button.hasAttribute("aria-expanded")).length).toBeGreaterThan(1);
  });
});

describe("hiding what happened until now", () => {
  it("hides everything that is over, says so with the way back, and remembers it for the session", () => {
    const flow = chapterFlow(1, { rounds: 1 });
    const first = show({ activities: flow.activities });
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.timeline.hide") }));
    expect(rowsOf(first.container)).toHaveLength(0);
    expect(screen.getByText(t("autopilot.timeline.nothingNew"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("autopilot.timeline.showHidden") })).toBeInTheDocument();
    first.unmount();
    const second = show({ activities: flow.activities });
    expect(rowsOf(second.container)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.timeline.showHidden") }));
    expect(rowsOf(second.container).length).toBeGreaterThan(0);
  });

  it("says how much is hidden and since when, while what came after is shown", () => {
    const flow = chapterFlow(1, { rounds: 1 });
    const view = show({ activities: flow.activities });
    const shown = flow.activities.length;
    fireEvent.click(screen.getByRole("button", { name: t("autopilot.timeline.hide") }));
    const since = JSON.parse(sessionStorage.getItem("narrarium-autopilot-timeline-v1") ?? "{}")[BOOK].since as string;
    // A step that finishes after the moment is shown, with the others still hidden.
    const later = stepOf("write", { from: Date.parse(since) / 1000 - Date.parse(sec(0)) / 1000 + 60, chapterNumber: 2, sceneNumber: 1, title: "Writing scene 1 of chapter 2" });
    view.rerender(<MemoryRouter><AutopilotTimeline bookId={BOOK} activities={[...flow.activities, later]} /></MemoryRouter>);
    expect(screen.getByText("Writing scene 1 of chapter 2")).toBeInTheDocument();
    const line = screen.getByText(t("autopilot.timeline.hidden", { count: shown, time: formatClock(since) }));
    expect(line).toHaveTextContent(String(shown));
  });

  it("has nothing to hide, and so no button, when nothing ever happened: there is no card at all, only the line that says so", () => {
    show();
    expect(screen.queryByRole("button", { name: t("autopilot.timeline.hide") })).not.toBeInTheDocument();
    expect(screen.getByText(t("autopilot.activity.idle"))).toBeInTheDocument();
  });
});

describe("a long list", () => {
  const manySteps = (count: number): AutopilotActivity[] => Array.from({ length: count }, (_, index) => stepOf("write", { from: index * 40, chapterNumber: 1, sceneNumber: index + 1, title: `Writing scene ${index + 1}` }));

  it("draws a window of the rows of the open group and gives more of them a step at a time, never more than 200", () => {
    const { container } = show({ activities: manySteps(250) });
    expect(rowsOf(container)).toHaveLength(GROUP_ROWS);
    // The newest are the first: the window is the top of the list.
    expect(screen.getByText("Writing scene 250")).toBeInTheDocument();
    expect(screen.queryByText("Writing scene 200")).not.toBeInTheDocument();
    const more = () => screen.queryByRole("button", { name: t("autopilot.timeline.more", { count: 40 }) });
    let rounds = 0;
    while (more() && rounds < 10) {
      fireEvent.click(more() as HTMLElement);
      rounds += 1;
    }
    expect(rounds).toBe(4);
    expect(rowsOf(container)).toHaveLength(200);
    expect(more()).toBeNull();
  });

  it("gives a last step that is smaller when fewer rows are left than a step", () => {
    show({ activities: manySteps(55) });
    expect(screen.getByRole("button", { name: t("autopilot.timeline.more", { count: 15 }) })).toBeInTheDocument();
  });

  it("has no more than a window of rows in the page for a log of 200 steps in many chapters, and none in the groups that are closed", () => {
    const activities: AutopilotActivity[] = [];
    let from = 0;
    for (let chapter = 1; activities.length < 200; chapter += 1) {
      const flow = chapterFlow(chapter, { from, rounds: 2 });
      activities.push(...flow.activities);
      from = flow.end + 5;
    }
    const kept = activities.slice(0, 200);
    const { container } = show({ activities: kept, events: kept.map((activity) => insightFor(activity, "ok", `Done ${activity.id}`)) });
    expect(container.querySelectorAll("[data-timeline-row]").length).toBeLessThanOrEqual(GROUP_ROWS + 5);
    expect(container.querySelectorAll("details").length).toBeLessThanOrEqual(GROUP_ROWS);
  });
});

describe("the step that runs now", () => {
  const LONG_TEXT = "The keeper climbed the stairs counting the steps under his breath, and on every landing the wind changed its note in the stairwell, as it had for thirty years.";
  const running = () => stepOf("write", { from: 5000, chapterNumber: 5, sceneNumber: 1, status: "running", title: "Writing scene 1 of chapter 5 «Scene 1»", reason: "The scene is the next of the plan.", next: "The readers will read the chapter." });
  const PREVIEW = "The keeper climbed the stairs counting the steps under his breath, and on every landing the wind changed its note in the stairwell.";

  it("shows the text it writes, whole, with why and what comes next, and not its title: the band says what it is", () => {
    const { container } = show({ activities: chapterFlow(4, { rounds: 1 }).activities, live: { activity: running(), preview: PREVIEW, characters: PREVIEW.length } });
    const live = container.querySelector("[data-timeline-live]") as HTMLElement;
    expect(live).toHaveTextContent(PREVIEW);
    expect(live).toHaveTextContent(t("autopilot.timeline.live"));
    expect(live).toHaveTextContent(`${t("autopilot.why")}: The scene is the next of the plan.`);
    expect(live).toHaveTextContent(t("autopilot.characters", { count: PREVIEW.length }));
    expect(screen.queryByText("Writing scene 1 of chapter 5 «Scene 1»")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Now$/i)).not.toBeInTheDocument();
    // It comes first, before the groups; and a step that runs is not a row.
    expect(live.compareDocumentPosition(container.querySelector("[data-timeline-group]") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("[data-timeline-row]")).toHaveLength(0);
  });

  it("opens the group the step belongs to, even when that chapter has no finished step yet", () => {
    show({ activities: chapterFlow(4, { rounds: 1 }).activities, live: { activity: running(), preview: PREVIEW } });
    const header = screen.getByText(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 5, round: 1 })));
    expect(header).toBeInTheDocument();
    expect(header.closest("li")).toHaveTextContent(t("autopilot.timeline.group.running"));
    expect(screen.getByRole("button", { name: new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })) })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows nothing at all when the step has no text, no reason and no next step to tell", () => {
    const quiet = stepOf("write", { from: 5000, chapterNumber: 5, sceneNumber: 1, status: "running", title: "Writing", reason: "", next: "" });
    const { container } = show({ activities: [], live: { activity: quiet, preview: "" } });
    expect(container.querySelector("[data-timeline-live]")).toBeNull();
  });

  it("follows the text as it comes without drawing a row again", () => {
    const reads = new Map<string, number>();
    // The review asked for fixes and the first fix is done: the step that runs (the specialists again) is in the second round, which has a row to draw.
    const flow = chapterFlow(4, { rounds: 2, closed: false }).activities;
    const logged = countActivityReads(flow.slice(0, flow.findIndex((activity) => activity.task === "repair") + 1), reads);
    const step = stepOf("specialists", { from: 9000, chapterNumber: 4, status: "running", title: "Specialists review chapter 4 (round 2)", reason: "Why", next: "Next" });
    const { container } = show({ activities: logged, live: { activity: step, preview: LONG_TEXT, characters: LONG_TEXT.length } });
    const drawn = [...reads.values()].reduce((sum, count) => sum + count, 0);
    expect(drawn).toBeGreaterThan(0);
    for (let chunk = 1; chunk <= 60; chunk += 1) {
      act(() => { useAutopilotStore.getState().ingest(eventAt(6000 + chunk, { type: "task-progress", activityId: step.id, characters: chunk * 10, preview: `${LONG_TEXT} words so far, chunk ${chunk}` }), "The Glass Harbor"); });
    }
    expect(container.querySelector("[data-timeline-live]")).toHaveTextContent("words so far, chunk 60");
    expect([...reads.values()].reduce((sum, count) => sum + count, 0)).toBe(drawn);
  });
});

describe("what a screen reader is told", () => {
  it("has one status, empty until the author changes the filter, and nothing live on a timer, a preview or a row", () => {
    const flow = chapterFlow(4, { rounds: 1 });
    const live = stepOf("write", { from: 5000, chapterNumber: 5, sceneNumber: 1, status: "running", title: "Writing", reason: "Why", next: "Next" });
    const { container } = show({ activities: flow.activities, events: [runStarted(1), insightFor(flow.activities[0], "warning", "A warning")], live: { activity: live, preview: "streaming words" } });
    expect(container.querySelectorAll("[role='status']")).toHaveLength(1);
    const regions = [...container.querySelectorAll("[aria-live], [role='status'], [role='alert']")];
    expect(regions).toHaveLength(1);
    expect(regions[0].textContent).toBe("");
    expect(container.querySelector("[data-timeline-live]")?.closest("[aria-live]")).toBeNull();
  });
});

describe("in Italian", () => {
  it("says it all in Italian: the groups, the filters, the buttons and the text of the codes", async () => {
    await i18n.changeLanguage("it");
    const closing = stepOf("consolidate", { from: 0, chapterNumber: 4, title: "Chiusura del capitolo 4" });
    const failed = stepOf("write", { from: 100, length: 10, chapterNumber: 5, sceneNumber: 1, title: "Scrittura della scena 1", status: "failed", error: "429" });
    const worked = stepOf("write", { from: 150, chapterNumber: 5, sceneNumber: 1, title: "Scrittura della scena 1" });
    show({ activities: [closing, failed, worked], events: [retryNotice(111, 1, 3, 20_000), eventAt(60, { type: "sync", activityId: closing.id, tone: "warning", code: "syncFailed", title: "Sync after the step failed." })] });
    expect(screen.getByRole("heading", { level: 2, name: "Tutto ciò che è successo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Capitolo 5 · giro 1/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Errori e avvisi/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Scrittura/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nascondi fino a ora" })).toBeInTheDocument();
    fireEvent.click(summaryOf("Scrittura della scena 1"));
    expect(await screen.findByText(/nuovo tentativo 1 di 3/i)).toBeInTheDocument();
  });
});

describe("what the list needs to be read", () => {
  it("keeps the events of other books out of it", () => {
    const worked = stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1, title: "Writing scene 1" });
    show({ activities: [worked], events: [{ ...insightFor(worked, "warning", "Not for this book"), bookId: "book-2" } as AutopilotEvent] });
    fireEvent.click(summaryOf("Writing scene 1"));
    expect(screen.queryByText("Not for this book")).not.toBeInTheDocument();
  });

  it("uses the clock of the steps and not the clock of the page: the same log reads the same twice", () => {
    const flow = chapterFlow(1, { rounds: 1 });
    const one = show({ activities: flow.activities });
    const html = one.container.innerHTML;
    one.unmount();
    expect(show({ activities: flow.activities }).container.innerHTML).toBe(html);
    expect(sec(0)).toBe("2026-11-21T09:00:00.000Z");
  });
});

describe("what kind of failure a step had", () => {
  const DETAIL: AutopilotErrorDetail = { endpoint: "https://api.openai.com", model: "gpt-4.1", provider: "openai", integration: "ai-1", status: 429 };
  const attempt = (from: number, patch: Partial<AutopilotActivity> = {}) => stepOf("write", { from, length: 10, chapterNumber: 5, sceneNumber: 2, title: "Writing scene 2", status: "failed", error: "429 Rate limit reached", errorKind: "rate_limit", errorDetail: DETAIL, ...patch });

  it("is said in a word with an icon on the row of a step that failed, besides the word that says it failed: the kind of the engine, where the row said only how it ended", () => {
    show({ activities: [attempt(0)] });
    const summary = summaryOf("Writing scene 2");
    expect(within(summary).getByText(t("autopilot.failure.kind.rate_limit.short"))).toBeInTheDocument();
    expect(within(summary).getByText(t("autopilot.activity.status.failed"))).toBeInTheDocument();
    expect(summary.querySelector("svg[aria-hidden='true']"), "an icon for the kind, which is decoration").not.toBeNull();
  });

  it.each(["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "config", "provider", "unknown"] as AutopilotErrorKind[])("has a word for a failure of kind %s", (kind) => {
    show({ activities: [attempt(0, { errorKind: kind })] });
    expect(within(summaryOf("Writing scene 2")).getByText(t(`autopilot.failure.kind.${kind}.short`))).toBeInTheDocument();
  });

  it("says only that it failed, as it did, for a step that an older engine wrote: no kind is made up", () => {
    show({ activities: [attempt(0, { errorKind: undefined, errorDetail: undefined })] });
    const summary = summaryOf("Writing scene 2");
    expect(within(summary).getByText(t("autopilot.activity.status.failed"))).toBeInTheDocument();
    for (const kind of ["network", "unknown", "provider"]) expect(within(summary).queryByText(t(`autopilot.failure.kind.${kind}.short`))).not.toBeInTheDocument();
  });

  it("says nothing of a kind for a step that worked", () => {
    show({ activities: [stepOf("write", { from: 0, chapterNumber: 5, sceneNumber: 2, title: "Writing scene 2" })] });
    for (const kind of ["network", "auth", "rate_limit", "timeout", "truncated", "refused", "conflict", "budget", "limit", "profile", "config", "provider", "unknown"]) {
      expect(within(summaryOf("Writing scene 2")).queryByText(t(`autopilot.failure.kind.${kind}.short`)), kind).not.toBeInTheDocument();
    }
  });

  it("says in the opened row, for each attempt, the kind and which retry it was, from the engine, though the feed has no notice of it", async () => {
    const first = attempt(0, { errorDetail: { ...DETAIL, attempt: 1, retries: 3 } });
    const second = attempt(40, { errorDetail: { ...DETAIL, attempt: 2, retries: 3 }, error: "429 Rate limit reached again" });
    const worked = stepOf("write", { from: 140, length: 30, chapterNumber: 5, sceneNumber: 2, title: "Writing scene 2", summary: "640 words — done" });
    show({ activities: [first, second, worked] });
    fireEvent.click(summaryOf("Writing scene 2"));
    const body = (await screen.findByText("429 Rate limit reached")).closest("details") as HTMLElement;
    const list = within(body).getByRole("list", { name: t("autopilot.timeline.row.attemptsTitle") });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(t("autopilot.failure.kind.rate_limit.short"));
    expect(items[0]).toHaveTextContent(t("autopilot.timeline.row.retryOf", { attempt: 1, retries: 3 }));
    expect(items[1]).toHaveTextContent(t("autopilot.timeline.row.retryOf", { attempt: 2, retries: 3 }));
    expect(items[1]).toHaveTextContent("429 Rate limit reached again");
    // The endpoint of the failed calls is told once, with the other facts of the step.
    expect(body).toHaveTextContent("https://api.openai.com");
    expect(body).toHaveTextContent("gpt-4.1");
  });

  it("keeps the notice of the retry that the feed has, and does not say which retry it was twice", async () => {
    const failed = attempt(0, { errorDetail: { ...DETAIL, attempt: 1, retries: 3 } });
    const worked = stepOf("write", { from: 40, length: 20, chapterNumber: 5, sceneNumber: 2, title: "Writing scene 2" });
    show({ activities: [failed, worked], events: [finishedEvent(failed), retryNotice(11, 1, 3, 20_000), finishedEvent(worked)] });
    fireEvent.click(summaryOf("Writing scene 2"));
    const body = (await screen.findByText("429 Rate limit reached")).closest("details") as HTMLElement;
    expect(body).toHaveTextContent(t("autopilot.insight.failureRetry", { attempt: 1, retries: 3, seconds: 20 }));
    expect(within(body).queryByText(t("autopilot.timeline.row.retryOf", { attempt: 1, retries: 3 }))).not.toBeInTheDocument();
  });

  it("says the kind in Italian", async () => {
    await i18n.changeLanguage("it");
    show({ activities: [attempt(0)] });
    expect(within(summaryOf("Writing scene 2")).getByText("Limite richieste")).toBeInTheDocument();
  });
});

describe("the rounds the plan records, and the verdict on the book, in the headers", () => {
  const record = (...rounds: ChapterRound[]) => (chapter: number) => (chapter === 4 ? rounds : undefined);

  it("gives a round the vote the plan recorded, in the header, with the words of the verdict that the review wrote", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    show({ activities, chapterRounds: record({ director: 6.5, readers: 7.2, accepted: 2, rejected: 1 }, { director: 8.5, accepted: 0, rejected: 0 }) });
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 2 })))).toHaveTextContent(`${t("director.opinion.verdict.approve")} 8.5/10`);
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })))).toHaveTextContent(`${t("director.opinion.verdict.revise")} 6.5/10`);
  });

  it("numbers the rounds from the plan when the log has lost the first review of the chapter", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    const lost = activities.slice(activities.findIndex((activity) => activity.task === "director-review") + 1);
    show({ activities: lost, chapterRounds: record({ director: 6 }, { director: 8 }) });
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 2 })))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(t("autopilot.timeline.group.chapter", { chapter: 4, round: 1 })) })).not.toBeInTheDocument();
  });

  it("tells, in the group that is open, what the readers gave and what the director decided in the round", () => {
    const { activities } = chapterFlow(4, { rounds: 1 });
    show({ activities, chapterRounds: record({ director: 6.5, readers: 7.2, accepted: 2, rejected: 1 }) });
    const line = document.querySelector("[data-timeline-round]") as HTMLElement;
    expect(line).toHaveTextContent([t("autopilot.timeline.round.readers", { score: 7.2 }), t("autopilot.timeline.round.accepted", { count: 2 }), t("autopilot.timeline.round.rejected", { count: 1 })].join(" · "));
  });

  it("tells only what is there: no line for a round that has no readers and nothing decided, and none for a state that has no record", () => {
    const { activities } = chapterFlow(4, { rounds: 1 });
    show({ activities, chapterRounds: record({ director: 8 }) });
    expect(document.querySelector("[data-timeline-round]")).toBeNull();
    cleanup();
    show({ activities });
    expect(document.querySelector("[data-timeline-round]")).toBeNull();
  });

  it("does not draw the line of a group that is closed", () => {
    const first = chapterFlow(3, { rounds: 1 });
    const second = chapterFlow(4, { from: first.end + 10, rounds: 1 });
    show({ activities: [...first.activities, ...second.activities], chapterRounds: () => [{ director: 8, readers: 7, accepted: 1, rejected: 0 }] });
    expect(document.querySelectorAll("[data-timeline-round]")).toHaveLength(1);
  });

  it("says the verdict of the engine on the whole book in the header of its review, before the words of the step", () => {
    const final = stepOf("final", { from: 0, summary: "approve 9/10 — Fine." });
    const review = { verdict: "revise" as const, score: 7, text: "Good, but the middle drags.", at: sec(40) };
    show({ activities: [final], finalReview: review });
    expect(groupHeader(new RegExp(t("autopilot.timeline.group.final")))).toHaveTextContent(`${t("autopilot.timeline.group.final")} · ${t("director.opinion.verdict.revise")} 7/10`);
  });
});
