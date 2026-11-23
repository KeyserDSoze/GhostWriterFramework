import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity, AutopilotErrorDetail, AutopilotErrorKind, AutopilotEvent, AutopilotLastErrorCode, AutopilotLongRetry, AutopilotRetryInfo, AutopilotStateSummary } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ book: null as unknown, runtime: null as unknown as ReturnType<typeof import("./helpers/quickCommands").makeRuntime>, toast: vi.fn(), save: vi.fn(async () => true) }));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: undefined, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: mocks.save }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AutopilotDock } from "@/components/autopilot/AutopilotDock";
import { ErrorPanel } from "@/components/autopilot/ErrorPanel";
import { AutopilotPage } from "@/pages/AutopilotPage";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { activityOf, eventOf, seedRun, type RunSeed } from "./helpers/autopilotBand";
import { LOCAL_BOOK, T0, makeRuntime, quickName, t } from "./helpers/quickCommands";

// «Retry now» wherever the run waits to try a failed step again (the error panel, the band, the quick commands, the mini-player), the long wait of «Retry
// later» in words, and what the error panel says of a run that stopped on a failure that may pass with time.

const MS = Date.parse(T0);
const at = (seconds: number) => new Date(MS + seconds * 1000).toISOString();
const SERVER_BOOK: BookEntry = { ...LOCAL_BOOK, autopilotHost: "server" };
const DETAIL: AutopilotErrorDetail = { endpoint: "https://llm.example.net/v1", model: "muse-30b", provider: "openai", integration: "ai-1", status: 503, attempt: 3, retries: 3 };
const FAILURE = "openai muse-30b: HTTP 503 — overloaded";
const SHORT: AutopilotRetryInfo = { at: at(36), attempt: 2, retries: 3 };
const LONG: AutopilotRetryInfo = { at: at(600), attempt: 3, retries: 3, longTerm: { cycle: 2, cycles: 3 } };
const POLICY: AutopilotLongRetry = { everyMinutes: 10, cycles: 3 };

/** The attempts of the step that failed in a row, as the engine leaves them in the log. */
function attempts(count: number, kind: AutopilotErrorKind = "provider", detail: AutopilotErrorDetail = DETAIL): AutopilotActivity[] {
  return Array.from({ length: count }, (_, index) => activityOf("concept", { id: `try-${index}`, title: "Designing the concept", status: "failed", error: FAILURE, errorKind: kind, errorDetail: detail, startedAt: at(index * 10 - 60), endedAt: at(index * 10 - 55) }));
}

/** A run that waits to try the failed step again: a quick retry, or a restart of «Retry later». */
function waiting(retry: AutopilotRetryInfo, seed: RunSeed = {}) {
  return seedRun({ status: "running", running: true, activities: attempts(retry.longTerm ? 4 : retry.attempt), retry, options: retry.longTerm ? { longRetry: POLICY } : {}, ...seed });
}

/** A run that stopped on an error, with «Retry later» as the options say, and what this browser heard of how it ended. */
function stopped({ kind = "provider", detail = DETAIL, longRetry, feed = [], book, code }: { kind?: AutopilotErrorKind; detail?: AutopilotErrorDetail; longRetry?: AutopilotLongRetry; feed?: AutopilotEvent[]; book?: BookEntry; code?: AutopilotLastErrorCode } = {}) {
  const log = attempts(1, kind, detail);
  return seedRun({
    ...(book ? { book, server: "retry" as const } : {}),
    status: "error",
    activities: log,
    options: longRetry ? { longRetry } : {},
    statePatch: { lastError: { message: FAILURE, at: log[0].endedAt as string, task: "concept", activityId: log[0].id, errorKind: kind, errorDetail: detail, ...(code ? { code } : {}) } },
    feed,
  });
}

const panel = () => document.querySelector<HTMLElement>("[data-autopilot-error]");
const bandOf = () => document.querySelector<HTMLElement>("[data-autopilot-band]") as HTMLElement;
const outcome = () => document.querySelector<HTMLElement>("[data-retry-outcome]");
const retryNamed = (variant: "page" | "dock" = "page", book: BookEntry = LOCAL_BOOK) => quickName(t("autopilot.retry.now"), variant, book);
const currentSummary = () => useAutopilotStore.getState().summaries["book-1"];
const stateEvent = (state: AutopilotStateSummary, seq: number) => ({ bookId: "book-1", at: state.updatedAt, seq, type: "state", state }) as AutopilotEvent;
const clock = (iso: string, language = "en") => new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(new Date(iso));

