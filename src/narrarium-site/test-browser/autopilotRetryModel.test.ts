import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AutopilotActivity, AutopilotErrorKind, AutopilotEvent, AutopilotStateSummary } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { presentFeedEvent } from "@/autopilot/format";
import { formatCountdown } from "@/autopilot/errorModel";
import { RECOMMENDED_LONG_RETRY, RETRY_SERVER_VERSION, mayPassWithTime, notBefore, readWhole, retryEndOf, retryWaitOf, serverHasRetry, waitWords } from "@/autopilot/retry";
import { buildTimeline } from "@/autopilot/timelineModel";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const T0 = "2026-11-21T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const summaryOf = (patch: Partial<AutopilotStateSummary>) => ({ status: "running", ...patch }) as AutopilotStateSummary;
const insight = (body: Record<string, unknown>, seq = 1) => ({ bookId: "book-1", at: at(seq), seq, type: "insight", tone: "warning", title: "engine words", ...body }) as AutopilotEvent;

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("the wait of a run, as the page reads it", () => {
  it("is nothing while nothing waits, and nothing for a run that is not running: a retry is only a retry while the run runs", () => {
    expect(retryWaitOf(null)).toBeNull();
    expect(retryWaitOf(summaryOf({}))).toBeNull();
    expect(retryWaitOf(summaryOf({ status: "paused", retry: { at: at(36), attempt: 1, retries: 3 } }))).toBeNull();
  });

  it("is a quick retry with its numbers, or a restart of «Retry later» with the cycle and how many: no limit is null, never a number", () => {
    expect(retryWaitOf(summaryOf({ retry: { at: at(36), attempt: 2, retries: 3 } }))).toEqual({ long: false, at: at(36), attempt: 2, retries: 3, cycle: null, cycles: null });
    expect(retryWaitOf(summaryOf({ retry: { at: at(600), attempt: 3, retries: 3, longTerm: { cycle: 2, cycles: 3 } } }))).toEqual({ long: true, at: at(600), attempt: 3, retries: 3, cycle: 2, cycles: 3 });
    expect(retryWaitOf(summaryOf({ retry: { at: at(600), attempt: 3, retries: 3, longTerm: { cycle: 7, cycles: null } } }))).toMatchObject({ long: true, cycle: 7, cycles: null });
  });
});

describe("when the next attempt is, in the time zone of the author", () => {
  const now = new Date("2026-11-21T10:00:00.000Z");
  const clock = (iso: string, language: string, timeZone: string) => new Intl.DateTimeFormat(language, { timeStyle: "short", timeZone }).format(new Date(iso));

  it("is a time of today, as the language writes it", () => {
    expect(notBefore("2026-11-21T13:35:00.000Z", "it", { now, timeZone: "Europe/Rome" })).toEqual({ day: "today", time: "14:35", date: expect.any(String) });
    expect(notBefore("2026-11-21T13:35:00.000Z", "en", { now, timeZone: "Europe/Rome" })?.time).toBe(clock("2026-11-21T13:35:00.000Z", "en", "Europe/Rome"));
  });

  it("says the day when it is not today: tomorrow, or the date in words", () => {
    expect(notBefore("2026-11-22T08:00:00.000Z", "it", { now, timeZone: "Europe/Rome" })).toMatchObject({ day: "tomorrow", time: "09:00" });
    const later = notBefore("2026-11-24T13:35:00.000Z", "it", { now, timeZone: "Europe/Rome" });
    expect(later).toMatchObject({ day: "later", time: "14:35" });
    expect(later?.date).toBe("martedì 24 novembre");
    expect(notBefore("2026-11-24T13:35:00.000Z", "en", { now, timeZone: "Europe/Rome" })?.date).toBe("Tuesday, November 24");
  });

  it("counts the day where the author is: the same moment is today in Rome and tomorrow in Tokyo", () => {
    const evening = new Date("2026-11-21T14:00:00.000Z");
    expect(notBefore("2026-11-21T16:00:00.000Z", "en", { now: evening, timeZone: "Europe/Rome" })?.day).toBe("today");
    expect(notBefore("2026-11-21T16:00:00.000Z", "en", { now: evening, timeZone: "Asia/Tokyo" })?.day).toBe("tomorrow");
  });

  it("is nothing for a moment that is not a date", () => {
    expect(notBefore("soon", "en", { now })).toBeNull();
  });
});

describe("a wait in words", () => {
  it("is said in the units a person reads, in the language of the app", () => {
    expect(waitWords(10 * 60_000, "en")).toBe("10 minutes");
    expect(waitWords(60_000, "it")).toBe("1 minuto");
    expect(waitWords(90 * 60_000, "en")).toBe("1 hour and 30 minutes");
    expect(waitWords(90 * 60_000, "it")).toBe("1 ora e 30 minuti");
    expect(waitWords(10_080 * 60_000, "it")).toBe("7 giorni");
    expect(waitWords(36_000, "en")).toBe("36 seconds");
  });

  it("goes on counting down past an hour and past a day", () => {
    expect(formatCountdown(36)).toBe("36 s");
    expect(formatCountdown(272)).toBe("4 min 32 s");
    expect(formatCountdown(2 * 3600 + 5 * 60 + 9)).toBe("2 h 05 min");
    expect(formatCountdown(3 * 86_400 + 4 * 3600, "en")).toBe("3 days 4 h");
    expect(formatCountdown(3 * 86_400 + 4 * 3600, "it")).toBe("3 giorni 4 h");
  });
});

