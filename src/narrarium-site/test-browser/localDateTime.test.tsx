import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { LocalTime } from "@/components/ui/local-time";
import { formatLocalDateTime, formatLocalTime, isLocalToday } from "@/lib/formatDateTime";

const ISO = "2026-11-21T21:28:18.893Z";

describe("formatLocalDateTime", () => {
  it("writes the date and time in the app language, in the given time zone", () => {
    expect(formatLocalDateTime(ISO, "it", { timeZone: "Europe/Rome" })).toBe("21 nov 2026, 22:28");
    expect(formatLocalDateTime(ISO, "en", { timeZone: "Europe/Rome" })).toMatch(/^Nov 21, 2026, 10:28\sPM$/);
  });

  it("follows the time zone, including the day", () => {
    expect(formatLocalDateTime(ISO, "it", { timeZone: "America/Los_Angeles" })).toBe("21 nov 2026, 13:28");
    expect(formatLocalDateTime("2026-11-21T23:30:00.000Z", "it", { timeZone: "Asia/Tokyo" })).toBe("22 nov 2026, 08:30");
  });

  it("uses the time zone of the browser when none is given", () => {
    const own = new Intl.DateTimeFormat("it", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ISO));
    expect(formatLocalDateTime(ISO, "it")).toBe(own);
  });

  it("returns a value it cannot read as it is, and nothing for a missing value", () => {
    expect(formatLocalDateTime("yesterday evening", "it")).toBe("yesterday evening");
    expect(formatLocalDateTime("2026-13-45T99:99:99Z", "en")).toBe("2026-13-45T99:99:99Z");
    for (const missing of [undefined, null, ""]) expect(formatLocalDateTime(missing, "en")).toBe("");
  });

  it("does not turn text that merely looks like a date to the browser into one", () => {
    for (const text of ["12", "build 12", "May 3", "1.5", "2026"]) expect(formatLocalDateTime(text, "en", { timeZone: "Europe/Rome" })).toBe(text);
  });

  it("reads an offset as well as Z, and the same instant gives the same text", () => {
    expect(formatLocalDateTime("2026-11-21T22:28:18+01:00", "it", { timeZone: "Europe/Rome" })).toBe("21 nov 2026, 22:28");
    expect(formatLocalDateTime("2026-11-21T22:28:18.893+0100", "it", { timeZone: "Europe/Rome" })).toBe("21 nov 2026, 22:28");
    expect(formatLocalDateTime("2026-11-21T21:28Z", "it", { timeZone: "Europe/Rome" })).toBe("21 nov 2026, 22:28");
  });

  it("does not move a calendar day with the time zone", () => {
    expect(formatLocalDateTime("2026-11-21", "it", { timeZone: "America/Los_Angeles" })).toBe("21 nov 2026");
    expect(formatLocalDateTime("2026-11-21", "it", { timeZone: "Pacific/Kiritimati" })).toBe("21 nov 2026");
  });

  it("falls back to English for a language it does not know", () => {
    expect(formatLocalDateTime(ISO, "not a language", { timeZone: "Europe/Rome" })).toMatch(/^Nov 21, 2026, 10:28\sPM$/);
  });
});

describe("formatLocalTime", () => {
  it("writes only the time, in the app language and the given time zone", () => {
    expect(formatLocalTime(ISO, "it", { timeZone: "Europe/Rome" })).toBe("22:28");
    expect(formatLocalTime(ISO, "en", { timeZone: "Europe/Rome" })).toMatch(/^10:28\sPM$/);
    expect(formatLocalTime(ISO, "it", { timeZone: "America/Los_Angeles" })).toBe("13:28");
  });

  it("returns a value it cannot read as it is", () => {
    expect(formatLocalTime("later", "it")).toBe("later");
  });
});

describe("isLocalToday", () => {
  const rome = { timeZone: "Europe/Rome" };

  it("is true for an instant of the same day and false for another day", () => {
    expect(isLocalToday(ISO, { ...rome, now: new Date("2026-11-21T22:00:00.000Z") })).toBe(true);
    expect(isLocalToday(ISO, { ...rome, now: new Date("2026-11-22T12:00:00.000Z") })).toBe(false);
  });

  it("compares days in the time zone of the viewer, not in UTC", () => {
    const lateEvening = "2026-11-21T22:30:00.000Z";
    const justAfterMidnight = new Date("2026-11-21T23:30:00.000Z");
    expect(isLocalToday(lateEvening, { ...rome, now: justAfterMidnight })).toBe(false);
    expect(isLocalToday(lateEvening, { timeZone: "UTC", now: justAfterMidnight })).toBe(true);
  });

  it("is false for a value it cannot read", () => {
    expect(isLocalToday("later", rome)).toBe(false);
  });
});

describe("LocalTime", () => {
  const zone = process.env.TZ;
  beforeAll(() => { process.env.TZ = "Europe/Rome"; });
  afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("en");
  });

  it.each([["it", "21 nov 2026, 22:28"], ["en", /^Nov 21, 2026, 10:28\sPM$/]] as const)("renders a <time> element in the language of the app (%s)", async (language, expected) => {
    await i18n.changeLanguage(language);
    render(<LocalTime value={ISO} className="muted" />);
    const element = document.querySelector("time")!;
    expect(element).toHaveAttribute("datetime", ISO);
    expect(element).toHaveAttribute("title", ISO);
    expect(element).toHaveClass("muted");
    expect(element.textContent).toMatch(expected);
  });

  it("follows a change of language", async () => {
    await i18n.changeLanguage("en");
    const { rerender } = render(<LocalTime value={ISO} />);
    expect(document.querySelector("time")?.textContent).toMatch(/Nov/);
    await i18n.changeLanguage("it");
    rerender(<LocalTime value={ISO} />);
    expect(document.querySelector("time")?.textContent).toBe("21 nov 2026, 22:28");
  });

  it("shows a value it cannot read as plain text, without a <time> element", () => {
    render(<LocalTime value="yesterday evening" />);
    expect(screen.getByText("yesterday evening")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });
});