/** What the engine says once the wait is over: the next summary has no retry in it. */
async function waitIsOver(seq = 1) {
  const without = { ...currentSummary() };
  delete without.retry;
  await act(async () => { useAutopilotStore.getState().ingest(stateEvent({ ...without, updatedAt: currentSummary().updatedAt }, seq), "The Glass Harbor"); });
}

/** The line of a wait, as the band and the panel write it. */
function waitLine(retry: AutopilotRetryInfo, language = "en"): string {
  const parts = [t("autopilot.retry.waiting")];
  if (!retry.longTerm) return [...parts, t("autopilot.retry.quick", { attempt: retry.attempt, retries: retry.retries })].join(" · ");
  const { cycle, cycles } = retry.longTerm;
  parts.push(cycles === null ? t("autopilot.retry.restart", { context: "unlimited", cycle }) : t("autopilot.retry.restart", { cycle, cycles }));
  parts.push(t("autopilot.retry.notBefore", { time: clock(retry.at, language) }));
  return parts.join(" · ");
}

function showPanel() {
  return render(<MemoryRouter><button type="button">elsewhere</button><section data-autopilot-band tabIndex={-1} aria-label="band" /><ErrorPanel bookId="book-1" /></MemoryRouter>);
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/book-1/autopilot"]}>
      <Routes><Route path="/app/books/:bookId/autopilot" element={<AutopilotPage />} /></Routes>
    </MemoryRouter>
  );
}

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = makeRuntime();
  mocks.book = LOCAL_BOOK;
  mocks.toast.mockReset();
  // The clock stands still (the waits are counted from it); the timers run, so that a wait for the page goes on. A test that needs the time to pass moves all of them.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
});

/** All the timers under the test's hand, from `T0`: for what counts the seconds. */
function tickingClock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
}

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], dockOpen: false, pageDockOpen: false, dockTab: "live", dockFocusBook: null, whereIntent: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("«Retry now» in the error panel", () => {
  it("is only there while the run waits: a run that goes on has no panel, and a run that stopped keeps the retry that resumes it", async () => {
    seedRun({ status: "running", running: true });
    const view = showPanel();
    expect(panel()).toBeNull();
    view.unmount();
    stopped({ kind: "network" });
    showPanel();
    fireEvent.click(screen.getByRole("button", { name: retryNamed() }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith("book-1"));
    expect(mocks.runtime.retryNow).not.toHaveBeenCalled();
  });

  it("skips a short wait: the runtime is asked, nothing is resumed, and the panel says so in words", async () => {
    waiting(SHORT);
    showPanel();
    const button = screen.getByRole("button", { name: retryNamed() });
    expect(button.tagName).toBe("BUTTON");
    expect(within(panel() as HTMLElement).getByRole("timer")).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "36 s" }));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.runtime.retryNow).toHaveBeenCalledWith("book-1"));
    expect(mocks.runtime.start).not.toHaveBeenCalled();
    await waitFor(() => expect(outcome()).toHaveTextContent(t("autopilot.retry.outcome.skipped")));
    expect(outcome()).toHaveAttribute("role", "status");
    expect(t("autopilot.retry.outcome.skipped")).toBe("Retrying now.");
  });

  it("says that the wait was already over when the runtime answers that nothing waited: it is no error, and no toast says it is", async () => {
    mocks.runtime.retryNow.mockResolvedValueOnce(false);
    waiting(SHORT);
    showPanel();
    fireEvent.click(screen.getByRole("button", { name: retryNamed() }));
    await waitFor(() => expect(outcome()).toHaveTextContent(t("autopilot.retry.outcome.over")));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("keeps the outcome when the panel goes away with the wait, and the focus goes to the band right above", async () => {
    waiting(SHORT);
    showPanel();
    const button = screen.getByRole("button", { name: retryNamed() });
    button.focus();
    expect(outcome(), "the status is there before it says anything, so that it is read out").not.toBeNull();
    expect(outcome()?.textContent).toBe("");
    fireEvent.click(button);
    await waitFor(() => expect(outcome()).toHaveTextContent(t("autopilot.retry.outcome.skipped")));
    await waitIsOver();
    expect(panel()).toBeNull();
    expect(outcome()).toHaveTextContent(t("autopilot.retry.outcome.skipped"));
    expect(document.activeElement).toBe(bandOf());
  });

  it("cannot be pressed twice while the command is on its way, and keeps the focus meanwhile", async () => {
    let answer: (value: boolean) => void = () => undefined;
    mocks.runtime.retryNow.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    waiting(SHORT);
    showPanel();
    const button = screen.getByRole("button", { name: retryNamed() });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(document.activeElement, "a button that is busy is not disabled: it would drop the focus").toBe(button);
    fireEvent.click(button);
    expect(mocks.runtime.retryNow).toHaveBeenCalledTimes(1);
    await act(async () => { answer(true); });
    await waitFor(() => expect(outcome()).toHaveTextContent(t("autopilot.retry.outcome.skipped")));
  });

  it("has no live region that changes with the time: the outcome is said once, in a polite status outside the alert", async () => {
    waiting(SHORT);
    showPanel();
    fireEvent.click(screen.getByRole("button", { name: retryNamed() }));
    await waitFor(() => expect(outcome()).toHaveTextContent(t("autopilot.retry.outcome.skipped")));
    expect(outcome()?.closest("[role='alert']")).toBeNull();
    expect(outcome()?.closest("[data-autopilot-error]"), "outside the panel, which goes away with the wait").toBeNull();
    expect(outcome()?.getAttribute("aria-live") ?? "polite").toBe("polite");
  });
});