describe("the failures «Retry later» waits for", () => {
  it.each(["network", "timeout", "rate_limit"] as const)("include a failure of kind %s, which passes with time", (kind) => {
    expect(mayPassWithTime(kind, {})).toBe(true);
  });

  it("include a provider error that is an overload or a failure of the server (5xx, 408, 429), not one that refuses the request", () => {
    for (const status of [500, 502, 503, 504, 408, 429]) expect(mayPassWithTime("provider", { status }), String(status)).toBe(true);
    for (const status of [400, 404, 409, 422]) expect(mayPassWithTime("provider", { status }), String(status)).toBe(false);
    expect(mayPassWithTime("provider", {}), "a provider error that says no status is not guessed").toBe(false);
  });

  it.each(["auth", "truncated", "refused", "conflict", "budget", "limit", "profile", "config", "unknown"] as AutopilotErrorKind[])("never include a failure of kind %s: a key, a discarded reply, the configuration or the budget do not pass with time", (kind) => {
    expect(mayPassWithTime(kind, { status: 503 })).toBe(false);
  });
});

describe("a whole number typed in the form", () => {
  it("is read only when it is one, in range: nothing is cut to fit, and an empty field is never «no limit»", () => {
    expect(readWhole("10", 1, 10_080)).toEqual({ value: 10, problem: null });
    expect(readWhole(" 10080 ", 1, 10_080)).toEqual({ value: 10_080, problem: null });
    expect(readWhole("", 1, 10_080)).toEqual({ value: null, problem: "empty" });
    expect(readWhole("   ", 1, 1000)).toEqual({ value: null, problem: "empty" });
    expect(readWhole("0", 1, 10_080)).toEqual({ value: null, problem: "min" });
    expect(readWhole("-5", 1, 10_080)).toEqual({ value: null, problem: "whole" });
    expect(readWhole("1.5", 1, 10_080)).toEqual({ value: null, problem: "whole" });
    expect(readWhole("1e3", 1, 10_080)).toEqual({ value: null, problem: "whole" });
    expect(readWhole("10081", 1, 10_080)).toEqual({ value: null, problem: "max" });
    expect(readWhole("1001", 1, 1000)).toEqual({ value: null, problem: "max" });
  });

  it("has recommended values of its own, and the server that brought «Retry later»", () => {
    expect(RECOMMENDED_LONG_RETRY).toEqual({ everyMinutes: 10, cycles: 6 });
    expect(RETRY_SERVER_VERSION).toBe("0.1.10");
    expect(serverHasRetry({ features: ["autopilot-controls"] })).toBe(false);
    expect(serverHasRetry({ features: ["autopilot-controls", "autopilot-retry"] })).toBe(true);
    expect(serverHasRetry(null)).toBe(false);
  });
});

describe("the feed and the timeline", () => {
  const wait = insight({ code: "longRetryWait", waitMs: 10 * 60_000, cycle: 2, cycles: 3, detail: "openai m: HTTP 503 — overloaded" }, 5);

  it("tell a wait of «Retry later» as a wait, not as an error, in the language of the app, with the failure kept as the detail", () => {
    const view = presentFeedEvent(i18n.getFixedT(null), wait);
    expect(view).toMatchObject({ tone: "info", text: t("autopilot.insight.longRetryWait", { wait: "10 minutes", cycle: 2, cycles: 3 }), detail: "openai m: HTTP 503 — overloaded" });
    expect(view?.text).toBe("The step failed after the quick retries: retrying in 10 minutes (restart 2 of 3).");
    const unlimited = presentFeedEvent(i18n.getFixedT(null), insight({ code: "longRetryWait", waitMs: 60 * 60_000, cycle: 4, cycles: null }));
    expect(unlimited?.text).toBe(t("autopilot.insight.longRetryWait", { context: "unlimited", wait: "1 hour", cycle: 4 }));
  });

  it("tell a skipped wait as a note, the end of the restarts with their count, and a «Retry later» turned off in words", () => {
    expect(presentFeedEvent(i18n.getFixedT(null), insight({ code: "retrySkipped", tone: "info", waitMs: 540_000 }))).toMatchObject({ tone: "info", text: "Wait skipped: retrying now." });
    expect(presentFeedEvent(i18n.getFixedT(null), insight({ code: "longRetryExhausted", tone: "critical", cycle: 3, cycles: 3 }))).toMatchObject({ tone: "critical", text: t("autopilot.insight.longRetryExhausted", { count: 3 }) });
    const off = { bookId: "book-1", at: at(9), seq: 9, type: "run-ended", runId: "run-1", status: "error", message: "“Retry later” was turned off while the step waited to be tried again: HTTP 503", code: "longRetryOff" } as AutopilotEvent;
    expect(presentFeedEvent(i18n.getFixedT(null), off)).toMatchObject({ tone: "critical", text: t("autopilot.insight.longRetryOff"), detail: "“Retry later” was turned off while the step waited to be tried again: HTTP 503" });
  });

  it("say the outline of a chapter that changed while it is written, and of a written one that left it, with the number of the chapter", async () => {
    await i18n.changeLanguage("it");
    expect(presentFeedEvent(i18n.getFixedT(null), insight({ code: "outlineChangedWhileWriting", tone: "info", chapterNumber: 4 }))?.text).toBe("La Scaletta del capitolo 4 è cambiata mentre è in scrittura: deciderai quando sarà chiuso.");
    expect(presentFeedEvent(i18n.getFixedT(null), insight({ code: "outlineRemovedWritten", tone: "info", chapterNumber: 6 }))?.text).toBe("Il capitolo 6 non è più nella Scaletta, ma è già scritto: resta nel libro.");
    expect(presentFeedEvent(i18n.getFixedT(null), insight({ code: "longRetryWait", waitMs: 90 * 60_000, cycle: 2, cycles: 3 }))?.text).toBe("Il passo non è riuscito dopo i tentativi ravvicinati: riprovo tra 1 ora e 30 minuti (ripartenza 2 di 3).");
  });

  it("make the wait a row of the timeline that is not a problem, the skipped wait a note, and the end of the restarts a problem", () => {
    const failed: AutopilotActivity = { id: "try-1", runId: "run-1", task: "concept", phase: "concept", title: "Designing the concept", reason: "", next: "", status: "failed", error: "HTTP 503", startedAt: at(0), endedAt: at(4) };
    const events = [
      wait,
      insight({ code: "retrySkipped", tone: "info", waitMs: 540_000 }, 6),
      insight({ code: "longRetryExhausted", tone: "critical", cycle: 3, cycles: 3 }, 7),
    ];
    const timeline = buildTimeline({ activities: [failed], events });
    const markers = timeline.groups.flatMap((group) => group.rows).filter((row) => row.kind === "marker");
    const byCode = (code: string) => markers.find((row) => row.kind === "marker" && row.event.type === "insight" && row.event.code === code);
    expect(byCode("longRetryWait")).toMatchObject({ tone: "info", problem: false });
    expect(byCode("retrySkipped")).toMatchObject({ tone: "info", problem: false });
    expect(byCode("longRetryExhausted")).toMatchObject({ tone: "critical", problem: true });
  });
});

describe("how «Retry later» ended a run", () => {
  const ended = (code: string | undefined, seq: number) => ({ bookId: "book-1", at: at(seq), seq, type: "run-ended", runId: "run-1", status: "error", message: "stopped", ...(code ? { code } : {}) }) as AutopilotEvent;
  const notice = (cycle: number, seq: number) => insight({ code: "longRetryExhausted", tone: "critical", cycle, cycles: cycle }, seq);

  it("is what the run-ended event of this run says, with how many restarts the notice told", () => {
    expect(retryEndOf([notice(3, 1), ended("longRetryExhausted", 2)], at(0))).toEqual({ code: "longRetryExhausted", count: 3 });
    expect(retryEndOf([ended("longRetryOff", 2)], at(0))).toEqual({ code: "longRetryOff", count: null });
    expect(retryEndOf([ended("longRetryExhausted", 2)], at(0))).toEqual({ code: "longRetryExhausted", count: null });
  });

  it("is nothing for a run that ended another way", () => {
    expect(retryEndOf([ended(undefined, 2)], at(0))).toBeNull();
    expect(retryEndOf([ended("somethingElse", 2)], at(0))).toBeNull();
  });

  it("is read from the state when the feed does not say: a page opened after the run, or another device", () => {
    expect(retryEndOf([], at(0), "longRetryExhausted")).toEqual({ code: "longRetryExhausted", count: null });
    expect(retryEndOf([], at(0), "longRetryOff")).toEqual({ code: "longRetryOff", count: null });
    expect(retryEndOf([insight({ code: "outlineChanged" }, 1)], at(0), "longRetryOff")).toEqual({ code: "longRetryOff", count: null });
  });

  it("is read from the state when the feed only knows the end of an earlier run", () => {
    expect(retryEndOf([ended("longRetryOff", 1)], at(600), "longRetryExhausted")).toEqual({ code: "longRetryExhausted", count: null });
  });

  it("is what the feed says, with its count, when it says it, and the state is the same run's word", () => {
    expect(retryEndOf([notice(3, 1), ended("longRetryExhausted", 2)], at(0), "longRetryExhausted")).toEqual({ code: "longRetryExhausted", count: 3 });
  });

  it("is nothing when the state has no code, or one this version does not know: an engine that is newer may say another", () => {
    expect(retryEndOf([], at(0))).toBeNull();
    expect(retryEndOf([], at(0), null)).toBeNull();
    expect(retryEndOf([], at(0), undefined)).toBeNull();
    expect(retryEndOf([], at(0), "longRetryTomorrow")).toBeNull();
  });
});