describe("the long wait of «Retry later» in the error panel", () => {
  it("says not before when beside the time left, in the time of the author, and explains the failure as for every other wait", () => {
    waiting(LONG);
    showPanel();
    const when = within(panel() as HTMLElement).getByText(`(${t("autopilot.retry.notBefore", { time: clock(LONG.at) })})`);
    expect(when.closest("[data-error-not-before]")).not.toBeNull();
    expect(within(panel() as HTMLElement).getByRole("timer")).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "10 min 00 s" }));
    // The failure is explained as for every other wait: its title, what it means, and where it happened.
    expect(within(screen.getByRole("alert")).getByRole("heading", { level: 2, name: t("autopilot.failure.kind.provider.title") })).toBeInTheDocument();
  });

  it("keeps the two counters apart: the quick retries that were made, and the restarts of «Retry later»", () => {
    waiting(LONG);
    showPanel();
    const fact = (label: string) => within(panel() as HTMLElement).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
    expect(fact(t("autopilot.retry.facts.quick"))).toHaveTextContent(t("autopilot.failure.facts.attemptOf", { attempt: 3, retries: 3 }));
    expect(fact(t("autopilot.retry.facts.restart"))).toHaveTextContent(t("autopilot.retry.facts.restartOf", { cycle: 2, cycles: 3 }));
    expect(within(panel() as HTMLElement).queryByText(t("autopilot.failure.facts.attempt"), { selector: "dt" })).toBeNull();
  });

  it("offers «Retry now», «Pause» (which ends the wait and stops the run) and «Change settings», which leads to «Retry later» in the configuration", async () => {
    waiting(LONG);
    showPanel();
    expect(screen.getByRole("button", { name: retryNamed() })).toBeEnabled();
    expect(screen.getByRole("link", { name: t("autopilot.retry.settings") })).toHaveAttribute("href", "/app/books/book-1/autopilot/settings#autopilot-retry");
    fireEvent.click(screen.getByRole("button", { name: quickName(t("autopilot.actions.pause")) }));
    await waitFor(() => expect(mocks.runtime.pause).toHaveBeenCalledWith("book-1", "after-step"));
    expect(mocks.runtime.retryNow).not.toHaveBeenCalled();
  });

  it("has no «Pause» or «Change settings» in a quick wait, which is over in seconds", () => {
    waiting(SHORT);
    showPanel();
    expect(screen.queryByRole("link", { name: t("autopilot.retry.settings") })).toBeNull();
    expect(screen.queryByRole("button", { name: quickName(t("autopilot.actions.pause")) })).toBeNull();
  });

  it("says «unlimited» when the restarts have no limit", () => {
    const retry = { ...LONG, longTerm: { cycle: 2, cycles: null } };
    waiting(retry, { options: { longRetry: { everyMinutes: 10, cycles: "unlimited" } } });
    showPanel();
    const fact = within(panel() as HTMLElement).getByText(t("autopilot.retry.facts.restart"), { selector: "dt" }).nextElementSibling as HTMLElement;
    expect(fact).toHaveTextContent(t("autopilot.retry.facts.restartOf", { context: "unlimited", cycle: 2 }));
    expect(fact).toHaveTextContent("2 (unlimited)");
  });

  it("says the date in words when the next attempt is on another day", () => {
    const retry = { ...LONG, at: at(3 * 86_400) };
    waiting(retry);
    showPanel();
    const date = new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long" }).format(new Date(retry.at));
    expect(within(panel() as HTMLElement).getByText(`(${t("autopilot.retry.notBefore", { context: "later", date, time: clock(retry.at) })})`)).toBeInTheDocument();
    expect(date).toBe("Tuesday, November 24");
    expect(t("autopilot.retry.notBefore", { context: "later", date, time: "2:35 PM" })).toBe("not before Tuesday, November 24 at 2:35 PM");
  });

  it("counts down the time that is left in a timer that is not read out, and announces only when the wait begins", () => {
    tickingClock();
    waiting(LONG);
    showPanel();
    const timer = within(panel() as HTMLElement).getByRole("timer");
    expect(timer).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "10 min 00 s" }));
    expect(timer.closest("[aria-live]")).toBeNull();
    const announcement = document.querySelector<HTMLElement>("[data-error-announcement]") as HTMLElement;
    const start = t("autopilot.failure.countdown.announceStart", { time: "10 min 00 s" });
    expect(announcement).toHaveTextContent(start);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(timer).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "9 min 00 s" }));
    expect(announcement.textContent).toBe(start);
  });

  it("is said in Italian", async () => {
    await i18n.changeLanguage("it");
    waiting(LONG);
    showPanel();
    expect(within(panel() as HTMLElement).getByText(`(non prima delle ${clock(LONG.at, "it")})`)).toBeInTheDocument();
    expect(within(panel() as HTMLElement).getByText("Ripartenza", { selector: "dt" }).nextElementSibling).toHaveTextContent("2 di 3");
    expect(screen.getByRole("link", { name: "Cambia le impostazioni" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: retryNamed() }));
    await waitFor(() => expect(outcome()).toHaveTextContent("Riprovo adesso."));
    expect(t("autopilot.retry.now")).toBe("Riprova ora");
  });
});

describe("a personal server", () => {
  it("without «Retry now» shows no button, and the panel says why and that the autopilot tries again by itself", () => {
    waiting(SHORT, { book: SERVER_BOOK, server: "online" });
    showPanel();
    expect(screen.queryByRole("button", { name: retryNamed() })).toBeNull();
    expect(within(panel() as HTMLElement).getByText(t("autopilot.retry.oldServer", { version: "0.1.10" }))).toBeInTheDocument();
  });

  it("with it skips the wait through the runtime", async () => {
    waiting(LONG, { book: SERVER_BOOK, server: "retry" });
    showPanel();
    expect(within(panel() as HTMLElement).queryByText(t("autopilot.retry.oldServer", { version: "0.1.10" }))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: retryNamed() }));
    await waitFor(() => expect(mocks.runtime.retryNow).toHaveBeenCalledWith("book-1"));
  });
});

describe("a run that stopped", () => {
  const ENDED = (code: string, seq: number) => eventOf({ type: "run-ended", runId: "run-1", status: "error", message: FAILURE, code }, seq);

  it("after every restart of «Retry later» says so, with how many, and does not suggest turning on what is on", () => {
    stopped({ longRetry: POLICY, feed: [eventOf({ type: "insight", tone: "critical", code: "longRetryExhausted", title: "engine words", cycle: 3, cycles: 3 }, 1), ENDED("longRetryExhausted", 2)] });
    showPanel();
    expect(within(panel() as HTMLElement).getByText(t("autopilot.insight.longRetryExhausted", { count: 3 })).closest("[data-retry-ended]")).not.toBeNull();
    expect(document.querySelector("[data-retry-suggest]")).toBeNull();
  });

  it("because «Retry later» was turned off while it waited says so, and does not suggest turning it on again", () => {
    stopped({ feed: [ENDED("longRetryOff", 1)] });
    showPanel();
    expect(within(panel() as HTMLElement).getByText(t("autopilot.insight.longRetryOff")).closest("[data-retry-ended]")).not.toBeNull();
    expect(document.querySelector("[data-retry-suggest]")).toBeNull();
  });

  it("says how «Retry later» ended it when this browser heard nothing of the end (a page opened after the run, another device): the state keeps the code", () => {
    stopped({ longRetry: POLICY, code: "longRetryExhausted" });
    showPanel();
    expect(within(panel() as HTMLElement).getByText(t("autopilot.insight.longRetryExhausted")).closest("[data-retry-ended]")).not.toBeNull();
    expect(document.querySelector("[data-retry-suggest]")).toBeNull();
  });

  it("says that «Retry later» was turned off while it waited, from the state, and does not suggest turning it on again", () => {
    stopped({ code: "longRetryOff" });
    showPanel();
    expect(within(panel() as HTMLElement).getByText(t("autopilot.insight.longRetryOff")).closest("[data-retry-ended]")).not.toBeNull();
    expect(document.querySelector("[data-retry-suggest]")).toBeNull();
  });

  it("on a failure that may pass with time, with «Retry later» off, says it can be turned on and leads there, without turning it on", async () => {
    stopped({ kind: "provider" });
    showPanel();
    const suggestion = document.querySelector<HTMLElement>("[data-retry-suggest]") as HTMLElement;
    expect(suggestion).toHaveTextContent(t("autopilot.retry.suggest"));
    const link = within(suggestion).getByRole("link", { name: t("autopilot.retry.suggestLink") });
    expect(link).toHaveAttribute("href", "/app/books/book-1/autopilot/settings#autopilot-retry");
    expect(suggestion.closest("[role='alert']"), "it is advice, not part of the alert").toBeNull();
    fireEvent.click(link);
    expect(mocks.runtime.updateOptions).not.toHaveBeenCalled();
    expect(mocks.runtime.start).not.toHaveBeenCalled();
  });

  it.each([["network", {}], ["rate_limit", { status: 429 }], ["timeout", {}]] as const)("suggests it for a failure of kind %s", (kind, detail) => {
    stopped({ kind, detail });
    showPanel();
    expect(document.querySelector("[data-retry-suggest]")).not.toBeNull();
  });

  it.each([["auth", { status: 401 }], ["config", {}], ["budget", {}], ["truncated", {}], ["provider", { status: 400 }]] as const)("does not suggest it for a failure of kind %s, which no wait cures", (kind, detail) => {
    stopped({ kind, detail });
    showPanel();
    expect(document.querySelector("[data-retry-suggest]")).toBeNull();
  });

  it("does not suggest it when it is already on, nor on a personal server that does not have it", () => {
    stopped({ longRetry: POLICY });
    const first = showPanel();
    expect(document.querySelector("[data-retry-suggest]")).toBeNull();
    first.unmount();
    seedRun({ book: SERVER_BOOK, server: "online", status: "error", activities: attempts(1), statePatch: { lastError: { message: FAILURE, at: at(-55), task: "concept", activityId: "try-0", errorKind: "provider", errorDetail: DETAIL } } });
    showPanel();
    expect(document.querySelector("[data-retry-suggest]")).toBeNull();
  });

  it("suggests it in Italian", async () => {
    await i18n.changeLanguage("it");
    stopped({ kind: "network", detail: {} });
    showPanel();
    expect(screen.getByRole("link", { name: "Apri «Riprova più tardi» nella configurazione" })).toBeInTheDocument();
  });
});

describe("the band and the quick commands while the run waits", () => {
  const band = () => within(bandOf());
  const bandStatus = () => bandOf().querySelector<HTMLElement>("[data-band-now] [role='status']") as HTMLElement;

  it("say that the run waits, not that it prepares the next step, with which retry", () => {
    waiting(SHORT);
    render(<Page />);
    expect(bandStatus()).toHaveTextContent(waitLine(SHORT));
    expect(bandStatus()).not.toHaveTextContent(t("autopilot.current.preparing"));
    expect(waitLine(SHORT)).toBe("Waiting to retry · retry 2 of 3");
  });

  it("say a long wait with the restart and the time, and do not tell it again as the seconds go by", () => {
    tickingClock();
    waiting(LONG);
    render(<Page />);
    expect(bandStatus()).toHaveTextContent(waitLine(LONG));
    expect(waitLine(LONG)).toBe(`Waiting to retry · restart 2 of 3 · not before ${clock(LONG.at)}`);
    const text = bandStatus().textContent;
    act(() => { vi.advanceTimersByTime(5000); });
    expect(bandStatus().textContent).toBe(text);
  });

  it("say the wait once on the page: the band says the line, the panel the time left and the facts, and nothing is said twice", () => {
    waiting(LONG);
    render(<Page />);
    expect(screen.getAllByText(waitLine(LONG))).toHaveLength(1);
    expect(within(bandOf()).queryByRole("timer"), "the panel counts down: the band does not do it again").toBeNull();
    expect(within(panel() as HTMLElement).getByRole("timer")).toBeInTheDocument();
  });

  it("say «unlimited» for restarts without a limit", () => {
    const retry = { ...LONG, longTerm: { cycle: 2, cycles: null } };
    waiting(retry, { options: { longRetry: { everyMinutes: 10, cycles: "unlimited" } } });
    render(<Page />);
    expect(bandStatus()).toHaveTextContent(waitLine(retry));
    expect(waitLine(retry)).toContain("restart 2 (unlimited)");
  });

  it("have «Retry now» in the band only while the run waits", () => {
    waiting(SHORT);
    const view = render(<Page />);
    expect(band().getByRole("button", { name: retryNamed() })).toBeEnabled();
    view.unmount();
    seedRun({ status: "running", running: true });
    render(<Page />);
    expect(band().queryByRole("button", { name: retryNamed() })).toBeNull();
  });

  it("skip the wait from the band and say so in the status of the bar, and the focus goes to the pause when the button goes away", async () => {
    waiting(SHORT);
    render(<Page />);
    const button = band().getByRole("button", { name: retryNamed() });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.runtime.retryNow).toHaveBeenCalledWith("book-1"));
    const status = band().getAllByRole("status").find((element) => element.textContent?.includes(t("autopilot.retry.outcome.skipped")));
    await waitFor(() => expect(band().getByText(t("autopilot.retry.outcome.skipped"))).toBeInTheDocument());
    expect(status ?? band().getByText(t("autopilot.retry.outcome.skipped")).closest("[role='status']")).not.toBeNull();
    await waitIsOver();
    expect(band().queryByRole("button", { name: retryNamed() })).toBeNull();
    expect(document.activeElement).toBe(band().getByRole("button", { name: quickName(t("autopilot.actions.pause")) }));
  });

  it("have no «Retry now» for a book on a server without it, and the bar does not explain it: the panel does", () => {
    mocks.book = SERVER_BOOK;
    waiting(SHORT, { book: SERVER_BOOK, server: "online" });
    render(<Page />);
    expect(band().queryByRole("button", { name: retryNamed() })).toBeNull();
    expect(band().queryByText(t("autopilot.retry.oldServer", { version: "0.1.10" }))).toBeNull();
    expect(screen.getAllByText(t("autopilot.retry.oldServer", { version: "0.1.10" }))).toHaveLength(1);
  });

  it("are in Italian", async () => {
    await i18n.changeLanguage("it");
    waiting(LONG);
    render(<Page />);
    expect(bandStatus()).toHaveTextContent(`In attesa di riprovare · ripartenza 2 di 3 · non prima delle ${clock(LONG.at, "it")}`);
    expect(band().getByRole("button", { name: retryNamed() })).toHaveTextContent("Riprova ora");
  });
});

describe("the mini-player", () => {
  function showDock() {
    useAutopilotStore.setState({ dockTab: "book", dockOpen: true });
    return render(<MemoryRouter initialEntries={["/app/books/book-1"]}><AutopilotDock /></MemoryRouter>);
  }

  it("says the long wait and skips it with its own «Retry now»", async () => {
    waiting(LONG, { dockOpen: true });
    showDock();
    const dock = within(screen.getByRole("region", { name: t("autopilot.dockTitle") }));
    expect(dock.getByText(waitLine(LONG))).toBeInTheDocument();
    fireEvent.click(dock.getByRole("button", { name: retryNamed("dock") }));
    await waitFor(() => expect(mocks.runtime.retryNow).toHaveBeenCalledWith("book-1"));
    await waitFor(() => expect(dock.getByText(t("autopilot.retry.outcome.skipped"))).toBeInTheDocument());
  });

  it("counts down a quick wait beside the line, in a timer that is not read out: it has no panel to do it", () => {
    waiting(SHORT, { dockOpen: true });
    showDock();
    const dock = within(screen.getByRole("region", { name: t("autopilot.dockTitle") }));
    expect(dock.getByText(waitLine(SHORT))).toBeInTheDocument();
    const timer = dock.getByRole("timer");
    expect(timer).toHaveTextContent(t("autopilot.failure.countdown.in", { time: "36 s" }));
    expect(timer.closest("[role='status'], [aria-live]")).toBeNull();
  });
});
